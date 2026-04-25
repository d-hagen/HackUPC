// Distributed image transformation: each worker applies a different filter to its block
// Usage:
//   job jobs/image-transform-job.js 4        → 4 horizontal strips
//   job jobs/image-transform-job.js 2 3      → 2 rows × 3 cols = 6 grid blocks
// Requires: img.png in app/ directory, ImageMagick installed on requester
import fs from 'fs'
import { execSync } from 'child_process'

export const outputFile = 'output.ppm'

export const transforms = ['grayscale', 'sepia', 'invert', 'warm', 'cool', 'posterize', 'edge', 'contrast']
const TRANSFORMS = transforms

function loadImagePixels (path) {
  const ppmPath = path.replace(/\.\w+$/, '_tmp.ppm')
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
export const data = { width, height, rowData: allRows }

// split(data, gridRows, gridCols=1)
// gridRows=4, gridCols=1 → 4 horizontal strips
// gridRows=2, gridCols=3 → 2×3 = 6 grid blocks
export function split (data, gridRows, gridCols = 1) {
  const { width, height, rowData } = data
  const blockH = Math.ceil(height / gridRows)
  const blockW = Math.ceil(width / gridCols)
  const chunks = []
  let idx = 0
  for (let gr = 0; gr < gridRows; gr++) {
    for (let gc = 0; gc < gridCols; gc++) {
      const startRow = gr * blockH
      const endRow = Math.min(startRow + blockH, height)
      const startCol = gc * blockW
      const endCol = Math.min(startCol + blockW, width)
      if (startRow >= height || startCol >= width) continue

      // Slice out just the columns this block needs
      const rows = rowData.slice(startRow, endRow).map(row => row.slice(startCol, endCol))

      chunks.push({
        width, height,
        startRow, endRow,
        startCol, endCol,
        rows,
        transform: TRANSFORMS[idx % TRANSFORMS.length],
        gridRows, gridCols
      })
      idx++
    }
  }
  return chunks
}

export function compute (chunk) {
  const { startRow, endRow, startCol, endCol, rows, transform } = chunk

  function clamp (v) { return Math.max(0, Math.min(255, Math.round(v))) }

  const transformed = rows.map(row => row.map(([r, g, b]) => {
    switch (transform) {
      case 'grayscale': {
        const gray = clamp(0.299 * r + 0.587 * g + 0.114 * b)
        return [gray, gray, gray]
      }
      case 'sepia':
        return [
          clamp(r * 0.393 + g * 0.769 + b * 0.189),
          clamp(r * 0.349 + g * 0.686 + b * 0.168),
          clamp(r * 0.272 + g * 0.534 + b * 0.131)
        ]
      case 'invert':
        return [255 - r, 255 - g, 255 - b]
      case 'warm':
        return [clamp(r * 1.2), clamp(g * 1.05), clamp(b * 0.8)]
      case 'cool':
        return [clamp(r * 0.8), clamp(g * 1.05), clamp(b * 1.3)]
      case 'posterize':
        return [clamp(Math.round(r / 64) * 64), clamp(Math.round(g / 64) * 64), clamp(Math.round(b / 64) * 64)]
      case 'edge': {
        const gray = 0.299 * r + 0.587 * g + 0.114 * b
        return [clamp((gray - 128) * 2.5 + 128), clamp((gray - 128) * 2.5 + 128), clamp((gray - 128) * 2.5 + 128)]
      }
      case 'contrast':
        return [clamp((r - 128) * 1.8 + 128), clamp((g - 128) * 1.8 + 128), clamp((b - 128) * 1.8 + 128)]
      default:
        return [r, g, b]
    }
  }))

  return { startRow, endRow, startCol, endCol, rows: transformed, transform }
}

export function join (results) {
  // Reconstruct full image: place each block at its (startRow, startCol) position
  const fullWidth = results.reduce((max, r) => Math.max(max, r.endCol), 0)
  const fullHeight = results.reduce((max, r) => Math.max(max, r.endRow), 0)

  // Build empty pixel grid
  const grid = Array.from({ length: fullHeight }, () => Array(fullWidth).fill(null))

  for (const block of results) {
    for (let y = 0; y < block.rows.length; y++) {
      for (let x = 0; x < block.rows[y].length; x++) {
        grid[block.startRow + y][block.startCol + x] = block.rows[y][x]
      }
    }
  }

  let ppm = `P3\n${fullWidth} ${fullHeight}\n255\n`
  for (const row of grid) {
    ppm += row.map(px => px ? `${px[0]} ${px[1]} ${px[2]}` : '0 0 0').join(' ') + '\n'
  }
  return ppm
}
