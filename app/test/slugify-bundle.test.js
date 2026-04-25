import test from 'brittle'
import { bundleTask } from '../bundler.js'
import { executeTask } from '../worker.js'
import { join } from 'path'

const TASK_PATH = join(import.meta.dirname, '..', 'tasks', 'slugify-text.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function bundleAndRun (args = []) {
  const { code } = await bundleTask(TASK_PATH, ['text'])
  return executeTask({ code, argNames: ['text'], args })
}

// ---------------------------------------------------------------------------
// bundleTask — slugify is fully inlined
// ---------------------------------------------------------------------------

test('slugify: bundle contains no dynamic require', async (t) => {
  const { code } = await bundleTask(TASK_PATH, ['text'])
  t.absent(code.includes('require("slugify")'), 'no require("slugify")')
  t.absent(code.includes("require('slugify')"), "no require('slugify')")
  t.ok(code.includes('__module'), 'CJS wrapper present')
  t.ok(code.includes('__fn'), 'function extractor present')
})

test('slugify: bundled code is self-contained (larger than bare task)', async (t) => {
  const { code } = await bundleTask(TASK_PATH, ['text'])
  // slugify library adds substantial size; a bare return would be < 500 chars
  t.ok(code.length > 1000, `bundle is ${code.length} chars, well above a bare task`)
})

// ---------------------------------------------------------------------------
// executeTask — slugify works on worker without the package installed
// ---------------------------------------------------------------------------

test('slugify: basic text conversion', async (t) => {
  const result = await bundleAndRun(['Hello World'])
  t.is(result.original, 'Hello World')
  t.is(result.slug, 'hello-world')
  t.is(result.slugUpper, 'Hello-World')
  t.is(result.slugCustom, 'hello_world')
})

test('slugify: special characters are handled', async (t) => {
  const result = await bundleAndRun(['Foo & Bar'])
  t.is(result.slug, 'foo-and-bar', '& becomes "and" in strict mode')
  t.is(result.slugCustom, 'foo_and_bar', 'custom separator works')
  t.ok(!result.slug.includes('&'), 'no raw & in slug')
})

test('slugify: unicode / accented characters', async (t) => {
  const result = await bundleAndRun(['Café Résumé'])
  t.ok(result.slug.length > 0, 'produces a non-empty slug')
  // slugify keeps accents by default, strict may strip them
  t.is(typeof result.slug, 'string')
})

test('slugify: empty string input', async (t) => {
  const result = await bundleAndRun([''])
  t.is(result.original, '')
  t.is(result.slug, '', 'empty in = empty slug')
})

test('slugify: numeric input', async (t) => {
  const result = await bundleAndRun(['42 is the answer'])
  t.is(result.slug, '42-is-the-answer')
})

test('slugify: long string with mixed content', async (t) => {
  const input = 'This is a Really Long Title!! With (Parentheses) & Special Chars 2024'
  const result = await bundleAndRun([input])
  t.is(result.original, input)
  t.ok(result.slug.length > 0)
  t.ok(!result.slug.includes(' '), 'no spaces in slug')
  t.ok(!result.slug.includes('!'), 'no exclamation marks in strict slug')
})

test('slugify: already-slugified input is unchanged', async (t) => {
  const result = await bundleAndRun(['already-a-slug'])
  t.is(result.slug, 'already-a-slug')
})

// ---------------------------------------------------------------------------
// Proves the dep is NOT needed at runtime on the worker
// ---------------------------------------------------------------------------

test('slugify: executing raw bundled code via executeTask (simulated worker)', async (t) => {
  // This is the exact flow a remote worker goes through:
  // 1. Receive a code string + argNames + args from Autobase
  // 2. Run it via executeTask — no npm install, no fs, just the string
  const { code, argNames } = await bundleTask(TASK_PATH, ['text'])

  const result = await executeTask({
    code,
    argNames,
    args: ['PeerCompute is awesome!']
  })

  t.is(result.slug, 'peercompute-is-awesome', 'full pipeline works without slugify installed on worker')
})
