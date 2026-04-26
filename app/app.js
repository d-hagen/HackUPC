'use strict'

const pipe = Pear[Pear.constructor.IPC].pipe()

const CON = {
  pipe:  'color:#06b6d4;font-weight:bold',
  event: 'color:#22c55e;font-weight:bold',
  cmd:   'color:#7c3aed;font-weight:bold',
  warn:  'color:#eab308;font-weight:bold',
  error: 'color:#ef4444;font-weight:bold',
  info:  'color:#94a3b8',
}

function dbg (style, label, ...args) {
  console.log(`%c${label}`, style, ...args)
}

let _pipeBuf = ''
pipe.on('data', chunk => {
  _pipeBuf += chunk.toString()
  const lines = _pipeBuf.split('\n')
  _pipeBuf = lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
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
  taskFilter: 'queue',
  scheduleDataFiles: [],
  scheduleScriptPath: null,
  scheduleScriptFile: null,
  cmdHistory: [],
  cmdHistoryPos: -1,
  workerCaps: null,
  settings: {},
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

const LEVEL_CON = {
  info:    CON.info,
  success: CON.event,
  error:   CON.error,
  warning: CON.warn,
  accent:  CON.pipe,
}

function log (listId, msg, level = 'info') {
  console.log(`%c[${listId === 'req-log-list' ? 'req' : 'wkr'}] ${msg}`, LEVEL_CON[level] || CON.info)
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

// ── Content tabs ──────────────────────────────────────────────
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

// ── Log toggles ───────────────────────────────────────────────
function setupLogToggle (toggleId, closeId, terminalId) {
  const toggle = $(toggleId)
  const terminal = $(terminalId)
  const close = $(closeId)
  toggle.addEventListener('click', () => {
    const isOpen = terminal.style.display !== 'none'
    terminal.style.display = isOpen ? 'none' : ''
    toggle.classList.toggle('active', !isOpen)
  })
  close.addEventListener('click', () => {
    terminal.style.display = 'none'
    toggle.classList.remove('active')
  })
}
setupLogToggle('req-log-toggle', 'req-log-close', 'req-log-terminal')
setupLogToggle('wkr-log-toggle', 'wkr-log-close', 'wkr-log-terminal')

// ── Task queue with filter ────────────────────────────────────
document.querySelectorAll('.tq-filter').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tq-filter').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    state.taskFilter = btn.dataset.filter
    renderTaskList()
  })
})

function renderTaskList () {
  const wrap = $('task-list-wrap')
  const filter = state.taskFilter
  const tasks = [...state.tasks.values()]

  const queue   = tasks.filter(t => t.status === 'pending')
  const running = tasks.filter(t => t.status === 'running')
  const history = tasks.filter(t => t.status === 'done' || t.status === 'error')

  $('tq-count-queue').textContent   = queue.length
  $('tq-count-running').textContent = running.length
  $('tq-count-history').textContent = history.length

  const visible = filter === 'queue' ? queue : filter === 'running' ? running : history

  ;[...wrap.children].forEach(c => { if (c.id !== 'task-empty') c.remove() })

  if (visible.length === 0) {
    $('task-empty').style.display = ''
    return
  }
  $('task-empty').style.display = 'none'

  for (const task of [...visible].reverse()) {
    const el = document.createElement('div')
    el.className = 'task-item'
    el.id = `task-${task.id}`
    const badge = task.status === 'pending' ? 'badge-pending'
      : task.status === 'running' ? 'badge-running'
      : task.status === 'error' ? 'badge-error' : 'badge-done'
    const label = { pending: 'Pending', running: 'Running', error: 'Error', done: 'Done' }[task.status]
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
    wrap.appendChild(el)
  }
}

function renderTask (task) {
  state.tasks.set(task.id, task)
  renderTaskList()
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
    const runningCount = [...state.tasks.values()].filter(t => t.by === w.id && t.status === 'running').length
    out += `<line id="graph-line-${escHtml(w.id)}" x1="${cx}" y1="${cy}" x2="${wx}" y2="${wy}" stroke="#2a2a35" stroke-width="1.5"/>`
    out += `<circle cx="${wx}" cy="${wy}" r="5" fill="#22c55e" opacity="0.9"/>`
    if (runningCount > 0) {
      out += `<text x="${wx}" y="${(+wy - 8).toFixed(1)}" text-anchor="middle" fill="#06b6d4" font-size="8" font-family="monospace">${runningCount}</text>`
    }
    out += `<text x="${wx}" y="${(+wy + 14).toFixed(1)}" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="monospace">${escHtml(w.id.slice(0, 8))}</text>`
  })
  const cc = state.requesterLaunched ? '#7c3aed' : '#475569'
  out += `<circle cx="${cx}" cy="${cy}" r="8" fill="${cc}"/>`
  out += `<text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="monospace">you</text>`
  svg.innerHTML = out
}

function animateTaskDispatch (workerId) {
  const lineEl = document.getElementById(`graph-line-${workerId}`)
  if (!lineEl) return
  lineEl.classList.add('graph-arc-pulse')
  setTimeout(() => lineEl.classList.remove('graph-arc-pulse'), 1200)
}

// ── Message handler ───────────────────────────────────────────
function handleMsg (msg) {
  const { type, payload } = msg
  if (!payload) return

  switch (type) {
    case 'connected':
      $('net-dot').className = 'dot searching'
      $('net-label').textContent = 'Ready'
      send('load-settings', {})
      send('get-capabilities', {})
      break

    case 'requester-ready':
      state.requesterLaunched = true
      $('net-dot').className = 'dot online'
      $('net-label').textContent = 'Online'
      if ($('req-stats-section'))   $('req-stats-section').style.display = ''
      if ($('req-graph-section'))   $('req-graph-section').style.display = ''
      if ($('req-workers-section')) $('req-workers-section').style.display = ''
      if ($('btn-launch-requester')) { $('btn-launch-requester').style.display = 'none'; $('btn-launch-requester').textContent = '▶ Start Request'; $('btn-launch-requester').disabled = false }
      if ($('btn-stop-requester'))  $('btn-stop-requester').style.display = ''
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

    case 'task-posted': {
      const t = { id: payload.taskId, status: 'pending', preview: payload.preview }
      state.tasks.set(payload.taskId, t)
      renderTask(t)
      reqLogA(`Task posted: ${payload.preview}`)
      // animate graph dispatch if worker known
      for (const [, w] of state.workers) animateTaskDispatch(w.id)
      break
    }

    case 'job-posted':
      state.jobs.set(payload.jobId, { done: 0, totalChunks: payload.totalChunks, fileName: payload.fileName })
      reqLogA(`Job posted: ${payload.fileName} (${payload.totalChunks} chunks)`)
      break

    case 'result': {
      const t = state.tasks.get(payload.taskId) || { id: payload.taskId, preview: payload.taskId.slice(0, 16) }
      t.status = payload.error ? 'error' : 'done'
      t.elapsed = payload.elapsed
      t.by = payload.by
      state.tasks.set(payload.taskId, t)
      renderTask(t)
      if (payload.error) {
        reqLogE(`Error from ${payload.by}: ${payload.error}`)
        cliPrint(`✗ Error from ${payload.by}: ${payload.error}`, 'error')
      } else {
        const out = JSON.stringify(payload.output).slice(0, 100)
        reqLogS(`Result from ${payload.by} (${payload.elapsed}ms): ${out}`)
        cliPrint(`✓ Result (${payload.elapsed}ms): ${out}`, 'success')
      }
      break
    }

    case 'chunk-done': {
      const job = state.jobs.get(payload.jobId)
      if (job) { job.done++; state.jobs.set(payload.jobId, job) }
      reqLogA(`Chunk ${payload.chunkIndex + 1}/${payload.totalChunks} done by ${payload.by} (${payload.elapsed}ms)`)
      renderTaskList()
      break
    }

    case 'job-complete': {
      const job = state.jobs.get(payload.jobId)
      if (job) {
        reqLogS(`Job complete: ${job.fileName}`)
        cliPrint(`✓ Job complete: ${job.fileName}`, 'success')
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
      if (payload.poolSize !== undefined) {
        $('ws-pool-util').textContent = `${payload.poolBusy ?? 0}/${payload.poolSize}`
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

    case 'task-start': {
      const rt = state.tasks.get(payload.taskId)
      if (rt) { rt.status = 'running'; renderTask(rt) }
      wkrLogA(`Task started: "${payload.preview}"${payload.jobId ? ` (job chunk ${(payload.chunkIndex ?? 0) + 1})` : ''}`)
      break
    }

    case 'task-done': {
      const td = state.tasks.get(payload.taskId)
      if (td && td.status !== 'done' && td.status !== 'error') {
        td.status = 'done'
        td.elapsed = payload.elapsed
        renderTask(td)
      }
      wkrLogS(`Task done in ${payload.elapsed}ms${payload.jobId ? ` (job chunk ${(payload.chunkIndex ?? 0) + 1})` : ''}`)
      break
    }

    case 'task-error':
      wkrLogE(`Task error: ${payload.error}`)
      break

    case 'file-uploaded':
      reqLogS(`Uploaded: ${payload.remotePath}`)
      showToast(`Uploaded ${payload.remotePath}`, 'success')
      cliPrint(`✓ Uploaded: ${payload.remotePath}`, 'success')
      // mark matching data file as uploaded
      for (const entry of state.scheduleDataFiles) {
        if (payload.remotePath === `/data/${entry.file.name}`) {
          entry.uploaded = true
        }
      }
      renderDataFileList()
      updateScheduleButtons()
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
      $('btn-launch-requester').textContent = '▶ Start Request'
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

    case 'capabilities-detected': {
      state.workerCaps = payload
      $('wkr-caps-section').style.display = ''
      const model = payload.cpuModel || 'unknown'
      $('cap-cpu-model').textContent = model.length > 18 ? model.slice(0, 18) + '…' : model
      $('cap-cpu-cores').textContent = payload.cpuCores || '—'
      $('cap-ram').textContent = payload.ramGB ? `${payload.ramGB} GB` : '—'
      $('cap-gpu-name').textContent = payload.gpuName || 'None'
      $('cap-gpu-type').textContent = payload.gpuType || 'cpu'
      $('cap-python').textContent = payload.hasPython ? (payload.pythonVersion || 'yes') : 'no'
      if (payload.cpuCores) {
        const threadsEl = $('wkr-threads')
        threadsEl.max = payload.cpuCores
        if (parseInt(threadsEl.value) > payload.cpuCores) threadsEl.value = payload.cpuCores
      }
      break
    }

    case 'settings-loaded':
      if (payload.defaultHw)      $('req-default-hw').value      = payload.defaultHw
      if (payload.defaultTimeout) $('req-default-timeout').value  = payload.defaultTimeout
      if (payload.bootstrapNode !== undefined) $('req-bootstrap-node').value = payload.bootstrapNode || ''
      state.settings = payload
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
  const bootstrapNode = $('req-bootstrap-node').value.trim() || null
  send('start-requester', { bootstrapNode })
  $('btn-launch-requester').textContent = 'Starting…'
  $('btn-launch-requester').disabled = true
  reqLog('Starting requester…')
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

// ── Settings panel ────────────────────────────────────────────
$('req-settings-toggle').addEventListener('click', () => {
  const body = $('req-settings-body')
  const arrow = $('req-settings-arrow')
  const isOpen = body.style.display !== 'none'
  body.style.display = isOpen ? 'none' : ''
  arrow.textContent = isOpen ? '▶' : '▼'
})

$('btn-save-settings').addEventListener('click', () => {
  send('save-settings', {
    defaultHw:      $('req-default-hw').value,
    defaultTimeout: parseInt($('req-default-timeout').value) || 60,
    bootstrapNode:  $('req-bootstrap-node').value.trim()
  })
  showToast('Settings saved', 'success')
})

// ── CLI ───────────────────────────────────────────────────────
const cliOutput = $('cli-output')
const cliInputEl = $('cli-input')

function cliPrint (msg, level = 'info') {
  const item = document.createElement('div')
  item.className = `cli-line ${level}`
  const ts = new Date().toTimeString().slice(0, 8)
  item.innerHTML = `<span class="cli-ts">${ts}</span>${escHtml(msg)}`
  cliOutput.appendChild(item)
  cliOutput.scrollTop = cliOutput.scrollHeight
}

function parseRequiresFlag (tokens) {
  const idx = tokens.indexOf('--requires')
  if (idx === -1) return {}
  const raw = tokens[idx + 1] || ''
  const req = {}
  for (const pair of raw.split(',')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) continue
    const k = pair.slice(0, eqIdx).trim()
    const v = pair.slice(eqIdx + 1).trim()
    if (!k) continue
    req[k] = v === 'true' ? true : v === 'false' ? false : isNaN(v) ? v : Number(v)
  }
  return req
}

function handleCLI (raw) {
  const line = raw.trim()
  if (!line) return
  cliPrint(`> ${line}`, 'cmd')

  if (state.cmdHistory[0] !== line) state.cmdHistory.unshift(line)
  if (state.cmdHistory.length > 50) state.cmdHistory.length = 50
  state.cmdHistoryPos = -1

  const tokens = line.split(/\s+/)
  const cmd = tokens[0].toLowerCase()

  if (cmd === 'run') {
    const reqIdx = tokens.indexOf('--requires')
    const codeParts = tokens.slice(1, reqIdx === -1 ? undefined : reqIdx)
    const code = codeParts.join(' ')
    if (!code) { cliPrint('Usage: run <code> [--requires k=v,...]', 'error'); return }
    const requires = parseRequiresFlag(tokens)
    send('submit-task', { code, requires: Object.keys(requires).length ? requires : undefined })
    cliPrint(`Task submitted: ${code.slice(0, 80)}`, 'accent')
    document.querySelector('.ctab[data-tab="req-tasks"]').click()
  } else if (cmd === 'shell') {
    const reqIdx = tokens.indexOf('--requires')
    const cmdParts = tokens.slice(1, reqIdx === -1 ? undefined : reqIdx)
    const shellCmd = cmdParts.join(' ')
    if (!shellCmd) { cliPrint('Usage: shell <cmd> [--requires k=v,...]', 'error'); return }
    const requires = parseRequiresFlag(tokens)
    send('submit-shell', { cmd: shellCmd, requires: Object.keys(requires).length ? requires : undefined })
    cliPrint(`Shell task submitted: ${shellCmd}`, 'accent')
    document.querySelector('.ctab[data-tab="req-tasks"]').click()
  } else if (cmd === 'job') {
    const filePath = tokens[1]
    if (!filePath) { cliPrint('Usage: job <path>', 'error'); return }
    send('submit-job', { filePath })
    cliPrint(`Job submitted: ${filePath}`, 'accent')
    document.querySelector('.ctab[data-tab="req-tasks"]').click()
  } else if (cmd === 'upload') {
    const localPath = tokens[1]
    if (!localPath) { cliPrint('Usage: upload <localPath> [remotePath]', 'error'); return }
    const remotePath = tokens[2] || `/${localPath.split('/').pop()}`
    send('upload-file', { localPath, remotePath })
    cliPrint(`Uploading ${localPath} → ${remotePath}`, 'accent')
  } else if (cmd === 'help') {
    cliPrint('Commands:', 'info')
    cliPrint('  run <js code> [--requires k=v,...]   — run JS on a worker', 'info')
    cliPrint('  shell <cmd> [--requires k=v,...]     — run shell command', 'info')
    cliPrint('  job <path.js>                        — submit a job file', 'info')
    cliPrint('  upload <localPath> [remotePath]      — upload a file', 'info')
    cliPrint('Requires flags: hasGPU=true, cpuCores=4, hasPython=true, ...', 'info')
  } else {
    cliPrint(`Unknown command: "${cmd}". Type "help" for commands.`, 'error')
  }
}

cliInputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    handleCLI(cliInputEl.value)
    cliInputEl.value = ''
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    const next = state.cmdHistoryPos + 1
    if (next < state.cmdHistory.length) {
      state.cmdHistoryPos = next
      cliInputEl.value = state.cmdHistory[state.cmdHistoryPos]
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    const next = state.cmdHistoryPos - 1
    if (next < 0) {
      state.cmdHistoryPos = -1
      cliInputEl.value = ''
    } else {
      state.cmdHistoryPos = next
      cliInputEl.value = state.cmdHistory[state.cmdHistoryPos]
    }
  }
})

// ── Schedule tab ──────────────────────────────────────────────
const dropDataZone  = $('drop-data')
const fileDataInput = $('file-data-input')
const dropScriptZone  = $('drop-script')
const fileScriptInput = $('file-script-input')

function updateScheduleButtons () {
  const hasData   = state.scheduleDataFiles.length > 0
  const hasScript = !!state.scheduleScriptPath
  const allUploaded = !hasData || state.scheduleDataFiles.every(f => f.uploaded)
  $('btn-upload-all').disabled = !hasData && !hasScript
  // Run is enabled when script is selected and (no data files, or all data files uploaded)
  $('btn-run-script').disabled = !(hasScript && allUploaded)
  const statusEl = $('schedule-status')
  if (!hasScript) {
    statusEl.textContent = ''
  } else if (!hasData) {
    statusEl.textContent = 'Ready to run (script only)'
    statusEl.style.color = 'var(--green)'
  } else if (allUploaded) {
    statusEl.textContent = 'All files uploaded — ready to run'
    statusEl.style.color = 'var(--green)'
  } else {
    const done = state.scheduleDataFiles.filter(f => f.uploaded).length
    statusEl.textContent = `${done}/${state.scheduleDataFiles.length} data files uploaded`
    statusEl.style.color = 'var(--text3)'
  }
}

function renderDataFileList () {
  const ul = $('data-file-list')
  ul.innerHTML = ''
  for (const entry of state.scheduleDataFiles) {
    const li = document.createElement('li')
    li.className = 'data-file-item'
    li.innerHTML = `<span class="dfi-name">${escHtml(entry.file.name)}</span>` +
      `<span class="dfi-status${entry.uploaded ? ' uploaded' : ''}">${entry.uploaded ? '✓ uploaded' : 'pending'}</span>`
    ul.appendChild(li)
  }
}

function addDataFiles (files) {
  for (const file of files) {
    if (!state.scheduleDataFiles.find(f => f.file.name === file.name)) {
      state.scheduleDataFiles.push({ file, path: file.path || file.name, uploaded: false })
    }
  }
  renderDataFileList()
  updateScheduleButtons()
}

dropDataZone.addEventListener('click', () => fileDataInput.click())
dropDataZone.addEventListener('dragover', e => { e.preventDefault(); dropDataZone.classList.add('drag-over') })
dropDataZone.addEventListener('dragleave', () => dropDataZone.classList.remove('drag-over'))
dropDataZone.addEventListener('drop', e => {
  e.preventDefault()
  dropDataZone.classList.remove('drag-over')
  addDataFiles([...e.dataTransfer.files])
})
fileDataInput.addEventListener('change', e => { if (e.target.files.length) addDataFiles([...e.target.files]) })

dropScriptZone.addEventListener('click', () => fileScriptInput.click())
dropScriptZone.addEventListener('dragover', e => { e.preventDefault(); dropScriptZone.classList.add('drag-over') })
dropScriptZone.addEventListener('dragleave', () => dropScriptZone.classList.remove('drag-over'))
dropScriptZone.addEventListener('drop', e => {
  e.preventDefault()
  dropScriptZone.classList.remove('drag-over')
  const file = e.dataTransfer.files[0]
  if (file && file.name.endsWith('.js')) selectScriptFile(file)
  else showToast('Please drop a .js file', 'error')
})
fileScriptInput.addEventListener('change', e => { if (e.target.files[0]) selectScriptFile(e.target.files[0]) })

function selectScriptFile (file) {
  state.scheduleScriptPath = file.path || file.name
  state.scheduleScriptFile = file
  $('drop-script-name').textContent = file.name
  $('drop-script-name').style.display = 'block'
  dropScriptZone.querySelector('.drop-title').textContent = file.name
  dropScriptZone.querySelector('.drop-sub').textContent = 'Click to change'
  updateScheduleButtons()
}

$('btn-upload-all').addEventListener('click', () => {
  let queued = 0
  for (const entry of state.scheduleDataFiles) {
    if (!entry.uploaded) {
      send('upload-file', { localPath: entry.path, remotePath: `/data/${entry.file.name}` })
      queued++
    }
  }
  if (state.scheduleScriptPath) {
    send('upload-file', { localPath: state.scheduleScriptPath, remotePath: `/scripts/${state.scheduleScriptFile.name}` })
    queued++
  }
  if (queued > 0) showToast(`Uploading ${queued} file(s)…`)
})

$('btn-run-script').addEventListener('click', () => {
  if (!state.scheduleScriptPath) { showToast('Select a script first', 'error'); return }
  send('submit-job', { filePath: state.scheduleScriptPath })
  showToast('Job submitted')
  document.querySelector('.ctab[data-tab="req-tasks"]').click()
})

// ── Startup ───────────────────────────────────────────────────
// Status polling starts immediately; sends that require main-process
// IPC to be ready (load-settings, get-capabilities) are deferred to
// the 'connected' event so the stream is registered before we write.
setInterval(() => send('get-status'), 3000)
