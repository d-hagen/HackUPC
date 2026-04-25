// Compute a Mandelbrot tile and return pixel data
// Each pixel is an iteration count (0 = in set, >0 = escaped at that iteration)

export function computeMandelbrot ({ x, y, w, h, iter, realMin = -2.5, realMax = 1, imagMin = -1.25, imagMax = 1.25, totalW = 512, totalH = 512 }) {
  const pixels = new Array(w * h)

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      // Map pixel to complex plane
      const cr = realMin + ((x + px) / totalW) * (realMax - realMin)
      const ci = imagMin + ((y + py) / totalH) * (imagMax - imagMin)

      let zr = 0
      let zi = 0
      let n = 0

      while (n < iter && zr * zr + zi * zi <= 4) {
        const tmp = zr * zr - zi * zi + cr
        zi = 2 * zr * zi + ci
        zr = tmp
        n++
      }

      pixels[py * w + px] = n
    }
  }

  return pixels
}

// Split a full image into tile tasks
export function createTileTasks (totalW, totalH, tileSize, iter) {
  const tasks = []
  for (let y = 0; y < totalH; y += tileSize) {
    for (let x = 0; x < totalW; x += tileSize) {
      const w = Math.min(tileSize, totalW - x)
      const h = Math.min(tileSize, totalH - y)
      tasks.push({ x, y, w, h, iter, totalW, totalH })
    }
  }
  return tasks
}
