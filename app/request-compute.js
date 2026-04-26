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
import http from 'http'

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

// Live preview server
let previewServer = null
let previewPngFile = null

function startPreviewServer (pngFile, dagMeta) {
  previewPngFile = pngFile
  // If server already running just update the png path and return — HTML already served
  if (previewServer) {
    previewServer.meta(0, 0)
    previewServer.dag({ tasks: [], N: 0 })
    return
  }

  const hasDag = true // always render DAG panel — it hides itself when no data

  const html = `<!DOCTYPE html>
<html>
<head>
<title>PeerCompute — Live Render</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #111; display: flex; flex-direction: row; align-items: flex-start; justify-content: center; min-height: 100vh; font-family: monospace; color: #aaa; gap: 32px; padding: 24px; }
  .panel { display: flex; flex-direction: column; align-items: center; }
  h2 { margin: 0 0 12px; font-size: 13px; letter-spacing: 2px; color: #555; }
  img { display: block; max-width: 50vw; max-height: 85vh; image-rendering: pixelated; border: 1px solid #333; }
  #status { margin-top: 10px; font-size: 12px; color: #444; }
  #dag-wrap { position: relative; }
  canvas { border: 1px solid #333; background: #0a0a0a; }
</style>
</head>
<body>
<div class="panel">
  <h2>PEERCOMPUTE — LIVE RENDER</h2>
  <img id="img" src="/image?t=0" />
  <div id="status">waiting for chunks…</div>
</div>
<div class="panel" id="dag-panel" style="display:none">
  <h2>TASK DEPENDENCY GRAPH</h2>
  <div id="dag-wrap"><canvas id="dag"></canvas></div>
</div>
<script>
  let t = 0
  let chunks = 0
  let total = 0

  setInterval(async () => {
    const res = await fetch('/meta')
    const meta = await res.json()
    if (meta.chunks !== chunks || meta.total !== total) {
      chunks = meta.chunks; total = meta.total
      document.getElementById('status').textContent =
        chunks === total && total > 0
          ? 'COMPLETE — ' + chunks + '/' + total + ' blocks rendered'
          : chunks + '/' + total + ' blocks received…'
    }
    t++
    document.getElementById('img').src = '/image?t=' + t
  }, 500)


  const CELL = 72
  const PAD = 36
  const canvas = document.getElementById('dag')
  const ctx = canvas.getContext('2d')
  let lastN = 0

  function cellCenter(N, r, c) {
    return [PAD + c * CELL + CELL / 2, PAD + r * CELL + CELL / 2]
  }

  function drawArrow(x1, y1, x2, y2, color) {
    const dx = x2 - x1, dy = y2 - y1
    const len = Math.sqrt(dx*dx + dy*dy)
    const rad = 18
    const sx = x1 + dx / len * rad, sy = y1 + dy / len * rad
    const ex = x2 - dx / len * (rad + 4), ey = y2 - dy / len * (rad + 4)
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey)
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke()
    const angle = Math.atan2(ey - sy, ex - sx)
    ctx.beginPath()
    ctx.moveTo(ex, ey)
    ctx.lineTo(ex - 8 * Math.cos(angle - 0.4), ey - 8 * Math.sin(angle - 0.4))
    ctx.lineTo(ex - 8 * Math.cos(angle + 0.4), ey - 8 * Math.sin(angle + 0.4))
    ctx.closePath(); ctx.fillStyle = color; ctx.fill()
  }

  async function renderDag() {
    const res = await fetch('/dag')
    const dag = await res.json()
    const N = dag.N
    if (!N || !dag.tasks || dag.tasks.length === 0) return
    document.getElementById('dag-panel').style.display = 'flex'
    const W = N * CELL + PAD * 2
    if (N !== lastN) { canvas.width = W; canvas.height = W; lastN = N }
    ctx.clearRect(0, 0, W, W)

    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const [x, y] = cellCenter(N, r, c)
        const t = dag.tasks[r * N + c]
        const arrowColor = t.state === 'done' ? '#2a4a2a' : '#2a2a2a'
        if (r > 0) { const [px, py] = cellCenter(N, r-1, c); drawArrow(px, py, x, y, arrowColor) }
        if (c > 0) { const [px, py] = cellCenter(N, r, c-1); drawArrow(px, py, x, y, arrowColor) }
      }
    }

    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const [x, y] = cellCenter(N, r, c)
        const t = dag.tasks[r * N + c]
        const state = t.state
        const fill = state === 'done' ? '#1a5c1a' : state === 'ready' ? '#5c4a00' : '#1a1a2a'
        const border = state === 'done' ? '#3f3' : state === 'ready' ? '#fa0' : '#334'
        ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2)
        ctx.fillStyle = fill; ctx.fill()
        ctx.strokeStyle = border; ctx.lineWidth = 2; ctx.stroke()
        ctx.fillStyle = state === 'done' ? '#7f7' : state === 'ready' ? '#fc0' : '#446'
        ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(r + ',' + c, x, y - 4)
        if (state === 'done' && t.value != null) {
          ctx.fillStyle = '#555'; ctx.font = '9px monospace'
          ctx.fillText('v=' + t.value, x, y + 6)
        }
        if (state === 'ready') {
          ctx.fillStyle = '#fa0'; ctx.font = '8px monospace'
          ctx.fillText('READY', x, y + 6)
        }
      }
    }

    ctx.font = '10px monospace'; ctx.textAlign = 'left'
    ctx.fillStyle = '#3f3'; ctx.fillText('● done', 10, W - 44)
    ctx.fillStyle = '#fa0'; ctx.fillText('● ready (waiting for worker)', 10, W - 30)
    ctx.fillStyle = '#446'; ctx.fillText('● blocked (deps pending)', 10, W - 16)
  }

  setInterval(renderDag, 500)
  renderDag()
</script>
</body>
</html>`

  let metaChunks = 0
  let metaTotal = 0
  let dagState = null  // { tasks: [{row,col,state,value}], N }

  previewServer = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
    } else if (req.url && req.url.startsWith('/image')) {
      if (previewPngFile && fs.existsSync(previewPngFile)) {
        try {
          const data = fs.readFileSync(previewPngFile)
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
          res.end(data)
        } catch { res.writeHead(500); res.end() }
      } else {
        const black = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(black)
      }
    } else if (req.url === '/meta') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ chunks: metaChunks, total: metaTotal }))
    } else if (req.url === '/dag') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(dagState || { tasks: [], N: 0 }))
    } else {
      res.writeHead(404); res.end()
    }
  })

  previewServer.meta = (chunks, total) => { metaChunks = chunks; metaTotal = total }
  previewServer.dag = (state) => { dagState = state }
  previewServer.listen(7842, '127.0.0.1', () => {
    console.log('[~] Preview server: http://localhost:7842')
    try { execSync('open http://localhost:7842') } catch {}
  })
}

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
  conn.on('error', () => {})
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
const printedChunks = new Set()

base.on('update', async () => {
  for (let i = 0; i < base.view.length; i++) {
    const entry = await base.view.get(i)

    if (entry.type === 'worker-available' && !workers.has(entry.key)) {
      workers.set(entry.key, { id: entry.by, ts: entry.ts })
    }

    if (entry.type === 'stream-chunk') {
      const key = `${entry.taskId}:${entry.seq}`
      if (!printedChunks.has(key)) {
        printedChunks.add(key)
        const jobMatch = findJobForTask(entry.taskId)
        const prefix = jobMatch
          ? `[job ${jobMatch.jobId.slice(0, 8)}… chunk ${jobMatch.chunkIndex}] `
          : ''
        if (entry.channel === 'stdout') {
          process.stdout.write(prefix + entry.data)
        } else if (entry.channel === 'stderr') {
          process.stderr.write(prefix + entry.data)
        } else {
          const preview = typeof entry.data === 'string'
            ? entry.data
            : JSON.stringify(entry.data)
          console.log(`  ${prefix}[stream ${entry.taskId.slice(0, 8)}… #${entry.seq}] ${preview.slice(0, 200)}`)
        }
      }
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

          // Update DAG visualization state
          if (job.dagTasks && entry.output) {
            job.dagTasks[chunkIndex].state = 'done'
            job.dagTasks[chunkIndex].value = entry.output.value ?? null
            // Mark newly unblocked tasks as 'ready'
            const N = job.dagN
            for (let i = 0; i < job.dagTasks.length; i++) {
              if (job.dagTasks[i].state !== 'blocked') continue
              const deps = job.dagTasks[i].dependsOn || []
              const allDone = deps.every(depIdx => job.dagTasks[depIdx]?.state === 'done')
              if (allDone) job.dagTasks[i].state = 'ready'
            }
            if (previewServer) previewServer.dag({ tasks: job.dagTasks, N: job.dagN })
          }

          // Progressive preview: works for both strips and grid blocks
          if (job.outputFile && extname(job.outputFile) === '.ppm') {
            try {
              const received = [...job.results.values()].filter(r => r && r.rows)
              if (received.length > 0) {
                // Always use full image dimensions so blocks appear at correct position
                const fullW = job.imageWidth || received.reduce((m, r) => Math.max(m, r.endCol ?? r.rows[0].length), 0)
                const fullH = job.imageHeight || received.reduce((m, r) => Math.max(m, r.endRow), 0)
                const grid = Array.from({ length: fullH }, () => new Array(fullW).fill(null))
                for (const block of received) {
                  const colOffset = block.startCol ?? 0
                  // GPU-rendered blocks get a purple tint so you can see which worker used GPU
                  const isGpu = block.device && !block.device.startsWith('CPU')
                  for (let y = 0; y < block.rows.length; y++) {
                    for (let x = 0; x < block.rows[y].length; x++) {
                      let px = block.rows[y][x]
                      if (isGpu) {
                        // blend 30% purple overlay: boost R+B, dim G
                        px = [
                          Math.min(255, Math.round(px[0] * 0.7 + 80)),
                          Math.round(px[1] * 0.7),
                          Math.min(255, Math.round(px[2] * 0.7 + 80))
                        ]
                      }
                      grid[block.startRow + y][colOffset + x] = px
                    }
                  }
                }
                let ppm = `P3\n${fullW} ${fullH}\n255\n`
                for (const row of grid) {
                  ppm += row.map(px => px ? `${px[0]} ${px[1]} ${px[2]}` : '40 40 40').join(' ') + '\n'
                }
                const pngFile = job.outputFile.replace('.ppm', '.png')
                fs.writeFileSync(job.outputFile, ppm)
                try { execSync(`magick ${job.outputFile} ${pngFile} 2>/dev/null || convert ${job.outputFile} ${pngFile}`) } catch {}
                if (job.results.size === 1) {
                  try { execSync(`open -g ${pngFile}`) } catch {}
                }
                if (previewServer) previewServer.meta(received.length, job.totalChunks)
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
        if (entry.streamed) {
          console.log(`\n[<] Task ${entry.taskId.slice(0, 8)}… completed (streamed ${entry.totalChunks} chunks, ${entry.elapsed || '?'}ms)`)
          if (entry.output !== null && entry.output !== undefined) {
            const out = JSON.stringify(entry.output, null, 2)
            console.log(`    Return value: ${out.length > 500 ? out.slice(0, 500) + '…' : out}`)
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
        }
        if (entry.elapsed && !entry.streamed) console.log(`    (${entry.elapsed}ms)`)
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
                         run return Array.from({length:10}, (_,i) => i*i)
                         run --requires hasGPU=true return "gpu task"
                         run --requires hasPyTorch=true,ramGB=8 return "heavy"
                         Tasks get: readFile(path), listFiles(), writeFile(path, data), emit(data)
                         Use emit(data) to stream intermediate results back in real-time
  file <path.js>       Send a .js file as a single task
  bundle <path.js> [argNames...] [-- values...]
                       Bundle a task file + its npm deps into one string, send to worker
                         Task file must: export default function (args...) { ... }
                         Example: bundle tasks/slugify-text.js text -- "Hello World"
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

      // Call prepare(drive) if exported — e.g. upload Python scripts to Hyperdrive
      if (mod.prepare) {
        console.log('[~] Running job prepare()…')
        try { await mod.prepare(drive) } catch (err) { console.log(`[!] prepare() failed: ${err.message}`) }
      }

      let chunks = mod.split(mod.data, n, ...extraArgs.slice(1))
      const jobId = crypto.randomUUID()
      const computeCode = mod.compute.toString()
      // gpuComputeCode: custom task code that runs python via child_process (GPU jobs)
      const baseCode = mod.gpuComputeCode
        ? mod.gpuComputeCode.trim()
        : `const compute = ${computeCode}; return compute(chunk)`
      // depAwareCode: alternative code for tasks that receive dependency outputs
      const depAwareCode = mod.depAwareCode ? mod.depAwareCode.trim() : null

      const workerIds = [...workers.values()].map(w => w.id)
      if (workerIds.length === 0) {
        console.log('[!] No workers connected. Tasks queued — will run when workers join.')
      }

      // Shuffle chunk order so blocks don't appear strictly top-to-bottom
      const chunkOrder = Array.from({ length: chunks.length }, (_, i) => i)
      for (let i = chunkOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [chunkOrder[i], chunkOrder[j]] = [chunkOrder[j], chunkOrder[i]]
      }

      if (jobRequires) console.log(`[>] Job requires: ${JSON.stringify(jobRequires)}`)
      console.log(`[>] Job ${jobId.slice(0, 8)}… splitting into ${chunks.length} chunks across ${workerIds.length || '?'} worker(s)`)

      const jobOutputFile = mod.outputFile || null

      // DAG metadata for visualization (if job exports dagLayout = 'grid')
      const dagMeta = mod.dagLayout === 'grid' ? { N: Math.round(Math.sqrt(chunks.length)) } : null

      if (jobOutputFile && extname(jobOutputFile) === '.ppm') {
        const pngFile = jobOutputFile.replace('.ppm', '.png')
        startPreviewServer(pngFile, dagMeta)
        if (previewServer) previewServer.meta(0, chunks.length)
      }

      // Infer full image dimensions from data or chunks for preview positioning
      const imageWidth = mod.data.width || mod.data.gridSize || chunks.reduce((m, c) => Math.max(m, c.endCol ?? c.gridSize ?? 0), 0) || null
      const imageHeight = mod.data.height || mod.data.gridSize || chunks.reduce((m, c) => Math.max(m, c.endRow ?? 0), 0) || null

      // Build taskId map for DAG: chunkIndex -> taskId (needed for dependsOn resolution)
      const chunkTaskIds = Array.from({ length: chunks.length }, () => crypto.randomUUID())

      // Build DAG task state array for visualization (tracks which chunks are done/pending)
      const dagTasks = dagMeta
        ? chunks.map((c, i) => ({ row: c.row ?? Math.floor(i / dagMeta.N), col: c.col ?? (i % dagMeta.N), state: 'blocked', value: null, dependsOn: c.dependsOn }))
        : null

      // Mark tasks with no deps as 'ready' immediately
      if (dagTasks) {
        for (const t of dagTasks) {
          if (!t.dependsOn || t.dependsOn.length === 0) t.state = 'ready'
        }
        if (previewServer) previewServer.dag({ tasks: dagTasks, N: dagMeta.N })
      }

      pendingJobs.set(jobId, {
        totalChunks: chunks.length,
        results: new Map(),
        joinFn: mod.join,
        outputFile: jobOutputFile,
        imageWidth,
        imageHeight,
        dagTasks,
        dagN: dagMeta?.N || null,
        chunkTaskIds
      })

      for (const i of chunkOrder) {
        const taskId = chunkTaskIds[i]
        taskToJob.set(taskId, { jobId, chunkIndex: i })

        // Workers self-select tasks — no round-robin assignment
        // This lets each worker's thread pool grab multiple tasks concurrently
        const assignedTo = jobRequires ? pickWorkerForTask(jobRequires, workers) : null

        const chunk = chunks[i]

        // Detect shell chunk: compute() returned { shellCmd, ... }
        const isShellChunk = chunk && typeof chunk.shellCmd === 'string'

        // Resolve dependsOn: chunk may have dependsOn: [chunkIndex, ...] → map to taskIds
        const dependsOn = chunk && chunk.dependsOn
          ? chunk.dependsOn.map(depIdx => chunkTaskIds[depIdx])
          : undefined

        if (isShellChunk) {
          const shellRequires = { allowsShell: true, ...jobRequires }
          await base.append({
            type: 'task', id: taskId, jobId, chunkIndex: i, totalChunks: chunks.length,
            taskType: 'shell', cmd: chunk.shellCmd,
            requires: shellRequires,
            assignedTo: assignedTo || undefined,
            driveKey,
            dependsOn: dependsOn || undefined,
            by: requesterId, ts: Date.now()
          })
          pendingTaskRequires.set(taskId, shellRequires)
        } else {
          // Use depAwareCode for tasks with dependencies, baseCode otherwise
          const taskCode = (dependsOn && dependsOn.length > 0 && depAwareCode) ? depAwareCode : baseCode
          await base.append({
            type: 'task', id: taskId, jobId, chunkIndex: i, totalChunks: chunks.length,
            code: taskCode, argNames: ['chunk'], args: [chunk],
            requires: jobRequires || undefined,
            assignedTo: assignedTo || undefined,
            driveKey,
            dependsOn: dependsOn || undefined,
            by: requesterId, ts: Date.now()
          })
          pendingTaskRequires.set(taskId, jobRequires || null)
        }
      }
      pendingTaskCount += chunks.length
      addConsumed(chunks.length)
      broadcast()
      console.log(`[>] ${chunks.length} subtasks posted${hasAnyDeps ? ' (DAG mode — dynamic assignment)' : ''}`)

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
    const raw = input.slice(7).trim()
    const sepIdx = raw.indexOf(' -- ')
    let beforeSep, afterSep
    if (sepIdx !== -1) {
      beforeSep = raw.slice(0, sepIdx).trim()
      afterSep = raw.slice(sepIdx + 4).trim()
    } else {
      beforeSep = raw
      afterSep = ''
    }
    const parts = beforeSep.split(/\s+/)
    const filePath = parts[0]
    const argNames = parts.slice(1)
    const args = afterSep ? afterSep.match(/"[^"]*"|'[^']*'|\S+/g).map(s => s.replace(/^["']|["']$/g, '')) : []
    try {
      const absPath = resolve(filePath)
      console.log(`[~] Bundling ${filePath} with esbuild…`)
      const { code } = await bundleTask(absPath, argNames)
      if (workers.size === 0) {
        console.log('[!] No workers yet. Task queued.')
      }
      const id = crypto.randomUUID()
      await base.append({
        type: 'task', id, code, argNames, args,
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
