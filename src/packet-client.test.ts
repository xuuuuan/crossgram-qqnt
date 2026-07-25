import { describe, expect, it, vi } from 'vitest'
import type { KernelMsgService } from './kernel-types.js'
import type { NativeRkey, PacketAddon } from './packet-addon.js'
import { QQPacketClient } from './packet-client.js'
import type { QQMediaLocator } from './protocol.js'

function fixture() {
  let now = 1_800_000_000_000
  let decoded: NativeRkey[] = [
    { value: '&rkey=private', ttlSeconds: '120', createdAt: now / 1_000, kind: 10 },
    { value: '&rkey=group', ttlSeconds: '60', createdAt: now / 1_000, kind: 20 },
  ]
  const send = vi.fn<(
    command: string, payload: Uint8Array,
  ) => Promise<unknown>>(async () => ({ result: 0, errMsg: '', rspbuffer: Buffer.from('response') }))
  const addon: PacketAddon = {
    sendPacket: vi.fn((sender, command, payload) => sender(command, payload)),
    encodeFetchRkeyRequest: vi.fn(() => ({
      command: 'OidbSvcTrpcTcp.0x9067_202', payload: Buffer.from('request'),
    })),
    decodeFetchRkeyResponse: vi.fn(() => decoded),
    refreshImageUrl: vi.fn((original, rkey) => {
      const url = new URL(original)
      url.searchParams.set('rkey', rkey.replace(/^&?rkey=/, ''))
      return url.toString()
    }),
    locateSendBinding: vi.fn(() => ({
      moduleBase: '0x180000000', anchorRva: 1, xrefRva: 2, functionRva: 3,
    })),
  }
  const msgService = {
    sendSsoCmdReqByContend: send,
  } as unknown as Pick<KernelMsgService, 'sendSsoCmdReqByContend'>
  const client = new QQPacketClient(msgService, { addon, now: () => now, timeoutMs: 100 })
  return {
    addon, client, send,
    advance(ms: number) { now += ms },
    setDecoded(value: NativeRkey[]) { decoded = value },
  }
}

function image(originImageUrl?: string): QQMediaLocator {
  return {
    messageId: 'message', elementId: 'element', chatType: 2, peerUid: 'group',
    kind: 'image', fileName: 'image.jpg', originImageUrl,
  }
}

describe('QQPacketClient', () => {
  it('uses private and group RKeys according to the QQ image appid', async () => {
    const f = fixture()
    await expect(f.client.getImageDirectUrl(image(
      'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=private&rkey=old',
    ))).resolves.toContain('rkey=private')
    await expect(f.client.getImageDirectUrl(image(
      'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=group&rkey=old',
    ))).resolves.toContain('rkey=group')

    expect(f.send).toHaveBeenCalledOnce()
    expect(f.send).toHaveBeenCalledWith('OidbSvcTrpcTcp.0x9067_202', Buffer.from('request'))
    expect(f.addon.locateSendBinding).toHaveBeenCalledOnce()
  })

  it('single-flights refreshes and expires the whole cache at the shortest TTL', async () => {
    const f = fixture()
    let resolve!: (value: unknown) => void
    f.send.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const url = image('https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=group')
    const pending = Array.from({ length: 8 }, () => f.client.getImageDirectUrl(url))
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    resolve({ rspbuffer: Buffer.from('response') })
    expect((await Promise.all(pending)).every((value) => value?.includes('rkey=group'))).toBe(true)

    // The shortest 60-second TTL has a 6-second safety window.
    f.advance(53_999)
    await f.client.getImageDirectUrl(url)
    expect(f.send).toHaveBeenCalledOnce()
    f.advance(2)
    await f.client.getImageDirectUrl(url)
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.addon.locateSendBinding).toHaveBeenCalledOnce()
  })

  it('accepts a direct Buffer response and refreshes zero-timestamp keys relative to now', async () => {
    const f = fixture()
    f.send.mockResolvedValue(Buffer.from('response'))
    f.setDecoded([{ value: '&rkey=group', ttlSeconds: '1', createdAt: 0, kind: 20 }])
    const locator = image('https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=group')
    await expect(f.client.getImageDirectUrl(locator)).resolves.toContain('rkey=group')
    f.advance(901)
    await f.client.getImageDirectUrl(locator)
    expect(f.send).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['QQ error result', { result: 7, errMsg: 'denied' }],
    ['missing response buffer', { result: 0 }],
    ['malformed response', null],
  ])('falls back cleanly for %s', async (_name, response) => {
    const f = fixture()
    f.send.mockResolvedValue(response)
    await expect(f.client.getImageDirectUrl(image(
      'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=group',
    ))).resolves.toBeUndefined()
  })

  it('does not load the addon or send without an original QQ image URL', async () => {
    const loadAddon = vi.fn<() => PacketAddon>()
    const client = new QQPacketClient({ sendSsoCmdReqByContend: vi.fn() }, { loadAddon })
    await expect(client.getImageDirectUrl(image())).resolves.toBeUndefined()
    await expect(client.getImageDirectUrl({
      ...image('https://example/image'), kind: 'file',
    })).resolves.toBeUndefined()
    expect(loadAddon).not.toHaveBeenCalled()
  })

  it('falls back when the QQ build has no packet sender or xref anchor', async () => {
    const f = fixture()
    const noSender = new QQPacketClient({}, { addon: f.addon })
    await expect(noSender.getImageDirectUrl(image(
      'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=group',
    ))).resolves.toBeUndefined()
    f.addon.locateSendBinding = vi.fn(() => { throw new Error('anchor missing') })
    const noAnchor = new QQPacketClient({ sendSsoCmdReqByContend: f.send }, { addon: f.addon })
    await expect(noAnchor.getImageDirectUrl(image(
      'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=group',
    ))).resolves.toBeUndefined()
    expect(f.send).not.toHaveBeenCalled()
  })
})
