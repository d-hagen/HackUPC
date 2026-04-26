import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const WEB_DIR = path.join(__dirname, 'web')
const UPLOAD_DIR = path.join(__dirname, 'uploads')
const JOBS_DIR = path.join(__dirname, 'jobs')
const PORT = Number(process.env.PORT) || 7843

fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
}

// ── State ──
let requesterProc = null
let workerProc = null
const sseClients = new Set()
const state = {
  requesterLaunched: false,
  workerLaunched: false,
  requesterId: null,
  workers: [],
  pendingTasks: 0,
  resultsReceived: 0,
  reputation: { donated: 0, consumed: 0, score: 0 },
  workerStatus: { searching: true, currentRequester: null, totalTasksDone: 0 },
  workerCaps: null,
  tasks: new Map(),
  jobs: new Map(),
  log: []
}

function broadcast (type, payload) {
  const data = JSON.stringify({ type, payload })
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`) } catch { sseClients.delete(res) }
  }
}

function addLog (role, msg, level = 'info') {
  const entry = { ts: Date.now(), role, msg, level }
  state.log.push(entry)
  if (state.log.length > 500) state.log.shift()
  broadcast('log', entry)
}

// ── Multi-line result buffering ──
let resultBuf = null // { taskId, by, lines: [] }

function flushResultBuf () {
  if (!resultBuf) return
  const { taskId, by, lines } = resultBuf
  resultBuf = null

  let output = null
  let elapsed = null
  let error = null

  for (const ln of lines) {
    const t = ln.trim()
    if (t.startsWith('Error:')) {
      error = t.replace('Error:', '').trim()
    } else if (t.match(/^\([\d.]+ms\)$/)) {
      elapsed = t.replace(/[()ms]/g, '')
    } else if (t.startsWith('Exit code:')) {
      if (!output) output = ''
      output += t + '\n'
    } else if (t.startsWith('stdout:') || t.startsWith('stderr:')) {
      if (!output) output = ''
      output += t + '\n'
    } else if (t.startsWith('[!]')) {
      if (!output) output = ''
      output += t + '\n'
    } else if (t.startsWith('Return value:')) {
      output = t.replace('Return value:', '').trim()
    } else if (t) {
      output = output ? output + '\n' + t : t
    }
  }

  if (output) output = output.trim()
  state.pendingTasks = Math.max(0, state.pendingTasks - 1)
  state.resultsReceived++
  const task = state.tasks.get(taskId)
  if (task) { task.status = error ? 'error' : 'done'; task.by = by; task.elapsed = elapsed }
  broadcast('result', { taskId, by, elapsed, error, output })
  addLog('requester', `Result from ${by} (task ${taskId}…)${output ? ': ' + (output.length > 80 ? output.slice(0, 80) + '…' : output) : ''}`, error ? 'error' : 'success')
}

// ── Parse stdout from requester/worker processes ──
function parseRequesterLine (line) {
  const s = line.trim()

  // If we're buffering a multi-line result, check if this line is a continuation (indented)
  if (resultBuf) {
    if (!s) return // blank line inside result block, ignore
    if (line.startsWith('    ') || line.startsWith('\t')) {
      resultBuf.lines.push(s)
      return
    }
    flushResultBuf()
  }

  if (!s) return

  if (s.includes('Worker joined:') || s.includes('[+] Worker joined:')) {
    const match = s.match(/Worker joined:\s*(\S+)/)
    if (match) {
      const wid = match[1]
      if (!state.workers.includes(wid)) state.workers.push(wid)
      broadcast('worker-joined', { workerId: wid })
      addLog('requester', `Worker joined: ${wid}`, 'success')
    }
    return
  }

  if (s.includes('[>] Task') && s.includes('posted')) {
    const match = s.match(/Task (\S+)…?\s+posted/)
    if (match) {
      const taskId = match[1]
      state.pendingTasks++
      const preview = s.includes(':') ? s.split('posted')[1]?.trim() || s : s
      state.tasks.set(taskId, { id: taskId, status: 'pending', preview: preview.slice(0, 60) })
      broadcast('task-posted', { taskId, preview: preview.slice(0, 60) })
      addLog('requester', s, 'accent')
    }
    return
  }

  if (s.includes('[>] Job') && s.includes('splitting')) {
    const match = s.match(/Job (\S+)…?\s+splitting into (\d+) chunks across (\d+|\?)/)
    if (match) {
      const jobId = match[1]
      const total = parseInt(match[2])
      state.jobs.set(jobId, { totalChunks: total, done: 0 })
      broadcast('job-posted', { jobId, totalChunks: total })
      for (let i = 0; i < total; i++) {
        const chunkId = `${jobId}-chunk-${i}`
        state.tasks.set(chunkId, { id: chunkId, status: 'pending', preview: `Chunk ${i + 1}/${total}`, jobId })
        broadcast('task-posted', { taskId: chunkId, preview: `Chunk ${i + 1}/${total}`, jobId })
      }
      state.pendingTasks += total
      addLog('requester', s, 'accent')
    }
    return
  }

  if (s.includes('subtasks posted')) {
    return
  }

  if (s.includes('[<] Chunk')) {
    const match = s.match(/Chunk (\d+)\/(\d+) done \(by (\S+),\s*([\d.]+)ms/)
    if (match) {
      const chunkIndex = parseInt(match[1]) - 1
      const total = parseInt(match[2])
      const by = match[3]
      const elapsed = match[4]
      // Find and update the job task entry
      for (const [id, task] of state.tasks) {
        if (task.jobId && task.preview === `Chunk ${chunkIndex + 1}/${total}` && task.status === 'pending') {
          task.status = 'done'
          task.by = by
          task.elapsed = elapsed
          broadcast('result', { taskId: id, by, elapsed, error: null })
          break
        }
      }
      const job = [...state.jobs.values()].find(j => j.totalChunks === total)
      if (job) job.done++
      state.pendingTasks = Math.max(0, state.pendingTasks - 1)
      state.resultsReceived++
      broadcast('chunk-done', { chunkIndex, totalChunks: total, by, elapsed })
      addLog('requester', s, 'success')
    }
    return
  }

  if (s.includes('[<] Result from')) {
    const match = s.match(/Result from (\S+) \(task (\S+)…?\)/)
    if (match) {
      resultBuf = { taskId: match[2], by: match[1], lines: [] }
    }
    return
  }

  if (s.includes('[<] Task') && s.includes('completed (streamed')) {
    const match = s.match(/Task (\S+)…?\s+completed \(streamed (\d+) chunks, ([\d.?]+)ms\)/)
    if (match) {
      resultBuf = { taskId: match[1], by: 'stream', lines: [] }
    }
    return
  }

  if (s.includes('Error:')) {
    const match = s.match(/task (\S+)…?\)/)
    if (match) {
      const taskId = match[1]
      const task = state.tasks.get(taskId)
      if (task) task.status = 'error'
      broadcast('result', { taskId, error: s })
    }
    addLog('requester', s, 'error')
    return
  }

  if (s.includes('JOB') && s.includes('COMPLETE')) {
    const match = s.match(/JOB (\S+)…?\s+COMPLETE/)
    if (match) {
      broadcast('job-complete', { jobId: match[1] })
      addLog('requester', s, 'success')
    }
    return
  }

  if (s.includes('ID:') && s.includes('requester-')) {
    const match = s.match(/(requester-\S+)/)
    if (match) {
      state.requesterId = match[1]
      broadcast('requester-id', { requesterId: match[1] })
    }
    addLog('requester', s, 'info')
    return
  }

  if (s.includes('DHT bootstrap complete')) {
    broadcast('requester-ready', { status: 'online', requesterId: state.requesterId })
    addLog('requester', s, 'success')
    return
  }

  if (s.startsWith('[') || s.includes('Advertis') || s.includes('Autobase') || s.includes('Requester')) {
    addLog('requester', s, 'info')
  }
}

function parseWorkerLine (line) {
  const s = line.trim()
  if (!s) return

  if (s.includes('Detected') || s.includes('Platform:')) {
    const match = s.match(/Platform:\s*(\S+)\s*\|\s*CPU:\s*(\d+)\s*cores\s*\|\s*RAM:\s*([\d.]+)GB/)
    if (match) {
      state.workerCaps = {
        platform: match[1],
        cpuCores: parseInt(match[2]),
        ramGB: parseFloat(match[3])
      }
      broadcast('capabilities-detected', state.workerCaps)
    }
    const gpuMatch = s.match(/GPU:\s*(.+?)\s*\((\w+)\)/)
    if (gpuMatch && state.workerCaps) {
      state.workerCaps.gpuName = gpuMatch[1]
      state.workerCaps.gpuType = gpuMatch[2]
      broadcast('capabilities-detected', state.workerCaps)
    }
    addLog('worker', s, 'info')
    return
  }

  if (s.includes('Thread pool:')) {
    const match = s.match(/Thread pool:\s*(\d+)/)
    if (match) {
      if (!state.workerCaps) state.workerCaps = {}
      state.workerCaps.poolSize = parseInt(match[1])
    }
    addLog('worker', s, 'info')
    return
  }

  if (s.includes('Listening for requesters')) {
    broadcast('worker-ready', { status: 'online' })
    addLog('worker', s, 'success')
    return
  }

  if (s.includes('DHT bootstrap complete')) {
    broadcast('worker-ready', { status: 'online' })
    addLog('worker', s, 'success')
    return
  }

  if (s.includes('[~] Joining')) {
    const match = s.match(/Joining (\S+)/)
    if (match) {
      state.workerStatus.searching = false
      state.workerStatus.currentRequester = match[1]
      broadcast('worker-joining', { requesterId: match[1] })
      addLog('worker', s, 'accent')
    }
    return
  }

  if (s.includes('[+] Authorized')) {
    broadcast('worker-authorized', {})
    addLog('worker', s, 'success')
    return
  }

  if (s.includes('[+] Writable')) {
    addLog('worker', s, 'success')
    return
  }

  if (s.includes('Connected to')) {
    const match = s.match(/Connected to (\S+),/)
    if (match) {
      state.workerStatus.currentRequester = match[1]
      broadcast('worker-joined-requester', { requesterId: match[1] })
      addLog('worker', s, 'success')
    }
    return
  }

  if (s.includes('[>] Task')) {
    const match = s.match(/Task (\S+)…?\s*\|\s*(.+?)\s*\[(pool|main)\]/)
    if (match) {
      broadcast('task-start', { taskId: match[1], preview: match[2], mode: match[3] })
      addLog('worker', s, 'accent')
    }
    return
  }

  if (s.includes('[<] Done in')) {
    const match = s.match(/Done in ([\d.]+)ms\s*\|\s*thread #(\d+)/)
    if (match) {
      state.workerStatus.totalTasksDone++
      broadcast('task-done', { elapsed: match[1], threadId: match[2] })
      addLog('worker', s, 'success')
    } else {
      state.workerStatus.totalTasksDone++
      broadcast('task-done', { elapsed: s.match(/([\d.]+)ms/)?.[1] || '?' })
      addLog('worker', s, 'success')
    }
    return
  }

  if (s.includes('[~] Left')) {
    state.workerStatus.searching = true
    state.workerStatus.currentRequester = null
    addLog('worker', s, 'warning')
    broadcast('worker-left-requester', {})
    return
  }

  if (s.includes('Found') && s.includes('requester')) {
    addLog('worker', s, 'info')
    broadcast('requester-found', { msg: s })
    return
  }

  if (s.includes('[!]')) {
    addLog('worker', s, 'error')
    return
  }

  if (s.includes('Searching')) {
    state.workerStatus.searching = true
    state.workerStatus.currentRequester = null
    addLog('worker', s, 'info')
    return
  }

  if (s.startsWith('[') || s.includes('Worker') || s.includes('Listening')) {
    addLog('worker', s, 'info')
  }
}

// ── Process spawning ──
function startRequester (opts = {}) {
  if (requesterProc) return { error: 'Requester already running' }

  const env = { ...process.env }
  if (opts.bootstrapNode) env.BOOTSTRAP = opts.bootstrapNode

  state.requesterLaunched = true
  state.requesterId = null
  state.workers = []
  state.pendingTasks = 0
  state.resultsReceived = 0
  state.tasks.clear()
  state.jobs.clear()

  requesterProc = spawn('node', ['request-compute.js'], {
    cwd: __dirname,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  let buf = ''
  requesterProc.stdout.on('data', chunk => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) parseRequesterLine(line)
  })

  requesterProc.stderr.on('data', chunk => {
    const s = chunk.toString().trim()
    if (s) addLog('requester', s, 'error')
  })

  requesterProc.on('close', code => {
    flushResultBuf()
    requesterProc = null
    state.requesterLaunched = false
    broadcast('requester-stopped', { code })
    addLog('requester', `Process exited (code ${code})`, 'warning')
  })

  addLog('requester', 'Starting requester...', 'info')
  return { ok: true }
}

function stopRequester () {
  if (!requesterProc) return { error: 'Not running' }
  requesterProc.kill('SIGINT')
  const proc = requesterProc
  setTimeout(() => {
    if (proc && !proc.killed) {
      try { proc.kill('SIGKILL') } catch {}
    }
  }, 5000)
  return { ok: true }
}

function startWorker (opts = {}) {
  if (workerProc) return { error: 'Worker already running' }

  const env = { ...process.env }
  if (opts.threads) env.POOL_SIZE = String(opts.threads)
  if (opts.allowShell) env.ALLOW_SHELL = '1'
  if (opts.bootstrapNode) env.BOOTSTRAP = opts.bootstrapNode

  state.workerLaunched = true
  state.workerStatus = { searching: true, currentRequester: null, totalTasksDone: 0 }

  workerProc = spawn('node', ['offer-compute.js'], {
    cwd: __dirname,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  let buf = ''
  workerProc.stdout.on('data', chunk => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) parseWorkerLine(line)
  })

  workerProc.stderr.on('data', chunk => {
    const s = chunk.toString().trim()
    if (s) addLog('worker', s, 'error')
  })

  workerProc.on('close', code => {
    workerProc = null
    state.workerLaunched = false
    broadcast('worker-stopped', { code })
    addLog('worker', `Process exited (code ${code})`, 'warning')
  })

  addLog('worker', `Starting worker (threads: ${opts.threads || 'auto'}, shell: ${opts.allowShell ? 'yes' : 'no'})...`, 'info')
  return { ok: true }
}

function stopWorker () {
  if (!workerProc) return { error: 'Not running' }
  workerProc.kill('SIGINT')
  const proc = workerProc
  setTimeout(() => {
    if (proc && !proc.killed) {
      try { proc.kill('SIGKILL') } catch {}
    }
  }, 5000)
  return { ok: true }
}

function sendToRequester (text) {
  if (!requesterProc) return { error: 'Requester not running' }
  requesterProc.stdin.write(text + '\n')
  return { ok: true }
}

// ── HTTP server ──
function readBody (req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      try { resolve(JSON.parse(body)) } catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

function readRawBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = url.pathname

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // SSE endpoint
  if (pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })
    res.write(`data: ${JSON.stringify({ type: 'connected', payload: { state: getPublicState() } })}\n\n`)
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  // API endpoints
  if (pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(getPublicState()))
    return
  }

  if (pathname === '/api/start-requester' && req.method === 'POST') {
    const body = await readBody(req)
    const result = startRequester(body)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
    return
  }

  if (pathname === '/api/stop-requester' && req.method === 'POST') {
    const result = stopRequester()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
    return
  }

  if (pathname === '/api/start-worker' && req.method === 'POST') {
    const body = await readBody(req)
    const result = startWorker(body)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
    return
  }

  if (pathname === '/api/stop-worker' && req.method === 'POST') {
    const result = stopWorker()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
    return
  }

  if (pathname === '/api/command' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body.command) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing command' }))
      return
    }
    const result = sendToRequester(body.command)
    addLog('requester', `> ${body.command}`, 'accent')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
    return
  }

  // Upload a file (data or script)
  if (pathname === '/api/upload' && req.method === 'POST') {
    const fileName = decodeURIComponent(url.searchParams.get('name') || '')
    const fileType = url.searchParams.get('type') || 'data'
    if (!fileName) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing name param' }))
      return
    }
    const safeName = path.basename(fileName)
    const raw = await readRawBody(req)

    if (fileType === 'script') {
      const dest = path.join(JOBS_DIR, safeName)
      fs.writeFileSync(dest, raw)
      addLog('requester', `Script saved: jobs/${safeName}`, 'success')
      broadcast('file-saved', { name: safeName, type: 'script', size: raw.length })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, path: `jobs/${safeName}` }))
    } else {
      const dest = path.join(UPLOAD_DIR, safeName)
      fs.writeFileSync(dest, raw)
      if (requesterProc) {
        sendToRequester(`upload ${dest} /data/${safeName}`)
        addLog('requester', `Uploading ${safeName} to shared drive...`, 'accent')
      }
      broadcast('file-saved', { name: safeName, type: 'data', size: raw.length })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, path: dest }))
    }
    return
  }

  // List uploaded files
  if (pathname === '/api/files' && req.method === 'GET') {
    const dataFiles = fs.existsSync(UPLOAD_DIR)
      ? fs.readdirSync(UPLOAD_DIR).map(name => {
          const stat = fs.statSync(path.join(UPLOAD_DIR, name))
          return { name, type: 'data', size: stat.size }
        })
      : []
    const scriptFiles = fs.existsSync(JOBS_DIR)
      ? fs.readdirSync(JOBS_DIR).filter(f => f.endsWith('.js')).map(name => {
          const stat = fs.statSync(path.join(JOBS_DIR, name))
          return { name, type: 'script', size: stat.size }
        })
      : []
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: dataFiles, scripts: scriptFiles }))
    return
  }

  // Delete an uploaded file
  if (pathname === '/api/delete-file' && req.method === 'POST') {
    const body = await readBody(req)
    const safeName = path.basename(body.name || '')
    if (!safeName) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing name' }))
      return
    }
    if (body.type === 'script') {
      const target = path.join(JOBS_DIR, safeName)
      try { fs.unlinkSync(target) } catch {}
      addLog('requester', `Script deleted: ${safeName}`, 'warning')
    } else {
      const target = path.join(UPLOAD_DIR, safeName)
      try { fs.unlinkSync(target) } catch {}
      addLog('requester', `Data file deleted: ${safeName}`, 'warning')
    }
    broadcast('file-deleted', { name: safeName, type: body.type })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // Run a job script
  if (pathname === '/api/run-job' && req.method === 'POST') {
    const body = await readBody(req)
    const safeName = path.basename(body.script || '')
    const chunks = body.chunks || null
    if (!safeName) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing script name' }))
      return
    }
    if (!requesterProc) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Requester not running' }))
      return
    }
    const extraArgs = Array.isArray(body.extraArgs) ? body.extraArgs.filter(a => a !== '').join(' ') : ''
    const argStr = [chunks, extraArgs].filter(Boolean).join(' ')
    const cmd = argStr ? `job jobs/${safeName} ${argStr}` : `job jobs/${safeName}`
    sendToRequester(cmd)
    addLog('requester', `> ${cmd}`, 'accent')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, command: cmd }))
    return
  }

  // Static files
  let filePath = pathname === '/' ? '/index.html' : pathname
  const fullPath = path.join(WEB_DIR, filePath)
  const normalizedPath = path.resolve(fullPath)
  if (!normalizedPath.startsWith(WEB_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return
  }

  try {
    const data = fs.readFileSync(normalizedPath)
    const ext = path.extname(normalizedPath)
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
})

function getPublicState () {
  return {
    requesterLaunched: state.requesterLaunched,
    workerLaunched: state.workerLaunched,
    requesterId: state.requesterId,
    workers: state.workers,
    pendingTasks: state.pendingTasks,
    resultsReceived: state.resultsReceived,
    reputation: state.reputation,
    workerStatus: state.workerStatus,
    workerCaps: state.workerCaps,
    tasks: [...state.tasks.values()],
    jobs: Object.fromEntries(state.jobs),
    log: state.log.slice(-100)
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PeerCompute UI: http://localhost:${PORT}`)
})

process.on('SIGINT', () => {
  if (requesterProc) requesterProc.kill('SIGINT')
  if (workerProc) workerProc.kill('SIGINT')
  setTimeout(() => process.exit(), 1000)
})
