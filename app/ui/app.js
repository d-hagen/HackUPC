'use strict'
const { pearPipe } = require('pear-pipe')

// ── IPC setup ──────────────────────────────────────────────────
const pipe = pearPipe()

function send (type, payload = {}) {
  if (!pipe) return
  pipe.write(JSON.stringify({ type, payload }))
}

// ── State ──────────────────────────────────────────────────────
const state = {
  workers: new Map(),      // workerId -> { id, ts }
  tasks: new Map(),        // taskId -> task obj
  jobs: new Map(),         // jobId -> { totalChunks, done, fileName }
  requesterReady: false,
  workerReady: false,
  workerSearching: true,
  workerCurrentRequester: null,
  workerTotalDone: 0,
  workerRep: 0,
  requesterRep: 0,
  mode: 'both',
  // Mandelbrot
  mandelbrotActive: false,
  mandelbrotJobId: null,
  mandelbrotDone: 0,
  mandelbrotTotal: 0,
  mandelbrotWorkers: new Set(),
  mandelbrotStart: null,
  mandelbrotCanvas: null,
  mandelbrotCtx: null,
  mandelbrotConfig: null,
}

// ── DOM refs ──────────────────────────────────────────────────
const $ = id => document.getElementById(id)
const netDot = $('net-dot')
const netLabel = $('net-label')
const statWorkers = $('stat-workers')
const statPending = $('stat-pending')
const statResults = $('stat-results')
const statRep = $('stat-rep')
const workerList = $('worker-list')
const wsStatus = $('ws-status')
const wsRequester = $('ws-requester')
const wsTasks = $('ws-tasks')
const wsRep = $('ws-rep')
const taskListWrap = $('task-list-wrap')
const taskEmpty = $('task-empty')
const logList = $('log-list')
const toast = $('toast')
const peerGraph = $('peer-graph')

// ── Logging ────────────────────────────────────────────────────
function log (msg, level = 'info') {
  const item = document.createElement('div')
  item.className = `log-item ${level}`
  const ts = new Date().toTimeString().slice(0, 8)
  item.innerHTML = `<span class="log-ts">${ts}</span>${escHtml(msg)}`
  logList.appendChild(item)
  logList.scrollTop = logList.scrollHeight
}

function escHtml (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function showToast (msg, type = '') {
  toast.textContent = msg
  toast.className = `show ${type}`
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => { toast.className = '' }, 3000)
}

// ── Tabs ──────────────────────────────────────────────────────
document.querySelectorAll('.ctab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.ctab').forEach(t => t.classList.remove('active'))
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'))
    tab.classList.add('active')
    $(`tab-${tab.dataset.tab}`).classList.add('active')
  })
})

// ── Mode tabs ─────────────────────────────────────────────────
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    state.mode = tab.dataset.mode
    updateModeVisibility()
  })
})

function updateModeVisibility () {
  const showRequester = state.mode === 'requester' || state.mode === 'both'
  const showWorker = state.mode === 'worker' || state.mode === 'both'
  $('requester-stats-section').style.display = showRequester ? '' : 'none'
  $('worker-stats-section').style.display = showWorker ? '' : 'none'
}

// ── Submit type tabs ──────────────────────────────────────────
document.querySelectorAll('.stype-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.stype-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    $('submit-code-mode').style.display = btn.dataset.stype === 'code' ? '' : 'none'
    $('submit-job-mode').style.display = btn.dataset.stype === 'job' ? '' : 'none'
    $('submit-shell-mode').style.display = btn.dataset.stype === 'shell' ? '' : 'none'
  })
})

// ── Task queue rendering ──────────────────────────────────────
function renderTask (task) {
  taskEmpty.style.display = 'none'
  let el = $(`task-${task.id}`)
  if (!el) {
    el = document.createElement('div')
    el.className = 'task-item'
    el.id = `task-${task.id}`
    taskListWrap.insertBefore(el, taskListWrap.firstChild)
  }

  const badge = task.status === 'pending' ? 'badge-pending'
    : task.status === 'running' ? 'badge-running'
    : task.status === 'error' ? 'badge-error'
    : 'badge-done'

  const statusLabel = task.status === 'pending' ? 'Pending'
    : task.status === 'running' ? 'Running'
    : task.status === 'error' ? 'Error'
    : 'Done'

  const elapsed = task.elapsed ? `${task.elapsed}ms` : ''
  const byStr = task.by ? task.by.slice(0, 10) : ''

  let html = `
    <span class="task-badge ${badge}">${statusLabel}</span>
    <span class="task-preview">${escHtml(task.preview || task.id.slice(0, 16))}</span>
    <span class="task-by">${escHtml(byStr)}</span>
    <span class="task-elapsed">${elapsed}</span>
  `

  if (task.jobId && task.totalChunks > 1) {
    const job = state.jobs.get(task.jobId)
    const done = job ? job.done : 0
    const total = task.totalChunks
    const pct = total > 0 ? (done / total * 100).toFixed(0) : 0
    html += `
      <div class="job-progress">
        <div class="job-progress-fill" style="width:${pct}%"></div>
      </div>
    `
  }

  el.innerHTML = html
}

// ── Worker list rendering ─────────────────────────────────────
function renderWorkers () {
  if (state.workers.size === 0) {
    workerList.innerHTML = '<div class="empty-state" style="padding:16px 0;"><div class="es-sub">No workers yet</div></div>'
    return
  }
  workerList.innerHTML = ''
  for (const [, w] of state.workers) {
    const div = document.createElement('div')
    div.className = 'worker-item'
    div.innerHTML = `
      <div class="wdot"></div>
      <span class="wid">${escHtml(w.id)}</span>
    `
    workerList.appendChild(div)
  }
}

// ── Peer graph (SVG) ──────────────────────────────────────────
function renderGraph () {
  const W = 232, H = 120
  const cx = W / 2, cy = H / 2
  const workers = [...state.workers.values()]
  const r = Math.min(46, 14 + workers.length * 6)

  let svg = ''

  // lines from center to workers
  workers.forEach((w, i) => {
    const angle = (i / Math.max(workers.length, 1)) * Math.PI * 2 - Math.PI / 2
    const wx = cx + r * Math.cos(angle)
    const wy = cy + r * Math.sin(angle)
    svg += `<line x1="${cx}" y1="${cy}" x2="${wx.toFixed(1)}" y2="${wy.toFixed(1)}" stroke="#2a2a35" stroke-width="1.5"/>`
  })

  // worker nodes
  workers.forEach((w, i) => {
    const angle = (i / Math.max(workers.length, 1)) * Math.PI * 2 - Math.PI / 2
    const wx = cx + r * Math.cos(angle)
    const wy = cy + r * Math.sin(angle)
    svg += `<circle cx="${wx.toFixed(1)}" cy="${wy.toFixed(1)}" r="5" fill="#22c55e" opacity="0.9"/>`
    svg += `<text x="${wx.toFixed(1)}" y="${(wy + 14).toFixed(1)}" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="monospace">${escHtml(w.id.slice(0, 8))}</text>`
  })

  // center node
  const centerColor = state.requesterReady ? '#7c3aed' : '#475569'
  svg += `<circle cx="${cx}" cy="${cy}" r="8" fill="${centerColor}"/>`
  svg += `<text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="monospace">you</text>`

  peerGraph.innerHTML = svg
}

// ── Mandelbrot canvas ─────────────────────────────────────────
function initMandelbrotCanvas (config) {
  const canvas = $('mandelbrot-canvas')
  canvas.width = config.width || 128
  canvas.height = config.height || 128
  canvas.style.display = 'block'
  canvas.style.width = Math.min(512, (config.width || 128) * 3) + 'px'
  canvas.style.height = Math.min(512, (config.height || 128) * 3) + 'px'
  $('mandelbrot-placeholder').style.display = 'none'
  $('mandelbrot-info').style.display = 'flex'
  state.mandelbrotCtx = canvas.getContext('2d')
  state.mandelbrotCanvas = canvas
  $('mand-total').textContent = state.mandelbrotTotal
}

function paintMandelbrotChunk (rows, startRow, maxIter) {
  const ctx = state.mandelbrotCtx
  if (!ctx) return
  const width = state.mandelbrotCanvas.width

  rows.forEach((row, ry) => {
    const y = startRow + ry
    row.forEach((n, x) => {
      const t = n >= maxIter ? 0 : n / maxIter
      const r = Math.floor(9 * (1 - t) * t * t * t * 255)
      const g = Math.floor(15 * (1 - t) * (1 - t) * t * t * 255)
      const b = Math.floor(8.5 * (1 - t) * (1 - t) * (1 - t) * t * 255)
      ctx.fillStyle = n >= maxIter ? '#0d0d0f' : `rgb(${r},${g},${b})`
      ctx.fillRect(x, y, 1, 1)
    })
  })
}

// ── IPC message handler ───────────────────────────────────────
if (pipe) {
  pipe.on('data', (data) => {
    let msg
    try { msg = JSON.parse(Buffer.from(data).toString()) } catch { return }
    const { type, payload } = msg

    switch (type) {
      case 'requester-ready':
        state.requesterReady = true
        netDot.className = 'dot online'
        netLabel.textContent = 'Online'
        log(`Requester ready — ${payload.requesterId}`, 'success')
        renderGraph()
        break

      case 'worker-ready':
        state.workerReady = true
        log(`Worker ready — ${payload.workerId}`, 'success')
        break

      case 'worker-joined': {
        state.workers.set(payload.workerId, { id: payload.workerId, ts: Date.now() })
        renderWorkers()
        renderGraph()
        log(`Worker joined: ${payload.workerId}`, 'success')
        showToast(`Worker joined: ${payload.workerId.slice(0, 16)}`, 'success')
        break
      }

      case 'task-posted':
        state.tasks.set(payload.taskId, {
          id: payload.taskId,
          status: 'pending',
          preview: payload.preview,
          ts: Date.now()
        })
        renderTask(state.tasks.get(payload.taskId))
        log(`Task posted: ${payload.preview}`, 'accent')
        break

      case 'job-posted': {
        state.jobs.set(payload.jobId, { done: 0, totalChunks: payload.totalChunks, fileName: payload.fileName })
        log(`Job posted: ${payload.fileName} (${payload.totalChunks} chunks)`, 'accent')
        // Mandelbrot detection
        if (payload.fileName && payload.fileName.toLowerCase().includes('mandelbrot')) {
          state.mandelbrotActive = true
          state.mandelbrotJobId = payload.jobId
          state.mandelbrotTotal = payload.totalChunks
          state.mandelbrotDone = 0
          state.mandelbrotStart = Date.now()
          $('mand-done').textContent = '0'
          $('mand-total').textContent = payload.totalChunks
          $('mand-workers').textContent = '0'
          document.querySelectorAll('.ctab').forEach(t => {
            if (t.dataset.tab === 'mandelbrot') t.click()
          })
        }
        break
      }

      case 'result': {
        const t = state.tasks.get(payload.taskId) || { id: payload.taskId, preview: payload.taskId.slice(0, 16) }
        t.status = payload.error ? 'error' : 'done'
        t.elapsed = payload.elapsed
        t.by = payload.by
        state.tasks.set(payload.taskId, t)
        renderTask(t)
        if (payload.error) {
          log(`Error from ${payload.by}: ${payload.error}`, 'error')
        } else {
          const out = JSON.stringify(payload.output).slice(0, 100)
          log(`Result from ${payload.by} (${payload.elapsed}ms): ${out}`, 'success')
        }
        break
      }

      case 'chunk-done': {
        const job = state.jobs.get(payload.jobId)
        if (job) {
          job.done++
          state.jobs.set(payload.jobId, job)
        }
        // Update any task items for this job
        for (const [, t] of state.tasks) {
          if (t.jobId === payload.jobId) renderTask(t)
        }
        // Mandelbrot live rendering
        if (state.mandelbrotActive && payload.jobId === state.mandelbrotJobId) {
          state.mandelbrotDone++
          state.mandelbrotWorkers.add(payload.by)
          $('mand-done').textContent = state.mandelbrotDone
          $('mand-workers').textContent = state.mandelbrotWorkers.size
          const elapsed = Date.now() - (state.mandelbrotStart || Date.now())
          $('mand-elapsed').textContent = `${elapsed}ms`

          if (payload.output && payload.output.rows && state.mandelbrotConfig) {
            if (!state.mandelbrotCtx) initMandelbrotCanvas(state.mandelbrotConfig)
            paintMandelbrotChunk(payload.output.rows, payload.output.startRow, state.mandelbrotConfig.maxIter || 200)
          }
        }
        log(`Chunk ${payload.chunkIndex + 1}/${payload.totalChunks} done by ${payload.by} (${payload.elapsed}ms)`, 'accent')
        break
      }

      case 'job-complete': {
        const job = state.jobs.get(payload.jobId)
        if (job) log(`Job complete: ${job.fileName} — ${payload.errors} errors`, payload.errors > 0 ? 'error' : 'success')
        if (state.mandelbrotActive && payload.jobId === state.mandelbrotJobId) {
          state.mandelbrotActive = false
          showToast('Mandelbrot complete!', 'success')
        }
        break
      }

      case 'requester-status': {
        statWorkers.textContent = payload.workers?.length ?? 0
        statPending.textContent = payload.pendingTasks ?? 0
        statResults.textContent = payload.resultsReceived ?? 0
        const score = payload.reputation?.score ?? 0
        statRep.textContent = score > 0 ? `+${score}` : score
        statRep.style.color = score > 0 ? 'var(--green)' : score < 0 ? 'var(--red)' : 'var(--text)'
        break
      }

      case 'worker-status': {
        wsStatus.textContent = payload.searching ? 'Searching…' : payload.currentRequester ? 'Computing' : 'Idle'
        wsRequester.textContent = payload.currentRequester ? payload.currentRequester.slice(0, 14) : '—'
        wsTasks.textContent = payload.totalTasksDone ?? 0
        const wscore = payload.reputation?.score ?? 0
        wsRep.textContent = wscore > 0 ? `+${wscore}` : wscore
        break
      }

      case 'worker-joined-requester':
        state.workerSearching = false
        netDot.className = 'dot online'
        log(`Connected to requester: ${payload.requesterId}`, 'success')
        break

      case 'worker-left-requester':
        state.workerSearching = true
        netDot.className = 'dot searching'
        netLabel.textContent = 'Searching…'
        log(`Left requester after ${payload.tasksDone} tasks`, 'warning')
        break

      case 'requester-found':
        log(`Found requester: ${payload.requesterId} (${payload.pendingTasks} tasks)`, 'info')
        break

      case 'task-start':
        log(`[worker] Running: ${payload.preview}`, 'accent')
        break

      case 'task-done':
        log(`[worker] Done in ${payload.elapsed}ms`, 'success')
        break

      case 'task-error':
        log(`[worker] Error: ${payload.error}`, 'error')
        break

      case 'file-uploaded':
        log(`Uploaded ${payload.localPath} → ${payload.remotePath} (${payload.bytes} bytes)`, 'success')
        showToast(`Uploaded ${payload.remotePath}`, 'success')
        break

      case 'error':
        log(`Error: ${payload.message}`, 'error')
        showToast(payload.message, 'error')
        break
    }
  })
}

// ── Init ──────────────────────────────────────────────────────
function init () {
  // Kick off net status
  netDot.className = 'dot searching'
  netLabel.textContent = 'Bootstrapping…'

  // Start both cores
  send('start-requester')
  send('start-worker', { allowShell: false })

  // Poll for status every 3s
  setInterval(() => send('get-status'), 3000)

  updateModeVisibility()
  renderGraph()
}

// ── Submit handlers ───────────────────────────────────────────
$('btn-run-code').addEventListener('click', () => {
  const code = $('code-input').value.trim()
  if (!code) { showToast('Enter some code first', 'error'); return }
  send('submit-task', { code })
  showToast('Task submitted')
  // switch to task queue tab
  document.querySelector('.ctab[data-tab="tasks"]').click()
})

$('code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    $('btn-run-code').click()
  }
})

$('btn-run-shell').addEventListener('click', () => {
  const cmd = $('shell-input').value.trim()
  if (!cmd) { showToast('Enter a command first', 'error'); return }
  send('submit-shell', { cmd })
  showToast('Shell task submitted')
  document.querySelector('.ctab[data-tab="tasks"]').click()
})

$('shell-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-run-shell').click()
})

// File drag & drop
const dropZone = $('drop-zone')
const fileInput = $('file-input')
let selectedJobPath = null

dropZone.addEventListener('click', () => fileInput.click())

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropZone.classList.add('drag-over')
})

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))

dropZone.addEventListener('drop', (e) => {
  e.preventDefault()
  dropZone.classList.remove('drag-over')
  const file = e.dataTransfer.files[0]
  if (file && file.name.endsWith('.js')) {
    selectJobFile(file)
  } else {
    showToast('Please drop a .js file', 'error')
  }
})

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0]
  if (file) selectJobFile(file)
})

function selectJobFile (file) {
  selectedJobPath = file.path || file.name
  const nameEl = $('drop-file-name')
  nameEl.textContent = file.name
  nameEl.style.display = 'block'
  $('btn-run-job').disabled = false
  dropZone.querySelector('.drop-title').textContent = file.name
  dropZone.querySelector('.drop-sub').textContent = 'Click to change file'

  // If it's a mandelbrot job, set up config for live canvas
  if (file.name.toLowerCase().includes('mandelbrot')) {
    state.mandelbrotConfig = { width: 128, height: 128, maxIter: 200 }
  }
}

$('btn-run-job').addEventListener('click', () => {
  if (!selectedJobPath) { showToast('Select a job file first', 'error'); return }
  const n = parseInt($('job-workers-input').value) || null
  send('submit-job', { filePath: selectedJobPath, n })
  showToast('Job submitted')
  document.querySelector('.ctab[data-tab="tasks"]').click()
})

// Mandelbrot demo button
$('btn-start-mandelbrot').addEventListener('click', () => {
  state.mandelbrotConfig = { width: 128, height: 128, maxIter: 200 }
  state.mandelbrotActive = true
  state.mandelbrotJobId = null // will be set when job-posted arrives
  state.mandelbrotStart = Date.now()
  state.mandelbrotDone = 0
  state.mandelbrotWorkers.clear()
  initMandelbrotCanvas(state.mandelbrotConfig)
  send('submit-job', { filePath: './jobs/mandelbrot-job.js', n: null })
  showToast('Mandelbrot job submitted')
})

// ── Boot ──────────────────────────────────────────────────────
init()
