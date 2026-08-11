import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const dist = join(root, 'dist')

await mkdir(dist, { recursive: true })
await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  bundle: true,
  outfile: join(dist, 'main.js'),
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  define: {
    'import.meta.url': '__filename',
    __QQNT_BRIDGE_BUILD_DIST_DIR__: JSON.stringify(dist),
  },
})
await copyFile(require.resolve('silk-wasm/lib/silk.wasm'), join(dist, 'silk.wasm'))
