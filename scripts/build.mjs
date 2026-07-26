import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, 'dist')

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
