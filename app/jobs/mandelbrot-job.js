// Render a Mandelbrot set by splitting into tile rows across workers
export const data = {
  width: 128, height: 128, maxIter: 200,
  realMin: -2.5, realMax: 1, imagMin: -1.25, imagMax: 1.25
}

export function split (data, n) {
  const rowsPerChunk = Math.ceil(data.height / n)
  const chunks = []
  for (let i = 0; i < n; i++) {
    const startRow = i * rowsPerChunk
    const endRow = Math.min(startRow + rowsPerChunk, data.height)
    if (startRow >= data.height) break
    chunks.push({ ...data, startRow, endRow })
  }
  return chunks
}

export function compute (chunk) {
  const { width, startRow, endRow, maxIter, realMin, realMax, imagMin, imagMax, height } = chunk
  const rows = []
  for (let y = startRow; y < endRow; y++) {
    const row = []
    for (let x = 0; x < width; x++) {
      const cr = realMin + (x / width) * (realMax - realMin)
      const ci = imagMin + (y / height) * (imagMax - imagMin)
      let zr = 0, zi = 0, n = 0
      while (n < maxIter && zr * zr + zi * zi <= 4) {
        const tmp = zr * zr - zi * zi + cr
        zi = 2 * zr * zi + ci
        zr = tmp
        n++
      }
      row.push(n)
    }
    rows.push(row)
  }
  return { startRow, rows }
}

export function join (results) {
  // Sort by startRow and flatten into full image
  results.sort((a, b) => a.startRow - b.startRow)
  const allRows = results.flatMap(r => r.rows)

  // Render ASCII
  const chars = ' .·:;+=x#%@'
  const maxIter = 200
  const lines = []
  for (let y = 0; y < allRows.length; y += 2) {
    let line = ''
    for (let x = 0; x < allRows[y].length; x++) {
      const val = allRows[y][x]
      const idx = val >= maxIter ? 0 : Math.min(chars.length - 1, Math.floor((val / maxIter) * chars.length))
      line += chars[idx]
    }
    lines.push(line)
  }
  return '\n' + lines.join('\n')
}
