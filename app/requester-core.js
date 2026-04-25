// RequesterCore: EventEmitter wrapper around request-compute logic (no readline)
import { createBase, NETWORK_TOPIC } from './base-setup.js'
import { loadReputation, addConsumed, getScore } from './reputation.js'
import { pathToFileURL } from 'url'
import { resolve, basename } from 'path'
import crypto from 'crypto'
import fs from 'fs'
import Hyperswarm from 'hyperswarm'
import EventEmitter from 'events'

export class RequesterCore extends EventEmitter {
  constructor ({ storePath = './store-requester', bootstrap = null } = {}) {
    super()
    this.storePath = storePath
    this.bootstrap = bootstrap
    this.requesterId = `requester-${crypto.randomUUID().slice(0, 8)}`
    this.autobaseKey = null
    this.driveKey = null

    this._base = null
    this._store = null
    this._drive = null
    this._replicationSwarm = null
    this._discoverySwarm = null
    this._cleanup = null

    this._printedResults = new Set()
    this._workers = new Map() // writerKey -> { id, ts }
    this._pendingJobs = new Map()
    this._taskToJob = new Map()
    this._broadcastConns = new Set()
    this._pendingTaskCount = 0
    this._broadcastInterval = null
  }

  async start () {
    const { base, swarm: replicationSwarm, store, drive, cleanup } =
      await createBase(this.storePath, null)

    this._base = base
    this._store = store
    this._drive = drive
    this._replicationSwarm = replicationSwarm
    this._cleanup = cleanup

    this.autobaseKey = base.key.toString('hex')
    this.driveKey = drive.key.toString('hex')

    const swarmOpts = this.bootstrap
      ? { bootstrap: [{ host: this.bootstrap.split(':')[0], port: Number(this.bootstrap.split(':')[1]) }] }
      : {}

    this._discoverySwarm = new Hyperswarm(swarmOpts)
    this._discoverySwarm.join(NETWORK_TOPIC, { client: true, server: true })

    replicationSwarm.join(base.discoveryKey, { client: true, server: true })
    replicationSwarm.on('connection', (conn) => store.replicate(conn))

    this._discoverySwarm.on('connection', (conn) => {
      this._broadcastConns.add(conn)
      conn.on('close', () => this._broadcastConns.delete(conn))
      conn.on('error', () => this._broadcastConns.delete(conn))

      const rep = loadReputation()
      conn.write(JSON.stringify({
        type: 'advertise',
        role: 'requester',
        requesterId: this.requesterId,
        autobaseKey: this.autobaseKey,
        pendingTasks: this._pendingTaskCount,
        reputation: { donated: rep.donated, consumed: rep.consumed, score: getScore(rep) },
        workerCount: this._workers.size
      }))

      conn.on('data', async (data) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'join-request' && msg.role === 'worker') {
            const writerKey = msg.writerKey
            if (!this._workers.has(writerKey)) {
              this._workers.set(writerKey, { id: msg.workerId, ts: Date.now() })
              await this._base.append({ type: 'add-writer', key: writerKey, by: this.requesterId, ts: Date.now() })
              conn.write(JSON.stringify({ type: 'join-accepted', autobaseKey: this.autobaseKey }))
              this.emit('worker-joined', { workerId: msg.workerId, writerKey })
              this._emitStatus()
            }
          }
        } catch {}
      })
    })

    this._base.on('update', () => this._processResults())

    this._broadcastInterval = setInterval(() => this._broadcast(), 10000)

    await Promise.all([this._discoverySwarm.flush(), this._replicationSwarm.flush()])
    this.emit('ready', { requesterId: this.requesterId, autobaseKey: this.autobaseKey })
    this._emitStatus()
  }

  _broadcast () {
    const rep = loadReputation()
    const msg = JSON.stringify({
      type: 'advertise',
      role: 'requester',
      requesterId: this.requesterId,
      autobaseKey: this.autobaseKey,
      pendingTasks: this._pendingTaskCount,
      workerCount: this._workers.size,
      reputation: { donated: rep.donated, consumed: rep.consumed, score: getScore(rep) }
    })
    for (const conn of this._broadcastConns) {
      try { conn.write(msg) } catch {}
    }
  }

  _emitStatus () {
    const rep = loadReputation()
    this.emit('status', {
      workers: [...this._workers.values()].map(w => ({ id: w.id, ts: w.ts })),
      pendingTasks: this._pendingTaskCount,
      resultsReceived: this._printedResults.size,
      reputation: { donated: rep.donated, consumed: rep.consumed, score: getScore(rep) }
    })
  }

  async _processResults () {
    for (let i = 0; i < this._base.view.length; i++) {
      const entry = await this._base.view.get(i)

      if (entry.type === 'result' && !this._printedResults.has(entry.taskId)) {
        this._printedResults.add(entry.taskId)

        const jobMatch = this._taskToJob.get(entry.taskId)
        if (jobMatch) {
          const { jobId, chunkIndex } = jobMatch
          const job = this._pendingJobs.get(jobId)
          if (job && !job.results.has(chunkIndex)) {
            job.results.set(chunkIndex, entry.error ? { error: entry.error } : entry.output)

            this.emit('chunk-done', {
              jobId,
              chunkIndex,
              totalChunks: job.totalChunks,
              output: entry.output,
              error: entry.error,
              by: entry.by,
              elapsed: entry.elapsed
            })

            if (job.results.size === job.totalChunks) {
              const errors = [...job.results.values()].filter(r => r && r.error)
              let final = null
              if (errors.length === 0) {
                const ordered = Array.from({ length: job.totalChunks }, (_, i) => job.results.get(i))
                try { final = job.joinFn(ordered) } catch (e) { final = { error: e.message } }
              }
              this.emit('job-complete', { jobId, result: final, errors: errors.length })
              this._pendingJobs.delete(jobId)
              for (const [taskId, m] of this._taskToJob) {
                if (m.jobId === jobId) this._taskToJob.delete(taskId)
              }
              this._pendingTaskCount = Math.max(0, this._pendingTaskCount - job.totalChunks)
              this._broadcast()
            }
          }
        } else {
          this.emit('result', {
            taskId: entry.taskId,
            output: entry.output,
            error: entry.error,
            elapsed: entry.elapsed,
            by: entry.by
          })
          this._pendingTaskCount = Math.max(0, this._pendingTaskCount - 1)
          this._broadcast()
        }
        this._emitStatus()
      }
    }
  }

  getStatus () {
    const rep = loadReputation()
    return {
      workers: [...this._workers.values()].map(w => ({ id: w.id, ts: w.ts })),
      pendingTasks: this._pendingTaskCount,
      resultsReceived: this._printedResults.size,
      reputation: { donated: rep.donated, consumed: rep.consumed, score: getScore(rep) }
    }
  }

  async submitTask (code) {
    const id = crypto.randomUUID()
    await this._base.append({
      type: 'task', id, code, argNames: [], args: [],
      driveKey: this.driveKey,
      by: this.requesterId, ts: Date.now()
    })
    this._pendingTaskCount++
    addConsumed(1)
    this._broadcast()
    this.emit('task-posted', { taskId: id, preview: code.slice(0, 60) })
    this._emitStatus()
    return id
  }

  async submitJob (filePath, nOverride = null) {
    const absPath = resolve(filePath)
    const mod = await import(pathToFileURL(absPath).href)
    if (!mod.split || !mod.compute || !mod.join || !mod.data) {
      throw new Error('Job file must export: data, split(data, n), compute(chunk), join(results)')
    }
    const n = nOverride || Math.max(1, this._workers.size)
    const chunks = mod.split(mod.data, n)
    const jobId = crypto.randomUUID()
    const computeCode = mod.compute.toString()
    const code = `const compute = ${computeCode}; return compute(chunk)`
    const workerIds = [...this._workers.values()].map(w => w.id)

    this._pendingJobs.set(jobId, {
      totalChunks: chunks.length,
      results: new Map(),
      joinFn: mod.join
    })

    for (let i = 0; i < chunks.length; i++) {
      const taskId = crypto.randomUUID()
      this._taskToJob.set(taskId, { jobId, chunkIndex: i })
      const assignedTo = workerIds.length > 0 ? workerIds[i % workerIds.length] : null
      await this._base.append({
        type: 'task', id: taskId, jobId, chunkIndex: i, totalChunks: chunks.length,
        code, argNames: ['chunk'], args: [chunks[i]],
        assignedTo, driveKey: this.driveKey,
        by: this.requesterId, ts: Date.now()
      })
    }
    this._pendingTaskCount += chunks.length
    addConsumed(chunks.length)
    this._broadcast()
    this.emit('job-posted', { jobId, totalChunks: chunks.length, fileName: basename(filePath) })
    this._emitStatus()
    return jobId
  }

  async submitFile (filePath) {
    const code = fs.readFileSync(filePath, 'utf-8')
    return this.submitTask(code)
  }

  async submitBundle (filePath, argNames = []) {
    const absPath = resolve(filePath)
    const { bundleTask } = await import('./bundler.js')
    const { code } = await bundleTask(absPath, argNames)
    const id = crypto.randomUUID()
    this._pendingTaskCount++
    await this._base.append({
      type: 'task', id, code, argNames, args: [],
      bundled: true, driveKey: this.driveKey,
      by: this.requesterId, ts: Date.now()
    })
    addConsumed(1)
    this._broadcast()
    this.emit('task-posted', { taskId: id, preview: `[bundled] ${basename(filePath)}` })
    this._emitStatus()
    return id
  }

  async submitShell (cmd, timeout = 60000) {
    const id = crypto.randomUUID()
    await this._base.append({
      type: 'task', id, taskType: 'shell', cmd, timeout,
      by: this.requesterId, ts: Date.now()
    })
    this._pendingTaskCount++
    addConsumed(1)
    this._broadcast()
    this.emit('task-posted', { taskId: id, preview: `[shell] ${cmd.slice(0, 60)}` })
    this._emitStatus()
    return id
  }

  async uploadFile (localPath, remotePath) {
    const rp = remotePath.startsWith('/') ? remotePath : '/' + remotePath
    const data = fs.readFileSync(resolve(localPath))
    await this._drive.put(rp, data)
    this.emit('file-uploaded', { localPath, remotePath: rp, bytes: data.length })
  }

  async stop () {
    if (this._broadcastInterval) clearInterval(this._broadcastInterval)
    if (this._discoverySwarm) await this._discoverySwarm.destroy()
    if (this._cleanup) await this._cleanup()
  }
}
