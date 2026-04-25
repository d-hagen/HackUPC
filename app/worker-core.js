// WorkerCore: EventEmitter wrapper around offer-compute logic (no readline)
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import crypto from 'crypto'
import fs from 'fs'
import { NETWORK_TOPIC } from './base-setup.js'
import { executeTask } from './worker.js'
import { addDonated, loadReputation, getScore } from './reputation.js'
import EventEmitter from 'events'

const IDLE_TIMEOUT = 15000

export class WorkerCore extends EventEmitter {
  constructor ({ storePath = null, allowShell = false, bootstrap = null } = {}) {
    super()
    this.workerId = `worker-${crypto.randomUUID().slice(0, 8)}`
    this.storePath = storePath || `./store-${this.workerId}`
    this.allowShell = allowShell
    this.bootstrap = bootstrap

    this._discoverySwarm = null
    this._replicationSwarm = null
    this._base = null
    this._store = null
    this._outputDrive = null

    this._searching = true
    this._joining = false
    this._processing = false
    this._currentRequester = null
    this._currentDiscoveryKey = null
    this._tasksDone = 0
    this._totalTasksDone = 0
    this._completed = new Set()
    this._availableRequesters = new Map()
    this._mountedDrives = new Map()
    this._idleTimer = null
    this._taskPollTimer = null
  }

  async start () {
    const swarmOpts = this.bootstrap
      ? { bootstrap: [{ host: this.bootstrap.split(':')[0], port: Number(this.bootstrap.split(':')[1]) }] }
      : {}

    this._discoverySwarm = new Hyperswarm(swarmOpts)
    this._replicationSwarm = new Hyperswarm(swarmOpts)

    this._replicationSwarm.on('connection', (conn) => {
      if (this._store) this._store.replicate(conn)
    })

    this._discoverySwarm.join(NETWORK_TOPIC, { client: true, server: true })

    this._discoverySwarm.on('connection', (conn) => {
      conn.on('data', async (data) => {
        try {
          const msg = JSON.parse(data.toString())

          if (msg.type === 'advertise' && msg.role === 'requester') {
            this._availableRequesters.set(msg.requesterId, {
              autobaseKey: msg.autobaseKey,
              pendingTasks: msg.pendingTasks || 0,
              workerCount: msg.workerCount || 0,
              reputation: msg.reputation || { donated: 0, consumed: 0, score: 0 },
              conn, ts: Date.now()
            })
            this.emit('requester-found', {
              requesterId: msg.requesterId,
              pendingTasks: msg.pendingTasks || 0,
              reputation: msg.reputation
            })
            if (this._searching && msg.pendingTasks > 0) {
              this._pickBestRequester()
            }
          }

          if (msg.type === 'join-accepted') {
            this.emit('authorized', { requesterId: this._currentRequester })
            this._resetIdleTimer()
          }
        } catch {}
      })
    })

    await this._discoverySwarm.flush()
    this.emit('ready', { workerId: this.workerId })
    this._emitStatus()

    setInterval(() => {
      if (this._searching) this._pickBestRequester()
    }, 5000)
  }

  _emitStatus () {
    const rep = loadReputation()
    this.emit('status', {
      workerId: this.workerId,
      searching: this._searching,
      currentRequester: this._currentRequester,
      tasksDone: this._tasksDone,
      totalTasksDone: this._totalTasksDone,
      reputation: { donated: rep.donated, consumed: rep.consumed, score: getScore(rep) }
    })
  }

  getStatus () {
    const rep = loadReputation()
    return {
      workerId: this.workerId,
      searching: this._searching,
      currentRequester: this._currentRequester,
      tasksDone: this._tasksDone,
      totalTasksDone: this._totalTasksDone,
      reputation: { donated: rep.donated, consumed: rep.consumed, score: getScore(rep) }
    }
  }

  _stopIdleTimer () {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null }
  }

  _resetIdleTimer () {
    this._stopIdleTimer()
    this._idleTimer = setTimeout(() => {
      if (this._base && !this._searching) this._leaveCurrentRequester()
    }, IDLE_TIMEOUT)
  }

  async _leaveCurrentRequester () {
    const leavingBase = this._base
    const leavingStore = this._store
    const leavingId = this._currentRequester
    const leavingDiscoveryKey = this._currentDiscoveryKey

    this._base = null
    this._store = null
    this._currentRequester = null
    this._currentDiscoveryKey = null

    this._stopIdleTimer()
    if (this._taskPollTimer) { clearInterval(this._taskPollTimer); this._taskPollTimer = null }

    if (leavingBase) try { await leavingBase.close() } catch {}
    if (leavingDiscoveryKey) await this._replicationSwarm.leave(leavingDiscoveryKey)
    if (leavingId) this._availableRequesters.delete(leavingId)

    this.emit('left', { requesterId: leavingId, tasksDone: this._tasksDone })
    this._tasksDone = 0
    this._completed.clear()
    this._searching = true

    this._emitStatus()
    this._pickBestRequester()
  }

  _pickBestRequester () {
    if (!this._searching) return

    const candidates = []
    for (const [id, info] of this._availableRequesters) {
      if (Date.now() - info.ts > 30000) continue
      if (info.pendingTasks <= 0) continue
      if (info.conn.destroyed) continue
      candidates.push({ id, info, score: info.reputation?.score ?? 0 })
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.info.pendingTasks - a.info.pendingTasks
    })

    if (candidates.length > 0) {
      const pick = candidates[0]
      this._joinRequester(pick.id, pick.info.autobaseKey, pick.info.conn).catch((err) => {
        this.emit('error', { message: `Failed to join ${pick.id}: ${err.message}` })
        this._searching = true
        this._currentRequester = null
      })
    }
  }

  async _joinRequester (requesterId, autobaseKey, conn) {
    if (!this._searching || this._joining) return
    this._searching = false
    this._joining = true
    this._currentRequester = requesterId

    if (this._outputDrive) {
      try { await this._outputDrive.close() } catch {}
      this._outputDrive = null
    }

    fs.rmSync(this.storePath, { recursive: true, force: true })
    this._store = new Corestore(this.storePath)
    this._base = new Autobase(this._store, Buffer.from(autobaseKey, 'hex'), {
      valueEncoding: 'json',
      open: (s) => s.get('view', { valueEncoding: 'json' }),
      apply: async (nodes, view, b) => {
        for (const node of nodes) {
          if (node.value.type === 'add-writer') {
            try { await b.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: false }) } catch {}
          }
          await view.append(node.value)
        }
      }
    })
    await this._base.ready()

    this._currentDiscoveryKey = this._base.discoveryKey
    const writerKey = this._base.local.key.toString('hex')

    this._outputDrive = new Hyperdrive(this._store)
    await this._outputDrive.ready()
    this._mountedDrives.clear()

    conn.write(JSON.stringify({ type: 'join-request', role: 'worker', writerKey, workerId: this.workerId }))

    this._replicationSwarm.join(this._base.discoveryKey, { client: true, server: true })
    for (const c of this._replicationSwarm.connections) this._store.replicate(c)
    await this._replicationSwarm.flush()

    this._base.on('update', async () => {
      if (this._base && this._base.writable) await this._processTasks()
    })

    if (this._taskPollTimer) clearInterval(this._taskPollTimer)
    this._taskPollTimer = setInterval(async () => {
      if (!this._base || this._searching) { clearInterval(this._taskPollTimer); this._taskPollTimer = null; return }
      try {
        await this._base.update()
        if (this._base.writable) await this._processTasks()
      } catch {}
    }, 2000)

    this._joining = false
    this._resetIdleTimer()
    this.emit('joined', { requesterId })
    this._emitStatus()
  }

  async _processTasks () {
    if (!this._base || !this._base.writable || this._processing) return
    this._processing = true
    let didWork = false

    try {
      for (let i = 0; i < this._base.view.length; i++) {
        const entry = await this._base.view.get(i)
        if (entry.type !== 'task' || this._completed.has(entry.id)) continue
        if (entry.taskType === 'shell') {
          if (!this.allowShell || !entry.cmd) continue
        } else {
          if (!entry.code) continue
        }
        if (entry.assignedTo && entry.assignedTo !== this.workerId) continue

        let hasResult = false
        for (let j = 0; j < this._base.view.length; j++) {
          const e = await this._base.view.get(j)
          if (e.type === 'result' && e.taskId === entry.id) { hasResult = true; break }
        }
        if (hasResult) { this._completed.add(entry.id); continue }

        this._completed.add(entry.id)
        didWork = true
        this._stopIdleTimer()

        const preview = entry.taskType === 'shell'
          ? `[shell] ${entry.cmd.trim().slice(0, 60)}`
          : entry.code.trim().replace(/\s+/g, ' ').slice(0, 60)

        this.emit('task-start', { taskId: entry.id, preview, jobId: entry.jobId, chunkIndex: entry.chunkIndex })

        let inputDrive = null
        if (entry.driveKey && this._store) {
          if (!this._mountedDrives.has(entry.driveKey)) {
            const d = new Hyperdrive(this._store, Buffer.from(entry.driveKey, 'hex'))
            await d.ready()
            this._mountedDrives.set(entry.driveKey, d)
          }
          inputDrive = this._mountedDrives.get(entry.driveKey)
          for (let attempt = 0; attempt < 10; attempt++) {
            await inputDrive.update()
            if (inputDrive.version > 0) break
            await new Promise(r => setTimeout(r, 500))
          }
        }

        const t0 = Date.now()
        try {
          const output = await executeTask(entry, inputDrive, this._outputDrive)
          const elapsed = Date.now() - t0

          const outputFiles = []
          if (this._outputDrive) {
            for await (const f of this._outputDrive.list('/')) outputFiles.push(f.key)
          }

          await this._base.append({
            type: 'result', taskId: entry.id, output,
            elapsed, by: this.workerId, ts: Date.now(),
            driveKey: this._outputDrive ? this._outputDrive.key.toString('hex') : undefined,
            outputFiles: outputFiles.length > 0 ? outputFiles : undefined
          })
          this._tasksDone++
          this._totalTasksDone++
          addDonated(1)
          this.emit('task-done', { taskId: entry.id, elapsed, output, jobId: entry.jobId, chunkIndex: entry.chunkIndex })
        } catch (err) {
          await this._base.append({ type: 'result', taskId: entry.id, error: err.message, by: this.workerId, ts: Date.now() })
          this.emit('task-error', { taskId: entry.id, error: err.message })
        }
        this._resetIdleTimer()
        this._emitStatus()
      }
    } finally {
      this._processing = false
    }

    if (didWork) {
      let hasRemaining = false
      for (let i = 0; i < this._base.view.length; i++) {
        const entry = await this._base.view.get(i)
        if (entry.type !== 'task') continue
        if (entry.taskType === 'shell' ? (!this.allowShell || !entry.cmd) : !entry.code) continue
        if (entry.assignedTo && entry.assignedTo !== this.workerId) continue
        if (this._completed.has(entry.id)) continue
        hasRemaining = true
        break
      }

      if (!hasRemaining) {
        for (const [id, info] of this._availableRequesters) {
          if (id !== this._currentRequester && info.pendingTasks > 0 && Date.now() - info.ts < 30000) {
            this._leaveCurrentRequester()
            break
          }
        }
      }
    }
  }

  async stop () {
    this._stopIdleTimer()
    if (this._taskPollTimer) clearInterval(this._taskPollTimer)
    if (this._discoverySwarm) await this._discoverySwarm.destroy()
    if (this._replicationSwarm) await this._replicationSwarm.destroy()
    if (this._base) try { await this._base.close() } catch {}
    fs.rmSync(this.storePath, { recursive: true, force: true })
  }
}
