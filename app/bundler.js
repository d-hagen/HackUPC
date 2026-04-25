// Bundles a task file and its npm dependencies into a single self-contained string
// using esbuild. The result can be sent over Autobase and executed on any worker
// without the worker needing the npm packages installed.
//
// The task file must have a default export that is the function to run:
//   export default function (args...) { ... }
//   export default async function (args...) { ... }
//
// Usage:
//   const { code, argNames } = await bundleTask('/path/to/task.js', ['arg1', 'arg2'])

import { build } from 'esbuild'
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Bundle a task file into a self-contained string.
 * @param {string} filePath  Absolute path to the task .js file
 * @param {string[]} argNames  Names of arguments the task function receives
 * @returns {{ code: string, argNames: string[] }}
 */
export async function bundleTask (filePath, argNames = []) {
  // esbuild compiles the file + all imports into a single IIFE bundle (CJS output).
  // We use a temp file so we can read the result back as a string.
  const tmpDir = mkdtempSync(join(tmpdir(), 'peercompute-'))
  const outFile = join(tmpDir, 'bundle.js')

  try {
    await build({
      entryPoints: [filePath],
      bundle: true,          // inline all imports recursively
      platform: 'node',
      format: 'cjs',         // CommonJS — safe to eval in a Function() context
      outfile: outFile,
      minify: false,         // keep readable for debugging
      treeShaking: true,
      logLevel: 'silent'
    })

    const bundledSource = readFileSync(outFile, 'utf-8')

    // Wrap the bundle so that when executed it exposes `module.exports`.
    // Then we call the exported default function with the provided args.
    // The resulting code string is what gets stored in the Autobase task entry.
    const code = wrapBundle(bundledSource, argNames)

    return { code, argNames }
  } finally {
    try { unlinkSync(outFile) } catch {}
    try { unlinkSync(tmpDir) } catch {}
  }
}

/**
 * Wraps a CJS bundle string so it can be run inside an AsyncFunction body.
 * The wrapper:
 *   1. Sets up a minimal CommonJS shim (module, exports, require stub)
 *   2. Executes the bundle
 *   3. Calls module.exports.default (or module.exports itself if no .default)
 *      with the provided argNames forwarded as arguments
 *   4. Returns whatever the task function returns
 */
function wrapBundle (bundledSource, argNames) {
  const argsForward = argNames.join(', ')
  return `
// --- bundled task (esbuild CJS output) ---
const __module = { exports: {} };
const __exports = __module.exports;
(function(module, exports, require) {
${bundledSource}
})(__module, __exports, function(id) {
  // minimal require shim: built-ins only — npm deps are already inlined by esbuild
  throw new Error('Dynamic require("' + id + '") is not supported in bundled tasks. All npm deps must be statically imported so esbuild can inline them.');
});
const __fn = __module.exports.default || __module.exports;
if (typeof __fn !== 'function') throw new Error('Bundled task must have a default export that is a function');
return await __fn(${argsForward});
// --- end bundle ---
`
}
