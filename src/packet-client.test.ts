import { create, toBinary } from '@bufbuild/protobuf'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as generated from './generated/qqnt/packet_pb.js'
import type { KernelMsgService } from './kernel-types.js'
import type { NativeRkey, NativeSysFace, PacketAddon } from './packet-addon.js'
import { QQPacketClient } from './packet-client.js'
import type { QQMediaLocator } from './protocol.js'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function fixture() {
  let now = 1_800_000_000_000
  let decoded: NativeRkey[] = [
    { value: '&rkey=private', ttlSeconds: '120', createdAt: now / 1_000, kind: 10 },
    { value: '&rkey=group', ttlSeconds: '60', createdAt: now / 1_000, kind: 20 },
  ]
  let decodedSysFaces: NativeSysFace[] = [{
    faceId: '476', name: '/不是吧', url: 'https://face.qq.example/476.png',
    aniStickerType: 2, aniStickerPackId: 3, aniStickerId: 476, width: 240, height: 180,
  }]
  const send = vi.fn<(
    command: string, payload: Uint8Array,
  ) => Promise<unknown>>(async () => ({ result: 0, errMsg: '', rspbuffer: Buffer.from('response') }))
  const addon: PacketAddon = {
    sendPacket: vi.fn((sender, command, payload) => sender(command, payload)),
    encodeFetchRkeyRequest: vi.fn(() => ({
      command: 'OidbSvcTrpcTcp.0x9067_202', payload: Buffer.from('request'),
    })),
    decodeFetchRkeyResponse: vi.fn(() => decoded),
    encodeFetchSysFacesRequest: vi.fn(() => ({
      command: 'OidbSvcTrpcTcp.0x9154_1', payload: Buffer.from('sys-face-request'),
    })),
    decodeFetchSysFacesResponse: vi.fn(() => decodedSysFaces),
    encodeVideoDownloadRequest: vi.fn((chatType, peer, selfUid, fileUuid) => ({
      command: chatType === 2 ? 'OidbSvcTrpcTcp.0x11ea_200' : 'OidbSvcTrpcTcp.0x11e9_200',
      payload: Buffer.from(JSON.stringify({ peer, selfUid, fileUuid })),
    })),
    decodeVideoDownloadResponse: vi.fn(() => ({
      url: 'https://cdn.qq.example/video.mp4?token=fresh', ttlSeconds: 60, createdAt: now / 1_000,
    })),
    encodeGroupFileDownloadRequest: vi.fn((group, fileUuid) => ({
      command: 'OidbSvcTrpcTcp.0x6d6_2', payload: Buffer.from(JSON.stringify({ group, fileUuid })),
    })),
    decodeGroupFileDownloadResponse: vi.fn(() => ({
      url: 'https://cdn.qq.example/group-file?token=fresh', ttlSeconds: 300, createdAt: 0,
    })),
    encodePrivateFileDownloadRequest: vi.fn((selfUid, fileUuid, fileHash) => ({
      command: 'OidbSvcTrpcTcp.0xe37_1200', payload: Buffer.from(JSON.stringify({ selfUid, fileUuid, fileHash })),
    })),
    decodePrivateFileDownloadResponse: vi.fn(() => ({
      url: 'http://cdn.qq.example/private-file?token=fresh', ttlSeconds: 300, createdAt: 0,
    })),
    refreshImageUrl: vi.fn((original, rkey) => {
      const url = new URL(original)
      url.searchParams.set('rkey', rkey.replace(/^&?rkey=/, ''))
      return url.toString()
    }),
    probePacketBinding: vi.fn(() => ({
      moduleBase: '0x180000000', modulePath: '/qqnt/wrapper.node', profile: 'linux-xref-v1',
      buildId: 'build-id', sha256: 'sha256', nameSlotRva: '0x1', bindingNameRva: '0x2',
      bindingName: 'sendSsoCmdReqByContend', napiCallbackSlotRva: '0x3', napiCallbackRva: '0x4',
      napiCallbackFingerprint: 'fingerprint', responseActionSlotRva: '0x5', responseActionRva: '0x6',
      responseActionFingerprint: 'fingerprint', converterRva: '0x7', converterFingerprint: 'fingerprint',
      resolveActionRva: '0x8', resolveActionFingerprint: 'fingerprint',
    })),
    locateSendBinding: vi.fn(() => ({
      moduleBase: '0x180000000', profile: 'xref-v1', timeDateStamp: 0x1122_3344,
      sizeOfImage: 0x678000, anchorRva: 1, xrefRva: 2, functionRva: 3, converterRva: 4, responseRva: 5,
    })),
    installSendHook: vi.fn(() => ({
      moduleBase: '0x180000000', profile: 'xref-v1', timeDateStamp: 0x1122_3344,
      sizeOfImage: 0x678000, anchorRva: 1, xrefRva: 2, functionRva: 3, converterRva: 4, responseRva: 5,
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
    setDecodedSysFaces(value: NativeSysFace[]) { decodedSysFaces = value },
  }
}

function image(originImageUrl?: string): QQMediaLocator {
  return {
    messageId: 'message', elementId: 'element', chatType: 2, peerUid: 'group',
    kind: 'image', fileName: 'image.jpg', originImageUrl,
  }
}

describe('QQPacketClient', () => {
  beforeEach(() => {
    setPlatform('win32')
  })

  afterEach(() => {
    setPlatform(originalPlatform)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('uses private and group RKeys according to the QQ image appid', async () => {
    const f = fixture()
    await expect(f.client.getImageDirectUrl(image(
      '/download?appid=1406&fileid=private&rkey=old',
    ))).resolves.toContain('rkey=private')
    await expect(f.client.getImageDirectUrl(image(
      'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=group&rkey=old',
    ))).resolves.toContain('rkey=group')

    expect(f.send).toHaveBeenCalledOnce()
    expect(f.send).toHaveBeenCalledWith('OidbSvcTrpcTcp.0x9067_202', Buffer.from('request'))
    expect(f.addon.installSendHook).toHaveBeenCalledOnce()
    expect(f.addon.refreshImageUrl).toHaveBeenNthCalledWith(
      1,
      'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=private&rkey=old',
      '&rkey=private',
    )
  })

  it('selects QQ image quality through the native CDN spec before refreshing RKey', async () => {
    const f = fixture()
    const locator = image('/download?appid=1407&fileid=group&spec=0&rkey=old')
    locator.imageSpec = 720

    await expect(f.client.getImageDirectUrl(locator)).resolves.toContain('spec=720')
    expect(f.addon.refreshImageUrl).toHaveBeenCalledWith(
      'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=group&spec=720&rkey=old',
      '&rkey=group',
    )
  })

  it('publishes a preuploaded group file through OidbSvcTrpcTcp.0x6d9_4', async () => {
    const f = fixture()
    const body = toBinary(generated.GroupFileFeedResponseSchema, create(
      generated.GroupFileFeedResponseSchema,
      { result: { files: [{ fileUuid: 'file-uuid', busId: 102 }] } },
    ))
    const response = toBinary(generated.OidbEnvelopeSchema, create(
      generated.OidbEnvelopeSchema,
      { body },
    ))
    f.send.mockResolvedValue({ rspbuffer: Buffer.from(response) })

    await expect(f.client.publishGroupFile('1002974327', 'file-uuid'))
      .resolves.toEqual({ published: true })
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.send.mock.calls[0]?.[0]).toBe('OidbSvcTrpcTcp.0x6d9_4')
    expect(Buffer.from(f.send.mock.calls[0]![1]).includes(Buffer.from('file-uuid'))).toBe(true)
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
    expect(f.addon.installSendHook).toHaveBeenCalledOnce()
  })

  it('single-flights and caches the complete QQ system-face catalog', async () => {
    const f = fixture()
    let resolve!: (value: unknown) => void
    f.send.mockImplementationOnce(() => new Promise((done) => { resolve = done }))

    const pending = Array.from({ length: 8 }, () => f.client.getSysFace('476'))
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    resolve({ rspbuffer: Buffer.from('sys-face-response') })
    expect(await Promise.all(pending)).toEqual(Array(8).fill(expect.objectContaining({
      faceId: '476', name: '/不是吧', url: 'https://face.qq.example/476.png', width: 240, height: 180,
    })))
    expect(f.send).toHaveBeenCalledWith('OidbSvcTrpcTcp.0x9154_1', Buffer.from('sys-face-request'))
    expect(f.addon.decodeFetchSysFacesResponse).toHaveBeenCalledWith(Buffer.from('sys-face-response'))

    await expect(f.client.getSysFace('999')).resolves.toBeUndefined()
    expect(f.send).toHaveBeenCalledOnce()
  })

  it('rejects unusable QQ system-face catalogs without poisoning a later retry', async () => {
    const f = fixture()
    f.setDecodedSysFaces([])
    await expect(f.client.getSysFace('476')).rejects.toThrow('FetchSysFaces response was empty')
    f.setDecodedSysFaces([{
      faceId: '476', name: '/不是吧', url: 'https://face.qq.example/476.png',
      aniStickerType: 2, aniStickerPackId: 3, aniStickerId: 476, width: 240, height: 240,
    }])
    await expect(f.client.getSysFace('476')).resolves.toMatchObject({ faceId: '476' })
    expect(f.send).toHaveBeenCalledTimes(2)
  })

  it('returns the stable remote qlogo URL for avatars without loading the packet addon', async () => {
    const loadAddon = vi.fn<() => PacketAddon>()
    const client = new QQPacketClient({ sendSsoCmdReqByContend: vi.fn() }, { loadAddon })
    await expect(client.getMediaDirectUrl({
      messageId: 'avatar:user:uid', elementId: 'avatar:user:uid', chatType: 1, peerUid: 'uid',
      kind: 'image', fileName: '1715311957.jpg', avatarUin: '1715311957',
    }, 'self-uid')).resolves.toEqual({
      url: 'https://q1.qlogo.cn/g?b=qq&nk=1715311957&s=640',
      expiresAt: Number.MAX_SAFE_INTEGER,
    })
    expect(loadAddon).not.toHaveBeenCalled()
  })

  it('prefers a UID-scoped QQNT avatar URL over the legacy qlogo fallback', async () => {
    const loadAddon = vi.fn<() => PacketAddon>()
    const client = new QQPacketClient({ sendSsoCmdReqByContend: vi.fn() }, { loadAddon })
    await expect(client.getMediaDirectUrl({
      messageId: 'avatar:user:uid', elementId: 'avatar:user:uid', chatType: 1, peerUid: 'uid',
      kind: 'image', fileName: '472247053.jpg', avatarUin: '472247053',
      avatarUrl: 'https://thirdqq.qlogo.cn/avatar/uid/140',
    }, 'self-uid')).resolves.toEqual({
      url: 'https://thirdqq.qlogo.cn/avatar/uid/140',
      expiresAt: Number.MAX_SAFE_INTEGER,
    })
    expect(loadAddon).not.toHaveBeenCalled()
  })

  it('single-flights and caches packet-resolved video URLs for concurrent Telegram ranges', async () => {
    const f = fixture()
    let resolve!: (value: unknown) => void
    f.send.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const locator: QQMediaLocator = {
      messageId: 'video-message', elementId: 'video-element', chatType: 2, peerUid: '1002974327',
      kind: 'file', fileName: 'clip.mp4', fileUuid: 'video-uuid', videoCodecFormat: 0,
    }
    const pending = Array.from({ length: 8 }, () => f.client.getMediaDirectUrl(locator, 'self-uid'))
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    resolve({ rspbuffer: Buffer.from('video-response') })
    expect(await Promise.all(pending)).toEqual(Array(8).fill({
      url: 'https://cdn.qq.example/video.mp4?token=fresh', expiresAt: 1_800_000_054_000,
    }))
    expect(f.addon.encodeVideoDownloadRequest).toHaveBeenCalledOnce()
    expect(f.addon.encodeVideoDownloadRequest).toHaveBeenCalledWith(2, '1002974327', 'self-uid', 'video-uuid')
    expect(f.addon.decodeVideoDownloadResponse).toHaveBeenCalledWith(Buffer.from('video-response'))

    f.advance(53_999)
    await f.client.getMediaDirectUrl(locator, 'self-uid')
    expect(f.send).toHaveBeenCalledOnce()
    f.advance(2)
    await f.client.getMediaDirectUrl(locator, 'self-uid')
    expect(f.send).toHaveBeenCalledTimes(2)
  })

  it('selects group and private file URL protocols without using QQNT downloads', async () => {
    const f = fixture()
    const group: QQMediaLocator = {
      messageId: 'group-message', elementId: 'group-element', chatType: 2, peerUid: '1002974327',
      kind: 'file', fileName: 'group.bin', fileUuid: 'group-file-uuid',
    }
    const privateFile: QQMediaLocator = {
      messageId: 'private-message', elementId: 'private-element', chatType: 1, peerUid: 'friend-uid',
      kind: 'file', fileName: 'private.bin', fileUuid: 'private-file-uuid', file10MMd5: 'first-10m-md5',
    }

    await expect(f.client.getMediaDirectUrl(group, 'self-uid')).resolves.toMatchObject({
      url: 'https://cdn.qq.example/group-file?token=fresh',
    })
    await expect(f.client.getMediaDirectUrl(privateFile, 'self-uid')).resolves.toMatchObject({
      url: 'http://cdn.qq.example/private-file?token=fresh',
    })
    expect(f.addon.encodeGroupFileDownloadRequest).toHaveBeenCalledWith('1002974327', 'group-file-uuid')
    expect(f.addon.encodePrivateFileDownloadRequest).toHaveBeenCalledWith(
      'self-uid', 'private-file-uuid', 'first-10m-md5',
    )
    expect(f.send.mock.calls.map(([command]) => command)).toEqual([
      'OidbSvcTrpcTcp.0x6d6_2', 'OidbSvcTrpcTcp.0xe37_1200',
    ])
  })

  it('fails closed when a remote file has no direct-link identity', async () => {
    const f = fixture()
    await expect(f.client.getMediaDirectUrl({
      messageId: 'missing', elementId: 'missing', chatType: 2, peerUid: '1002974327',
      kind: 'file', fileName: 'missing.bin', filePath: 'C:\\QQ\\missing.bin',
    }, 'self-uid')).resolves.toBeUndefined()
    await expect(f.client.getMediaDirectUrl({
      messageId: 'private', elementId: 'private', chatType: 1, peerUid: 'friend',
      kind: 'file', fileName: 'private.bin', fileUuid: 'private-uuid',
    }, 'self-uid')).resolves.toBeUndefined()
    expect(f.send).not.toHaveBeenCalled()
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

  it('decodes rspbuffer when QQ also reports a non-zero convenience result', async () => {
    const f = fixture()
    f.send.mockResolvedValue({
      result: 145,
      errMsg: 'request parse failed',
      rspbuffer: Buffer.from('authoritative-response'),
    })

    await expect(f.client.getImageDirectUrl(image(
      '/download?appid=1407&fileid=group',
    ))).resolves.toContain('rkey=group')
    expect(f.addon.decodeFetchRkeyResponse).toHaveBeenCalledWith(Buffer.from('authoritative-response'))
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

  it('installs the hook and sends FetchRkey on Linux', async () => {
    setPlatform('linux')
    const f = fixture()

    await expect(f.client.getImageDirectUrl(image(
      'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=group',
    ))).resolves.toContain('rkey=group')

    expect(f.addon.installSendHook).toHaveBeenCalledOnce()
    expect(f.addon.encodeFetchRkeyRequest).toHaveBeenCalledOnce()
    expect(f.send).toHaveBeenCalledWith('OidbSvcTrpcTcp.0x9067_202', Buffer.from('request'))
  })

  it('falls back when the QQ build has no packet sender or xref anchor', async () => {
    const f = fixture()
    const noSender = new QQPacketClient({}, { addon: f.addon })
    await expect(noSender.getImageDirectUrl(image(
      'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=group',
    ))).resolves.toBeUndefined()
    f.addon.installSendHook = vi.fn(() => { throw new Error('anchor missing') })
    const noAnchor = new QQPacketClient({
      sendSsoCmdReqByContend: f.send as NonNullable<KernelMsgService['sendSsoCmdReqByContend']>,
    }, { addon: f.addon })
    await expect(noAnchor.getImageDirectUrl(image(
      'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=group',
    ))).resolves.toBeUndefined()
    expect(f.send).not.toHaveBeenCalled()
  })
})
