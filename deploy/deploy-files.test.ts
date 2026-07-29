import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

describe('Linux deployment files', () => {
  it('keeps installer and control scripts valid POSIX shell', () => {
    for (const file of ['install.sh', 'qqntctl']) {
      expect(() => execFileSync('sh', ['-n', join(root, 'deploy', file)]), file).not.toThrow()
    }
  })

  it('uses an unprivileged systemd service with Xvfb and localhost defaults', () => {
    const unit = readFileSync(join(root, 'deploy', 'qqnt-bridge.service'), 'utf8')
    expect(unit).toContain('User=qqnt-bridge')
    expect(unit).toContain('/usr/bin/xvfb-run')
    expect(unit).toContain('--server-args="-screen 0 1280x720x24 -nolisten tcp"')
    expect(unit).toContain('ProtectSystem=full')
    expect(unit).toContain('RuntimeMaxSec=7d')
    expect(unit).toContain('MemoryMax=800M')
    const installer = readFileSync(join(root, 'deploy', 'install.sh'), 'utf8')
    expect(installer).toContain('QQNT_BRIDGE_HOST:-127.0.0.1')
    expect(installer).toContain('QQNT_BRIDGE_AUTO_LOGIN=1')
    expect(installer).toContain('QQNT_BRIDGE_HEADLESS=1')
    expect(installer).toContain('systemctl restart qqnt-bridge.service')
    expect(installer).toContain('/usr/local/libexec/qqnt-bridge/install.sh')
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
