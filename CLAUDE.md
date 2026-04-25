# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

PeerCompute — a zero-infrastructure P2P distributed computing platform built on the Pear/Holepunch protocol stack. Peers share CPU power over Hyperswarm DHT without servers, blockchain, or tokens. The core innovation is using **Autobase as a distributed task queue** (repurposing a document-sync log as a job scheduler).

## Commands

All commands run from `app/`:

```bash
npm install                          # install dependencies
npm test                             # run tests (brittle test/*.test.js)
node boot.js                         # start local DHT bootstrap for testing
BOOTSTRAP=localhost:8000 node request-compute.js   # start requester (local)
BOOTSTRAP=localhost:8000 node offer-compute.js     # start worker (local)
node request-compute.js              # start requester (public DHT)
node offer-compute.js                # start worker (public DHT)
node demos/demo.js                   # self-contained 2-peer demo
node demos/demo-generic.js           # 6 generic task types demo
node test/test-jobs.js               # distributed job test (split/join)
```

No linter is configured. No build step — runs directly on Pear Runtime (Bare JS engine), not Node.js. All Node.js stdlib imports are mapped to `bare-*` polyfills in package.json.

## Environment Variables

- `BOOTSTRAP=host:port` — DHT bootstrap node address for local testing
- `ALLOW_SHELL=1` — opt-in to enable shell command execution on workers

## Architecture

### Dual-Swarm Design

The system uses **two separate Hyperswarm instances** per peer — this is intentional and critical:

1. **Discovery swarm** (joins `NETWORK_TOPIC`): lightweight JSON signaling — requesters broadcast advertisements, workers send join-requests. No Autobase replication here.
2. **Replication swarm** (joins `base.discoveryKey`): binary Protomux protocol for Autobase + Corestore + Hyperdrive replication.

Mixing JSON writes with binary replication on the same swarm corrupts the Protomux protocol. Never combine them.

### Core Modules

- **`request-compute.js`** — Requester CLI. Creates Autobase + Hyperdrive, advertises on discovery swarm, posts tasks, collects results. Commands: `run`, `job`, `file`, `shell`, `upload`, `download`, `status`.
- **`offer-compute.js`** — Worker CLI. Discovers requesters, picks best by reputation, joins Autobase replication, polls for tasks every 2s, roams to next requester after 15s idle.
- **`base-setup.js`** — Shared setup: Autobase + Hyperswarm + Hyperdrive creation, handles local vs public DHT.
- **`worker.js`** — Task executor. JS tasks via `new AsyncFunction(...)`, shell tasks via `bare-subprocess`. Task code receives `readFile`, `writeFile`, `listFiles` as injected arguments for Hyperdrive I/O.
- **`reputation.js`** — Local-only reputation ledger (`donated - consumed = score`). Self-reported, not distributed.

### Distributed Job Protocol

Job files in `jobs/` export four functions: `data`, `split(data, n)`, `compute(chunk)`, `join(results)`. The requester splits data into N chunks, posts each as a task with `assignedTo: workerId` (round-robin), workers execute their assigned chunks, requester collects and joins results.

### Task Assignment

Tasks use `assignedTo: workerId` to prevent duplicate execution. Workers only execute tasks where `assignedTo` is null or matches their own ID.

### Worker Roaming

Workers automatically leave after 15s idle and discover the next highest-reputation requester with pending tasks — creating a dynamic marketplace where compute flows to demand.
