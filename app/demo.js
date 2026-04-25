// Self-contained demo: spawns boot, peer-a, peer-b in child processes
// Shows full P2P matrix multiplication + Mandelbrot rendering
import { fork } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'
import DHT from '@hyperswarm/dht'
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import crypto from 'crypto'
import { createRandomMatrix, multiplyMatrices, printMatrix } from './matrix.js'
import { computeMandelbrot, createTileTasks } from './mandelbrot.js'

const DIR = dirname(fileURLToPath(import.meta.url))

// Clean up old stores
fs.rmSync(join(DIR, 'store-a'), { recursive: true, force: true })
fs.rmSync(join(DIR, 'store-b'), { recursive: true, force: true })

// ── Step 1: Start local DHT bootstrap ──
console.log('Starting local DHT bootstrap...')
const dht = new DHT({ bootstrap: [] })
await dht.ready()
const bootPort = dht.address().port
const bootstrap = [{ host: '127.0.0.1', port: bootPort }]
console.log(`DHT bootstrap on port ${bootPort}\n`)

// ── Step 2: Create Peer A ──
function open (store) { return store.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, base) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      await base.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true })
    }
    await view.append(node.value)
  }
}

const storeA = new Corestore(join(DIR, 'store-a'))
const baseA = new Autobase(storeA, null, { valueEncoding: 'json', open, apply })
await baseA.ready()

console.log('═══════════════════════════════════════════')
console.log('  PEER A online')
console.log(`  Autobase key: ${baseA.key.toString('hex').slice(0, 16)}...`)
console.log('═══════════════════════════════════════════\n')

// ── Step 3: Create Peer B (separate Corestore, same process) ──
const storeB = new Corestore(join(DIR, 'store-b'))
const baseB = new Autobase(storeB, baseA.key, { valueEncoding: 'json', open, apply })
await baseB.ready()

console.log('═══════════════════════════════════════════')
console.log('  PEER B online')
console.log(`  Writer key:   ${baseB.local.key.toString('hex').slice(0, 16)}...`)
console.log('═══════════════════════════════════════════\n')

// ── Step 4: Join Hyperswarm ──
const swarmA = new Hyperswarm({ bootstrap })
const swarmB = new Hyperswarm({ bootstrap })

let connectedA = false, connectedB = false

swarmA.on('connection', (conn) => {
  if (!connectedA) { console.log('[A] peer connected!'); connectedA = true }
  baseA.replicate(conn)
})
swarmB.on('connection', (conn) => {
  if (!connectedB) { console.log('[B] peer connected!'); connectedB = true }
  baseB.replicate(conn)
})

// Both join + announce on the same topic
swarmA.join(baseA.discoveryKey, { client: true, server: true })
swarmB.join(baseA.discoveryKey, { client: true, server: true })

console.log('Joining swarm...')
await Promise.all([swarmA.flush(), swarmB.flush()])

// Wait for connections
const waitForConnection = () => new Promise((resolve) => {
  if (connectedA && connectedB) return resolve()
  const check = setInterval(() => {
    if (connectedA && connectedB) { clearInterval(check); resolve() }
  }, 100)
  // Timeout after 10s
  setTimeout(() => { clearInterval(check); resolve() }, 10000)
})
await waitForConnection()

if (!connectedA || !connectedB) {
  console.log('\nHyperswarm connection timed out. Falling back to direct replication...\n')
  // Direct pipe replication as fallback
  const s1 = storeA.replicate(true)
  const s2 = storeB.replicate(false)
  s1.pipe(s2).pipe(s1)
  await new Promise(r => setTimeout(r, 500))
} else {
  console.log('Both peers connected via Hyperswarm!\n')
}

// Helper: force sync between the two bases
async function sync () {
  // Trigger update on both
  await baseA.update()
  await baseB.update()
  await new Promise(r => setTimeout(r, 300))
  await baseA.update()
  await baseB.update()
}

// ── Step 5: A authorizes B as writer ──
console.log('[A] Adding Peer B as writer...')
await baseA.append({
  type: 'add-writer',
  key: baseB.local.key.toString('hex'),
  by: 'peer-A',
  ts: Date.now()
})
await sync()
console.log('[A] Peer B authorized ✓\n')

// ══════════════════════════════════════════
//   TEST 1: Matrix Multiplication
// ══════════════════════════════════════════
console.log('═══════════════════════════════════════════')
console.log('  TEST 1: P2P Matrix Multiplication')
console.log('═══════════════════════════════════════════\n')

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

await sync()
console.log(`[B] synced, view has ${baseB.view.length} entries`)

// B finds and computes task
for (let i = 0; i < baseB.view.length; i++) {
  const entry = await baseB.view.get(i)
  if (entry.type === 'task' && entry.action === 'matrix-multiply') {
    console.log('[B] found task, computing...')
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

await sync()

for (let i = 0; i < baseA.view.length; i++) {
  const entry = await baseA.view.get(i)
  if (entry.type === 'result' && entry.action === 'matrix-multiply') {
    console.log(`[A] ★ RECEIVED RESULT from ${entry.by} ★`)
    printMatrix(entry.output, '[A] A×B')
  }
}

// ══════════════════════════════════════════
//   TEST 2: Mandelbrot Tiles
// ══════════════════════════════════════════
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

await sync()
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

await sync()

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

// ── Summary ──
console.log(`\n═══════════════════════════════════════════`)
console.log(`  Total entries in autobase: ${baseA.view.length}`)
console.log(`  Tasks posted by peer-A:    ${tiles.length + 1}`)
console.log(`  Results from peer-B:       ${results.length + 1}`)
console.log(`═══════════════════════════════════════════`)

// ── Cleanup ──
await swarmA.destroy()
await swarmB.destroy()
await baseA.close()
await baseB.close()
await dht.destroy()
console.log('\nDone. All peers and DHT shut down.')
