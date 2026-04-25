// GPU benchmark job — runs matrix multiply on best available device (CUDA/MPS/CPU)
// Requires PyTorch. Demonstrates GPU routing: only workers with PyTorch will get this.
// Usage: job jobs/gpu-benchmark-job.js

export const requires = { hasPyTorch: true }

export const data = { sizes: [1024, 2048, 4096] }

export function split (data, n) {
  // Each chunk is one matrix size — run all sizes on available workers
  return data.sizes.map(size => ({ size }))
}

export function compute (chunk) {
  // This runs as a shell-style JS task via AsyncFunction
  // We return a shell command string that the requester will run
  // Actually: we embed python inline using the shell taskType pattern
  // For AsyncFunction tasks, we can't easily run subprocesses — see gpu-benchmark-shell.js
  // This version just returns metadata about the chunk
  return { size: chunk.size, note: 'Use shell command for real GPU benchmark' }
}

export function join (results) {
  return results.map(r => `${r.size}x${r.size}: ${r.note}`).join('\n')
}
