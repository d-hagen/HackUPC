// Generic task executor: runs arbitrary JS function code sent as a string
// Supports optional file I/O via Hyperdrive and shell command execution

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Materialize all files from a Hyperdrive to a temp directory
// Returns the temp dir path. Called before shell tasks that need drive files.
async function materializeDrive (drive, prefix = 'peercompute-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  for await (const entry of drive.list('/')) {
    const filePath = path.join(tmpDir, entry.key.replace(/^\//, ''))
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const data = await drive.get(entry.key)
    if (data) fs.writeFileSync(filePath, data)
  }
  return tmpDir
}

export function executeShellTask (task, onEmit) {
  const { cmd, timeout = 60000 } = task

  if (!cmd) throw new Error('Shell task has no cmd field')

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let killed = false

    const proc = spawn('sh', ['-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: task.cwd || process.cwd(),
      env: task.env || process.env
    })

    const timer = setTimeout(() => {
      killed = true
      proc.kill('SIGKILL')
    }, timeout)

    proc.stdout.on('data', (d) => {
      const chunk = d.toString()
      stdout += chunk
      if (onEmit) onEmit({ data: chunk, channel: 'stdout' })
    })
    proc.stderr.on('data', (d) => {
      const chunk = d.toString()
      stderr += chunk
      if (onEmit) onEmit({ data: chunk, channel: 'stderr' })
    })

    proc.on('close', (exitCode) => {
      clearTimeout(timer)
      if (killed) {
        resolve({ stdout, stderr, exitCode: -1, timedOut: true })
      } else {
        resolve({ stdout, stderr, exitCode })
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

export async function executeTask (task, inputDrive, outputDrive, onEmit, deps) {
  if (task.taskType === 'shell') {
    // Materialize drive files to /tmp so shell scripts can access them
    let driveDir = null
    if (inputDrive) {
      try { driveDir = await materializeDrive(inputDrive) } catch {}
    }
    const shellTask = driveDir
      ? { ...task, env: { ...process.env, DRIVE_DIR: driveDir }, cwd: driveDir }
      : task
    const result = await executeShellTask(shellTask, onEmit)
    // Clean up temp dir after task completes
    if (driveDir) try { fs.rmSync(driveDir, { recursive: true, force: true }) } catch {}
    return result
  }
  const { code, args = [] } = task

  if (!code) throw new Error('Task has no code field')

  // Build helpers for file access if drives are provided
  const helpers = {}
  const argNames = [...(task.argNames || [])]

  if (inputDrive) {
    helpers.readFile = async (path, encoding) => {
      // Retry with drive sync — Hyperdrive data may still be replicating
      for (let attempt = 0; attempt < 20; attempt++) {
        const data = await inputDrive.get(path, { encoding })
        if (data !== null) return data
        await inputDrive.update()
        await new Promise(r => setTimeout(r, 500))
      }
      return null
    }
    helpers.listFiles = async (path = '/') => {
      const entries = []
      for await (const entry of inputDrive.list(path)) {
        entries.push(entry.key)
      }
      return entries
    }
    argNames.push('readFile', 'listFiles')
    args.push(helpers.readFile, helpers.listFiles)
  }

  if (outputDrive) {
    helpers.writeFile = async (path, data) => {
      await outputDrive.put(path, typeof data === 'string' ? Buffer.from(data) : data)
    }
    argNames.push('writeFile')
    args.push(helpers.writeFile)
  }

  if (onEmit) {
    helpers.emit = (data) => { onEmit({ data, channel: null }) }
    argNames.push('emit')
    args.push(helpers.emit)
  }

  // Inject dependency outputs if provided (DAG support)
  if (deps && deps.length > 0) {
    argNames.push('deps')
    args.push(deps)
  }

  const fn = new (Object.getPrototypeOf(async function () {}).constructor)(...argNames, code)
  const result = await fn(...args)
  return result === undefined ? null : result
}
