// Wave-front DAG demo
//
// NxN grid of tasks. Task (r,c) depends on (r-1,c) [top] and (r,c-1) [left].
// This creates a diagonal wavefront of execution: tasks on anti-diagonal
// row+col=k are all independent and can run in parallel.
//
// Compute: value = max(top_val, left_val) + 1  (wavefront distance from corner)
// Color:   blue (corner, dist=1) → green → red (far corner, dist=2*(N-1))
// Each task sleeps a random delay so you can watch the wave propagate.
//
// Usage: job jobs/wave-dag-job.js [N] [cellSize] [delayMs]
//   N        grid size (default 6)
//   cellSize pixels per cell in the preview image (default 80)
//   delayMs  base delay per task in ms (default 250)

export const outputFile = 'wave-dag.ppm'
export const dagLayout = 'grid'  // tells preview server to render DAG panel

export const data = { N: 6, cellSize: 80, delayMs: 250 }

export function split (data, N = data.N, cellSize = data.cellSize, delayMs = data.delayMs) {
  N = Number(N); cellSize = Number(cellSize); delayMs = Number(delayMs)
  const tasks = []
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const dependsOn = []
      if (r > 0) dependsOn.push((r - 1) * N + c)  // top
      if (c > 0) dependsOn.push(r * N + (c - 1))  // left
      tasks.push({
        row: r, col: c, N, cellSize, delayMs,
        startRow: r * cellSize, endRow: (r + 1) * cellSize,
        startCol: c * cellSize, endCol: (c + 1) * cellSize,
        dependsOn: dependsOn.length > 0 ? dependsOn : undefined
      })
    }
  }
  return tasks
}

function makeBlock (chunk, value) {
  const { N, startRow, endRow, startCol, endCol, row, col } = chunk
  const maxVal = 2 * (N - 1) || 1
  const t = Math.min(1, (value - 1) / maxVal)
  const r = Math.round(t < 0.5 ? 0 : (t - 0.5) * 2 * 255)
  const g = Math.round(t < 0.25 ? t * 4 * 255 : t < 0.75 ? 255 : (1 - t) * 4 * 255)
  const b = Math.round(t < 0.5 ? (1 - t * 2) * 255 : 0)
  const rows = Array.from({ length: endRow - startRow }, () =>
    new Array(endCol - startCol).fill([r, g, b])
  )
  return { row, col, value, startRow, endRow, startCol, endCol, rows }
}

// Only (0,0) uses this — no deps
export async function compute (chunk) {
  const delay = chunk.delayMs * (0.5 + Math.random())
  await new Promise(res => setTimeout(res, delay))
  return makeBlock(chunk, 1)
}

// All tasks with deps (every cell except (0,0))
export const depAwareCode = `
  const { row, col, N, startRow, endRow, startCol, endCol, delayMs } = chunk

  await new Promise(res => setTimeout(res, delayMs * (0.5 + Math.random())))

  // deps order matches dependsOn order in split():
  //   if row>0 && col>0: deps[0]=top, deps[1]=left
  //   if row>0 && col==0: deps[0]=top
  //   if row==0 && col>0: deps[0]=left
  const topDep  = row > 0 ? deps[0] : null
  const leftDep = col > 0 ? (row > 0 ? deps[1] : deps[0]) : null
  const topVal  = topDep  ? topDep.value  : 0
  const leftVal = leftDep ? leftDep.value : 0
  const value   = Math.max(topVal, leftVal) + 1

  const maxVal = 2 * (N - 1) || 1
  const t = Math.min(1, (value - 1) / maxVal)
  const r = Math.round(t < 0.5 ? 0 : (t - 0.5) * 2 * 255)
  const g = Math.round(t < 0.25 ? t * 4 * 255 : t < 0.75 ? 255 : (1 - t) * 4 * 255)
  const b = Math.round(t < 0.5 ? (1 - t * 2) * 255 : 0)
  const rows = Array.from({ length: endRow - startRow }, () =>
    new Array(endCol - startCol).fill([r, g, b])
  )
  return { row, col, value, startRow, endRow, startCol, endCol, rows }
`

export function join (results) {
  if (!results.length) return 'P3\n1 1\n255\n0 0 0\n'
  const N = Math.round(Math.sqrt(results.length))
  const cellSize = results[0].rows.length
  const fullSize = N * cellSize
  const grid = Array.from({ length: fullSize }, () => new Array(fullSize).fill(null))
  for (const block of results) {
    const colOffset = block.startCol ?? 0
    for (let y = 0; y < block.rows.length; y++) {
      for (let x = 0; x < block.rows[y].length; x++) {
        grid[block.startRow + y][colOffset + x] = block.rows[y][x]
      }
    }
  }
  let ppm = `P3\n${fullSize} ${fullSize}\n255\n`
  for (const row of grid) {
    ppm += row.map(px => px ? `${px[0]} ${px[1]} ${px[2]}` : '40 40 40').join(' ') + '\n'
  }
  return ppm
}
