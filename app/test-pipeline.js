// =============================================================================
//  FULL PIPELINE TEST
//  Demonstrates everything working together:
//    1. File upload via Hyperdrive (Python script)
//    2. Data splitting across 2 workers
//    3. Shell execution (Python) on each worker
//    4. Result collection and joining
//
//  Flow:
//    Requester                          Worker 1              Worker 2
//    ─────────                          ────────              ────────
//    Upload stats.py to drive ──────►  (replicated)          (replicated)
//    Split 1000 numbers into 2 chunks
//    Post task (chunk 0) ───────────►  Read stats.py from drive
//                                      Write chunk to temp file
//                                      Run: python3 stats.py < chunk
//                                      Return {sum, count, min, max, mean}
//    Post task (chunk 1) ──────────────────────────────────► (same process)
//    Collect both results
//    Join: combine partial stats
//    into final global stats
// =============================================================================

import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperdrive from 'hyperdrive'
import crypto from 'crypto'
import fs from 'fs'
import { executeTask } from './worker.js'

// ── Step 0: Clean up old stores ──────────────────────────────────────────────
for (const d of ['store-pipeline-r', 'store-pipeline-w1', 'store-pipeline-w2']) {
  fs.rmSync(d, { recursive: true, force: true })
}

// ── Autobase boilerplate (same as all other tests) ───────────────────────────
function open (store) { return store.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, base) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      await base.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true })
    }
    await view.append(node.value)
  }
}

// ── Step 1: Create requester + 2 workers ─────────────────────────────────────
// Each gets its own Corestore, Autobase, and Hyperdrive.
// Workers join the requester's Autobase by passing its key.
// Direct pipe replication simulates what Hyperswarm does over the network.

console.log('╔══════════════════════════════════════════════════╗')
console.log('║  FULL PIPELINE TEST: Files + Python + 2 Workers  ║')
console.log('╚══════════════════════════════════════════════════╝\n')

const storeR = new Corestore('./store-pipeline-r')
const requester = new Autobase(storeR, null, { valueEncoding: 'json', open, apply })
await requester.ready()
const requesterDrive = new Hyperdrive(storeR)
await requesterDrive.ready()

const storeW1 = new Corestore('./store-pipeline-w1')
const w1 = new Autobase(storeW1, requester.key, { valueEncoding: 'json', open, apply })
await w1.ready()
const w1OutputDrive = new Hyperdrive(storeW1)
await w1OutputDrive.ready()

const storeW2 = new Corestore('./store-pipeline-w2')
const w2 = new Autobase(storeW2, requester.key, { valueEncoding: 'json', open, apply })
await w2.ready()
const w2OutputDrive = new Hyperdrive(storeW2)
await w2OutputDrive.ready()

// Direct replication (requester ↔ worker1, requester ↔ worker2)
const s1a = storeR.replicate(true); const s1b = storeW1.replicate(false); s1a.pipe(s1b).pipe(s1a)
const s2a = storeR.replicate(true); const s2b = storeW2.replicate(false); s2a.pipe(s2b).pipe(s2a)

async function sync () {
  await requester.update(); await w1.update(); await w2.update()
  await new Promise(r => setTimeout(r, 500))
  await requester.update(); await w1.update(); await w2.update()
}

// Authorize both workers as writers
await requester.append({ type: 'add-writer', key: w1.local.key.toString('hex'), by: 'requester', ts: Date.now() })
await requester.append({ type: 'add-writer', key: w2.local.key.toString('hex'), by: 'requester', ts: Date.now() })
await sync()
console.log('[1/5] Requester + 2 workers created and authorized\n')

// ── Step 2: Upload Python script to Hyperdrive ──────────────────────────────
// The requester reads the local Python file and writes it to their Hyperdrive.
// After sync, both workers can read it from the replicated drive.

const pythonScript = fs.readFileSync('jobs/stats.py')
await requesterDrive.put('/stats.py', pythonScript)
console.log('[2/5] Uploaded stats.py to Hyperdrive')
console.log(`      Drive key: ${requesterDrive.key.toString('hex').slice(0, 16)}…`)

// Workers mount the requester's drive (read-only access)
const w1InputDrive = new Hyperdrive(storeW1, requesterDrive.key)
await w1InputDrive.ready()
const w2InputDrive = new Hyperdrive(storeW2, requesterDrive.key)
await w2InputDrive.ready()
await sync()

// Verify workers can see the file
const w1Files = []
for await (const entry of w1InputDrive.list('/')) w1Files.push(entry.key)
console.log(`      Worker 1 sees: ${JSON.stringify(w1Files)}`)
console.log()

// ── Step 3: Generate data and split into chunks ─────────────────────────────
// 1000 random numbers between 0-999. Split into 2 equal chunks.

const data = Array.from({ length: 1000 }, () => Math.floor(Math.random() * 1000))
const mid = Math.floor(data.length / 2)
const chunks = [data.slice(0, mid), data.slice(mid)]

console.log('[3/5] Data generated: 1000 random numbers')
console.log(`      Chunk 0: ${chunks[0].length} numbers (first: ${chunks[0][0]}, last: ${chunks[0].at(-1)})`)
console.log(`      Chunk 1: ${chunks[1].length} numbers (first: ${chunks[1][0]}, last: ${chunks[1].at(-1)})`)
console.log()

// ── Step 4: Post tasks and execute ──────────────────────────────────────────
// Each task:
//   1. Reads stats.py from the requester's Hyperdrive (via readFile helper)
//   2. Writes the script to a temp file on disk
//   3. Pipes the chunk data into `python3 stats.py` via stdin
//   4. Parses and returns the JSON output
//
// This is the key demo: the task code is a JS string that combines
// file transfer (Hyperdrive) with shell execution (Python).

const taskCode = `
  // Read the Python script from the P2P drive
  const scriptBytes = await readFile('/stats.py')
  const script = scriptBytes.toString()

  // Write it to a temp file so Python can run it
  const { execSync } = await import('child_process')
  const { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } = await import('fs')
  const { join } = await import('path')
  const os = await import('os')

  const tmpDir = mkdtempSync(join(os.tmpdir(), 'peercompute-'))
  const scriptPath = join(tmpDir, 'stats.py')
  writeFileSync(scriptPath, script)

  // Run Python with the chunk data piped through stdin
  const input = JSON.stringify(chunk)
  const output = execSync('python3 "' + scriptPath + '"', {
    input,
    encoding: 'utf-8',
    timeout: 30000
  })

  // Cleanup temp files
  unlinkSync(scriptPath)
  rmdirSync(tmpDir)

  return JSON.parse(output.trim())
`

const taskIds = []
const workerIds = ['worker-1', 'worker-2']

for (let i = 0; i < chunks.length; i++) {
  const taskId = crypto.randomUUID()
  taskIds.push(taskId)
  await requester.append({
    type: 'task',
    id: taskId,
    code: taskCode,
    argNames: ['chunk'],
    args: [chunks[i]],
    assignedTo: workerIds[i],        // worker-1 gets chunk 0, worker-2 gets chunk 1
    driveKey: requesterDrive.key.toString('hex'),
    by: 'requester',
    ts: Date.now()
  })
}
await sync()
console.log('[4/5] 2 tasks posted (one per worker)')

// Workers execute their assigned tasks
const workerBases = [w1, w2]
const workerInputDrives = [w1InputDrive, w2InputDrive]
const workerOutputDrives = [w1OutputDrive, w2OutputDrive]

for (let w = 0; w < 2; w++) {
  const worker = workerBases[w]
  const wId = workerIds[w]

  for (let j = 0; j < worker.view.length; j++) {
    const entry = await worker.view.get(j)
    if (entry.type !== 'task' || !entry.code) continue
    if (entry.assignedTo && entry.assignedTo !== wId) continue
    if (!taskIds.includes(entry.id)) continue

    const t0 = performance.now()
    const output = await executeTask(entry, workerInputDrives[w], workerOutputDrives[w])
    const elapsed = (performance.now() - t0).toFixed(0)

    await worker.append({
      type: 'result', taskId: entry.id, output,
      elapsed: Number(elapsed), by: wId, ts: Date.now()
    })
    console.log(`      ${wId}: chunk ${taskIds.indexOf(entry.id)} done in ${elapsed}ms → sum=${output.sum}, count=${output.count}`)
  }
}
await sync()
console.log()

// ── Step 5: Collect results and join ────────────────────────────────────────
// The requester reads all results from the Autobase, orders them by chunk index,
// and combines partial statistics into a single global result.

const results = new Map()
for (let i = 0; i < requester.view.length; i++) {
  const entry = await requester.view.get(i)
  if (entry.type === 'result' && taskIds.includes(entry.taskId)) {
    const idx = taskIds.indexOf(entry.taskId)
    results.set(idx, entry.output)
  }
}

// Join: combine partial statistics
const partials = Array.from({ length: chunks.length }, (_, i) => results.get(i))
const joined = {
  sum: partials.reduce((acc, r) => acc + r.sum, 0),
  count: partials.reduce((acc, r) => acc + r.count, 0),
  min: Math.min(...partials.map(r => r.min)),
  max: Math.max(...partials.map(r => r.max)),
  mean: partials.reduce((acc, r) => acc + r.sum, 0) / partials.reduce((acc, r) => acc + r.count, 0)
}

console.log('[5/5] Results joined:')
console.log(`      Total sum:   ${joined.sum}`)
console.log(`      Total count: ${joined.count}`)
console.log(`      Global min:  ${joined.min}`)
console.log(`      Global max:  ${joined.max}`)
console.log(`      Global mean: ${joined.mean.toFixed(2)}`)

// ── Verify against local computation ────────────────────────────────────────
const expected = {
  sum: data.reduce((a, b) => a + b, 0),
  count: data.length,
  min: Math.min(...data),
  max: Math.max(...data),
  mean: data.reduce((a, b) => a + b, 0) / data.length
}

console.log()
console.log('      ── Verification ──')
console.log(`      Expected sum:  ${expected.sum}  ${joined.sum === expected.sum ? '✓' : '✗ MISMATCH'}`)
console.log(`      Expected min:  ${expected.min}  ${joined.min === expected.min ? '✓' : '✗ MISMATCH'}`)
console.log(`      Expected max:  ${expected.max}  ${joined.max === expected.max ? '✓' : '✗ MISMATCH'}`)
console.log(`      Expected mean: ${expected.mean.toFixed(2)}  ${joined.mean.toFixed(2) === expected.mean.toFixed(2) ? '✓' : '✗ MISMATCH'}`)

const allMatch = joined.sum === expected.sum &&
  joined.min === expected.min &&
  joined.max === expected.max &&
  joined.mean.toFixed(2) === expected.mean.toFixed(2)

console.log()
console.log(allMatch ? '══ ALL CHECKS PASSED ══' : '══ SOME CHECKS FAILED ══')

// Cleanup
await requester.close(); await w1.close(); await w2.close()
for (const d of ['store-pipeline-r', 'store-pipeline-w1', 'store-pipeline-w2']) {
  fs.rmSync(d, { recursive: true, force: true })
}
