// Worker thread pool for parallel task execution
// Dispatches pure compute tasks to worker_threads, returns results via promises

import { Worker } from 'bare-worker'
import os from 'os'

// Build the worker URL from import.meta.url (pear://... in Pear runtime).
// Module.resolve inside bare-worker accepts absolute pear:// URLs directly.
const WORKER_SCRIPT = new URL('./thread-worker.mjs', import.meta.url).href

export class ThreadPool {
  constructor (size) {
    this.size = size || Math.max(1, os.cpus().length - 1)
    this.workers = []         // { worker, busy, id }
    this.queue = []           // { task, resolve, reject }
    this.running = 0
    this.destroyed = false
  }

  async start () {
    for (let i = 0; i < this.size; i++) {
      const thread = await this._spawnThread(i)
      this.workers.push(thread)
    }
    console.log(`[pool] Started ${this.size} worker thread(s)`)
  }

  _spawnThread (id) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_SCRIPT)
      const entry = { worker, busy: false, id }

      worker.once('message', (msg) => {
        if (msg.type === 'ready') resolve(entry)
      })

      worker.on('error', (err) => {
        console.log(`[pool] Thread ${id} error: ${err.message}`)
        // Replace crashed thread
        if (!this.destroyed) {
          this._replaceThread(id)
        }
      })

      worker.on('exit', (code) => {
        if (!this.destroyed && code !== 0) {
          console.log(`[pool] Thread ${id} exited with code ${code}, respawning…`)
          this._replaceThread(id)
        }
      })

      // Timeout if thread never becomes ready
      setTimeout(() => reject(new Error(`Thread ${id} failed to start`)), 5000)
    })
  }

  async _replaceThread (id) {
    try {
      const thread = await this._spawnThread(id)
      this.workers[id] = thread
      this._drain()
    } catch (err) {
      console.log(`[pool] Failed to respawn thread ${id}: ${err.message}`)
    }
  }

  // Run a pure compute task (no Hyperdrive access) on a pool thread
  // Returns a promise that resolves with the task output
  runTask (task) {
    if (this.destroyed) return Promise.reject(new Error('Pool is destroyed'))

    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject })
      this._drain()
    })
  }

  _drain () {
    while (this.queue.length > 0) {
      const thread = this.workers.find(t => !t.busy)
      if (!thread) break // all threads busy, wait

      const { task, resolve, reject } = this.queue.shift()
      thread.busy = true
      this.running++

      const taskId = task.id || Math.random().toString(36).slice(2)

      const handler = (msg) => {
        if (msg.taskId !== taskId) return
        thread.worker.removeListener('message', handler)
        thread.busy = false
        this.running--

        if (msg.type === 'result') {
          resolve({ output: msg.output, threadId: thread.id })
        } else if (msg.type === 'error') {
          reject(new Error(msg.error))
        }

        // Drain queue for next waiting task
        this._drain()
      }

      thread.worker.on('message', handler)
      thread.worker.postMessage({
        type: 'execute',
        taskId,
        code: task.code,
        argNames: task.argNames || [],
        args: task.args || []
      })
    }
  }

  // Check if pool has capacity for more tasks
  get available () {
    return this.workers.filter(t => !t.busy).length
  }

  get busy () {
    return this.running >= this.size
  }

  async destroy () {
    this.destroyed = true
    // Reject queued tasks
    for (const { reject } of this.queue) {
      reject(new Error('Pool destroyed'))
    }
    this.queue = []

    await Promise.all(
      this.workers.map(({ worker }) =>
        new Promise((resolve) => {
          worker.once('exit', resolve)
          worker.postMessage({ type: 'exit' })
          // Force kill after 2s if graceful exit fails
          setTimeout(() => {
            try { worker.terminate() } catch {}
            resolve()
          }, 2000)
        })
      )
    )
    this.workers = []
    console.log('[pool] All threads stopped')
  }
}
