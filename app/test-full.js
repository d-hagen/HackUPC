// Full end-to-end test using autobase-test-helpers for reliable local sync
import Corestore from 'corestore'
import Autobase from 'autobase'
import crypto from 'crypto'
import fs from 'fs'
import { replicateAndSync } from 'autobase-test-helpers'
import { createRandomMatrix, multiplyMatrices, printMatrix } from './matrix.js'
import { computeMandelbrot, createTileTasks } from './mandelbrot.js'

fs.rmSync('./store-a', { recursive: true, force: true })
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

const storeA = new Corestore('./store-a')
const baseA = new Autobase(storeA, null, { valueEncoding: 'json', open, apply })
await baseA.ready()

const storeB = new Corestore('./store-b')
const baseB = new Autobase(storeB, baseA.key, { valueEncoding: 'json', open, apply })
await baseB.ready()

// ==== TEST 1: Matrix Multiplication ====
console.log('═══════════════════════════════════════════')
console.log('  TEST 1: P2P Matrix Multiplication')
console.log('═══════════════════════════════════════════\n')

// A adds B as writer
await baseA.append({ type: 'add-writer', key: baseB.local.key.toString('hex'), by: 'peer-A', ts: Date.now() })
await replicateAndSync([baseA, baseB])
console.log('[A] added B as writer ✓')

// A posts matrix task
const matA = createRandomMatrix(4)
const matB = createRandomMatrix(4)
printMatrix(matA, '[A] Matrix A')
printMatrix(matB, '[A] Matrix B')

await baseA.append({
  type: 'task',
  id: crypto.randomUUID(),
  action: 'matrix-multiply',
  params: { a: matA, b: matB },
  status: 'pending',
  by: 'peer-A',
  ts: Date.now()
})
console.log('[A] task posted\n')

// Sync to B
await replicateAndSync([baseA, baseB])
console.log(`[B] synced, view has ${baseB.view.length} entries`)

// B finds and computes task
for (let i = 0; i < baseB.view.length; i++) {
  const entry = await baseB.view.get(i)
  if (entry.type === 'task' && entry.action === 'matrix-multiply') {
    console.log(`[B] found task, computing...`)
    const t0 = performance.now()
    const result = multiplyMatrices(entry.params.a, entry.params.b)
    const elapsed = (performance.now() - t0).toFixed(2)

    await baseB.append({
      type: 'result',
      taskId: entry.id,
      action: 'matrix-multiply',
      output: result,
      by: 'peer-B',
      ts: Date.now()
    })
    printMatrix(result, `[B] Result (${elapsed}ms)`)
    console.log('[B] result written ✓\n')
  }
}

// Sync result back to A
await replicateAndSync([baseA, baseB])

for (let i = 0; i < baseA.view.length; i++) {
  const entry = await baseA.view.get(i)
  if (entry.type === 'result') {
    console.log(`[A] ★ RECEIVED RESULT from ${entry.by} ★`)
    printMatrix(entry.output, '[A] A×B')
  }
}

// ==== TEST 2: Mandelbrot Tiles ====
console.log('\n═══════════════════════════════════════════')
console.log('  TEST 2: P2P Mandelbrot Rendering')
console.log('═══════════════════════════════════════════\n')

const IMAGE_SIZE = 128
const TILE_SIZE = 32
const MAX_ITER = 200
const tiles = createTileTasks(IMAGE_SIZE, IMAGE_SIZE, TILE_SIZE, MAX_ITER)
console.log(`[A] posting ${tiles.length} tile tasks (${IMAGE_SIZE}×${IMAGE_SIZE}, ${TILE_SIZE}px tiles)`)

for (const params of tiles) {
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

await replicateAndSync([baseA, baseB])
console.log(`[B] synced, ${baseB.view.length} entries`)

// B computes all mandelbrot tiles
const t0 = performance.now()
let tileCount = 0
for (let i = 0; i < baseB.view.length; i++) {
  const entry = await baseB.view.get(i)
  if (entry.type === 'task' && entry.action === 'mandelbrot') {
    const pixels = computeMandelbrot(entry.params)
    await baseB.append({
      type: 'result',
      taskId: entry.id,
      tileX: entry.params.x, tileY: entry.params.y,
      tileW: entry.params.w, tileH: entry.params.h,
      pixels,
      by: 'peer-B',
      ts: Date.now()
    })
    tileCount++
  }
}
console.log(`[B] computed ${tileCount} tiles in ${(performance.now() - t0).toFixed(1)}ms`)

// Sync results back
await replicateAndSync([baseA, baseB])

// A assembles the image
const results = []
for (let i = 0; i < baseA.view.length; i++) {
  const entry = await baseA.view.get(i)
  if (entry.type === 'result' && entry.tileX !== undefined) results.push(entry)
}
console.log(`[A] received ${results.length}/${tileCount} tile results\n`)

const image = new Array(IMAGE_SIZE * IMAGE_SIZE).fill(0)
for (const r of results) {
  for (let py = 0; py < r.tileH; py++) {
    for (let px = 0; px < r.tileW; px++) {
      image[(r.tileY + py) * IMAGE_SIZE + (r.tileX + px)] = r.pixels[py * r.tileW + px]
    }
  }
}

console.log('Mandelbrot set (computed by peer-B, assembled by peer-A):')
console.log('')
const chars = ' .·:;+=x#%@'
for (let y = 0; y < IMAGE_SIZE; y += 2) {
  let row = ''
  for (let x = 0; x < IMAGE_SIZE; x += 1) {
    const val = image[y * IMAGE_SIZE + x]
    const idx = val >= MAX_ITER ? 0 : Math.min(chars.length - 1, Math.floor((val / MAX_ITER) * chars.length))
    row += chars[idx]
  }
  console.log(row)
}

// Summary
console.log(`\n═══════════════════════════════════════════`)
console.log(`  Total entries in autobase: ${baseA.view.length}`)
console.log(`  Tasks posted by peer-A:    ${tiles.length + 1}`)
console.log(`  Results from peer-B:       ${results.length + 1}`)
console.log(`═══════════════════════════════════════════`)

await baseA.close()
await baseB.close()
