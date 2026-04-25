// GPU-accelerated image blur via PyTorch on workers.
// Each strip is a JS task that fetches gpu-blur.py from the shared drive,
// writes it to /tmp, and runs python3 on it with pixel data via stdin.
// Works without ALLOW_SHELL — uses Node child_process inside AsyncFunction.
//
// Usage: job jobs/gpu-blur-job.js [n]
import fs from 'fs'
import { execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const outputFile = 'blur-output.ppm'

// Called by request-compute.js before tasks are posted — uploads gpu-blur.py
export async function prepare (drive) {
  const script = fs.readFileSync(resolve(__dirname, 'gpu-blur.py'))
  await drive.put('/gpu-blur.py', script)
  console.log('[~] Uploaded gpu-blur.py to drive')
}

function loadImagePixels (imgPath) {
  const ppmPath = imgPath + '.tmp.ppm'
  execSync(`magick "${imgPath}" -compress none "${ppmPath}"`)
  const raw = fs.readFileSync(ppmPath, 'utf-8')
  const lines = raw.trim().split('\n')
  const [w, h] = lines[1].split(' ').map(Number)
  const values = lines.slice(3).join(' ').trim().split(/\s+/).map(Number)
  const rows = []
  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      row.push([values[i], values[i + 1], values[i + 2]])
    }
    rows.push(row)
  }
  fs.unlinkSync(ppmPath)
  return { rows, width: w, height: h }
}

const { rows: allRows, width, height } = loadImagePixels('./img.png')
export const data = { width, height, rowData: allRows }

export function split (data, n) {
  const { width, height, rowData } = data
  const rowsPerChunk = Math.ceil(height / n)
  const chunks = []
  for (let i = 0; i < n; i++) {
    const startRow = i * rowsPerChunk
    const endRow = Math.min(startRow + rowsPerChunk, height)
    if (startRow >= height) break
    chunks.push({ width, height, startRow, endRow, rows: rowData.slice(startRow, endRow) })
  }
  return chunks
}

// Each chunk is passed as args to this function running on the worker.
// readFile is injected by worker.js from the shared Hyperdrive.
export function compute (chunk) {
  return chunk // data passed as args; actual code is the gpuComputeCode below
}

// This is the actual code run on workers — serialized and sent as task code.
// It reads gpu-blur.py from the drive, writes to /tmp, runs python3 via spawnSync.
export const gpuComputeCode = `
  const { spawnSync } = await import('child_process')
  const { writeFileSync, mkdtempSync, rmSync } = await import('fs')
  const { join: pathJoin } = await import('path')
  const { tmpdir } = await import('os')

  // Fetch Python script from shared drive
  const scriptData = await readFile('/gpu-blur.py')
  if (!scriptData) throw new Error('gpu-blur.py not found in drive')

  // Write script to temp dir
  const tmpDir = mkdtempSync(pathJoin(tmpdir(), 'peercompute-gpu-'))
  const scriptPath = pathJoin(tmpDir, 'gpu-blur.py')
  writeFileSync(scriptPath, scriptData)

  // Prepare input JSON
  const payload = JSON.stringify({
    startRow: chunk.startRow,
    endRow: chunk.endRow,
    width: chunk.width,
    pixels: chunk.rows
  })

  // Run Python script
  const result = spawnSync('python3', [scriptPath], {
    input: payload,
    encoding: 'utf-8',
    maxBuffer: 100 * 1024 * 1024,
    timeout: 120000
  })

  // Clean up
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}

  if (result.status !== 0) {
    throw new Error('gpu-blur.py failed: ' + (result.stderr || '').slice(0, 200))
  }
  if (!result.stdout) throw new Error('gpu-blur.py produced no output')

  return JSON.parse(result.stdout)
`

export function join (results) {
  results.sort((a, b) => a.startRow - b.startRow)
  const fullWidth = results[0].width
  const fullHeight = results.reduce((s, r) => s + r.pixels.length, 0)

  let ppm = `P3\n${fullWidth} ${fullHeight}\n255\n`
  for (const strip of results) {
    for (const row of strip.pixels) {
      ppm += row.map(px => `${px[0]} ${px[1]} ${px[2]}`).join(' ') + '\n'
    }
  }
  return ppm
}
