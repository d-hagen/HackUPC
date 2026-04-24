# Pear / Holepunch P2P Stack - Practical Reference

Research date: 2026-04-25. Versions: Hypercore 11.28.1, Hyperswarm 4.17.0, Autobase 7.27.3, Autopass 3.4.1.

---

## 1. Pear Runtime

### What It Is
Pear is a runtime for building cross-platform P2P desktop and terminal apps. It runs on the Bare JS engine (not Node.js, not a browser). Apps are distributed peer-to-peer via `pear://` links -- no servers, no app stores.

### Project Init & Structure

```bash
npm i pear -g
pear init [template] [dir]    # templates: default, ui, node-compat, or pear:// link
pear run --dev .              # run in dev mode from local dir
pear run pear://somekey       # run a published app by link
```

**Minimal project structure:**
```
my-app/
  package.json     # MUST have "name" field; "pear" section for config
  index.js         # terminal app entry (or index.html for desktop)
```

**package.json for a terminal app:**
```json
{
  "name": "my-p2p-app",
  "main": "index.js",
  "pear": {
    "name": "my-p2p-app"
  },
  "dependencies": {
    "hyperswarm": "^4.17.0",
    "autobase": "^7.27.3",
    "corestore": "^7.4.7"
  }
}
```

**package.json for a desktop app (Electron):**
```json
{
  "name": "my-desktop-app",
  "main": "index.js",
  "pear": {
    "name": "my-desktop-app",
    "gui": {
      "backgroundColor": "#1b1d29",
      "width": 1220,
      "height": 808
    }
  },
  "dependencies": {
    "pear-electron": "...",
    "pear-bridge": "...",
    "autopass": "^3.4.1",
    "corestore": "^7.4.7"
  }
}
```

### Desktop App Entry Point (index.js)
```javascript
import Runtime from 'pear-electron'
import Bridge from 'pear-bridge'

const bridge = new Bridge()
await bridge.ready()

const runtime = new Runtime()
const pipe = await runtime.start({ bridge })
pipe.on('close', () => Pear.exit())
```
The actual app logic goes in `app.js` (loaded by `index.html` in the Electron webview). The bridge connects the Electron frontend to the Bare backend.

### Global `Pear` API

Available globally in all Pear apps:

```javascript
// Key properties
Pear.app.key         // Buffer - app key (null when running from disk)
Pear.app.storage     // string - app storage directory path
Pear.app.dev         // boolean - running in dev mode?
Pear.app.name        // string - app name
Pear.app.options     // object - config from package.json pear section
Pear.app.args        // array - CLI args
Pear.app.flags       // object - parsed CLI flags
Pear.app.channel     // string - release channel
Pear.app.checkpoint  // any - state persisted across restarts

// Methods
await Pear.checkpoint(value)  // persist state for next startup
Pear.teardown(async () => {}) // register cleanup handler
Pear.exit(code)               // clean exit (runs teardown)
```

**Deprecated APIs** (use separate modules instead): `Pear.restart()`, `Pear.config`, `Pear.messages()`, `Pear.message()`, `Pear.updates()`, `Pear.Window`, `Pear.View`.

### CLI Commands
```bash
pear init [template] [dir]    # scaffold project
pear run [--dev] <link|dir>   # run app (--devtools for inspector)
pear stage <channel> [dir]    # sync to app drive for distribution
pear seed <channel|link>      # make app available to peers
pear release <channel> [dir]  # mark production release
pear info [link]              # show app/platform info
pear dump <link> <dir>        # download app files from link
pear touch                    # generate new pear link
pear drop                     # delete app data permanently
pear gc releases|sidecars     # garbage collect
```

### Gotchas
- **Not Node.js.** Bare runtime has different module semantics. Use `bare-*` modules instead of Node builtins (`bare-fs`, `bare-crypto`, `bare-http1`, etc.).
- **`pear.config` is deprecated.** Use `Pear.app.options` for configuration.
- **Versioning is automatic.** The `version` field in `package.json` is ignored by Pear.
- **Many Pear.* APIs are deprecated** and moved to separate modules (`pear-updates`, `pear-messages`, `pear-wakeups`, etc.). The Pear docs list them but don't always make it clear they're deprecated until you read the API reference.

---

## 2. Hypercore (v11.28.1)

### What It Is
A secure, distributed, append-only log. The fundamental data structure -- everything else builds on top of it.

### Constructor
```javascript
const Hypercore = require('hypercore')

// Create new core
const core = new Hypercore(storage, { valueEncoding: 'json' })

// Open existing core by key
const core = new Hypercore(storage, existingKey, { valueEncoding: 'json' })
```

**Key constructor options:**
- `valueEncoding`: `'json'` | `'utf-8'` | `'binary'` (default)
- `keyPair`: `{ publicKey, secretKey }`
- `encryption`: `{ key: Buffer }` -- encrypt at rest
- `timeout`: milliseconds for operations (0 = no timeout)
- `writable`: boolean (default true)
- `createIfMissing`: boolean (default true)
- `onwait`: callback when `get()` waits for download

### Properties (available after `await core.ready()`)
```javascript
core.key              // Buffer - public key (32 bytes)
core.discoveryKey     // Buffer - for peer discovery (hash of key)
core.id               // string - z-base-32 encoded public key
core.length           // number - block count
core.byteLength       // number - total bytes
core.writable         // boolean
core.readable         // boolean
core.fork             // number - fork ID (increments on truncate)
core.peers            // array - connected peers
core.contiguousLength // number - blocks available from index 0
core.signedLength     // number - quorum-verified length
```

### Core Methods
```javascript
// Write
const { length, byteLength } = await core.append('hello')
const { length, byteLength } = await core.append(['batch', 'of', 'blocks'])

// Read
const block = await core.get(0)                    // by index
const block = await core.get(0, { timeout: 5000 }) // with timeout
const has = await core.has(0)                       // check existence
const has = await core.has(0, 10)                   // range check

// Wait for new data from peers
const updated = await core.update()

// Byte-level seek
const [blockIndex, offset] = await core.seek(byteOffset)

// Truncate (destructive, increments fork)
await core.truncate(newLength)

// Clear cached blocks
await core.clear(start, end)
```

### Streams
```javascript
// Read stream
const rs = core.createReadStream({ start: 0, end: core.length, live: false })
const rs = core.createReadStream({ live: true }) // real-time updates

// Write stream
const ws = core.createWriteStream()

// Byte stream
const bs = core.createByteStream({ byteOffset: 0 })
```

### Download Management
```javascript
const range = core.download({ start: 0, end: 100 })
await range.done() // wait for download to complete
range.destroy()    // cancel download
```

### Replication
```javascript
// Create replication stream
const stream = core.replicate(true)  // true = initiator
const stream = core.replicate(false) // false = responder

// Or pass an existing stream for multiplexing
const stream = core.replicate(existingNoiseStream)

// Signal that peer discovery is happening
const done = core.findingPeers()
// ... start discovery ...
done() // call when discovery round completes
```

### User Data (local-only key-value store, NOT replicated)
```javascript
await core.setUserData('myKey', Buffer.from('myValue'))
const val = await core.getUserData('myKey')
```

### Events
```javascript
core.on('ready', () => {})
core.on('close', () => {})
core.on('append', () => {})                        // new blocks (local or remote)
core.on('truncate', (ancestors, forkId) => {})
core.on('peer-add', (peer) => {})
core.on('peer-remove', (peer) => {})
core.on('upload', (index, byteLength, peer) => {})
core.on('download', (index, byteLength, peer) => {})
```

### Static Methods
```javascript
Hypercore.discoveryKey(key)            // Buffer -> Buffer
Hypercore.key(manifest)               // manifest -> key
Hypercore.createProtocolStream(true)   // create noise stream with protomux
Hypercore.MAX_SUGGESTED_BLOCK_SIZE     // 15MB
```

### Gotchas
- **v10+ is not compatible with v9.** Complete break in storage format and wire protocol.
- **random-access-storage no longer supported.** Use Corestore or Hypercore Storage.
- **Storage path matters.** In Pear, use `Pear.app.storage + '/some-path'` for persistence.
- `core.length` vs `core.signedLength` -- length includes unverified appends. For trustworthy length, use signedLength.

---

## 3. Hyperswarm (v4.17.0)

### What It Is
High-level peer discovery and connection over a distributed hash table (HyperDHT). Finds peers by 32-byte "topic" keys and establishes encrypted connections.

### Constructor
```javascript
const Hyperswarm = require('hyperswarm')

const swarm = new Hyperswarm({
  // All optional:
  keyPair: await store.createKeyPair('hyperswarm'), // noise keypair
  seed: Buffer.alloc(32),          // or generate keypair from seed
  maxPeers: 100,                   // connection limit
  firewall: (remotePublicKey) => false, // return true to reject
  dht: existingDHTInstance
})
```

### Properties
```javascript
swarm.connecting   // number - pending connections
swarm.connections  // Set - active connections (Noise-encrypted duplex streams)
swarm.peers        // Map<hex, PeerInfo> - known peers
swarm.dht          // underlying HyperDHT instance
```

### Core Methods
```javascript
// Join a topic (32-byte buffer)
const discovery = swarm.join(topicBuffer, {
  server: true,   // accept incoming connections (default true)
  client: true,   // actively seek peers (default true)
  limit: Infinity  // max peers for this topic
})
await discovery.flushed() // wait until announced to DHT

// Leave a topic (does NOT close existing connections)
await swarm.leave(topicBuffer)

// Direct peer connection by public key
swarm.joinPeer(noisePublicKey)
swarm.leavePeer(noisePublicKey)

// Check topic status
const info = swarm.status(topicBuffer) // PeerDiscovery | undefined

// Wait for pending operations
await swarm.flush()

// Suspend/resume (for mobile or background)
await swarm.suspend()
await swarm.resume()

// Listen explicitly (usually automatic)
await swarm.listen()

// Shutdown
await swarm.destroy()
```

### Events
```javascript
// THE key event - fires for every new peer connection
swarm.on('connection', (socket, peerInfo) => {
  // socket is a Noise-encrypted duplex stream
  // peerInfo.publicKey - remote peer's public key
  // peerInfo.topics - topics this peer joined (client mode only)

  // Replicate a core or corestore over this connection:
  core.replicate(socket)
  // OR
  store.replicate(socket)
})

swarm.on('update', () => {})           // internal state changed
swarm.on('ban', (peerInfo, err) => {}) // peer banned
```

### PeerDiscovery (returned by swarm.join)
```javascript
const discovery = swarm.join(topic)
await discovery.flushed()                       // fully announced
await discovery.refresh({ client: true, server: true }) // re-announce
await discovery.destroy()                       // stop discovery
```

### PeerInfo
```javascript
peerInfo.publicKey    // Buffer
peerInfo.topics       // Array<Buffer> (client connections only)
peerInfo.prioritized  // boolean - rapid reconnect
peerInfo.ban()        // ban peer (doesn't close existing connection)
```

### Common Pattern: Hyperswarm + Corestore Replication
```javascript
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')

const store = new Corestore('./storage')
const swarm = new Hyperswarm()

// Replicate all cores in the store over every connection
swarm.on('connection', (socket) => store.replicate(socket))

// Join the core's discovery key as topic
const core = store.get({ name: 'my-core' })
await core.ready()
swarm.join(core.discoveryKey)
await swarm.flush()
```

### Gotchas
- **Topics must be exactly 32 bytes.** Use `crypto.createHash('sha256').update('my-topic').digest()` or `hypercore-crypto.discoveryKey(Buffer.from('topic'))`.
- **`swarm.leave()` does NOT close existing connections.** It only stops new discovery. You must manually destroy connections if needed.
- **Server mode connections don't have `peerInfo.topics`.** Only client-mode connections know which topic they connected for.
- **`firewall` must be synchronous.** Can't do async checks.
- **Connection deduplication is automatic.** Two peers will only have one connection even if they share multiple topics.

---

## 4. Autobase (v7.27.3)

### What It Is
Multi-writer database built on Hypercore. Multiple peers each have their own append-only log; Autobase linearizes them into a single deterministic view. This is the key primitive for collaborative P2P apps.

### Constructor
```javascript
const Autobase = require('autobase')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')

const store = new Corestore('./storage')

// Create new autobase
const base = new Autobase(store, null, {
  open(store) {
    // Create the materialized view
    // MUST only use the store argument, nothing external
    return new Hyperbee(store.get('view'), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
  },
  async apply(nodes, view, host) {
    // Process linearized nodes into the view
    // MUST be fully deterministic
    for (const node of nodes) {
      const op = JSON.parse(node.value.toString())
      if (op.type === 'put') await view.put(op.key, op.value)
      if (op.type === 'del') await view.del(op.key)
    }
    await view.flush()
  },
  valueEncoding: 'json',  // encoding for appended values
  ackInterval: 1000,       // auto-ack every 1s (indexers only)
  encrypt: true,           // enable encryption
  encryptionKey: someKey   // 32-byte encryption key
})

// Load existing autobase by key
const base = new Autobase(store, existingKey, { open, apply })
```

**All constructor options:**
| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `open` | `(store, host) => view` | **required** | Must return view from store only |
| `apply` | `async (nodes, view, host) => {}` | **required** | Must be deterministic |
| `optimistic` | boolean | false | Allow non-writer appends |
| `close` | `async (view) => {}` | - | Cleanup |
| `valueEncoding` | string/codec | - | For appended values |
| `ackInterval` | number (ms) | - | Auto-ack interval for indexers |
| `encryptionKey` | Buffer | - | Encryption key |
| `encrypt` | boolean | false | Auto-encrypt |
| `fastForward` | boolean/object | true | Enable fast-forward catchup |
| `bigBatches` | boolean | false | Larger apply batches |

### Properties
```javascript
base.key           // Buffer - primary key
base.discoveryKey  // Buffer - for networking
base.isIndexer     // boolean
base.writable      // boolean - is this peer a writer?
base.view          // the materialized view (e.g., a Hyperbee)
base.length        // number - system core length
base.signedLength  // number - quorum-signed checkpoint
base.paused        // boolean
```

### Methods
```javascript
// Append data (only writers can do this, unless optimistic mode)
await base.append({ type: 'put', key: 'foo', value: 'bar' })

// Fetch latest data and update view
await base.update()

// Manually ack (indexers only)
await base.ack()
await base.ack(true) // background ack (triggers timer)

// Replication (same as corestore)
const stream = base.replicate(isInitiator)
// or pass existing socket:
base.replicate(socket)

// Pause/resume apply processing
await base.pause()
await base.resume()

// Hash the system state
const hash = await base.hash()

// Get current writer heads (for debugging forks)
const heads = base.heads()

// User data (local only, not replicated)
await base.setUserData('key', 'value')
const val = await base.getUserData('key')
```

### Host Methods (inside `apply` callback only)
```javascript
async apply(nodes, view, host) {
  for (const node of nodes) {
    const op = node.value

    if (op.type === 'add-writer') {
      // Add as writer + indexer
      await host.addWriter(op.key, { indexer: true })
    }
    if (op.type === 'remove-writer') {
      if (host.removeable(op.key)) {
        await host.removeWriter(op.key)
      }
    }
    if (op.type === 'ack-writer') {
      // For optimistic mode - verify a non-writer's append
      await host.ackWriter(op.key)
    }

    // host.interrupt(reason) - abort apply, close base
  }
}
```

### Events
```javascript
base.on('update', () => {})           // view updated after apply
base.on('writable', () => {})         // became a writer
base.on('unwritable', () => {})       // lost writer status
base.on('is-indexer', () => {})       // became an indexer
base.on('is-non-indexer', () => {})   // lost indexer status
base.on('error', (err) => {})        // error during update
base.on('warning', (warning) => {})  // non-fatal warning
base.on('fast-forward', (to, from) => {}) // caught up via checkpoint
base.on('interrupt', (reason) => {})  // host.interrupt() called
```

### Writer Management Flow (the critical path)

The first peer creates the base and is automatically the first writer + indexer. To add more writers:

```javascript
// Peer A: create base (is writer + indexer automatically)
const baseA = new Autobase(storeA, null, { open, apply })
await baseA.ready()

// Peer B: join by key (NOT a writer yet)
const baseB = new Autobase(storeB, baseA.key, { open, apply })
await baseB.ready()
// baseB.writable === false at this point

// Peer B sends its local writer key to Peer A somehow
// (over the swarm connection, via the base itself, etc.)

// Peer A: in their apply function, they handle an "add-writer" message
await baseA.append({
  type: 'add-writer',
  key: baseB.local.key  // Peer B's local writer key
})

// In apply:
// if (op.type === 'add-writer') await host.addWriter(op.key, { indexer: true })

// After replication and update, Peer B is now a writer
```

### Complete Working Example
```javascript
const Autobase = require('autobase')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const Hyperswarm = require('hyperswarm')

const store = new Corestore('./my-storage')
const swarm = new Hyperswarm()

const base = new Autobase(store, null, {
  open(store) {
    return new Hyperbee(store.get('view'), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
  },
  async apply(nodes, view, host) {
    for (const node of nodes) {
      const op = node.value
      if (op.type === 'add-writer') {
        await host.addWriter(op.key, { indexer: true })
        continue
      }
      if (op.type === 'put') {
        await view.put(op.key, op.value)
      }
    }
    await view.flush()
  },
  valueEncoding: 'json',
  ackInterval: 1000
})

await base.ready()

// Network
swarm.on('connection', (socket) => base.replicate(socket))
swarm.join(base.discoveryKey)
await swarm.flush()

// Write data
await base.append({ type: 'put', key: 'hello', value: { msg: 'world' } })

// Read from view
const entry = await base.view.get('hello')
console.log(entry.value) // { msg: 'world' }

// Iterate view
for await (const entry of base.view.createReadStream()) {
  console.log(entry.key, entry.value)
}
```

### Gotchas -- CRITICAL

1. **The `open` function MUST only use its `store` argument.** If you reference external state, undo/redo during reordering will break. The view must be fully derivable from the store alone.

2. **The `apply` function MUST be deterministic.** Same nodes in same order must produce identical view state on every peer. No timestamps, no randomness, no external API calls.

3. **Views cannot be added dynamically.** They must be defined in `open` at construction time. Open issue #181 with no response.

4. **`base.local.key` is what you send to other peers** for writer addition. This is the local writer's Hypercore key, not `base.key`.

5. **Consensus ordering can have edge cases.** Issue #204 reported a case where 1 out of 10 peers had the first two messages swapped. This was fixed, but indicates the linearizer can have subtle bugs under high concurrency.

6. **`signedLength` convergence can be delayed** in single-writer, multi-indexer setups (issue #359).

7. **`base.writable` is false until the peer is explicitly added as a writer** via `host.addWriter()` inside `apply`. Just joining by key doesn't make you a writer.

8. **Replication uses corestore's replicate, not hypercore's.** Call `base.replicate(socket)` -- it handles all the internal cores.

9. **Documentation is acknowledged to be incomplete** (issue #186). The README is the most reliable source.

---

## 5. Autopass (v3.4.1) -- Reference Implementation

### What It Is
A complete password manager / shared notes app built on Autobase. It's the best reference for how to build a real app on this stack because it handles all the hard parts: writer management, pairing, encryption, replication.

### Constructor
```javascript
const Autopass = require('autopass')
const Corestore = require('corestore')

// Create new vault
const pass = new Autopass(new Corestore('./storage'))
await pass.ready()

// Pair with existing vault using invite
const pair = Autopass.pair(new Corestore('./storage'), inviteCode)
const pass = await pair.finished()
```

### Key API
```javascript
// CRUD
await pass.add(key, value, file)  // add entry
const entry = await pass.get(key) // get entry
const stream = pass.list()        // stream all entries
await pass.remove(key)            // delete entry

// Writer management
pass.writerKey                     // local writer key
const invite = await pass.createInvite({ readOnly: false })
await pass.addWriter(writerData)   // { key, name, readOnly }
await pass.removeWriter(writerKey)
const writer = await pass.getWriter(key)
const writers = pass.listWriters(query)
await pass.deleteInvite()

// Mirrors (blind replication)
await pass.addMirror(key)
const mirrors = await pass.getMirror()
await pass.removeMirror(key)

// Network control
await pass.suspend()
await pass.resume()
await pass.close()
```

### Events
```javascript
pass.on('update', () => {})    // data changed
pass.on('writable', () => {})  // became a writer (implied from source)
```

### How Autopass Structures Autobase Internally

From the source code, this is the actual pattern:

```javascript
// Boot sequence
this.base = new Autobase(this.store, key, {
  encrypt: true,
  encryptionKey,
  open(store) {
    return HyperDB.bee(store.get('view'), db, {
      extension: false,
      autoUpdate: true
    })
  },
  apply: this._apply.bind(this)
})

// Apply uses a router/dispatcher pattern
async _apply(nodes, view, base) {
  for (const node of nodes) {
    await this.router.dispatch(node.value, { view, base })
  }
  await view.flush()
}

// Commands are dispatched by type:
// '@autopass/add-writer'    -> host.addWriter(key, { indexer })
// '@autopass/remove-writer' -> host.removeWriter(key)
// '@autopass/put'           -> view.insert(key, value)
// '@autopass/del'           -> view.delete(key)
// '@autopass/add-invite'    -> view.insert(invite)
// '@autopass/del-invite'    -> view.delete(invite)
// '@autopass/add-mirror'    -> view.insert(mirror)
// '@autopass/del-mirror'    -> view.delete(mirror)
```

**Key architectural choices:**
- Uses `HyperDB` (not raw Hyperbee) for the view -- HyperDB adds schema support on top of Hyperbee.
- Uses `blind-pairing` for secure invite-based peer discovery.
- Uses `blind-peering` for background mirror synchronization.
- Commands are encoded with `hyperdispatch` (type-based routing).
- Uses `hyperschema` for structured data encoding.

### Replication Setup (from source)
```javascript
// Hyperswarm for networking
this.swarm = new Hyperswarm({
  keyPair: await this.store.createKeyPair('hyperswarm'),
  bootstrap: this.bootstrap,
  relayThrough: this.relayThrough
})

// Replicate base over every connection
this.swarm.on('connection', (socket) => this.base.replicate(socket))

// Join base's discovery key
this.swarm.join(this.base.discoveryKey)
```

### Gotchas
- **Requires Corestore 7** (backed by RocksDB). Earlier versions won't work.
- **Uses `HyperDB` not raw `Hyperbee`** for the view. If you're building something simpler, you can use Hyperbee directly.
- **Pairing is complex.** The `blind-pairing` module handles secure invite exchange. For a hackathon, you might want to skip this and just share keys manually.

---

## 6. Pearpass-Example -- App Structure Reference

### File Layout
```
pearpass-example/
  assets/          # icons, images
  css/             # stylesheets
  .gitignore
  LICENSE
  README.md
  app.js           # main application logic (Autopass usage)
  index.html       # Electron frontend
  index.js         # Pear/Electron bootstrap
  package.json     # config + deps
```

### package.json
```json
{
  "name": "pearwords",
  "version": "0.0.3",
  "pear": {
    "gui": {
      "backgroundColor": "#1b1d29",
      "width": 1220,
      "height": 808
    }
  },
  "scripts": {
    "dev": "pear run -d .",
    "test": "brittle test/*.test.js",
    "lint": "standard --fix"
  },
  "dependencies": {
    "autopass": "...",
    "corestore": "...",
    "pear-bridge": "...",
    "pear-electron": "...",
    "sweetalert2": "..."
  }
}
```

### App Logic Pattern (app.js)
```javascript
const Autopass = require('autopass')
const Corestore = require('corestore')

// Storage uses Pear.app.storage for persistence
const baseDir = Pear.app.storage + '/store'

// Create or load vault
const autopass = new Autopass(new Corestore(baseDir))
await autopass.ready()

// Data is stored as serialized arrays
// ["password", username, password, website]
// ["note", title, content]
await autopass.add(key, JSON.stringify(['password', user, pass, url]))

// List all entries
for await (const entry of autopass.list()) {
  const data = JSON.parse(entry.value)
  // data[0] is type, rest is fields
}

// Pairing
const invite = await autopass.createInvite()
// Share this 106-char invite string with peer

// Or join via invite
const pair = Autopass.pair(new Corestore(baseDir), inviteString)
const autopass = await pair.finished()

// Listen for updates
autopass.on('update', () => refreshUI())
autopass.on('writable', () => enableWriteUI())
```

---

## 7. Quick-Start Template for a Terminal P2P App

For a hackathon, this is the minimal working setup:

```javascript
// index.js - Pear terminal app
const Autobase = require('autobase')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const Hyperswarm = require('hyperswarm')

const store = new Corestore(Pear.app.storage + '/data')
const swarm = new Hyperswarm()

// Get the base key from args, or create new
const existingKey = Pear.app.args[0] || null

const base = new Autobase(store, existingKey, {
  open(store) {
    return new Hyperbee(store.get('view'), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
  },
  async apply(nodes, view, host) {
    for (const node of nodes) {
      const op = node.value
      switch (op.type) {
        case 'add-writer':
          await host.addWriter(op.key, { indexer: true })
          break
        case 'put':
          await view.put(op.key, op.value)
          break
        case 'del':
          await view.del(op.key)
          break
      }
    }
    await view.flush()
  },
  valueEncoding: 'json',
  ackInterval: 1000
})

await base.ready()
console.log('Base key:', base.key.toString('hex'))

// Teardown
Pear.teardown(async () => {
  await swarm.destroy()
  await base.close()
  await store.close()
})

// Network
swarm.on('connection', (socket) => base.replicate(socket))
swarm.join(base.discoveryKey)
await swarm.flush()

// Now base.view is a Hyperbee you can read/write
base.on('update', async () => {
  console.log('View updated, length:', base.view.version)
})
```

Run: `pear run --dev .` or `pear run --dev . <hex-key-to-join>`

---

## 8. Docs vs Reality Assessment

| Component | Docs Quality | Notes |
|-----------|-------------|-------|
| Pear Runtime | Fair | Pear docs site is SPA-based and doesn't render well for scraping. Many APIs listed in nav are deprecated without clear indication. The CLI reference and API reference pages are the most reliable. |
| Hypercore | Good | README is comprehensive and matches v11. Breaking change from v9 is well documented. |
| Hyperswarm | Good | README is accurate and complete. API is stable and straightforward. |
| Autobase | Mixed | README is the best source. The Pear docs page for Autobase has acknowledged documentation gaps (issue #186). The apply/open pattern is the hardest to get right and the docs don't emphasize the determinism requirement enough. |
| Autopass | Minimal | README is thin. The source code is the real documentation. |
| Pearpass-example | Minimal | README only has setup steps. You need to read the source to understand patterns. |

### What Actually Works
- Hypercore, Hyperswarm, Corestore: stable, well-tested, reliable.
- Autobase: works but has edge cases under high concurrency. The core linearization is solid for typical usage.
- Pear runtime: works for building apps, but the ecosystem is still maturing. Many modules are in flux.

### What to Watch Out For
- The `open`/`apply` determinism requirement is absolute and easy to violate accidentally.
- Writer management requires explicit action in the apply function -- there's no built-in "auto-add writer" mechanism.
- For a hackathon, use Autopass as your reference, not the abstract Autobase docs.
- If you don't need multiwriter, just use Hypercore + Hyperswarm directly -- much simpler.
