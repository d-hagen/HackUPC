import test from 'brittle'
import { ThreadPool } from '../thread-pool.js'

// ---------------------------------------------------------------------------
// Thread pool — unit tests
// ---------------------------------------------------------------------------

test('pool starts with requested number of threads', async (t) => {
  const pool = new ThreadPool(2)
  await pool.start()
  t.is(pool.size, 2)
  t.is(pool.workers.length, 2)
  t.is(pool.available, 2)
  await pool.destroy()
})

test('pool executes a single task', async (t) => {
  const pool = new ThreadPool(1)
  await pool.start()

  const { output, threadId } = await pool.runTask({
    id: 'test-1',
    code: 'return 2 + 3',
    argNames: [],
    args: []
  })
  t.is(output, 5)
  t.is(threadId, 0)
  await pool.destroy()
})

test('pool executes task with arguments', async (t) => {
  const pool = new ThreadPool(1)
  await pool.start()

  const { output } = await pool.runTask({
    id: 'test-args',
    code: 'return a * b + c',
    argNames: ['a', 'b', 'c'],
    args: [6, 7, 0]
  })
  t.is(output, 42)
  await pool.destroy()
})

test('pool runs multiple tasks in parallel', async (t) => {
  const pool = new ThreadPool(3)
  await pool.start()

  const t0 = performance.now()
  const results = await Promise.all([
    pool.runTask({ id: 't1', code: 'await new Promise(r => setTimeout(r, 100)); return 1' }),
    pool.runTask({ id: 't2', code: 'await new Promise(r => setTimeout(r, 100)); return 2' }),
    pool.runTask({ id: 't3', code: 'await new Promise(r => setTimeout(r, 100)); return 3' })
  ])
  const elapsed = performance.now() - t0

  t.alike(results.map(r => r.output).sort(), [1, 2, 3])
  // If serial, ~300ms. If parallel, ~100ms. Allow generous margin.
  t.ok(elapsed < 250, `parallel execution took ${elapsed.toFixed(0)}ms (expected < 250ms)`)
  await pool.destroy()
})

test('pool queues tasks when all threads are busy', async (t) => {
  const pool = new ThreadPool(1) // only 1 thread
  await pool.start()

  const results = await Promise.all([
    pool.runTask({ id: 'q1', code: 'return 10' }),
    pool.runTask({ id: 'q2', code: 'return 20' }),
    pool.runTask({ id: 'q3', code: 'return 30' })
  ])

  t.alike(results.map(r => r.output).sort((a, b) => a - b), [10, 20, 30])
  await pool.destroy()
})

test('pool propagates task errors', async (t) => {
  const pool = new ThreadPool(1)
  await pool.start()

  await t.exception(
    () => pool.runTask({ id: 'err', code: 'throw new Error("task-boom")' }),
    /task-boom/
  )
  await pool.destroy()
})

test('pool continues working after a task error', async (t) => {
  const pool = new ThreadPool(1)
  await pool.start()

  // First task errors
  try {
    await pool.runTask({ id: 'fail', code: 'throw new Error("oops")' })
  } catch {}

  // Next task should still work
  const { output } = await pool.runTask({ id: 'ok', code: 'return 99' })
  t.is(output, 99)
  await pool.destroy()
})

test('pool rejects tasks after destroy', async (t) => {
  const pool = new ThreadPool(1)
  await pool.start()
  await pool.destroy()

  await t.exception(
    () => pool.runTask({ id: 'late', code: 'return 1' }),
    /destroyed/
  )
})

test('pool reports available and busy state', async (t) => {
  const pool = new ThreadPool(2)
  await pool.start()

  t.is(pool.available, 2)
  t.is(pool.busy, false)

  // Start a slow task to occupy one thread
  const slow = pool.runTask({
    id: 'slow',
    code: 'await new Promise(r => setTimeout(r, 200)); return "done"'
  })

  // Give it a moment to be picked up
  await new Promise(r => setTimeout(r, 20))

  t.is(pool.available, 1)
  t.is(pool.busy, false)

  await slow
  await pool.destroy()
})

test('pool handles async task code', async (t) => {
  const pool = new ThreadPool(1)
  await pool.start()

  const { output } = await pool.runTask({
    id: 'async',
    code: `
      const arr = [1, 2, 3, 4, 5]
      await new Promise(r => setTimeout(r, 10))
      return arr.reduce((a, b) => a + b, 0)
    `
  })
  t.is(output, 15)
  await pool.destroy()
})

test('pool default size is at least 1', async (t) => {
  const pool = new ThreadPool()
  t.ok(pool.size >= 1, `default size is ${pool.size}`)
  // don't start — just checking constructor
})
