import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'

const enabled = process.env.QQNT_BRIDGE_E2E === '1'
const base = process.env.QQNT_BRIDGE_URL ?? 'http://127.0.0.1:18767/v1'
const token = process.env.QQNT_BRIDGE_TOKEN
const allowedDirect = '1715311957'
const allowedGroups = new Set(['1058754719', '1084013940'])

function headers(extra: Record<string, string> = {}) {
  return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }
}

async function resolve(kind: 'direct' | 'group', id: string) {
  if (kind === 'direct' && id !== allowedDirect) throw new Error(`E2E direct target is not allowed: ${id}`)
  if (kind === 'group' && !allowedGroups.has(id)) throw new Error(`E2E group target is not allowed: ${id}`)
  const response = await fetch(`${base}/conversations/resolve?kind=${kind}&id=${id}`, { headers: headers() })
  if (!response.ok) throw new Error(await response.text())
  return await response.json() as { id: string }
}

describe.skipIf(!enabled)('live QQNT bridge E2E', () => {
  it('sends and reads back private and group text messages only in the approved chats', async () => {
    for (const [kind, numericId] of [
      ['direct', allowedDirect],
      ['group', '1058754719'],
      ['group', '1084013940'],
    ] as const) {
      const conversation = await resolve(kind, numericId)
      const text = `[mtproto-relay e2e] ${new Date().toISOString()} ${kind}`
      const manifest = Buffer.from(JSON.stringify({ conversationId: conversation.id, text })).toString('base64url')
      let sent: Response | undefined
      let sentBody = ''
      for (let attempt = 0; attempt < 5; attempt++) {
        sent = await fetch(`${base}/messages`, {
          method: 'POST', headers: headers({ 'x-qqnt-manifest': manifest }), body: new Uint8Array(),
        })
        sentBody = await sent.text()
        if (sent.ok || !sentBody.includes('Invalid argument')) break
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      }
      expect(sent!.status, sentBody).toBe(200)
      const history = await fetch(`${base}/conversations/${encodeURIComponent(conversation.id)}/history?limit=20`, {
        headers: headers(),
      })
      expect(JSON.stringify(await history.json())).toContain(text)
    }
  }, 180_000)

  it('streams a PNG image to xuuuuan and returns a confirmed image element', async () => {
    const imagePath = new URL('../../mtproto-relay-cordis/packages/platform-static/src/test-image.png', import.meta.url)
    const image = await stat(imagePath)
    const conversation = await resolve('direct', allowedDirect)
    const manifest = Buffer.from(JSON.stringify({
      conversationId: conversation.id, media: [{
        kind: 'image', name: basename(imagePath.pathname), size: image.size, mimeType: 'image/png',
      }],
    })).toString('base64url')
    const sent = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: headers({ 'x-qqnt-manifest': manifest, 'content-length': String(image.size) }),
      body: createReadStream(imagePath) as never,
      duplex: 'half',
    } as RequestInit)
    const body = await sent.text()
    expect(sent.status, body).toBe(200)
    const message = JSON.parse(body) as { id: string, conversationId: string, parts: unknown[] }
    expect(message).toMatchObject({
      conversationId: conversation.id,
      parts: [{ type: 'media', media: { kind: 'image' } }],
    })
    const history = await fetch(`${base}/conversations/${encodeURIComponent(conversation.id)}/history?limit=20`, {
      headers: headers(),
    })
    expect(await history.text()).toContain(message.id)
  }, 180_000)

  it.runIf(Boolean(process.env.QQNT_BRIDGE_E2E_FILE))('streams a file to xuuuuan and downloads it by range', async () => {
    const path = process.env.QQNT_BRIDGE_E2E_FILE!
    const info = await stat(path)
    const conversation = await resolve('direct', allowedDirect)
    const manifest = Buffer.from(JSON.stringify({
      conversationId: conversation.id,
      media: [{ kind: 'file', name: basename(path), size: info.size }],
    })).toString('base64url')
    const sent = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: headers({ 'x-qqnt-manifest': manifest, 'content-length': String(info.size) }),
      body: createReadStream(path) as never,
      // Node fetch requires duplex for streaming request bodies.
      duplex: 'half',
    } as RequestInit)
    const body = await sent.text()
    expect(sent.status, body).toBe(200)
    const message = JSON.parse(body) as { parts: Array<{ type: string, media?: { locator: unknown } }> }
    const locator = message.parts.find((part) => part.type === 'media')?.media?.locator
    expect(locator).toBeTruthy()
    const downloaded = await fetch(`${base}/media/open`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json', 'x-qqnt-offset': '0', 'x-qqnt-limit': '4096' }),
      body: JSON.stringify(locator),
    })
    expect(downloaded.status).toBe(200)
    expect((await downloaded.arrayBuffer()).byteLength).toBe(Math.min(4096, info.size))
  }, 180_000)
})
