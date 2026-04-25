/** @typedef {import('pear-interface')} */ /* global Pear */
import './compat.js'
import { RequesterCore } from './requester-core.js'
import { WorkerCore } from './worker-core.js'

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
// Send a JSON line; renderer receives via pear-pipe.
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
}

async function handleCmd (body) {
  const { type, payload = {} } = body
  if (type !== 'get-status') console.log(tag(`→ cmd    ${type}`), JSON.stringify(payload).slice(0, 120))

  if (type === 'start-requester' && !requester) {
    requester = new RequesterCore({ storePath: './store-requester' })
    wireRequester(requester)
    await requester.start()
  }

  if (type === 'start-worker' && !worker) {
    // hw: 'cpu' | 'cpu+gpu' | 'gpu'
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

  if (type === 'submit-task'  && requester) await requester.submitTask(payload.code)
  if (type === 'submit-job'   && requester) await requester.submitJob(payload.filePath, payload.n || null)
  if (type === 'submit-shell' && requester) await requester.submitShell(payload.cmd, payload.timeout || 60000)
  if (type === 'upload-file'  && requester) await requester.uploadFile(payload.localPath, payload.remotePath)

  if (type === 'get-status') {
    if (requester) broadcast('requester-status', requester.getStatus())
    if (worker)    broadcast('worker-status',    worker.getStatus())
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
