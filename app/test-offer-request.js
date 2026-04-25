// Quick test: offer-compute + request-compute using direct replication
import Corestore from 'corestore'
import Autobase from 'autobase'
import crypto from 'crypto'
import fs from 'fs'
import { executeTask } from './worker.js'

fs.rmSync('./store-requester', { recursive: true, force: true })
fs.rmSync('./store-worker', { recursive: true, force: true })

function open (store) { return store.get('view', { valueEncoding: 'json' }) }
async function apply (nodes, view, base) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      await base.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true })
    }
    await view.append(node.value)
  }
}

// Create requester + worker
const storeR = new Corestore('./store-requester')
const requester = new Autobase(storeR, null, { valueEncoding: 'json', open, apply })
await requester.ready()

const storeW = new Corestore('./store-worker')
const worker = new Autobase(storeW, requester.key, { valueEncoding: 'json', open, apply })
await worker.ready()

// Direct replication
const s1 = storeR.replicate(true); const s2 = storeW.replicate(false); s1.pipe(s2).pipe(s1)

async function sync () {
  await requester.update(); await worker.update()
  await new Promise(r => setTimeout(r, 300))
  await requester.update(); await worker.update()
}

// Authorize worker
await requester.append({ type: 'add-writer', key: worker.local.key.toString('hex'), by: 'requester', ts: Date.now() })
await sync()
console.log('Worker authorized\n')

// Worker announces
await worker.append({ type: 'worker-available', key: worker.local.key.toString('hex'), by: 'worker-abc', ts: Date.now() })
await sync()

// Post tasks
const tasks = [
  { label: 'Addition', code: 'return 17 + 25', argNames: [], args: [] },
  { label: 'Fibonacci(25)', code: 'function fib(n){return n<=1?n:fib(n-1)+fib(n-2)} return fib(n)', argNames: ['n'], args: [25] },
  { label: 'Primes to 50', code: 'const s=new Array(limit+1).fill(true);s[0]=s[1]=false;for(let i=2;i*i<=limit;i++)if(s[i])for(let j=i*i;j<=limit;j+=i)s[j]=false;return s.reduce((a,v,i)=>{if(v)a.push(i);return a},[])', argNames: ['limit'], args: [50] },
  { label: 'Sort 500 numbers', code: 'return arr.sort((a,b)=>a-b).slice(0,10)', argNames: ['arr'], args: [Array.from({length:500}, () => Math.floor(Math.random()*10000))] },
]

for (const t of tasks) {
  const id = crypto.randomUUID()
  console.log(`[>] Posting: ${t.label}`)
  await requester.append({ type: 'task', id, code: t.code, argNames: t.argNames, args: t.args, by: 'requester', ts: Date.now() })
  await sync()

  // Worker executes
  for (let i = 0; i < worker.view.length; i++) {
    const entry = await worker.view.get(i)
    if (entry.type === 'task' && entry.id === id) {
      const t0 = performance.now()
      const output = await executeTask(entry)
      const elapsed = (performance.now() - t0).toFixed(2)
      await worker.append({ type: 'result', taskId: id, output, elapsed: Number(elapsed), by: 'worker-abc', ts: Date.now() })
    }
  }
  await sync()

  // Requester reads result
  for (let i = 0; i < requester.view.length; i++) {
    const entry = await requester.view.get(i)
    if (entry.type === 'result' && entry.taskId === id) {
      console.log(`[<] Result: ${JSON.stringify(entry.output).slice(0, 80)} (${entry.elapsed}ms)\n`)
    }
  }
}

console.log('All tasks completed.')
await requester.close()
await worker.close()
