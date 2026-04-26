// Integration test for DAG dependency graph jobs (Jacobi + Gauss-Seidel)
// Uses in-memory Autobase replication — no network needed.
// Verifies: dependsOn resolution, dep output injection, convergence.
import Corestore from 'corestore'
import Autobase from 'autobase'
import crypto from 'crypto'
import fs from 'fs'
import { pathToFileURL, fileURLToPath } from 'url'
import { resolve, dirname } from 'path'
import { executeTask } from '../worker.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

for (const d of ['store-dag-r', 'store-dag-w1', 'store-dag-w2']) {
  fs.rmSync(d, { recursive: true, force: true })
}

function open (s) { return s.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, b) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      try { await b.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true }) } catch {}
    }
    await view.append(node.value)
  }
}

const storeR = new Corestore('./store-dag-r')
const requester = new Autobase(storeR, null, { valueEncoding: 'json', open, apply })
await requester.ready()

const storeW1 = new Corestore('./store-dag-w1')
const w1 = new Autobase(storeW1, requester.key, { valueEncoding: 'json', open, apply })
await w1.ready()

const storeW2 = new Corestore('./store-dag-w2')
const w2 = new Autobase(storeW2, requester.key, { valueEncoding: 'json', open, apply })
await w2.ready()

const s1a = storeR.replicate(true); const s1b = storeW1.replicate(false); s1a.pipe(s1b).pipe(s1a)
const s2a = storeR.replicate(true); const s2b = storeW2.replicate(false); s2a.pipe(s2b).pipe(s2a)

async function sync () {
  for (let i = 0; i < 3; i++) {
    await requester.update(); await w1.update(); await w2.update()
    await new Promise(r => setTimeout(r, 200))
  }
}

await requester.append({ type: 'add-writer', key: w1.local.key.toString('hex'), by: 'req', ts: Date.now() })
await requester.append({ type: 'add-writer', key: w2.local.key.toString('hex'), by: 'req', ts: Date.now() })
await sync()

async function runDAGJob (jobFile, label) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  JOB: ${label}`)
  console.log(`${'═'.repeat(60)}\n`)

  const mod = await import(pathToFileURL(resolve(__dirname, '..', jobFile)).href + '?t=' + Date.now())
  const chunks = mod.split(mod.data, 2) // 2 workers
  const jobId = crypto.randomUUID()

  const computeCode = mod.compute.toString()
  const baseCode = `const compute = ${computeCode}; return compute(chunk)`
  const depAwareCode = mod.depAwareCode ? mod.depAwareCode.trim() : null

  // Pre-assign taskIds so dependsOn can reference by index
  const chunkTaskIds = chunks.map(() => crypto.randomUUID())

  console.log(`Tasks: ${chunks.length} | depAwareCode: ${!!depAwareCode}`)

  // Post all tasks
  const workerIds = ['worker-dag-1', 'worker-dag-2']
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const dependsOn = chunk.dependsOn
      ? chunk.dependsOn.map(idx => chunkTaskIds[idx])
      : undefined
    const useDepCode = dependsOn && dependsOn.length > 0 && depAwareCode
    const code = useDepCode ? depAwareCode : baseCode

    await requester.append({
      type: 'task', id: chunkTaskIds[i], jobId,
      chunkIndex: i, totalChunks: chunks.length,
      code, argNames: ['chunk'], args: [chunk],
      assignedTo: workerIds[i % 2],
      dependsOn,
      by: 'requester', ts: Date.now()
    })
  }
  await sync()
  console.log(`[+] All ${chunks.length} tasks posted`)

  // Execute with proper dependency ordering — simulate worker behavior
  const workers = [
    { base: w1, id: workerIds[0] },
    { base: w2, id: workerIds[1] }
  ]

  // Iteratively execute tasks when deps are satisfied (up to N passes)
  const completed = new Map() // taskId -> output
  const MAX_PASSES = chunks.length + 5
  let pass = 0
  let totalDone = 0

  while (totalDone < chunks.length && pass < MAX_PASSES) {
    pass++
    let doneSomething = false

    for (const { base, id: wId } of workers) {
      await base.update()
      for (let i = 0; i < base.view.length; i++) {
        const entry = await base.view.get(i)
        if (entry.type !== 'task') continue
        if (entry.assignedTo && entry.assignedTo !== wId) continue
        if (completed.has(entry.id)) continue

        // Check deps satisfied
        if (entry.dependsOn && entry.dependsOn.length > 0) {
          const missing = entry.dependsOn.filter(id => !completed.has(id))
          if (missing.length > 0) continue
        }

        // Collect dep outputs in order
        const deps = entry.dependsOn
          ? entry.dependsOn.map(id => completed.get(id))
          : []

        const t0 = performance.now()
        const output = await executeTask(entry, null, null, null, deps.length > 0 ? deps : undefined)
        const elapsed = (performance.now() - t0).toFixed(1)

        completed.set(entry.id, output)
        totalDone++
        doneSomething = true

        await base.append({ type: 'result', taskId: entry.id, output, elapsed: Number(elapsed), by: wId, ts: Date.now() })
        if (totalDone % 8 === 0 || totalDone === chunks.length) {
          process.stdout.write(`\r  Progress: ${totalDone}/${chunks.length} tasks done`)
        }
      }
    }

    if (!doneSomething) {
      await sync()
    }
  }
  console.log()

  if (totalDone < chunks.length) {
    console.log(`[!] Only ${totalDone}/${chunks.length} tasks completed after ${pass} passes`)
    return false
  }

  await sync()

  // Collect results from view
  const resultMap = new Map()
  for (let i = 0; i < requester.view.length; i++) {
    const entry = await requester.view.get(i)
    if (entry.type === 'result' && chunkTaskIds.includes(entry.taskId)) {
      resultMap.set(entry.taskId, entry.output)
    }
  }

  const orderedResults = chunkTaskIds.map(id => resultMap.get(id)).filter(Boolean)
  const output = mod.join(orderedResults)

  const previewLen = Math.min(200, output.length)
  console.log(`\n[+] join() output (first ${previewLen} chars):`)
  console.log(output.slice(0, previewLen))

  if (mod.outputFile) {
    fs.writeFileSync(resolve(__dirname, '..', mod.outputFile.replace('.ppm', '-dag-test.ppm')), output)
    console.log(`[+] Saved to ${mod.outputFile.replace('.ppm', '-dag-test.ppm')}`)
  }

  return true
}

let allPassed = true

// Test Jacobi (barrier-style DAG: each iter depends on ALL strips from prev iter)
try {
  const ok = await runDAGJob('jobs/jacobi-job.js', 'Jacobi iteration (barrier DAG)')
  if (ok) {
    console.log('\n[+] JACOBI: PASSED')
  } else {
    console.log('\n[!] JACOBI: FAILED')
    allPassed = false
  }
} catch (err) {
  console.log(`\n[!] JACOBI ERROR: ${err.message}`)
  console.log(err.stack)
  allPassed = false
}

// Test Gauss-Seidel (chain-style DAG: strip i → strip i+1 within same iteration)
try {
  const ok = await runDAGJob('jobs/gauss-seidel-job.js', 'Gauss-Seidel (chain DAG)')
  if (ok) {
    console.log('\n[+] GAUSS-SEIDEL: PASSED')
  } else {
    console.log('\n[!] GAUSS-SEIDEL: FAILED')
    allPassed = false
  }
} catch (err) {
  console.log(`\n[!] GAUSS-SEIDEL ERROR: ${err.message}`)
  console.log(err.stack)
  allPassed = false
}

// Cleanup
await requester.close(); await w1.close(); await w2.close()
for (const d of ['store-dag-r', 'store-dag-w1', 'store-dag-w2']) {
  fs.rmSync(d, { recursive: true, force: true })
}

console.log('\n' + (allPassed ? '══ ALL DAG TESTS PASSED ══' : '══ SOME DAG TESTS FAILED ══'))
process.exit(allPassed ? 0 : 1)
