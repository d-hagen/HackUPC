# P2P Shared Computing with Open Data: Analysis & Proposal

**Confirmed with challenge owner: peers CAN see the data they compute on. No encryption requirement. Open-data compute is fully valid for the challenge.**

---

## 1. What Changes When You Drop Privacy

Removing the encryption/privacy requirement fundamentally simplifies the problem:

| With privacy | Without privacy |
|---|---|
| Need homomorphic encryption, MPC, or TEEs to compute on hidden data | Peers just... run the code on the data directly |
| Trust is a hard cryptographic problem | Trust is a social/reputational problem (much simpler) |
| Limited to trusted peers only (invite-based) | Any peer can contribute compute |
| Result verification requires complex proofs | Result verification via redundant computation (send same task to 2+ peers, compare) |
| Massive overhead from encryption | Zero overhead from encryption |
| Restricts what computations are possible | Any computation is possible |

**This is the model BOINC, Folding@Home, and Golem all use.** The data is open. Peers see everything. The only concerns are:
1. Is the peer returning correct results? (verification)
2. Is the peer actually doing work? (freeloading)
3. Will the peer stay online? (churn/reliability)

---

## 2. Challenge Fit

Confirmed with challenge owner: encryption/privacy is not required. All Pear protocol requirements are met:

| Challenge requirement | Open-data compute | Fits? |
|---|---|---|
| **"Leverages the Pear protocol"** | Hypercore as task/result log, Autobase for multiwriter, Hyperswarm for peer discovery | **Yes** |
| **"Multiwriter P2P synchronization"** | Multiple peers write tasks + results to shared Autobase | **Yes** |
| **"Distributed ledgers"** | Hypercore append-only logs ARE distributed ledgers | **Yes** |
| **"DHT-based swarming"** | Hyperswarm for peer discovery | **Yes** |
| **"The Cloud does not exist"** | No server, pure P2P | **Yes** |
| **Data sharing between peers** | Peers see and compute on shared data directly | **Yes** |

**All requirements met. Full green light.**

---

## 3. Existing Implementations & Literature

### Distributed compute with open data (no privacy layer)

| Project | Architecture | Open data? | Server? | Status |
|---|---|---|---|---|
| **[BOINC](https://boinc.berkeley.edu/)** | Central server distributes work units to volunteer clients | Yes -- work units are open | **Yes** -- central server required | Production, 800K+ volunteers |
| **[Folding@Home](https://foldingathome.org/)** | Central server assigns protein folding tasks | Yes -- scientific data is open | **Yes** -- central server | Production, 1M+ contributors |
| **[Golem Network](https://golem.network/)** | P2P marketplace, requestors submit tasks, providers execute in Docker | Yes -- provider sees task data | **No** -- P2P with Ethereum settlement | Production (CPU), GPU beta |
| **[iExec](https://iexec.io/)** | Decentralized compute marketplace with worker pools | Partial -- supports TEEs but also open mode | **No** -- P2P with blockchain | Production |
| **[Render Network](https://rendernetwork.com/)** | Decentralized GPU rendering | Yes -- render nodes see the scene data | **No** -- blockchain-coordinated | Production |
| **[CrowdRender](https://www.crowd-render.com/)** | P2P Blender render farm | Yes -- peers see the .blend file | **No** -- P2P LAN discovery | Production, open source |
| **[BitWrk](https://www.bitwrk.net/)** | Decentralized rendering marketplace | Yes | Hybrid | Open source |
| **[P2P-MapReduce](https://scalab.dimes.unical.it/projects/p2p-mapreduce/)** | Decentralized MapReduce, peers elect dynamic masters | Yes | **No** -- fully P2P, dynamic master election | Research prototype (JXTA + Hadoop) |
| **[deThread](https://github.com/deThread/dethread)** | Browser-based distributed computing | Yes -- JS tasks run in Web Workers | **Yes** -- coordinator server | Library, npm |
| **[Petals](https://petals.dev/)** | Distributed LLM inference, BitTorrent-style | Yes -- model layers are open | **No** -- P2P | Production |

### Key academic work

| Paper | Core idea | Relevance |
|---|---|---|
| **[P2P-MapReduce (Marozzo et al., 2012)](https://www.sciencedirect.com/science/article/pii/S0022000011001668)** | Fully decentralized MapReduce. Peers dynamically become masters/slaves. Handles churn, master failure, job recovery. No fixed coordinator. | **Directly relevant** -- this is the architecture pattern for serverless P2P compute |
| **[Tran & Ha (2014): Feasible MapReduce P2P Framework](https://link.springer.com/article/10.1007/s40595-014-0031-8)** | MapReduce on P2P networks using DHT for task distribution | Maps onto Hyperswarm DHT |
| **[Collaborative Framework for P2P (Springer)](https://link.springer.com/chapter/10.1007/978-3-642-27317-9_4)** | Task distribution among peers in completely decentralized environments | General architecture reference |
| **[WASM as Secure Sandbox (2025)](https://www.tspi.at/2025/10/02/wasmsandbox.html)** | WebAssembly for running untrusted code in sandboxed environments across distributed nodes | Relevant if you want peers to run arbitrary code safely |
| **[wasmCloud Zero Trust Computing](https://wasmcloud.com/blog/zero-trust-security/)** | Zero-trust distributed computing with WASM | Production pattern for sandboxed P2P compute |

### What's NOT been built

Nobody has built: **P2P open-data compute sharing using the Pear/Hypercore stack (Autobase as task log, Hyperswarm for discovery).**

- BOINC/Folding@Home use central servers → not truly P2P
- Golem/iExec use blockchain for settlement → different stack entirely
- P2P-MapReduce used JXTA (dead framework) → concept proven but no modern implementation
- deThread uses WebSockets with coordinator → not serverless
- Petals is AI-specific → not general compute

**The gap: a general-purpose, serverless P2P compute framework built on Hypercore/Autobase/Hyperswarm.**

---

## 4. Architecture: How It Would Work on Pear

### The Autobase-as-Task-Queue Pattern

Autobase is an append-only multiwriter log. The insight: **this is exactly what an event-sourced task queue looks like.**

```
Autobase entries (chronological, all peers can read/write):

[peer-A] { type: 'task',   id: 't1', action: 'compute', fn: 'primes', range: [1, 1000000], status: 'pending' }
[peer-B] { type: 'claim',  taskId: 't1', claimedBy: 'peer-B' }
[peer-B] { type: 'result', taskId: 't1', output: [2, 3, 5, 7, ...], duration: 3400 }
[peer-A] { type: 'task',   id: 't2', action: 'compute', fn: 'mandelbrot', tile: {x:0,y:0,w:256,h:256}, status: 'pending' }
[peer-C] { type: 'claim',  taskId: 't2', claimedBy: 'peer-C' }
[peer-C] { type: 'result', taskId: 't2', output: <pixel data>, duration: 1200 }
```

This maps perfectly onto Autobase:
- Each entry is a Hypercore block (append-only, signed, hash-linked)
- Multiple peers write via Autobase multiwriter
- Peers discover each other via Hyperswarm DHT
- The log IS the task queue, claim registry, and result store

### System diagram

```
                    ┌──────────────────────────┐
                    │    Shared Autobase Log    │
                    │                          │
                    │  task → claim → result   │
                    │  task → claim → result   │
                    │  task → ...              │
                    └────────┬─────────────────┘
                             │
                    Hyperswarm DHT discovery
                    (topic = shared key)
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
         │ Peer A  │   │ Peer B  │   │ Peer C  │
         │         │   │         │   │         │
         │ Posts   │   │ Claims  │   │ Claims  │
         │ tasks   │   │ tasks   │   │ tasks   │
         │         │   │ Computes│   │ Computes│
         │ Reads   │   │ Writes  │   │ Writes  │
         │ results │   │ results │   │ results │
         └─────────┘   └─────────┘   └─────────┘
```

### Task lifecycle

```
PENDING  ──→  CLAIMED  ──→  COMPUTING  ──→  COMPLETED
   │              │              │              │
   │         peer writes    peer runs      peer writes
   │         claim entry    the function   result entry
   │              │              │
   │              └── TIMEOUT ───┘  (reassign if peer drops)
   │
   └── any peer can post tasks
```

### Verification (optional but impressive)

Since data is open, you can verify results by:
1. **Redundant computation**: Send same task to 2 peers, compare results
2. **Spot checks**: Requestor re-computes a random subset of completed tasks
3. **Reputation**: Track correct results per peer in the Autobase log

---

## 5. Does This Idea Already Exist in This Form?

**No.** Specifically:

| What exists | How ours differs |
|---|---|
| BOINC: open-data volunteer compute | Requires central server. Ours is fully P2P on Hyperswarm. |
| Golem: P2P compute marketplace | Uses Ethereum/blockchain. Ours uses Hypercore/Autobase (simpler, no tokens needed). |
| P2P-MapReduce: serverless P2P compute | Used JXTA (dead). No modern implementation exists. We'd build on Pear. |
| PearPass: P2P data sync on Pear | Storage only, no compute. We add task execution. |
| deThread: browser distributed compute | Requires coordinator server. Not on Pear stack. |

**Novel combination**: Autobase as an event-sourced task queue + Hyperswarm for serverless peer discovery + open-data compute execution. This pattern hasn't been implemented on Pear.

---

## 6. What Novelty Could We Add?

### Already novel (the base idea)
- Using Autobase as a distributed task queue (nobody has done this)
- P2P compute with zero infrastructure on Pear

### Additional novelty options

| Feature | What it is | Effort | Impact |
|---|---|---|---|
| **Dynamic peer roles** | Any peer can be requestor OR provider. No fixed roles. Inspired by P2P-MapReduce's dynamic master election. | Low | High -- true P2P, not client-server in disguise |
| **Capability-based routing** | Peers announce hardware specs (CPU cores, RAM, GPU) via Hyperswarm metadata. Tasks route to best-fit peer. | Low | Medium -- practical and demoable |
| **Visual compute dashboard** | Real-time visualization of tasks flowing between peers, Mandelbrot tiles rendering as they arrive | Medium | Very high for demo -- judges love visuals |
| **WASM sandboxed execution** | Peers submit WASM modules as tasks. Executing peer runs them in a sandbox. Arbitrary code, safely. | High | Very high novelty -- no P2P WASM compute on Hypercore exists |
| **Compute credit ledger** | The Autobase log tracks work contributed by each peer. "Proof of work" without blockchain. | Low | Medium -- adds fairness/incentive layer |
| **Automatic task splitting** | Large tasks auto-split into chunks based on connected peer count. More peers = more parallelism. | Medium | High -- shows the system scaling live |
| **Churn recovery** | If a peer disconnects mid-task, timeout → task reverts to PENDING → another peer picks it up. Free from Autobase eventually-consistent sync. | Low | Medium -- essential for robustness |
| **Task dependency chains** | Tasks can declare dependencies on other tasks. A task only becomes claimable when its dependencies are completed. Enables multi-stage pipelines. | Medium | High -- enables real workflows, not just independent chunks |

---

## 7. What Would Need to Be Built

### Components

1. **Pear app scaffold**
   - `pear init`, project structure, Corestore setup
   - Autobase initialization with shared discovery key

2. **Task schema & lifecycle manager**
   - Entry types: `task`, `claim`, `result`, `peer-info`
   - State machine: pending → claimed → computing → completed / timeout
   - Conflict resolution: first-write-wins for claims (check before claiming)

3. **Compute engine**
   - Receives a task description (function name + parameters)
   - Executes the computation locally
   - Writes result back to Autobase
   - Built-in task types: prime search, Mandelbrot tiles, matrix multiplication, text processing

4. **Peer discovery & announcement**
   - Join Hyperswarm topic (derived from Autobase key)
   - Announce: peer ID, available CPU cores, current load
   - Watch for new peers joining/leaving

5. **Task watcher / scheduler**
   - Listen to `autobase.on('update')` for new tasks
   - If task status is 'pending' and this peer is available → claim it
   - Simple greedy: first available peer takes first available task

6. **Result aggregator**
   - Collect completed results
   - For visual tasks (Mandelbrot): assemble tiles into full image
   - For numerical tasks: aggregate/display results

7. **UI / Dashboard**
   - Connected peers with status indicators
   - Task queue: pending / in-progress / completed
   - Live result visualization
   - Post new task form
   - Peer contribution stats

---

## 8. Feasibility Assessment

| Question | Answer |
|---|---|
| **Is it buildable in a hackathon?** | **Yes, more easily than the privacy version.** No encryption complexity. The Autobase-as-task-queue pattern is ~150 lines. Compute functions are plain JS. |
| **Is Pear the right tool?** | **Mostly yes.** Hyperswarm gives you serverless peer discovery. Autobase gives you multiwriter task log. The gap: Pear wasn't designed for compute, so task execution is custom JS on top. But that's a thin layer. |
| **What's the hardest part?** | **Task claim conflicts.** Two peers claiming the same task simultaneously. Autobase is eventually consistent, so you'll see both claims. Solution: first-write-wins by timestamp, or let both compute and compare (turns a bug into a verification feature). |
| **What if Pear runtime is flaky?** | Same risk as the privacy version. Test `pear init` + pearpass-example first. If it works, everything else follows. |
| **Is it impressive for judges?** | **Yes, if you have a visual task.** Mandelbrot tiles rendering live as different peers compute them is visceral. A terminal-only prime search is less impressive. |
| **Does it fit the challenge?** | **Yes.** Confirmed with challenge owner -- open data compute on Pear is valid. All protocol requirements met. |

### Time estimate

| Component | Time |
|---|---|
| Pear setup + hello world | ~1h |
| Autobase task schema + lifecycle | ~3h |
| Compute engine (Mandelbrot + primes) | ~2h |
| Peer discovery + announcement | ~1h |
| Task watcher / claim logic | ~2h |
| Result aggregation + visualization | ~3h |
| Dashboard UI | ~2h |
| Polish + demo | ~1h |
| **Total** | **~15h** |

---

## 9. Recommendation

**Build pure open-data P2P compute on Pear:**
- Autobase as the distributed task queue (novel -- nobody has done this)
- Hyperswarm for serverless peer discovery
- Visual compute tasks (Mandelbrot tiles) for demo impact
- Dynamic peer roles -- any peer is both requestor and provider
- Compute credit ledger for fairness tracking

Pitch: "A zero-infrastructure P2P compute-sharing platform built on Pear. Your swarm is your supercomputer. No servers, no cloud, no blockchain -- just peers sharing CPU power over Hypercore."

---

## 10. Sources

### P2P Compute Platforms
- [BOINC](https://boinc.berkeley.edu/) -- Volunteer computing middleware
- [Folding@Home](https://foldingathome.org/) -- Protein folding distributed computing
- [Golem Network](https://golem.network/) -- Decentralized compute marketplace
- [iExec](https://iexec.io/) -- Confidential & open compute marketplace
- [Render Network](https://rendernetwork.com/) -- Decentralized GPU rendering
- [CrowdRender](https://www.crowd-render.com/) -- P2P Blender render farm
- [BitWrk](https://www.bitwrk.net/) -- Decentralized rendering
- [Petals](https://petals.dev/) -- Distributed LLM inference
- [deThread](https://github.com/deThread/dethread) -- Browser distributed computing

### P2P MapReduce Research
- [P2P-MapReduce (Marozzo et al., 2012)](https://www.sciencedirect.com/science/article/pii/S0022000011001668) -- Decentralized MapReduce
- [P2P-MapReduce Project Page](https://scalab.dimes.unical.it/projects/p2p-mapreduce/) -- University of Calabria
- [Feasible MapReduce P2P Framework (Tran & Ha, 2014)](https://link.springer.com/article/10.1007/s40595-014-0031-8)
- [Collaborative Framework for P2P (Springer)](https://link.springer.com/chapter/10.1007/978-3-642-27317-9_4)

### WASM & Sandboxed Execution
- [WASM as Secure Sandbox (2025)](https://www.tspi.at/2025/10/02/wasmsandbox.html)
- [wasmCloud Zero Trust](https://wasmcloud.com/blog/zero-trust-security/)
- [WebAssembly Security](https://webassembly.org/docs/security/)
- [CMU: Provably-Safe WASM Sandboxing](https://www.cs.cmu.edu/~csd-phd-blog/2023/provably-safe-sandboxing-wasm/)

### Pear / Hypercore Stack
- [Pear Runtime Docs](https://docs.pears.com/)
- [Hypercore](https://github.com/holepunchto/hypercore)
- [Autobase](https://github.com/holepunchto/autobase)
- [Hyperswarm](https://github.com/holepunchto/hyperswarm)
- [HyperDHT](https://github.com/holepunchto/hyperdht)
- [autopass](https://github.com/holepunchto/autopass)
- [pearpass-example](https://github.com/holepunchto/pearpass-example)
- [Awesome Pears](https://github.com/gasolin/awesome-pears)

### Architecture Patterns
- [Event Sourcing (Microsoft)](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
- [CQRS + Event Sourcing](https://developer.confluent.io/courses/event-sourcing/cqrs/)
- [Local-first Software (Ink & Switch)](https://www.inkandswitch.com/local-first/)
- [Citizen Science Computing (IEEE)](https://ieeexplore.ieee.org/document/8249551/)
