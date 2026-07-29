import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
    expect(unit).toContain('ProtectSystem=full')
    const installer = readFileSync(join(root, 'deploy', 'install.sh'), 'utf8')
    expect(installer).toContain('QQNT_BRIDGE_HOST:-127.0.0.1')
    expect(installer).toContain('QQNT_BRIDGE_AUTO_LOGIN=1')
  })
})
