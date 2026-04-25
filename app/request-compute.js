// Task requester: hosts own Autobase, advertises on network, assigns tasks to workers
import { createBase, NETWORK_TOPIC } from './base-setup.js'
import { loadReputation, addConsumed, getScore } from './reputation.js'
import { pathToFileURL } from 'url'
import { resolve } from 'path'
import crypto from 'crypto'
import fs from 'fs'
import readline from 'readline'
import Hyperswarm from 'hyperswarm'

import { basename } from 'path'

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

// Periodically re-broadcast availability
const broadcastConns = new Set()

function broadcast () {
  const rep = loadReputation()
  const msg = JSON.stringify({
    type: 'advertise',
    role: 'requester',
    requesterId,
    autobaseKey,
    pendingTasks: pendingTaskCount,
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

  // Send advertisement immediately
  const rep = loadReputation()
  conn.write(JSON.stringify({
    type: 'advertise',
    role: 'requester',
    requesterId,
    autobaseKey,
    pendingTasks: pendingTaskCount,
    reputation: { donated: rep.donated, consumed: rep.consumed, score: getScore(rep) },
    workerCount: workers.size
  }))

  conn.on('data', async (data) => {
    try {
      const msg = JSON.parse(data.toString())

      if (msg.type === 'join-request' && msg.role === 'worker') {
        const writerKey = msg.writerKey
        if (!workers.has(writerKey)) {
          workers.set(writerKey, { id: msg.workerId, ts: Date.now() })
          await base.append({ type: 'add-writer', key: writerKey, by: requesterId, ts: Date.now() })
          console.log(`[+] Worker joined: ${msg.workerId}`)
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

          if (job.results.size === job.totalChunks) {
            const errors = [...job.results.values()].filter(r => r && r.error)
            if (errors.length > 0) {
              console.log(`[!] Job ${jobId.slice(0, 8)}… had ${errors.length} failed chunks`)
            } else {
              const ordered = Array.from({ length: job.totalChunks }, (_, i) => job.results.get(i))
              try {
                const final = job.joinFn(ordered)
                console.log(`\n[*] JOB ${jobId.slice(0, 8)}… COMPLETE`)
                const out = typeof final === 'string' ? final : JSON.stringify(final, null, 2)
                console.log(out.length > 2000 ? out.slice(0, 2000) + '…' : out)
              } catch (err) {
                console.log(`[!] Join failed: ${err.message}`)
              }
            }
            pendingJobs.delete(jobId)
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
  run <code>           Send JS code to execute
                         run return 2 + 2
                         run return Array.from({length:10}, (_,i) => i*i)
                         Tasks with files get: readFile(path), listFiles(), writeFile(path, data)
  file <path.js>       Send a .js file as a single task
  job <path.js> [n]    Run a distributed job (split across n workers, default=all)
                         Job file exports: data, split(data,n), compute(chunk), join(results)
  shell <command>      Send a shell command to execute on a worker
                         shell python3 -c "print(2+2)"
                         shell echo hello world
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
    const code = input.slice(4).trim()
    if (workers.size === 0) {
      console.log('[!] No workers yet. Task queued — will run when a worker joins.')
    }
    const id = crypto.randomUUID()
    pendingTaskCount++
    broadcast()
    await base.append({
      type: 'task', id, code, argNames: [], args: [],
      driveKey,
      by: requesterId, ts: Date.now()
    })
    addConsumed(1)
    broadcast()
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

      const workerIds = [...workers.values()].map(w => w.id)
      if (workerIds.length === 0) {
        console.log('[!] No workers connected. Tasks queued — will run when workers join.')
      }

      console.log(`[>] Job ${jobId.slice(0, 8)}… splitting into ${chunks.length} chunks across ${workerIds.length || '?'} worker(s)`)

      pendingJobs.set(jobId, {
        totalChunks: chunks.length,
        results: new Map(),
        joinFn: mod.join
      })

      pendingTaskCount += chunks.length
      broadcast()

      for (let i = 0; i < chunks.length; i++) {
        const taskId = crypto.randomUUID()
        taskToJob.set(taskId, { jobId, chunkIndex: i })
        const assignedTo = workerIds.length > 0 ? workerIds[i % workerIds.length] : null
        await base.append({
          type: 'task', id: taskId, jobId, chunkIndex: i, totalChunks: chunks.length,
          code, argNames: ['chunk'], args: [chunks[i]],
          assignedTo, driveKey,
          by: requesterId, ts: Date.now()
        })
      }
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
      pendingTaskCount++
      broadcast()
      await base.append({
        type: 'task', id, code, argNames: [], args: [],
        driveKey, by: requesterId, ts: Date.now()
      })
      addConsumed(1)
      broadcast()
      console.log(`[>] Task from ${filePath} posted (${id.slice(0, 8)}…)`)
    } catch (err) {
      console.log(`[!] Error reading file: ${err.message}`)
    }

  } else if (input.startsWith('shell ')) {
    let cmdStr = input.slice(6).trim()
    let timeout = 60000

    const timeoutMatch = cmdStr.match(/--timeout\s+(\d+)/)
    if (timeoutMatch) {
      timeout = parseInt(timeoutMatch[1])
      cmdStr = cmdStr.replace(/--timeout\s+\d+/, '').trim()
    }

    if (!cmdStr) {
      console.log('[!] Usage: shell <command>')
      rl.prompt(); return
    }

    if (workers.size === 0) {
      console.log('[!] No workers yet. Task queued — will run when a shell-enabled worker joins.')
    }
    const id = crypto.randomUUID()
    pendingTaskCount++
    broadcast()
    await base.append({
      type: 'task', id, taskType: 'shell', cmd: cmdStr, timeout,
      by: requesterId, ts: Date.now()
    })
    addConsumed(1)
    broadcast()
    console.log(`[>] Shell task ${id.slice(0, 8)}… posted: ${cmdStr.slice(0, 60)}`)

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
