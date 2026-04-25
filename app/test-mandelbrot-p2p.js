import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import crypto from 'crypto'
import fs from 'fs'
import { computeMandelbrot, createTileTasks } from './mandelbrot.js'

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

// ---- Create both peers ----
const storeA = new Corestore('./test-peer-a')
const baseA = new Autobase(storeA, null, { valueEncoding: 'json', open, apply })
await baseA.ready()

const storeB = new Corestore('./test-peer-b')
const baseB = new Autobase(storeB, baseA.key, { valueEncoding: 'json', open, apply })
await baseB.ready()

// Debug: log all updates
baseA.on('update', () => console.log(`  [A] update event -> view.length=${baseA.view.length}`))
baseB.on('update', () => console.log(`  [B] update event -> view.length=${baseB.view.length}`))

// ---- Swarm ----
const swarmA = new Hyperswarm()
const swarmB = new Hyperswarm()

const connectedPromise = new Promise((resolve) => {
  swarmB.on('connection', (conn) => {
    console.log('[B] connection event')
    baseB.replicate(conn)
    resolve()
  })
})

swarmA.on('connection', (conn) => {
  console.log('[A] connection event')
  baseA.replicate(conn)
})

swarmA.join(baseA.discoveryKey, { client: true, server: true })
swarmB.join(baseB.discoveryKey, { client: true, server: true })
await swarmA.flush()
await swarmB.flush()

console.log('[*] waiting for peer connection...')
await Promise.race([connectedPromise, new Promise(r => setTimeout(r, 15000))])
await new Promise(r => setTimeout(r, 2000)) // settle

// ---- A adds B as writer ----
console.log('[A] adding B as writer')
await baseA.append({ type: 'add-writer', key: baseB.local.key.toString('hex'), by: 'peer-A', ts: Date.now() })
await new Promise(r => setTimeout(r, 3000))

// ---- A posts tasks ----
const IMAGE_SIZE = 256
const TILE_SIZE = 64
const MAX_ITER = 200
const tileTasks = createTileTasks(IMAGE_SIZE, IMAGE_SIZE, TILE_SIZE, MAX_ITER)
console.log(`[A] posting ${tileTasks.length} tasks`)

for (const params of tileTasks) {
  await baseA.append({
    type: 'task',
    id: crypto.randomUUID(),
    action: 'mandelbrot',
    params,
    status: 'pending',
    by: 'peer-A',
    ts: Date.now()
  })
}
console.log(`[A] done posting. A view.length=${baseA.view.length}`)

// Wait for B to sync
console.log('[*] waiting for B to sync...')
await new Promise((resolve) => {
  const target = baseA.view.length
  const check = () => {
    console.log(`  [poll] B view.length=${baseB.view.length}, target=${target}`)
    if (baseB.view.length >= target) return resolve()
    setTimeout(check, 1000)
  }
  setTimeout(check, 1000)
  setTimeout(() => { console.log('[*] sync timeout'); resolve() }, 30000)
})

// ---- B computes ----
console.log(`\n[B] scanning ${baseB.view.length} entries for tasks...`)
const tasks = []
for (let i = 0; i < baseB.view.length; i++) {
  const entry = await baseB.view.get(i)
  if (entry.type === 'task' && entry.action === 'mandelbrot') tasks.push(entry)
}
console.log(`[B] found ${tasks.length} tasks, computing...`)

const t0 = performance.now()
for (const task of tasks) {
  const pixels = computeMandelbrot(task.params)
  await baseB.append({
    type: 'result',
    taskId: task.id,
    tileX: task.params.x,
    tileY: task.params.y,
    tileW: task.params.w,
    tileH: task.params.h,
    pixels,
    by: 'peer-B',
    ts: Date.now()
  })
}
console.log(`[B] computed ${tasks.length} tiles in ${(performance.now() - t0).toFixed(1)}ms`)

// Wait for results to sync to A
await new Promise(r => setTimeout(r, 5000))

// ---- A reads results ----
const results = []
for (let i = 0; i < baseA.view.length; i++) {
  const entry = await baseA.view.get(i)
  if (entry.type === 'result') results.push(entry)
}
console.log(`\n[A] received ${results.length}/${tasks.length} results`)

// ASCII render
if (results.length > 0) {
  const image = new Array(IMAGE_SIZE * IMAGE_SIZE).fill(0)
  for (const r of results) {
    for (let py = 0; py < r.tileH; py++) {
      for (let px = 0; px < r.tileW; px++) {
        image[(r.tileY + py) * IMAGE_SIZE + (r.tileX + px)] = r.pixels[py * r.tileW + px]
      }
    }
  }

  console.log(`\nMandelbrot ${IMAGE_SIZE}x${IMAGE_SIZE} (computed by peer-B, assembled by peer-A):\n`)
  const chars = ' .:-=+*#%@'
  for (let y = 0; y < IMAGE_SIZE; y += 4) {
    let row = ''
    for (let x = 0; x < IMAGE_SIZE; x += 2) {
      const val = image[y * IMAGE_SIZE + x]
      const idx = val >= MAX_ITER ? 0 : Math.min(chars.length - 1, Math.floor((val / MAX_ITER) * chars.length))
      row += chars[idx]
    }
    console.log(row)
  }
}

await swarmA.destroy()
await swarmB.destroy()
await baseA.close()
await baseB.close()
console.log('\n[*] done')
