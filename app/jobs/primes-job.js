// ─── Prime Sieve ─────────────────────────────────────────────────────────────
// Finds all primes up to a limit by splitting the number range across workers.
// Simple embarrassingly parallel job — good "hello world" for new workers.
// join() merges sorted prime lists from each range.
//
// Usage (from requester prompt):
//   job jobs/primes-job.js 4     → 4 workers each sieve their range
//   job jobs/primes-job.js [n]
//
// No external dependencies. Works on any worker.
// ─────────────────────────────────────────────────────────────────────────────
export const data = { limit: 10000 }

export function split (data, n) {
  const { limit } = data
  const chunkSize = Math.ceil(limit / n)
  const chunks = []
  for (let i = 0; i < n; i++) {
    chunks.push({ from: i * chunkSize + 1, to: Math.min((i + 1) * chunkSize, limit) })
  }
  return chunks
}

export function compute (chunk) {
  const primes = []
  for (let num = Math.max(2, chunk.from); num <= chunk.to; num++) {
    let isPrime = true
    for (let i = 2; i * i <= num; i++) {
      if (num % i === 0) { isPrime = false; break }
    }
    if (isPrime) primes.push(num)
  }
  return primes
}

export function join (results) {
  return results.flat().sort((a, b) => a - b)
}
