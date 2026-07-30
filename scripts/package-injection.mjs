import { createPackageWithOptions } from '@electron/asar'
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const mode = process.argv.find((argument) => argument.startsWith('--mode='))?.slice(7) ?? 'release'
if (mode !== 'release' && mode !== 'debug') throw new Error(`invalid package mode: ${mode}`)

const platform = process.platform === 'win32' ? 'windows' : process.platform
const arch = process.arch === 'x64' ? 'x64' : process.arch
const artifactDir = join(root, 'native', 'packet-addon', 'artifacts')
const addon = (await readdir(artifactDir).catch(() => [])).find((name) => name.endsWith('.node'))
if (!addon) throw new Error('native addon is missing; run pnpm build:native first')

const dist = join(root, 'dist')
const staging = join(dist, `.package-${platform}-${arch}-${mode}`)
const app = join(staging, 'app')
const payload = join(staging, 'payload')
const packageRoot = join(dist, 'packages')
const baseName = `qqnt-bridge-${platform}-${arch}-${mode}`
const archive = join(packageRoot, `${baseName}.tar.gz`)

await rm(staging, { recursive: true, force: true })
await mkdir(app, { recursive: true })
await mkdir(join(payload, 'resources'), { recursive: true })
await mkdir(join(payload, 'bin'), { recursive: true })
await mkdir(join(payload, 'systemd'), { recursive: true })
await mkdir(packageRoot, { recursive: true })

await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  bundle: true,
  outfile: join(app, 'main.cjs'),
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: mode === 'release',
  keepNames: mode === 'debug',
  sourcemap: mode === 'debug' ? 'inline' : false,
  legalComments: 'none',
  define: {
    'import.meta.url': '__filename',
    __QQNT_BRIDGE_BUILD_DIST_DIR__: 'undefined',
    __QQNT_BRIDGE_BUILD_MODE__: JSON.stringify(mode),
  },
})

await cp(join(artifactDir, addon), join(app, addon))
await writeFile(join(app, 'package.json'), `${JSON.stringify({
  name: 'qqnt-bridge-injection',
  version: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
  private: true,
  main: './loader.js',
}, null, 2)}\n`)
await cp(join(root, 'deploy', 'loader.cjs'), join(app, 'loader.js'))

const asarPath = join(payload, 'resources', 'app.asar')
await createPackageWithOptions(app, asarPath, { unpack: '*.node' })
await cp(join(root, 'deploy', 'qqntctl'), join(payload, 'bin', 'qqntctl'))
await cp(join(root, 'deploy', 'install.sh'), join(payload, 'bin', 'install.sh'))
await cp(join(root, 'deploy', 'run-headless.sh'), join(payload, 'bin', 'run-headless.sh'))
await cp(join(root, 'deploy', 'session-state.sh'), join(payload, 'bin', 'session-state.sh'))
await cp(join(root, 'deploy', 'qqnt-bridge.service'), join(payload, 'systemd', 'qqnt-bridge.service'))
await cp(join(root, 'deploy', 'README.md'), join(payload, 'README.md'))
await writeFile(join(payload, 'BUILD_MODE'), `${mode}\n`)

await rm(archive, { force: true })
await execFileAsync('tar', ['-czf', archive, '-C', payload, '.'])
await rm(staging, { recursive: true, force: true })
console.log(archive)
