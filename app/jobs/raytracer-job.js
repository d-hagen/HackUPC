// Distributed ray tracer: each worker renders a horizontal strip
// join() assembles strips into a PPM file (open with Preview on macOS)
export const outputFile = 'render.ppm'

export const data = {
  width: 800,
  height: 600,
  samplesPerPixel: 64,
  maxDepth: 10
}

export function split (data, n) {
  const rowsPerChunk = Math.ceil(data.height / n)
  const chunks = []
  for (let i = 0; i < n; i++) {
    const startRow = i * rowsPerChunk
    const endRow = Math.min(startRow + rowsPerChunk, data.height)
    if (startRow >= data.height) break
    chunks.push({ ...data, startRow, endRow })
  }
  return chunks
}

export function compute (chunk) {
  const { width, height, startRow, endRow, samplesPerPixel, maxDepth } = chunk

  // --- Scene ---
  const spheres = [
    // ground
    { cx: 0, cy: -100.5, cz: -1, r: 100, color: [0.5, 0.8, 0.4], type: 'diffuse' },
    // center glass-like
    { cx: 0, cy: 0, cz: -1, r: 0.5, color: [0.8, 0.8, 1.0], type: 'diffuse' },
    // left metal
    { cx: -1.1, cy: 0, cz: -1, r: 0.5, color: [0.8, 0.6, 0.2], type: 'metal', fuzz: 0.3 },
    // right metal
    { cx: 1.1, cy: 0, cz: -1, r: 0.5, color: [0.7, 0.3, 0.3], type: 'metal', fuzz: 0.0 },
    // small top
    { cx: 0, cy: 1.0, cz: -1.5, r: 0.3, color: [0.9, 0.7, 0.2], type: 'diffuse' }
  ]

  // --- Camera ---
  const camOrigin = [0, 0.5, 2]
  const camTarget = [0, 0, -1]
  const up = [0, 1, 0]
  const fov = Math.PI / 4

  const vlen = (v) => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  const norm = (v) => { const l = vlen(v); return [v[0] / l, v[1] / l, v[2] / l] }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
  const scale = (v, s) => [v[0] * s, v[1] * s, v[2] * s]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ]
  const reflect = (v, n) => sub(v, scale(n, 2 * dot(v, n)))
  const mulColor = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]]

  const w = norm(sub(camOrigin, camTarget))
  const u = norm(cross(up, w))
  const v = cross(w, u)

  const halfH = Math.tan(fov / 2)
  const halfW = halfH * (width / height)

  const lowerLeft = sub(sub(sub(camOrigin, scale(u, halfW)), scale(v, halfH)), w)
  const horiz = scale(u, 2 * halfW)
  const vert = scale(v, 2 * halfH)

  // LCG random
  let seed = 42 + startRow * 1337
  function rand () {
    seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF
    return (seed >>> 0) / 0xFFFFFFFF
  }
  function randInUnitSphere () {
    let p
    do { p = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1] } while (vlen(p) >= 1)
    return p
  }

  function hitSphere (s, ro, rd, tmin, tmax) {
    const oc = sub(ro, [s.cx, s.cy, s.cz])
    const a = dot(rd, rd)
    const b = dot(oc, rd)
    const c = dot(oc, oc) - s.r * s.r
    const disc = b * b - a * c
    if (disc < 0) return null
    const sqrtD = Math.sqrt(disc)
    let t = (-b - sqrtD) / a
    if (t < tmin || t > tmax) {
      t = (-b + sqrtD) / a
      if (t < tmin || t > tmax) return null
    }
    const p = add(ro, scale(rd, t))
    const n = norm(sub(p, [s.cx, s.cy, s.cz]))
    return { t, p, n, sphere: s }
  }

  function sceneHit (ro, rd, tmin, tmax) {
    let best = null
    for (const s of spheres) {
      const h = hitSphere(s, ro, rd, tmin, best ? best.t : tmax)
      if (h) best = h
    }
    return best
  }

  function rayColor (ro, rd, depth) {
    if (depth <= 0) return [0, 0, 0]
    const h = sceneHit(ro, rd, 0.001, 1e9)
    if (!h) {
      // sky gradient
      const t = 0.5 * (norm(rd)[1] + 1)
      return add(scale([1, 1, 1], 1 - t), scale([0.5, 0.7, 1.0], t))
    }
    const { p, n, sphere: s } = h
    if (s.type === 'metal') {
      const ref = reflect(norm(rd), n)
      const scattered = add(ref, scale(randInUnitSphere(), s.fuzz))
      if (dot(scattered, n) > 0) {
        return mulColor(s.color, rayColor(p, scattered, depth - 1))
      }
      return [0, 0, 0]
    }
    // diffuse
    const target = add(add(p, n), randInUnitSphere())
    return mulColor(s.color, scale(rayColor(p, sub(target, p), depth - 1), 0.5))
  }

  const rows = []
  for (let y = startRow; y < endRow; y++) {
    const row = []
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0
      for (let s = 0; s < samplesPerPixel; s++) {
        const su = (x + rand()) / width
        const sv = 1 - (y + rand()) / height
        const dir = norm(sub(add(add(lowerLeft, scale(horiz, su)), scale(vert, sv)), camOrigin))
        const [cr, cg, cb] = rayColor(camOrigin, dir, maxDepth)
        r += cr; g += cg; b += cb
      }
      // gamma correction
      row.push([
        Math.min(255, Math.floor(Math.sqrt(r / samplesPerPixel) * 255.99)),
        Math.min(255, Math.floor(Math.sqrt(g / samplesPerPixel) * 255.99)),
        Math.min(255, Math.floor(Math.sqrt(b / samplesPerPixel) * 255.99))
      ])
    }
    rows.push(row)
  }

  return { startRow, endRow, rows }
}

export function join (results) {
  results.sort((a, b) => a.startRow - b.startRow)
  const width = results[0].rows[0].length
  const height = results.reduce((s, r) => s + r.rows.length, 0)

  // Build PPM file content
  let ppm = `P3\n${width} ${height}\n255\n`
  for (const strip of results) {
    for (const row of strip.rows) {
      ppm += row.map(([r, g, b]) => `${r} ${g} ${b}`).join(' ') + '\n'
    }
  }
  return ppm
}
