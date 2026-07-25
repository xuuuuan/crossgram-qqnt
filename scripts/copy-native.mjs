import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const artifacts = join(root, 'native', 'packet-addon', 'artifacts')
const binding = (await readdir(artifacts)).find((name) => name.endsWith('.node'))
if (!binding) throw new Error(`native packet addon was not built in ${artifacts}`)
await mkdir(join(root, 'dist'), { recursive: true })
await copyFile(join(artifacts, binding), join(root, 'dist', binding))
