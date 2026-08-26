import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('embedded packet addon bundle e2e', () => {
  it('extracts the esbuild-embedded binary and loads it across the N-API boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qqnt-packet-bundle-e2e-'))
    let materializedDirectory: string | undefined
    try {
      const artifactDirectory = resolve('native/packet-addon/artifacts')
      const artifactName = (await readdir(artifactDirectory)).find((name) => name.endsWith('.node'))
      if (!artifactName) throw new Error('native packet addon artifact is missing')
      const artifact = await readFile(join(artifactDirectory, artifactName))
      const sha256 = createHash('sha256').update(artifact).digest('hex')
      const bundle = join(root, 'packet-addon.cjs')
      await build({
        entryPoints: [resolve('src/packet-addon.ts')],
        bundle: true,
        outfile: bundle,
        platform: 'node',
        target: 'node22',
        format: 'cjs',
        define: {
          'import.meta.url': '__filename',
          __QQNT_BRIDGE_BUILD_DIST_DIR__: 'undefined',
          __QQNT_BRIDGE_EMBEDDED_PACKET_ADDON_BASE64__: JSON.stringify(artifact.toString('base64')),
          __QQNT_BRIDGE_EMBEDDED_PACKET_ADDON_FILENAME__: JSON.stringify(artifactName),
          __QQNT_BRIDGE_EMBEDDED_PACKET_ADDON_SHA256__: JSON.stringify(sha256),
        },
      })
      const runner = join(root, 'runner.cjs')
      await writeFile(runner, `delete process.env.QQNT_BRIDGE_PACKET_ADDON;
const bridge = require(${JSON.stringify(bundle)});
const candidate = bridge.packetAddonCandidates()[0];
const addon = bridge.loadPacketAddon();
const request = addon.encodeFetchRkeyRequest();
process.stdout.write(JSON.stringify({ candidate, command: request.command, payload: request.payload.toString('hex') }));
`)
      const executed = await execFileAsync(process.execPath, [runner])
      const result = JSON.parse(executed.stdout) as { candidate: string, command: string, payload: string }
      materializedDirectory = dirname(result.candidate)

      expect(result.candidate).toContain(join('qqnt-bridge-packet-addons', sha256, artifactName))
      expect(createHash('sha256').update(await readFile(result.candidate)).digest('hex')).toBe(sha256)
      expect(result.command).toBe('OidbSvcTrpcTcp.0x9067_202')
      expect(result.payload).toBe(
        '08e7a00210ca01221c0a130a05080110ca011206a80602b006011a02080222050a030a14026001',
      )
    } finally {
      if (materializedDirectory) await rm(materializedDirectory, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  })
})
