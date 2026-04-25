import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import crypto from 'crypto'

// CLI args: node peer.js <storage-dir> <peer-name> [bootstrap-key]
const storagePath = process.argv[2] || './peer-store'
const peerName = process.argv[3] || 'peer-' + crypto.randomBytes(2).toString('hex')
const bootstrapKey = process.argv[4] || null

const store = new Corestore(storagePath)

function open (store) {
  return store.get('view', { valueEncoding: 'json' })
}

async function apply (nodes, view, base) {
  for (const node of nodes) {
    // Handle writer-add requests
    if (node.value.type === 'add-writer') {
      await base.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true })
    }
    await view.append(node.value)
  }
}

// If bootstrap key is provided, join existing autobase; otherwise create new one
const base = new Autobase(store, bootstrapKey ? Buffer.from(bootstrapKey, 'hex') : null, {
  valueEncoding: 'json',
  open,
  apply
})

await base.ready()

const myWriterKey = base.local.key.toString('hex')

console.log(`[${peerName}] started`)
console.log(`[${peerName}] autobase key: ${base.key.toString('hex')}`)
console.log(`[${peerName}] writer key:   ${myWriterKey.slice(0, 16)}...`)
console.log(`[${peerName}] discovery key: ${base.discoveryKey.toString('hex').slice(0, 16)}...`)

// ---- Hyperswarm: discover and replicate ----
const swarm = new Hyperswarm()

swarm.on('connection', (conn) => {
  console.log(`[${peerName}] peer connected!`)
  base.replicate(conn)
})

swarm.join(base.discoveryKey, { client: true, server: true })
await swarm.flush()

console.log(`[${peerName}] joined swarm`)

// ---- Watch for updates ----
base.on('update', async () => {
  const len = base.view.length
  console.log(`[${peerName}] autobase updated -> ${len} entries`)

  // Print latest entry
  if (len > 0) {
    const latest = await base.view.get(len - 1)
    console.log(`[${peerName}] latest:`, latest)
  }
})

// ---- Interactive commands via stdin ----
console.log(`\nCommands:`)
console.log(`  add-writer <key>  - authorize a peer as writer`)
console.log(`  task              - post a sample compute task`)
console.log(`  list              - list all entries`)
console.log(`  key               - print writer key (share with other peer)`)
console.log(``)

process.stdin.setEncoding('utf-8')
process.stdin.on('data', async (input) => {
  const line = input.trim()
  const [cmd, ...args] = line.split(' ')

  if (cmd === 'add-writer' && args[0]) {
    await base.append({ type: 'add-writer', key: args[0], by: peerName, ts: Date.now() })
    console.log(`[${peerName}] requested add-writer for ${args[0].slice(0, 16)}...`)
  } else if (cmd === 'task') {
    const task = {
      type: 'task',
      id: crypto.randomUUID(),
      action: 'mandelbrot',
      params: { x: 0, y: 0, w: 64, h: 64, iter: 100 },
      status: 'pending',
      by: peerName,
      ts: Date.now()
    }
    await base.append(task)
    console.log(`[${peerName}] posted task: ${task.id}`)
  } else if (cmd === 'list') {
    console.log(`--- ${base.view.length} entries ---`)
    for (let i = 0; i < base.view.length; i++) {
      const entry = await base.view.get(i)
      console.log(i, entry)
    }
  } else if (cmd === 'key') {
    console.log(`writer key: ${myWriterKey}`)
  } else {
    console.log('unknown command:', cmd)
  }
})

process.on('SIGINT', async () => {
  console.log(`\n[${peerName}] shutting down...`)
  await swarm.destroy()
  await base.close()
  process.exit()
})
