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

const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`
const storePath = `./store-${workerId}`
const IDLE_TIMEOUT = 15000 // leave after 15s with no tasks
const ALLOW_SHELL = process.env.ALLOW_SHELL === '1' || process.env.ALLOW_SHELL === 'true'

console.log('╔═══════════════════════════════════════════╗')
console.log('║         OFFER COMPUTE — Worker            ║')
console.log('╠═══════════════════════════════════════════╣')
console.log(`║  Worker ID: ${workerId}                ║`)
console.log('╚═══════════════════════════════════════════╝')
console.log('')
console.log(`Idle timeout: ${IDLE_TIMEOUT / 1000}s | Store: ${storePath}`)
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

replicationSwarm.on('connection', (conn) => {
  if (store) store.replicate(conn)
})

function open (s) { return s.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, b) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      await b.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true })
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
const completed = new Set()
const availableRequesters = new Map() // requesterId -> { autobaseKey, pendingTasks, conn, ts }
const mountedDrives = new Map() // driveKey hex -> Hyperdrive instance
let outputDrive = null // worker's own drive for output files
let idleTimer = null
let taskPollTimer = null
let searching = true

function resetIdleTimer () {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (base && !searching) {
      console.log(`[~] Idle for ${IDLE_TIMEOUT / 1000}s, leaving ${currentRequester}…`)
      leaveCurrentRequester()
    }
  }, IDLE_TIMEOUT)
}

async function leaveCurrentRequester () {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  if (taskPollTimer) { clearInterval(taskPollTimer); taskPollTimer = null }

  const leavingId = currentRequester

  // Leave Autobase replication topic on the replication swarm
  if (currentDiscoveryKey) {
    replicationSwarm.leave(currentDiscoveryKey)
    currentDiscoveryKey = null
  }

  // Close old base
  if (base) {
    try { await base.close() } catch {}
    base = null
    store = null
  }

  // Remove from pool so we don't rejoin immediately
  if (leavingId) availableRequesters.delete(leavingId)

  console.log(`[~] Left ${leavingId || 'unknown'} (${tasksDone} tasks done)\n`)
  currentRequester = null
  tasksDone = 0
  completed.clear()
  searching = true

  console.log('Searching for requesters with tasks...\n')
  pickBestRequester()
}

async function joinRequester (requesterId, autobaseKey, conn) {
  if (!searching) return
  searching = false
  currentRequester = requesterId

  console.log(`[~] Joining ${requesterId}…`)

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

  // Request to join (JSON on discovery connection — safe, no replication here)
  conn.write(JSON.stringify({
    type: 'join-request', role: 'worker', writerKey, workerId
  }))

  // Join the Autobase topic on the REPLICATION swarm (separate from discovery)
  // This creates a fresh connection to the requester, used only for binary
  // Autobase/Corestore protocol — no JSON interference.
  replicationSwarm.join(base.discoveryKey, { client: true, server: true })

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

  resetIdleTimer()
  console.log(`[~] Connected to ${requesterId}, waiting for authorization...\n`)
}

async function processTasks () {
  if (!base || !base.writable) return

  let didWork = false

  for (let i = 0; i < base.view.length; i++) {
    const entry = await base.view.get(i)
    if (entry.type !== 'task' || completed.has(entry.id)) continue
    if (entry.taskType === 'shell') {
      if (!ALLOW_SHELL || !entry.cmd) continue
    } else {
      if (!entry.code) continue
    }
    if (entry.assignedTo && entry.assignedTo !== workerId) continue

    // Check if result exists
    let hasResult = false
    for (let j = 0; j < base.view.length; j++) {
      const e = await base.view.get(j)
      if (e.type === 'result' && e.taskId === entry.id) { hasResult = true; break }
    }
    if (hasResult) { completed.add(entry.id); continue }

    completed.add(entry.id)
    didWork = true
    resetIdleTimer()

    const codePreview = entry.taskType === 'shell'
      ? `[SHELL] ${entry.cmd.trim().slice(0, 60)}`
      : entry.code.trim().replace(/\s+/g, ' ').slice(0, 60)
    console.log(`[>] Task ${entry.id.slice(0, 8)}… | ${codePreview}`)

    // Mount requester's drive if task has files
    let inputDrive = null
    if (entry.driveKey && store) {
      if (!mountedDrives.has(entry.driveKey)) {
        const d = new Hyperdrive(store, Buffer.from(entry.driveKey, 'hex'))
        await d.ready()
        mountedDrives.set(entry.driveKey, d)
      }
      inputDrive = mountedDrives.get(entry.driveKey)
    }

    const t0 = performance.now()
    try {
      const output = await executeTask(entry, inputDrive, outputDrive)
      const elapsed = (performance.now() - t0).toFixed(2)

      // Check if output files were written
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
      await base.append({
        type: 'result', taskId: entry.id, error: err.message,
        by: workerId, ts: Date.now()
      })
      console.log(`[!] Error: ${err.message}\n`)
    }
  }

  // If we did work and there's nothing left, check for other requesters immediately
  if (didWork) {
    let hasRemainingTasks = false
    for (let i = 0; i < base.view.length; i++) {
      const entry = await base.view.get(i)
      if (entry.type !== 'task') continue
      if (entry.taskType === 'shell' ? (!ALLOW_SHELL || !entry.cmd) : !entry.code) continue
      if (entry.assignedTo && entry.assignedTo !== workerId) continue
      if (completed.has(entry.id)) continue
      hasRemainingTasks = true
      break
    }

    if (!hasRemainingTasks) {
      // Check if another requester has tasks waiting
      let betterOption = false
      for (const [id, info] of availableRequesters) {
        if (id !== currentRequester && info.pendingTasks > 0 && Date.now() - info.ts < 30000) {
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

function pickBestRequester () {
  if (!searching) return

  // Rank requesters: must have pending tasks, prefer higher reputation score
  const candidates = []
  for (const [id, info] of availableRequesters) {
    if (Date.now() - info.ts > 30000) continue // skip stale
    if (info.pendingTasks <= 0) continue // skip idle
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
    joinRequester(pick.id, pick.info.autobaseKey, pick.info.conn)
  }
}

// Join well-known topic on DISCOVERY swarm only (JSON signaling, no replication)
discoverySwarm.join(NETWORK_TOPIC, { client: true, server: true })

discoverySwarm.on('connection', (conn) => {
  conn.on('data', async (data) => {
    try {
      const msg = JSON.parse(data.toString())

      if (msg.type === 'advertise' && msg.role === 'requester') {
        const repScore = msg.reputation?.score ?? 0
        availableRequesters.set(msg.requesterId, {
          autobaseKey: msg.autobaseKey,
          pendingTasks: msg.pendingTasks || 0,
          workerCount: msg.workerCount || 0,
          reputation: msg.reputation || { donated: 0, consumed: 0, score: 0 },
          conn,
          ts: Date.now()
        })

        if (searching) {
          if (msg.pendingTasks > 0) {
            const scoreStr = repScore !== 0 ? `, reputation: ${repScore}` : ''
            console.log(`[~] Found ${msg.requesterId} (${msg.pendingTasks} pending tasks${scoreStr})`)
            pickBestRequester() // let ranking decide instead of joining immediately
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

await discoverySwarm.flush()
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
  await discoverySwarm.destroy()
  await replicationSwarm.destroy()
  if (base) try { await base.close() } catch {}
  fs.rmSync(storePath, { recursive: true, force: true })
  process.exit()
})
