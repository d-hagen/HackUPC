// Task requester: hosts own Autobase, advertises on network, assigns tasks to workers
import { createBase, NETWORK_TOPIC } from './base-setup.js'
import { loadReputation, addConsumed, getScore } from './reputation.js'
import { pickWorkerForTask } from './capabilities.js'
import { pathToFileURL } from 'url'
import { resolve } from 'path'
import crypto from 'crypto'
import fs from 'fs'
import readline from 'readline'
import Hyperswarm from 'hyperswarm'

import { basename, extname } from 'path'
import { bundleTask } from './bundler.js'
import { execSync } from 'child_process'

const requesterId = `requester-${crypto.randomUUID().slice(0, 8)}`
const { base, swarm: replicationSwarm, store, drive, cleanup } = await createBase('./store-requester', null)
const autobaseKey = base.key.toString('hex')
const driveKey = drive.key.toString('hex')

console.log('╔═══════════════════════════════════════════╗')
console.log('║       REQUEST COMPUTE — Requester         ║')
console.log('╠═══════════════════════════════════════════╣')
console.log(`║  ID: ${requesterId}              ║`)
console.log('╚═══════════════════════════════════════════╝')
console.log('')

// Track state
const printedResults = new Set()
const workers = new Map() // writerKey -> { id, ts }
const pendingJobs = new Map()
const taskToJob = new Map()
let pendingTaskCount = 0
const pendingTaskRequires = new Map() // taskId -> requires object (null = any worker)

function findJobForTask (taskId) { return taskToJob.get(taskId) || null }

// --- Two swarms: discovery (JSON messaging) and replication (Autobase sync) ---

const BOOTSTRAP = process.env.BOOTSTRAP
const swarmOpts = BOOTSTRAP
  ? { bootstrap: [{ host: BOOTSTRAP.split(':')[0], port: Number(BOOTSTRAP.split(':')[1]) }] }
  : {}

// Discovery swarm: NETWORK_TOPIC only, for advertisements and join handshake
const discoverySwarm = new Hyperswarm(swarmOpts)
discoverySwarm.join(NETWORK_TOPIC, { client: true, server: true })

// Replication swarm: base.discoveryKey only, for Autobase sync
replicationSwarm.join(base.discoveryKey, { client: true, server: true })
replicationSwarm.on('connection', (conn) => {
  store.replicate(conn)
})

// Parse --requires key=val,key2=val2 from start of string
// Returns { requires: object|null, rest: string }
function parseRequires (input) {
  const match = input.match(/^--requires\s+(\S+)\s+(.*)$/s)
  if (!match) return { requires: null, rest: input }
  const pairs = match[1].split(',')
  const requires = {}
  for (const pair of pairs) {
    const [k, v] = pair.split('=')
    if (!k) continue
    if (v === undefined || v === 'true') requires[k] = true
    else if (v === 'false') requires[k] = false
    else if (!isNaN(Number(v))) requires[k] = Number(v)
    else requires[k] = v
  }
  return { requires, rest: match[2].trim() }
}

// Periodically re-broadcast availability
const broadcastConns = new Set()

function broadcast () {
  const rep = loadReputation()
  // Deduplicated list of requires objects for pending tasks (null entry = task any worker can run)
  const requiresSeen = new Set()
  const pendingRequires = []
  for (const req of pendingTaskRequires.values()) {
    const key = req ? JSON.stringify(req) : 'null'
    if (!requiresSeen.has(key)) {
      requiresSeen.add(key)
      pendingRequires.push(req)
    }
  }
  const msg = JSON.stringify({
    type: 'advertise',
    role: 'requester',
    requesterId,
    autobaseKey,
    pendingTasks: pendingTaskCount,
    pendingRequires,
    workerCount: workers.size,
    reputation: { donated: rep.donated, consumed: rep.consumed, score: getScore(rep) }
  })
  for (const conn of broadcastConns) {
    try { conn.write(msg) } catch {}
  }
}

discoverySwarm.on('connection', (conn) => {
  broadcastConns.add(conn)
  conn.on('close', () => broadcastConns.delete(conn))
  conn.on('error', () => broadcastConns.delete(conn))

  // Send advertisement immediately — reuse broadcast() so pendingRequires is always included
  broadcast()

  conn.on('data', async (data) => {
    try {
      const msg = JSON.parse(data.toString())

      if (msg.type === 'join-request' && msg.role === 'worker') {
        const writerKey = msg.writerKey
        if (!workers.has(writerKey)) {
          const caps = msg.capabilities || {}
          workers.set(writerKey, { id: msg.workerId, ts: Date.now(), caps })
          await base.append({ type: 'add-writer', key: writerKey, by: requesterId, ts: Date.now() })
          const gpuStr = caps.hasGPU ? ` | GPU: ${caps.gpuName} (${caps.gpuType})` : ' | CPU only'
          const coreStr = caps.cpuCores ? ` | ${caps.cpuCores} cores ${caps.ramGB}GB RAM` : ''
          console.log(`[+] Worker joined: ${msg.workerId}${gpuStr}${coreStr}`)
          conn.write(JSON.stringify({ type: 'join-accepted', autobaseKey }))
          rl.prompt()
        }
      }
    } catch {}
  })

  // NO replication on discovery connections
})

Promise.all([discoverySwarm.flush(), replicationSwarm.flush()])
  .then(() => console.log('DHT bootstrap complete.'))
console.log('Advertising on network, waiting for workers...\n')

// Re-broadcast every 10s so workers that missed initial ads can discover us
setInterval(() => broadcast(), 10000)

// Watch for results
base.on('update', async () => {
  for (let i = 0; i < base.view.length; i++) {
    const entry = await base.view.get(i)

    if (entry.type === 'worker-available' && !workers.has(entry.key)) {
      workers.set(entry.key, { id: entry.by, ts: entry.ts })
    }

    if (entry.type === 'result' && !printedResults.has(entry.taskId)) {
      printedResults.add(entry.taskId)

      const jobMatch = findJobForTask(entry.taskId)
      if (jobMatch) {
        const { jobId, chunkIndex } = jobMatch
        const job = pendingJobs.get(jobId)
        if (job && !job.results.has(chunkIndex)) {
          job.results.set(chunkIndex, entry.error ? { error: entry.error } : entry.output)
          console.log(`\n[<] Chunk ${chunkIndex + 1}/${job.totalChunks} done (by ${entry.by}, ${entry.elapsed || '?'}ms)`)

          // Progressive preview: works for both strips and grid blocks
          if (job.outputFile && extname(job.outputFile) === '.ppm') {
            try {
              const received = [...job.results.values()].filter(r => r && r.rows)
              if (received.length > 0) {
                const isGrid = received[0].startCol != null && received[0].startCol > 0
                let ppm
                if (isGrid) {
                  // Reconstruct partial image: place blocks at their 2D position, blank elsewhere
                  const fullW = received.reduce((m, r) => Math.max(m, r.endCol), 0)
                  const fullH = received.reduce((m, r) => Math.max(m, r.endRow), 0)
                  const grid = Array.from({ length: fullH }, () => Array(fullW).fill(null))
                  for (const block of received) {
                    for (let y = 0; y < block.rows.length; y++) {
                      for (let x = 0; x < block.rows[y].length; x++) {
                        grid[block.startRow + y][block.startCol + x] = block.rows[y][x]
                      }
                    }
                  }
                  ppm = `P3\n${fullW} ${fullH}\n255\n`
                  for (const row of grid) {
                    ppm += row.map(px => px ? `${px[0]} ${px[1]} ${px[2]}` : '180 180 180').join(' ') + '\n'
                  }
                } else {
                  // Strips: concatenate in row order
                  received.sort((a, b) => a.startRow - b.startRow)
                  const w = received[0].rows[0].length
                  const h = received.reduce((s, r) => s + r.rows.length, 0)
                  ppm = `P3\n${w} ${h}\n255\n`
                  for (const strip of received) {
                    for (const row of strip.rows) ppm += row.map(([r, g, b]) => `${r} ${g} ${b}`).join(' ') + '\n'
                  }
                }
                const pngFile = job.outputFile.replace('.ppm', '.png')
                fs.writeFileSync(job.outputFile, ppm)
                try { execSync(`magick ${job.outputFile} ${pngFile} 2>/dev/null || convert ${job.outputFile} ${pngFile}`) } catch {}
                if (job.results.size === 1) {
                  try { execSync(`open -g ${pngFile}`) } catch {}
                }
                console.log(`    [~] Preview updated: ${pngFile} (${received.length}/${job.totalChunks} blocks)`)
              }
            } catch {}
          }

          if (job.results.size === job.totalChunks) {
            const errors = [...job.results.values()].filter(r => r && r.error)
            if (errors.length > 0) {
              console.log(`[!] Job ${jobId.slice(0, 8)}… had ${errors.length} failed chunks`)
            } else {
              const ordered = Array.from({ length: job.totalChunks }, (_, i) => job.results.get(i))
              try {
                const final = job.joinFn(ordered)
                console.log(`\n[*] JOB ${jobId.slice(0, 8)}… COMPLETE`)
                if (job.outputFile) {
                  fs.writeFileSync(job.outputFile, typeof final === 'string' ? final : JSON.stringify(final, null, 2))
                  console.log(`    Saved → ${job.outputFile}`)
                  if (extname(job.outputFile) === '.ppm') {
                    const pngFile = job.outputFile.replace('.ppm', '.png')
                    try { execSync(`magick ${job.outputFile} ${pngFile} 2>/dev/null || convert ${job.outputFile} ${pngFile}`) } catch {}
                    console.log(`    Saved → ${pngFile}`)
                  }
                } else {
                  const out = typeof final === 'string' ? final : JSON.stringify(final, null, 2)
                  console.log(out.length > 2000 ? out.slice(0, 2000) + '…' : out)
                }
              } catch (err) {
                console.log(`[!] Join failed: ${err.message}`)
              }
            }
            pendingJobs.delete(jobId)
            // Clean up task-to-job mappings for this completed job
            for (const [taskId, mapping] of taskToJob) {
              if (mapping.jobId === jobId) {
                taskToJob.delete(taskId)
                pendingTaskRequires.delete(taskId)
              }
            }
            pendingTaskCount = Math.max(0, pendingTaskCount - job.totalChunks)
            broadcast()
          }
          rl.prompt()
        }
      } else {
        console.log(`\n[<] Result from ${entry.by} (task ${entry.taskId.slice(0, 8)}…)`)
        if (entry.error) {
          console.log(`    Error: ${entry.error}`)
        } else if (entry.output && entry.output.stdout !== undefined) {
          console.log(`    Exit code: ${entry.output.exitCode}`)
          if (entry.output.timedOut) console.log(`    [!] Process timed out`)
          if (entry.output.stdout) console.log(`    stdout: ${entry.output.stdout.slice(0, 400)}`)
          if (entry.output.stderr) console.log(`    stderr: ${entry.output.stderr.slice(0, 200)}`)
        } else {
          const out = JSON.stringify(entry.output ?? null, null, 2)
          console.log(out.length > 500 ? `    ${out.slice(0, 500)}…` : `    ${out}`)
        }
        if (entry.elapsed) console.log(`    (${entry.elapsed}ms)`)
        pendingTaskCount = Math.max(0, pendingTaskCount - 1)
        pendingTaskRequires.delete(entry.taskId)
        broadcast()
        rl.prompt()
      }
    }
  }
})

// Interactive prompt
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function showHelp () {
  console.log(`
Commands:
  run [--requires k=v,...] <code>
                       Send JS code to execute
                         run return 2 + 2
                         run --requires hasGPU=true return "gpu task"
                         run --requires hasPyTorch=true,ramGB=8 return "heavy"
  file <path.js>       Send a .js file as a single task
  bundle <path.js> [arg1 arg2 ...]
                       Bundle a task file + its npm deps into one string, send to worker
                         Task file must: export default function (args...) { ... }
                         Example: bundle tasks/resize.js inputPath outputPath
  job <path.js> [n] [cols]
                       Run a distributed job (split across n workers, default=all)
                         Job file exports: data, split(data,n), compute(chunk), join(results)
                         Extra args passed to split: e.g. "job file.js 2 3" → split(data,2,3) grid
                         Optionally exports: requires (e.g. { hasGPU: true })
  shell [--requires k=v,...] <command>
                       Send a shell command to execute on a worker
                         shell python3 -c "print(2+2)"
                         shell --requires hasGPU=true nvidia-smi
                         shell --timeout 5000 sleep 10
  upload <file> [name] Upload a file to the shared drive (available to workers)
  files                List files on the shared drive
  download <path>      Download a file from worker output
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
    const { requires, rest: code } = parseRequires(input.slice(4).trim())
    if (workers.size === 0) {
      console.log('[!] No workers yet. Task queued — will run when a worker joins.')
    }
    const assignedTo = pickWorkerForTask(requires, workers)
    const id = crypto.randomUUID()
    await base.append({
      type: 'task', id, code, argNames: [], args: [],
      requires: requires || undefined,
      assignedTo: assignedTo || undefined,
      driveKey,
      by: requesterId, ts: Date.now()
    })
    pendingTaskCount++
    pendingTaskRequires.set(id, requires || null)
    addConsumed(1)
    broadcast()
    if (requires) console.log(`[>] Task ${id.slice(0, 8)}… posted (requires: ${JSON.stringify(requires)}, assigned: ${assignedTo || 'any'})`)
    else console.log(`[>] Task ${id.slice(0, 8)}… posted`)

  } else if (input.startsWith('job ')) {
    const parts = input.slice(4).trim().split(/\s+/)
    const filePath = parts[0]
    const extraArgs = parts.slice(1).map(p => parseInt(p)).filter(n => !isNaN(n))
    const nOverride = extraArgs[0] || null
    try {
      const absPath = resolve(filePath)
      const mod = await import(pathToFileURL(absPath).href)

      if (!mod.split || !mod.compute || !mod.join || !mod.data) {
        console.log('[!] Job file must export: data, split(data, n), compute(chunk), join(results)')
        rl.prompt(); return
      }

      const jobRequires = mod.requires || null
      const n = nOverride || Math.max(1, workers.size)
      const chunks = mod.split(mod.data, n, ...extraArgs.slice(1))
      const jobId = crypto.randomUUID()
      const computeCode = mod.compute.toString()
      const code = `const compute = ${computeCode}; return compute(chunk)`

      const workerIds = [...workers.values()].map(w => w.id)
      if (workerIds.length === 0) {
        console.log('[!] No workers connected. Tasks queued — will run when workers join.')
      }

      if (jobRequires) console.log(`[>] Job requires: ${JSON.stringify(jobRequires)}`)
      console.log(`[>] Job ${jobId.slice(0, 8)}… splitting into ${chunks.length} chunks across ${workerIds.length || '?'} worker(s)`)

      pendingJobs.set(jobId, {
        totalChunks: chunks.length,
        results: new Map(),
        joinFn: mod.join,
        outputFile: mod.outputFile || null
      })

      for (let i = 0; i < chunks.length; i++) {
        const taskId = crypto.randomUUID()
        taskToJob.set(taskId, { jobId, chunkIndex: i })
        // For jobs with requirements, pick capable worker; otherwise round-robin
        const assignedTo = jobRequires
          ? pickWorkerForTask(jobRequires, workers)
          : (workerIds.length > 0 ? workerIds[i % workerIds.length] : null)
        await base.append({
          type: 'task', id: taskId, jobId, chunkIndex: i, totalChunks: chunks.length,
          code, argNames: ['chunk'], args: [chunks[i]],
          requires: jobRequires || undefined,
          assignedTo: assignedTo || undefined,
          driveKey,
          by: requesterId, ts: Date.now()
        })
        pendingTaskRequires.set(taskId, jobRequires || null)
      }
      pendingTaskCount += chunks.length
      addConsumed(chunks.length)
      broadcast()
      console.log(`[>] ${chunks.length} subtasks posted`)

    } catch (err) {
      console.log(`[!] Error loading job: ${err.message}`)
    }

  } else if (input.startsWith('file ')) {
    const filePath = input.slice(5).trim()
    try {
      const code = fs.readFileSync(filePath, 'utf-8')
      if (workers.size === 0) {
        console.log('[!] No workers yet. Task queued.')
      }
      const id = crypto.randomUUID()
      await base.append({
        type: 'task', id, code, argNames: [], args: [],
        driveKey, by: requesterId, ts: Date.now()
      })
      pendingTaskCount++
      pendingTaskRequires.set(id, null)
      addConsumed(1)
      broadcast()
      console.log(`[>] Task from ${filePath} posted (${id.slice(0, 8)}…)`)
    } catch (err) {
      console.log(`[!] Error reading file: ${err.message}`)
    }

  } else if (input.startsWith('bundle ')) {
    const parts = input.slice(7).trim().split(/\s+/)
    const filePath = parts[0]
    const argNames = parts.slice(1)
    try {
      const absPath = resolve(filePath)
      console.log(`[~] Bundling ${filePath} with esbuild…`)
      const { code } = await bundleTask(absPath, argNames)
      if (workers.size === 0) {
        console.log('[!] No workers yet. Task queued.')
      }
      const id = crypto.randomUUID()
      await base.append({
        type: 'task', id, code, argNames, args: [],
        bundled: true,
        driveKey, by: requesterId, ts: Date.now()
      })
      pendingTaskCount++
      pendingTaskRequires.set(id, null)
      addConsumed(1)
      broadcast()
      console.log(`[>] Bundled task ${id.slice(0, 8)}… posted (${(code.length / 1024).toFixed(1)} KB)`)
    } catch (err) {
      console.log(`[!] Bundle failed: ${err.message}`)
    }

  } else if (input.startsWith('shell ')) {
    let { requires, rest: cmdStr } = parseRequires(input.slice(6).trim())
    let timeout = 60000

    const timeoutMatch = cmdStr.match(/--timeout\s+(\d+)/)
    if (timeoutMatch) {
      timeout = parseInt(timeoutMatch[1])
      cmdStr = cmdStr.replace(/--timeout\s+\d+/, '').trim()
    }

    if (!cmdStr) {
      console.log('[!] Usage: shell [--requires k=v,...] <command>')
      rl.prompt(); return
    }

    if (workers.size === 0) {
      console.log('[!] No workers yet. Task queued — will run when a shell-enabled worker joins.')
    }
    const shellRequires = { allowsShell: true, ...requires }
    const assignedTo = pickWorkerForTask(shellRequires, workers)
    const id = crypto.randomUUID()
    await base.append({
      type: 'task', id, taskType: 'shell', cmd: cmdStr, timeout,
      requires: shellRequires,
      assignedTo: assignedTo || undefined,
      by: requesterId, ts: Date.now()
    })
    pendingTaskCount++
    pendingTaskRequires.set(id, shellRequires)
    addConsumed(1)
    broadcast()
    console.log(`[>] Shell task ${id.slice(0, 8)}… posted: ${cmdStr.slice(0, 60)} (requires: ${JSON.stringify(shellRequires)}, assigned: ${assignedTo || 'any'})`)

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

  } else if (input.startsWith('upload ')) {
    const parts = input.slice(7).trim().split(/\s+/)
    const localPath = parts[0]
    const remoteName = parts[1] || '/' + basename(localPath)
    const remotePath = remoteName.startsWith('/') ? remoteName : '/' + remoteName
    try {
      const data = fs.readFileSync(resolve(localPath))
      await drive.put(remotePath, data)
      console.log(`[+] Uploaded ${localPath} → ${remotePath} (${data.length} bytes)`)
    } catch (err) {
      console.log(`[!] Upload failed: ${err.message}`)
    }

  } else if (input === 'files') {
    let count = 0
    for await (const entry of drive.list('/')) {
      console.log(`  ${entry.key} (${entry.value.blob.byteLength} bytes)`)
      count++
    }
    if (count === 0) console.log('No files on drive.')

  } else if (input.startsWith('download ')) {
    const remotePath = input.slice(9).trim()
    // Check worker result drives for the file
    let found = false
    for (let i = 0; i < base.view.length; i++) {
      const entry = await base.view.get(i)
      if (entry.type === 'result' && entry.driveKey && entry.outputFiles) {
        if (entry.outputFiles.includes(remotePath)) {
          try {
            const workerDrive = new (await import('hyperdrive')).default(store, Buffer.from(entry.driveKey, 'hex'))
            await workerDrive.ready()
            const data = await workerDrive.get(remotePath)
            const localName = basename(remotePath)
            fs.writeFileSync(localName, data)
            console.log(`[+] Downloaded ${remotePath} → ./${localName} (${data.length} bytes)`)
            found = true
            break
          } catch (err) {
            console.log(`[!] Download failed: ${err.message}`)
          }
        }
      }
    }
    if (!found) {
      // Try own drive
      try {
        const data = await drive.get(remotePath)
        if (data) {
          const localName = basename(remotePath)
          fs.writeFileSync(localName, data)
          console.log(`[+] Downloaded ${remotePath} → ./${localName} (${data.length} bytes)`)
        } else {
          console.log(`[!] File not found: ${remotePath}`)
        }
      } catch {
        console.log(`[!] File not found: ${remotePath}`)
      }
    }

  } else if (input === 'status') {
    const rep = loadReputation()
    console.log(`Autobase entries: ${base.view.length}`)
    console.log(`Workers: ${workers.size}`)
    console.log(`Pending tasks: ${pendingTaskCount}`)
    console.log(`Results received: ${printedResults.size}`)
    console.log(`Reputation: score=${getScore(rep)} (donated=${rep.donated}, consumed=${rep.consumed})`)

  } else if (input === 'help') {
    showHelp()
  } else {
    console.log('Unknown command. Type "help" for usage.')
  }

  rl.prompt()
})

rl.on('close', async () => {
  console.log('\nShutting down...')
  await discoverySwarm.destroy()
  await cleanup()
  process.exit()
})
