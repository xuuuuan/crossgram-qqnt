import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

describe('Linux deployment files', () => {
  it('keeps installer and control scripts valid POSIX shell', () => {
    for (const file of ['install.sh', 'qqntctl', 'run-headless.sh']) {
      expect(() => execFileSync('sh', ['-n', join(root, 'deploy', file)]), file).not.toThrow()
    }
  })

  it('uses an unprivileged systemd service with Xvfb and localhost defaults', () => {
    const unit = readFileSync(join(root, 'deploy', 'qqnt-bridge.service'), 'utf8')
    expect(unit).toContain('User=qqnt-bridge')
    expect(unit).toContain('/usr/local/libexec/qqnt-bridge/run-headless.sh')
    expect(unit).not.toContain('/opt/QQ/qq')
    expect(unit).toContain('ProtectSystem=full')
    expect(unit).toContain('RuntimeMaxSec=7d')
    expect(unit).toContain('MemoryMax=800M')
    const launcher = readFileSync(join(root, 'deploy', 'run-headless.sh'), 'utf8')
    expect(launcher).toContain('Xvfb "$display" -screen 0 1280x720x24 -nolisten tcp')
    expect(launcher).toContain('dbus-run-session -- "$QQNT_BINARY"')
    const installer = readFileSync(join(root, 'deploy', 'install.sh'), 'utf8')
    expect(installer).toContain('QQNT_BRIDGE_HOST:-127.0.0.1')
    expect(installer).toContain('QQNT_BRIDGE_AUTO_LOGIN=1')
    expect(installer).toContain('QQNT_BRIDGE_HEADLESS=1')
    expect(installer).toContain('systemctl restart qqnt-bridge.service')
    expect(installer).toContain('/usr/local/libexec/qqnt-bridge/install.sh')
    expect(installer).toContain('QQNT_BINARY=/absolute/path/to/qq')
    expect(installer).toContain('command -v dnf')
    expect(installer).toContain('command -v pacman')
    expect(installer).toContain('command -v zypper')
  })

  it('finds a standard QQ tree and accepts an explicit custom executable', () => {
    const temp = mkdtempSync(join(tmpdir(), 'qqnt-resolve-'))
    const standard = join(temp, 'opt', 'QQ', 'qq')
    const custom = join(temp, 'custom QQ', 'qq')
    try {
      mkdirSync(join(temp, 'opt', 'QQ'), { recursive: true })
      mkdirSync(join(temp, 'custom QQ'), { recursive: true })
      writeFileSync(standard, '#!/bin/sh\n')
      writeFileSync(custom, '#!/bin/sh\n')
      chmodSync(standard, 0o755)
      chmodSync(custom, 0o755)
      const script = join(root, 'deploy', 'install.sh')
      const detected = execFileSync('sh', [script], {
        encoding: 'utf8',
        env: { ...process.env, QQNT_BRIDGE_RESOLVE_ONLY: '1', QQNT_SEARCH_ROOT: temp },
      }).trim()
      expect(detected.replaceAll('\\', '/')).toBe(standard.replaceAll('\\', '/'))
      const explicit = execFileSync('sh', [script], {
        encoding: 'utf8',
        env: { ...process.env, QQNT_BRIDGE_RESOLVE_ONLY: '1', QQNT_BINARY: custom },
      }).trim()
      expect(explicit.replaceAll('\\', '/')).toBe(custom.replaceAll('\\', '/'))
      expect(() => execFileSync('sh', [script], {
        env: { ...process.env, QQNT_BRIDGE_RESOLVE_ONLY: '1', QQNT_SEARCH_ROOT: join(temp, 'missing') },
      })).toThrow()
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('runs the packaged installer for in-place updates', () => {
    const temp = mkdtempSync(join(tmpdir(), 'qqntctl-update-'))
    const envFile = join(temp, 'bridge.env')
    const updater = join(temp, 'installer.sh')
    const marker = join(temp, 'updated')
    try {
      writeFileSync(envFile, 'QQNT_BRIDGE_TOKEN=test-token\n')
      writeFileSync(updater, '#!/bin/sh\nprintf \'%s\' "$QQNT_BRIDGE_MODE" > "$QQNT_BRIDGE_UPDATE_MARKER"\n')
      chmodSync(updater, 0o755)
      execFileSync('sh', [join(root, 'deploy', 'qqntctl'), 'update', 'debug'], {
        env: {
          ...process.env,
          QQNT_BRIDGE_ENV_FILE: envFile,
          QQNT_BRIDGE_INSTALLER: updater,
          QQNT_BRIDGE_UPDATE_MARKER: marker,
        },
      })
      expect(readFileSync(marker, 'utf8')).toBe('debug')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
