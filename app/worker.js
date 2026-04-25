// Generic task executor: runs arbitrary JS function code sent as a string
// Task format: { type: 'task', id, code: 'function body as string', args: [...], by, ts }
// The code string is wrapped in an AsyncFunction and called with ...args
// Return value is sent back as the result

export async function executeTask (task) {
  const { code, args = [] } = task

  if (!code) throw new Error('Task has no code field')

  // Build an async function from the code string and invoke it
  const fn = new (Object.getPrototypeOf(async function () {}).constructor)(...(task.argNames || []), code)
  const result = await fn(...args)
  return result
}
