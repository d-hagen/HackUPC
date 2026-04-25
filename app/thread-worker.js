// Thread entry point — runs inside each worker_thread
// Receives task code + args from parent, executes, posts result back

import { parentPort, workerData } from 'worker_threads'

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
    process.exit(0)
  }
})

parentPort.postMessage({ type: 'ready' })
