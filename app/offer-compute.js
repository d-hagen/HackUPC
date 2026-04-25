// Compute worker: discovers requesters on network, joins one with tasks, computes, moves on
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import crypto from 'crypto'
import fs from 'fs'
import { NETWORK_TOPIC } from './base-setup.js'
import { executeTask } from './worker.js'

const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`
const IDLE_TIMEOUT = 15000 // leave after 15s with no tasks

console.log('╔═══════════════════════════════════════════╗')
console.log('║         OFFER COMPUTE — Worker            ║')
console.log('╠═══════════════════════════════════════════╣')
console.log(`║  Worker ID: ${workerId}                ║`)
console.log('╚═══════════════════════════════════════════╝')
console.log('')
console.log(`Idle timeout: ${IDLE_TIMEOUT / 1000}s (leaves requester if no tasks)\n`)

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
let tasksDone = 0
let totalTasksDone = 0
const completed = new Set()
const availableRequesters = new Map() // requesterId -> { autobaseKey, pendingTasks, conn, ts }
let idleTimer = null
let searching = true

function resetIdleTimer () {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (base && searching === false) {
      console.log(`[~] Idle for ${IDLE_TIMEOUT / 1000}s, leaving ${currentRequester}…`)
      leaveCurrentRequester()
    }
  }, IDLE_TIMEOUT)
}

async function leaveCurrentRequester () {
  if (base) {
    console.log(`[~] Disconnecting from ${currentRequester} (completed ${tasksDone} tasks)\n`)
    base = null
    store = null
    currentRequester = null
    tasksDone = 0
    completed.clear()
  }
  searching = true
  console.log('Searching for requesters with tasks...\n')
  pickBestRequester()
}

async function joinRequester (requesterId, autobaseKey, conn) {
  if (!searching) return
  searching = false
  currentRequester = requesterId

  console.log(`[~] Joining ${requesterId}…`)

  fs.rmSync('./store-worker', { recursive: true, force: true })
  store = new Corestore('./store-worker')
  base = new Autobase(store, Buffer.from(autobaseKey, 'hex'), {
    valueEncoding: 'json', open, apply
  })
  await base.ready()

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
    resetIdleTimer() // got work, reset idle

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
}

function pickBestRequester () {
  if (!searching) return

  // Pick the requester with the most pending tasks
  let best = null
  let bestTasks = -1
  for (const [id, info] of availableRequesters) {
    if (info.pendingTasks > bestTasks) {
      best = id
      bestTasks = info.pendingTasks
    }
  }

  if (best && bestTasks > 0) {
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

// If no requester found yet, periodically check
setInterval(() => {
  if (searching) pickBestRequester()
}, 5000)

process.on('SIGINT', async () => {
  console.log(`\nShutting down… (${totalTasksDone} tasks completed total)`)
  if (idleTimer) clearTimeout(idleTimer)
  await swarm.destroy()
  if (base) await base.close()
  process.exit()
})
