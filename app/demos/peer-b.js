// Peer B: Compute worker — watches for tasks, executes arbitrary JS, writes results
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import fs from 'fs'
import { executeTask } from '../worker.js'

const BOOTSTRAP = process.env.BOOTSTRAP // optional, uses public DHT if not set
const AUTOBASE_KEY = process.argv[2]

if (!AUTOBASE_KEY) { console.error('Usage: node peer-b.js <autobase-key>'); process.exit(1) }

fs.rmSync('./store-b', { recursive: true, force: true })

function open (store) { return store.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, base) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      await base.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true })
    }
    await view.append(node.value)
  }
}

const store = new Corestore('./store-b')
const base = new Autobase(store, Buffer.from(AUTOBASE_KEY, 'hex'), { valueEncoding: 'json', open, apply })
await base.ready()

console.log('=== PEER B (Compute Worker) ===')
console.log('Writer key:', base.local.key.toString('hex'))
console.log('')
console.log('>>> Give this writer key to Peer A so they can authorize you <<<')
console.log('')

const swarmOpts = BOOTSTRAP ? { bootstrap: [{ host: BOOTSTRAP.split(':')[0], port: Number(BOOTSTRAP.split(':')[1]) }] } : {}
const swarm = new Hyperswarm(swarmOpts)
swarm.on('connection', (conn) => {
  console.log('[B] peer connected!')
  base.replicate(conn)
})
swarm.join(base.discoveryKey, { client: true, server: true })
await swarm.flush()
console.log('[B] in swarm, watching for tasks...\n')

const completed = new Set()

base.on('update', async () => {
  for (let i = 0; i < base.view.length; i++) {
    const entry = await base.view.get(i)
    if (entry.type !== 'task' || completed.has(entry.id)) continue
    if (!entry.code) continue // skip old-format tasks

    // Check if already computed
    let hasResult = false
    for (let j = 0; j < base.view.length; j++) {
      const e = await base.view.get(j)
      if (e.type === 'result' && e.taskId === entry.id) { hasResult = true; break }
    }
    if (hasResult) continue

    completed.add(entry.id)
    console.log(`[B] task ${entry.id.slice(0, 8)}... code: ${entry.code.trim().slice(0, 60)}`)

    const t0 = performance.now()
    try {
      const output = await executeTask(entry)
      const elapsed = (performance.now() - t0).toFixed(2)
      if (base.writable) {
        await base.append({ type: 'result', taskId: entry.id, output, by: 'peer-B', ts: Date.now() })
        console.log(`[B] done in ${elapsed}ms → ${JSON.stringify(output).slice(0, 80)}\n`)
      } else {
        console.log('[B] computed but NOT WRITABLE — Peer A needs to add your writer key\n')
      }
    } catch (err) {
      if (base.writable) {
        await base.append({ type: 'result', taskId: entry.id, error: err.message, by: 'peer-B', ts: Date.now() })
      }
      console.log(`[B] error: ${err.message}\n`)
    }
  }
})

process.on('SIGINT', async () => {
  await swarm.destroy()
  await base.close()
  process.exit()
})
