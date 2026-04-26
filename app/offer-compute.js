// Compute worker: discovers requesters on network, joins one with tasks, computes, moves on
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import crypto from 'crypto'
import fs from 'fs'
import Hyperdrive from 'hyperdrive'
import { NETWORK_TOPIC } from './base-setup.js'
import { executeTask } from './worker.js'
import { addDonated, loadReputation, getScore } from './reputation.js'
import { detectCapabilities, meetsRequirements } from './capabilities.js'
import os from 'os'
import { ThreadPool } from './thread-pool.js'

const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`
const storePath = `./store-${workerId}`
const IDLE_TIMEOUT = 60000 // leave after 60s with no tasks
const ALLOW_SHELL = process.env.ALLOW_SHELL === '1' || process.env.ALLOW_SHELL === 'true'
const POOL_SIZE = Number(process.env.POOL_SIZE) || Math.max(1, os.cpus().length - 1)
const pool = new ThreadPool(POOL_SIZE)
await pool.start()

console.log('╔═══════════════════════════════════════════╗')
console.log('║         OFFER COMPUTE — Worker            ║')
console.log('╠═══════════════════════════════════════════╣')
console.log(`║  Worker ID: ${workerId}                ║`)
console.log('╚═══════════════════════════════════════════╝')
console.log('')
console.log(`Idle timeout: ${IDLE_TIMEOUT / 1000}s | Store: ${storePath}`)
console.log(`Thread pool: ${POOL_SIZE} thread(s) | CPUs: ${os.cpus().length}`)
console.log(`Shell execution: ${ALLOW_SHELL ? 'ENABLED' : 'DISABLED (set ALLOW_SHELL=1 to enable)'}\n`)

const BOOTSTRAP = process.env.BOOTSTRAP
const swarmOpts = BOOTSTRAP
  ? { bootstrap: [{ host: BOOTSTRAP.split(':')[0], port: Number(BOOTSTRAP.split(':')[1]) }] }
  : {}

// --- Two swarms: discovery (JSON signaling) and replication (Autobase sync) ---
// They MUST be separate because raw JSON writes and Protomux-based Autobase
// replication corrupt each other when sharing a connection.

const discoverySwarm = new Hyperswarm(swarmOpts)
const replicationSwarm = new Hyperswarm(swarmOpts)

discoverySwarm.on('error', (err) => {
  console.log(`[!] Discovery swarm error: ${err.message}`)
})
replicationSwarm.on('error', (err) => {
  console.log(`[!] Replication swarm error: ${err.message}`)
})

replicationSwarm.on('connection', (conn) => {
  conn.on('error', () => {})
  if (store) store.replicate(conn)
})

function open (s) { return s.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, b) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      try {
        await b.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: false })
      } catch {}
    }
    await view.append(node.value)
  }
}

// State
let base = null
let store = null
let currentRequester = null
let currentDiscoveryKey = null
let tasksDone = 0
let totalTasksDone = 0
let processing = false // guard against concurrent processTasks calls
const completed = new Set()
const availableRequesters = new Map() // requesterId -> { autobaseKey, pendingTasks, conn, ts }
const mountedDrives = new Map() // driveKey hex -> Hyperdrive instance
let outputDrive = null // worker's own drive for output files
let idleTimer = null
let taskPollTimer = null
let searching = true
let joining = false // guard against concurrent joinRequester calls
const myCapabilities = {} // populated async after swarm init

function stopIdleTimer () {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
}

function resetIdleTimer () {
  stopIdleTimer()
  idleTimer = setTimeout(() => {
    if (base && !searching) {
      console.log(`[~] Idle for ${IDLE_TIMEOUT / 1000}s, leaving ${currentRequester}…`)
      leaveCurrentRequester()
    }
  }, IDLE_TIMEOUT)
}

async function leaveCurrentRequester () {
  // Nullify base and store immediately (synchronous) so concurrent
  // processTasks / poll calls bail at the `if (!base)` guard
  const leavingBase = base
  const leavingStore = store
  const leavingId = currentRequester
  const leavingDiscoveryKey = currentDiscoveryKey
  base = null
  store = null
  currentRequester = null
  currentDiscoveryKey = null

  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  if (taskPollTimer) { clearInterval(taskPollTimer); taskPollTimer = null }

  // Leave Autobase replication topic on the replication swarm
  if (leavingDiscoveryKey) {
    await replicationSwarm.leave(leavingDiscoveryKey)
  }

  // Close old base and store to clean up replication streams
  if (leavingBase) {
    try { await leavingBase.close() } catch {}
  }
  if (leavingStore) {
    try { await leavingStore.close() } catch {}
  }

  // Destroy stale replication connections so the next join() gets fresh ones.
  // Hyperswarm deduplicates — if an old conn survives, 'connection' won't
  // fire again and the new store never gets replicated.
  for (const conn of [...replicationSwarm.connections]) {
    conn.destroy()
  }

  // Remove from pool so we don't rejoin immediately
  if (leavingId) availableRequesters.delete(leavingId)

  console.log(`[~] Left ${leavingId || 'unknown'} (${tasksDone} tasks done)\n`)
  tasksDone = 0
  completed.clear()
  searching = true

  console.log('Searching for requesters with tasks...\n')
  pickBestRequester()
}

async function joinRequester (requesterId, autobaseKey, conn) {
  if (!searching || joining) return
  searching = false
  joining = true
  currentRequester = requesterId

  console.log(`[~] Joining ${requesterId}…`)

  // Close old output drive if lingering from previous session
  if (outputDrive) {
    try { await outputDrive.close() } catch {}
    outputDrive = null
  }

  fs.rmSync(storePath, { recursive: true, force: true })
  store = new Corestore(storePath)
  base = new Autobase(store, Buffer.from(autobaseKey, 'hex'), {
    valueEncoding: 'json', open, apply
  })
  await base.ready()

  currentDiscoveryKey = base.discoveryKey
  const writerKey = base.local.key.toString('hex')

  // Create output drive for file results
  outputDrive = new Hyperdrive(store)
  await outputDrive.ready()
  mountedDrives.clear()

  // Request to join — include capabilities so requester can route tasks
  conn.write(JSON.stringify({
    type: 'join-request', role: 'worker', writerKey, workerId,
    capabilities: myCapabilities
  }))

  // Join the Autobase topic on the REPLICATION swarm (separate from discovery)
  // This creates a fresh connection to the requester, used only for binary
  // Autobase/Corestore protocol — no JSON interference.
  replicationSwarm.join(base.discoveryKey, { client: true, server: true })
  await replicationSwarm.flush()

  // Watch for tasks on new updates
  base.on('update', async () => {
    if (base && base.writable) {
      await processTasks()
    }
  })

  // Poll every 2s to catch tasks already in the log before we joined
  if (taskPollTimer) clearInterval(taskPollTimer)
  taskPollTimer = setInterval(async () => {
    if (!base || searching) { clearInterval(taskPollTimer); taskPollTimer = null; return }
    try {
      await base.update()
      if (base.writable) {
        await processTasks()
      }
    } catch {}
  }, 2000)

  joining = false
  resetIdleTimer()
  console.log(`[~] Connected to ${requesterId}, waiting for authorization...\n`)
}

async function processTasks () {
  if (!base || !base.writable || processing) return
  processing = true

  let didWork = false
  const pendingTasks = []        // uncompleted tasks found so far (survives try block)
  try {
    // Re-scan loop: after each batch completes, immediately re-scan for more
    // tasks that replicated during execution instead of waiting for the next trigger.
    // Indices persist across iterations so we only scan new log entries.
    const resultIndex = new Map()  // taskId -> output
    const claimed = new Set()      // taskIds claimed by any worker
    let scannedUpTo = 0            // how far we've read into the log

    while (base && base.writable) {
      const poolPromises = []
      let batchWork = false

      // Phase 1: incrementally scan only new log entries since last iteration
      await base.update()
      const len = base.view.length
      for (let i = scannedUpTo; i < len; i++) {
        const e = await base.view.get(i)
        if (e.type === 'result') resultIndex.set(e.taskId, e.output)
        else if (e.type === 'claim') claimed.add(e.taskId)
        else if (e.type === 'task') pendingTasks.push(e)
      }
      scannedUpTo = len

      const poolBatch = []   // tasks to dispatch to thread pool at once
      const mainBatch = []   // tasks that need main thread (shell/file-I/O)
      const freeThreads = pool.available
      const stillPending = []

      for (const entry of pendingTasks) {
        if (completed.has(entry.id)) continue
        if (entry.taskType === 'shell') {
          if (!ALLOW_SHELL || !entry.cmd) { stillPending.push(entry); continue }
        } else {
          if (!entry.code) continue
        }
        if (entry.assignedTo && entry.assignedTo !== workerId) continue
        if (entry.requires && !meetsRequirements(entry.requires, myCapabilities)) continue

        // Already has a result
        if (resultIndex.has(entry.id)) { completed.add(entry.id); continue }

        // Already claimed by another worker — skip
        if (claimed.has(entry.id)) continue

        // Block on unresolved dependencies
        if (entry.dependsOn && entry.dependsOn.length > 0) {
          const missing = entry.dependsOn.filter(id => !resultIndex.has(id))
          if (missing.length > 0) { resetIdleTimer(); stillPending.push(entry); continue }
        }

        // Collect dep outputs in order for injection
        const deps = entry.dependsOn
          ? entry.dependsOn.map(id => resultIndex.get(id))
          : []

        const needsFiles = entry.code && /\b(readFile|listFiles|writeFile)\b/.test(entry.code)
        const usePool = entry.taskType !== 'shell' && !needsFiles

        if (usePool) {
          // Only grab as many pool tasks as we have free threads
          if (poolBatch.length >= freeThreads) { stillPending.push(entry); continue }
          poolBatch.push({ entry, deps })
        } else {
          mainBatch.push({ entry, deps })
        }
      }

      // Replace pending list with tasks we didn't dispatch this cycle
      pendingTasks.length = 0
      pendingTasks.push(...stillPending)

      // Nothing to do this cycle — break out of re-scan loop
      if (poolBatch.length === 0 && mainBatch.length === 0) break

      // Phase 2: write claims for all tasks we're about to execute, then dispatch
      for (const { entry } of [...poolBatch, ...mainBatch]) {
        completed.add(entry.id)
        await base.append({ type: 'claim', taskId: entry.id, by: workerId, ts: Date.now() })
      }

      for (const { entry, deps } of poolBatch) {
        batchWork = true
        stopIdleTimer()
        const codePreview = entry.code.trim().replace(/\s+/g, ' ').slice(0, 60)
        console.log(`[>] Task ${entry.id.slice(0, 8)}… | ${codePreview} [pool]`)
        const t0 = performance.now()
        const taskEntry = entry
        const p = pool.runTask(taskEntry, deps).then(async ({ output, threadId }) => {
          const elapsed = (performance.now() - t0).toFixed(2)

          if (!base || !base.writable) {
            console.log(`[!] Task ${taskEntry.id.slice(0, 8)}… done but lost connection — result dropped`)
            return
          }

          const outputFiles = []
          if (outputDrive) {
            for await (const f of outputDrive.list('/')) {
              outputFiles.push(f.key)
            }
          }

          await base.append({
            type: 'result', taskId: taskEntry.id, output,
            elapsed: Number(elapsed), by: workerId, ts: Date.now(),
            driveKey: outputDrive ? outputDrive.key.toString('hex') : undefined,
            outputFiles: outputFiles.length > 0 ? outputFiles : undefined
          })
          tasksDone++
          totalTasksDone++
          addDonated(1)
          const preview = JSON.stringify(output).slice(0, 80)
          console.log(`[<] Done in ${elapsed}ms | thread #${threadId} | ${preview}`)
          console.log(`    (${tasksDone} for this requester, ${totalTasksDone} total)\n`)
        }).catch(async (err) => {
          if (base && base.writable) {
            await base.append({
              type: 'result', taskId: taskEntry.id, error: err.message,
              by: workerId, ts: Date.now()
            })
          }
          console.log(`[!] Error: ${err.message}\n`)
        })
        poolPromises.push(p)
      }

      // Phase 3: run main-thread tasks sequentially (shell/file-I/O)
      for (const { entry, deps } of mainBatch) {
        batchWork = true
        stopIdleTimer()
        const codePreview = entry.taskType === 'shell'
          ? `[SHELL] ${entry.cmd.trim().slice(0, 60)}`
          : entry.code.trim().replace(/\s+/g, ' ').slice(0, 60)
        console.log(`[>] Task ${entry.id.slice(0, 8)}… | ${codePreview} [main]`)

        let inputDrive = null
        if (entry.driveKey && store) {
          if (!mountedDrives.has(entry.driveKey)) {
            const d = new Hyperdrive(store, Buffer.from(entry.driveKey, 'hex'))
            await d.ready()
            mountedDrives.set(entry.driveKey, d)
          }
          inputDrive = mountedDrives.get(entry.driveKey)
          for (let attempt = 0; attempt < 10; attempt++) {
            await inputDrive.update()
            if (inputDrive.version > 0) break
            await new Promise(r => setTimeout(r, 500))
          }
        }

        const t0 = performance.now()
        try {
          const output = await executeTask(entry, inputDrive, outputDrive, null, deps)
          const elapsed = (performance.now() - t0).toFixed(2)

          if (!base || !base.writable) {
            console.log(`[!] Task ${entry.id.slice(0, 8)}… done but lost connection — result dropped`)
            continue
          }

          const outputFiles = []
          if (outputDrive) {
            for await (const f of outputDrive.list('/')) {
              outputFiles.push(f.key)
            }
          }

          await base.append({
            type: 'result', taskId: entry.id, output,
            elapsed: Number(elapsed), by: workerId, ts: Date.now(),
            driveKey: outputDrive ? outputDrive.key.toString('hex') : undefined,
            outputFiles: outputFiles.length > 0 ? outputFiles : undefined
          })
          tasksDone++
          totalTasksDone++
          addDonated(1)
          if (entry.taskType === 'shell' && output) {
            const stdoutPreview = (output.stdout || '').trim().slice(0, 80)
            console.log(`[<] Done in ${elapsed}ms | exit=${output.exitCode} | ${stdoutPreview}`)
            if (output.timedOut) console.log(`    [!] Process timed out`)
          } else {
            const preview = JSON.stringify(output).slice(0, 80)
            console.log(`[<] Done in ${elapsed}ms | ${preview}`)
          }
          console.log(`    (${tasksDone} for this requester, ${totalTasksDone} total)\n`)
        } catch (err) {
          if (base && base.writable) {
            await base.append({
              type: 'result', taskId: entry.id, error: err.message,
              by: workerId, ts: Date.now()
            })
          }
          console.log(`[!] Error: ${err.message}\n`)
        }
        resetIdleTimer()
      }

      // Wait for all pool tasks dispatched this cycle to finish
      if (poolPromises.length > 0) {
        await Promise.all(poolPromises)
      }

      didWork = didWork || batchWork
      // Loop back to re-scan for tasks that replicated during this batch
    }
  } finally {
    processing = false
  }

  // If we did work and nothing left, check for other requesters immediately
  if (didWork && base) {
    if (pendingTasks.length === 0) {
      let betterOption = false
      for (const [id, info] of availableRequesters) {
        if (id !== currentRequester && info.pendingTasks > 0 && Date.now() - info.ts < 30000 && canHelpRequester(info)) {
          betterOption = true
          break
        }
      }
      if (betterOption) {
        console.log('[~] All tasks done here, another requester has work — moving on')
        leaveCurrentRequester()
      }
    }
  }
}

function canHelpRequester (info) {
  const reqs = info.pendingRequires || []
  if (reqs.length === 0) return true
  return reqs.some(req => meetsRequirements(req, myCapabilities))
}

function pickBestRequester () {
  if (!searching) return

  // Rank requesters: must have pending tasks, prefer higher reputation score
  const candidates = []
  for (const [id, info] of availableRequesters) {
    if (Date.now() - info.ts > 30000) continue // skip stale
    if (info.pendingTasks <= 0) continue // skip idle
    if (info.conn.destroyed) continue // skip dead connections
    if (!canHelpRequester(info)) continue // skip: no pending tasks this worker can run
    const score = info.reputation?.score ?? 0
    candidates.push({ id, info, score })
  }

  // Sort by reputation score (descending), then by pending tasks (descending)
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.info.pendingTasks - a.info.pendingTasks
  })

  if (candidates.length > 0) {
    const pick = candidates[0]
    const scoreStr = pick.score !== 0 ? ` (reputation: ${pick.score})` : ''
    console.log(`[~] Found ${pick.id} with ${pick.info.pendingTasks} pending task(s)${scoreStr}`)
    if (candidates.length > 1) {
      console.log(`    (${candidates.length - 1} other requester(s) available, picked highest reputation)`)
    }
    joinRequester(pick.id, pick.info.autobaseKey, pick.info.conn).catch((err) => {
      console.log(`[!] Failed to join ${pick.id}: ${err.message}`)
      searching = true
      currentRequester = null
    })
  }
}

// Join well-known topic on DISCOVERY swarm only (JSON signaling, no replication)
discoverySwarm.join(NETWORK_TOPIC, { client: true, server: true })

discoverySwarm.on('connection', (conn) => {
  conn.on('error', () => {})
  conn.on('close', () => {
    for (const [id, info] of availableRequesters) {
      if (info.conn === conn) { availableRequesters.delete(id); break }
    }
  })

  conn.on('data', async (data) => {
    try {
      const msg = JSON.parse(data.toString())

      if (msg.type === 'advertise' && msg.role === 'requester') {
        const repScore = msg.reputation?.score ?? 0
        availableRequesters.set(msg.requesterId, {
          autobaseKey: msg.autobaseKey,
          pendingTasks: msg.pendingTasks || 0,
          pendingRequires: msg.pendingRequires || [],
          workerCount: msg.workerCount || 0,
          reputation: msg.reputation || { donated: 0, consumed: 0, score: 0 },
          conn,
          ts: Date.now()
        })

        if (searching) {
          if (msg.pendingTasks > 0) {
            const scoreStr = repScore !== 0 ? `, reputation: ${repScore}` : ''
            console.log(`[~] Found ${msg.requesterId} (${msg.pendingTasks} pending tasks${scoreStr})`)
            pickBestRequester()
          } else {
            console.log(`[~] Found ${msg.requesterId} (no pending tasks, staying available)`)
          }
        }
      }

      if (msg.type === 'join-accepted') {
        console.log(`[+] Authorized by ${currentRequester}!`)
        resetIdleTimer()
      }
    } catch {}
  })

  // NO replication on discovery connections
})

// Detect capabilities in background — doesn't block swarm startup
console.log('Detecting capabilities...')
detectCapabilities().then(caps => {
  Object.assign(myCapabilities, caps)
  console.log(`Platform: ${caps.platform}/${caps.arch} | CPU: ${caps.cpuCores} cores | RAM: ${caps.ramGB}GB`)
  console.log(`GPU: ${caps.gpuName} (${caps.gpuType}) | Python: ${caps.hasPython ? caps.pythonVersion : 'no'} | PyTorch: ${caps.hasPyTorch ? caps.pytorchVersion : 'no'}`)
  // Re-evaluate known requesters now that caps are populated
  if (searching) pickBestRequester()
})

discoverySwarm.flush().then(() => console.log('DHT bootstrap complete.'))
console.log('Listening for requesters on network...\n')

// Periodically check for requesters if searching
setInterval(() => {
  if (searching) pickBestRequester()
}, 5000)

process.on('SIGINT', async () => {
  const rep = loadReputation()
  console.log(`\nShutting down… (${totalTasksDone} tasks completed, reputation: score=${getScore(rep)})`)
  if (idleTimer) clearTimeout(idleTimer)
  if (taskPollTimer) clearInterval(taskPollTimer)
  await pool.destroy()
  await discoverySwarm.destroy()
  await replicationSwarm.destroy()
  if (base) try { await base.close() } catch {}
  fs.rmSync(storePath, { recursive: true, force: true })
  process.exit()
})
