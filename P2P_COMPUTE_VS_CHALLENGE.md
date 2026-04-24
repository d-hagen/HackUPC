# P2P Shared Computing vs. The Pear Challenge: Analysis & Hybrid Proposal

---

## 1. Why Pure Shared Computing Conflicts with the Challenge

The challenge states:

> *"Build a functional application or tool that leverages the Pear protocol to enable decentralized, multiwriter, peer-to-peer (P2P) synchronization of **encrypted secrets or private notes**."*

### Point-by-point conflict analysis

| Challenge requirement | Pure shared computing | Conflict? |
|---|---|---|
| **"Leverages the Pear protocol"** | Most compute-sharing uses BOINC, Ray, WebRTC, or custom protocols | **Yes** -- Pear is designed for data sync, not task execution. There's no `pear.runOnPeer(task)` API. |
| **"Encrypted secrets or private notes"** | Compute tasks are workloads (functions + input data), not secrets | **Yes** -- a Mandelbrot tile or prime search has nothing to do with sensitive data management |
| **"Multiwriter P2P synchronization"** | Compute sharing is request/response (submit task → get result), not collaborative sync | **Partial** -- you could model task results as multiwriter entries, but it's forced |
| **"Distributed ledgers"** | Compute systems use task queues, not append-only logs | **Yes** -- Hypercore is an append-only log for data persistence, not a job scheduler |
| **"DHT-based swarming"** | Some compute systems use DHT for peer discovery, but not for data storage | **Partial** -- Hyperswarm fits for discovery, but the rest of the stack goes unused |
| **"The Cloud does not exist"** | Many compute-sharing systems use a coordinator server (BOINC, deThread, Folding@Home) | **Yes** -- unless you go fully decentralized, which adds significant complexity |
| **"Data can be shared, updated, and persisted across multiple devices"** | Compute results are ephemeral outputs, not persisted shared state | **Yes** -- the challenge expects durable, synced data across devices |

### The core problem

Pear's stack (Hypercore + Autobase + Hyperbee + Hyperswarm) is purpose-built for **data synchronization**: append entries to logs, merge across writers, replicate encrypted state. It has no concept of "run this function on a remote peer's CPU." You'd be fighting the framework instead of using it.

Pure shared computing would mean:
- Ignoring Hypercore/Autobase/Hyperbee entirely (or using them awkwardly as a task queue)
- Building a custom task execution layer that Pear doesn't provide
- Having no "encrypted secrets or private notes" in the system
- Judges immediately seeing it doesn't match the track

---

## 2. The Hybrid: Compute Over Private Data

### The insight

**What if the data being computed on IS the encrypted secrets?**

Instead of "share CPU for generic tasks," the system becomes: **"I have private data I need processed, and I want to delegate that processing to trusted peers -- without any cloud server -- while keeping the data encrypted and synced via Pear."**

This flips the framing:
- The **primary artifact** is encrypted private data (notes, secrets, credentials) → satisfies the challenge
- The **novel feature** is that peers can perform computation on each other's data → satisfies your interest in shared computing
- The **infrastructure** is Pear (Hypercore for logs, Autobase for multiwriter, Hyperswarm for discovery) → satisfies the protocol requirement

### Concrete use cases

| Use case | Private data (the "secrets") | Compute task (the "sharing") |
|---|---|---|
| **P2P encrypted note search** | Encrypted personal notes | Peers with access build and query a distributed search index |
| **Shared secrets vault with analytics** | Team API keys, passwords, env vars | Peers compute: "which secrets are expiring?", "which are unused?", audit logs |
| **Collaborative encrypted knowledge base** | Private team documentation | Peers compute: full-text indexing, tag extraction, link graph analysis |
| **Distributed password health checker** | Encrypted passwords | Peers compute: breach checks (k-anonymity against HaveIBeenPwned), strength scoring, duplicate detection |

---

## 3. Literature & Existing Implementations

### What already exists for encrypted P2P notes/secrets

| Project | What it does | Stack | Compute? |
|---|---|---|---|
| **[PearPass](https://github.com/tetherto/pearpass-app-desktop)** | P2P password manager | Pear + autopass + Autobase | **No** -- storage and sync only |
| **[PeerPass](https://github.com/MKPLKN/peer-pass)** | P2P password manager | Pear + Holepunch | **No** -- CRUD only |
| **[autopass](https://github.com/holepunchto/autopass)** | Multiwriter password/note module | Hypercore + Autobase + Hyperbee | **No** -- it's a data layer, no processing |
| **[Standard Notes](https://standardnotes.com/)** | E2E encrypted notes | Client-server (cloud sync) | **No**, and **not P2P** |
| **[Notesnook](https://github.com/streetwriters/notesnook)** | E2E encrypted notes | Client-server | **No**, and **not P2P** |
| **[Anytype](https://anytype.io/)** | Local-first encrypted workspace | CRDT + IPFS-based any-sync protocol | **No compute delegation** -- search is local-only |
| **[CryptPad](https://cryptpad.org/)** | E2E encrypted collaborative docs | Client-server with E2E encryption | Processing is local; server is relay only |
| **[Conclave](https://conclave-team.github.io/conclave-site/)** | P2P collaborative text editor | CRDT + WebRTC | **No** -- no encryption, no compute delegation |

### Key observation: the gap in the market

Every existing system treats peers as **dumb replicators**: they store and sync data, but all processing (search, indexing, analysis) happens locally on the device that needs the result. Nobody delegates computation to peers.

This is the gap:

```
Existing:    Peer A ←--sync data--→ Peer B    (both compute independently)

Proposed:    Peer A ←--sync data--→ Peer B
                    ←--delegate compute task--→
                    ←--return encrypted result--→
```

### Relevant academic/industry research

| Concept | What it is | Relevance | Feasibility for hackathon |
|---|---|---|---|
| **[Secure Multi-Party Computation (MPC)](https://en.wikipedia.org/wiki/Secure_multi-party_computation)** | Multiple parties jointly compute a function without revealing inputs | Theoretically perfect -- compute on private data without exposing it | **Too complex** -- requires specialized crypto protocols, very slow |
| **[Homomorphic Encryption](https://en.wikipedia.org/wiki/Homomorphic_encryption)** | Compute on encrypted data without decrypting | The "holy grail" -- compute on ciphertext directly | **Way too slow** -- orders of magnitude overhead, not hackathon-viable |
| **[Shamir's Secret Sharing](https://en.wikipedia.org/wiki/Shamir%27s_secret_sharing)** | Split a secret into N shares; any K can reconstruct | Could split data across peers for distributed processing | **Usable for storage/auth**, not for general computation |
| **[Trusted Execution Environments (TEEs)](https://en.wikipedia.org/wiki/Confidential_computing)** | Hardware-isolated secure enclaves (Intel SGX, ARM TrustZone) | Process private data in hardware-protected memory | **Requires specific hardware** -- not portable for a demo |
| **[Blind Indexing](https://maciej.litwiniuk.net/posts/2026-02-25-searchability-for-encrypted-records/)** | Create searchable indexes from encrypted data using keyed hashes | Enables search without decrypting content | **Hackathon-viable** -- straightforward crypto (HMAC), works well |
| **[DHT-based P2P indexing (PCIR)](https://www.sciencedirect.com/science/article/abs/pii/S1389128610001842)** | Distribute search index across DHT peers in clusters | Peers collectively build a search index | **Relevant architecture** -- maps onto Hyperswarm DHT |
| **[Local-first software (Ink & Switch)](https://www.inkandswitch.com/local-first/)** | CRDTs for offline-first, device-owned collaborative data | Foundational philosophy for the challenge | **Already implemented** -- Autobase is essentially this |

### The realistic approach: Trusted Peer Delegation

Instead of cryptographic wizardry, use a simpler model that actually works:

**Peers in an Autobase are already trusted** -- you explicitly invite them via `autopass.createInvite()`. They can read your decrypted data by design. So delegating computation to them isn't a security problem -- they already have access.

This sidesteps MPC/FHE entirely:
1. Peer A has encrypted notes synced via Autobase
2. Peer A requests: "search my notes for X" or "index all my notes"
3. Peer B (who is already an authorized writer/reader) picks up the task
4. Peer B has the decryption key (they're in the Autobase trust circle)
5. Peer B computes the result, writes it back to the shared Autobase
6. Peer A reads the result

The trust model is: **if you've invited someone into your Autobase, you trust them to compute on your data**. This is the same trust model as sharing a 1Password vault with a teammate -- they can already see everything.

---

## 4. Does This Idea Already Exist?

**No.** Not in this specific form.

| What exists | What's missing (our novelty) |
|---|---|
| PearPass: P2P encrypted password storage on Pear | No compute delegation, no search, no analytics |
| Anytype: local-first encrypted workspace with CRDT | Search is local-only, not P2P delegated; uses its own protocol, not Pear |
| Standard Notes / Notesnook: encrypted notes with search | Cloud-based, not P2P; search runs on client only |
| BOINC/Golem: distributed computing | Generic compute, not about private data; uses own protocols, not Pear |
| CryptPad: E2E encrypted collaboration | Server-relayed, not true P2P; no compute delegation |

**The novel combination is**: encrypted private data (notes/secrets) + multiwriter P2P sync via Pear + **delegated computation between trusted peers** where peers can do work on each other's behalf.

Nobody has built "P2P encrypted notes where your peers can search/index/analyze your notes for you."

---

## 5. Novelty We Could Add

### Tier 1: Core differentiator (what makes it unique)

**Distributed task delegation over Autobase** -- peers post "compute requests" (search queries, indexing jobs, analysis tasks) as entries in the shared Hypercore log. Other peers pick up tasks, execute them, and write results back. The Autobase log becomes both a data store AND a task queue.

This is novel because:
- autopass/PearPass are read/write vaults with no processing layer
- No existing Pear app treats the Autobase as a job queue
- It combines data sync + compute in a single protocol layer

### Tier 2: Impressive add-ons

| Feature | Novelty | Effort |
|---|---|---|
| **Blind search index** | Peers build HMAC-based search indexes that enable keyword lookup without exposing plaintext to the index | Medium -- keyed HMAC over note content, store index entries in Hyperbee |
| **Compute credit system** | Track who contributed compute cycles via Hypercore entries; peers earn "credits" for doing work | Low -- just counters in the shared Autobase |
| **Capability-based task routing** | Peers advertise their compute capabilities (CPU cores, available memory); task assigner picks the best peer | Low -- metadata in the Hyperswarm announcement |
| **Offline-first compute queue** | Tasks queue up when peers are offline; execute when they reconnect and sync | Free -- Autobase already handles offline-first sync |

### Tier 3: "Wow factor" for judges

| Feature | Why it impresses |
|---|---|
| **Live demo: phone searches laptop's notes** | Phone posts search query → laptop picks it up, computes results, writes back → phone displays results. All P2P, no server. |
| **Real-time task dashboard** | Visual showing tasks flowing between peers, compute progress, results arriving |
| **"Your data never left your trust circle"** | Narrative around how this replaces cloud APIs (Notion, Evernote, 1Password) with zero-infrastructure compute |

---

## 6. What Would Need to Be Built

### Architecture overview

```
┌─────────────────────────────────────────────────────┐
│                  Shared Autobase                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Notes/   │  │ Compute  │  │ Results/          │  │
│  │ Secrets  │  │ Tasks    │  │ Indexes           │  │
│  │ (entries)│  │ (entries)│  │ (entries)         │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
└──────────────────┬──────────────────────────────────┘
                   │ replicated via
                   │ Hyperswarm DHT
        ┌──────────┼──────────┐
        │          │          │
   ┌────▼───┐ ┌───▼────┐ ┌───▼────┐
   │ Peer A │ │ Peer B │ │ Peer C │
   │ writes │ │ picks  │ │ picks  │
   │ notes  │ │ up     │ │ up     │
   │ + posts│ │ search │ │ index  │
   │ tasks  │ │ task   │ │ task   │
   └────────┘ └────────┘ └────────┘
```

### General components (not exact implementation)

1. **Data layer** -- Notes/secrets CRUD via autopass or custom Autobase schema
   - Encrypted note storage (Autobase + Hyperbee)
   - Multiwriter support (invite/pair peers)
   - Standard encrypted fields: title, body, tags, timestamps

2. **Task layer** -- Compute task lifecycle on the same Autobase
   - Task schema: `{ type: 'task', action: 'search'|'index'|'analyze', params: {...}, status, assignee, result }`
   - Task posting: any peer writes a task entry
   - Task claiming: peers watch for unclaimed tasks, claim by writing an update
   - Result writing: compute peer writes result entry back to Autobase

3. **Compute engine** -- Actual processing logic
   - Search: full-text scan or blind index lookup over synced notes
   - Indexing: build keyword→note mappings, write index entries to Hyperbee
   - Analysis: duplicate detection, expiry checks, tag extraction, word counts
   - Runs locally on the peer that claimed the task

4. **Peer discovery & capability** -- Hyperswarm + metadata
   - Join a topic (shared secret or Autobase discovery key)
   - Announce capabilities (available CPU, battery, online status)
   - Simple routing: prefer peers with more resources or lower load

5. **UI/Dashboard** -- Visualize the system
   - Note editor (create/edit encrypted notes)
   - Connected peers list with status
   - Task queue: pending, in-progress, completed
   - Search results view
   - Real-time updates as tasks flow between peers

6. **Trust & auth** -- Leveraging autopass invitation model
   - Invite-based: `createInvite()` → share code → `pair()`
   - All peers in the Autobase can read all data (trusted circle)
   - Optional: read-only writers who can compute but not modify notes

---

## 7. Feasibility Assessment

| Aspect | Assessment |
|---|---|
| **Is it buildable in a hackathon?** | Yes -- autopass handles 80% of the data layer. The task layer is ~200 lines of Autobase schema + event handling. Search/indexing is straightforward JS. |
| **Is the Pear stack mature enough?** | Yes -- PearPass proves production-grade apps work on it. autopass API is clean and documented. |
| **Is the compute delegation actually useful?** | Yes -- "my phone has low battery, let my laptop do the search" is a real scenario. Distributed indexing across devices is genuinely useful. |
| **Will judges see it as fitting the challenge?** | Yes -- encrypted secrets (notes/passwords) synced via Autobase with DHT swarming. The compute layer is the differentiator, not a contradiction. |
| **Does it already exist?** | No -- this specific combination (Pear + encrypted notes + peer compute delegation) has no existing implementation. |

---

## 8. Sources

### Pear Ecosystem
- [Pear Runtime Docs](https://docs.pears.com/)
- [Holepunch GitHub](https://github.com/holepunchto)
- [autopass](https://github.com/holepunchto/autopass) -- Multiwriter password/note sharing module
- [PearPass Desktop](https://github.com/tetherto/pearpass-app-desktop) -- Official P2P password manager
- [PeerPass](https://github.com/MKPLKN/peer-pass) -- Community P2P password manager
- [pearpass-example](https://github.com/holepunchto/pearpass-example) -- Minimal autopass example app
- [Hyperswarm](https://github.com/holepunchto/hyperswarm) -- DHT-based peer discovery
- [HyperDHT](https://github.com/holepunchto/hyperdht) -- The DHT powering Hyperswarm
- [Autobase](https://github.com/holepunchto/autobase) -- Multiwriter Hypercore
- [Hyperbee](https://github.com/holepunchto/hyperbee) -- Append-only B-tree on Hypercore
- [blind-pairing-core](https://github.com/holepunchto/blind-pairing-core) -- Secure pairing module

### Encrypted Notes & Local-First
- [Standard Notes](https://standardnotes.com/) -- E2E encrypted notes (cloud-based)
- [Notesnook](https://github.com/streetwriters/notesnook) -- Open source E2E encrypted notes
- [Anytype](https://anytype.io/) -- Local-first encrypted workspace (any-sync protocol)
- [CryptPad](https://cryptpad.org/) -- E2E encrypted collaborative docs
- [Peergos](https://github.com/Peergos/Peergos) -- P2P encrypted file storage & social network
- [Ink & Switch: Local-first software](https://www.inkandswitch.com/local-first/) -- Foundational research paper

### Cryptography & Secure Computation
- [Secure Multi-Party Computation (Wikipedia)](https://en.wikipedia.org/wiki/Secure_multi-party_computation)
- [Partisia MPC Guide 2026](https://www.partisia.com/tech/multi-party-computation)
- [Shamir's Secret Sharing](https://en.wikipedia.org/wiki/Shamir%27s_secret_sharing)
- [Blind Indexing for Encrypted Records](https://maciej.litwiniuk.net/posts/2026-02-25-searchability-for-encrypted-records/)
- [Searchable Encryption (USENIX)](https://www.usenix.org/system/files/sec21-xu-min.pdf)
- [DHT P2P Indexing - PCIR (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S1389128610001842)
- [Confidential Computing (IBM)](https://www.ibm.com/think/topics/confidential-computing)
- [Homomorphic Encryption for P2P (Springer)](https://link.springer.com/article/10.1007/s12083-021-01076-8)

### Academic
- [Stanford CS244B: P2P Note Taking App](http://www.scs.stanford.edu/20sp-cs244b/projects/Peer-to-Peer%20Note%20Taking%20App.pdf)
- [Stanford CS244B: CRDT Collaborative Editor](https://www.scs.stanford.edu/24sp-cs244b/projects/Local-based_collaborative_text_editor_using_CRDT.pdf)
- [MUTE: Scalable P2P Collaborative Editor with CRDT & E2E](https://github.com/coast-team/mute)
- [Browser as Botnet (Brannon Dorsey)](https://medium.com/@brannondorsey/browser-as-botnet-or-the-coming-war-on-your-web-browser-be920c4f718)
- [Volunteer Computing Survey (ACM)](https://dl.acm.org/doi/10.1145/3320073)

### Distributed Computing
- [P2P Foundation: Distributed Computation](https://wiki.p2pfoundation.net/Distributed_Computation)
- [Awesome Decentralized Apps](https://github.com/croqaz/awesome-decentralized)
- [Distributed Access Control in P2P Databases (Springer)](https://link.springer.com/chapter/10.1007/978-3-642-13739-6_8)
