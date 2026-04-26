// ─── Distributed Matrix Multiplication ───────────────────────────────────────
// Computes C = A × B by splitting rows of A across workers. Each worker reads
// both matrices from the shared Hyperdrive, multiplies its assigned rows, and
// returns results. Demonstrates P2P file sharing via Hyperdrive.
//
// Setup (run once from app/ directory):
//   node jobs/gen-matrices.js 500     → generates matrix-a.json, matrix-b.json
//
// Usage (from requester prompt):
//   upload matrix-a.json
//   upload matrix-b.json
//   job jobs/matrix-job.js 4          → 4 workers each multiply their row block
//
// No external dependencies beyond the generated matrix files.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs'

const meta = JSON.parse(readFileSync('matrix-meta.json', 'utf-8'))

export const data = { rows: meta.rows }

export function split (data, n) {
  // Distribute row indices round-robin across n workers
  const chunks = Array.from({ length: n }, () => [])
  for (let i = 0; i < data.rows; i++) {
    chunks[i % n].push(i)
  }
  return chunks.map(rows => ({ rows }))
}

export async function compute (chunk) {
  // readFile and emit are injected by the worker runtime (lexical scope)
  emit({ status: 'loading matrices from Hyperdrive' })

  const rawA = await readFile('/matrix-a.json')
  const rawB = await readFile('/matrix-b.json')
  const A = JSON.parse(typeof rawA === 'string' ? rawA : rawA.toString())
  const B = JSON.parse(typeof rawB === 'string' ? rawB : rawB.toString())

  emit({ status: 'computing', assignedRows: chunk.rows.length, matrixSize: A.length })

  const K = A[0].length
  const N = B[0].length
  const result = []

  for (let idx = 0; idx < chunk.rows.length; idx++) {
    const i = chunk.rows[idx]
    const row = new Array(N)
    for (let j = 0; j < N; j++) {
      let sum = 0
      for (let k = 0; k < K; k++) {
        sum += A[i][k] * B[k][j]
      }
      row[j] = sum
    }
    result.push({ i, row })

    // Progress update every 50 rows
    if ((idx + 1) % 50 === 0) {
      emit({ progress: `${idx + 1}/${chunk.rows.length} rows` })
    }
  }

  emit({ status: 'done', rowsComputed: result.length })
  return result
}

export function join (results) {
  // Reassemble all rows in order
  const all = results.flat()
  all.sort((a, b) => a.i - b.i)
  const C = all.map(r => r.row)

  const n = C.length
  const m = C[0].length
  const checksum = C.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0)

  return {
    result: `${n}x${m} matrix`,
    corners: {
      topLeft: C[0][0],
      topRight: C[0][m - 1],
      bottomLeft: C[n - 1][0],
      bottomRight: C[n - 1][m - 1]
    },
    checksum
  }
}
