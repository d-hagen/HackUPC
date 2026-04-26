# PeerCompute — Architecture

## Overview

PeerCompute is a peer-to-peer distributed compute platform built on the Pear/Holepunch stack.
Any machine can act as a **Requester** (submits tasks), a **Worker** (executes tasks), or both.
There is no central server. Peers discover each other over Hyperswarm DHT.

---

## Process Model

The desktop app runs as two processes connected by a duplex pipe (fd-3):

```
┌─────────────────────────────────────────────────────────────────────────┐
│  RENDERER PROCESS  (Electron web page)                                  │
│  File: app/app.js                                                       │
│                                                                         │
│  • Renders the UI (HTML/CSS)                                            │
│  • Owns all UI state (tasks, workers, jobs maps)                        │
│  • Sends commands to main via pipe                                      │
│  • Receives events from main via pipe                                   │
│  • No direct access to Node/Bare APIs or the filesystem                 │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │  pear-pipe  (Electron internal IPC, fd-3)
                           │  Protocol: newline-delimited JSON
                           │  {"type":"submit-task","payload":{...}}\n
                           │
┌──────────────────────────▼──────────────────────────────────────────────┐
│  MAIN PROCESS  (Bare/Node runtime)                                      │
│  File: app/index.js                                                     │
│                                                                         │
│  • Receives commands from renderer in handleCmd()                       │
│  • Broadcasts events back to renderer via broadcast()                   │
│  • Owns RequesterCore and WorkerCore instances                          │
│  • Has full access to filesystem, network, Hyperswarm                   │
└──────────────────────────┬────────────────────┬────────────────────────┘
                           │                    │
              ┌────────────▼────────┐  ┌────────▼────────────┐
              │  RequesterCore      │  │  WorkerCore         │
              │  requester-core.js  │  │  worker-core.js     │
              └────────────┬────────┘  └────────┬────────────┘
                           │                    │
              ┌────────────▼────────────────────▼────────────┐
              │  Hyperswarm DHT  (peer-to-peer network)       │
              │  Two swarm instances per node:                │
              │   • discoverySwarm  — JSON signaling          │
              │   • replicationSwarm — Autobase/core sync     │
              └───────────────────────────────────────────────┘
```

---

## IPC Protocol (Renderer ↔ Main)

Every message is a single JSON line terminated by `\n`.

### Renderer → Main  (`send(type, payload)` in app.js → `handleCmd()` in index.js)

| type | payload | what happens |
|---|---|---|
| `start-requester` | `{}` | Creates RequesterCore, joins network |
| `start-worker` | `{ hw, threads, allowShell }` | Creates WorkerCore, joins network |
| `stop-requester` | `{ force? }` | Calls requester.stop(); if pending tasks and no force, replies with stop-blocked |
| `stop-worker` | `{}` | Calls worker.stop() |
| `submit-task` | `{ code, requirements, timeout }` | requester.submitTask(code) |
| `submit-job` | `{ filePath, n, requirements }` | requester.submitJob(filePath, n) |
| `submit-shell` | `{ cmd, requirements, timeout }` | requester.submitShell(cmd, timeout) |
| `upload-file` | `{ localPath, remotePath }` | requester.uploadFile(localPath, remotePath) |
| `get-status` | `{}` | Polls both cores and broadcasts status events (every 3s) |

### Main → Renderer  (`broadcast(type, payload)` in index.js → `handleMsg()` in app.js)

| type | payload | UI reaction |
|---|---|---|
| `connected` | `{}` | Sets network dot to "Ready", starts status poll interval |
| `requester-ready` | `{ requesterId }` | Shows stats/graph/worker panels, swaps launch→stop button |
| `worker-ready` | `{ workerId }` | Shows self panel, swaps launch→stop button |
| `worker-joined` | `{ workerId }` | Adds worker to sidebar list + peer graph |
| `task-posted` | `{ taskId, preview }` | Adds task card (Pending) to Task Queue |
| `job-posted` | `{ jobId, totalChunks, fileName }` | Logs job start; if mandelbrot → switches to Mandelbrot tab |
| `result` | `{ taskId, output, error, elapsed, by }` | Updates task card to Done/Error |
| `chunk-done` | `{ jobId, chunkIndex, totalChunks, output, by, elapsed }` | Paints mandelbrot canvas tile |
| `job-complete` | `{ jobId, errors }` | Logs completion |
| `requester-status` | `{ workers, pendingTasks, resultsReceived, reputation }` | Updates sidebar stat numbers |
| `worker-status` | `{ workerId, searching, currentRequester, totalTasksDone, reputation }` | Updates worker self panel |
| `worker-authorized` | `{ requesterId }` | Logs "Join accepted" in worker log |
| `worker-joined-requester` | `{ requesterId }` | Network dot → green "Computing" |
| `worker-left-requester` | `{ requesterId, tasksDone }` | Network dot → yellow "Searching…" |
| `requester-found` | `{ requesterId, pendingTasks, reputation }` | Logs requester discovery in worker log |
| `task-start` | `{ taskId, preview, jobId, chunkIndex }` | Logs task start in worker log |
| `task-done` | `{ taskId, elapsed, jobId, chunkIndex }` | Logs task completion in worker log |
| `task-error` | `{ taskId, error }` | Logs error in worker log |
| `file-uploaded` | `{ remotePath, bytes }` | Toast + log |
| `stop-blocked` | `{ role, pending }` | Shows confirmation modal |
| `requester-stopped` | `{}` | Resets requester UI to pre-launch state |
| `worker-stopped` | `{}` | Resets worker UI, unlocks settings |
| `error` | `{ message }` | Error toast + log in both panels |

---

## P2P Network Layer

### Discovery (JSON signaling over Hyperswarm)

All peers join the same `NETWORK_TOPIC` (a fixed 32-byte hash in `base-setup.js`).
This swarm is used for **advertisement and handshake only** — raw JSON messages.

```
Requester broadcasts every 10s:
  { type:'advertise', role:'requester', requesterId, autobaseKey,
    pendingTasks, workerCount, reputation }

Worker receives 'advertise':
  → stores requester info in _availableRequesters map
  → emits 'requester-found' (shown in worker Activity Log)
  → if searching and pendingTasks > 0, calls _pickBestRequester()

Worker sends join request:
  { type:'join-request', role:'worker', writerKey, workerId }

Requester receives 'join-request':
  → adds worker as Autobase writer
  → replies: { type:'join-accepted', autobaseKey }

Worker receives 'join-accepted':
  → emits 'authorized' (logged: "Join accepted by requester")
  → starts Autobase replication
  → emits 'joined' (logged: "Joined requester: ...")
```

### Replication (Autobase/Hypercore over a separate Hyperswarm)

A second swarm joins `base.discoveryKey` for core replication only.
Autobase ensures both requester and worker see the same append-only log.

```
Requester appends to Autobase:
  { type:'task', id, code, args, assignedTo, driveKey, ... }

Worker reads Autobase view:
  → finds unprocessed tasks assigned to it (or unassigned)
  → executes task
  → appends result: { type:'result', taskId, output, elapsed, by, ... }

Requester reads Autobase view:
  → detects new result entries in _processResults()
  → emits 'result' or 'chunk-done' + 'job-complete'
```

### File transfer (Hyperdrive)

Large data is shared via Hyperdrive (a distributed filesystem over Hypercore).
- Requester writes files to its drive, passes `driveKey` in each task record
- Worker mounts the drive by key, reads input files before executing
- Worker writes output files to its own `_outputDrive`

---

## Worker Selection Logic

Workers score requesters by reputation and pick the best one:

```
score = requester.reputation.score   (donated - consumed)
tiebreak = pendingTasks count        (prefer busier requester)

Requester is ignored if:
  • last seen > 30s ago
  • pendingTasks == 0
  • connection is destroyed
```

Workers leave a requester after `IDLE_TIMEOUT` (15s) with no new tasks,
then immediately re-run `_pickBestRequester()` to find another.

---

## Reputation System (`reputation.js`)

Tracks work done locally per node (stored in a JSON file):
- **donated**: tasks completed as a worker (good)
- **consumed**: tasks submitted as a requester (cost)
- **score** = donated − consumed

Requesters advertise their score. Workers prefer high-score requesters,
creating an incentive to contribute compute back to the network.

---

## File Structure

```
app/
├── index.js          Main process: pipe server, core lifecycle, command router
├── app.js            Renderer: UI logic, pipe client, DOM updates
├── index.html        UI markup: requester view + worker view
├── style.css         Dark theme UI styles
├── requester-core.js RequesterCore EventEmitter — network + Autobase requester logic
├── worker-core.js    WorkerCore EventEmitter — task execution + network worker logic
├── worker.js         executeTask() — sandboxed JS/shell task runner
├── base-setup.js     createBase() helper — Corestore + Autobase + Hyperdrive init
├── reputation.js     Reputation load/save/score helpers
├── bundler.js        Task bundler (esbuild) for multi-file tasks
├── compat.js         Shims: fetch, process, Buffer for Bare runtime
└── jobs/             Example job files (mandelbrot, primes, sum, etc.)
```

---

## What the Worker Log Shows

Every event the worker experiences from the network is logged in the **Activity Log** tab:

| Event | Log message |
|---|---|
| Worker process starts | `Launching worker — cpu+gpu, 4 threads` |
| Worker ready on network | `Worker ready — worker-xxxxxxxx` |
| Requester discovered (any peer) | `Requester found: requester-xxxxxxxx — N pending task(s), reputation +5` |
| Join request accepted | `Join accepted by requester: requester-xxxxxxxx` |
| Fully joined requester | `Joined requester: requester-xxxxxxxx` |
| Task received and started | `Task started: "return 2+2"` |
| Task completed | `Task done in 12ms` |
| Task failed | `Task error: <message>` |
| Left requester (idle/done) | `Left requester requester-xxxxxxxx — 3 task(s) done this session` |
| Worker stopped | `Worker stopped.` |

**Yes — tasks from any peer's requester appear in the log**, not just your own.
The worker doesn't know or care whether the requester is running on the same machine or a friend's laptop across the internet. It sees all requesters on the Hyperswarm topic.
