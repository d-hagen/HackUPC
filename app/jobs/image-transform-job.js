// Distributed image transformation: each worker applies a different filter to its strip
// Requires: img.png in app/ directory, ImageMagick installed on requester
import fs from 'fs'
import { execSync } from 'child_process'

export const outputFile = 'output.ppm'

const TRANSFORMS = ['grayscale', 'sepia', 'invert', 'warm', 'cool', 'pixelate', 'edge', 'contrast']

function loadImagePixels (path) {
  // Convert to text PPM via ImageMagick, parse into row arrays
  const ppmPath = path.replace(/\.\w+$/, '.ppm')
  execSync(`magick "${path}" -compress none "${ppmPath}"`)
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

export const data = { width, height, totalRows: allRows.length, rowData: allRows }

export function split (data, n) {
  const { width, height, rowData } = data
  const rowsPerChunk = Math.ceil(height / n)
  const chunks = []
  for (let i = 0; i < n; i++) {
    const startRow = i * rowsPerChunk
    const endRow = Math.min(startRow + rowsPerChunk, height)
    if (startRow >= height) break
    chunks.push({
      width,
      height,
      startRow,
      endRow,
      rows: rowData.slice(startRow, endRow),
      transform: TRANSFORMS[i % TRANSFORMS.length]
    })
  }
  return chunks
}

export function compute (chunk) {
  const { width, startRow, endRow, rows, transform } = chunk

  function clamp (v) { return Math.max(0, Math.min(255, Math.round(v))) }

  const transformed = rows.map(row => row.map(([r, g, b]) => {
    switch (transform) {
      case 'grayscale': {
        const gray = clamp(0.299 * r + 0.587 * g + 0.114 * b)
        return [gray, gray, gray]
      }
      case 'sepia': {
        return [
          clamp(r * 0.393 + g * 0.769 + b * 0.189),
          clamp(r * 0.349 + g * 0.686 + b * 0.168),
          clamp(r * 0.272 + g * 0.534 + b * 0.131)
        ]
      }
      case 'invert':
        return [255 - r, 255 - g, 255 - b]
      case 'warm':
        return [clamp(r * 1.2), clamp(g * 1.05), clamp(b * 0.8)]
      case 'cool':
        return [clamp(r * 0.8), clamp(g * 1.05), clamp(b * 1.3)]
      case 'pixelate': {
        // 8x8 block average
        const blockSize = 8
        const bx = Math.floor((rows[0].indexOf([r, g, b]) || 0) / blockSize) * blockSize
        // approximate: just posterize (reduce color depth)
        return [clamp(Math.round(r / 32) * 32), clamp(Math.round(g / 32) * 32), clamp(Math.round(b / 32) * 32)]
      }
      case 'edge': {
        // high contrast + desaturate
        const gray = 0.299 * r + 0.587 * g + 0.114 * b
        const contrast = clamp((gray - 128) * 2.5 + 128)
        return [contrast, contrast, contrast]
      }
      case 'contrast': {
        return [clamp((r - 128) * 1.8 + 128), clamp((g - 128) * 1.8 + 128), clamp((b - 128) * 1.8 + 128)]
      }
      default:
        return [r, g, b]
    }
  }))

  return { startRow, endRow, rows: transformed, transform }
}

export function join (results) {
  results.sort((a, b) => a.startRow - b.startRow)
  const width = results[0].rows[0].length
  const height = results.reduce((s, r) => s + r.rows.length, 0)

  let ppm = `P3\n${width} ${height}\n255\n`
  for (const strip of results) {
    for (const row of strip.rows) {
      ppm += row.map(([r, g, b]) => `${r} ${g} ${b}`).join(' ') + '\n'
    }
  }
  return ppm
}
