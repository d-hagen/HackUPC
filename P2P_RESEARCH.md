# Peer-to-Peer Shared Computing: Deep Dive

## The Core Idea

**You have idle computing power. Someone else needs it. And vice versa.**

This is voluntary distributed computing: a network of peers that dynamically share CPU/GPU resources. When you're not using your machine, others can borrow cycles. When you need more power than you have, you pull from the pool.

This is architecturally identical to how botnets work -- except with **consent, transparency, and legitimate purpose**.

---

## 1. The Botnet Parallel (and How to Repurpose It)

### How Botnets Actually Work
A botnet is just a distributed compute network where the owners **don't know** their machines are participating. The architecture is:
1. **Command & Control (C2) server** -- coordinates tasks
2. **Agent/client** on each compromised machine -- receives work, returns results
3. **Task distribution** -- C2 splits work into chunks, fans out to agents
4. **Result aggregation** -- C2 collects and merges results

That's it. Strip away the malware delivery and the lack of consent, and you have BOINC.

### What Botnets Prove
- **Scale works**: Botnets routinely coordinate hundreds of thousands of machines
- **Heterogeneous hardware works**: Agents run on everything from phones to servers
- **Unreliable nodes are manageable**: Machines drop offline constantly; the system copes
- **Browser-based execution works**: Brannon Dorsey's ["Browser as Botnet"](https://medium.com/@brannondorsey/browser-as-botnet-or-the-coming-war-on-your-web-browser-be920c4f718) research ran JavaScript on 117,852 browsers via ad networks -- mining crypto, serving torrents, running DDoS -- all from browser tabs. 180,175 browsers served a torrent file at 702 Mbps combined upload in 24 hours.

### The Legitimate Repurposing
Replace:
- Malware delivery → **Voluntary install or browser tab opt-in**
- Hidden execution → **Transparent resource dashboard**
- C2 server → **Task coordination server (or decentralized coordination)**
- Stolen cycles → **Donated idle cycles with user-set limits**

The technical architecture is nearly identical. The difference is consent and control.

---

## 2. Existing Technologies & Platforms

### Established Volunteer Computing

| Platform | What It Does | Scale | Tech |
|----------|-------------|-------|------|
| **[BOINC](https://boinc.berkeley.edu/)** | General-purpose volunteer computing middleware (Berkeley) | 800K+ active volunteers | C++, client-server, cross-platform |
| **[Folding@Home](https://foldingathome.org/)** | Protein folding simulation | 1M+ contributors, hit 1.5 exaFLOPS during COVID | Custom client, GPU-accelerated |
| **[Einstein@Home](https://www.aei.mpg.de/43575/einstein-home)** | Gravitational wave detection | 500K+ participants | BOINC-based |

**Key insight**: BOINC is open source and the most proven framework. It handles task distribution, result validation, credit tracking, and client management. Version 8.2.9 released April 2026.

### Blockchain-Based Compute Marketplaces

| Platform | Model | Token | Status (2026) |
|----------|-------|-------|----------------|
| **[Golem Network](https://golem.network/)** | P2P compute marketplace on Ethereum | GLM | GPU beta, production for CPU tasks |
| **[Akash Network](https://akash.network/)** | Kubernetes-compatible GPU marketplace | AKT | 428% YoY growth, 80%+ utilization |
| **[Nosana](https://nosana.com/)** | GPU rental on Solana for AI workloads | NOS | Production, scaling in 2026 |
| **[iExec](https://iexec.io/)** | Confidential computing marketplace | RLC | Focus on trusted execution environments |

**Key insight**: These add economic incentives (tokens/payments) and trustless execution via blockchain. Golem is the most accessible for a demo -- open source, documented APIs, and you can run a local testnet.

### AI-Specific Distributed Computing

| Platform | What It Does | How |
|----------|-------------|-----|
| **[Petals](https://petals.dev/)** | Run LLMs (LLaMA 405B, BLOOM 176B) across distributed GPUs, BitTorrent-style | Splits model into layer blocks, each node hosts a subset. 10x faster than offloading |
| **[Exo](https://github.com/exo-explore/exo)** | Run AI clusters at home across heterogeneous devices (iPhone, Mac, RPi, NVIDIA) | Unifies devices into one virtual GPU |

**Key insight**: Petals is the best real-world proof that this works for a killer use case (LLM inference). Well-documented, open source, active community. Paper: [arxiv.org/abs/2209.01188](https://arxiv.org/abs/2209.01188).

### Browser-Based Distributed Computing

| Library | What It Does | Stack |
|---------|-------------|-------|
| **[deThread](https://github.com/deThread/dethread)** | Distributed computing in the browser | JavaScript, WebSockets (socket.io), Web Workers |
| **[PeerJS](https://peerjs.com/)** | WebRTC abstraction for P2P data channels | JavaScript, WebRTC |

**deThread architecture**:
- Server: task queue management, client connection handling, failure recovery
- Client: Web Worker integration for concurrent processing via socket.io
- API: `dethread.start(io, tasks, clientInit)` / `dethread.on(event, cb)` / `dethread.closeProcess()`
- Client reports `navigator.hardwareConcurrency` to spin up optimal number of Web Workers
- Demo app: distributed MD5 hash cracking

### General-Purpose Distributed Frameworks

| Framework | What It Does | Best For |
|-----------|-------------|----------|
| **[Ray](https://www.ray.io/)** | Distributed Python execution with task scheduling, auto-scaling, fault tolerance | ML/AI workloads |
| **[Celery](https://docs.celeryq.dev/)** | Distributed task queue for Python | Background jobs, can be adapted for P2P |
| **[libp2p](https://libp2p.io/)** | Modular P2P networking stack (used by IPFS, Ethereum, Filecoin) | Building custom P2P protocols |

---

## 3. Architecture Approaches

### Approach A: Centralized Coordinator (Simplest -- Recommended for Demo)

```
                 +-----------------+
                 |  Coordinator    |
                 |  Server         |
                 | - Task queue    |
                 | - Result store  |
                 | - Worker mgmt   |
                 +--------+--------+
                    /     |     \
                   /      |      \
            +-----+  +---+---+  +-----+
            |Node1|  |Node2  |  |Node3|
            |idle |  |busy   |  |idle |
            +-----+  +-------+  +-----+
```

- Server holds a task queue, distributes work to available nodes
- Nodes report availability and resource capacity
- Server handles fault tolerance (reassign tasks from dropped nodes)
- **This is how BOINC, Folding@Home, and botnets all work**

**Pros**: Simple, proven, easy to demo
**Cons**: Single point of failure, coordinator must be trusted

### Approach B: Decentralized P2P (Harder, More Interesting)

```
            +-----+     +-----+
            |Node1+-----+Node2|
            +--+--+     +--+--+
               |    \  /    |
               |     \/     |
               |     /\     |
            +--+--+ /  \+--+--+
            |Node3+-----+Node4|
            +-----+     +-----+
```

- Nodes discover each other via DHT (distributed hash table) or mDNS
- Task requests broadcast to network, nodes bid based on available resources
- Results validated by consensus or redundant computation
- **This is how Golem, libp2p-based systems work**

**Pros**: No single point of failure, truly decentralized
**Cons**: Complex, harder to demo, coordination overhead

### Approach C: Browser-Based (Most Accessible for Demo)

```
            +-----------------+
            |  Web Server     |
            |  (coordinates)  |
            +--------+--------+
                     |
            WebSocket/WebRTC
            /        |        \
      +--------+ +--------+ +--------+
      |Browser1| |Browser2| |Browser3|
      |Worker  | |Worker  | |Worker  |
      |Threads | |Threads | |Threads |
      +--------+ +--------+ +--------+
```

- Users open a web page → instantly become compute nodes
- Web Workers run tasks in background threads (no UI freeze)
- WebSocket for coordination, optional WebRTC for direct P2P data
- **This is what deThread does, and what Dorsey's research proved at scale**

**Pros**: Zero install, instant participation, visually demoable
**Cons**: Limited to JavaScript, browser sandboxing limits power, tabs can close

---

## 4. Key Technical Challenges

| Challenge | Solution | Notes |
|-----------|----------|-------|
| **Trust**: How do you know a node returned correct results? | Redundant computation (send same task to N nodes, compare), cryptographic proofs, TEEs | BOINC uses redundant computation; iExec uses TEEs |
| **Freeloading**: Nodes that consume but don't contribute | Credit systems, tit-for-tat, token incentives | Golem/Akash use economic incentives |
| **Security**: Malicious code on volunteer machines | Sandboxing (WASM, Docker, browser sandbox), code signing | Browser sandbox is strongest; Golem uses Docker |
| **NAT traversal**: P2P connections through firewalls | STUN/TURN servers, WebRTC ICE, relay fallback | libp2p handles this; PeerJS abstracts it |
| **Task granularity**: Splitting work effectively | Map-reduce patterns, embarrassingly parallel problems | Easiest with independent chunks (Mandelbrot, hash search) |
| **Latency**: Network delays between distributed nodes | Prefer throughput-oriented tasks over latency-sensitive | Not suitable for real-time gaming; fine for batch compute |
| **Heterogeneous hardware**: Phones vs desktops vs GPUs | Adaptive chunk sizing based on reported capability | `navigator.hardwareConcurrency` in browsers |

---

## 5. Real-World Applications (Documented, In Production)

| Application | Platform | Impact |
|------------|----------|--------|
| **COVID-19 protein folding** | Folding@Home | Hit 1.5 exaFLOPS -- more than top 100 supercomputers combined |
| **Gravitational wave search** | Einstein@Home | Deepest all-sky search for continuous gravitational waves (Feb 2026) |
| **Distributed LLM inference** | Petals | Run 405B parameter models on consumer GPUs |
| **AI training/inference marketplace** | Akash, Nosana | Commercial GPU marketplace, 428% YoY growth |
| **Climate modeling** | BOINC/Climateprediction.net | 10,000+ volunteer PCs simulating climate models |
| **Drug discovery** | Folding@Home | Multiple published papers on therapeutic targets |
| **Browser-based content delivery** | Dorsey's research | 180K browsers serving torrents at 702 Mbps combined |

---

## 6. Demo Feasibility Assessment

### Most Realistic Demo: Browser-Based Distributed Computing (Approach C)

**Buildable in a hackathon (12-24h).** This is the recommended path.

**Stack**:
- **Server**: Node.js + socket.io (or Python + websockets)
- **Client**: Browser + Web Workers
- **Dashboard**: Real-time visualization of connected nodes and task progress

**Best demo task: Mandelbrot set rendering**
- Each pixel is independent → perfect parallelism
- Visually impressive output
- Can show tiles appearing as different browsers compute them
- Easy to demonstrate speedup: 1 browser = slow, 10 browsers = fast

**Why Mandelbrot over hash cracking**: Visual output is more impressive for a demo. Audience can see the image assemble in real time as distributed workers contribute tiles.

**What makes it impressive for judges**:
- Open it on 5 phones in the audience → instant compute cluster
- Show real-time speedup as more browsers connect
- Show the "botnet" parallel: architecturally the same thing, but consensual

### Minimum Viable Demo Components

1. **Task Splitter**: Breaks problem into independent chunks
2. **Coordinator**: Assigns chunks to workers, tracks progress
3. **Worker**: Executes a chunk, returns result
4. **Dashboard**: Real-time visualization of distributed work
5. **Fault Tolerance**: Reassign work from disconnected workers

### Alternative Demo: Python CLI P2P Task Queue

If browser approach feels limiting, build a CLI tool where machines on a LAN share computing tasks:
- Python + asyncio + websockets
- mDNS for peer discovery
- Task: distributed prime search or matrix multiplication

### Alternative Demo: Petals-Style LLM Distribution

Most impressive output, but requires multiple GPU machines and more setup time.

---

## 7. Recommended Tech Stack for Hackathon

### Browser Demo (Primary Recommendation)

```
Server:     Node.js + Express + socket.io
Workers:    Web Workers (vanilla JS)
Frontend:   Vanilla JS + Canvas API (for Mandelbrot visualization)
Dashboard:  Real-time stats via socket.io events
```

### Python Backend Alternative

```
Server:     Python + FastAPI + websockets
Workers:    Python subprocesses or asyncio tasks
Discovery:  zeroconf (mDNS) for LAN, WebSocket for WAN
Task:       NumPy-based computation chunks
```

### Key npm packages
```
socket.io          # WebSocket abstraction
express            # HTTP server
dethread           # Ready-made distributed computing (if you want to skip building from scratch)
peerjs             # WebRTC P2P (if going decentralized)
```

---

## 8. Sources

### Platforms & Tools
- [BOINC](https://boinc.berkeley.edu/) - Berkeley Open Infrastructure for Network Computing
- [Folding@Home](https://en.wikipedia.org/wiki/Folding@home) - Protein folding distributed computing
- [Einstein@Home](https://www.aei.mpg.de/43575/einstein-home) - Gravitational wave detection
- [Golem Network](https://golem.network/) - Decentralized compute marketplace
- [Akash Network](https://akash.network/) - Kubernetes-compatible GPU marketplace
- [Nosana](https://nosana.com/) - GPU rental on Solana
- [Petals](https://petals.dev/) - Distributed LLM inference ([paper](https://arxiv.org/abs/2209.01188))
- [Exo](https://github.com/exo-explore/exo) - Home AI cluster
- [deThread](https://github.com/deThread/dethread) - Browser distributed computing library
- [PeerJS](https://peerjs.com/) - WebRTC abstraction
- [Ray](https://www.ray.io/) - Distributed Python framework
- [libp2p](https://libp2p.io/) - Modular P2P networking stack

### Research & Articles
- [Browser as Botnet (Brannon Dorsey)](https://medium.com/@brannondorsey/browser-as-botnet-or-the-coming-war-on-your-web-browser-be920c4f718) - Browser-based distributed computing research
- [Volunteer Computing Survey (ACM)](https://dl.acm.org/doi/10.1145/3320073) - Academic survey and taxonomy
- [Awesome Volunteer Computing](https://github.com/ranjithrajv/awesome-volunteer-computing) - Curated project list
- [Cyren - Legitimate Botnets](https://data443.com/blog/cyren/legitimate-botnets-do-exist/) - Botnet vs distributed computing comparison
- [Top 10 Decentralized GPU Marketplaces 2026](https://essfeed.com/top-10-decentralized-gpu-marketplaces-fueling-the-2026-ai-compute-boom/)
- [Decentralized Cloud Computing Guide (Fluence)](https://www.fluence.network/blog/decentralized-cloud-computing-guide/)
- [BOINC Platform Paper (Springer)](https://link.springer.com/article/10.1007/s10723-019-09497-9)
- [python-p2p-network](https://github.com/macsnoeren/python-p2p-network) - Python P2P framework
