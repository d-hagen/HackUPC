/** @typedef {import('pear-interface')} */ /* global Pear */
import './compat.js'
import fs from 'fs'
import { RequesterCore } from './requester-core.js'
import { WorkerCore } from './worker-core.js'
import { detectCapabilities } from './capabilities.js'

let requester = null
let worker = null

// pear-bridge + pear-electron open the Electron window
const { default: Runtime } = await import('pear-electron')
const { default: Bridge } = await import('pear-bridge')
const bridge = new Bridge()
await bridge.ready()
const runtime = new Runtime()
const uiPipe = await runtime.start({ bridge })

// uiPipe is the fd-3 duplex stream to the renderer process.
function send (type, payload) {
  uiPipe.write(JSON.stringify({ type, payload }) + '\n')
}

const tag = s => `\x1b[36m[peercompute]\x1b[0m ${s}`

function broadcast (type, payload) {
  if (!type.endsWith('-status')) console.log(tag(`← event  ${type}`), JSON.stringify(payload).slice(0, 120))
  send(type, payload)
}

function wireRequester (r) {
  r.on('ready',        p => broadcast('requester-ready', p))
  r.on('worker-joined', p => broadcast('worker-joined', p))
  r.on('task-posted',  p => broadcast('task-posted', p))
  r.on('job-posted',   p => broadcast('job-posted', p))
  r.on('result',       p => broadcast('result', p))
  r.on('chunk-done',   p => broadcast('chunk-done', p))
  r.on('job-complete', p => broadcast('job-complete', p))
  r.on('file-uploaded', p => broadcast('file-uploaded', p))
  r.on('status',       p => broadcast('requester-status', p))
  r.on('error',        p => broadcast('error', p))
}

function wireWorker (w) {
  w.on('ready',           p => broadcast('worker-ready', p))
  w.on('authorized',      p => broadcast('worker-authorized', p))
  w.on('joined',          p => broadcast('worker-joined-requester', p))
  w.on('left',            p => broadcast('worker-left-requester', p))
  w.on('task-start',      p => broadcast('task-start', p))
  w.on('task-done',       p => broadcast('task-done', p))
  w.on('task-error',      p => broadcast('task-error', p))
  w.on('requester-found', p => broadcast('requester-found', p))
  w.on('status',          p => broadcast('worker-status', p))
  w.on('error',           p => broadcast('error', p))
}

const SETTINGS_PATH = './pear-settings.json'

async function handleCmd (body) {
  const { type, payload = {} } = body
  if (type !== 'get-status') console.log(tag(`→ cmd    ${type}`), JSON.stringify(payload).slice(0, 120))

  if (type === 'start-requester' && !requester) {
    const bootstrap = payload.bootstrapNode || null
    requester = new RequesterCore({ storePath: './store-requester', bootstrap })
    wireRequester(requester)
    await requester.start()
  }

  if (type === 'start-worker' && !worker) {
    const hw = payload.hw || 'cpu+gpu'
    worker = new WorkerCore({
      storePath: './store-worker-ui',
      allowShell: payload.allowShell || false,
      gpu: hw !== 'cpu',
      gpuOnly: hw === 'gpu',
      threads: payload.threads || 4,
    })
    wireWorker(worker)
    await worker.start()
  }

  if (type === 'submit-task'  && requester) await requester.submitTask(payload.code, payload.requires).catch(e => broadcast('error', { message: e.message }))
  if (type === 'submit-job'   && requester) await requester.submitJob(payload.filePath, payload.n || null).catch(e => broadcast('error', { message: e.message }))
  if (type === 'submit-shell' && requester) await requester.submitShell(payload.cmd, payload.timeout || 60000, payload.requires).catch(e => broadcast('error', { message: e.message }))
  if (type === 'upload-file'  && requester) await requester.uploadFile(payload.localPath, payload.remotePath).catch(e => broadcast('error', { message: e.message }))

  if (type === 'get-status') {
    if (requester) broadcast('requester-status', requester.getStatus())
    if (worker) {
      const status = worker.getStatus()
      if (worker._pool) {
        status.poolSize = worker._pool.size
        status.poolBusy = worker._pool.running || 0
      }
      broadcast('worker-status', status)
    }
  }

  if (type === 'stop-requester' && requester) {
    const pending = requester._pendingTaskCount || 0
    if (pending > 0 && !payload.force) {
      broadcast('stop-blocked', { role: 'requester', pending })
      return
    }
    await requester.stop()
    requester = null
    broadcast('requester-stopped', {})
  }

  if (type === 'stop-worker' && worker) {
    await worker.stop()
    worker = null
    broadcast('worker-stopped', {})
  }

  if (type === 'save-settings') {
    try {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(payload, null, 2))
      broadcast('settings-loaded', payload)
    } catch (e) {
      broadcast('error', { message: `Failed to save settings: ${e.message}` })
    }
  }

  if (type === 'load-settings') {
    try {
      if (fs.existsSync(SETTINGS_PATH)) {
        const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'))
        broadcast('settings-loaded', data)
      }
    } catch {}
  }

  if (type === 'get-capabilities') {
    try {
      const caps = await detectCapabilities()
      broadcast('capabilities-detected', caps)
    } catch (e) {
      broadcast('error', { message: `Capability detection failed: ${e.message}` })
    }
  }
}

// Read newline-delimited JSON commands from the renderer
let buf = ''
uiPipe.on('data', chunk => {
  buf += chunk.toString()
  const lines = buf.split('\n')
  buf = lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    try { handleCmd(JSON.parse(line)) } catch (e) { console.error('cmd parse error', e) }
  }
})

// Tell the renderer it's connected
send('connected', {})
