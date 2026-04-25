// Peer A: Task requester — posts compute jobs, receives results
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import crypto from 'crypto'
import fs from 'fs'
import readline from 'readline'

const BOOTSTRAP = process.env.BOOTSTRAP // optional, uses public DHT if not set

fs.rmSync('./store-a', { recursive: true, force: true })

function open (store) { return store.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, base) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      await base.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true })
    }
    await view.append(node.value)
  }
}

const store = new Corestore('./store-a')
const base = new Autobase(store, null, { valueEncoding: 'json', open, apply })
await base.ready()

console.log('=== PEER A (Task Requester) ===')
console.log('Autobase key:', base.key.toString('hex'))
console.log('Writer key:  ', base.local.key.toString('hex'))
console.log('')

const swarmOpts = BOOTSTRAP ? { bootstrap: [{ host: BOOTSTRAP.split(':')[0], port: Number(BOOTSTRAP.split(':')[1]) }] } : {}
const swarm = new Hyperswarm(swarmOpts)
swarm.on('connection', (conn) => {
  console.log('[A] peer connected!')
  base.replicate(conn)
})
swarm.join(base.discoveryKey, { client: true, server: true })
await swarm.flush()
console.log('[A] in swarm, waiting for peers...\n')

// Track printed results
const printed = new Set()

// Watch for results
base.on('update', async () => {
  for (let i = 0; i < base.view.length; i++) {
    const entry = await base.view.get(i)
    if (entry.type === 'result' && !printed.has(entry.taskId)) {
      printed.add(entry.taskId)
      console.log(`\n[A] ★ RESULT from ${entry.by} (task ${entry.taskId.slice(0, 8)}...) ★`)
      if (entry.error) {
        console.log(`[A] Error: ${entry.error}`)
      } else {
        console.log(`[A] Output:`, JSON.stringify(entry.output, null, 2))
      }
      rl.prompt()
    }
  }
})

// Interactive prompt
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function showHelp () {
  console.log(`
Commands:
  add <writer-key>     Authorize a peer as writer
  run <code>           Send JS code to execute (single line)
                       Example: run return 2 + 2
                       Example: run return Array.from({length:10}, (_,i) => i*i)
  task <file.js>       Send a .js file as a task
  list                 Show all entries in the autobase
  help                 Show this help
`)
}

showHelp()
rl.setPrompt('peer-a> ')
rl.prompt()

rl.on('line', async (line) => {
  const input = line.trim()
  if (!input) { rl.prompt(); return }

  if (input.startsWith('add ')) {
    const writerKey = input.slice(4).trim()
    await base.append({ type: 'add-writer', key: writerKey, by: 'peer-A', ts: Date.now() })
    console.log('[A] added writer:', writerKey.slice(0, 16) + '...')

  } else if (input.startsWith('run ')) {
    const code = input.slice(4).trim()
    const id = crypto.randomUUID()
    await base.append({
      type: 'task', id, code, argNames: [], args: [],
      by: 'peer-A', ts: Date.now()
    })
    console.log(`[A] posted task ${id.slice(0, 8)}...`)

  } else if (input.startsWith('task ')) {
    const file = input.slice(5).trim()
    try {
      const code = fs.readFileSync(file, 'utf-8')
      const id = crypto.randomUUID()
      await base.append({
        type: 'task', id, code, argNames: [], args: [],
        by: 'peer-A', ts: Date.now()
      })
      console.log(`[A] posted task from ${file} (${id.slice(0, 8)}...)`)
    } catch (err) {
      console.log(`[A] error reading file: ${err.message}`)
    }

  } else if (input === 'list') {
    console.log(`--- ${base.view.length} entries ---`)
    for (let i = 0; i < base.view.length; i++) {
      const entry = await base.view.get(i)
      if (entry.type === 'result') {
        const out = entry.error ? `ERROR: ${entry.error}` : JSON.stringify(entry.output).slice(0, 80)
        console.log(`  ${i}: result for ${entry.taskId.slice(0, 8)}... → ${out}`)
      } else if (entry.type === 'task') {
        console.log(`  ${i}: task ${entry.id.slice(0, 8)}... code: ${(entry.code || '').slice(0, 60)}`)
      } else {
        console.log(`  ${i}: ${entry.type} (by ${entry.by})`)
      }
    }

  } else if (input === 'help') {
    showHelp()
  } else {
    console.log('Unknown command. Type "help" for usage.')
  }

  rl.prompt()
})

rl.on('close', async () => {
  await swarm.destroy()
  await base.close()
  process.exit()
})
