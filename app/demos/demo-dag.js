// DAG dependency graph demo: Jacobi + Gauss-Seidel iterative solvers
//
// Shows:
//   1. Barrier DAG (Jacobi): all strips of iter k must finish before ANY strip of iter k+1
//   2. Chain DAG (Gauss-Seidel): strip i → strip i+1 within same sweep (sequential)
//
// Both solve the Laplace equation (heat diffusion) on a 2D grid.
// Visualizes convergence as a heatmap: red=hot(100), blue=cold(0).
//
// Usage: node demos/demo-dag.js
import fs from 'fs'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'
import { execSync } from 'child_process'
import DHT from '@hyperswarm/dht'
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import { executeTask } from '../worker.js'

const DIR = dirname(fileURLToPath(import.meta.url))
for (const d of ['store-dag-a', 'store-dag-b']) fs.rmSync(join(DIR, d), { recursive: true, force: true })

function open (s) { return s.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, b) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      try { await b.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true }) } catch {}
    }
    await view.append(node.value)
  }
}

console.log('╔══════════════════════════════════════════════════════════╗')
console.log('║         DAG DEMO — Jacobi + Gauss-Seidel Solvers         ║')
console.log('╠══════════════════════════════════════════════════════════╣')
console.log('║  Laplace equation ∇²u = 0 on 32×32 grid                  ║')
console.log('║  Boundary: top=100°, bottom=0°, left=0°, right=0°        ║')
console.log('╚══════════════════════════════════════════════════════════╝\n')

// Boot DHT
const dht = new DHT({ bootstrap: [] })
await dht.ready()
const bootstrap = [{ host: '127.0.0.1', port: dht.address().port }]
console.log(`[boot] DHT on port ${dht.address().port}`)

// Peer A = requester
const storeA = new Corestore(join(DIR, 'store-dag-a'))
const baseA = new Autobase(storeA, null, { valueEncoding: 'json', open, apply })
await baseA.ready()

// Peer B = worker
const storeB = new Corestore(join(DIR, 'store-dag-b'))
const baseB = new Autobase(storeB, baseA.key, { valueEncoding: 'json', open, apply })
await baseB.ready()

// Connect
const swarmA = new Hyperswarm({ bootstrap })
const swarmB = new Hyperswarm({ bootstrap })
let connA = false, connB = false
swarmA.on('connection', c => { connA = true; storeA.replicate(c) })
swarmB.on('connection', c => { connB = true; storeB.replicate(c) })
swarmA.join(baseA.discoveryKey, { client: true, server: true })
swarmB.join(baseA.discoveryKey, { client: true, server: true })
await Promise.all([swarmA.flush(), swarmB.flush()])
await new Promise(r => {
  const t = setInterval(() => { if (connA && connB) { clearInterval(t); r() } }, 100)
  setTimeout(() => { clearInterval(t); r() }, 6000)
})
// Fallback: direct replication
if (!connA || !connB) {
  const s1 = storeA.replicate(true); const s2 = storeB.replicate(false); s1.pipe(s2).pipe(s1)
}

async function sync () {
  for (let i = 0; i < 2; i++) {
    await baseA.update(); await baseB.update()
    await new Promise(r => setTimeout(r, 250))
  }
}

await baseA.append({ type: 'add-writer', key: baseB.local.key.toString('hex'), by: 'A', ts: Date.now() })
await sync()
console.log('[A] Peer B authorized as compute worker\n')

async function runJob (jobFile, label) {
  console.log(`${'─'.repeat(60)}`)
  console.log(`  ${label}`)
  console.log(`${'─'.repeat(60)}`)

  const { default: _d, ...mod } = await import(new URL(`../jobs/${jobFile}`, import.meta.url).href + '?t=' + Date.now())
  const chunks = mod.split(mod.data, 4) // 4 workers (we'll use B for all)
  const jobId = crypto.randomUUID()

  const computeCode = mod.compute.toString()
  const baseCode = `const compute = ${computeCode}; return compute(chunk)`
  const depCode = mod.depAwareCode ? mod.depAwareCode.trim() : null

  const taskIds = chunks.map(() => crypto.randomUUID())
  const t0 = performance.now()

  // Post all tasks
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const dependsOn = chunk.dependsOn ? chunk.dependsOn.map(idx => taskIds[idx]) : undefined
    const useDepCode = dependsOn && dependsOn.length > 0 && depCode
    await baseA.append({
      type: 'task', id: taskIds[i], jobId,
      code: useDepCode ? depCode : baseCode,
      argNames: ['chunk'], args: [chunk],
      dependsOn,
      by: 'A', ts: Date.now()
    })
  }
  await sync()
  console.log(`  [A→B] ${chunks.length} tasks posted (${chunks.filter(c => c.dependsOn).length} with deps)`)

  // Worker B executes with dependency resolution
  const completed = new Map()
  let pass = 0
  while (completed.size < chunks.length && pass < chunks.length + 10) {
    pass++
    await baseB.update()
    for (let i = 0; i < baseB.view.length; i++) {
      const entry = await baseB.view.get(i)
      if (entry.type !== 'task' || !taskIds.includes(entry.id)) continue
      if (completed.has(entry.id)) continue

      // Block if deps not ready
      if (entry.dependsOn && entry.dependsOn.length > 0) {
        const missing = entry.dependsOn.filter(id => !completed.has(id))
        if (missing.length > 0) continue
      }

      const deps = entry.dependsOn ? entry.dependsOn.map(id => completed.get(id)) : []
      const output = await executeTask(entry, null, null, null, deps.length > 0 ? deps : undefined)
      completed.set(entry.id, output)
      await baseB.append({ type: 'result', taskId: entry.id, output, by: 'B', ts: Date.now() })

      const pct = Math.round(completed.size / chunks.length * 100)
      process.stdout.write(`\r  [B]   ${completed.size}/${chunks.length} tasks (${pct}%)  `)
    }
    if (completed.size < chunks.length) await sync()
  }
  console.log()

  const elapsed = ((performance.now() - t0) / 1000).toFixed(2)

  // Collect + join
  await sync()
  const resultMap = new Map()
  for (let i = 0; i < baseA.view.length; i++) {
    const entry = await baseA.view.get(i)
    if (entry.type === 'result' && taskIds.includes(entry.taskId)) {
      resultMap.set(entry.taskId, entry.output)
    }
  }

  const results = taskIds.map(id => resultMap.get(id)).filter(Boolean)
  const ppm = mod.join(results)

  const outPpm = join(DIR, '..', mod.outputFile.replace('.ppm', '-demo.ppm'))
  const outPng = outPpm.replace('.ppm', '.png')
  fs.writeFileSync(outPpm, ppm)
  try { execSync(`magick "${outPpm}" -scale 800% "${outPng}"`) } catch {}

  console.log(`  [A]   Done in ${elapsed}s`)
  console.log(`  [A]   Output: ${outPng}`)

  // Show convergence stats
  const lastIter = Math.max(...results.map(r => r.iter))
  const lastStrips = results.filter(r => r.iter === lastIter).sort((a, b) => a.startRow - b.startRow)
  const center = lastStrips.flatMap(s => s.rows)[16]?.[16]?.toFixed(2)
  console.log(`  [A]   Center cell (iter ${lastIter}): ${center}° (converging to ~50°)\n`)

  return { elapsed, outputPng: outPng }
}

// Run Jacobi (barrier DAG)
const j = await runJob('jacobi-job.js', 'JACOBI — barrier DAG (each iter = parallel strips, blocked by prior iter)')

// Run Gauss-Seidel (chain DAG)
const g = await runJob('gauss-seidel-job.js', 'GAUSS-SEIDEL — chain DAG (strip i+1 waits for strip i, same iter)')

console.log('═'.repeat(60))
console.log('  RESULTS')
console.log('═'.repeat(60))
console.log(`  Jacobi:       ${j.elapsed}s  →  ${j.outputPng.split('/').pop()}`)
console.log(`  Gauss-Seidel: ${g.elapsed}s  →  ${g.outputPng.split('/').pop()}`)
console.log()
console.log('  Key difference:')
console.log('  • Jacobi: all 4 strips run IN PARALLEL per iteration (barrier sync between iters)')
console.log('  • Gauss-Seidel: strips run SEQUENTIALLY per sweep (chain: 0→1→2→3→next iter)')
console.log('  • G-S converges faster (uses updated values immediately), but no parallelism within sweep')
console.log()
try {
  execSync(`open "${j.outputPng}" "${g.outputPng}"`)
} catch {}

await baseA.close(); await baseB.close()
await swarmA.destroy(); await swarmB.destroy()
await dht.destroy()
for (const d of ['store-dag-a', 'store-dag-b']) {
  try { fs.rmSync(join(DIR, d), { recursive: true, force: true }) } catch {}
}
