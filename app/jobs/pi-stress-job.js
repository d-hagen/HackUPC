// Monte Carlo Pi estimation — CPU-heavy job that takes ~4 minutes total
// Each chunk runs ~4 min / n workers, emitting progress every ~60 seconds
// Usage: job jobs/pi-stress-job.js

export const data = { totalSamples: 800_000_000 }

export function split (data, n) {
  const perWorker = Math.ceil(data.totalSamples / n)
  const chunks = []
  for (let i = 0; i < n; i++) {
    chunks.push({ samples: perWorker, chunkIndex: i, totalChunks: n })
  }
  return chunks
}

export function compute (chunk) {
  const { samples, chunkIndex } = chunk
  let inside = 0
  const batchSize = 1_000_000
  const emitEvery = 60_000 // 60s in ms
  let lastEmit = Date.now()

  for (let done = 0; done < samples; done += batchSize) {
    const end = Math.min(done + batchSize, samples)
    for (let i = done; i < end; i++) {
      const x = Math.random()
      const y = Math.random()
      if (x * x + y * y <= 1) inside++
    }

    const now = Date.now()
    if (now - lastEmit >= emitEvery) {
      const progress = ((end / samples) * 100).toFixed(1)
      const piEstimate = (4 * inside / end).toFixed(6)
      emit({ chunkIndex, progress: `${progress}%`, samplesProcessed: end, piSoFar: piEstimate })
      lastEmit = now
    }
  }

  return { inside, total: samples }
}

export function join (results) {
  let totalInside = 0
  let totalSamples = 0
  for (const r of results) {
    totalInside += r.inside
    totalSamples += r.total
  }
  const pi = 4 * totalInside / totalSamples
  return {
    pi,
    error: Math.abs(pi - Math.PI).toFixed(10),
    totalSamples,
    workers: results.length
  }
}
