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

### What's In the Box

- **P2P discovery** — peers find each other over Hyperswarm DHT, no coordination server needed
- **Multi-threaded workers** — each worker runs a `worker_threads` pool, filling all CPU cores concurrently
- **GPU support** — auto-detects NVIDIA CUDA, Apple MPS, and AMD ROCm; routes GPU tasks to capable workers via Python/PyTorch subprocess
- **DAG scheduling** — tasks declare dependencies (`dependsOn`); workers self-select ready tasks and execute wavefronts in parallel
- **Task claiming** — workers write claims to the shared log before executing, preventing duplicate work across peers
- **Distributed jobs** — split data across N workers, join results; live image preview as chunks complete
- **Web dashboard** — localhost HTTP UI with real-time task queue, worker stats, job scheduling, and DAG visualization
- **P2P file transfer** — upload and download files between peers via Hyperdrive; task code gets injected `readFile()`/`writeFile()` helpers for direct drive I/O
- **Reputation & roaming** — workers rank requesters by reputation score and automatically roam to where work is

### Supported Commands

| Command | What it does |
|---|---|
| `run <code>` | Execute arbitrary JS code directly on a worker |
| `file <path.js>` | Send a `.js` file as a task |
| `bundle <path.js> [args]` | Bundle task + all npm dependencies via esbuild — workers don't need packages installed |
| `job <path.js> [n] [args]` | Run a distributed split/join job across N workers |
| `shell <cmd>` | Run a shell command on a worker (requires `ALLOW_SHELL=1`) |
| `upload <file>` / `download <path>` | Transfer files between peers via Hyperdrive |
| `workers` / `status` / `results` | View connected workers, network status, task results |

Or use the **web dashboard** — schedule jobs, monitor tasks, and view live previews from the browser.

> Demo video: *[TODO: add link]*

### How It Compares

| | **PeerCompute** | **BOINC** | **Golem** | **Render Network** |
|---|---|---|---|---|
| Infrastructure | None | Central server | Ethereum + Docker | Blockchain |
| Setup | `npm install` | Install client + project app | Install Golem + Docker + yagna | OctaneRender + RNDR app |
| Payment | Reputation (no money) | Volunteer only | ETH/GLM tokens | RNDR tokens |
| Task queue | Autobase P2P log | Server database | Smart contracts | Centralized |
| Dependency bundling | esbuild (auto-inlined) | Manual packaging | Docker containers | N/A |
| Hardware routing | Auto-detect GPU/CPU/RAM | Manual project selection | Provider profiles | Manual selection |

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
| Image transform | `jobs/image-transform-job.js` | Splits an image into a grid of blocks, applies a different filter (grayscale, sepia, invert, warm, cool, etc.) per block, reassembles into a single output image with live preview |
| Wave-front DAG | `jobs/wave-dag-job.js` | NxN grid of tasks where each cell depends on its top and left neighbor. Tasks execute in diagonal wavefronts — all cells on the same anti-diagonal run in parallel. Produces a color-gradient image and a live DAG visualization |
| GPU benchmark | `jobs/gpu-benchmark-job.js` | Splits matrix sizes across workers, benchmarks GPU via PyTorch |
| Statistics (Python) | `jobs/stats-task.js` + `jobs/stats.py` | Computes sum/count/min/max/mean on data via Python subprocess |

#### Running the image transform job

Requires `img.png` in the `app/` directory and ImageMagick installed on the requester.

```bash
# In the requester prompt:
# 8 rows x 6 columns = 48 grid blocks, each with a different filter
job jobs/image-transform-job.js 8 6
```

A live preview opens at `http://localhost:7842` — blocks fill in as workers complete them.

#### Running the wave-front DAG job

```bash
# In the requester prompt:
# 6x6 grid, 80px cells, 250ms delay per task
job jobs/wave-dag-job.js 6 80 250
```

Opens a live preview with two panels: the color image building up and a DAG graph showing blocked (blue), ready (orange), and done (green) tasks propagating diagonally.

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

| Feature | What | Status |
|---|---|---|
| **Worker thread pool** | `worker_threads` for parallel task execution per worker | Done |
| **WASM sandbox** | Execute WASM modules for safe, portable, near-native compute | High |
| **GPU via Python execution** | Upload Python files with PyTorch/CUDA deps to workers, execute via JS task subprocess | Done |
| **Streaming results** | Partial/progress updates during long tasks | Done |
| **Task dependencies (DAG)** | DAG of tasks with `dependsOn` — B runs only after A completes, wavefront parallel execution | Done |
| **Task claiming** | Workers write claims to Autobase before executing to prevent duplicate work across peers | Done |
| **Incremental log scan** | Persistent scan indices so old job entries are never re-read on subsequent runs | Done |
| **Batch thread dispatch** | Collect all dispatchable tasks first, dispatch to pool in one burst so all threads fill concurrently | Done |

### 2. UI & App

**Current state:** Localhost HTTP dashboard served by `ui-server.js` (HTML/CSS/JS).

| Feature | What | Status |
|---|---|---|
| **Web dashboard** | HTTP server on localhost serving a live dashboard with HTML/CSS — connected peers, task queue, results | Done |
| **Live task dashboard** | Real-time view of pending/running/done tasks, worker status, and job results | Done |
| **Job scheduling UI** | Submit jobs with arguments directly from the web interface | Done |
| **Live image preview** | PPM job output rendered live in browser as chunks complete (Mandelbrot, image transforms, etc.) | Done |
| **DAG visualization** | Canvas-based dependency graph showing task states (blocked/ready/done) with animated wavefront | Done |

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

## File Structure

```
app/
├── request-compute.js     # Requester CLI (main entry point)
├── offer-compute.js       # Worker CLI (main entry point)
├── base-setup.js          # Shared Autobase + Hyperswarm setup
├── worker.js              # Generic JS/shell task executor
├── thread-pool.js         # Worker thread pool for parallel task execution
├── thread-worker.js       # Thread worker script (runs inside worker_threads)
├── ui-server.js           # Localhost HTTP server for web dashboard
├── bundler.js             # esbuild task bundler (inlines npm deps)
├── capabilities.js        # Hardware detection & capability routing
├── reputation.js          # Local reputation ledger
├── boot.js                # Local DHT bootstrap (for testing)
├── web/
│   └── index.html         # Dashboard UI (HTML/CSS/JS)
├── tasks/                 # Example bundled tasks (with npm deps)
├── jobs/                  # Example distributed jobs
│   ├── sum-job.js
│   ├── primes-job.js
│   ├── mandelbrot-job.js
│   ├── image-transform-job.js
│   ├── wave-dag-job.js
│   ├── gauss-seidel-job.js
│   ├── jacobi-job.js
│   ├── gpu-blur-job.js
│   ├── gpu-benchmark-job.js
│   └── ...
├── test/                  # Tests (brittle + integration)
├── demos/                 # Demo scripts
├── examples/              # Standalone compute examples
└── package.json
```
