// Sum a large array by splitting across workers
export const data = Array.from({ length: 1000 }, (_, i) => i + 1)

export function split (data, n) {
  const chunks = Array.from({ length: n }, () => [])
  data.forEach((v, i) => chunks[i % n].push(v))
  return chunks
}

export function compute (chunk) {
  return chunk.reduce((a, b) => a + b, 0)
}

export function join (results) {
  return results.reduce((a, b) => a + b, 0)
}
