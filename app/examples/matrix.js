// Simple matrix multiplication for demo
// Multiply two NxN matrices

export function createRandomMatrix (n) {
  const m = []
  for (let i = 0; i < n; i++) {
    const row = []
    for (let j = 0; j < n; j++) {
      row.push(Math.floor(Math.random() * 10))
    }
    m.push(row)
  }
  return m
}

export function multiplyMatrices (a, b) {
  const n = a.length
  const result = []
  for (let i = 0; i < n; i++) {
    result[i] = []
    for (let j = 0; j < n; j++) {
      let sum = 0
      for (let k = 0; k < n; k++) {
        sum += a[i][k] * b[k][j]
      }
      result[i][j] = sum
    }
  }
  return result
}

export function printMatrix (m, label) {
  console.log(`${label} (${m.length}x${m[0].length}):`)
  for (const row of m) {
    console.log('  [' + row.map(v => String(v).padStart(5)).join(', ') + ' ]')
  }
}
