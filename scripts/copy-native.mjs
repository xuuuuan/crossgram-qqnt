import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const artifacts = join(root, 'native', 'packet-addon', 'artifacts')
const binding = (await readdir(artifacts)).find((name) => name.endsWith('.node'))
if (!binding) throw new Error(`native packet addon was not built in ${artifacts}`)
await mkdir(join(root, 'dist'), { recursive: true })
const source = join(artifacts, binding)
const destination = join(root, 'dist', binding)
const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')
const current = await digest(destination).catch(() => undefined)
if (current !== await digest(source)) await copyFile(source, destination)
