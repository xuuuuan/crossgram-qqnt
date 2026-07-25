import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardConsoleStream, log, recordSlowHttpRequest } from './log.js'

describe('host-safe logging', () => {
  afterEach(() => vi.restoreAllMocks())

  it('absorbs asynchronous errors from an inherited console pipe', () => {
    const stream = new EventEmitter()
    guardConsoleStream(stream)
    guardConsoleStream(stream)

    expect(() => stream.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).not.toThrow()
    expect(stream.listenerCount('error')).toBe(1)
  })

  it('absorbs synchronous console write failures', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
    })

    expect(() => log('info', 'pipe is gone')).not.toThrow()
  })
})

describe('slow HTTP request records', () => {
  const paths: string[] = []
  afterEach(async () => Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

  it('deduplicates IDs and query values into one actionable route record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-bridge-slow-http-'))
    paths.push(directory)
    const path = join(directory, 'slow.log')

    expect(recordSlowHttpRequest({
      method: 'GET',
      target: '/v1/conversations/group-a/history?limit=51&beforeId=message-a',
      status: 200,
      durationMs: 700,
      completed: true,
    }, path)).toBe(true)
    expect(recordSlowHttpRequest({
      method: 'GET',
      target: '/v1/conversations/group-b/history?beforeId=message-b&limit=101',
      status: 200,
      durationMs: 900,
      completed: true,
    }, path)).toBe(false)

    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      route: '/v1/conversations/:id/history?beforeId&limit',
      durationMs: 700,
    })
  })
})
