// Compute worker: discovers requesters on network, joins one with tasks, computes, moves on
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import crypto from 'crypto'
import fs from 'fs'
import { NETWORK_TOPIC } from './base-setup.js'
import { executeTask } from './worker.js'

const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`
const storePath = `./store-${workerId}`
const IDLE_TIMEOUT = 15000 // leave after 15s with no tasks

console.log('╔═══════════════════════════════════════════╗')
console.log('║         OFFER COMPUTE — Worker            ║')
console.log('╠═══════════════════════════════════════════╣')
console.log(`║  Worker ID: ${workerId}                ║`)
console.log('╚═══════════════════════════════════════════╝')
console.log('')
console.log(`Idle timeout: ${IDLE_TIMEOUT / 1000}s | Store: ${storePath}\n`)

const BOOTSTRAP = process.env.BOOTSTRAP
const swarmOpts = BOOTSTRAP
  ? { bootstrap: [{ host: BOOTSTRAP.split(':')[0], port: Number(BOOTSTRAP.split(':')[1]) }] }
  : {}
const swarm = new Hyperswarm(swarmOpts)

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
let idleTimer = null
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

  const leavingId = currentRequester

  // Leave old autobase discovery topic
  if (currentDiscoveryKey) {
    swarm.leave(currentDiscoveryKey)
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

  // Request to join
  conn.write(JSON.stringify({
    type: 'join-request', role: 'worker', writerKey, workerId
  }))

  // Replicate
  base.replicate(conn)
  swarm.join(base.discoveryKey, { client: true, server: true })

  // Watch for tasks
  base.on('update', async () => {
    if (base && base.writable) {
      await processTasks()
    }
  })

  resetIdleTimer()
  console.log(`[~] Connected to ${requesterId}, waiting for authorization...\n`)
}

async function processTasks () {
  if (!base || !base.writable) return

  let didWork = false

  for (let i = 0; i < base.view.length; i++) {
    const entry = await base.view.get(i)
    if (entry.type !== 'task' || completed.has(entry.id)) continue
    if (!entry.code) continue
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

    const codePreview = entry.code.trim().replace(/\s+/g, ' ').slice(0, 60)
    console.log(`[>] Task ${entry.id.slice(0, 8)}… | ${codePreview}`)

    const t0 = performance.now()
    try {
      const output = await executeTask(entry)
      const elapsed = (performance.now() - t0).toFixed(2)
      await base.append({
        type: 'result', taskId: entry.id, output,
        elapsed: Number(elapsed), by: workerId, ts: Date.now()
      })
      tasksDone++
      totalTasksDone++
      const preview = JSON.stringify(output).slice(0, 80)
      console.log(`[<] Done in ${elapsed}ms | ${preview}`)
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
      if (entry.type !== 'task' || !entry.code) continue
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

  let best = null
  let bestTasks = 0 // only pick requesters with > 0 tasks

  for (const [id, info] of availableRequesters) {
    // Skip stale advertisements (> 30s old)
    if (Date.now() - info.ts > 30000) continue
    if (info.pendingTasks > bestTasks) {
      best = id
      bestTasks = info.pendingTasks
    }
  }

  if (best) {
    const info = availableRequesters.get(best)
    console.log(`[~] Found ${best} with ${info.pendingTasks} pending task(s)`)
    joinRequester(best, info.autobaseKey, info.conn)
  }
}

// Join well-known topic to find requesters
swarm.join(NETWORK_TOPIC, { client: true, server: true })

swarm.on('connection', (conn) => {
  conn.on('data', async (data) => {
    try {
      const msg = JSON.parse(data.toString())

      if (msg.type === 'advertise' && msg.role === 'requester') {
        availableRequesters.set(msg.requesterId, {
          autobaseKey: msg.autobaseKey,
          pendingTasks: msg.pendingTasks || 0,
          workerCount: msg.workerCount || 0,
          conn,
          ts: Date.now()
        })

        if (searching) {
          if (msg.pendingTasks > 0) {
            console.log(`[~] Found ${msg.requesterId} (${msg.pendingTasks} pending tasks)`)
            joinRequester(msg.requesterId, msg.autobaseKey, conn)
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

  // If we already have a base, replicate on new connections
  if (base) {
    base.replicate(conn)
  }
})

await swarm.flush()
console.log('Listening for requesters on network...\n')

// Periodically check for requesters if searching
setInterval(() => {
  if (searching) pickBestRequester()
}, 5000)

process.on('SIGINT', async () => {
  console.log(`\nShutting down… (${totalTasksDone} tasks completed total)`)
  if (idleTimer) clearTimeout(idleTimer)
  await swarm.destroy()
  if (base) try { await base.close() } catch {}
  fs.rmSync(storePath, { recursive: true, force: true })
  process.exit()
})
