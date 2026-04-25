import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import crypto from 'crypto'
import fs from 'fs'

// Clean up
fs.rmSync('./test-peer-a', { recursive: true, force: true })
fs.rmSync('./test-peer-b', { recursive: true, force: true })

function open (store) {
  return store.get('view', { valueEncoding: 'json' })
}

async function apply (nodes, view, base) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      await base.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true })
    }
    await view.append(node.value)
  }
}

// ---- Create Peer A (founder) ----
const storeA = new Corestore('./test-peer-a')
const baseA = new Autobase(storeA, null, { valueEncoding: 'json', open, apply })
await baseA.ready()
console.log('[A] autobase key:', baseA.key.toString('hex').slice(0, 16) + '...')

// ---- Create Peer B (joins A's autobase) ----
const storeB = new Corestore('./test-peer-b')
const baseB = new Autobase(storeB, baseA.key, { valueEncoding: 'json', open, apply })
await baseB.ready()
console.log('[B] writer key:', baseB.local.key.toString('hex').slice(0, 16) + '...')

// ---- Connect via Hyperswarm ----
const swarmA = new Hyperswarm()
const swarmB = new Hyperswarm()

swarmA.on('connection', (conn) => { console.log('[A] peer connected'); baseA.replicate(conn) })
swarmB.on('connection', (conn) => { console.log('[B] peer connected'); baseB.replicate(conn) })

swarmA.join(baseA.discoveryKey, { client: true, server: true })
swarmB.join(baseB.discoveryKey, { client: true, server: true })

await swarmA.flush()
await swarmB.flush()
console.log('[*] both peers in swarm, waiting for connection...')

// Wait for peers to find each other
await new Promise((resolve) => {
  let connected = false
  swarmA.on('connection', () => { if (!connected) { connected = true; console.log('[*] peers connected!'); setTimeout(resolve, 2000) } })
  // Fallback timeout
  setTimeout(() => { if (!connected) { console.log('[*] connection timeout -- continuing anyway'); resolve() } }, 15000)
})

// ---- A adds B as a writer ----
console.log('[A] adding B as writer...')
await baseA.append({ type: 'add-writer', key: baseB.local.key.toString('hex'), by: 'peer-A', ts: Date.now() })

// Wait for sync
await new Promise(resolve => setTimeout(resolve, 3000))

// ---- A posts a task ----
const task = {
  type: 'task',
  id: crypto.randomUUID(),
  action: 'mandelbrot',
  params: { x: 0, y: 0, w: 64, h: 64, iter: 100 },
  status: 'pending',
  by: 'peer-A',
  ts: Date.now()
}
await baseA.append(task)
console.log('[A] posted task:', task.id)

// Wait for sync
await new Promise(resolve => setTimeout(resolve, 5000))

// ---- B reads the view ----
console.log(`\n[B] reading view (${baseB.view.length} entries):`)
for (let i = 0; i < baseB.view.length; i++) {
  const entry = await baseB.view.get(i)
  console.log(`  ${i}:`, entry)
}

// ---- B writes a result ----
if (baseB.writable) {
  const result = { type: 'result', taskId: task.id, output: 'computed!', by: 'peer-B', ts: Date.now() }
  await baseB.append(result)
  console.log('[B] wrote result')
} else {
  console.log('[B] NOT writable yet -- addWriter may not have synced')
}

// Wait for sync
await new Promise(resolve => setTimeout(resolve, 3000))

// ---- A reads final state ----
console.log(`\n[A] final view (${baseA.view.length} entries):`)
for (let i = 0; i < baseA.view.length; i++) {
  const entry = await baseA.view.get(i)
  console.log(`  ${i}:`, entry)
}

// Cleanup
await swarmA.destroy()
await swarmB.destroy()
await baseA.close()
await baseB.close()

console.log('\n[*] test complete')
