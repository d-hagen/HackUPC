// Thread entry point — runs inside each worker_thread
// Receives task code + args from parent, executes, posts result back

import { parentPort } from 'bare-worker'

parentPort.on('message', async (msg) => {
  if (msg.type === 'execute') {
    const { taskId, code, argNames = [], args = [] } = msg

    try {
      const fn = new (Object.getPrototypeOf(async function () {}).constructor)(...argNames, code)
      const result = await fn(...args)
      parentPort.postMessage({
        type: 'result',
        taskId,
        output: result === undefined ? null : result
      })
    } catch (err) {
      parentPort.postMessage({
        type: 'error',
        taskId,
        error: err.message
      })
    }
  }

  if (msg.type === 'exit') {
    Bare.exit(0)
  }
})

parentPort.postMessage({ type: 'ready' })
