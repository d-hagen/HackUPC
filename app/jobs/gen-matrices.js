// Generate random matrices for distributed multiplication test
// Run from app/: node jobs/gen-matrices.js [size]
// Default size: 500 (500x500 matrices, ~2.5 MB each)

import { writeFileSync, statSync } from 'fs'

const size = parseInt(process.argv[2]) || 500

function randomMatrix (rows, cols) {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => Math.floor(Math.random() * 10))
  )
}

const A = randomMatrix(size, size)
const B = randomMatrix(size, size)

writeFileSync('matrix-a.json', JSON.stringify(A))
writeFileSync('matrix-b.json', JSON.stringify(B))
writeFileSync('matrix-meta.json', JSON.stringify({ rows: size, cols: size }))

const aKB = (statSync('matrix-a.json').size / 1024).toFixed(1)
const bKB = (statSync('matrix-b.json').size / 1024).toFixed(1)

console.log(`Generated ${size}x${size} matrices:`)
console.log(`  matrix-a.json (${aKB} KB)`)
console.log(`  matrix-b.json (${bKB} KB)`)
console.log(`  matrix-meta.json`)
console.log()
console.log('Next steps in the requester prompt:')
console.log('  upload matrix-a.json')
console.log('  upload matrix-b.json')
console.log('  job jobs/matrix-job.js')
