// Task requester: creates a compute network, auto-discovers workers, sends tasks
import { createBase, NETWORK_TOPIC } from './base-setup.js'
import { pathToFileURL } from 'url'
import { resolve } from 'path'
import crypto from 'crypto'
import fs from 'fs'
import readline from 'readline'

const { base, swarm, cleanup } = await createBase('./store-requester', null)
const autobaseKey = base.key.toString('hex')

console.log('╔═══════════════════════════════════════════╗')
console.log('║       REQUEST COMPUTE — Requester         ║')
console.log('╚═══════════════════════════════════════════╝')
console.log('')
console.log('Searching for workers on the network...\n')

// Track state
const printedResults = new Set()
const workers = new Map()
const pendingJobs = new Map() // jobId -> { totalChunks, results: Map<chunkIndex, output>, joinFn }

// Join the well-known discovery topic to find workers
swarm.join(NETWORK_TOPIC, { client: true, server: true })

swarm.on('connection', (conn, info) => {
  // Send our autobase key so the worker can join
  conn.write(JSON.stringify({ type: 'handshake', role: 'requester', autobaseKey }))

  conn.on('data', async (data) => {
    try {
      const msg = JSON.parse(data.toString())

      if (msg.type === 'handshake' && msg.role === 'worker') {
        // Worker sent us their writer key — auto-authorize them
        const writerKey = msg.writerKey
        if (!workers.has(writerKey)) {
          workers.set(writerKey, { id: msg.workerId, ts: Date.now() })
          await base.append({ type: 'add-writer', key: writerKey, by: 'requester', ts: Date.now() })
          console.log(`[+] Worker discovered and authorized: ${msg.workerId}`)
          rl.prompt()
        }
      }
    } catch {}
  })

  // Also replicate the autobase over this connection
  base.replicate(conn)
})

await swarm.flush()

// Watch for results and worker announcements
base.on('update', async () => {
  for (let i = 0; i < base.view.length; i++) {
    const entry = await base.view.get(i)

    if (entry.type === 'worker-available' && !workers.has(entry.key)) {
      workers.set(entry.key, { id: entry.by, ts: entry.ts })
      console.log(`[+] Worker online: ${entry.by}`)
      rl.prompt()
    }

    if (entry.type === 'result' && !printedResults.has(entry.taskId)) {
      printedResults.add(entry.taskId)

      // Check if this result belongs to a distributed job
      const jobMatch = findJobForTask(entry.taskId)
      if (jobMatch) {
        const { jobId, chunkIndex } = jobMatch
        const job = pendingJobs.get(jobId)
        if (job && !job.results.has(chunkIndex)) {
          job.results.set(chunkIndex, entry.error ? { error: entry.error } : entry.output)
          console.log(`\n[<] Chunk ${chunkIndex + 1}/${job.totalChunks} done (by ${entry.by}, ${entry.elapsed || '?'}ms)`)

          if (job.results.size === job.totalChunks) {
            // All chunks done — run join
            const errors = [...job.results.values()].filter(r => r && r.error)
            if (errors.length > 0) {
              console.log(`[!] Job ${jobId.slice(0, 8)}… had ${errors.length} failed chunks`)
            } else {
              const ordered = Array.from({ length: job.totalChunks }, (_, i) => job.results.get(i))
              try {
                const final = job.joinFn(ordered)
                console.log(`\n[*] JOB ${jobId.slice(0, 8)}… COMPLETE`)
                const out = typeof final === 'string' ? final : JSON.stringify(final, null, 2)
                if (out.length > 2000) {
                  console.log(out.slice(0, 2000) + `… (${out.length} chars)`)
                } else {
                  console.log(out)
                }
              } catch (err) {
                console.log(`[!] Join failed: ${err.message}`)
              }
            }
            pendingJobs.delete(jobId)
          }
          rl.prompt()
        }
      } else {
        // Regular (non-job) result
        console.log(`\n[<] Result from ${entry.by} (task ${entry.taskId.slice(0, 8)}…)`)
        if (entry.error) {
          console.log(`    Error: ${entry.error}`)
        } else {
          const out = JSON.stringify(entry.output, null, 2)
          if (out.length > 500) {
            console.log(`    ${out.slice(0, 500)}… (${out.length} chars)`)
          } else {
            console.log(`    ${out}`)
          }
        }
        if (entry.elapsed) console.log(`    (${entry.elapsed}ms)`)
        rl.prompt()
      }
    }
  }
})

// Map taskId -> { jobId, chunkIndex } for distributed jobs
const taskToJob = new Map()
function findJobForTask (taskId) { return taskToJob.get(taskId) || null }

// Interactive prompt
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function showHelp () {
  console.log(`
Commands:
  run <code>           Send JS code to execute
                         run return 2 + 2
                         run return Array.from({length:10}, (_,i) => i*i)
  file <path.js>       Send a .js file as a single task
  job <path.js> [n]    Run a distributed job (split across n workers, default=all)
                         Job file exports: data, split(data,n), compute(chunk), join(results)
                         Examples: job jobs/sum-job.js
                                   job jobs/mandelbrot-job.js 4
  workers              List connected workers
  results              Show all results
  status               Show network status
  help                 Show this help
`)
}

showHelp()
rl.setPrompt('request> ')
rl.prompt()

rl.on('line', async (line) => {
  const input = line.trim()
  if (!input) { rl.prompt(); return }

  if (input.startsWith('run ')) {
    const code = input.slice(4).trim()
    if (workers.size === 0) {
      console.log('[!] No workers connected yet. Waiting for a worker to join...')
    }
    const id = crypto.randomUUID()
    await base.append({
      type: 'task', id, code, argNames: [], args: [],
      by: 'requester', ts: Date.now()
    })
    console.log(`[>] Task ${id.slice(0, 8)}… posted`)

  } else if (input.startsWith('job ')) {
    const parts = input.slice(4).trim().split(/\s+/)
    const filePath = parts[0]
    const nOverride = parts[1] ? parseInt(parts[1]) : null
    try {
      const absPath = resolve(filePath)
      const mod = await import(pathToFileURL(absPath).href)

      if (!mod.split || !mod.compute || !mod.join || !mod.data) {
        console.log('[!] Job file must export: data, split(data, n), compute(chunk), join(results)')
        rl.prompt(); return
      }

      const n = nOverride || Math.max(1, workers.size)
      const chunks = mod.split(mod.data, n)
      const jobId = crypto.randomUUID()
      const computeCode = mod.compute.toString()
      const code = `const compute = ${computeCode}; return compute(chunk)`

      // Round-robin assign chunks to available workers
      const workerIds = [...workers.values()].map(w => w.id)
      if (workerIds.length === 0) {
        console.log('[!] No workers connected. Tasks will be unassigned (first worker takes all).')
      }

      console.log(`[>] Job ${jobId.slice(0, 8)}… splitting into ${chunks.length} chunks across ${workerIds.length || '?'} worker(s)`)

      pendingJobs.set(jobId, {
        totalChunks: chunks.length,
        results: new Map(),
        joinFn: mod.join
      })

      for (let i = 0; i < chunks.length; i++) {
        const taskId = crypto.randomUUID()
        taskToJob.set(taskId, { jobId, chunkIndex: i })
        const assignedTo = workerIds.length > 0 ? workerIds[i % workerIds.length] : null
        await base.append({
          type: 'task', id: taskId, jobId, chunkIndex: i, totalChunks: chunks.length,
          code, argNames: ['chunk'], args: [chunks[i]],
          assignedTo,
          by: 'requester', ts: Date.now()
        })
      }
      console.log(`[>] ${chunks.length} subtasks posted`)

    } catch (err) {
      console.log(`[!] Error loading job: ${err.message}`)
    }

  } else if (input.startsWith('file ')) {
    const filePath = input.slice(5).trim()
    try {
      const code = fs.readFileSync(filePath, 'utf-8')
      if (workers.size === 0) {
        console.log('[!] No workers connected yet. Task will be picked up when a worker joins.')
      }
      const id = crypto.randomUUID()
      await base.append({
        type: 'task', id, code, argNames: [], args: [],
        by: 'requester', ts: Date.now()
      })
      console.log(`[>] Task from ${filePath} posted (${id.slice(0, 8)}…)`)
    } catch (err) {
      console.log(`[!] Error reading file: ${err.message}`)
    }

  } else if (input === 'workers') {
    if (workers.size === 0) {
      console.log('No workers connected yet.')
    } else {
      console.log(`${workers.size} worker(s):`)
      for (const [key, info] of workers) {
        console.log(`  ${info.id} — ${key.slice(0, 24)}…`)
      }
    }

  } else if (input === 'results') {
    let count = 0
    for (let i = 0; i < base.view.length; i++) {
      const entry = await base.view.get(i)
      if (entry.type === 'result') {
        count++
        const out = entry.error ? `Error: ${entry.error}` : JSON.stringify(entry.output).slice(0, 80)
        console.log(`  ${entry.taskId.slice(0, 8)}… → ${out} (by ${entry.by})`)
      }
    }
    if (count === 0) console.log('No results yet.')

  } else if (input === 'status') {
    console.log(`Autobase entries: ${base.view.length}`)
    console.log(`Workers: ${workers.size}`)
    console.log(`Results received: ${printedResults.size}`)

  } else if (input === 'help') {
    showHelp()
  } else {
    console.log('Unknown command. Type "help" for usage.')
  }

  rl.prompt()
})

rl.on('close', async () => {
  console.log('\nShutting down...')
  await cleanup()
  process.exit()
})
