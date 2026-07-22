import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { inspect } from 'node:util'

export const logPath = process.env.QQNT_BRIDGE_LOG
  ?? join(homedir(), 'Library', 'Logs', 'qqnt-bridge.log')

export function log(level: 'info' | 'error', message: string, ...details: unknown[]): void {
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
  else console.log(output, ...details)
}
