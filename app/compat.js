import _fetch from 'bare-node-fetch'
import _process from 'process'
import _Buffer from 'buffer'

global.fetch = _fetch
global.process = _process
global.Buffer = _Buffer.Buffer || _Buffer
