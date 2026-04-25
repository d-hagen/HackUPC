// Detect worker hardware capabilities at startup
// CUDA (NVIDIA) → MPS (Apple Silicon) → CPU

import os from 'os'
import { execSync, spawnSync } from 'child_process'

function runCmd (cmd, timeout = 500) {
  try {
    const result = spawnSync('sh', ['-c', cmd], { timeout, encoding: 'utf-8' })
    return { ok: result.status === 0, stdout: (result.stdout || '').trim() }
  } catch {
    return { ok: false, stdout: '' }
  }
}

function detectGPUType () {
  // NVIDIA CUDA — skip on macOS, no CUDA support
  const nvidiaSmi = process.platform !== 'darwin' ? runCmd('nvidia-smi --list-gpus') : { ok: false, stdout: '' }
  if (nvidiaSmi.ok && nvidiaSmi.stdout) {
    const firstLine = nvidiaSmi.stdout.split('\n')[0]
    const nameMatch = firstLine.match(/GPU \d+: (.+?) \(/)
    return {
      type: 'cuda',
      name: nameMatch ? nameMatch[1] : 'NVIDIA GPU',
      raw: nvidiaSmi.stdout
    }
  }

  // Apple Silicon MPS — check via process.arch + sysctl
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') {
      const chip = runCmd('sysctl -n machdep.cpu.brand_string')
      return {
        type: 'mps',
        name: chip.stdout || 'Apple Silicon',
        raw: chip.stdout
      }
    }
    // Intel Mac — no GPU acceleration
    const chip = runCmd('sysctl -n machdep.cpu.brand_string')
    return {
      type: 'cpu',
      name: chip.stdout || 'Intel Mac',
      raw: chip.stdout
    }
  }

  // AMD ROCm (Linux only)
  const rocm = process.platform !== 'darwin' ? runCmd('rocm-smi --showproductname') : { ok: false, stdout: '' }
  if (rocm.ok && rocm.stdout) {
    return { type: 'rocm', name: 'AMD GPU (ROCm)', raw: rocm.stdout }
  }

  return { type: 'cpu', name: 'CPU only', raw: '' }
}

function detectPython () {
  const py3 = runCmd('python3 --version')
  if (py3.ok) return { available: true, version: py3.stdout }
  const py = runCmd('python --version')
  if (py.ok) return { available: true, version: py.stdout }
  return { available: false, version: null }
}

function detectPyTorch (pythonCmd = 'python3') {
  const result = runCmd(
    `${pythonCmd} -c "import torch; mps=hasattr(torch.backends,'mps') and torch.backends.mps.is_available(); print(torch.__version__+'|'+str(torch.cuda.is_available())+'|'+str(mps))"`,
    3000
  )
  if (!result.ok) return { available: false }
  const [version, cuda, mps] = result.stdout.split('|')
  return {
    available: true,
    version,
    cuda: cuda === 'True',
    mps: mps === 'True'
  }
}

export async function detectCapabilities () {
  const gpu = detectGPUType()
  const python = detectPython()
  const pytorch = python.available ? detectPyTorch() : { available: false }

  // Resolve effective GPU device considering pytorch support
  let gpuDevice = gpu.type
  if (gpuDevice === 'mps' && pytorch.available && !pytorch.mps) gpuDevice = 'cpu'
  if (gpuDevice === 'cuda' && pytorch.available && !pytorch.cuda) gpuDevice = 'cpu'

  return {
    // Hardware
    platform: process.platform,           // darwin / linux / win32
    arch: process.arch,                    // arm64 / x64
    cpuCores: os.cpus().length,
    ramGB: Math.round(os.totalmem() / 1e9),
    cpuModel: os.cpus()[0]?.model || 'unknown',

    // GPU
    gpuType: gpuDevice,                    // 'cuda' | 'mps' | 'rocm' | 'cpu'
    gpuName: gpu.name,
    hasGPU: gpuDevice !== 'cpu',

    // Python
    hasPython: python.available,
    pythonVersion: python.version,
    hasPyTorch: pytorch.available,
    pytorchVersion: pytorch.available ? pytorch.version : null,

    // Convenience flags
    hasCUDA: gpuDevice === 'cuda',
    hasMPS: gpuDevice === 'mps',
    allowsShell: process.env.ALLOW_SHELL === '1' || process.env.ALLOW_SHELL === 'true'
  }
}

// Best torch device string for a task given worker caps
export function bestTorchDevice (caps) {
  if (caps.hasCUDA) return 'cuda'
  if (caps.hasMPS) return 'mps'
  return 'cpu'
}

// Check if worker meets task requirements
export function meetsRequirements (requires, caps) {
  if (!requires) return true
  if (requires.hasGPU && !caps.hasGPU) return false
  if (requires.hasCUDA && !caps.hasCUDA) return false
  if (requires.hasMPS && !caps.hasMPS) return false
  if (requires.hasPython && !caps.hasPython) return false
  if (requires.hasPyTorch && !caps.hasPyTorch) return false
  if (requires.ramGB && caps.ramGB < requires.ramGB) return false
  if (requires.cpuCores && caps.cpuCores < requires.cpuCores) return false
  if (requires.platform && caps.platform !== requires.platform) return false
  if (requires.arch && caps.arch !== requires.arch) return false
  if (requires.allowsShell && !caps.allowsShell) return false
  return true
}

// Pick best worker from map for a task's requirements
export function pickWorkerForTask (requires, workers) {
  if (!requires) return null // caller handles round-robin
  const capable = []
  for (const [writerKey, worker] of workers) {
    if (meetsRequirements(requires, worker.caps || {})) {
      capable.push({ writerKey, worker })
    }
  }
  if (capable.length === 0) return null
  // Prefer GPU workers, then more cores
  capable.sort((a, b) => {
    const aGPU = a.worker.caps?.hasGPU ? 1 : 0
    const bGPU = b.worker.caps?.hasGPU ? 1 : 0
    if (bGPU !== aGPU) return bGPU - aGPU
    return (b.worker.caps?.cpuCores || 0) - (a.worker.caps?.cpuCores || 0)
  })
  return capable[0].worker.id
}
