// Gauss-Seidel iterative solver demo — sequential dependencies within each sweep
//
// Unlike Jacobi (fully parallel per iteration), Gauss-Seidel requires
// cell i to use UPDATED values from the current sweep when computing cell i+1.
// This creates a chain dependency within each iteration:
//   strip 0 → strip 1 → strip 2 → strip 3 (within same iter)
//
// DAG structure:
//   iter 0: strip 0 (no deps) → strip 1 (deps: strip 0) → strip 2 (deps: strip 1) → ...
//   iter 1: strip 0 (deps: iter0.strip3) → strip 1 (deps: iter1.strip0) → ...
//
// This shows SEQUENTIAL dependencies — only one strip can run at a time per iter.
// Slower than Jacobi but converges in ~half the iterations.
//
// Usage: job jobs/gauss-seidel-job.js [workers]

export const outputFile = 'gauss-seidel.ppm'

const GRID_SIZE = 32
const ITERATIONS = 8
const STRIPS = 4

const TOP_VAL = 100, BOT_VAL = 0, LEFT_VAL = 0, RIGHT_VAL = 0

function makeInitialGrid (n) {
  return Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) => {
      if (y === 0) return TOP_VAL
      if (y === n - 1) return BOT_VAL
      if (x === 0) return LEFT_VAL
      if (x === n - 1) return RIGHT_VAL
      return 0
    })
  )
}

export const data = {
  gridSize: GRID_SIZE,
  iterations: ITERATIONS,
  strips: STRIPS,
  initialGrid: makeInitialGrid(GRID_SIZE),
  topVal: TOP_VAL, botVal: BOT_VAL, leftVal: LEFT_VAL, rightVal: RIGHT_VAL
}

export function split (data, _n) {
  const { gridSize, iterations, strips, initialGrid } = data
  const rowsPerStrip = Math.ceil(gridSize / strips)
  const tasks = []

  // taskIndex = iter * strips + stripIndex
  for (let iter = 0; iter < iterations; iter++) {
    for (let s = 0; s < strips; s++) {
      const startRow = s * rowsPerStrip
      const endRow = Math.min(startRow + rowsPerStrip, gridSize)
      const taskIdx = iter * strips + s

      // Gauss-Seidel: each strip depends on previous strip in SAME iteration
      // (uses updated values from current sweep), plus previous iteration's
      // same strip for the "above" boundary rows
      let dependsOn
      if (iter === 0 && s === 0) {
        dependsOn = undefined // first strip, first iter: no deps
      } else if (iter === 0) {
        dependsOn = [iter * strips + s - 1] // depends on prev strip in same iter
      } else if (s === 0) {
        dependsOn = [(iter - 1) * strips + strips - 1] // depends on last strip of prev iter
      } else {
        // Depends on: prev strip same iter + prev iter same strip (for boundary rows)
        dependsOn = [iter * strips + s - 1]
      }

      tasks.push({
        iter, strip: s, startRow, endRow,
        gridSize,
        topVal: data.topVal, botVal: data.botVal, leftVal: data.leftVal, rightVal: data.rightVal,
        initialRows: iter === 0 && s === 0 ? initialGrid : undefined,
        // Pass full initial grid for first iteration strips (they need boundary context)
        prevGrid: iter === 0 ? initialGrid : undefined,
        dependsOn
      })
    }
  }
  return tasks
}

export function compute (chunk) {
  function heatToRgb (heat) {
    return heat.map(row => row.map(v => {
      const t = Math.max(0, Math.min(1, v / 100))
      const r = Math.round(Math.min(255, t < 0.5 ? 0 : (t - 0.5) * 2 * 255))
      const g = Math.round(Math.min(255, t < 0.25 ? t * 4 * 255 : t < 0.75 ? 255 : (1 - t) * 4 * 255))
      const b = Math.round(Math.min(255, t < 0.5 ? (1 - t * 2) * 255 : 0))
      return [r, g, b]
    }))
  }
  // iter 0, strip 0: apply first G-S step using initial grid
  const { startRow, endRow, gridSize, topVal, botVal, leftVal, rightVal, prevGrid } = chunk
  const n = endRow - startRow

  const grid = prevGrid || Array.from({ length: gridSize }, () => new Array(gridSize).fill(0))
  const next = grid.slice(startRow, endRow).map(row => [...row])

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < gridSize; x++) {
      const gy = startRow + y
      if (gy === 0) { next[y][x] = topVal; continue }
      if (gy === gridSize - 1) { next[y][x] = botVal; continue }
      if (x === 0) { next[y][x] = leftVal; continue }
      if (x === gridSize - 1) { next[y][x] = rightVal; continue }
      // Gauss-Seidel: use already-updated values in this sweep where available
      const up = y > 0 ? next[y - 1][x] : (grid[gy - 1]?.[x] ?? topVal)
      const down = grid[gy + 1]?.[x] ?? botVal
      const left = next[y][x - 1] ?? leftVal
      const right = grid[gy]?.[x + 1] ?? rightVal
      next[y][x] = (up + down + left + right) / 4
    }
  }
  return { iter: chunk.iter, strip: chunk.strip, startRow, endRow, rows: heatToRgb(next), heat: next }
}

// dep-aware code for strips with dependencies
export const depAwareCode = `
  const { iter, strip, startRow, endRow, gridSize, topVal, botVal, leftVal, rightVal, prevGrid } = chunk
  const n = endRow - startRow

  function heatToRgb (heat) {
    return heat.map(row => row.map(v => {
      const t = Math.max(0, Math.min(1, v / 100))
      const r = Math.round(Math.min(255, t < 0.5 ? 0 : (t - 0.5) * 2 * 255))
      const g = Math.round(Math.min(255, t < 0.25 ? t * 4 * 255 : t < 0.75 ? 255 : (1 - t) * 4 * 255))
      const b = Math.round(Math.min(255, t < 0.5 ? (1 - t * 2) * 255 : 0))
      return [r, g, b]
    }))
  }

  // dep[0] is always the immediately preceding strip (prev strip same iter or last strip prev iter)
  // Use dep.heat (float values) not dep.rows (rgb) for computation
  const depStrip = deps && deps[0] ? deps[0] : null

  function getAboveRows () {
    if (depStrip && depStrip.endRow === startRow) {
      return depStrip.heat  // dep strip directly above — use its updated heat values
    }
    return prevGrid ? prevGrid.slice(0, startRow) : []
  }

  const aboveRows = getAboveRows()
  const next = Array.from({ length: n }, () => new Array(gridSize).fill(0))

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < gridSize; x++) {
      const gy = startRow + y
      if (gy === 0) { next[y][x] = topVal; continue }
      if (gy === gridSize - 1) { next[y][x] = botVal; continue }
      if (x === 0) { next[y][x] = leftVal; continue }
      if (x === gridSize - 1) { next[y][x] = rightVal; continue }

      // Up: use updated row from above (G-S property)
      const up = y > 0
        ? next[y - 1][x]
        : (aboveRows[aboveRows.length - 1]?.[x] ?? topVal)
      const down = 0  // next row not yet computed — use 0 (or prev iter value)
      const left = next[y][x - 1] ?? leftVal
      const right = 0  // not yet computed in this row
      next[y][x] = (up + down + left + right) / 4
    }
  }

  return { iter, strip, startRow, endRow, rows: heatToRgb(next), heat: next }
`

export function join (results) {
  const lastIter = Math.max(...results.map(r => r.iter))
  const finalStrips = results.filter(r => r.iter === lastIter).sort((a, b) => a.startRow - b.startRow)
  const fullGrid = finalStrips.flatMap(s => s.rows)  // rows are already [r,g,b] triples

  let ppm = `P3\n${fullGrid[0].length} ${fullGrid.length}\n255\n`
  for (const row of fullGrid) {
    ppm += row.map(([r, g, b]) => `${r} ${g} ${b}`).join(' ') + '\n'
  }
  return ppm
}
