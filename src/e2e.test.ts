import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const enabled = process.env.QQNT_BRIDGE_E2E === '1'
const base = process.env.QQNT_BRIDGE_URL ?? 'http://127.0.0.1:18767/v1'
const token = process.env.QQNT_BRIDGE_TOKEN
const allowedDirect = '2426125592'
const allowedGroups = new Set(['1084013940'])
const testPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

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
  it('returns the real QQ top message in dialogs instead of recent-contact abstract text', async () => {
    const dialogsResponse = await fetch(`${base}/dialogs?limit=20`, { headers: headers() })
    expect(dialogsResponse.status, await dialogsResponse.clone().text()).toBe(200)
    const page = await dialogsResponse.json() as {
      conversations: Array<{
        id: string
        lastMessage?: { id: string, parts: unknown[], senderId: string, timestamp: number, msgSeq?: string }
      }>
    }
    const dialog = page.conversations.find((item) => item.lastMessage)
    expect(dialog, 'expected at least one recent QQ conversation with a top message').toBeDefined()

    const messageResponse = await fetch(`${base}/messages/get`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ conversationId: dialog!.id, messageId: dialog!.lastMessage!.id }),
    })
    expect(messageResponse.status, await messageResponse.clone().text()).toBe(200)
    const actual = await messageResponse.json() as NonNullable<typeof dialog>['lastMessage']
    expect(dialog!.lastMessage).toEqual(actual)
  }, 30_000)

  it('exposes the current QQ nickname and a remote qlogo avatar URL', async () => {
    const statusResponse = await fetch(`${base}/status`, { headers: headers() })
    expect(statusResponse.status, await statusResponse.clone().text()).toBe(200)
    const status = await statusResponse.json() as { selfUid: string, selfUin: string }
    const userResponse = await fetch(`${base}/users/${encodeURIComponent(status.selfUid)}`, { headers: headers() })
    expect(userResponse.status, await userResponse.clone().text()).toBe(200)
    const user = await userResponse.json() as {
      id: string, numericId?: string, name: string
      avatar?: { locator: { avatarUin?: string } }
    }
    expect(user).toMatchObject({
      id: status.selfUid,
      numericId: status.selfUin,
      avatar: { locator: { avatarUin: status.selfUin } },
    })
    expect(user.name).not.toBe(status.selfUin)
    const directResponse = await fetch(`${base}/files/direct-url`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(user.avatar!.locator),
    })
    expect(directResponse.status, await directResponse.clone().text()).toBe(200)
    const { url } = await directResponse.json() as { url: string }
    expect(new URL(url).hostname).toBe('q1.qlogo.cn')
    const avatarResponse = await fetch(url)
    expect(avatarResponse.status).toBe(200)
    expect(new Uint8Array(await avatarResponse.arrayBuffer()).slice(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]))
  })

  it('refreshes a QQ image RKey through the native packet hook and supports CDN ranges', async () => {
    const response = await fetch(`${base}/files/direct-url`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        messageId: '7666383158988150809',
        elementId: '7666383158988150808',
        chatType: 2,
        peerUid: '1002974327',
        kind: 'image',
        fileName: 'A1A07C530F47B8C3946C881C509D4C22.jpg',
        fileSize: '164882',
        fileUuid: '',
        originImageUrl: '/download?appid=1407&fileid=EhSduvhPaULWrCWdqKW-X9MN8t6jsxiSiAog_wooqYPctLftlQMyBHByb2RQgL2jAVoQ5faoiM59PRBAPHo86fwa43oCYReCAQJuag&spec=0',
      }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const { url } = await response.json() as { url: string }
    const direct = new URL(url)
    expect(direct.origin).toBe('https://multimedia.nt.qq.com.cn')
    expect(direct.searchParams.get('rkey')).toBeTruthy()

    const range = await fetch(direct, { headers: { range: 'bytes=0-127' } })
    expect(range.status, await range.clone().text()).toBe(206)
    expect(range.headers.get('content-range')).toBe('bytes 0-127/164882')
    const bytes = new Uint8Array(await range.arrayBuffer())
    expect(bytes).toHaveLength(128)
    expect(bytes.slice(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]))
  }, 30_000)

  it('sends and reads back private and group text messages only in the approved chats', async () => {
    for (const [kind, numericId] of [
      ['direct', allowedDirect],
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

  it('shows the QQ users behind a reaction in an approved group', async () => {
    const conversation = await resolve('group', '1084013940')
    const catalogResponse = await fetch(`${base}/reactions/catalog`, { headers: headers() })
    expect(catalogResponse.status, await catalogResponse.clone().text()).toBe(200)
    const catalog = await catalogResponse.json() as { available: Array<{ key: string }> }
    expect(catalog.available.length).toBeGreaterThan(0)
    const reactionKey = catalog.available[0]!.key
    const text = `[mtproto-relay reaction actors e2e] ${new Date().toISOString()}`
    const manifest = Buffer.from(JSON.stringify({ conversationId: conversation.id, text })).toString('base64url')
    const sentResponse = await fetch(`${base}/messages`, {
      method: 'POST', headers: headers({ 'x-qqnt-manifest': manifest }), body: new Uint8Array(),
    })
    const sentBody = await sentResponse.text()
    expect(sentResponse.status, sentBody).toBe(200)
    const sent = JSON.parse(sentBody) as { id: string }
    const setResponse = await fetch(`${base}/messages/reactions`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ conversationId: conversation.id, messageId: sent.id, reactionKeys: [reactionKey] }),
    })
    expect(setResponse.status, await setResponse.clone().text()).toBe(200)

    let actorId: string | undefined
    for (let attempt = 0; attempt < 5 && !actorId; attempt++) {
      const response = await fetch(`${base}/messages/reactions?conversationId=${encodeURIComponent(conversation.id)}&messageId=${encodeURIComponent(sent.id)}`, {
        headers: headers(),
      })
      expect(response.status, await response.clone().text()).toBe(200)
      const state = await response.json() as {
        reactions: Array<{ key: string, recentActors?: Array<{ userId: string }> }>
      }
      actorId = state.reactions.find((item) => item.key === reactionKey)?.recentActors?.[0]?.userId
      if (!actorId) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
    expect(actorId).toBeTruthy()
    const userResponse = await fetch(`${base}/users/${encodeURIComponent(actorId!)}`, { headers: headers() })
    expect(userResponse.status, await userResponse.clone().text()).toBe(200)
    const actor = await userResponse.json() as {
      id: string, numericId?: string, name: string
      avatar?: { locator: { avatarUin?: string } }
    }
    expect(actor).toMatchObject({
      id: actorId,
      numericId: expect.any(String),
      avatar: { locator: { avatarUin: expect.any(String) } },
    })
    expect(actor.name).not.toBe(actor.numericId)
  }, 180_000)

  it('streams a PNG image to xuuuuan and returns a confirmed image element', async () => {
    const hashes = bufferHashes(testPng)
    const conversation = await resolve('direct', allowedDirect)
    const manifest = Buffer.from(JSON.stringify({
      conversationId: conversation.id, media: [{
        kind: 'image', name: 'qqnt-bridge-e2e.png', size: testPng.length, mimeType: 'image/png', ...hashes,
      }],
    })).toString('base64url')
    const sent = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: headers({ 'x-qqnt-manifest': manifest, 'content-length': String(testPng.length) }),
      body: Readable.from(testPng) as never,
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

  it('streams two PNG images to xuuuuan as one QQ message', async () => {
    const hashes = bufferHashes(testPng)
    const conversation = await resolve('direct', allowedDirect)
    const manifest = Buffer.from(JSON.stringify({
      conversationId: conversation.id,
      mediaFraming: 'length-prefixed-v1',
      media: [
        { kind: 'image', name: 'first-qqnt-bridge-e2e.png', size: testPng.length, mimeType: 'image/png', ...hashes },
        { kind: 'image', name: 'second-qqnt-bridge-e2e.png', size: testPng.length, mimeType: 'image/png', ...hashes },
      ],
    })).toString('base64url')
    const body = Readable.from((async function* () {
      for (let index = 0; index < 2; index++) {
        const header = Buffer.allocUnsafe(4)
        header.writeUInt32BE(testPng.length)
        yield header
        yield testPng
        yield Buffer.alloc(4)
      }
    })())
    const sent = await fetch(`${base}/messages`, {
      method: 'POST', headers: headers({ 'x-qqnt-manifest': manifest }), body: body as never, duplex: 'half',
    } as RequestInit)
    const responseBody = await sent.text()
    expect(sent.status, responseBody).toBe(200)
    const message = JSON.parse(responseBody) as { parts: Array<{ type: string }> }
    expect(message.parts.filter((part) => part.type === 'media')).toHaveLength(2)
  }, 180_000)

  it.runIf(Boolean(process.env.QQNT_BRIDGE_E2E_FILE))('streams a private file and resolves a ranged CDN direct URL', async () => {
    const path = process.env.QQNT_BRIDGE_E2E_FILE!
    const info = await stat(path)
    const hashes = await fileHashes(path)
    const conversation = await resolve('direct', allowedDirect)
    const manifest = Buffer.from(JSON.stringify({
      conversationId: conversation.id,
      media: [{ kind: 'file', name: basename(path), size: info.size, ...hashes }],
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
    const resolved = await fetch(`${base}/files/direct-url`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(locator),
    })
    expect(resolved.status, await resolved.clone().text()).toBe(200)
    const { url, expiresAt } = await resolved.json() as { url: string, expiresAt: number }
    expect(new URL(url).protocol).toMatch(/^https?:$/)
    expect(expiresAt).toBeGreaterThan(Date.now())
    const end = Math.min(info.size, 128) - 1
    const downloaded = await fetch(url, { headers: { range: `bytes=0-${end}` } })
    expect(downloaded.status, await downloaded.clone().text()).toBe(206)
    expect((await downloaded.arrayBuffer()).byteLength).toBe(end + 1)
  }, 180_000)
})

async function fileHashes(path: string | URL): Promise<{ md5: string, sha1: string, file10MMd5: string }> {
  const md5 = createHash('md5')
  const sha1 = createHash('sha1')
  const first10M = createHash('md5')
  let accepted = 0
  for await (const chunk of createReadStream(path)) {
    md5.update(chunk)
    sha1.update(chunk)
    if (accepted < 10 * 1024 * 1024) {
      const value = chunk.subarray(0, Math.min(chunk.length, 10 * 1024 * 1024 - accepted))
      first10M.update(value)
      accepted += value.length
    }
  }
  return { md5: md5.digest('hex'), sha1: sha1.digest('hex'), file10MMd5: first10M.digest('hex') }
}

function bufferHashes(value: Buffer): { md5: string, sha1: string, file10MMd5: string } {
  return {
    md5: createHash('md5').update(value).digest('hex'),
    sha1: createHash('sha1').update(value).digest('hex'),
    file10MMd5: createHash('md5').update(value.subarray(0, 10 * 1024 * 1024)).digest('hex'),
  }
}
