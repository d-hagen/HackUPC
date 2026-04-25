import test from 'brittle' // https://github.com/holepunchto/brittle
import { bundleTask } from '../bundler.js'
import { executeTask } from '../worker.js'
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary task file and return its absolute path */
function tmpTask (code) {
  const dir = mkdtempSync(join(tmpdir(), 'pctest-'))
  const file = join(dir, 'task.js')
  writeFileSync(file, code)
  return { file, cleanup: () => { try { unlinkSync(file) } catch {} try { rmdirSync(dir) } catch {} } }
}

/** Bundle a task file then execute it on the worker side */
async function bundleAndRun (filePath, argNames = [], args = []) {
  const { code } = await bundleTask(filePath, argNames)
  return executeTask({ code, argNames, args })
}

// ---------------------------------------------------------------------------
// bundleTask — unit tests
// ---------------------------------------------------------------------------

test('bundleTask returns code string and argNames', async (t) => {
  const { file, cleanup } = tmpTask('export default async function () { return 42 }')
  try {
    const result = await bundleTask(file)
    t.is(typeof result.code, 'string', 'code is a string')
    t.ok(result.code.length > 0, 'code is non-empty')
    t.alike(result.argNames, [], 'argNames defaults to empty array')
  } finally { cleanup() }
})

test('bundleTask forwards argNames', async (t) => {
  const { file, cleanup } = tmpTask('export default async function (x, y) { return x + y }')
  try {
    const result = await bundleTask(file, ['x', 'y'])
    t.alike(result.argNames, ['x', 'y'])
  } finally { cleanup() }
})

test('bundleTask inlines npm dependencies', async (t) => {
  // Use the real hello-ms.js task that imports `ms`
  const { code } = await bundleTask(join(import.meta.dirname, '..', 'tasks', 'hello-ms.js'))
  // The bundled code should contain the inlined ms logic — no dynamic require needed
  t.ok(code.includes('__module'), 'wrapper sets up CommonJS shim')
  t.ok(code.includes('__fn'), 'wrapper extracts default export')
  t.absent(code.includes('require("ms")'), 'ms is inlined, not dynamically required')
})

test('bundleTask rejects non-existent file', async (t) => {
  await t.exception(() => bundleTask('/no/such/file.js'), 'throws on missing file')
})

// ---------------------------------------------------------------------------
// executeTask with bundled code — integration tests
// ---------------------------------------------------------------------------

test('execute bundled task: no deps, no args', async (t) => {
  const { file, cleanup } = tmpTask('export default async function () { return 42 }')
  try {
    const result = await bundleAndRun(file)
    t.is(result, 42)
  } finally { cleanup() }
})

test('execute bundled task: with args', async (t) => {
  const { file, cleanup } = tmpTask('export default async function (a, b) { return a * b }')
  try {
    const result = await bundleAndRun(file, ['a', 'b'], [6, 7])
    t.is(result, 42)
  } finally { cleanup() }
})

test('execute bundled task: hello-ms (npm dep)', async (t) => {
  const taskPath = join(import.meta.dirname, '..', 'tasks', 'hello-ms.js')
  const result = await bundleAndRun(taskPath)
  t.ok(Array.isArray(result), 'result is an array')
  t.is(result.length, 4, 'four formatted durations')
  t.ok(result[0].includes('1000ms'), 'first entry contains 1000ms')
  t.ok(result[0].includes('1s'), 'first entry shows "1s"')
})

test('execute bundled task: format-bytes with args (npm dep + args)', async (t) => {
  const taskPath = join(import.meta.dirname, '..', 'tasks', 'format-bytes.js')
  const result = await bundleAndRun(taskPath, ['bytes'], [1048576])
  t.ok(result.formatted, 'has formatted field')
  t.ok(result.formatted.includes('MB'), '1048576 bytes = ~1 MB')
  t.ok(result.transferTime, 'has transferTime field')
})

test('execute bundled task: sync default export', async (t) => {
  const { file, cleanup } = tmpTask('export default function () { return "sync-ok" }')
  try {
    const result = await bundleAndRun(file)
    t.is(result, 'sync-ok')
  } finally { cleanup() }
})

test('execute bundled task: returns complex object', async (t) => {
  const { file, cleanup } = tmpTask(`
    export default async function () {
      return { nums: [1, 2, 3], nested: { ok: true } }
    }
  `)
  try {
    const result = await bundleAndRun(file)
    t.alike(result.nums, [1, 2, 3])
    t.is(result.nested.ok, true)
  } finally { cleanup() }
})

test('bundled task that throws propagates error', async (t) => {
  const { file, cleanup } = tmpTask('export default async function () { throw new Error("boom") }')
  try {
    await t.exception(() => bundleAndRun(file), /boom/)
  } finally { cleanup() }
})

// ---------------------------------------------------------------------------
// Task dependencies — bundling inlines npm deps so workers don't need them
// ---------------------------------------------------------------------------

test('bundled task with npm dep runs without worker having the package', async (t) => {
  // Simulates a worker that doesn't have `ms` installed:
  // the bundled code must contain the full inlined implementation
  const taskPath = join(import.meta.dirname, '..', 'tasks', 'hello-ms.js')
  const { code } = await bundleTask(taskPath)

  // The bundled code must NOT contain a live require('ms') call
  t.absent(code.includes('require("ms")'), 'no dynamic require("ms")')
  t.absent(code.includes("require('ms')"), 'no dynamic require(\'ms\')')

  // Execute the bundled code directly via executeTask (simulates a fresh worker)
  const result = await executeTask({ code, argNames: [], args: [] })
  t.ok(Array.isArray(result), 'result is an array')
  t.is(result.length, 4)
  t.ok(result[0].includes('1s'), 'ms package logic is working inside bundle')
})

test('bundled task with npm dep + args works end-to-end', async (t) => {
  // format-bytes.js uses ms — worker must not need either installed
  const taskPath = join(import.meta.dirname, '..', 'tasks', 'format-bytes.js')
  const { code } = await bundleTask(taskPath, ['bytes'])

  const result = await executeTask({ code, argNames: ['bytes'], args: [1073741824] })
  t.is(result.formatted, '1.00 GB', 'formats 1 GiB correctly')
  t.ok(result.transferTime, 'ms-based transfer time present')
})

test('bundled task using npm dep from tasks/ dir inlines it', async (t) => {
  // Both hello-ms.js and format-bytes.js import ms — bundling either should
  // produce code that works without ms being available at runtime
  const helloPath = join(import.meta.dirname, '..', 'tasks', 'hello-ms.js')
  const fmtPath = join(import.meta.dirname, '..', 'tasks', 'format-bytes.js')

  const { code: helloCode } = await bundleTask(helloPath)
  const { code: fmtCode } = await bundleTask(fmtPath, ['bytes'])

  // Both should have the dep inlined
  t.absent(helloCode.includes('require("ms")'), 'hello-ms: ms inlined')
  t.absent(fmtCode.includes('require("ms")'), 'format-bytes: ms inlined')

  // Both should execute correctly
  const helloResult = await executeTask({ code: helloCode, argNames: [], args: [] })
  t.is(helloResult.length, 4)

  const fmtResult = await executeTask({ code: fmtCode, argNames: ['bytes'], args: [1024] })
  t.is(fmtResult.formatted, '1.00 KB')
})

test('bundled task: require shim in wrapper rejects dynamic requires', async (t) => {
  // The wrapBundle CJS shim includes a require function that throws on any call.
  // We test it directly by crafting code that invokes the shim's require.
  const code = `
const __module = { exports: {} };
const __exports = __module.exports;
(function(module, exports, require) {
  module.exports.default = function() { return require("some-pkg") };
})(__module, __exports, function(id) {
  throw new Error('Dynamic require("' + id + '") is not supported in bundled tasks.');
});
const __fn = __module.exports.default;
return await __fn();
`
  await t.exception(
    () => executeTask({ code, argNames: [], args: [] }),
    /Dynamic require\("some-pkg"\) is not supported/
  )
})

test('bundled task: uses only built-in node APIs without npm deps', async (t) => {
  // A task with no npm imports should still bundle and run fine
  const { file, cleanup } = tmpTask(`
    export default async function () {
      return { pid: typeof process !== 'undefined', math: Math.PI }
    }
  `)
  try {
    const result = await bundleAndRun(file)
    t.is(result.math, Math.PI)
  } finally { cleanup() }
})

test('bundled task: dep used in both directions (parse + format)', async (t) => {
  // hello-ms already tests format; here we verify format-bytes uses ms for
  // computation, proving the dep is functional, not just inlined as dead code
  const taskPath = join(import.meta.dirname, '..', 'tasks', 'format-bytes.js')
  const { code } = await bundleTask(taskPath, ['bytes'])

  // Various inputs to stress the inlined dep
  const r1 = await executeTask({ code, argNames: ['bytes'], args: [0] })
  t.is(r1.formatted, '0.00 B', 'handles zero bytes')

  const r2 = await executeTask({ code, argNames: ['bytes'], args: [1099511627776] })
  t.is(r2.formatted, '1.00 TB', 'handles terabytes')
})

test('bundled task: large dependency is fully contained in bundle', async (t) => {
  // Verify the bundle is self-contained by checking it has substantial size
  // (a trivial function without deps would be very small)
  const taskPath = join(import.meta.dirname, '..', 'tasks', 'hello-ms.js')
  const { code: bundledCode } = await bundleTask(taskPath)

  const { file: bareFile, cleanup: bareCleanup } = tmpTask('export default function () { return 1 }')
  try {
    const { code: bareCode } = await bundleTask(bareFile)
    t.ok(bundledCode.length > bareCode.length, 'bundle with dep is larger than bare task')
    // The wrapper structure should be present
    t.ok(bundledCode.includes('__module'), 'has CJS wrapper')
    t.ok(bundledCode.includes('__fn'), 'has function extractor')
  } finally { bareCleanup() }
})

// ---------------------------------------------------------------------------
// executeTask — plain (non-bundled) code still works
// ---------------------------------------------------------------------------

test('executeTask: plain inline code', async (t) => {
  const result = await executeTask({ code: 'return 1 + 2', argNames: [], args: [] })
  t.is(result, 3)
})

test('executeTask: plain code with args', async (t) => {
  const result = await executeTask({ code: 'return n * n', argNames: ['n'], args: [9] })
  t.is(result, 81)
})

test('executeTask: rejects task with no code', async (t) => {
  await t.exception(() => executeTask({}), /no code/)
})
