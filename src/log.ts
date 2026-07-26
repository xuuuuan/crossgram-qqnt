import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { inspect } from 'node:util'
import type { EventEmitter } from 'node:events'

export const logPath = process.env.QQNT_BRIDGE_LOG
  ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? homedir(), 'qqnt-bridge', 'qqnt-bridge.log')
    : join(homedir(), 'Library', 'Logs', 'qqnt-bridge.log'))

export const slowHttpLogPath = process.env.QQNT_BRIDGE_SLOW_HTTP_LOG
  ?? join(dirname(logPath), 'qqnt-bridge-slow-http.log')

const slowHttpKeys = new Map<string, Set<string>>()
const guardedConsoleStreams = new WeakSet<object>()
const rotatingLogSizes = new Map<string, number>()
const DEFAULT_LOG_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_LOG_BACKUPS = 3

// Electron keeps stdout/stderr inherited from the process that launched QQ.
// Once a short-lived launcher closes its pipe, console.* emits EPIPE on the
// stream. An unhandled stream error would otherwise surface as an uncaught
// exception in QQ's browser process.
export function guardConsoleStream(stream: Pick<EventEmitter, 'on'> | undefined): void {
  if (!stream || guardedConsoleStreams.has(stream)) return
  guardedConsoleStreams.add(stream)
  stream.on('error', () => {
    // File logging remains available; losing an optional console must never
    // destabilize the injected host process.
  })
}

guardConsoleStream(process.stdout)
guardConsoleStream(process.stderr)

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  brightCyan: '\u001b[96m',
} as const

export function log(level: 'info' | 'warn' | 'error', message: string, ...details: unknown[]): void {
  const rendered = [
    new Date().toISOString(),
    level.toUpperCase(),
    message,
    ...details.map((detail) => typeof detail === 'string' ? detail : inspect(detail, { depth: 8 })),
  ].join(' ')
  try {
    appendRotatingLog(logPath, `${rendered}\n`)
  } catch {
    // QQ logging must never make the host process fail.
  }
  const output = consoleOutput(level, message)
  try {
    if (level === 'error') console.error(output, ...details)
    else if (level === 'warn') console.warn(output, ...details)
    else console.log(output, ...details)
  } catch {
    // Some console implementations throw synchronously instead of emitting an
    // error event when their backing pipe has already closed.
  }
}

export function appendRotatingLog(path: string, content: string, options: {
  maxBytes?: number
  backups?: number
} = {}): void {
  const maxBytes = options.maxBytes ?? positiveInteger(process.env.QQNT_BRIDGE_LOG_MAX_BYTES)
    ?? DEFAULT_LOG_MAX_BYTES
  const backups = options.backups ?? positiveInteger(process.env.QQNT_BRIDGE_LOG_BACKUPS)
    ?? DEFAULT_LOG_BACKUPS
  const bytes = Buffer.byteLength(content, 'utf8')
  mkdirSync(dirname(path), { recursive: true })
  let size = rotatingLogSizes.get(path)
  if (size === undefined) {
    try {
      size = statSync(path).size
    } catch {
      size = 0
    }
  }
  if (size > 0 && size + bytes > maxBytes) {
    rotateLog(path, backups)
    size = 0
  }
  appendFileSync(path, content, 'utf8')
  rotatingLogSizes.set(path, size + bytes)
}

function rotateLog(path: string, backups: number): void {
  rotatingLogSizes.delete(path)
  if (backups <= 0) {
    removeIfExists(path)
    return
  }
  removeIfExists(`${path}.${backups}`)
  for (let index = backups - 1; index >= 1; index--) {
    renameIfExists(`${path}.${index}`, `${path}.${index + 1}`)
  }
  renameIfExists(path, `${path}.1`)
}

function renameIfExists(source: string, destination: string): void {
  try {
    renameSync(source, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function removeIfExists(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function consoleOutput(level: 'info' | 'warn' | 'error', message: string): string {
  const plain = `[qqnt-bridge] ${level.toUpperCase()} ${message}`
  if (!useConsoleColor()) return plain
  const levelColor = level === 'error' ? ANSI.red : level === 'warn' ? ANSI.yellow : ANSI.cyan
  const messageColor = message.startsWith('received message') ? `${ANSI.bold}${ANSI.brightCyan}` : ''
  return `${ANSI.dim}[qqnt-bridge]${ANSI.reset} ${levelColor}${level.toUpperCase()}${ANSI.reset} ${messageColor}${message}${messageColor ? ANSI.reset : ''}`
}

function useConsoleColor(): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.QQNT_BRIDGE_COLOR === '0') return false
  if (process.env.VITEST) return false
  return true
}

export function recordSlowHttpRequest(entry: {
  method: string
  target: string
  status: number
  durationMs: number
  completed: boolean
}, path = slowHttpLogPath): boolean {
  const route = normalizedHttpRoute(entry.target)
  const key = `${entry.method} ${route} status=${entry.status} completed=${entry.completed}`
  const keys = slowHttpKeysFor(path)
  if (keys.has(key)) return false
  keys.add(key)
  const line = JSON.stringify({
    firstSeen: new Date().toISOString(),
    key,
    route,
    ...entry,
  })
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${line}\n`)
  } catch {
    // Performance diagnostics must never make the host process fail.
  }
  return true
}

function slowHttpKeysFor(path: string): Set<string> {
  const cached = slowHttpKeys.get(path)
  if (cached) return cached
  const keys = new Set<string>()
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const value = JSON.parse(line) as { key?: unknown }
        if (typeof value.key === 'string') keys.add(value.key)
      } catch {
        // Keep valid records usable if a previous write was interrupted.
      }
    }
  } catch {
    // The file is expected not to exist on first launch.
  }
  slowHttpKeys.set(path, keys)
  return keys
}

function normalizedHttpRoute(target: string): string {
  try {
    const url = new URL(target, 'http://localhost')
    const segments = url.pathname.split('/').map((segment, index, all) => {
      if (index > 1 && (all[index - 1] === 'conversations' || all[index - 1] === 'users')) return ':id'
      return segment
    })
    const keys = [...new Set(url.searchParams.keys())].sort()
    return `${segments.join('/')}${keys.length ? `?${keys.join('&')}` : ''}`
  } catch {
    return target
  }
}
