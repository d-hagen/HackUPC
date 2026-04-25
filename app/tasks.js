import Corestore from 'corestore'
import Autobase from 'autobase'
import crypto from 'crypto'

const store = new Corestore('./store')

const base = new Autobase(store, null, {
  open: (store) => store.get({ name: 'tasks' }),
  apply: async (nodes, view, base) => {
    for (const node of nodes) {
      await view.append(node.value)
    }
  }
})

await base.ready()

// Write a task
await base.append(JSON.stringify({
  type: 'task',
  id: crypto.randomUUID(),
  action: 'mandelbrot',
  params: { x: 0, y: 0, w: 256, h: 256, iter: 100 },
  status: 'pending',
  by: 'peer-A',
  ts: Date.now()
}))

// Read all entries
console.log(`Total entries: ${base.view.length}`)
for (let i = 0; i < base.view.length; i++) {
  const block = await base.view.get(i)
  console.log(JSON.parse(block))
}

await base.close()
