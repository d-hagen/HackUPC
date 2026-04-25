// Shared Autobase + Hyperswarm setup
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperswarm from 'hyperswarm'
import crypto from 'crypto'
import fs from 'fs'

// Well-known topic all peers join for discovery
export const NETWORK_TOPIC = crypto.createHash('sha256').update('p2p-compute-network-v1').digest()

function open (store) { return store.get('view', { valueEncoding: 'json' }) }

async function apply (nodes, view, base) {
  for (const node of nodes) {
    if (node.value.type === 'add-writer') {
      await base.addWriter(Buffer.from(node.value.key, 'hex'), { indexer: true })
    }
    await view.append(node.value)
  }
}

export async function createBase (storePath, key) {
  fs.rmSync(storePath, { recursive: true, force: true })

  const store = new Corestore(storePath)
  const baseKey = key ? Buffer.from(key, 'hex') : null
  const base = new Autobase(store, baseKey, { valueEncoding: 'json', open, apply })
  await base.ready()

  const BOOTSTRAP = process.env.BOOTSTRAP
  const swarmOpts = BOOTSTRAP
    ? { bootstrap: [{ host: BOOTSTRAP.split(':')[0], port: Number(BOOTSTRAP.split(':')[1]) }] }
    : {}
  const swarm = new Hyperswarm(swarmOpts)

  const cleanup = async () => {
    await swarm.destroy()
    await base.close()
  }

  return { base, swarm, store, cleanup, open, apply }
}
