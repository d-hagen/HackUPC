'use strict'

// ── IPC via Pear's internal pipe (no HTTP) ─────────────────────
//
//  How this works:
//  ┌─────────────────────────────────────────────────────────────┐
//  │  Renderer (this file, app.js)  ←─── Electron/Pear ────→  Main process (index.js)  │
//  │                                                             │
//  │  send(type, payload)           ──JSON line──►  handleCmd()  │
//  │  handleMsg(msg)               ◄──JSON line──   broadcast()  │
//  └─────────────────────────────────────────────────────────────┘
//
//  Both sides communicate over a single duplex pipe (pear-pipe / fd-3).
//  Every message is a JSON object on one line: {"type":"...","payload":{...}}\n
//
//  Renderer → Main:  send('submit-task', { code: '...' })
//  Main → Renderer:  index.js calls broadcast('task-posted', { taskId, preview })
//                    which calls send() on the main side, which arrives here as
//                    a 'data' event and is routed to handleMsg()

const pipe = Pear[Pear.constructor.IPC].pipe()

// ── Debug logger ───────────────────────────────────────────────
//  Writes to both:
//    • DevTools console  (always visible in Cmd+Option+I)
//    • The on-screen log panels (req-log-list / wkr-log-list)
//
//  console.log styles:  %c prefix applies CSS in DevTools
const CON = {
  pipe:  'color:#06b6d4;font-weight:bold',   // cyan  — IPC traffic
  event: 'color:#22c55e;font-weight:bold',   // green — events from backend
  cmd:   'color:#7c3aed;font-weight:bold',   // purple — commands to backend
  warn:  'color:#eab308;font-weight:bold',
  error: 'color:#ef4444;font-weight:bold',
  info:  'color:#94a3b8',
}

function dbg (style, label, ...args) {
  console.log(`%c${label}`, style, ...args)
}

// ── Pipe receive ───────────────────────────────────────────────
let _pipeBuf = ''
pipe.on('data', chunk => {
  _pipeBuf += chunk.toString()
  const lines = _pipeBuf.split('\n')
  _pipeBuf = lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      // skip noisy status polls from console (still shown in UI log)
      if (!msg.type.endsWith('-status')) {
        dbg(CON.event, `◄ event  ${msg.type}`, msg.payload)
      }
      handleMsg(msg)
    } catch (e) {
      dbg(CON.error, '◄ pipe parse error', e.message, line)
    }
  }
})

pipe.on('error', err => dbg(CON.error, '◄ pipe error', err.message))
pipe.on('close', () => dbg(CON.warn, '◄ pipe closed'))

dbg(CON.pipe, '★ app.js loaded — pipe open, waiting for backend...')

// ── Pipe send ──────────────────────────────────────────────────
function send (type, payload = {}) {
  if (type !== 'get-status') dbg(CON.cmd, `► cmd    ${type}`, payload)
  pipe.write(JSON.stringify({ type, payload }) + '\n')
}

// ── State ──────────────────────────────────────────────────────
const state = {
  workers: new Map(),
  tasks: new Map(),
  jobs: new Map(),
  requesterLaunched: false,
  workerLaunched: false,
  mandelbrotActive: false,
  mandelbrotJobId: null,
  mandelbrotDone: 0,
  mandelbrotTotal: 0,
  mandelbrotWorkers: new Set(),
  mandelbrotStart: null,
  mandelbrotCtx: null,
  mandelbrotConfig: null,
}

// ── DOM helpers ────────────────────────────────────────────────
const $ = id => document.getElementById(id)

function escHtml (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function showToast (msg, type = '') {
  const toast = $('toast')
  toast.textContent = msg
  toast.className = `show ${type}`
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => { toast.className = '' }, 3000)
}

// level → console style mapping
const LEVEL_CON = {
  info:    CON.info,
  success: CON.event,
  error:   CON.error,
  warning: CON.warn,
  accent:  CON.pipe,
}

function log (listId, msg, level = 'info') {
  // 1. DevTools console
  console.log(`%c[${listId === 'req-log-list' ? 'req' : 'wkr'}] ${msg}`, LEVEL_CON[level] || CON.info)

  // 2. On-screen log panel
  const list = $(listId)
  if (!list) return
  const item = document.createElement('div')
  item.className = `log-item ${level}`
  const ts = new Date().toTimeString().slice(0, 8)
  item.innerHTML = `<span class="log-ts">${ts}</span>${escHtml(msg)}`
  list.appendChild(item)
  list.scrollTop = list.scrollHeight
}

const reqLog  = msg => log('req-log-list', msg, 'info')
const reqLogS = msg => log('req-log-list', msg, 'success')
const reqLogE = msg => log('req-log-list', msg, 'error')
const reqLogA = msg => log('req-log-list', msg, 'accent')
const reqLogW = msg => log('req-log-list', msg, 'warning')
const wkrLog  = msg => log('wkr-log-list', msg, 'info')
const wkrLogS = msg => log('wkr-log-list', msg, 'success')
const wkrLogE = msg => log('wkr-log-list', msg, 'error')
const wkrLogA = msg => log('wkr-log-list', msg, 'accent')
const wkrLogW = msg => log('wkr-log-list', msg, 'warning')

// ── Mode tabs ─────────────────────────────────────────────────
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    const mode = tab.dataset.mode
    $('view-requester').style.display = mode === 'requester' ? '' : 'none'
    $('view-worker').style.display = mode === 'worker' ? '' : 'none'
  })
})

// ── Content tabs (generic handler) ────────────────────────────
function initTabs (containerSelector) {
  document.querySelectorAll(`${containerSelector} .ctab`).forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll(`${containerSelector} .ctab`).forEach(t => t.classList.remove('active'))
      const tabId = `tab-${tab.dataset.tab}`
      // deactivate all panes that share this tab bar
      const allPanes = document.querySelectorAll(`${containerSelector} ~ .view-content .tab-pane`)
      allPanes.forEach(p => p.classList.remove('active'))
      tab.classList.add('active')
      const pane = $(tabId)
      if (pane) pane.classList.add('active')
    })
  })
}

// Tabs are inside .view-content — use parent .mode-view for scoping
document.querySelectorAll('.content-tabs .ctab').forEach(tab => {
  tab.addEventListener('click', () => {
    const bar = tab.closest('.content-tabs')
    const view = tab.closest('.mode-view')
    bar.querySelectorAll('.ctab').forEach(t => t.classList.remove('active'))
    view.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'))
    tab.classList.add('active')
    const pane = $(`tab-${tab.dataset.tab}`)
    if (pane) pane.classList.add('active')
  })
})

// ── Submit type sub-tabs ───────────────────────────────────────
document.querySelectorAll('.stype-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.stype-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    $('submit-code-mode').style.display = btn.dataset.stype === 'code' ? '' : 'none'
    $('submit-job-mode').style.display = btn.dataset.stype === 'job' ? '' : 'none'
    $('submit-shell-mode').style.display = btn.dataset.stype === 'shell' ? '' : 'none'
  })
})

// ── Task queue ────────────────────────────────────────────────
function renderTask (task) {
  $('task-empty').style.display = 'none'
  const wrap = $('task-list-wrap')
  let el = $(`task-${task.id}`)
  if (!el) {
    el = document.createElement('div')
    el.className = 'task-item'
    el.id = `task-${task.id}`
    wrap.insertBefore(el, wrap.firstChild)
  }
  const badge = task.status === 'pending' ? 'badge-pending'
    : task.status === 'running' ? 'badge-running'
    : task.status === 'error' ? 'badge-error' : 'badge-done'
  const label = task.status === 'pending' ? 'Pending'
    : task.status === 'running' ? 'Running'
    : task.status === 'error' ? 'Error' : 'Done'
  let html = `
    <span class="task-badge ${badge}">${label}</span>
    <span class="task-preview">${escHtml(task.preview || task.id.slice(0, 16))}</span>
    <span class="task-by">${escHtml(task.by ? task.by.slice(0, 10) : '')}</span>
    <span class="task-elapsed">${task.elapsed ? task.elapsed + 'ms' : ''}</span>
  `
  if (task.jobId && task.totalChunks > 1) {
    const job = state.jobs.get(task.jobId)
    const pct = task.totalChunks > 0 ? ((job ? job.done : 0) / task.totalChunks * 100).toFixed(0) : 0
    html += `<div class="job-progress"><div class="job-progress-fill" style="width:${pct}%"></div></div>`
  }
  el.innerHTML = html
}

// ── Worker list ───────────────────────────────────────────────
function renderWorkers () {
  const list = $('worker-list')
  if (state.workers.size === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:12px 0"><div class="es-sub">No workers yet</div></div>'
    return
  }
  list.innerHTML = ''
  for (const [, w] of state.workers) {
    const div = document.createElement('div')
    div.className = 'worker-item'
    div.innerHTML = `<div class="wdot"></div><span class="wid">${escHtml(w.id)}</span>`
    list.appendChild(div)
  }
}

// ── Peer graph ────────────────────────────────────────────────
function renderGraph () {
  const svg = $('peer-graph')
  const W = 232, H = 120, cx = W / 2, cy = H / 2
  const workers = [...state.workers.values()]
  const r = Math.min(46, 14 + workers.length * 8)
  let out = ''
  workers.forEach((w, i) => {
    const angle = (i / Math.max(workers.length, 1)) * Math.PI * 2 - Math.PI / 2
    const wx = (cx + r * Math.cos(angle)).toFixed(1)
    const wy = (cy + r * Math.sin(angle)).toFixed(1)
    out += `<line x1="${cx}" y1="${cy}" x2="${wx}" y2="${wy}" stroke="#2a2a35" stroke-width="1.5"/>`
    out += `<circle cx="${wx}" cy="${wy}" r="5" fill="#22c55e" opacity="0.9"/>`
    out += `<text x="${wx}" y="${(+wy + 14).toFixed(1)}" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="monospace">${escHtml(w.id.slice(0, 8))}</text>`
  })
  const cc = state.requesterLaunched ? '#7c3aed' : '#475569'
  out += `<circle cx="${cx}" cy="${cy}" r="8" fill="${cc}"/>`
  out += `<text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="monospace">you</text>`
  svg.innerHTML = out
}

// ── Mandelbrot ────────────────────────────────────────────────
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
  $('mand-total').textContent = state.mandelbrotTotal
}

function paintMandelbrotChunk (rows, startRow, maxIter) {
  const ctx = state.mandelbrotCtx
  if (!ctx) return
  rows.forEach((row, ry) => {
    row.forEach((n, x) => {
      const t = n >= maxIter ? 0 : n / maxIter
      const r = Math.floor(9 * (1 - t) * t * t * t * 255)
      const g = Math.floor(15 * (1 - t) * (1 - t) * t * t * 255)
      const b = Math.floor(8.5 * (1 - t) * (1 - t) * (1 - t) * t * 255)
      ctx.fillStyle = n >= maxIter ? '#0d0d0f' : `rgb(${r},${g},${b})`
      ctx.fillRect(x, startRow + ry, 1, 1)
    })
  })
}

// ── Message handler ───────────────────────────────────────────
function handleMsg (msg) {
  const { type, payload } = msg
  if (!payload) return

  const netDot = $('net-dot')
  const netLabel = $('net-label')

  switch (type) {
    case 'connected':
      netDot.className = 'dot searching'
      netLabel.textContent = 'Ready'
      setInterval(() => send('get-status'), 3000)
      break

    case 'requester-ready':
      state.requesterLaunched = true
      netDot.className = 'dot online'
      netLabel.textContent = 'Online'
      $('req-stats-section').style.display = ''
      $('req-graph-section').style.display = ''
      $('req-workers-section').style.display = ''
      $('btn-launch-requester').style.display = 'none'
      $('btn-stop-requester').style.display = ''
      reqLogS(`Requester ready — ${payload.requesterId}`)
      renderGraph()
      break

    case 'worker-ready':
      state.workerLaunched = true
      $('wkr-self-section').style.display = ''
      $('btn-launch-worker').style.display = 'none'
      $('btn-stop-worker').style.display = ''
      wkrLogS(`Worker ready — ${payload.workerId}`)
      break

    case 'worker-joined':
      state.workers.set(payload.workerId, { id: payload.workerId, ts: Date.now() })
      renderWorkers()
      renderGraph()
      reqLogS(`Worker joined: ${payload.workerId}`)
      showToast(`Worker joined: ${payload.workerId.slice(0, 16)}`, 'success')
      break

    case 'task-posted':
      state.tasks.set(payload.taskId, { id: payload.taskId, status: 'pending', preview: payload.preview })
      renderTask(state.tasks.get(payload.taskId))
      reqLogA(`Task posted: ${payload.preview}`)
      break

    case 'job-posted': {
      state.jobs.set(payload.jobId, { done: 0, totalChunks: payload.totalChunks, fileName: payload.fileName })
      reqLogA(`Job posted: ${payload.fileName} (${payload.totalChunks} chunks)`)
      if (payload.fileName && payload.fileName.toLowerCase().includes('mandelbrot')) {
        state.mandelbrotActive = true
        state.mandelbrotJobId = payload.jobId
        state.mandelbrotTotal = payload.totalChunks
        state.mandelbrotDone = 0
        state.mandelbrotStart = Date.now()
        state.mandelbrotWorkers.clear()
        $('mand-done').textContent = '0'
        $('mand-total').textContent = payload.totalChunks
        $('mand-workers').textContent = '0'
        document.querySelector('.ctab[data-tab="req-mandelbrot"]').click()
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
      if (payload.error) reqLogE(`Error from ${payload.by}: ${payload.error}`)
      else reqLogS(`Result from ${payload.by} (${payload.elapsed}ms): ${JSON.stringify(payload.output).slice(0, 100)}`)
      break
    }

    case 'chunk-done': {
      const job = state.jobs.get(payload.jobId)
      if (job) { job.done++; state.jobs.set(payload.jobId, job) }
      if (state.mandelbrotActive && payload.jobId === state.mandelbrotJobId) {
        state.mandelbrotDone++
        state.mandelbrotWorkers.add(payload.by)
        $('mand-done').textContent = state.mandelbrotDone
        $('mand-workers').textContent = state.mandelbrotWorkers.size
        $('mand-elapsed').textContent = `${Date.now() - state.mandelbrotStart}ms`
        if (payload.output && payload.output.rows && state.mandelbrotConfig) {
          if (!state.mandelbrotCtx) initMandelbrotCanvas(state.mandelbrotConfig)
          paintMandelbrotChunk(payload.output.rows, payload.output.startRow, state.mandelbrotConfig.maxIter || 200)
        }
      }
      reqLogA(`Chunk ${payload.chunkIndex + 1}/${payload.totalChunks} done by ${payload.by} (${payload.elapsed}ms)`)
      break
    }

    case 'job-complete': {
      const job = state.jobs.get(payload.jobId)
      if (job) reqLog(`Job complete: ${job.fileName}`)
      if (state.mandelbrotActive && payload.jobId === state.mandelbrotJobId) {
        state.mandelbrotActive = false
        showToast('Mandelbrot complete!', 'success')
      }
      break
    }

    case 'requester-status':
      $('stat-workers').textContent = payload.workers?.length ?? 0
      $('stat-pending').textContent = payload.pendingTasks ?? 0
      $('stat-results').textContent = payload.resultsReceived ?? 0
      {
        const score = payload.reputation?.score ?? 0
        const el = $('stat-rep')
        el.textContent = score > 0 ? `+${score}` : score
        el.style.color = score > 0 ? 'var(--green)' : score < 0 ? 'var(--red)' : 'var(--text)'
      }
      break

    case 'worker-status':
      $('ws-status').textContent = payload.searching ? 'Searching…' : payload.currentRequester ? 'Computing' : 'Idle'
      $('ws-requester').textContent = payload.currentRequester ? payload.currentRequester.slice(0, 14) : '—'
      $('ws-tasks').textContent = payload.totalTasksDone ?? 0
      {
        const wscore = payload.reputation?.score ?? 0
        $('ws-rep').textContent = wscore > 0 ? `+${wscore}` : wscore
      }
      break

    case 'worker-authorized':
      wkrLogS(`Join accepted by requester: ${payload.requesterId}`)
      break

    case 'worker-joined-requester':
      $('net-dot').className = 'dot online'
      $('net-label').textContent = 'Computing'
      wkrLogS(`Joined requester: ${payload.requesterId}`)
      break

    case 'worker-left-requester':
      $('net-dot').className = 'dot searching'
      $('net-label').textContent = 'Searching…'
      wkrLogW(`Left requester ${payload.requesterId} — ${payload.tasksDone} task(s) done this session`)
      break

    case 'requester-found': {
      const rep = payload.reputation
      const score = rep ? (rep.score > 0 ? `+${rep.score}` : rep.score) : '?'
      wkrLog(`Requester found: ${payload.requesterId} — ${payload.pendingTasks} pending task(s), reputation ${score}`)
      break
    }

    case 'task-start':
      wkrLogA(`Task started: "${payload.preview}"${payload.jobId ? ` (job chunk ${(payload.chunkIndex ?? 0) + 1})` : ''}`)
      break

    case 'task-done':
      wkrLogS(`Task done in ${payload.elapsed}ms${payload.jobId ? ` (job chunk ${(payload.chunkIndex ?? 0) + 1})` : ''}`)
      break

    case 'task-error':
      wkrLogE(`Task error: ${payload.error}`)
      break

    case 'file-uploaded':
      reqLogS(`Uploaded: ${payload.remotePath}`)
      showToast(`Uploaded ${payload.remotePath}`, 'success')
      break

    case 'stop-blocked': {
      _pendingStopRole = payload.role
      $('stop-modal-body').textContent =
        `You still have ${payload.pending} task${payload.pending > 1 ? 's' : ''} pending. ` +
        `Stopping now will terminate them before results are returned.`
      $('stop-modal').style.display = 'flex'
      break
    }

    case 'requester-stopped':
      state.requesterLaunched = false
      $('btn-launch-requester').textContent = '▶ Connect to Network'
      $('btn-launch-requester').disabled = false
      $('btn-stop-requester').style.display = 'none'
      $('req-stats-section').style.display = 'none'
      $('req-graph-section').style.display = 'none'
      $('req-workers-section').style.display = 'none'
      $('net-dot').className = 'dot'
      $('net-label').textContent = 'Offline'
      state.workers.clear()
      reqLogW('Requester stopped.')
      break

    case 'worker-stopped':
      state.workerLaunched = false
      $('btn-launch-worker').textContent = '▶ Launch Worker'
      $('btn-launch-worker').disabled = false
      $('btn-stop-worker').style.display = 'none'
      $('wkr-self-section').style.display = 'none'
      $('wkr-hw').disabled = false
      $('wkr-threads').disabled = false
      $('wkr-allow-shell').disabled = false
      wkrLogW('Worker stopped.')
      break

    case 'error':
      reqLogE(`Error: ${payload.message}`)
      wkrLogE(`Error: ${payload.message}`)
      showToast(payload.message, 'error')
      break
  }
}

// ── Launch / Stop: Requester ──────────────────────────────────
$('btn-launch-requester').addEventListener('click', () => {
  if (state.requesterLaunched) return
  send('start-requester', {})
  $('btn-launch-requester').textContent = 'Connecting…'
  $('btn-launch-requester').disabled = true
  reqLog('Connecting to network…')
})

$('btn-stop-requester').addEventListener('click', () => {
  send('stop-requester', {})
})

// ── Launch / Stop: Worker ─────────────────────────────────────
$('btn-launch-worker').addEventListener('click', () => {
  if (state.workerLaunched) return
  const hw = $('wkr-hw').value
  const threads = parseInt($('wkr-threads').value) || 4
  const allowShell = $('wkr-allow-shell').checked
  send('start-worker', { hw, threads, allowShell })
  $('btn-launch-worker').textContent = 'Launching…'
  $('btn-launch-worker').disabled = true
  $('wkr-hw').disabled = true
  $('wkr-threads').disabled = true
  $('wkr-allow-shell').disabled = true
  wkrLog(`Launching worker — ${hw}, ${threads} threads${allowShell ? ', shell enabled' : ''}`)
})

$('btn-stop-worker').addEventListener('click', () => {
  send('stop-worker', {})
})

// ── Stop confirmation modal ───────────────────────────────────
let _pendingStopRole = null

$('stop-modal-cancel').addEventListener('click', () => {
  $('stop-modal').style.display = 'none'
  _pendingStopRole = null
})

$('stop-modal-confirm').addEventListener('click', () => {
  $('stop-modal').style.display = 'none'
  if (_pendingStopRole === 'requester') send('stop-requester', { force: true })
  _pendingStopRole = null
})

// ── Submit: Code ──────────────────────────────────────────────
$('btn-run-code').addEventListener('click', () => {
  const code = $('code-input').value.trim()
  if (!code) { showToast('Enter some code first', 'error'); return }
  const hw       = $('code-hw').value
  const threads  = parseInt($('code-threads').value) || 1
  const timeout  = (parseInt($('code-timeout').value) || 60) * 1000
  send('submit-task', { code, requirements: { hw, threads }, timeout })
  showToast('Task submitted')
  document.querySelector('.ctab[data-tab="req-tasks"]').click()
})

$('code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('btn-run-code').click()
})

// ── Submit: Shell ─────────────────────────────────────────────
$('btn-run-shell').addEventListener('click', () => {
  const cmd = $('shell-input').value.trim()
  if (!cmd) { showToast('Enter a command', 'error'); return }
  const hw      = $('shell-hw').value
  const timeout = (parseInt($('shell-timeout').value) || 60) * 1000
  send('submit-shell', { cmd, requirements: { hw }, timeout })
  showToast('Shell task submitted')
  document.querySelector('.ctab[data-tab="req-tasks"]').click()
})

$('shell-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-run-shell').click()
})

// ── Submit: Job file ──────────────────────────────────────────
const dropZone = $('drop-zone')
const fileInput = $('file-input')
let selectedJobPath = null

dropZone.addEventListener('click', () => fileInput.click())
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over') })
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
dropZone.addEventListener('drop', e => {
  e.preventDefault()
  dropZone.classList.remove('drag-over')
  const file = e.dataTransfer.files[0]
  if (file && file.name.endsWith('.js')) selectJobFile(file)
  else showToast('Please drop a .js file', 'error')
})
fileInput.addEventListener('change', e => { if (e.target.files[0]) selectJobFile(e.target.files[0]) })

function selectJobFile (file) {
  selectedJobPath = file.path || file.name
  $('drop-file-name').textContent = file.name
  $('drop-file-name').style.display = 'block'
  $('btn-run-job').disabled = false
  dropZone.querySelector('.drop-title').textContent = file.name
  dropZone.querySelector('.drop-sub').textContent = 'Click to change file'
  if (file.name.toLowerCase().includes('mandelbrot')) {
    state.mandelbrotConfig = { width: 128, height: 128, maxIter: 200 }
  }
}

$('btn-run-job').addEventListener('click', () => {
  if (!selectedJobPath) { showToast('Select a job file first', 'error'); return }
  const n       = parseInt($('job-workers-input').value) || null
  const hw      = $('job-hw').value
  const threads = parseInt($('job-threads').value) || 1
  send('submit-job', { filePath: selectedJobPath, n, requirements: { hw, threads } })
  showToast('Job submitted')
  document.querySelector('.ctab[data-tab="req-tasks"]').click()
})

// ── Upload: Data file ─────────────────────────────────────────
setupDropZone('drop-data', 'file-data-input', 'drop-data-name', 'btn-upload-data', null, (file, path) => {
  const remotePath = $('data-remote-path').value.trim() || `/data/${file.name}`
  send('upload-file', { localPath: path, remotePath })
  showToast('Uploading data…')
})

// ── Upload: Script file ───────────────────────────────────────
setupDropZone('drop-script', 'file-script-input', 'drop-script-name', 'btn-upload-script', '.js', (file, path) => {
  const remotePath = $('script-remote-path').value.trim() || `/scripts/${file.name}`
  send('upload-file', { localPath: path, remotePath })
  showToast('Uploading script…')
})

function setupDropZone (zoneId, inputId, nameId, btnId, ext, onUpload) {
  const zone = $(zoneId)
  const input = $(inputId)
  const btn = $(btnId)
  let selectedPath = null
  let selectedFile = null

  zone.addEventListener('click', () => input.click())
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over') })
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
  zone.addEventListener('drop', e => {
    e.preventDefault()
    zone.classList.remove('drag-over')
    const file = e.dataTransfer.files[0]
    if (file && (!ext || file.name.endsWith(ext))) select(file)
    else showToast(ext ? `Please drop a ${ext} file` : 'Please drop a file', 'error')
  })
  input.addEventListener('change', e => { if (e.target.files[0]) select(e.target.files[0]) })

  function select (file) {
    selectedPath = file.path || file.name
    selectedFile = file
    $(nameId).textContent = file.name
    $(nameId).style.display = 'block'
    zone.querySelector('.drop-title').textContent = file.name
    zone.querySelector('.drop-sub').textContent = 'Click to change'
    btn.disabled = false
  }

  btn.addEventListener('click', () => {
    if (!selectedPath) return
    onUpload(selectedFile, selectedPath)
  })
}

// ── Mandelbrot ────────────────────────────────────────────────
$('btn-start-mandelbrot').addEventListener('click', () => {
  state.mandelbrotConfig = { width: 128, height: 128, maxIter: 200 }
  state.mandelbrotActive = true
  state.mandelbrotStart = Date.now()
  state.mandelbrotDone = 0
  state.mandelbrotWorkers.clear()
  initMandelbrotCanvas(state.mandelbrotConfig)
  send('submit-job', { filePath: './jobs/mandelbrot-job.js', n: null })
  showToast('Mandelbrot job submitted')
})
