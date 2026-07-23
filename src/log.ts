import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { inspect } from 'node:util'

export const logPath = process.env.QQNT_BRIDGE_LOG
  ?? join(homedir(), 'Library', 'Logs', 'qqnt-bridge.log')

export const slowHttpLogPath = process.env.QQNT_BRIDGE_SLOW_HTTP_LOG
  ?? join(dirname(logPath), 'qqnt-bridge-slow-http.log')

const slowHttpKeys = new Map<string, Set<string>>()

export function log(level: 'info' | 'warn' | 'error', message: string, ...details: unknown[]): void {
  const rendered = [
    new Date().toISOString(),
    level.toUpperCase(),
    message,
    ...details.map((detail) => typeof detail === 'string' ? detail : inspect(detail, { depth: 8 })),
  ].join(' ')
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${rendered}\n`)
  } catch {
    // QQ logging must never make the host process fail.
  }
  const output = `[qqnt-bridge] ${message}`
  if (level === 'error') console.error(output, ...details)
  else if (level === 'warn') console.warn(output, ...details)
  else console.log(output, ...details)
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
