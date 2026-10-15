import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dockerDir = join(root, 'deploy', 'docker')

const read = (name: string) => readFileSync(join(dockerDir, name), 'utf8')
const posix = (value: string) => value.replaceAll('\\', '/')

function writeExecutable(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

describe('Container image files', () => {
  it('keeps the container scripts valid POSIX shell', () => {
    for (const file of ['entrypoint.sh', 'qq-wrapper.sh']) {
      expect(() => execFileSync('sh', ['-n', join(dockerDir, file)]), file).not.toThrow()
    }
  })

  it('installs Linux QQ and the published injection in one pruned layer', () => {
    const dockerfile = read('Dockerfile')
    expect(dockerfile).toContain('FROM ubuntu:24.04')
    expect(dockerfile).toContain('ARG QQ_DEB_URL=https://qqdl.gtimg.cn/')
    expect(dockerfile).toContain('qqnt-bridge-linux-x64-release.tar.gz')
    expect(dockerfile).toContain('install -m 0644 /opt/qqnt-bridge/resources/app.asar /opt/QQ/resources/app.asar')
    expect(dockerfile).toContain('install -m 0755 /opt/qqnt-bridge/bin/qqntctl /usr/local/bin/qqntctl')
    expect(dockerfile).toContain('dbus-x11')
    expect(dockerfile).toContain('xvfb')
    expect(dockerfile).toContain('EXPOSE 18767')
    expect(dockerfile).toContain('USER qqnt')
    expect(dockerfile).toContain('HOME=/var/lib/qqnt-bridge')
    expect(dockerfile).not.toMatch(/QQNT_BRIDGE_TOKEN=/)

    // Later layers cannot shrink the image, so installs and every prune share
    // the same RUN; ALSA is explicit because the deb expects ffmpeg to pull it.
    const layer = dockerfile.slice(dockerfile.indexOf('RUN set -eux'), dockerfile.indexOf('\n\n', dockerfile.indexOf('RUN set -eux')))
    expect(layer).toContain('apt-get install -y --no-install-recommends /tmp/qq.deb')
    expect(layer).toContain('apt-cache show libasound2t64')
    for (const prune of [
      'rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/locale/* /usr/share/icons/*',
      'rm -f /opt/QQ/LICENSES.chromium.html',
      'rm -rf /opt/QQ/resources/app/avsdk',
      'rm -f /usr/lib/x86_64-linux-gnu/libLLVM.so.*',
      'rm -rf /usr/lib/x86_64-linux-gnu/dri',
    ]) {
      expect(layer, prune).toContain(prune)
    }
  })

  it('ships voice messages by default and keeps calls opt-in', () => {
    const dockerfile = read('Dockerfile')
    expect(dockerfile).toContain('ARG WITH_FFMPEG=1')
    expect(dockerfile).toContain('ARG WITH_AVSDK=0')
    // A headless, --disable-gpu QQ never loads the graphics stack.
    expect(dockerfile).not.toContain('WITH_MESA')
  })

  it('probes its own API with its own client', () => {
    const dockerfile = read('Dockerfile')
    // One source of truth for the health contract: the tool an operator uses.
    expect(dockerfile).toContain('HEALTHCHECK --interval=15s --timeout=10s --retries=20 --start-period=180s CMD ["qqntctl", "status"]')
    const entrypoint = read('entrypoint.sh')
    expect(entrypoint).toContain('QQNT_BRIDGE_ENV_FILE=${QQNT_BRIDGE_ENV_FILE:-$QQNT_BRIDGE_STATE_DIR/qqnt-bridge.env}')
    expect(readFileSync(join(root, 'deploy', 'qqntctl'), 'utf8')).toContain('"$base/v1/status"')
  })

  it('records the release it was built from', () => {
    const dockerfile = read('Dockerfile')
    expect(dockerfile).toContain('ARG QQNT_BRIDGE_VERSION=unknown')
    expect(dockerfile).toContain('> /opt/qqnt-bridge/VERSION')
    expect(dockerfile).toContain('> /opt/qqnt-bridge/SOURCE_URL')
    const entrypoint = read('entrypoint.sh')
    expect(entrypoint).toContain('QQNT_BRIDGE_RUNNER=${QQNT_BRIDGE_RUNNER:-/usr/local/libexec/qqnt-bridge/run-headless.sh}')
    expect(entrypoint).toContain('chmod 0600 "$QQNT_BRIDGE_ENV_FILE"')
  })

  it('seeds the bridge env file and hands over to the headless runner', () => {
    const temp = mkdtempSync(join(tmpdir(), 'qqnt-docker-entrypoint-'))
    const stateDir = posix(join(temp, 'state'))
    const calls = join(temp, 'calls')
    try {
      const qq = join(temp, 'qq')
      const runner = join(temp, 'runner')
      writeExecutable(qq, 'exit 0')
      writeExecutable(runner, 'printf \'runner\\n%s\\n\' "$HOME" > "$QQNT_TEST_CALLS"')

      execFileSync('sh', [join(dockerDir, 'entrypoint.sh')], {
        env: {
          ...process.env,
          PATH: `${posix(temp)}${delimiter}${posix(process.env.PATH ?? '')}`,
          QQNT_BINARY: posix(qq),
          QQNT_BRIDGE_RUNNER: posix(runner),
          QQNT_BRIDGE_STATE_DIR: stateDir,
          QQNT_BRIDGE_TOKEN: 'qqnt-token',
          QQNT_BRIDGE_PORT: '18767',
          QQNT_TEST_CALLS: calls,
        },
      })

      const envFile = readFileSync(join(temp, 'state', 'qqnt-bridge.env'), 'utf8')
      expect(envFile).toContain('QQNT_BRIDGE_HOST=0.0.0.0')
      expect(envFile).toContain('QQNT_BRIDGE_PORT=18767')
      expect(envFile).toContain('QQNT_BRIDGE_TOKEN=qqnt-token')
      expect(envFile).toContain('QQNT_BRIDGE_HEADLESS=1')
      expect(envFile).toContain(`QQNT_BINARY="${posix(qq)}"`)
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['runner', stateDir])
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('lets the release workflow publish the image from the tag it just released', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
    expect(workflow).toContain('images: ghcr.io/${{ github.repository }}')
    expect(workflow).toContain('packages: write')
    expect(workflow).toContain('context: deploy/docker')
    expect(workflow).toContain('QQNT_BRIDGE_VERSION=${{ github.ref_name }}')
    expect(workflow).toContain('releases/download/${{ github.ref_name }}/qqnt-bridge-linux-x64-release.tar.gz')
    expect(workflow).toContain('qq-deb-url')
    expect(workflow).toContain('QQ_DEB_URL=${{ inputs.qq-deb-url || vars.QQ_DEB_URL')
  })

  it('runs on release tags instead of every branch push', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
    const trigger = workflow.slice(0, workflow.indexOf('\npermissions:'))
    // A branch push must not start a release: the mirror rewrites the history
    // and force-pushes its default branch on every sync, which would rebuild
    // every version each time.
    expect(trigger).toContain('tags:')
    expect(trigger).not.toContain('branches:')
    expect(workflow).toContain('concurrency:')
  })

  it('gates publishing on a variable instead of a repository name', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
    // A fork has neither the variable nor the images, so it keeps publishing
    // under its own namespace.
    expect(workflow).toContain("vars.PUBLISH_IMAGES != 'false'")
    expect(workflow).not.toMatch(/if: github\.repository/)
    expect(workflow).not.toContain("'xuuuuan/crossgram-qqnt'")
  })
})
