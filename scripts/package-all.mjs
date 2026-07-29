import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const run = promisify(execFile)
for (const mode of ['release', 'debug']) {
  const { stdout } = await run(process.execPath, [join(root, 'scripts', 'package-injection.mjs'), `--mode=${mode}`], {
    cwd: root,
  })
  process.stdout.write(stdout)
}
