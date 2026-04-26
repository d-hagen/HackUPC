'use strict'

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

// ── State ──
const state = {
  workers: [],
  tasks: new Map(),
  jobs: new Map(),
  requesterLaunched: false,
  workerLaunched: false,
  taskFilter: 'queue',
  workerCaps: null,
  workerStatus: { searching: true, currentRequester: null, totalTasksDone: 0 },
  scheduleDataFiles: [],
  scheduleScriptName: null,
  cmdHistory: [],
  cmdHistoryPos: -1
}

// ── API helpers ──
async function api (endpoint, body) {
  const res = await fetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  })
  return res.json()
}

// ── SSE connection ──
function connectSSE () {
  const evtSource = new EventSource('/events')

  evtSource.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      handleMsg(msg)
    } catch {}
  }

  evtSource.onerror = () => {
    $('net-dot').className = 'dot'
    $('net-label').textContent = 'Disconnected'
  }
}

// ── Logging ──
function logTo (listId, msg, level = 'info') {
  const list = $(listId)
  if (!list) return
  const item = document.createElement('div')
  item.className = `log-item ${level}`
  const ts = new Date().toTimeString().slice(0, 8)
  item.innerHTML = `<span class="log-ts">${ts}</span>${escHtml(msg)}`
  list.appendChild(item)
  list.scrollTop = list.scrollHeight
}

// ── Mode tabs ──
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    const mode = tab.dataset.mode
    $('view-requester').style.display = mode === 'requester' ? '' : 'none'
    $('view-worker').style.display = mode === 'worker' ? '' : 'none'
  })
})

// ── Content tabs ──
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

// ── Log toggles ──
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

// ── Task queue rendering ──
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
    const badge = task.status === 'pending' ? 'badge-pending'
      : task.status === 'running' ? 'badge-running'
      : task.status === 'error' ? 'badge-error' : 'badge-done'
    const label = { pending: 'Pending', running: 'Running', error: 'Error', done: 'Done' }[task.status]
    el.innerHTML = `
      <span class="task-badge ${badge}">${label}</span>
      <span class="task-preview">${escHtml(task.preview || task.id.slice(0, 16))}</span>
      <span class="task-by">${escHtml(task.by ? task.by.slice(0, 12) : '')}</span>
      <span class="task-elapsed">${task.elapsed ? task.elapsed + 'ms' : ''}</span>
    `
    wrap.appendChild(el)
  }
}

// ── Worker list ──
function renderWorkers () {
  const list = $('worker-list')
  if (state.workers.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:12px 0"><div class="es-sub">No workers yet</div></div>'
    return
  }
  list.innerHTML = ''
  for (const wid of state.workers) {
    const div = document.createElement('div')
    div.className = 'worker-item'
    div.innerHTML = `<div class="wdot"></div><span class="wid">${escHtml(wid)}</span>`
    list.appendChild(div)
  }
}

// ── Peer graph ──
function renderGraph () {
  const svg = $('peer-graph')
  const W = 232, H = 120, cx = W / 2, cy = H / 2
  const workers = state.workers
  const r = Math.min(46, 14 + workers.length * 8)
  let out = ''
  workers.forEach((wid, i) => {
    const angle = (i / Math.max(workers.length, 1)) * Math.PI * 2 - Math.PI / 2
    const wx = (cx + r * Math.cos(angle)).toFixed(1)
    const wy = (cy + r * Math.sin(angle)).toFixed(1)
    out += `<line x1="${cx}" y1="${cy}" x2="${wx}" y2="${wy}" stroke="#2a2a35" stroke-width="1.5"/>`
    out += `<circle cx="${wx}" cy="${wy}" r="5" fill="#22c55e" opacity="0.9"/>`
    out += `<text x="${wx}" y="${(+wy + 14).toFixed(1)}" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="monospace">${escHtml(wid.slice(0, 10))}</text>`
  })
  const cc = state.requesterLaunched ? '#7c3aed' : '#475569'
  out += `<circle cx="${cx}" cy="${cy}" r="8" fill="${cc}"/>`
  out += `<text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="monospace">you</text>`
  svg.innerHTML = out
}

// ── Worker activity ──
function addActivity (badge, msg) {
  const list = $('wkr-activity-list')
  const empty = $('wkr-activity-empty')
  if (empty) empty.style.display = 'none'

  const el = document.createElement('div')
  el.className = 'activity-item'
  const ts = new Date().toTimeString().slice(0, 8)
  el.innerHTML = `
    <span class="activity-badge ${badge}">${badge}</span>
    <span class="activity-msg">${escHtml(msg)}</span>
    <span class="activity-time">${ts}</span>
  `
  list.appendChild(el)
  list.scrollTop = list.scrollHeight
}

// ── Message handler ──
function handleMsg (msg) {
  const { type, payload } = msg
  if (!payload) return

  switch (type) {
    case 'connected':
      $('net-dot').className = 'dot searching'
      $('net-label').textContent = 'Ready'
      if (payload.state) {
        state.requesterLaunched = payload.state.requesterLaunched
        state.workerLaunched = payload.state.workerLaunched
        state.workers = payload.state.workers || []
        state.workerStatus = payload.state.workerStatus || state.workerStatus
        state.workerCaps = payload.state.workerCaps
        if (payload.state.tasks) {
          for (const t of payload.state.tasks) state.tasks.set(t.id, t)
        }
        syncUIState()
        if (payload.state.log) {
          for (const entry of payload.state.log) {
            const listId = entry.role === 'requester' ? 'req-log-list' : 'wkr-log-list'
            logTo(listId, entry.msg, entry.level)
          }
        }
      }
      break

    case 'requester-ready':
      state.requesterLaunched = true
      $('net-dot').className = 'dot online'
      $('net-label').textContent = 'Online'
      $('req-stats-section').style.display = ''
      $('req-graph-section').style.display = ''
      $('req-workers-section').style.display = ''
      $('btn-launch-requester').style.display = 'none'
      $('btn-stop-requester').style.display = ''
      renderGraph()
      showToast('Requester started', 'success')
      break

    case 'worker-ready':
      state.workerLaunched = true
      $('wkr-self-section').style.display = ''
      $('btn-launch-worker').style.display = 'none'
      $('btn-stop-worker').style.display = ''
      showToast('Worker started', 'success')
      addActivity('info', 'Worker started, listening for requesters...')
      break

    case 'worker-joined': {
      const wid = payload.workerId
      if (!state.workers.includes(wid)) state.workers.push(wid)
      $('stat-workers').textContent = state.workers.length
      renderWorkers()
      renderGraph()
      showToast(`Worker joined: ${wid.slice(0, 16)}`, 'success')
      break
    }

    case 'task-posted': {
      state.tasks.set(payload.taskId, { id: payload.taskId, status: 'pending', preview: payload.preview })
      $('stat-pending').textContent = ++state._pending || (state._pending = 1)
      renderTaskList()
      break
    }

    case 'job-posted':
      state.jobs.set(payload.jobId, { done: 0, totalChunks: payload.totalChunks })
      break

    case 'result': {
      const t = state.tasks.get(payload.taskId) || { id: payload.taskId, preview: '' }
      t.status = payload.error ? 'error' : 'done'
      t.by = payload.by
      t.elapsed = payload.elapsed
      state.tasks.set(payload.taskId, t)
      renderTaskList()
      if (payload.error) {
        cliPrint(`Error: ${payload.error}`, 'error')
      } else {
        cliPrint(`Result from ${payload.by || '?'}`, 'success')
      }
      break
    }

    case 'chunk-done': {
      const job = [...state.jobs.values()].find(j => j.totalChunks > 0)
      if (job) job.done++
      break
    }

    case 'job-complete':
      showToast('Job complete!', 'success')
      cliPrint('Job complete!', 'success')
      break

    case 'capabilities-detected':
      state.workerCaps = payload
      $('wkr-caps-section').style.display = ''
      $('cap-cpu-cores').textContent = payload.cpuCores || '-'
      $('cap-ram').textContent = payload.ramGB ? `${payload.ramGB} GB` : '-'
      $('cap-gpu-name').textContent = payload.gpuName || 'None'
      $('cap-gpu-type').textContent = payload.gpuType || 'cpu'
      $('cap-platform').textContent = payload.platform || '-'
      break

    case 'worker-joining':
      state.workerStatus.searching = false
      state.workerStatus.currentRequester = payload.requesterId
      $('ws-status').textContent = 'Joining...'
      $('ws-requester').textContent = payload.requesterId?.slice(0, 14) || '-'
      addActivity('info', `Joining ${payload.requesterId}...`)
      break

    case 'worker-authorized':
      $('ws-status').textContent = 'Authorized'
      addActivity('done', 'Authorization accepted')
      break

    case 'worker-joined-requester':
      $('net-dot').className = 'dot online'
      $('net-label').textContent = 'Computing'
      $('ws-status').textContent = 'Computing'
      $('ws-requester').textContent = payload.requesterId?.slice(0, 14) || '-'
      addActivity('done', `Connected to ${payload.requesterId}`)
      break

    case 'worker-left-requester':
      state.workerStatus.searching = true
      state.workerStatus.currentRequester = null
      $('net-dot').className = 'dot searching'
      $('net-label').textContent = 'Searching...'
      $('ws-status').textContent = 'Searching...'
      $('ws-requester').textContent = '-'
      addActivity('info', 'Left requester, searching...')
      break

    case 'requester-found':
      addActivity('info', payload.msg || 'Requester found')
      break

    case 'task-start':
      addActivity('start', `Task: ${payload.preview || payload.taskId} [${payload.mode || '?'}]`)
      break

    case 'task-done':
      state.workerStatus.totalTasksDone++
      $('ws-tasks').textContent = state.workerStatus.totalTasksDone
      addActivity('done', `Done in ${payload.elapsed || '?'}ms${payload.threadId !== undefined ? ` (thread #${payload.threadId})` : ''}`)
      break

    case 'requester-stopped':
      state.requesterLaunched = false
      state.workers = []
      $('btn-launch-requester').style.display = ''
      $('btn-launch-requester').textContent = '▶ Start Request'
      $('btn-launch-requester').disabled = false
      $('btn-stop-requester').style.display = 'none'
      $('req-stats-section').style.display = 'none'
      $('req-graph-section').style.display = 'none'
      $('req-workers-section').style.display = 'none'
      $('net-dot').className = 'dot'
      $('net-label').textContent = 'Offline'
      showToast('Requester stopped', '')
      break

    case 'worker-stopped':
      state.workerLaunched = false
      $('btn-launch-worker').style.display = ''
      $('btn-launch-worker').textContent = '▶ Launch Worker'
      $('btn-launch-worker').disabled = false
      $('btn-stop-worker').style.display = 'none'
      $('wkr-self-section').style.display = 'none'
      $('wkr-hw').disabled = false
      $('wkr-threads').disabled = false
      $('wkr-allow-shell').disabled = false
      addActivity('info', 'Worker stopped')
      showToast('Worker stopped', '')
      break

    case 'log': {
      const listId = payload.role === 'requester' ? 'req-log-list' : 'wkr-log-list'
      logTo(listId, payload.msg, payload.level)

      // Update stats from log parsing
      if (payload.role === 'requester') {
        $('stat-workers').textContent = state.workers.length
        $('stat-results').textContent = [...state.tasks.values()].filter(t => t.status === 'done').length
        $('stat-pending').textContent = [...state.tasks.values()].filter(t => t.status === 'pending').length
      }
      break
    }
  }
}

function syncUIState () {
  if (state.requesterLaunched) {
    $('btn-launch-requester').style.display = 'none'
    $('btn-stop-requester').style.display = ''
    $('req-stats-section').style.display = ''
    $('req-graph-section').style.display = ''
    $('req-workers-section').style.display = ''
    $('net-dot').className = 'dot online'
    $('net-label').textContent = 'Online'
    $('stat-workers').textContent = state.workers.length
    renderWorkers()
    renderGraph()
    renderTaskList()
  }
  if (state.workerLaunched) {
    $('btn-launch-worker').style.display = 'none'
    $('btn-stop-worker').style.display = ''
    $('wkr-self-section').style.display = ''
    $('wkr-hw').disabled = true
    $('wkr-threads').disabled = true
    $('wkr-allow-shell').disabled = true
    $('ws-status').textContent = state.workerStatus.searching ? 'Searching...' : 'Computing'
    $('ws-requester').textContent = state.workerStatus.currentRequester?.slice(0, 14) || '-'
    $('ws-tasks').textContent = state.workerStatus.totalTasksDone
  }
  if (state.workerCaps) {
    $('wkr-caps-section').style.display = ''
    $('cap-cpu-cores').textContent = state.workerCaps.cpuCores || '-'
    $('cap-ram').textContent = state.workerCaps.ramGB ? `${state.workerCaps.ramGB} GB` : '-'
    $('cap-gpu-name').textContent = state.workerCaps.gpuName || 'None'
    $('cap-gpu-type').textContent = state.workerCaps.gpuType || 'cpu'
    $('cap-platform').textContent = state.workerCaps.platform || '-'
  }
}

// ── Launch / Stop: Requester ──
$('btn-launch-requester').addEventListener('click', async () => {
  if (state.requesterLaunched) return
  const bootstrapNode = $('req-bootstrap-node').value.trim() || undefined
  $('btn-launch-requester').textContent = 'Starting...'
  $('btn-launch-requester').disabled = true
  await api('start-requester', { bootstrapNode })
})

$('btn-stop-requester').addEventListener('click', async () => {
  await api('stop-requester')
})

// ── Launch / Stop: Worker ──
$('btn-launch-worker').addEventListener('click', async () => {
  if (state.workerLaunched) return
  const threads = parseInt($('wkr-threads').value) || 4
  const allowShell = $('wkr-allow-shell').checked
  const bootstrapNode = $('wkr-bootstrap-node').value.trim() || undefined
  $('btn-launch-worker').textContent = 'Launching...'
  $('btn-launch-worker').disabled = true
  $('wkr-hw').disabled = true
  $('wkr-threads').disabled = true
  $('wkr-allow-shell').disabled = true
  await api('start-worker', { threads, allowShell, bootstrapNode })
})

$('btn-stop-worker').addEventListener('click', async () => {
  await api('stop-worker')
})

// ── Settings panel ──
$('req-settings-toggle').addEventListener('click', () => {
  const body = $('req-settings-body')
  const arrow = $('req-settings-arrow')
  const isOpen = body.style.display !== 'none'
  body.style.display = isOpen ? 'none' : ''
  arrow.textContent = isOpen ? '▶' : '▼'
})

// ── CLI ──
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

async function handleCLI (raw) {
  const line = raw.trim()
  if (!line) return
  cliPrint(`> ${line}`, 'cmd')

  if (state.cmdHistory[0] !== line) state.cmdHistory.unshift(line)
  if (state.cmdHistory.length > 50) state.cmdHistory.length = 50
  state.cmdHistoryPos = -1

  const tokens = line.split(/\s+/)
  const cmd = tokens[0].toLowerCase()

  if (cmd === 'help') {
    cliPrint('Commands:', 'info')
    cliPrint('  run <js code>             - run JS on a worker', 'info')
    cliPrint('  shell <cmd>               - run shell command', 'info')
    cliPrint('  job <path.js> [n] [cols]  - submit a job file', 'info')
    cliPrint('  upload <localPath>        - upload a file', 'info')
    cliPrint('  workers                   - list connected workers', 'info')
    cliPrint('  status                    - show status', 'info')
    return
  }

  if (!state.requesterLaunched) {
    cliPrint('Requester not started. Launch it first.', 'error')
    return
  }

  // Send command directly to the requester's stdin
  const result = await api('command', { command: line })
  if (result.error) {
    cliPrint(`Error: ${result.error}`, 'error')
  } else {
    cliPrint(`Sent: ${line}`, 'accent')
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

// ── Schedule tab ──
const dropDataZone  = $('drop-data')
const fileDataInput = $('file-data-input')
const dropScriptZone  = $('drop-script')
const fileScriptInput = $('file-script-input')

function updateScheduleButtons () {
  const hasData   = state.scheduleDataFiles.length > 0
  const hasScript = !!state.scheduleScriptName
  $('btn-upload-all').disabled = !hasData && !hasScript
  $('btn-run-script').disabled = !hasScript
  const statusEl = $('schedule-status')
  if (!hasScript) {
    statusEl.textContent = ''
  } else if (!hasData) {
    statusEl.textContent = 'Ready to run (script only)'
    statusEl.style.color = 'var(--green)'
  } else {
    statusEl.textContent = `${state.scheduleDataFiles.length} data file(s) selected`
    statusEl.style.color = 'var(--text3)'
  }
}

function renderDataFileList () {
  const ul = $('data-file-list')
  ul.innerHTML = ''
  for (const entry of state.scheduleDataFiles) {
    const li = document.createElement('li')
    li.className = 'data-file-item'
    li.innerHTML = `<span class="dfi-name">${escHtml(entry.name)}</span><span class="dfi-status">ready</span>`
    ul.appendChild(li)
  }
}

function addDataFiles (files) {
  for (const file of files) {
    if (!state.scheduleDataFiles.find(f => f.name === file.name)) {
      state.scheduleDataFiles.push({ name: file.name, file })
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
  state.scheduleScriptName = file.name
  $('drop-script-name').textContent = file.name
  $('drop-script-name').style.display = 'block'
  dropScriptZone.querySelector('.drop-title').textContent = file.name
  dropScriptZone.querySelector('.drop-sub').textContent = 'Click to change'
  updateScheduleButtons()
}

$('btn-upload-all').addEventListener('click', async () => {
  for (const entry of state.scheduleDataFiles) {
    await api('command', { command: `upload ${entry.name}` })
  }
  showToast('Upload commands sent')
})

$('btn-run-script').addEventListener('click', async () => {
  if (!state.scheduleScriptName) { showToast('Select a script first', 'error'); return }
  await api('command', { command: `job jobs/${state.scheduleScriptName}` })
  showToast('Job submitted')
  document.querySelector('.ctab[data-tab="req-tasks"]').click()
})

// ── Stop modal ──
$('stop-modal-cancel').addEventListener('click', () => {
  $('stop-modal').style.display = 'none'
})
$('stop-modal-confirm').addEventListener('click', () => {
  $('stop-modal').style.display = 'none'
})

// ── Boot ──
connectSSE()
