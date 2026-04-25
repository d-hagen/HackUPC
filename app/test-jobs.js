// Test distributed jobs: split/compute/join with direct replication
import Corestore from 'corestore'
import Autobase from 'autobase'
import crypto from 'crypto'
import fs from 'fs'
import { pathToFileURL } from 'url'
import { resolve } from 'path'
import { executeTask } from './worker.js'

fs.rmSync('./store-requester', { recursive: true, force: true })
fs.rmSync('./store-worker-1', { recursive: true, force: true })
fs.rmSync('./store-worker-2', { recursive: true, force: true })

function open (store) { return store.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, base) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      await base.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true })
    }
    await view.append(node.value)
  }
}

// Create requester + 2 workers
const storeR = new Corestore('./store-requester')
const requester = new Autobase(storeR, null, { valueEncoding: 'json', open, apply })
await requester.ready()

const storeW1 = new Corestore('./store-worker-1')
const w1 = new Autobase(storeW1, requester.key, { valueEncoding: 'json', open, apply })
await w1.ready()

const storeW2 = new Corestore('./store-worker-2')
const w2 = new Autobase(storeW2, requester.key, { valueEncoding: 'json', open, apply })
await w2.ready()

// Direct replication
const s1a = storeR.replicate(true); const s1b = storeW1.replicate(false); s1a.pipe(s1b).pipe(s1a)
const s2a = storeR.replicate(true); const s2b = storeW2.replicate(false); s2a.pipe(s2b).pipe(s2a)

async function sync () {
  await requester.update(); await w1.update(); await w2.update()
  await new Promise(r => setTimeout(r, 300))
  await requester.update(); await w1.update(); await w2.update()
}

// Authorize workers
await requester.append({ type: 'add-writer', key: w1.local.key.toString('hex'), by: 'requester', ts: Date.now() })
await requester.append({ type: 'add-writer', key: w2.local.key.toString('hex'), by: 'requester', ts: Date.now() })
await sync()
console.log('2 workers authorized\n')

// Test each job file
const jobFiles = ['jobs/sum-job.js', 'jobs/primes-job.js', 'jobs/mandelbrot-job.js']

for (const jobFile of jobFiles) {
  console.log(`\n${'═'.repeat(50)}`)
  console.log(`  JOB: ${jobFile}`)
  console.log(`${'═'.repeat(50)}\n`)

  const mod = await import(pathToFileURL(resolve(jobFile)).href)
  const n = 2 // split across 2 workers
  const chunks = mod.split(mod.data, n)
  const jobId = crypto.randomUUID()
  const computeCode = mod.compute.toString()
  const code = `const compute = ${computeCode}; return compute(chunk)`

  console.log(`Split into ${chunks.length} chunks`)

  // Post subtasks
  const taskIds = []
  for (let i = 0; i < chunks.length; i++) {
    const taskId = crypto.randomUUID()
    taskIds.push(taskId)
    await requester.append({
      type: 'task', id: taskId, jobId, chunkIndex: i, totalChunks: chunks.length,
      code, argNames: ['chunk'], args: [chunks[i]],
      by: 'requester', ts: Date.now()
    })
  }
  await sync()

  // Workers execute (round-robin: even chunks → w1, odd → w2)
  const workers = [w1, w2]
  for (let i = 0; i < taskIds.length; i++) {
    const worker = workers[i % 2]
    for (let j = 0; j < worker.view.length; j++) {
      const entry = await worker.view.get(j)
      if (entry.type === 'task' && entry.id === taskIds[i]) {
        const t0 = performance.now()
        const output = await executeTask(entry)
        const elapsed = (performance.now() - t0).toFixed(2)
        await worker.append({
          type: 'result', taskId: taskIds[i], output, elapsed: Number(elapsed),
          by: `worker-${i % 2 + 1}`, ts: Date.now()
        })
        console.log(`  Chunk ${i} done by worker-${i % 2 + 1} (${elapsed}ms)`)
      }
    }
  }
  await sync()

  // Requester collects and joins
  const results = new Map()
  for (let i = 0; i < requester.view.length; i++) {
    const entry = await requester.view.get(i)
    if (entry.type === 'result' && taskIds.includes(entry.taskId)) {
      const idx = taskIds.indexOf(entry.taskId)
      results.set(idx, entry.output)
    }
  }

  const ordered = Array.from({ length: chunks.length }, (_, i) => results.get(i))
  const final = mod.join(ordered)
  const out = typeof final === 'string' ? final : JSON.stringify(final)
  console.log(`\nJoined result:`)
  console.log(out.length > 500 ? out.slice(0, 500) + '…' : out)
}

console.log('\n\nAll jobs completed.')
await requester.close()
await w1.close()
await w2.close()
