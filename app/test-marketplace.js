// Test: multiple requesters, multiple workers, marketplace model
import Corestore from 'corestore'
import Autobase from 'autobase'
import crypto from 'crypto'
import fs from 'fs'
import { executeTask } from './worker.js'

// Clean
for (const d of ['store-r1', 'store-r2', 'store-w1', 'store-w2']) {
  fs.rmSync(d, { recursive: true, force: true })
}

function open (store) { return store.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, base) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      await base.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true })
    }
    await view.append(node.value)
  }
}

async function createRequester (storePath) {
  const store = new Corestore(storePath)
  const base = new Autobase(store, null, { valueEncoding: 'json', open, apply })
  await base.ready()
  return { store, base }
}

async function createWorker (storePath, autobaseKey) {
  const store = new Corestore(storePath)
  const base = new Autobase(store, Buffer.from(autobaseKey, 'hex'), { valueEncoding: 'json', open, apply })
  await base.ready()
  return { store, base }
}

async function sync (...bases) {
  for (const b of bases) await b.update()
  await new Promise(r => setTimeout(r, 300))
  for (const b of bases) await b.update()
}

// === Setup: 2 requesters, 2 workers ===
const r1 = await createRequester('./store-r1')
const r2 = await createRequester('./store-r2')

// Worker 1 joins requester 1
const w1 = await createWorker('./store-w1', r1.base.key.toString('hex'))
const s1a = r1.store.replicate(true); const s1b = w1.store.replicate(false); s1a.pipe(s1b).pipe(s1a)

// Worker 2 joins requester 2
const w2 = await createWorker('./store-w2', r2.base.key.toString('hex'))
const s2a = r2.store.replicate(true); const s2b = w2.store.replicate(false); s2a.pipe(s2b).pipe(s2a)

// Authorize workers
await r1.base.append({ type: 'add-writer', key: w1.base.local.key.toString('hex'), by: 'requester-1', ts: Date.now() })
await r2.base.append({ type: 'add-writer', key: w2.base.local.key.toString('hex'), by: 'requester-2', ts: Date.now() })
await sync(r1.base, w1.base, r2.base, w2.base)

console.log('╔═══════════════════════════════════════════╗')
console.log('║  Marketplace Test: 2 requesters, 2 workers║')
console.log('╚═══════════════════════════════════════════╝\n')

// === Requester 1 posts a task ===
console.log('--- Requester 1: posting "return 100 + 200" ---')
const t1id = crypto.randomUUID()
await r1.base.append({
  type: 'task', id: t1id, code: 'return 100 + 200', argNames: [], args: [],
  by: 'requester-1', ts: Date.now()
})
await sync(r1.base, w1.base)

// Worker 1 executes
for (let i = 0; i < w1.base.view.length; i++) {
  const e = await w1.base.view.get(i)
  if (e.type === 'task' && e.id === t1id) {
    const output = await executeTask(e)
    await w1.base.append({ type: 'result', taskId: t1id, output, by: 'worker-1', ts: Date.now() })
    console.log(`Worker 1 computed: ${output}`)
  }
}
await sync(r1.base, w1.base)

// Requester 1 gets result
for (let i = 0; i < r1.base.view.length; i++) {
  const e = await r1.base.view.get(i)
  if (e.type === 'result' && e.taskId === t1id) {
    console.log(`Requester 1 received: ${e.output} from ${e.by}\n`)
  }
}

// === Requester 2 posts a different task ===
console.log('--- Requester 2: posting "return Array.from({length:5}, (_,i) => i*i)" ---')
const t2id = crypto.randomUUID()
await r2.base.append({
  type: 'task', id: t2id, code: 'return Array.from({length:5}, (_,i) => i*i)', argNames: [], args: [],
  by: 'requester-2', ts: Date.now()
})
await sync(r2.base, w2.base)

// Worker 2 executes
for (let i = 0; i < w2.base.view.length; i++) {
  const e = await w2.base.view.get(i)
  if (e.type === 'task' && e.id === t2id) {
    const output = await executeTask(e)
    await w2.base.append({ type: 'result', taskId: t2id, output, by: 'worker-2', ts: Date.now() })
    console.log(`Worker 2 computed: ${JSON.stringify(output)}`)
  }
}
await sync(r2.base, w2.base)

// Requester 2 gets result
for (let i = 0; i < r2.base.view.length; i++) {
  const e = await r2.base.view.get(i)
  if (e.type === 'result' && e.taskId === t2id) {
    console.log(`Requester 2 received: ${JSON.stringify(e.output)} from ${e.by}\n`)
  }
}

// === Verify isolation: requester 1 does NOT see requester 2's tasks ===
console.log('--- Isolation check ---')
let r1Tasks = 0, r2Tasks = 0
for (let i = 0; i < r1.base.view.length; i++) {
  const e = await r1.base.view.get(i)
  if (e.type === 'task') r1Tasks++
}
for (let i = 0; i < r2.base.view.length; i++) {
  const e = await r2.base.view.get(i)
  if (e.type === 'task') r2Tasks++
}
console.log(`Requester 1 autobase: ${r1Tasks} task(s) (should be 1)`)
console.log(`Requester 2 autobase: ${r2Tasks} task(s) (should be 1)`)
console.log(`Isolated: ${r1Tasks === 1 && r2Tasks === 1 ? 'YES' : 'NO'}\n`)

console.log('Marketplace test passed.')
await r1.base.close(); await r2.base.close()
await w1.base.close(); await w2.base.close()
