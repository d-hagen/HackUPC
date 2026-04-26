// ─── Jacobi Solver (Barrier DAG) ─────────────────────────────────────────────
// Distributed iterative PDE solver (Laplace equation ∇²u=0) on a 2D grid.
// Each Jacobi iteration is fully parallel: all N strips run concurrently,
// but iteration k+1 cannot start until ALL strips from iteration k are done
// — this is a "barrier" dependency pattern in the task DAG.
//
// Output: heatmap PPM showing the converged temperature field.
// Live preview updates each time a strip result arrives.
//
// Usage (from requester prompt):
//   job jobs/jacobi-job.js 4     → 4 strips, default iterations
//   job jobs/jacobi-job.js [n]
//
// No external dependencies. Works on any worker.
// ─────────────────────────────────────────────────────────────────────────────
// Visualization: outputs a PPM heatmap showing convergence

export const outputFile = 'jacobi.ppm'

const GRID_SIZE = 32      // NxN grid (smaller = faster convergence, clearer heatmap)
const ITERATIONS = 16     // number of Jacobi iterations (each is a DAG layer)
const STRIPS = 4          // number of strips per iteration (= number of workers)

// Boundary conditions
const TOP_VAL = 100
const BOT_VAL = 0
const LEFT_VAL = 0
const RIGHT_VAL = 0

function makeInitialGrid (n) {
  const grid = Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) => {
      if (y === 0) return TOP_VAL
      if (y === n - 1) return BOT_VAL
      if (x === 0) return LEFT_VAL
      if (x === n - 1) return RIGHT_VAL
      return 0
    })
  )
  return grid
}

const initialGrid = makeInitialGrid(GRID_SIZE)

// data: describes the full job DAG
export const data = {
  gridSize: GRID_SIZE,
  iterations: ITERATIONS,
  strips: STRIPS,
  initialGrid,
  topVal: TOP_VAL, botVal: BOT_VAL, leftVal: LEFT_VAL, rightVal: RIGHT_VAL
}

// split() builds a flat list of all tasks across all iterations
// Each task has dependsOn: [chunkIndex of deps] for the DAG
export function split (data, _n) {
  const { gridSize, iterations, strips, initialGrid } = data
  const rowsPerStrip = Math.ceil(gridSize / strips)
  const tasks = []

  // Flatten: taskIndex = iter * strips + stripIndex
  for (let iter = 0; iter < iterations; iter++) {
    for (let s = 0; s < strips; s++) {
      const startRow = s * rowsPerStrip
      const endRow = Math.min(startRow + rowsPerStrip, gridSize)

      // For iter 0: provide the initial strip data directly
      // For iter k>0: depends on ALL strips from iter k-1 (need full grid to compute averages)
      const dependsOn = iter === 0
        ? undefined
        : Array.from({ length: strips }, (_, prevS) => (iter - 1) * strips + prevS)

      tasks.push({
        iter,
        strip: s,
        startRow,
        endRow,
        gridSize,
        topVal: data.topVal,
        botVal: data.botVal,
        leftVal: data.leftVal,
        rightVal: data.rightVal,
        // Initial grid only on first iteration (large but only sent once per strip)
        initialRows: iter === 0 ? initialGrid.slice(startRow, endRow) : undefined,
        dependsOn   // chunkIndex references — resolved to taskIds by request-compute.js
      })
    }
  }
  return tasks
}

// compute() is run on each worker for each task
// For iter 0: uses initialRows from chunk
// For iter k>0: reconstructs full grid from deps (all strips from iter k-1), applies Jacobi
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
  const { iter, strip, startRow, endRow, gridSize, topVal, botVal, leftVal, rightVal, initialRows } = chunk

  // deps is injected by worker.js when task has dependsOn
  // deps[i] = output of strip i from previous iteration = { strip, startRow, endRow, heat }
  // We reconstruct full previous grid from all dep strips

  function jacobiStep (prevGrid) {
    const n = prevGrid.length
    const m = prevGrid[0].length
    const next = Array.from({ length: n }, () => new Array(m).fill(0))
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < m; x++) {
        const gy = startRow + y  // global y
        // Boundary
        if (gy === 0) { next[y][x] = topVal; continue }
        if (gy === gridSize - 1) { next[y][x] = botVal; continue }
        if (x === 0) { next[y][x] = leftVal; continue }
        if (x === m - 1) { next[y][x] = rightVal; continue }
        // Get neighbors from prevGrid (which is the full reconstructed grid)
        const up = prevGrid[y - 1] ? prevGrid[y - 1][x] : topVal
        const down = prevGrid[y + 1] ? prevGrid[y + 1][x] : botVal
        const left = prevGrid[y][x - 1] ?? leftVal
        const right = prevGrid[y][x + 1] ?? rightVal
        next[y][x] = (up + down + left + right) / 4
      }
    }
    return next
  }

  let stripRows
  if (iter === 0) {
    // First iteration: just apply one Jacobi step to initial data
    const prevRows = initialRows || Array.from({ length: endRow - startRow }, () => new Array(gridSize).fill(0))
    stripRows = jacobiStep(prevRows)
  } else {
    // Reconstruct full grid from deps (all strips of prev iter, sorted by strip index)
    // deps is available as the 'deps' argument injected by worker.js
    // We use the deps argument in the function via AsyncFunction injection
    throw new Error('deps injection not available in regular compute — use depAwareCode')
  }

  return { iter, strip, startRow, endRow, rows: heatToRgb(stripRows), heat: stripRows }
}

// For tasks with dependsOn, worker.js injects deps as an extra argument.
// This is the code that actually runs on workers for iter > 0.
// iter 0 still uses compute() above (no deps).
export const depAwareCode = `
  const { iter, strip, startRow, endRow, gridSize, topVal, botVal, leftVal, rightVal } = chunk

  function heatToRgb (heat) {
    return heat.map(row => row.map(v => {
      const t = Math.max(0, Math.min(1, v / 100))
      const r = Math.round(Math.min(255, t < 0.5 ? 0 : (t - 0.5) * 2 * 255))
      const g = Math.round(Math.min(255, t < 0.25 ? t * 4 * 255 : t < 0.75 ? 255 : (1 - t) * 4 * 255))
      const b = Math.round(Math.min(255, t < 0.5 ? (1 - t * 2) * 255 : 0))
      return [r, g, b]
    }))
  }

  function jacobiStep (prevRows, fullGridRows) {
    const n = endRow - startRow
    const m = gridSize
    const next = Array.from({ length: n }, () => new Array(m).fill(0))
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < m; x++) {
        const gy = startRow + y
        if (gy === 0) { next[y][x] = topVal; continue }
        if (gy === gridSize - 1) { next[y][x] = botVal; continue }
        if (x === 0) { next[y][x] = leftVal; continue }
        if (x === gridSize - 1) { next[y][x] = rightVal; continue }
        // Get neighbors from full prev grid
        const prevY = gy  // index into fullGridRows
        const up = fullGridRows[prevY - 1]?.[x] ?? topVal
        const down = fullGridRows[prevY + 1]?.[x] ?? botVal
        const left = fullGridRows[prevY][x - 1] ?? leftVal
        const right = fullGridRows[prevY][x + 1] ?? rightVal
        next[y][x] = (up + down + left + right) / 4
      }
    }
    return next
  }

  // deps = array of { iter, strip, startRow, endRow, heat } from all prev-iter strips
  // Reconstruct full previous grid using heat (float values), not rows (rgb)
  const allPrevRows = deps && deps.length > 0
    ? deps.slice().sort((a, b) => a.startRow - b.startRow).flatMap(d => d.heat)
    : chunk.initialRows || []

  const stripRows = jacobiStep(null, allPrevRows)
  return { iter, strip, startRow, endRow, rows: heatToRgb(stripRows), heat: stripRows }
`

export function join (results) {
  // Take the last iteration's results to form the final grid
  const lastIter = Math.max(...results.map(r => r.iter))
  const finalStrips = results
    .filter(r => r.iter === lastIter)
    .sort((a, b) => a.startRow - b.startRow)

  const fullGrid = finalStrips.flatMap(s => s.rows)  // rows are already [r,g,b] triples
  const gridSize = fullGrid.length

  let ppm = `P3\n${gridSize} ${gridSize}\n255\n`
  for (const row of fullGrid) {
    ppm += row.map(([r, g, b]) => `${r} ${g} ${b}`).join(' ') + '\n'
  }
  return ppm
}
