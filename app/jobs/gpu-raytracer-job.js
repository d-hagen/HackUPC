// ─── GPU Ray Tracer ───────────────────────────────────────────────────────────
// Distributed path tracer rendered on workers' GPUs via PyTorch.
// All pixels in a strip computed in parallel as tensors (CUDA/MPS/CPU fallback).
// gpu-raytracer.py is uploaded to Hyperdrive at job start and fetched by workers.
// GPU-rendered strips appear with a purple tint in the live preview so you can
// see which worker used hardware acceleration.
//
// ~10x faster than the JS raytracer on MPS/CUDA at spp≥32.
//
// Usage (from requester prompt):
//   job jobs/gpu-raytracer-job.js 8              → 8 strips, 800×600, spp=32
//   job jobs/gpu-raytracer-job.js [strips] [width] [height] [spp] [depth]
//
// Requires: PyTorch on workers (auto-routed; falls back to slow CPU Python)
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs'
import { execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const outputFile = 'gpu-render.ppm'
export const requires = { hasPyTorch: true }

export const data = {
  width: 800,
  height: 600,
  samplesPerPixel: 32,
  maxDepth: 8
}

export async function prepare (drive) {
  const script = fs.readFileSync(resolve(__dirname, 'gpu-raytracer.py'))
  await drive.put('/gpu-raytracer.py', script)
  console.log('[~] Uploaded gpu-raytracer.py to drive')
}

export function split (data, strips, width, height, spp, depth) {
  width  = Number(width  || data.width)
  height = Number(height || data.height)
  spp    = Number(spp    || data.samplesPerPixel)
  depth  = Number(depth  || data.maxDepth)
  strips = Number(strips || 4)

  const rowsPerStrip = Math.ceil(height / strips)
  const chunks = []
  for (let i = 0; i < strips; i++) {
    const startRow = i * rowsPerStrip
    const endRow   = Math.min(startRow + rowsPerStrip, height)
    if (startRow >= height) break
    chunks.push({ width, height, startRow, endRow, samplesPerPixel: spp, maxDepth: depth })
  }
  return chunks
}

// Stub — actual work done by gpuComputeCode below
export function compute (chunk) { return chunk }

// Serialized string executed as AsyncFunction on worker.
// Fetches gpu-raytracer.py from shared drive, runs python3 via spawnSync.
export const gpuComputeCode = `
  const { spawnSync } = await import('child_process')
  const { writeFileSync, mkdtempSync, rmSync } = await import('fs')
  const { join: pathJoin } = await import('path')
  const { tmpdir } = await import('os')

  // Fetch Python script from shared Hyperdrive
  const scriptData = await readFile('/gpu-raytracer.py')
  if (!scriptData) throw new Error('gpu-raytracer.py not found in drive')

  const tmpDir = mkdtempSync(pathJoin(tmpdir(), 'peercompute-rt-'))
  const scriptPath = pathJoin(tmpDir, 'gpu-raytracer.py')
  writeFileSync(scriptPath, scriptData)

  const payload = JSON.stringify({
    startRow:        chunk.startRow,
    endRow:          chunk.endRow,
    width:           chunk.width,
    height:          chunk.height,
    samplesPerPixel: chunk.samplesPerPixel,
    maxDepth:        chunk.maxDepth
  })

  const result = spawnSync('python3', [scriptPath], {
    input:     payload,
    encoding:  'utf-8',
    maxBuffer: 200 * 1024 * 1024,
    timeout:   300000
  })

  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}

  if (result.status !== 0) {
    throw new Error('gpu-raytracer.py failed: ' + (result.stderr || '').slice(0, 300))
  }
  if (!result.stdout) throw new Error('gpu-raytracer.py produced no output')

  return JSON.parse(result.stdout)
`

export function join (results) {
  results.sort((a, b) => a.startRow - b.startRow)

  const fullW = results[0].width || results[0].rows[0].length
  const fullH = results.reduce((s, r) => s + r.rows.length, 0)

  // Log which device rendered each strip
  for (const r of results) {
    const tag = r.device && !r.device.startsWith('CPU') ? `GPU (${r.device})` : (r.device || 'CPU')
    console.log(`  strip ${r.startRow}-${r.endRow}: ${tag}, ${r.elapsed_ms || '?'}ms`)
  }

  let ppm = `P3\n${fullW} ${fullH}\n255\n`
  for (const strip of results) {
    for (const row of strip.rows) {
      ppm += row.map(px => `${px[0]} ${px[1]} ${px[2]}`).join(' ') + '\n'
    }
  }
  return ppm
}
