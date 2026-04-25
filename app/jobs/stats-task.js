const script = (await readFile('/stats.py')).toString()
const { execSync } = await import('child_process')
const { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } = await import('fs')
const { join } = await import('path')
const os = await import('os')

const tmpDir = mkdtempSync(join(os.tmpdir(), 'peercompute-'))
const scriptPath = join(tmpDir, 'stats.py')
writeFileSync(scriptPath, script)

const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const output = execSync('python3 "' + scriptPath + '"', {
  input: JSON.stringify(data),
  encoding: 'utf-8',
  timeout: 30000
})

unlinkSync(scriptPath)
rmdirSync(tmpDir)

return JSON.parse(output.trim())
