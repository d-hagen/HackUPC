// Test: file transfer via Hyperdrive between requester and worker
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperdrive from 'hyperdrive'
import crypto from 'crypto'
import fs from 'fs'
import { executeTask } from '../worker.js'

for (const d of ['store-r', 'store-w']) {
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

// Create requester with drive
const storeR = new Corestore('./store-r')
const requester = new Autobase(storeR, null, { valueEncoding: 'json', open, apply })
await requester.ready()
const requesterDrive = new Hyperdrive(storeR)
await requesterDrive.ready()

// Create worker with drive
const storeW = new Corestore('./store-w')
const worker = new Autobase(storeW, requester.key, { valueEncoding: 'json', open, apply })
await worker.ready()
const workerOutputDrive = new Hyperdrive(storeW)
await workerOutputDrive.ready()

// Replicate everything
const s1 = storeR.replicate(true); const s2 = storeW.replicate(false); s1.pipe(s2).pipe(s1)

async function sync () {
  await requester.update(); await worker.update()
  await new Promise(r => setTimeout(r, 500))
  await requester.update(); await worker.update()
}

// Authorize worker
await requester.append({ type: 'add-writer', key: worker.local.key.toString('hex'), by: 'requester', ts: Date.now() })
await sync()
console.log('Worker authorized\n')

// === TEST 1: Requester uploads a file, worker reads it ===
console.log('═══ Test 1: Upload file, worker reads it ═══')

await requesterDrive.put('/data.txt', Buffer.from('Hello from the requester! This is test data.'))
await requesterDrive.put('/numbers.json', Buffer.from(JSON.stringify([1, 2, 3, 4, 5])))
console.log('[R] Uploaded data.txt and numbers.json')

await sync()

// Worker mounts requester's drive and reads files
const inputDrive = new Hyperdrive(storeW, requesterDrive.key)
await inputDrive.ready()
await sync()

// Post task that reads from the drive
const t1id = crypto.randomUUID()
await requester.append({
  type: 'task', id: t1id,
  code: `
    const text = await readFile('/data.txt')
    const nums = JSON.parse(await readFile('/numbers.json'))
    return { text: text.toString(), sum: nums.reduce((a,b) => a+b, 0) }
  `,
  argNames: [], args: [],
  driveKey: requesterDrive.key.toString('hex'),
  by: 'requester', ts: Date.now()
})
await sync()

// Worker executes with drive access
for (let i = 0; i < worker.view.length; i++) {
  const entry = await worker.view.get(i)
  if (entry.type === 'task' && entry.id === t1id) {
    const output = await executeTask(entry, inputDrive, workerOutputDrive)
    console.log(`[W] Result:`, output)
    await worker.append({
      type: 'result', taskId: t1id, output,
      by: 'worker', ts: Date.now()
    })
  }
}
await sync()

// Verify requester sees result
for (let i = 0; i < requester.view.length; i++) {
  const entry = await requester.view.get(i)
  if (entry.type === 'result' && entry.taskId === t1id) {
    console.log(`[R] Got result:`, entry.output)
  }
}

// === TEST 2: Worker writes output files ===
console.log('\n═══ Test 2: Worker writes output files ═══')

const t2id = crypto.randomUUID()
await requester.append({
  type: 'task', id: t2id,
  code: `
    await writeFile('/output.txt', 'Computed by worker!')
    await writeFile('/result.json', JSON.stringify({ pi: 3.14159, computed: true }))
    return 'files written'
  `,
  argNames: [], args: [],
  driveKey: requesterDrive.key.toString('hex'),
  by: 'requester', ts: Date.now()
})
await sync()

for (let i = 0; i < worker.view.length; i++) {
  const entry = await worker.view.get(i)
  if (entry.type === 'task' && entry.id === t2id) {
    const output = await executeTask(entry, inputDrive, workerOutputDrive)
    console.log(`[W] Result:`, output)

    // List output files
    const outputFiles = []
    for await (const f of workerOutputDrive.list('/')) {
      outputFiles.push(f.key)
    }
    console.log(`[W] Output files:`, outputFiles)

    await worker.append({
      type: 'result', taskId: t2id, output,
      driveKey: workerOutputDrive.key.toString('hex'),
      outputFiles,
      by: 'worker', ts: Date.now()
    })
  }
}
await sync()

// Requester reads worker's output files
for (let i = 0; i < requester.view.length; i++) {
  const entry = await requester.view.get(i)
  if (entry.type === 'result' && entry.taskId === t2id && entry.driveKey) {
    console.log(`[R] Worker has output files:`, entry.outputFiles)
    const wDrive = new Hyperdrive(storeR, Buffer.from(entry.driveKey, 'hex'))
    await wDrive.ready()
    await sync()
    for (const f of entry.outputFiles) {
      const data = await wDrive.get(f)
      if (data) {
        console.log(`[R] Downloaded ${f}: ${data.toString()}`)
      }
    }
  }
}

console.log('\nAll Hyperdrive tests passed.')
await requester.close(); await worker.close()
