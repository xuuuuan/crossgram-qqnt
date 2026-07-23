import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordSlowHttpRequest } from './log.js'

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
