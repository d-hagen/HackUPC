// Generic P2P compute demo: Peer A sends arbitrary JS functions, Peer B executes them
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import DHT from '@hyperswarm/dht'
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import crypto from 'crypto'
import { executeTask } from '../worker.js'

const DIR = dirname(fileURLToPath(import.meta.url))
fs.rmSync(join(DIR, 'store-a'), { recursive: true, force: true })
fs.rmSync(join(DIR, 'store-b'), { recursive: true, force: true })

// ── Autobase setup ──
function open (store) { return store.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, base) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      await base.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true })
    }
    await view.append(node.value)
  }
}

// ── Boot DHT ──
const dht = new DHT({ bootstrap: [] })
await dht.ready()
const bootstrap = [{ host: '127.0.0.1', port: dht.address().port }]

// ── Peer A ──
const storeA = new Corestore(join(DIR, 'store-a'))
const baseA = new Autobase(storeA, null, { valueEncoding: 'json', open, apply })
await baseA.ready()
console.log(`Peer A online (${baseA.key.toString('hex').slice(0, 16)}...)`)

// ── Peer B ──
const storeB = new Corestore(join(DIR, 'store-b'))
const baseB = new Autobase(storeB, baseA.key, { valueEncoding: 'json', open, apply })
await baseB.ready()
console.log(`Peer B online (${baseB.local.key.toString('hex').slice(0, 16)}...)`)

// ── Connect via Hyperswarm (with fallback) ──
const swarmA = new Hyperswarm({ bootstrap })
const swarmB = new Hyperswarm({ bootstrap })
let connA = false, connB = false
swarmA.on('connection', c => { connA = true; baseA.replicate(c) })
swarmB.on('connection', c => { connB = true; baseB.replicate(c) })
swarmA.join(baseA.discoveryKey, { client: true, server: true })
swarmB.join(baseA.discoveryKey, { client: true, server: true })
await Promise.all([swarmA.flush(), swarmB.flush()])
await new Promise(r => { const t = setInterval(() => { if (connA && connB) { clearInterval(t); r() } }, 100); setTimeout(() => { clearInterval(t); r() }, 8000) })
if (!connA || !connB) {
  const s1 = storeA.replicate(true); const s2 = storeB.replicate(false); s1.pipe(s2).pipe(s1)
  await new Promise(r => setTimeout(r, 500))
}

async function sync () {
  await baseA.update(); await baseB.update()
  await new Promise(r => setTimeout(r, 300))
  await baseA.update(); await baseB.update()
}

// ── Authorize B ──
await baseA.append({ type: 'add-writer', key: baseB.local.key.toString('hex'), by: 'peer-A', ts: Date.now() })
await sync()
console.log('Peer B authorized as writer\n')

// ── Helper: A posts a task, B executes, A gets result ──
async function postAndCompute (label, task) {
  console.log(`═══ ${label} ═══`)

  // A posts
  const id = crypto.randomUUID()
  await baseA.append({ type: 'task', id, ...task, by: 'peer-A', ts: Date.now() })
  console.log('[A] task posted')
  await sync()

  // B finds and executes
  for (let i = 0; i < baseB.view.length; i++) {
    const entry = await baseB.view.get(i)
    if (entry.type === 'task' && entry.id === id) {
      console.log('[B] executing...')
      const t0 = performance.now()
      try {
        const output = await executeTask(entry)
        const elapsed = (performance.now() - t0).toFixed(2)
        await baseB.append({ type: 'result', taskId: id, output, by: 'peer-B', ts: Date.now() })
        console.log(`[B] done in ${elapsed}ms`)
      } catch (err) {
        await baseB.append({ type: 'result', taskId: id, error: err.message, by: 'peer-B', ts: Date.now() })
        console.log(`[B] error: ${err.message}`)
      }
    }
  }
  await sync()

  // A reads result
  for (let i = 0; i < baseA.view.length; i++) {
    const entry = await baseA.view.get(i)
    if (entry.type === 'result' && entry.taskId === id) {
      if (entry.error) {
        console.log(`[A] got error: ${entry.error}`)
      } else {
        console.log(`[A] result:`, JSON.stringify(entry.output).slice(0, 200))
      }
    }
  }
  console.log('')
}

// ═══════════════════════════════════════════
//   TASK 1: Simple arithmetic
// ═══════════════════════════════════════════
await postAndCompute('Task 1: Add two numbers', {
  code: 'return a + b',
  argNames: ['a', 'b'],
  args: [17, 25]
})

// ═══════════════════════════════════════════
//   TASK 2: Fibonacci
// ═══════════════════════════════════════════
await postAndCompute('Task 2: Fibonacci(30)', {
  code: `
    function fib(n) { return n <= 1 ? n : fib(n-1) + fib(n-2) }
    return fib(n)
  `,
  argNames: ['n'],
  args: [30]
})

// ═══════════════════════════════════════════
//   TASK 3: Matrix multiplication
// ═══════════════════════════════════════════
await postAndCompute('Task 3: Matrix multiply 4x4', {
  code: `
    const n = a.length
    const result = []
    for (let i = 0; i < n; i++) {
      result[i] = []
      for (let j = 0; j < n; j++) {
        let sum = 0
        for (let k = 0; k < n; k++) sum += a[i][k] * b[k][j]
        result[i][j] = sum
      }
    }
    return result
  `,
  argNames: ['a', 'b'],
  args: [
    [[1,2],[3,4]],
    [[5,6],[7,8]]
  ]
})

// ═══════════════════════════════════════════
//   TASK 4: Prime sieve
// ═══════════════════════════════════════════
await postAndCompute('Task 4: Primes up to 100', {
  code: `
    const sieve = new Array(limit + 1).fill(true)
    sieve[0] = sieve[1] = false
    for (let i = 2; i * i <= limit; i++) {
      if (sieve[i]) for (let j = i * i; j <= limit; j += i) sieve[j] = false
    }
    return sieve.reduce((acc, v, i) => { if (v) acc.push(i); return acc }, [])
  `,
  argNames: ['limit'],
  args: [100]
})

// ═══════════════════════════════════════════
//   TASK 5: Sort a big array
// ═══════════════════════════════════════════
const bigArray = Array.from({ length: 1000 }, () => Math.floor(Math.random() * 10000))
await postAndCompute('Task 5: Sort 1000 random numbers', {
  code: `return arr.sort((a, b) => a - b)`,
  argNames: ['arr'],
  args: [bigArray]
})

// ═══════════════════════════════════════════
//   TASK 6: Mandelbrot tile (code sent inline)
// ═══════════════════════════════════════════
await postAndCompute('Task 6: Mandelbrot tile 64x64', {
  code: `
    const { x, y, w, h, iter, realMin, realMax, imagMin, imagMax, totalW, totalH } = params
    const pixels = new Array(w * h)
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const cr = realMin + ((x + px) / totalW) * (realMax - realMin)
        const ci = imagMin + ((y + py) / totalH) * (imagMax - imagMin)
        let zr = 0, zi = 0, n = 0
        while (n < iter && zr * zr + zi * zi <= 4) {
          const tmp = zr * zr - zi * zi + cr
          zi = 2 * zr * zi + ci
          zr = tmp
          n++
        }
        pixels[py * w + px] = n
      }
    }
    return { totalPixels: pixels.length, sample: pixels.slice(0, 10) }
  `,
  argNames: ['params'],
  args: [{ x: 0, y: 0, w: 64, h: 64, iter: 200, realMin: -2.5, realMax: 1, imagMin: -1.25, imagMax: 1.25, totalW: 512, totalH: 512 }]
})

// ── Summary ──
console.log('═══════════════════════════════════════════')
console.log(`Total entries in autobase: ${baseA.view.length}`)
console.log('═══════════════════════════════════════════')

await swarmA.destroy(); await swarmB.destroy()
await baseA.close(); await baseB.close()
await dht.destroy()
console.log('Done.')
