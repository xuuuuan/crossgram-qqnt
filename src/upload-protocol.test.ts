import { createHash } from 'node:crypto'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'
import * as generated from './generated/qqnt/packet_pb.js'
import type { KernelMsgService } from './kernel-types.js'
import type { PacketAddon } from './packet-addon.js'
import { QQPacketClient } from './packet-client.js'
import {
  decodeDirectMessageResponse, decodeGroupFileFeedResponse, decodeHighwayResponse, decodeHighwaySessionResponse,
  decodeImageUploadResponse, decodeFileUploadResponse, decodePrivateFileMetadataResponse, decodeVideoUploadResponse,
  encodeDirectMessageRequest, encodeFileUploadRequest, encodeGroupFileFeedRequest, encodeHighwayFrame,
  encodeHighwaySessionRequest, encodeImageUploadRequest, encodePrivateFileMetadataRequest,
  encodeVideoHighwayExt, encodeVideoUploadRequest,
  HIGHWAY_BLOCK_SIZE, QQMediaUploadRejectedError, QQMessageSendRejectedError, VIDEO_THUMBNAIL_BYTES,
  VIDEO_THUMBNAIL_HEIGHT, VIDEO_THUMBNAIL_MD5, VIDEO_THUMBNAIL_SHA1, VIDEO_THUMBNAIL_WIDTH,
} from './upload-protocol.js'

describe('direct QQ upload protocol', () => {
  it('encodes private and group image preflight requests with hashes and dimensions', () => {
    const spec = {
      name: 'photo.png', size: 1234,
      md5: '00112233445566778899aabbccddeeff',
      sha1: '00112233445566778899aabbccddeeff00112233',
      width: 640, height: 480, picType: 1001,
    }
    const direct = encodeImageUploadRequest(1, 'u_friend', spec)
    const group = encodeImageUploadRequest(2, '1002974327', spec)
    expect(direct.command).toBe('OidbSvcTrpcTcp.0x11c5_100')
    expect(group.command).toBe('OidbSvcTrpcTcp.0x11c4_100')
    expect(direct.payload.includes(Buffer.from(spec.md5.toUpperCase()))).toBe(true)
    expect(direct.payload.includes(Buffer.from(spec.sha1.toUpperCase()))).toBe(true)
    expect(direct.payload.includes(Buffer.from('u_friend'))).toBe(true)
    expect(group.payload.includes(Buffer.from('u_friend'))).toBe(false)

    const favorite = encodeImageUploadRequest(1, 'u_friend', { ...spec, picSubType: 1 })
    const envelope = fromBinary(generated.OidbEnvelopeSchema, favorite.payload)
    const decoded = fromBinary(generated.ImageUploadRequestSchema, envelope.body)
    expect(decoded.upload?.message?.picture).toMatchObject({
      subtype: 1, summary: '[图片]', c2c: { subtype: 1 },
    })
    expect(decoded.upload?.message?.picture?.group).toBeUndefined()
  })

  it('decodes Highway tickets, upload servers, fast-upload UUIDs, and protocol failures', () => {
    const session = pb([field(0x501, pb([
      field(1, Buffer.from('ticket')),
      field(3, pb([u(1, 1), field(2, pb([fixed(2, 0x0100007f), u(3, 8080)]))])),
    ]))])
    expect(decodeHighwaySessionResponse(session)).toEqual({
      ticket: Buffer.from('ticket'), servers: [{ host: '127.0.0.1', port: 8080 }],
    })

    const msgInfoBody = pb([field(1, pb([field(2, Buffer.from('image-uuid'))]))])
    const upload = oidb(pb([field(2, pb([
      field(1, Buffer.from('ukey')), field(3, pb([u(1, 0x0100007f), u(2, 80)])),
      field(6, pb([field(1, msgInfoBody)])),
    ]))]))
    expect(decodeImageUploadResponse(upload)).toEqual({
      ukey: 'ukey', fileUuid: 'image-uuid',
      ipv4s: [{ host: '127.0.0.1', port: 80 }],
      msgInfo: pb([field(1, msgInfoBody)]), msgInfoBodies: [msgInfoBody], compatQMsg: undefined,
    })
    const rejected = () => decodeImageUploadResponse(oidb(Buffer.from(toBinary(
      generated.ImageUploadResponseSchema,
      create(generated.ImageUploadResponseSchema, {
        head: create(generated.ImageResponseHeadSchema, { code: 7, message: 'denied' }),
      }),
    ))))
    expect(rejected).toThrow('denied (7)')
    expect(rejected).toThrow(QQMediaUploadRejectedError)
  })

  it('negotiates playable video with main and thumbnail rich-media uploads', () => {
    const spec = {
      name: 'clip.mp4', mimeType: 'video/mp4', size: 1234,
      md5: '00112233445566778899aabbccddeeff',
      sha1: '00112233445566778899aabbccddeeff00112233',
      width: 640, height: 360, duration: 9.4,
    }
    const direct = encodeVideoUploadRequest(1, 'u_friend', spec)
    const group = encodeVideoUploadRequest(2, '1002974327', spec)
    expect(direct.command).toBe('OidbSvcTrpcTcp.0x11e9_100')
    expect(group.command).toBe('OidbSvcTrpcTcp.0x11ea_100')
    const requestEnvelope = fromBinary(generated.OidbEnvelopeSchema, group.payload)
    const request = fromBinary(generated.VideoUploadRequestSchema, requestEnvelope.body)
    expect(request.head).toMatchObject({
      common: { requestId: 3, command: 100 },
      scene: { requestType: 2, businessType: 2, sceneType: 2, group: { groupUin: 1002974327 } },
      client: { agentType: 2 },
    })
    expect(request.upload).toMatchObject({
      tryFastUploadCompleted: true, srvSendMsg: false, compatQmsgSceneType: 2,
      noNeedCompatMsg: false,
      uploadInfo: [{
        subFileType: 0,
        fileInfo: {
          fileSize: 1234, fileName: 'clip.mp4', width: 640, height: 360, time: 9,
          type: { type: 2, videoFormat: 2 },
        },
      }, {
        subFileType: 100,
        fileInfo: {
          fileSize: VIDEO_THUMBNAIL_BYTES.length,
          width: VIDEO_THUMBNAIL_WIDTH, height: VIDEO_THUMBNAIL_HEIGHT,
          fileHash: VIDEO_THUMBNAIL_MD5.toUpperCase(),
          fileSha1: VIDEO_THUMBNAIL_SHA1.toUpperCase(),
          type: { type: 1 },
        },
      }],
    })
    const customThumbnail = {
      size: 777,
      md5: 'ffeeddccbbaa99887766554433221100',
      sha1: 'ffeeddccbbaa9988776655443322110000112233',
      width: 400,
      height: 225,
    }
    const customEnvelope = fromBinary(
      generated.OidbEnvelopeSchema,
      encodeVideoUploadRequest(1, 'u_friend', { ...spec, thumbnail: customThumbnail }).payload,
    )
    const customRequest = fromBinary(generated.VideoUploadRequestSchema, customEnvelope.body)
    expect(customRequest.upload?.uploadInfo[1]?.fileInfo).toMatchObject({
      fileSize: customThumbnail.size,
      fileHash: customThumbnail.md5.toUpperCase(),
      fileSha1: customThumbnail.sha1.toUpperCase(),
      width: customThumbnail.width,
      height: customThumbnail.height,
    })

    const videoBody = pb([field(1, pb([field(2, Buffer.from('video-uuid'))]))])
    const thumbnailBody = pb([field(1, pb([field(2, Buffer.from('thumbnail-uuid'))]))])
    const msgInfo = pb([field(1, videoBody), field(1, thumbnailBody)])
    const response = oidb(pb([field(2, pb([
      field(1, Buffer.from('video-ukey')),
      field(3, pb([u(1, 0x0100007f), u(2, 80)])),
      field(6, msgInfo),
      field(10, pb([
        u(1, 100), field(2, Buffer.from('thumbnail-ukey')),
        field(4, pb([u(1, 0x0200007f), u(2, 81)])),
      ])),
    ]))]))
    const upload = decodeVideoUploadResponse(response)
    expect(upload).toEqual({
      fileUuid: 'video-uuid', thumbnailFileUuid: 'thumbnail-uuid', msgInfo,
      msgInfoBodies: [videoBody, thumbnailBody],
      videoUkey: 'video-ukey', videoIpv4s: [{ host: '127.0.0.1', port: 80 }],
      thumbnailUkey: 'thumbnail-ukey', thumbnailIpv4s: [{ host: '127.0.0.2', port: 81 }],
    })
    const mainExt = fromBinary(
      generated.ImageHighwayExtSchema,
      encodeVideoHighwayExt(upload, 'video', spec.sha1),
    )
    const thumbnailExt = fromBinary(
      generated.ImageHighwayExtSchema,
      encodeVideoHighwayExt(upload, 'thumbnail', VIDEO_THUMBNAIL_SHA1),
    )
    expect(mainExt).toMatchObject({ fileUuid: 'video-uuid', ukey: 'video-ukey' })
    expect(thumbnailExt).toMatchObject({ fileUuid: 'thumbnail-uuid', ukey: 'thumbnail-ukey' })
    expect(mainExt.msgInfoBodies.map(Buffer.from)).toEqual([videoBody, thumbnailBody])
  })

  it('frames exact Highway metadata and validates server responses', () => {
    const body = Buffer.from('payload')
    const frame = encodeHighwayFrame({
      selfUin: '1715311957', commandId: 1003, sequence: 9,
      ticket: Buffer.from('ticket'), fileSize: body.length, offset: 0,
      fileMd5: createHash('md5').update(body).digest('hex'),
      extendInfo: Buffer.from('ext'), body,
    })
    expect(frame[0]).toBe(0x28)
    expect(frame.at(-1)).toBe(0x29)
    const headLength = frame.readUInt32BE(1)
    expect(frame.readUInt32BE(5)).toBe(body.length)
    expect(frame.subarray(9 + headLength, -1)).toEqual(body)
    expect(frame.subarray(9, 9 + headLength).includes(Buffer.from('ticket'))).toBe(true)

    expect(() => decodeHighwayResponse(highwayResponse())).not.toThrow()
    expect(() => decodeHighwayResponse(highwayResponse(pb([u(3, 9)]))))
      .toThrow('error=9')
    expect(() => decodeHighwayResponse(Buffer.from([0x28, 0x29]))).toThrow('invalid Highway')
  })

  it('encodes and decodes group/private file negotiation and builds their Highway metadata', () => {
    const spec = {
      name: 'report.bin', size: 456,
      md5: '00112233445566778899aabbccddeeff',
      sha1: '00112233445566778899aabbccddeeff00112233',
      file10MMd5: 'ffeeddccbbaa99887766554433221100',
    }
    expect(encodeFileUploadRequest(2, '1002974327', 'self', spec).command)
      .toBe('OidbSvcTrpcTcp.0x6d6_0')
    expect(encodeFileUploadRequest(1, 'u_friend', 'u_self', spec).command)
      .toBe('OidbSvcTrpcTcp.0xe37_1700')

    const groupResponse = oidb(pb([field(1, pb([
      field(4, Buffer.from('10.0.0.1')), field(7, Buffer.from('group-uuid')),
      field(8, Buffer.from('check')), field(9, Buffer.from('upload-key')), u(14, 80),
    ]))]))
    const group = decodeFileUploadResponse(2, groupResponse, '1715311957', '1002974327', spec)
    expect(group).toMatchObject({ fileUuid: 'group-uuid', exists: false, commandId: 71 })
    expect(group.extendInfo).toBeInstanceOf(Buffer)
    expect(group.extendInfo!.includes(Buffer.from('10.0.0.1'))).toBe(true)
    expect(group.extendInfo!.includes(Buffer.from('report.bin'))).toBe(true)

    const privateResponse = oidb(pb([field(19, pb([
      field(90, Buffer.from('private-uuid')),
      field(210, pb([u(1, 0x0100007f), u(2, 80), u(3, 0x0200000a), u(4, 443)])),
      field(200, Buffer.from('addon')), field(220, Buffer.from('media-key')),
    ]))]))
    const direct = decodeFileUploadResponse(1, privateResponse, '1715311957', 'u_friend', spec)
    expect(direct).toMatchObject({
      fileUuid: 'private-uuid', fileHash: 'addon', exists: false, commandId: 95,
    })
    expect(direct.extendInfo!.includes(Buffer.from('10.0.0.2'))).toBe(true)

    const fastGroup = oidb(pb([field(1, pb([
      field(7, Buffer.from('existing-uuid')), u(10, 1),
    ]))]))
    expect(decodeFileUploadResponse(2, fastGroup, '1715311957', '1002974327', spec))
      .toEqual({ fileUuid: 'existing-uuid', exists: true, commandId: 71 })
  })

  it('keeps images on PbSendMsg and publishes group files through the 0x6d9 feed protocol', () => {
    const image = {
      fileUuid: 'image-uuid', ipv4s: [], ukey: undefined,
      msgInfo: pb([field(1, Buffer.from('image-index'))]),
      msgInfoBodies: [Buffer.from('image-index')], compatQMsg: Buffer.from('compat-image'),
    }
    const group = encodeDirectMessageRequest(2, '1002974327', '1002974327', [
      { kind: 'text', text: 'caption' }, { kind: 'image', upload: image },
    ], { clientSequence: 7n, random: 8, nowSeconds: 9 })
    expect(group.command).toBe('MessageSvc.PbSendMsg')
    const request = wire(group.payload)
    expect(request.map((item) => item.tag)).toEqual([1, 2, 3, 4, 5])
    expect(wire(requiredWireBytes(wire(requiredWireBytes(request, 1)), 2))[0]).toMatchObject({ tag: 1, value: 1002974327n })
    const richText = wire(requiredWireBytes(wire(requiredWireBytes(request, 3)), 1))
    expect(richText.filter((item) => item.tag === 2)).toHaveLength(3)
    expect(group.payload.includes(Buffer.from('caption'))).toBe(true)
    expect(group.payload.includes(Buffer.from('compat-image'))).toBe(true)
    expect(group.payload.includes(image.msgInfo)).toBe(true)

    const feed = encodeGroupFileFeedRequest('1002974327', 'group-file', 123456)
    expect(feed.command).toBe('OidbSvcTrpcTcp.0x6d9_4')
    const envelope = fromBinary(generated.OidbEnvelopeSchema, feed.payload)
    expect(envelope).toMatchObject({ command: 0x6d9, subCommand: 4, reserved: 1 })
    const decodedFeed = fromBinary(generated.GroupFileFeedRequestSchema, envelope.body)
    expect(decodedFeed.feeds).toMatchObject({
      groupCode: 1002974327n, appId: 2, multiSendSequence: 0,
      files: [{ busId: 102, fileUuid: 'group-file', messageRandom: 123456, feedFlag: 1 }],
    })
    const acceptedFeed = oidb(pb([field(5, pb([
      u(1, 0), field(4, pb([u(1, 0), field(3, Buffer.from('group-file')), u(4, 102)])),
    ]))]))
    expect(() => decodeGroupFileFeedResponse(acceptedFeed)).not.toThrow()
    expect(() => decodeGroupFileFeedResponse(oidb(pb([field(5, pb([
      u(1, 79), field(2, Buffer.from('denied')),
    ]))])))).toThrow('denied (79)')
    expect(() => encodeDirectMessageRequest(2, '1002974327', '1002974327', [{
      kind: 'file', spec: fileSpec(), upload: { fileUuid: 'group-file', exists: true, commandId: 71 },
    }])).toThrow('0x6d9_4')

    expect(decodeDirectMessageResponse(pb([u(3, 123), u(11, 456), u(14, 789)]))).toEqual({
      sendTime: 123, sequence: 456n, clientSequence: 789n,
    })
    expect(() => decodeDirectMessageResponse(pb([u(1, 7), field(2, Buffer.from('denied'))])))
      .toThrow('denied (7)')
    try {
      decodeDirectMessageResponse(pb([
        u(1, 16), field(2, Buffer.from('add the recipient as a friend first')),
      ]))
      throw new Error('expected the permanent send rejection to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(QQMessageSendRejectedError)
      expect(error).toMatchObject({
        result: 16,
        detail: 'add the recipient as a friend first',
        message: 'QQ message send rejected: add the recipient as a friend first (16)',
      })
    }
  })

  it('sends videos as service-48 rich media instead of QQ group files', () => {
    const video = {
      fileUuid: 'video-uuid', thumbnailFileUuid: 'thumbnail-uuid',
      msgInfo: Buffer.from('complete-video-msg-info'), msgInfoBodies: [],
      videoIpv4s: [], thumbnailIpv4s: [],
    }
    const group = fromBinary(generated.SendMessageRequestSchema, encodeDirectMessageRequest(
      2, '1002974327', '1002974327', [
        { kind: 'text', text: 'caption' }, { kind: 'video', upload: video },
      ], { clientSequence: 7n, random: 8 },
    ).payload)
    const privateMessage = fromBinary(generated.SendMessageRequestSchema, encodeDirectMessageRequest(
      1, 'u_friend', '42', [{ kind: 'video', upload: video }],
      { clientSequence: 9n, random: 10 },
    ).payload)
    expect(group.body?.richText?.elements.at(-1)?.common).toMatchObject({
      serviceType: 48, businessType: 21, payload: video.msgInfo,
    })
    expect(privateMessage.body?.richText?.elements[0]?.common).toMatchObject({
      serviceType: 48, businessType: 11, payload: video.msgInfo,
    })
  })

  it('keeps stable PbSendMsg vectors for text, mentions, faces, market stickers, and replies', () => {
    const request = encodeDirectMessageRequest(1, 'u_friend', '42', [
      { kind: 'text', text: 'hello' },
      { kind: 'mention', text: '@Alice', userUid: 'u_alice', userUin: '12345' },
      { kind: 'face', face: { faceId: 14, faceType: 1 } },
      { kind: 'face', face: {
        faceId: 476, faceType: 3, packId: '3', stickerId: '476',
        sourceType: 1, stickerType: 2, resultId: 'result-476',
      } },
      { kind: 'face', face: { faceId: 260, faceType: 1 } },
      { kind: 'market-face', face: {
        name: 'Wave', emojiId: '0a0b', packageId: 7, key: 'key', width: 320, height: 180,
      } },
      { kind: 'reply', reply: {
        messageId: '99', sequence: '10', clientSequence: '11', senderUin: '12',
        senderUid: 'u_sender', receiverUid: 'u_friend', time: 13,
      } },
    ], { clientSequence: 1n, random: 2 })
    const decoded = fromBinary(generated.SendMessageRequestSchema, request.payload)
    const elements = decoded.body?.richText?.elements ?? []
    expect(elements.map((element) => Buffer.from(toBinary(generated.ElemSchema, element)).toString('hex')))
      .toEqual([
        '0a070a0568656c6c6f',
        '0a1a0a0640416c6963656210180220b96028004a07755f616c696365',
        '1202080e',
        'aa03250825121f0a0133120334373618dc0320012802320a726573756c742d3437363a0048011801',
        'aa030d0821120708840212001a001801',
        '32230a065b576176655d1006180122020a0b280730033a036b657950c00258b4016a024001',
        'ea02230a010b100c180d421818633208755f73656e6465723a08755f667269656e64400b5000',
      ])
  })

  it('uses the QQNT client-sequence range for live PbSendMsg requests', () => {
    for (let index = 0; index < 32; index++) {
      const request = encodeDirectMessageRequest(
        1, 'u_friend', '42', [{ kind: 'text', text: 'hello' }],
      )
      const decoded = fromBinary(generated.SendMessageRequestSchema, request.payload)
      expect(decoded.clientSequence).toBeGreaterThanOrEqual(10_000n)
      expect(decoded.clientSequence).toBeLessThan(99_999n)
    }
  })

  it('fetches private-file message metadata and builds the 0x211 file send route', () => {
    const metadataRequest = encodePrivateFileMetadataRequest('u_self', 'u_friend', 'file-uuid', 'file-hash')
    expect(metadataRequest.command).toBe('OidbSvcTrpcTcp.0xe37_800')
    for (const value of ['u_self', 'u_friend', 'file-uuid', 'file-hash']) {
      expect(metadataRequest.payload.includes(Buffer.from(value))).toBe(true)
    }
    const metadataResponse = oidb(pb([field(10, pb([
      field(30, pb([
        u(3, 6), field(100, Buffer.from('field-100')), field(101, Buffer.from('field-101')),
        u(110, 1), u(130, 1700000000),
      ])),
    ]))]))
    const metadata = decodePrivateFileMetadataResponse(metadataResponse)
    expect(metadata).toEqual({
      field1: 1, field6: 6, field7: Buffer.from('field-101'),
      field8: Buffer.from('field-100'), timestamp1: 1700000000,
    })

    const direct = encodeDirectMessageRequest(1, 'u_friend', '42', [{
      kind: 'file', spec: fileSpec(), upload: {
        fileUuid: 'file-uuid', fileHash: 'file-hash', exists: false, commandId: 95,
        privateMetadata: metadata,
      },
    }], { selfUid: 'u_self', clientSequence: 10n, random: 11, nowSeconds: 1700000000 })
    const request = wire(direct.payload)
    const route = wire(requiredWireBytes(request, 1))
    expect(route.map((item) => item.tag)).toEqual([15])
    expect(requiredWireBytes(route, 15).includes(Buffer.from('u_friend'))).toBe(true)
    const body = wire(requiredWireBytes(request, 3))
    expect(body.map((item) => item.tag)).toEqual([2])
    for (const value of ['file-uuid', 'file-hash', 'report.bin', 'u_self', 'u_friend']) {
      expect(requiredWireBytes(body, 2).includes(Buffer.from(value))).toBe(true)
    }
    expect(requiredWireBytes(body, 2).includes(Buffer.from(fileSpec().file10MMd5, 'hex'))).toBe(true)
    expect(() => encodeDirectMessageRequest(1, 'u_friend', '42', [
      { kind: 'text', text: 'caption' },
      { kind: 'file', spec: fileSpec(), upload: { fileUuid: 'x', exists: true, commandId: 95 } },
    ], { selfUid: 'u_self' })).toThrow('cannot contain captions')
  })

  it('streams a reopened relay body directly into bounded Highway requests without filesystem staging', async () => {
    const bytes = Buffer.alloc(HIGHWAY_BLOCK_SIZE + 3, 0x5a)
    const md5 = createHash('md5').update(bytes).digest('hex')
    const sha1 = createHash('sha1').update(bytes).digest('hex')
    const msgInfoBody = pb([field(1, pb([field(2, Buffer.from('direct-uuid'))]))])
    const imageResponse = oidb(pb([field(2, pb([
      field(1, Buffer.from('direct-ukey')),
      field(3, pb([u(1, 0x0100007f), u(2, 80)])),
      field(6, pb([field(1, msgInfoBody)])),
    ]))]))
    const sessionResponse = pb([field(0x501, pb([
      field(1, Buffer.from('session-ticket')),
      field(3, pb([u(1, 1), field(2, pb([fixed(2, 0x0100007f), u(3, 8080)]))])),
    ]))])
    const sent = vi.fn(async (command: string) => ({
      rspbuffer: command.startsWith('OidbSvcTrpcTcp') ? imageResponse : sessionResponse,
    }))
    const addon = {
      sendPacket: vi.fn((send, command, payload) => send(command, payload)),
      installSendHook: vi.fn(() => ({
        moduleBase: '0x1', locator: 'test', timeDateStamp: 0, sizeOfImage: 0,
        anchorRva: 0, xrefRva: 0, functionRva: 0, converterRva: 0, responseRva: 0,
      })),
    } as unknown as PacketAddon
    const posted: Buffer[] = []
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      posted.push(Buffer.from(init!.body as Buffer))
      return new Response(highwayResponse())
    }) as typeof globalThis.fetch
    const client = new QQPacketClient({
      sendSsoCmdReqByContend: sent as NonNullable<KernelMsgService['sendSsoCmdReqByContend']>,
    }, { addon, fetch })

    const uploaded = await client.uploadImage(1, 'u_friend', '1715311957', {
      name: 'direct.png', size: bytes.length, md5, sha1, width: 1, height: 1, picType: 1001,
    }, (async function* () {
      yield bytes.subarray(0, 17)
      yield bytes.subarray(17, HIGHWAY_BLOCK_SIZE + 1)
      yield bytes.subarray(HIGHWAY_BLOCK_SIZE + 1)
    })())

    expect(uploaded.fileUuid).toBe('direct-uuid')
    expect(sent.mock.calls.map(([command]) => command)).toEqual([
      'OidbSvcTrpcTcp.0x11c5_100', 'HttpConn.0x6ff_501',
    ])
    expect(posted).toHaveLength(2)
    expect(posted.map((frame) => frame.readUInt32BE(5))).toEqual([HIGHWAY_BLOCK_SIZE, 3])
    expect(fetch).toHaveBeenNthCalledWith(1,
      'http://127.0.0.1:8080/cgi-bin/httpconn?htcmd=0x6FF0087&uin=1715311957',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('streams video and its companion thumbnail through the correct Highway commands', async () => {
    const bytes = Buffer.from('playable-video')
    const md5 = createHash('md5').update(bytes).digest('hex')
    const sha1 = createHash('sha1').update(bytes).digest('hex')
    const videoBody = pb([field(1, pb([field(2, Buffer.from('video-uuid'))]))])
    const thumbnailBody = pb([field(1, pb([field(2, Buffer.from('thumbnail-uuid'))]))])
    const videoResponse = oidb(pb([field(2, pb([
      field(1, Buffer.from('video-ukey')),
      field(3, pb([u(1, 0x0100007f), u(2, 80)])),
      field(6, pb([field(1, videoBody), field(1, thumbnailBody)])),
      field(10, pb([
        u(1, 100), field(2, Buffer.from('thumbnail-ukey')),
        field(4, pb([u(1, 0x0100007f), u(2, 80)])),
      ])),
    ]))]))
    const sessionResponse = pb([field(0x501, pb([
      field(1, Buffer.from('session-ticket')),
      field(3, pb([u(1, 1), field(2, pb([fixed(2, 0x0100007f), u(3, 8080)]))])),
    ]))])
    const sent = vi.fn(async (command: string) => ({
      rspbuffer: command.startsWith('OidbSvcTrpcTcp') ? videoResponse : sessionResponse,
    }))
    const addon = {
      sendPacket: vi.fn((send, command, payload) => send(command, payload)),
      installSendHook: vi.fn(() => ({
        moduleBase: '0x1', locator: 'test', timeDateStamp: 0, sizeOfImage: 0,
        anchorRva: 0, xrefRva: 0, functionRva: 0, converterRva: 0, responseRva: 0,
      })),
    } as unknown as PacketAddon
    const posted: Buffer[] = []
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      posted.push(Buffer.from(init!.body as Buffer))
      return new Response(highwayResponse())
    }) as typeof globalThis.fetch
    const client = new QQPacketClient({
      sendSsoCmdReqByContend: sent as NonNullable<KernelMsgService['sendSsoCmdReqByContend']>,
    }, { addon, fetch })

    const uploaded = await client.uploadVideo(2, '1002974327', '1715311957', {
      name: 'clip.mp4', mimeType: 'video/mp4', size: bytes.length, md5, sha1,
      width: 320, height: 180, duration: 4,
    }, (async function* () { yield bytes })())

    expect(uploaded.fileUuid).toBe('video-uuid')
    expect(posted).toHaveLength(2)
    const heads = posted.map((frame) => fromBinary(
      generated.HighwayRequestHeadSchema,
      frame.subarray(9, 9 + frame.readUInt32BE(1)),
    ))
    expect(heads.map((head) => head.base?.commandId)).toEqual([1005, 1006])
    expect(posted.map((frame) => frame.subarray(9 + frame.readUInt32BE(1), -1)))
      .toEqual([bytes, VIDEO_THUMBNAIL_BYTES])
  })

  it('uses the stable Highway session request wire shape and rejects incomplete streams', async () => {
    expect(encodeHighwaySessionRequest().payload.toString('hex')).toBe(
      '8a501b18102001300338013805380a38154802500958087a05312e302e31',
    )
    const fastResponse = oidb(pb([field(2, pb([
      field(6, pb([field(1, pb([field(1, pb([field(2, Buffer.from('fast-uuid'))]))]))])),
    ]))]))
    const send = vi.fn(async () => ({ rspbuffer: fastResponse }))
    const addon = {
      sendPacket: vi.fn((sender, command, payload) => sender(command, payload)),
      installSendHook: vi.fn(() => ({
        moduleBase: '0x1', locator: 'test', timeDateStamp: 0, sizeOfImage: 0,
        anchorRva: 0, xrefRva: 0, functionRva: 0, converterRva: 0, responseRva: 0,
      })),
    } as unknown as PacketAddon
    const client = new QQPacketClient({
      sendSsoCmdReqByContend: send as NonNullable<KernelMsgService['sendSsoCmdReqByContend']>,
    }, { addon, fetch: vi.fn() as typeof globalThis.fetch })
    await expect(client.uploadImage(1, 'friend', '1', {
      name: 'x.png', size: 2, md5: '00'.repeat(16), sha1: '11'.repeat(20), picType: 1001,
    }, (async function* () { yield Buffer.from([1]) })())).rejects.toThrow('expected 2 bytes, received 1')
  })
})

function highwayResponse(head: Buffer<ArrayBufferLike> = Buffer.alloc(0), body: Buffer<ArrayBufferLike> = Buffer.alloc(0)): Buffer {
  const output = Buffer.alloc(10 + head.length + body.length)
  output[0] = 0x28
  output.writeUInt32BE(head.length, 1)
  output.writeUInt32BE(body.length, 5)
  head.copy(output, 9)
  body.copy(output, 9 + head.length)
  output[output.length - 1] = 0x29
  return output
}

function oidb(body: Buffer): Buffer { return pb([u(1, 1), u(2, 100), field(4, body), u(12, 1)]) }
function pb(parts: Buffer[]): Buffer { return Buffer.concat(parts) }
function field(tag: number, value: Buffer): Buffer { return pb([v(BigInt((tag << 3) | 2)), v(BigInt(value.length)), value]) }
function u(tag: number, value: number): Buffer { return pb([v(BigInt(tag << 3)), v(BigInt(value))]) }
function fixed(tag: number, value: number): Buffer {
  const output = Buffer.alloc(5); output[0] = (tag << 3) | 5; output.writeUInt32LE(value, 1); return output
}
function v(value: bigint): Buffer {
  const result: number[] = []
  do { let byte = Number(value & 0x7fn); value >>= 7n; if (value) byte |= 0x80; result.push(byte) } while (value)
  return Buffer.from(result)
}

function fileSpec() {
  return {
    name: 'report.bin', size: 456,
    md5: '00112233445566778899aabbccddeeff',
    sha1: '00112233445566778899aabbccddeeff00112233',
    file10MMd5: 'ffeeddccbbaa99887766554433221100',
  }
}

type TestWireField = { tag: number, wire: number, value: bigint | Buffer }
function wire(input: Uint8Array): TestWireField[] {
  const buffer = Buffer.from(input)
  const result: TestWireField[] = []
  let offset = 0
  while (offset < buffer.length) {
    const key = readTestVarint(buffer, offset); offset = key.offset
    const tag = Number(key.value >> 3n)
    const type = Number(key.value & 7n)
    if (type === 0) {
      const value = readTestVarint(buffer, offset); offset = value.offset
      result.push({ tag, wire: type, value: value.value })
    } else if (type === 2) {
      const length = readTestVarint(buffer, offset); offset = length.offset
      const end = offset + Number(length.value)
      result.push({ tag, wire: type, value: buffer.subarray(offset, end) })
      offset = end
    } else throw new Error(`unsupported test wire type ${type}`)
  }
  return result
}
function requiredWireBytes(input: TestWireField[], tag: number): Buffer {
  const value = input.find((item) => item.tag === tag && item.wire === 2)?.value
  if (!Buffer.isBuffer(value)) throw new Error(`missing bytes tag ${tag}`)
  return value
}
function readTestVarint(buffer: Buffer, start: number): { value: bigint, offset: number } {
  let value = 0n
  let shift = 0n
  for (let offset = start; offset < buffer.length; offset++) {
    const byte = buffer[offset]!
    value |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return { value, offset: offset + 1 }
    shift += 7n
  }
  throw new Error('truncated test varint')
}
