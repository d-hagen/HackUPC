// Streaming results test: verifies stream-chunk entries appear in autobase view
import Corestore from 'corestore'
import Autobase from 'autobase'
import crypto from 'crypto'
import fs from 'fs'
import { replicateAndSync } from 'autobase-test-helpers'
import { executeTask } from '../worker.js'

fs.rmSync('./store-stream-a', { recursive: true, force: true })
fs.rmSync('./store-stream-b', { recursive: true, force: true })

function open (store) { return store.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, base) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      await base.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true })
    }
    await view.append(node.value)
  }
}

const storeA = new Corestore('./store-stream-a')
const baseA = new Autobase(storeA, null, { valueEncoding: 'json', open, apply })
await baseA.ready()

const storeB = new Corestore('./store-stream-b')
const baseB = new Autobase(storeB, baseA.key, { valueEncoding: 'json', open, apply })
await baseB.ready()

// Authorize B as writer
await baseA.append({ type: 'add-writer', key: baseB.local.key.toString('hex'), by: 'peer-A', ts: Date.now() })
await replicateAndSync([baseA, baseB])

let passed = 0
let failed = 0
function assert (cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`) }
  else { failed++; console.log(`  FAIL: ${msg}`) }
}

// ==== TEST 1: JS task with emit() ====
console.log('\n=== TEST 1: JS task streaming via emit() ===\n')

const taskId1 = crypto.randomUUID()

// Simulate worker: collect emitted chunks, then append result
const chunks = []
const onEmit = ({ data, channel }) => {
  chunks.push({ data, channel })
  // In real system, this would base.append stream-chunk entries.
  // Here we append them directly to baseB.
  baseB.append({
    type: 'stream-chunk',
    taskId: taskId1,
    seq: chunks.length - 1,
    data,
    channel,
    by: 'peer-B',
    ts: Date.now()
  })
}

const task1 = {
  taskType: undefined,
  code: 'emit("step 1"); emit("step 2"); emit({ progress: 50 }); return "final"',
  argNames: [],
  args: [],
  id: taskId1
}

const output1 = await executeTask(task1, null, null, onEmit)
// Wait for all appends to flush
await new Promise(r => setTimeout(r, 200))

assert(output1 === 'final', `JS task return value is "final" (got: ${output1})`)
assert(chunks.length === 3, `emit() called 3 times (got: ${chunks.length})`)
assert(chunks[0].data === 'step 1', `first chunk is "step 1"`)
assert(chunks[1].data === 'step 2', `second chunk is "step 2"`)
assert(chunks[2].data.progress === 50, `third chunk is object { progress: 50 }`)
assert(chunks.every(c => c.channel === null), `all JS chunks have channel=null`)

// Append final result
await baseB.append({
  type: 'result',
  taskId: taskId1,
  output: output1,
  elapsed: 10,
  by: 'peer-B',
  ts: Date.now(),
  streamed: true,
  totalChunks: chunks.length
})

// Sync and verify from A's perspective
await replicateAndSync([baseA, baseB])

const streamChunks1 = []
let result1 = null
for (let i = 0; i < baseA.view.length; i++) {
  const entry = await baseA.view.get(i)
  if (entry.type === 'stream-chunk' && entry.taskId === taskId1) streamChunks1.push(entry)
  if (entry.type === 'result' && entry.taskId === taskId1) result1 = entry
}

assert(streamChunks1.length === 3, `A sees 3 stream-chunk entries (got: ${streamChunks1.length})`)
assert(result1 !== null, `A sees final result entry`)
assert(result1.streamed === true, `result has streamed=true`)
assert(result1.totalChunks === 3, `result has totalChunks=3`)
assert(result1.output === 'final', `result output is "final"`)

// ==== TEST 2: JS task without emit (backward compat) ====
console.log('\n=== TEST 2: JS task without streaming (backward compat) ===\n')

const task2 = {
  code: 'return 42',
  argNames: [],
  args: [],
  id: crypto.randomUUID()
}

const output2 = await executeTask(task2, null, null, null)
assert(output2 === 42, `non-streaming task returns 42 (got: ${output2})`)

const output2b = await executeTask(task2, null, null)
assert(output2b === 42, `task without onEmit param returns 42 (got: ${output2b})`)

// ==== TEST 3: Shell task streaming ====
console.log('\n=== TEST 3: Shell task stdout streaming ===\n')

const shellChunks = []
const shellOnEmit = ({ data, channel }) => {
  shellChunks.push({ data, channel })
}

const shellTask = {
  taskType: 'shell',
  cmd: 'echo line1; echo line2; echo errline >&2',
  timeout: 5000,
  id: crypto.randomUUID()
}

const shellOutput = await executeTask(shellTask, null, null, shellOnEmit)

assert(shellOutput.stdout.includes('line1'), `shell stdout contains "line1"`)
assert(shellOutput.stdout.includes('line2'), `shell stdout contains "line2"`)
assert(shellOutput.stderr.includes('errline'), `shell stderr contains "errline"`)
assert(shellChunks.length > 0, `shell task emitted ${shellChunks.length} stream chunks`)

const stdoutChunks = shellChunks.filter(c => c.channel === 'stdout')
const stderrChunks = shellChunks.filter(c => c.channel === 'stderr')
assert(stdoutChunks.length > 0, `has stdout chunks`)
assert(stderrChunks.length > 0, `has stderr chunks`)
assert(stdoutChunks.some(c => c.data.includes('line1')), `stdout chunks contain "line1"`)
assert(stderrChunks.some(c => c.data.includes('errline')), `stderr chunks contain "errline"`)

// Summary
console.log(`\n${'='.repeat(40)}`)
console.log(`  ${passed} passed, ${failed} failed`)
console.log('='.repeat(40))

await baseA.close()
await baseB.close()

fs.rmSync('./store-stream-a', { recursive: true, force: true })
fs.rmSync('./store-stream-b', { recursive: true, force: true })

if (failed > 0) process.exit(1)
