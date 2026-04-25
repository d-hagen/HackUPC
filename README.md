# PeerCompute

**A zero-infrastructure P2P compute-sharing platform built on the Pear protocol. Your swarm is your supercomputer.**

No servers, no cloud, no blockchain, no tokens — just peers sharing CPU power over Hypercore.

---

## What Is This?

PeerCompute turns idle laptops into a distributed supercomputer. Anyone can **offer** spare CPU power or **request** computation from the network. Peers discover each other automatically via Hyperswarm DHT, exchange tasks through Autobase (a distributed append-only log), and route work based on a reputation system — all without a single server.

### Why It Matters

Every existing P2P compute platform requires significant infrastructure: BOINC needs a central server, Golem needs Ethereum and Docker, Render Network needs blockchain custody. PeerCompute needs **nothing** — two laptops and `npm install`.

The core innovation is using **Autobase as a distributed task queue**. Nobody has done this before. Autobase was designed for syncing documents (like Keet chat or PearPass). We repurpose it as an event-sourced job scheduler: tasks, claims, and results are all entries in the same append-only log, replicated across peers via Hyperswarm.

### How It Works

1. **Requester** starts up, creates an Autobase, and advertises on the network with a reputation score
2. **Workers** discover available requesters, pick the highest-reputation one with pending tasks, and join
3. Workers announce their **hardware capabilities** (GPU, CPU cores, RAM, Python/PyTorch availability) — requesters route tasks to the best-fit worker
4. Requester posts tasks — single JS functions, bundled modules with npm dependencies, shell commands, or distributed jobs that **split** data across N workers
5. Workers execute tasks, write results back to the Autobase
6. For distributed jobs, the requester **joins** all chunk results into a final output
7. When idle, workers automatically roam to find the next requester with work

### How It Compares

| | **PeerCompute** | **BOINC** | **Golem** | **Render Network** |
|---|---|---|---|---|
| Infrastructure | None | Central server | Ethereum + Docker | Blockchain |
| Setup | `npm install` | Install client + project app | Install Golem + Docker + yagna | OctaneRender + RNDR app |
| Payment | Reputation (no money) | Volunteer only | ETH/GLM tokens | RNDR tokens |
| Task queue | Autobase P2P log | Server database | Smart contracts | Centralized |
| Dependency bundling | esbuild (auto-inlined) | Manual packaging | Docker containers | N/A |
| Hardware routing | Auto-detect GPU/CPU/RAM | Manual project selection | Provider profiles | Manual selection |
| Code | ~1,500 lines JS | Tens of thousands | Tens of thousands + Docker | Proprietary |

### Why This Matters for Pear/Holepunch

Pear's showcase apps today are **Keet** (chat/video) and **PearPass** (password manager) — both are data sync and storage. PeerCompute proves the Pear stack can do something entirely new: **distributed computation**.

- **New category for the platform.** Autobase was built for syncing documents. We show it works as a job scheduler — tasks, claims, results, reputation, all in the same append-only log. This expands what developers think Pear is for.
- **"The Cloud does not exist" taken further.** Pear's slogan is about eliminating servers for data. PeerCompute eliminates servers for compute too. The full vision: storage, communication, AND computation — all P2P on one protocol stack.
- **Zero-infrastructure pitch.** If Pear wants to attract enterprise or developer adoption beyond chat apps, "P2P compute with zero setup" is a compelling story that no other platform can tell this simply.

---

## What's Built (Working)

### Core System
| Component | File | Status |
|---|---|---|
| **Requester CLI** | `request-compute.js` | Done — hosts Autobase, advertises on network, assigns tasks, collects results |
| **Worker CLI** | `offer-compute.js` | Done — discovers requesters, joins, executes tasks, roams when idle |
| **Generic task executor** | `worker.js` | Done — runs arbitrary JS function bodies via `AsyncFunction`, shell commands via subprocess |
| **Shared Autobase setup** | `base-setup.js` | Done — creates Autobase + Hyperswarm + Hyperdrive, handles local/public DHT |
| **Reputation system** | `reputation.js` | Done — local ledger (donated/consumed), score broadcast in advertisements |
| **File transfer (Hyperdrive)** | `base-setup.js` + `worker.js` | Done — upload/download files between peers, task code gets `readFile()`/`writeFile()` |
| **npm/module bundler** | `bundler.js` | Done — bundles task code + all npm dependencies into a self-contained string via esbuild. Workers don't need packages pre-installed |
| **Hardware capability detection** | `capabilities.js` | Done — detects GPU (CUDA/MPS/ROCm), CPU cores, RAM, Python, PyTorch. Workers announce capabilities, requesters route tasks to best-fit worker |

### Task Types
| Feature | Status |
|---|---|
| **Single task execution** | Done — `run <code>` sends any JS to a worker |
| **File-based tasks** | Done — `file <path.js>` sends a .js file as task |
| **Bundled tasks with npm deps** | Done — `bundle <path.js> [args]` uses esbuild to inline all npm imports, workers execute without needing packages installed |
| **Distributed jobs (split/join)** | Done — `job <path.js> [n]` splits data across N workers, joins results |
| **Shell command execution** | Done — `shell <command>` runs any shell command on a worker (`ALLOW_SHELL=1`) |
| **Task timeout + kill** | Done — shell tasks have configurable timeout (default 60s), SIGKILL on expiry |
| **Worker assignment** | Done — round-robin `assignedTo` prevents duplicate computation |

### Capability-Based Routing
| Feature | Status |
|---|---|
| **GPU detection** | Done — NVIDIA CUDA via `nvidia-smi`, Apple Silicon MPS via `sysctl`, AMD ROCm via `rocm-smi` |
| **CPU/RAM profiling** | Done — core count, memory, architecture, platform |
| **Python/PyTorch detection** | Done — version check, CUDA/MPS availability for PyTorch |
| **Requirement matching** | Done — `meetsRequirements(requires, caps)` checks GPU, CPU, RAM, platform, Python, shell access |
| **Smart worker selection** | Done — `pickWorkerForTask()` filters eligible workers, sorts by GPU then CPU cores |
| **PyTorch device routing** | Done — `bestTorchDevice()` returns optimal device string (cuda/mps/cpu) |

### Marketplace Model
| Feature | Status |
|---|---|
| **Auto-discovery** | Done — shared network topic, no keys to exchange |
| **Multi-requester support** | Done — each requester hosts own Autobase, workers roam between them |
| **Idle timeout + roaming** | Done — workers leave after 15s idle, find next requester |
| **Reputation-based ranking** | Done — workers prefer higher-reputation requesters |
| **Unique worker stores** | Done — `store-${workerId}` avoids collisions |
| **Proper cleanup on leave** | Done — closes base, leaves topic, clears pool |

### Reliability
| Feature | Status |
|---|---|
| **Worker rejoin guard** | Done — `joining` flag prevents concurrent join attempts |
| **Broadcast connection tracking** | Done — maintains active connection set, cleans up on close/error |
| **Stale core handling** | Done — try/catch around `addWriter` in apply prevents stale cores from blocking the view |
| **Race condition fixes** | Done — atomic state transitions, guard flags for concurrent operations |

### Example Bundled Tasks
| Task | File | What it does |
|---|---|---|
| Duration formatter | `tasks/hello-ms.js` | Bundles the `ms` npm package to format milliseconds |
| URL slug generator | `tasks/slugify-text.js` | Bundles the `slugify` npm package to create URL-safe strings |
| Byte formatter | `tasks/format-bytes.js` | Bundles `ms` + custom logic with argument forwarding |

### Example Distributed Jobs
| Job | File | What it does |
|---|---|---|
| Sum array | `jobs/sum-job.js` | Splits 1000 numbers, sums in parallel, joins |
| Find primes | `jobs/primes-job.js` | Splits range, sieves in parallel, merges sorted |
| Mandelbrot | `jobs/mandelbrot-job.js` | Splits image into row chunks, renders in parallel, assembles ASCII art |
| GPU benchmark | `jobs/gpu-benchmark-job.js` | Splits matrix sizes across workers, benchmarks GPU via PyTorch |
| Statistics (Python) | `jobs/stats-task.js` + `jobs/stats.py` | Computes sum/count/min/max/mean on data via Python subprocess |

### Tests & Demos
| File | What it tests |
|---|---|
| `test/index.test.js` | 20+ bundling tests — npm dep inlining, execution, error propagation |
| `test/slugify-bundle.test.js` | 14 slugify-specific tests — special chars, unicode, edge cases |
| `test/test-capabilities.js` | 39 capability tests — requirement matching, worker selection, device routing |
| `test/test-pipeline.js` | Full E2E pipeline — upload Python script to Hyperdrive, split data, workers run Python, join results |
| `demos/demo.js` | Self-contained: matrix multiply + Mandelbrot with Hyperswarm fallback |
| `demos/demo-generic.js` | 6 different generic tasks (arithmetic, fibonacci, matrix, primes, sort, mandelbrot) |
| `test/test-full.js` | Matrix + Mandelbrot via `replicateAndSync` |
| `test/test-jobs.js` | Split/join with 2 workers, all 3 job types |
| `test/test-marketplace.js` | 2 requesters + 2 workers, isolation verification |
| `test/test-hyperdrive.js` | File upload/download between requester and worker via Hyperdrive |

---

## What's Missing / Next Steps

### 1. Scaling & Performance

| Feature | What | Effort |
|---|---|---|
| **Worker thread pool** | `worker_threads` for parallel task execution per worker | Medium |
| **WASM sandbox** | Execute WASM modules for safe, portable, near-native compute | High |
| **GPU access (native)** | WebGPU/WGSL or native CUDA passthrough (currently possible via shell + PyTorch) | High |
| **Streaming results** | Partial/progress updates during long tasks | Low |
| **Task dependencies** | DAG of tasks: B runs only after A completes | Medium |

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

### 3. Refine Task Splitting

| Feature | What | Effort |
|---|---|---|
| **Adaptive chunk sizing** | Benchmark workers, give bigger chunks to faster ones | Medium |
| **Work stealing** | If worker A finishes early, it takes a chunk from worker B's queue | Medium |
| **Streaming split** | For huge datasets: split lazily, stream chunks as workers request | High |
| **Auto-retry failed chunks** | If a worker crashes, reassign its chunks to other workers | Low |
| **Progress tracking per chunk** | Show which chunks are pending/running/done in real-time | Low |
| **Built-in splitters** | Library of common split patterns: by rows, by array slice, by file list | Low |

### 4. Pay-for-Compute (Concept)

**Current state:** Reputation is `donated - consumed`, self-reported, local only. Not a payment system.

| Level | What | Feasibility |
|---|---|---|
| **Credit ledger (current)** | Track compute donated/consumed per peer. Self-reported. | Done |
| **Attestation-based credits** | Workers sign attestations of compute delivered. Requesters can verify. | Medium — needs crypto signatures |
| **Token/credit system** | Peers earn credits for computing, spend credits for requesting. Tracked in a shared Autobase. | Medium — needs shared state + anti-cheat |
| **Blockchain settlement** | Actual payments via Ethereum/Solana smart contracts. Workers get paid per task. | Out of scope — but architecture supports it as a layer |

### 5. Other Improvements

| Feature | What | Effort |
|---|---|---|
| **Encryption (optional)** | Encrypt task data for specific worker's public key | High |
| **Churn recovery** | If worker disconnects mid-task, timeout and reassign to another worker | Low |
| **Peer health monitoring** | Heartbeat messages, detect dead workers, remove from pool | Low |
| **Rate limiting** | Prevent spam: max tasks per minute per requester | Low |
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
                                                     capabilities:
                                                     GPU, CPU, RAM,
                                                     Python, PyTorch
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

### Dual-Swarm Design

The system uses **two separate Hyperswarm instances** per peer:

1. **Discovery swarm** (joins `NETWORK_TOPIC`): lightweight JSON signaling — requesters broadcast advertisements (reputation score, pending task count), workers send join-requests with their hardware capabilities.
2. **Replication swarm** (joins `base.discoveryKey`): binary Protomux protocol for Autobase + Corestore + Hyperdrive replication.

Mixing JSON writes with binary replication on the same swarm corrupts the Protomux protocol. Never combine them.

### Task Bundling Pipeline

```
task.js (imports npm packages)
        │
        ▼
   esbuild (bundle: true, platform: node)
        │
        ▼
   Self-contained code string (all deps inlined)
        │
        ▼
   Posted to Autobase as task entry
        │
        ▼
   Worker executes via AsyncFunction (no npm install needed)
```

### Capability-Based Routing

```
Worker announces:  { gpu: 'NVIDIA RTX 4090', cores: 16, ram: 32,
                     hasCUDA: true, hasPyTorch: true, ... }

Task requires:     { hasGPU: true, hasPyTorch: true, minCores: 8 }

pickWorkerForTask() → filters eligible → sorts by GPU, then cores → assigns
```

## File Structure

```
app/
├── request-compute.js     # Requester CLI (main entry point)
├── offer-compute.js       # Worker CLI (main entry point)
├── base-setup.js          # Shared Autobase + Hyperswarm setup
├── worker.js              # Generic JS/shell task executor
├── bundler.js             # esbuild task bundler (inlines npm deps)
├── capabilities.js        # Hardware detection & capability routing
├── reputation.js          # Local reputation ledger
├── boot.js                # Local DHT bootstrap (for testing)
├── tasks/                 # Example bundled tasks (with npm deps)
│   ├── hello-ms.js        # Uses `ms` package
│   ├── slugify-text.js    # Uses `slugify` package
│   └── format-bytes.js    # Uses `ms` + arguments
├── jobs/                  # Example distributed jobs
│   ├── sum-job.js
│   ├── primes-job.js
│   ├── mandelbrot-job.js
│   ├── gpu-benchmark-job.js
│   ├── gpu-benchmark.py   # Standalone GPU benchmark (PyTorch)
│   ├── stats-task.js
│   └── stats.py
├── test/                  # Tests (brittle + integration)
│   ├── index.test.js      # Bundling tests
│   ├── slugify-bundle.test.js
│   ├── test-capabilities.js   # Capability detection tests
│   ├── test-pipeline.js       # E2E pipeline test (Python + Hyperdrive)
│   ├── test-jobs.js           # Distributed job tests
│   ├── test-marketplace.js    # Multi-requester isolation test
│   ├── test-hyperdrive.js     # File transfer test
│   └── test-full.js           # Matrix + Mandelbrot test
├── demos/                 # Demo scripts
│   ├── demo.js            # Self-contained demo (single process)
│   ├── demo-generic.js    # Generic task demo (6 task types)
│   ├── peer.js            # Minimal peer example
│   ├── peer-a.js          # Requester peer
│   └── peer-b.js          # Worker peer
├── examples/              # Standalone compute examples
│   ├── mandelbrot.js      # Mandelbrot compute functions
│   └── matrix.js          # Matrix multiply functions
└── package.json
```

## Quick Start

```bash
# Laptop 1 (requester)
cd app && npm install
node request-compute.js

# Laptop 2 (worker)
cd app && npm install
ALLOW_SHELL=1 node offer-compute.js

# In requester prompt:
run return 2 + 2
file tasks/hello-ms.js
bundle tasks/slugify-text.js "Hello World"
shell python3 -c "print(2+2)"
job jobs/mandelbrot-job.js 4
upload data.csv
status
```

### Local Development (single machine)

```bash
cd app && npm install

# Terminal 1: start local DHT bootstrap
node boot.js

# Terminal 2: requester
BOOTSTRAP=localhost:8000 node request-compute.js

# Terminal 3: worker
BOOTSTRAP=localhost:8000 ALLOW_SHELL=1 node offer-compute.js
```

### Environment Variables

- `BOOTSTRAP=host:port` — DHT bootstrap node address for local testing
- `ALLOW_SHELL=1` — opt-in to enable shell command execution on workers

### Requester Commands

| Command | Description |
|---|---|
| `run <code>` | Execute arbitrary JS code on a worker |
| `file <path.js>` | Send a .js file as a task |
| `bundle <path.js> [args]` | Bundle task + npm deps with esbuild, send to worker |
| `job <path.js> [n]` | Run distributed job split across N workers |
| `shell <cmd>` | Run shell command on a worker (requires `ALLOW_SHELL=1`) |
| `upload <file> [name]` | Upload file to shared Hyperdrive |
| `download <path>` | Download file from worker's output drive |
| `files` | List uploaded files |
| `workers` | List connected workers |
| `results` | Show all task results |
| `status` | Show network status and reputation |
| `help` | Show help |
