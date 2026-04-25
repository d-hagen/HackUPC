// Starts a local DHT bootstrap node so two peers can find each other on localhost
import DHT from '@hyperswarm/dht'

const node = new DHT({ bootstrap: [] })
await node.ready()

const port = node.address().port
console.log(`DHT bootstrap running on port ${port}`)
console.log(`Start peers with: BOOTSTRAP=localhost:${port}`)

process.on('SIGINT', async () => {
  await node.destroy()
  process.exit()
})
