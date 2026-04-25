# PeerCompute — Project Snapshot & Roadmap

**P2P shared computing platform on the Pear protocol. No servers, no cloud — peers share CPU power over Hypercore.**

---

## What's Built (Working)

### Core System
| Component | File | Status |
|---|---|---|
| **Requester CLI** | `request-compute.js` | Done — hosts Autobase, advertises on network, assigns tasks, collects results |
| **Worker CLI** | `offer-compute.js` | Done — discovers requesters, joins, executes tasks, roams when idle |
| **Generic task executor** | `worker.js` | Done — runs arbitrary JS function bodies via `AsyncFunction` |
| **Shared Autobase setup** | `base-setup.js` | Done — creates Autobase + Hyperswarm, handles local/public DHT |
| **Reputation system** | `reputation.js` | Done — local ledger (donated/consumed), score broadcast in advertisements |

### Task Distribution
| Feature | Status |
|---|---|
| **Single task execution** | Done — `run <code>` sends any JS to a worker |
| **File-based tasks** | Done — `file <path.js>` sends a .js file as task |
| **Distributed jobs (split/join)** | Done — `job <path.js> [n]` splits data across N workers, joins results |
| **Worker assignment** | Done — round-robin `assignedTo` prevents duplicate computation |

### Marketplace Model
| Feature | Status |
|---|---|
| **Auto-discovery** | Done — shared network topic, no keys to exchange |
| **Multi-requester support** | Done — each requester hosts own Autobase, workers roam between them |
| **Idle timeout + roaming** | Done — workers leave after 15s idle, find next requester |
| **Reputation-based ranking** | Done — workers prefer higher-reputation requesters |
| **Unique worker stores** | Done — `store-${workerId}` avoids collisions |
| **Proper cleanup on leave** | Done — closes base, leaves topic, clears pool |

### Example Jobs
| Job | File | What it does |
|---|---|---|
| Sum array | `jobs/sum-job.js` | Splits 1000 numbers, sums in parallel, joins |
| Find primes | `jobs/primes-job.js` | Splits range, sieves in parallel, merges sorted |
| Mandelbrot | `jobs/mandelbrot-job.js` | Splits image into row chunks, renders in parallel, assembles ASCII art |

### Tests & Demos
| File | What it tests |
|---|---|
| `demo.js` | Self-contained: matrix multiply + Mandelbrot with Hyperswarm fallback |
| `demo-generic.js` | 6 different generic tasks (arithmetic, fibonacci, matrix, primes, sort, mandelbrot) |
| `test-full.js` | Matrix + Mandelbrot via `replicateAndSync` |
| `test-jobs.js` | Split/join with 2 workers, all 3 job types |
| `test-marketplace.js` | 2 requesters + 2 workers, isolation verification |

---

## What's Missing / Next Steps

### 1. Real Large-Scale Computing Tasks

**Current limitation:** Tasks must be pure JS function bodies with JSON-serializable I/O. No imports, no files, no GPU, no binary data.

| Feature | What | Why | Effort |
|---|---|---|---|
| **Subprocess execution** | Workers run shell commands (`python script.py`, `blender -b`, `ffmpeg`) via `child_process` | Unlocks any language/tool, not just JS | Medium |
| **File transfer via Hyperdrive** | Send/receive files (datasets, images, models) alongside tasks | JSON can't carry GBs of data | Medium |
| **Binary data support** | `Buffer`/`ArrayBuffer` encoding (base64 or Hypercore blocks) | Images, audio, model weights | Low |
| **npm/module support** | Bundle dependencies with task code, or pre-install on workers | Real code needs libraries | Medium |
| **Task timeout + kill** | Wrap execution in child process, kill after N seconds | Infinite loops block workers forever | Low |
| **Worker thread pool** | `worker_threads` for parallel task execution per worker | One task at a time wastes multi-core CPUs | Medium |
| **WASM sandbox** | Execute WASM modules for safe, portable, near-native compute | Security + performance + language-agnostic | High |
| **GPU access** | WebGPU/WGSL or native CUDA passthrough | ML inference, rendering, crypto | High |
| **Streaming results** | Partial/progress updates during long tasks | Users need feedback on 10-min renders | Low |
| **Task dependencies** | DAG of tasks: B runs only after A completes | Multi-stage pipelines (preprocess → train → evaluate) | Medium |

**Priority for demo:** Subprocess execution + file transfer would unlock rendering and ML inference immediately.

### 2. UI & App

**Current state:** CLI only (readline prompt).

| Feature | What | Effort |
|---|---|---|
| **Pear desktop app** | GUI using Pear Runtime's built-in UI (HTML/CSS/JS) | Medium |
| **Live task dashboard** | Connected peers, task queue (pending/running/done), results | Medium |
| **Drag-and-drop task submission** | Drop a .js or .py file to submit as task | Low |
| **Real-time Mandelbrot viewer** | Tiles render live as workers compute them | Medium |
| **Worker stats panel** | CPU usage, tasks completed, uptime, reputation | Low |
| **Peer network graph** | Visual map of connected peers and data flow | Medium |
| **Terminal UI (blessed/ink)** | Rich CLI with panels, progress bars, live updates (no browser needed) | Medium |

**Priority for demo:** Terminal UI with live task progress would be highest impact for least effort. Pear desktop app is the "real" version.

### 3. Refine Task Splitting

**Current state:** Job files define `split()`, `compute()`, `join()`. Splitting is manual and static.

| Feature | What | Effort |
|---|---|---|
| **Auto-split by worker count** | Default `n = workers.size`, auto-adjust as workers join/leave | Low (partially done) |
| **Adaptive chunk sizing** | Benchmark workers, give bigger chunks to faster ones | Medium |
| **Work stealing** | If worker A finishes early, it takes a chunk from worker B's queue | Medium |
| **Streaming split** | For huge datasets: split lazily, stream chunks as workers request | High |
| **Auto-retry failed chunks** | If a worker crashes, reassign its chunks to other workers | Low |
| **Progress tracking per chunk** | Show which chunks are pending/running/done in real-time | Low |
| **Built-in splitters** | Library of common split patterns: by rows, by array slice, by file list | Low |
| **Recursive splitting** | If a chunk is too large for one worker, it can sub-split | High |

**Priority:** Auto-retry + progress tracking are quick wins. Work stealing is the impressive demo feature.

### 4. Pay-for-Compute (Concept)

**Current state:** Reputation is `donated - consumed`, self-reported, local only. Not a payment system.

| Level | What | Feasibility |
|---|---|---|
| **Credit ledger (current)** | Track compute donated/consumed per peer. Self-reported. | Done |
| **Attestation-based credits** | Workers sign attestations of compute delivered. Requesters can verify. | Medium — needs crypto signatures |
| **Token/credit system** | Peers earn credits for computing, spend credits for requesting. Tracked in a shared Autobase. | Medium — needs shared state + anti-cheat |
| **Blockchain settlement** | Actual payments via Ethereum/Solana smart contracts. Workers get paid per task. | Out of scope — but architecture supports it as a layer |
| **Dummy marketplace UI** | Show "balance: 50 credits" and "cost: 3 credits" in the UI. No real money. | Low — UI only, demonstrates the concept |

**Priority for hackathon:** Dummy marketplace UI showing credits being earned and spent. No real payment needed — just show the flow.

### 5. Other Improvements

| Feature | What | Effort |
|---|---|---|
| **Result verification** | Send same task to 2 workers, compare results. Flag mismatches. | Low |
| **Capability announcement** | Workers report CPU cores, RAM, GPU. Requesters route tasks to best fit. | Low |
| **Encryption (optional)** | Encrypt task data for specific worker's public key. Worker decrypts, computes, encrypts result. | High |
| **Churn recovery** | If worker disconnects mid-task, timeout → reassign to another worker | Low |
| **Peer health monitoring** | Heartbeat messages, detect dead workers, remove from pool | Low |
| **Rate limiting** | Prevent spam: max tasks per minute per requester | Low |
| **Logging & metrics** | Structured logs, compute time histograms, network stats | Low |
| **Config file** | `peercompute.json` for idle timeout, store path, bootstrap, etc. | Low |

---

## Architecture

```
┌─────────────────┐         NETWORK_TOPIC          ┌─────────────────┐
│  Requester A    │◄──────── Hyperswarm DHT ───────►│  Worker 1       │
│                 │          (discovery)            │                 │
│  Own Autobase   │                                │  Joins A or B   │
│  Posts tasks    │◄─── advertise { score: 5 } ───►│  based on       │
│  Collects       │                                │  reputation     │
│  results        │         Autobase replication    │  score          │
│                 │◄──────────────────────────────►│                 │
└─────────────────┘                                └─────────────────┘

┌─────────────────┐                                ┌─────────────────┐
│  Requester B    │◄──────── Hyperswarm DHT ───────►│  Worker 2       │
│                 │          (discovery)            │                 │
│  Own Autobase   │                                │  Roams between  │
│  Posts tasks    │◄─── advertise { score: -2 } ──►│  requesters     │
│  Collects       │                                │  when idle      │
│  results        │         Autobase replication    │                 │
│                 │◄──────────────────────────────►│                 │
└─────────────────┘                                └─────────────────┘
```

## File Structure

```
app/
├── request-compute.js     # Requester CLI (main entry point)
├── offer-compute.js       # Worker CLI (main entry point)
├── base-setup.js          # Shared Autobase + Hyperswarm setup
├── worker.js              # Generic JS task executor
├── reputation.js          # Local reputation ledger
├── boot.js                # Local DHT bootstrap (for testing)
├── jobs/                  # Example distributed jobs
│   ├── sum-job.js
│   ├── primes-job.js
│   └── mandelbrot-job.js
├── mandelbrot.js          # Mandelbrot compute functions
├── matrix.js              # Matrix multiply functions
├── demo.js                # Self-contained demo (single process)
├── demo-generic.js        # Generic task demo (6 task types)
├── test-*.js              # Test scripts
├── peer-a.js / peer-b.js  # Earlier peer prototypes
└── package.json
```

## Quick Start

```bash
# Laptop 1 (requester)
cd app && npm install
node request-compute.js

# Laptop 2 (worker)
cd app && npm install
node offer-compute.js

# In requester prompt:
run return 2 + 2
job jobs/mandelbrot-job.js 4
status
```
