// Compute worker: auto-discovers requesters on the network, joins and executes tasks
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import crypto from 'crypto'
import fs from 'fs'
import { NETWORK_TOPIC } from './base-setup.js'
import { executeTask } from './worker.js'

const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`

console.log('╔═══════════════════════════════════════════╗')
console.log('║         OFFER COMPUTE — Worker            ║')
console.log('╠═══════════════════════════════════════════╣')
console.log(`║  Worker ID: ${workerId}                ║`)
console.log('╚═══════════════════════════════════════════╝')
console.log('')
console.log('Searching for requesters on the network...\n')

const BOOTSTRAP = process.env.BOOTSTRAP
const swarmOpts = BOOTSTRAP
  ? { bootstrap: [{ host: BOOTSTRAP.split(':')[0], port: Number(BOOTSTRAP.split(':')[1]) }] }
  : {}
const swarm = new Hyperswarm(swarmOpts)

let base = null
let store = null
const completed = new Set()
let tasksDone = 0
let joined = false

function open (s) { return s.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, b) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      await b.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true })
    }
    await view.append(node.value)
  }
}

async function processTasks () {
  if (!base || !base.writable) return

  for (let i = 0; i < base.view.length; i++) {
    const entry = await base.view.get(i)
    if (entry.type !== 'task' || completed.has(entry.id)) continue
    if (!entry.code) continue

    // Check if result already exists
    let hasResult = false
    for (let j = 0; j < base.view.length; j++) {
      const e = await base.view.get(j)
      if (e.type === 'result' && e.taskId === entry.id) { hasResult = true; break }
    }
    if (hasResult) { completed.add(entry.id); continue }

    completed.add(entry.id)
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
      const preview = JSON.stringify(output).slice(0, 80)
      console.log(`[<] Done in ${elapsed}ms | ${preview}`)
      console.log(`    (${tasksDone} tasks completed)\n`)
    } catch (err) {
      await base.append({
        type: 'result', taskId: entry.id, error: err.message,
        by: workerId, ts: Date.now()
      })
      console.log(`[!] Error: ${err.message}\n`)
    }
  }
}

// Join well-known topic to find requesters
swarm.join(NETWORK_TOPIC, { client: true, server: true })

swarm.on('connection', (conn, info) => {
  conn.on('data', async (data) => {
    try {
      const msg = JSON.parse(data.toString())

      if (msg.type === 'handshake' && msg.role === 'requester' && !joined) {
        joined = true
        console.log('[~] Found requester! Joining compute network...')

        // Create our autobase joining the requester's network
        fs.rmSync('./store-worker', { recursive: true, force: true })
        store = new Corestore('./store-worker')
        base = new Autobase(store, Buffer.from(msg.autobaseKey, 'hex'), {
          valueEncoding: 'json', open, apply
        })
        await base.ready()

        const writerKey = base.local.key.toString('hex')
        console.log(`[~] Writer key: ${writerKey.slice(0, 24)}…`)

        // Send our writer key back so the requester can authorize us
        conn.write(JSON.stringify({
          type: 'handshake', role: 'worker', writerKey, workerId
        }))

        // Replicate autobase over this connection
        base.replicate(conn)

        // Also join the autobase's discovery key for data replication
        swarm.join(base.discoveryKey, { client: true, server: true })

        // Watch for tasks
        base.on('update', async () => {
          // Announce once writable
          if (base.writable) {
            await processTasks()
          }
        })

        console.log('[~] Connected! Waiting for authorization...\n')
      }
    } catch {}
  })

  // If we already have a base, replicate on new connections too
  if (base) {
    base.replicate(conn)
  }
})

await swarm.flush()

process.on('SIGINT', async () => {
  console.log('\nShutting down...')
  await swarm.destroy()
  if (base) await base.close()
  process.exit()
})
