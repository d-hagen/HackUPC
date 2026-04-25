// Test: capability detection, meetsRequirements, pickWorkerForTask
import { detectCapabilities, meetsRequirements, pickWorkerForTask, bestTorchDevice } from '../capabilities.js'
import assert from 'assert'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`)
    failed++
  }
}

// --- meetsRequirements ---
console.log('\n[ meetsRequirements ]')

const mpsWorker = {
  hasGPU: true, hasMPS: true, hasCUDA: false,
  hasPython: true, hasPyTorch: true,
  cpuCores: 8, ramGB: 16,
  platform: 'darwin', arch: 'arm64'
}

const cudaWorker = {
  hasGPU: true, hasCUDA: true, hasMPS: false,
  hasPython: true, hasPyTorch: true,
  cpuCores: 32, ramGB: 64,
  platform: 'linux', arch: 'x64'
}

const cpuWorker = {
  hasGPU: false, hasCUDA: false, hasMPS: false,
  hasPython: true, hasPyTorch: false,
  cpuCores: 4, ramGB: 8,
  platform: 'darwin', arch: 'x64'
}

test('null requires = always passes', () => {
  assert(meetsRequirements(null, cpuWorker))
  assert(meetsRequirements(undefined, cpuWorker))
})
test('hasGPU: MPS worker passes', () => assert(meetsRequirements({ hasGPU: true }, mpsWorker)))
test('hasGPU: CPU worker fails', () => assert(!meetsRequirements({ hasGPU: true }, cpuWorker)))
test('hasCUDA: CUDA worker passes', () => assert(meetsRequirements({ hasCUDA: true }, cudaWorker)))
test('hasCUDA: MPS worker fails', () => assert(!meetsRequirements({ hasCUDA: true }, mpsWorker)))
test('hasMPS: MPS worker passes', () => assert(meetsRequirements({ hasMPS: true }, mpsWorker)))
test('hasMPS: CUDA worker fails', () => assert(!meetsRequirements({ hasMPS: true }, cudaWorker)))
test('hasPyTorch: passes when installed', () => assert(meetsRequirements({ hasPyTorch: true }, mpsWorker)))
test('hasPyTorch: fails when not installed', () => assert(!meetsRequirements({ hasPyTorch: true }, cpuWorker)))
test('ramGB threshold pass', () => assert(meetsRequirements({ ramGB: 8 }, mpsWorker)))
test('ramGB threshold fail', () => assert(!meetsRequirements({ ramGB: 32 }, mpsWorker)))
test('cpuCores threshold pass', () => assert(meetsRequirements({ cpuCores: 4 }, mpsWorker)))
test('cpuCores threshold fail', () => assert(!meetsRequirements({ cpuCores: 16 }, mpsWorker)))
test('platform match', () => assert(meetsRequirements({ platform: 'darwin' }, mpsWorker)))
test('platform mismatch', () => assert(!meetsRequirements({ platform: 'linux' }, mpsWorker)))
test('arch match', () => assert(meetsRequirements({ arch: 'arm64' }, mpsWorker)))
test('arch mismatch', () => assert(!meetsRequirements({ arch: 'x64' }, mpsWorker)))
test('combined: hasGPU + ramGB pass', () => assert(meetsRequirements({ hasGPU: true, ramGB: 8 }, mpsWorker)))
test('combined: hasGPU + ramGB fail (too little RAM)', () => assert(!meetsRequirements({ hasGPU: true, ramGB: 32 }, mpsWorker)))

// --- pickWorkerForTask ---
console.log('\n[ pickWorkerForTask ]')

const workers = new Map([
  ['key-mps', { id: 'worker-mps', caps: mpsWorker }],
  ['key-cuda', { id: 'worker-cuda', caps: cudaWorker }],
  ['key-cpu', { id: 'worker-cpu', caps: cpuWorker }]
])

test('null requires = returns null (caller handles round-robin)', () => {
  assert(pickWorkerForTask(null, workers) === null)
})
test('hasMPS picks mps worker', () => {
  assert(pickWorkerForTask({ hasMPS: true }, workers) === 'worker-mps')
})
test('hasCUDA picks cuda worker', () => {
  assert(pickWorkerForTask({ hasCUDA: true }, workers) === 'worker-cuda')
})
test('hasGPU prefers cuda (more cores) over mps', () => {
  // cudaWorker has 32 cores vs mps 8 cores, both have GPU
  // sort: same hasGPU score, then cores → cuda wins
  assert(pickWorkerForTask({ hasGPU: true }, workers) === 'worker-cuda')
})
test('hasPyTorch excludes cpu worker (no pytorch)', () => {
  const w = pickWorkerForTask({ hasPyTorch: true }, workers)
  assert(w === 'worker-mps' || w === 'worker-cuda')
  assert(w !== 'worker-cpu')
})
test('impossible requirements returns null', () => {
  assert(pickWorkerForTask({ hasCUDA: true, hasMPS: true }, workers) === null)
})
test('ramGB=32 excludes mps worker (16GB)', () => {
  // only cuda worker (64GB) qualifies
  assert(pickWorkerForTask({ hasGPU: true, ramGB: 32 }, workers) === 'worker-cuda')
})

// --- bestTorchDevice ---
console.log('\n[ bestTorchDevice ]')

test('cuda first', () => assert(bestTorchDevice(cudaWorker) === 'cuda'))
test('mps second', () => assert(bestTorchDevice(mpsWorker) === 'mps'))
test('cpu fallback', () => assert(bestTorchDevice(cpuWorker) === 'cpu'))

// --- detectCapabilities (live) ---
console.log('\n[ detectCapabilities — live ]')
const caps = await detectCapabilities()
test('returns platform string', () => assert(typeof caps.platform === 'string'))
test('returns arch string', () => assert(typeof caps.arch === 'string'))
test('returns cpuCores number > 0', () => assert(typeof caps.cpuCores === 'number' && caps.cpuCores > 0))
test('returns ramGB number > 0', () => assert(typeof caps.ramGB === 'number' && caps.ramGB > 0))
test('hasGPU is boolean', () => assert(typeof caps.hasGPU === 'boolean'))
test('gpuType is string', () => assert(typeof caps.gpuType === 'string'))
test('hasPython is boolean', () => assert(typeof caps.hasPython === 'boolean'))
test('hasPyTorch is boolean', () => assert(typeof caps.hasPyTorch === 'boolean'))
test('hasCUDA + hasMPS are mutually exclusive', () => assert(!(caps.hasCUDA && caps.hasMPS)))
test('arm64 darwin = hasMPS or hasCUDA=false', () => {
  if (caps.platform === 'darwin' && caps.arch === 'arm64') {
    assert(!caps.hasCUDA) // no CUDA on Apple Silicon
  }
})

console.log(`\n${'─'.repeat(44)}`)
console.log(`  ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
