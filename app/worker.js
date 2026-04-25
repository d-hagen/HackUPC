// Generic task executor: runs arbitrary JS function code sent as a string
// Supports optional file I/O via Hyperdrive

export async function executeTask (task, inputDrive, outputDrive) {
  const { code, args = [] } = task

  if (!code) throw new Error('Task has no code field')

  // Build helpers for file access if drives are provided
  const helpers = {}
  const argNames = [...(task.argNames || [])]

  if (inputDrive) {
    helpers.readFile = async (path, encoding) => {
      return inputDrive.get(path, { encoding })
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

  const fn = new (Object.getPrototypeOf(async function () {}).constructor)(...argNames, code)
  const result = await fn(...args)
  return result
}
