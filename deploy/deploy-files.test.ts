import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

describe('Linux deployment files', () => {
  it('keeps installer and control scripts valid POSIX shell', () => {
    for (const file of ['install.sh', 'qqntctl', 'run-headless.sh', 'session-state.sh']) {
      expect(() => execFileSync('sh', ['-n', join(root, 'deploy', file)]), file).not.toThrow()
    }
  })

  it('runs updates from a temporary installer copy and removes it afterwards', () => {
    const temp = mkdtempSync(join(tmpdir(), 'qqnt-update-bootstrap-'))
    const envFile = join(temp, 'bridge.env')
    const installer = join(temp, 'install.sh')
    const marker = join(temp, 'installer-path')
    try {
      writeFileSync(envFile, 'QQNT_BRIDGE_TOKEN=test-token\n')
      writeFileSync(installer, '#!/bin/sh\nprintf \'%s\n\' "$0" > "$QQNT_INSTALLER_MARKER"\n')
      chmodSync(installer, 0o755)
      execFileSync('sh', [join(root, 'deploy', 'qqntctl'), 'update'], {
        env: {
          ...process.env,
          QQNT_BRIDGE_ENV_FILE: envFile,
          QQNT_BRIDGE_INSTALLER: installer,
          QQNT_INSTALLER_MARKER: marker,
          TMPDIR: temp,
        },
      })
      const executed = readFileSync(marker, 'utf8').trim()
      expect(executed).not.toBe(installer)
      expect(executed).toContain('qqnt-bridge-installer.')
      expect(existsSync(executed)).toBe(false)
    } finally {
      rmSync(temp, { recursive: true, force: true })
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
    expect(installer).toContain('pre-update.')
    expect(installer).toContain('session-state.sh restore')
    expect(installer).toContain('for helper in "$tmp/bridge/bin/"*')
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

  it('launches a custom QQ path through portable Xvfb and D-Bus helpers', () => {
    const temp = mkdtempSync(join(tmpdir(), 'qqnt-launch-'))
    const qq = join(temp, 'custom QQ', 'qq')
    const marker = join(temp, 'qq-arguments')
    try {
      mkdirSync(join(temp, 'custom QQ'), { recursive: true })
      writeFileSync(join(temp, 'Xvfb'), '#!/bin/sh\ntrap \'exit 0\' TERM INT\nwhile :; do sleep 1; done\n')
      writeFileSync(join(temp, 'dbus-run-session'), '#!/bin/sh\n[ "$1" = -- ] && shift\nexec "$@"\n')
      writeFileSync(qq, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$QQNT_LAUNCH_MARKER"\n')
      for (const file of ['Xvfb', 'dbus-run-session', join('custom QQ', 'qq')]) chmodSync(join(temp, file), 0o755)
      execFileSync('sh', [join(root, 'deploy', 'run-headless.sh')], {
        env: {
          ...process.env,
          PATH: `${temp}${delimiter}${process.env.PATH ?? ''}`,
          QQNT_BINARY: qq,
          QQNT_LAUNCH_MARKER: marker,
        },
        timeout: 5_000,
      })
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual([
        '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      ])
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

  it('restores one last-known-good session when the first headless login does not become ready', () => {
    const temp = mkdtempSync(join(tmpdir(), 'qqnt-session-recovery-'))
    const qq = join(temp, 'qq')
    const launches = join(temp, 'launches')
    const stateCalls = join(temp, 'session-state-calls')
    try {
      writeFileSync(join(temp, 'Xvfb'), '#!/bin/sh\ntrap \'exit 0\' TERM INT\nwhile :; do sleep 1; done\n')
      writeFileSync(join(temp, 'dbus-run-session'), '#!/bin/sh\n[ "$1" = -- ] && shift\nexec "$@"\n')
      writeFileSync(qq, '#!/bin/sh\ncount=0\n[ ! -f "$QQNT_LAUNCHES" ] || count=$(cat "$QQNT_LAUNCHES")\ncount=$((count + 1))\nprintf \'%s\' "$count" > "$QQNT_LAUNCHES"\nif [ "$count" -eq 1 ]; then trap \'exit 0\' TERM INT; while :; do sleep 1; done; else sleep 2; fi\n')
      writeFileSync(join(temp, 'curl'), '#!/bin/sh\ncount=0\n[ ! -f "$QQNT_LAUNCHES" ] || count=$(cat "$QQNT_LAUNCHES")\nif [ "$count" -ge 2 ]; then printf \'{"ready":true}\n\'; else printf \'{"ready":false}\n\'; fi\n')
      writeFileSync(join(temp, 'session-state'), '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$QQNT_SESSION_CALLS"\ncase "$1" in has-lkg) exit 0;; esac\n')
      for (const file of ['Xvfb', 'dbus-run-session', 'qq', 'curl', 'session-state']) {
        chmodSync(join(temp, file), 0o755)
      }
      execFileSync('sh', [join(root, 'deploy', 'run-headless.sh')], {
        env: {
          ...process.env,
          PATH: `${temp}${delimiter}${process.env.PATH ?? ''}`,
          QQNT_BINARY: qq,
          QQNT_BRIDGE_TOKEN: 'test-token',
          QQNT_BRIDGE_SESSION_TOOL: join(temp, 'session-state'),
          QQNT_BRIDGE_CURL: join(temp, 'curl'),
          QQNT_BRIDGE_SESSION_READY_TIMEOUT_SECONDS: '3',
          QQNT_BRIDGE_SESSION_STABILIZE_SECONDS: '0',
          QQNT_LAUNCHES: launches,
          QQNT_SESSION_CALLS: stateCalls,
        },
        timeout: 15_000,
      })
      expect(readFileSync(launches, 'utf8')).toBe('2')
      expect(readFileSync(stateCalls, 'utf8').trim().split('\n')).toEqual([
        'has-lkg', 'restore-lkg', 'save-lkg',
      ])
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('snapshots and restores only QQNT login state', () => {
    const temp = mkdtempSync(join(tmpdir(), 'qqnt-session-state-'))
    const state = join(temp, 'state')
    const config = join(state, '.config', 'qqnt-bridge-injection')
    const archive = join(state, 'backups', 'session', 'manual.tar.gz')
    const shellArchive = archive.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
    const script = join(root, 'deploy', 'session-state.sh')
    try {
      mkdirSync(join(config, 'auth'), { recursive: true })
      mkdirSync(join(config, 'global', 'nt_data', 'Login'), { recursive: true })
      mkdirSync(join(config, 'global', 'nt_data', 'mmkv'), { recursive: true })
      mkdirSync(join(config, 'global', 'nt_data', 'nt_db'), { recursive: true })
      mkdirSync(join(config, 'global', 'nt_data', 'Emoji'), { recursive: true })
      writeFileSync(join(config, 'auth', 'login.enc'), 'ticket-before')
      writeFileSync(join(config, 'global', 'nt_data', 'Login', '.10001'), '')
      writeFileSync(join(config, 'global', 'nt_data', 'mmkv', 'global'), 'switch-before')
      writeFileSync(join(config, 'global', 'nt_data', 'nt_db', 'login.db'), 'db-before')
      writeFileSync(join(config, 'global', 'nt_data', 'nt_db', 'login.db-wal'), 'wal-before')
      writeFileSync(join(config, 'global', 'nt_data', 'Emoji', 'cache'), 'leave-me')
      execFileSync('sh', [script, 'save', shellArchive], {
        env: { ...process.env, QQNT_BRIDGE_STATE_DIR: state },
      })

      rmSync(join(config, 'auth'), { recursive: true, force: true })
      rmSync(join(config, 'global', 'nt_data', 'Login'), { recursive: true, force: true })
      writeFileSync(join(config, 'global', 'nt_data', 'mmkv', 'global'), 'switch-after')
      writeFileSync(join(config, 'global', 'nt_data', 'nt_db', 'login.db'), 'db-after')
      execFileSync('sh', [script, 'restore', shellArchive], {
        env: { ...process.env, QQNT_BRIDGE_STATE_DIR: state },
      })

      expect(readFileSync(join(config, 'auth', 'login.enc'), 'utf8')).toBe('ticket-before')
      expect(readFileSync(join(config, 'global', 'nt_data', 'mmkv', 'global'), 'utf8')).toBe('switch-before')
      expect(readFileSync(join(config, 'global', 'nt_data', 'nt_db', 'login.db'), 'utf8')).toBe('db-before')
      expect(readFileSync(join(config, 'global', 'nt_data', 'nt_db', 'login.db-wal'), 'utf8')).toBe('wal-before')
      expect(readFileSync(join(config, 'global', 'nt_data', 'Emoji', 'cache'), 'utf8')).toBe('leave-me')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('switches accounts without the bridge API and prints the new terminal QR', () => {
    const temp = mkdtempSync(join(tmpdir(), 'qqntctl-logout-'))
    const envFile = join(temp, 'bridge.env')
    const state = join(temp, 'state')
    const authDir = join(state, '.config', 'qqnt-bridge-injection', 'auth')
    const systemctlMarker = join(temp, 'systemctl-calls')
    const qrMarker = join(temp, 'qr-input')
    try {
      mkdirSync(authDir, { recursive: true })
      writeFileSync(join(authDir, 'login.enc'), 'encrypted-ticket')
      writeFileSync(join(authDir, 'login.enc-wal'), 'ticket-wal')
      mkdirSync(join(state, 'backups', 'session'), { recursive: true })
      writeFileSync(join(state, 'backups', 'session', 'last-known-good.tar.gz'), 'session-snapshot')
      writeFileSync(envFile, 'QQNT_BRIDGE_TOKEN=test-token\n')
      writeFileSync(join(temp, 'systemctl'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$QQNT_SYSTEMCTL_MARKER"\n')
      writeFileSync(join(temp, 'curl'), '#!/bin/sh\ncase "$*" in *qrcode/url*) printf \'https://qr.test/new-account\\n\';; esac\n')
      writeFileSync(join(temp, 'qrencode'), '#!/bin/sh\ncat > "$QQNT_QR_MARKER"\n')
      for (const command of ['systemctl', 'curl', 'qrencode']) chmodSync(join(temp, command), 0o755)
      execFileSync('sh', [join(root, 'deploy', 'qqntctl'), 'logout'], {
        env: {
          ...process.env,
          PATH: `${temp}${delimiter}${process.env.PATH ?? ''}`,
          QQNT_BRIDGE_ENV_FILE: envFile,
          QQNT_BRIDGE_STATE_DIR: state,
          QQNT_BRIDGE_SYSTEMCTL: join(temp, 'systemctl'),
          QQNT_BRIDGE_CURL: join(temp, 'curl'),
          QQNT_BRIDGE_QRENCODE: join(temp, 'qrencode'),
          QQNT_SYSTEMCTL_MARKER: systemctlMarker,
          QQNT_QR_MARKER: qrMarker,
        },
        timeout: 5_000,
      })
      expect(readFileSync(systemctlMarker, 'utf8').trim().split('\n')).toEqual([
        'stop qqnt-bridge.service', 'start qqnt-bridge.service',
      ])
      expect(readFileSync(qrMarker, 'utf8')).toBe('https://qr.test/new-account\n')
      expect(readdirSync(authDir)).toEqual([])
      const backups = readdirSync(join(state, 'backups', 'login')).sort()
      expect(backups).toHaveLength(3)
      expect(backups).toEqual(expect.arrayContaining([
        expect.stringMatching(/^login\.enc\.\d{8}-\d{6}-\d+$/),
        expect.stringMatching(/^login\.enc-wal\.\d{8}-\d{6}-\d+$/),
        expect.stringMatching(/^session\.last-known-good\.\d{8}-\d{6}-\d+\.tar\.gz$/),
      ]))
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
