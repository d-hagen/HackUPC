// Generic task executor: runs arbitrary JS function code sent as a string
// Supports optional file I/O via Hyperdrive and shell command execution

import { spawn } from 'child_process'

export function executeShellTask (task, onEmit) {
  const { cmd, timeout = 60000 } = task

  if (!cmd) throw new Error('Shell task has no cmd field')

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let killed = false

    const proc = spawn('sh', ['-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: task.cwd || process.cwd()
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

export async function executeTask (task, inputDrive, outputDrive, onEmit) {
  if (task.taskType === 'shell') {
    return executeShellTask(task, onEmit)
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

  const fn = new (Object.getPrototypeOf(async function () {}).constructor)(...argNames, code)
  const result = await fn(...args)
  return result === undefined ? null : result
}
