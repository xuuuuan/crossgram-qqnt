import { createHash, randomBytes } from 'node:crypto'
import { create, fromBinary, toBinary, type DescMessage, type MessageInitShape } from '@bufbuild/protobuf'
import * as pb from './generated/qqnt/packet_pb.js'

const HIGHWAY_APP_ID = 1_600_001_604
export const HIGHWAY_BLOCK_SIZE = 1024 * 1024

export interface DirectImageSpec {
  name: string
  size: number
  md5: string
  sha1: string
  width?: number
  height?: number
  picType: number
  picSubType?: number
}

export interface PacketRequest {
  command: string
  payload: Buffer
}

export interface HighwaySession {
  ticket: Buffer
  servers: Array<{ host: string, port: number }>
}

export interface PreparedImageUpload {
  ukey?: string
  fileUuid: string
  ipv4s: Array<{ host: string, port: number }>
  msgInfo: Buffer
  msgInfoBodies: Buffer[]
  compatQMsg?: Buffer
}

export interface DirectFileSpec {
  name: string
  size: number
  md5: string
  sha1: string
  file10MMd5: string
}

export interface PreparedFileUpload {
  fileUuid: string
  fileHash?: string
  exists: boolean
  commandId: 71 | 95
  extendInfo?: Buffer
  privateMetadata?: PrivateFileMetadata
}

export interface PrivateFileMetadata {
  field1: number
  field6: number
  field7: Buffer
  field8: Buffer
  timestamp1: number
}

export interface DirectReplySpec {
  messageId: string
  sequence?: string
  clientSequence?: string
  senderUin?: string
  senderUid?: string
  receiverUid?: string
  time?: number
}

export interface DirectFaceSpec {
  faceId: number
  faceType: number
  packId?: string
  stickerId?: string
  sourceType?: number
  stickerType?: number
  resultId?: string
}

export interface DirectMarketFaceSpec {
  name: string
  emojiId: string
  packageId: number
  key: string
  width?: number
  height?: number
}

export type DirectMessagePart =
  | { kind: 'text', text: string }
  | { kind: 'mention', text: string, userUid: string, userUin?: string, all?: boolean }
  | { kind: 'face', face: DirectFaceSpec }
  | { kind: 'market-face', face: DirectMarketFaceSpec }
  | { kind: 'reply', reply: DirectReplySpec }
  | { kind: 'image', upload: PreparedImageUpload }
  | { kind: 'file', spec: DirectFileSpec, upload: PreparedFileUpload }

export interface DirectMessageSendResponse {
  sequence: bigint
  clientSequence: bigint
  sendTime: number
}

export function encodeHighwaySessionRequest(): PacketRequest {
  return {
    command: 'HttpConn.0x6ff_501',
    payload: binary(pb.HttpConnRequestSchema, {
      body: {
        field3: 16, field4: 1, field6: 3, commands: [1, 5, 10, 21],
        field9: 2, field10: 9, field11: 8, version: '1.0.1',
      },
    }),
  }
}

export function decodeHighwaySessionResponse(payload: Uint8Array): HighwaySession {
  const session = required(
    fromBinary(pb.HttpConnResponseSchema, payload).session,
    'HttpConn response',
  )
  const ticket = requiredBuffer(session.ticket, 'Highway sigSession')
  const servers = session.serverGroups
    .filter((group) => group.kind === 1)
    .flatMap((group) => group.addresses)
    .map((address) => ({ host: ipv4(address.host), port: address.port }))
    .filter((server) => server.host !== '0.0.0.0' && server.port > 0)
  if (!servers.length) throw new Error('Highway session response contained no upload server')
  return { ticket, servers }
}

export function encodeImageUploadRequest(
  chatType: 1 | 2,
  peerUid: string,
  spec: DirectImageSpec,
): PacketRequest {
  assertHash(spec.md5, 'MD5', 32)
  assertHash(spec.sha1, 'SHA-1', 40)
  if (!Number.isSafeInteger(spec.size) || spec.size < 0) {
    throw new Error('image size must be a non-negative safe integer')
  }
  const group = chatType === 2
  const command = group ? 0x11c4 : 0x11c5
  const subtype = spec.picSubType ?? 0
  const scene = group
    ? { requestType: 2, businessType: 1, chatType, group: { groupUin: numericPeer(peerUid) } }
    : { requestType: 2, businessType: 1, chatType, c2c: { field1: 2, peerUid } }
  const picture = group
    ? { subtype, summary: '[图片]', group: { subtype } }
    : { subtype, summary: '[图片]', c2c: { subtype } }
  const body = binary(pb.ImageUploadRequestSchema, {
    head: {
      business: { field1: 1, field2: 100 },
      scene,
      client: { field1: 2 },
    },
    upload: {
      file: {
        info: {
          size: BigInt(spec.size), md5: spec.md5.toUpperCase(), sha1: spec.sha1.toUpperCase(),
          name: spec.name, type: { field1: 1, picType: spec.picType },
          width: spec.width ?? 0, height: spec.height ?? 0, field9: 1,
        },
        field2: 0,
      },
      field2: true, field3: false, uploadId: randomPositiveInt64(), chatType,
      message: {
        picture,
        field2: { field3: new Uint8Array() },
        field3: { field11: new Uint8Array(), field12: new Uint8Array(), field13: new Uint8Array() },
      },
      field7: 0, field8: false,
    },
  })
  return {
    command: `OidbSvcTrpcTcp.0x${command.toString(16)}_100`,
    payload: encodeOidb(command, 100, body, true),
  }
}

export function decodeImageUploadResponse(payload: Uint8Array): PreparedImageUpload {
  const response = fromBinary(pb.ImageUploadResponseSchema, decodeOidb(payload))
  if (response.head?.code) {
    throw new Error(`QQ image upload preparation failed: ${response.head.message} (${response.head.code})`)
  }
  const upload = required(response.upload, 'image upload response')
  const msgInfo = requiredBuffer(upload.msgInfo, 'image MsgInfo')
  const msgInfoBodies = fromBinary(pb.ImageMsgInfoSchema, msgInfo).bodies.map(Buffer.from)
  const firstBody = requiredBuffer(msgInfoBodies[0], 'image MsgInfo body')
  const index = required(fromBinary(pb.ImageMsgInfoBodySchema, firstBody).index, 'image index')
  if (!index.fileUuid) throw new Error('image upload response contained no file UUID')
  return {
    ukey: upload.ukey || undefined,
    fileUuid: index.fileUuid,
    ipv4s: upload.addresses.map((address) => ({ host: ipv4(address.host), port: address.port })),
    msgInfo,
    msgInfoBodies,
    compatQMsg: upload.compatQmsg.length ? Buffer.from(upload.compatQmsg) : undefined,
  }
}

export function encodePrivateFileMetadataRequest(
  selfUid: string,
  peerUid: string,
  fileUuid: string,
  fileHash: string,
): PacketRequest {
  if (!selfUid || !peerUid || !fileUuid || !fileHash) {
    throw new Error('private file metadata requires sender, receiver, UUID, and file hash')
  }
  const body = binary(pb.PrivateFileMetadataRequestSchema, {
    command: 800, field2: 0,
    query: { selfUid, peerUid, fileUuid, fileHash },
    field101: 3, field102: 1, chatType: 1,
  })
  return { command: 'OidbSvcTrpcTcp.0xe37_800', payload: encodeOidb(0xe37, 800, body, false) }
}

export function decodePrivateFileMetadataResponse(payload: Uint8Array): PrivateFileMetadata {
  const result = required(
    fromBinary(pb.PrivateFileMetadataResponseSchema, decodeOidb(payload)).result,
    'private file metadata response',
  )
  if (result.code) throw new Error(`QQ private file metadata failed (${result.code})`)
  const metadata = required(result.metadata, 'private file metadata')
  return {
    field1: metadata.field1,
    field6: metadata.field6,
    field7: requiredBuffer(metadata.field7, 'private file metadata field 101'),
    field8: requiredBuffer(metadata.field8, 'private file metadata field 100'),
    timestamp1: metadata.timestamp1,
  }
}

export function encodeFileUploadRequest(
  chatType: 1 | 2,
  peerUid: string,
  selfUid: string,
  spec: DirectFileSpec,
): PacketRequest {
  assertFileSpec(spec)
  if (chatType === 2) {
    const body = binary(pb.GroupFileUploadRequestSchema, { upload: {
      groupUin: numericPeer(peerUid), field2: 4, field3: 102, field4: 6,
      parent: '/', name: spec.name, path: `/${spec.name}`, size: BigInt(spec.size),
      sha1: hex(spec.sha1), field10: new Uint8Array(), md5: hex(spec.md5), field15: true,
    } })
    return { command: 'OidbSvcTrpcTcp.0x6d6_0', payload: encodeOidb(0x6d6, 0, body, true) }
  }
  if (!selfUid || !peerUid) throw new Error('private file upload requires self and peer UID')
  const body = binary(pb.PrivateFileUploadRequestSchema, {
    command: 1700, field2: 0,
    upload: {
      selfUid, peerUid, size: BigInt(spec.size), name: spec.name,
      first10mMd5: hex(spec.file10MMd5), sha1: hex(spec.sha1), parent: '/',
      md5: hex(spec.md5), field120: new Uint8Array(),
    },
    field101: 3, field102: 1, chatType: 1,
  })
  return { command: 'OidbSvcTrpcTcp.0xe37_1700', payload: encodeOidb(0xe37, 1700, body, false) }
}

export function decodeFileUploadResponse(
  chatType: 1 | 2,
  payload: Uint8Array,
  selfUin: string,
  peerUid: string,
  spec: DirectFileSpec,
): PreparedFileUpload {
  assertFileSpec(spec)
  const body = decodeOidb(payload)
  if (chatType === 2) {
    const upload = required(
      fromBinary(pb.GroupFileUploadResponseSchema, body).upload,
      'group file upload response',
    )
    if (upload.code) {
      throw new Error(`QQ group file upload preparation failed: ${upload.message || upload.error} (${upload.code})`)
    }
    const response: PreparedFileUpload = {
      fileUuid: upload.fileUuid, exists: Boolean(upload.exists), commandId: 71,
    }
    if (!response.fileUuid) throw new Error('group file upload response contained no file UUID')
    if (response.exists) return response
    response.extendInfo = fileUploadExt({
      selfUin, peerUin: numericPeer(peerUid), spec, fileUuid: response.fileUuid,
      checkKey: requiredBuffer(upload.checkKey, 'group file check key'),
      uploadKey: requiredBuffer(upload.uploadKey, 'group file upload key'),
      host: upload.host, port: upload.port, group: true,
    })
    return response
  }
  const upload = required(
    fromBinary(pb.PrivateFileUploadResponseSchema, body).upload,
    'private file upload response',
  )
  if (upload.code) throw new Error(`QQ private file upload preparation failed: ${upload.error} (${upload.code})`)
  const response: PreparedFileUpload = {
    fileUuid: upload.fileUuid, fileHash: upload.fileHash || undefined,
    exists: Boolean(upload.exists), commandId: 95,
  }
  if (!response.fileUuid) throw new Error('private file upload response contained no file UUID')
  if (response.exists) return response
  const address = upload.addresses[0]
  const host = address?.host2 || address?.host1
  const port = address?.port2 || address?.port1 || upload.port
  response.extendInfo = fileUploadExt({
    selfUin, spec, fileUuid: response.fileUuid, checkKey: hex(spec.sha1),
    uploadKey: requiredBuffer(upload.uploadKey, 'private file media upload key'),
    host: host ? ipv4(host) : upload.host, port, group: false,
  })
  return response
}

export function encodeImageHighwayExt(upload: PreparedImageUpload, sha1Hex: string): Buffer {
  assertHash(sha1Hex, 'SHA-1', 40)
  if (!upload.ukey) throw new Error('image upload has no ukey')
  return binary(pb.ImageHighwayExtSchema, {
    fileUuid: upload.fileUuid,
    ukey: upload.ukey,
    network: { endpoints: upload.ipv4s.map(({ host, port }) => ({
      host: { enabled: true, host }, port,
    })) },
    msgInfoBodies: upload.msgInfoBodies,
    blockSize: HIGHWAY_BLOCK_SIZE,
    hash: { sha1: hex(sha1Hex) },
  })
}

function fileUploadExt(options: {
  selfUin: string
  peerUin?: number
  spec: DirectFileSpec
  fileUuid: string
  checkKey: Buffer
  uploadKey: Buffer
  host: string
  port: number
  group: boolean
}): Buffer {
  const selfUin = BigInt(numericUin(options.selfUin, 'self UIN'))
  if (!options.host || !options.port) throw new Error('file upload response contained no Highway endpoint')
  return binary(pb.FileHighwayExtSchema, {
    field1: 100, field2: 1, ...(!options.group ? { field3: 0 } : {}),
    entry: {
      business: {
        selfUin,
        ...(options.group ? {
          peerUin: BigInt(options.peerUin!), groupUin: BigInt(options.peerUin!),
        } : {}),
      },
      file: {
        size: BigInt(options.spec.size), md5: hex(options.spec.md5),
        checkKey: options.checkKey, md5Again: hex(options.spec.md5),
        fileUuid: options.fileUuid, uploadKey: options.uploadKey,
      },
      client: { field100: 3, field200: '100', field300: 3, version: '1.1.1', field600: 4 },
      name: { name: options.spec.name },
      network: { endpoint: { host: { kind: 1, host: options.host }, port: options.port } },
    },
    privateFile: options.group ? 0 : 1,
  })
}

export function encodeHighwayFrame(options: {
  selfUin: string
  commandId: number
  sequence: number
  ticket: Uint8Array
  fileSize: number
  offset: number
  fileMd5: string
  extendInfo: Uint8Array
  body: Uint8Array
}): Buffer {
  assertHash(options.fileMd5, 'MD5', 32)
  const head = binary(pb.HighwayRequestHeadSchema, {
    base: {
      version: 1, selfUin: options.selfUin, command: 'PicUp.DataUp',
      sequence: options.sequence, appId: HIGHWAY_APP_ID, dataFlag: 16, commandId: options.commandId,
    },
    segment: {
      fileSize: BigInt(options.fileSize), offset: BigInt(options.offset), length: options.body.length,
      ticket: options.ticket, chunkMd5: createHash('md5').update(options.body).digest(),
      fileMd5: hex(options.fileMd5),
    },
    extendInfo: options.extendInfo,
    field4: 0,
    loginSig: { field1: 8, appId: HIGHWAY_APP_ID },
  })
  const frame = Buffer.allocUnsafe(10 + head.length + options.body.length)
  frame[0] = 0x28
  frame.writeUInt32BE(head.length, 1)
  frame.writeUInt32BE(options.body.length, 5)
  head.copy(frame, 9)
  Buffer.from(options.body).copy(frame, 9 + head.length)
  frame[frame.length - 1] = 0x29
  return frame
}

export function decodeHighwayResponse(payload: Uint8Array): void {
  const buffer = Buffer.from(payload)
  if (buffer.length < 10 || buffer[0] !== 0x28 || buffer[buffer.length - 1] !== 0x29) {
    throw new Error('invalid Highway response frame')
  }
  const headLength = buffer.readUInt32BE(1)
  const bodyLength = buffer.readUInt32BE(5)
  if (9 + headLength + bodyLength + 1 !== buffer.length) throw new Error('truncated Highway response frame')
  const head = fromBinary(pb.HighwayResponseHeadSchema, buffer.subarray(9, 9 + headLength))
  const returnCode = head.segment?.returnCode ?? 0
  if (head.errorCode || returnCode) {
    throw new Error(`Highway upload rejected block: error=${head.errorCode} return=${returnCode}`)
  }
}

export function encodeDirectMessageRequest(
  chatType: 1 | 2,
  peerUid: string,
  peerUin: string,
  parts: DirectMessagePart[],
  options: { selfUid?: string, clientSequence?: bigint, random?: number, nowSeconds?: number } = {},
): PacketRequest {
  if (!parts.length) throw new Error('direct protocol message must contain at least one part')
  const files = parts.filter((part) => part.kind === 'file')
  const privateFile = chatType === 1 ? files[0] : undefined
  if (chatType === 1 && files.length) {
    if (parts.length !== 1 || files.length !== 1) {
      throw new Error('QQ private file messages cannot contain captions or other media')
    }
    if (!options.selfUid) throw new Error('QQ private file message requires the sender UID')
  }
  const routing = privateFile
    ? { privateFile: { peerUin: BigInt(numericUin(peerUin, 'QQ private peer')), field2: 4, peerUid } }
    : chatType === 2
      ? { group: { groupUin: BigInt(numericPeer(peerUin || peerUid)) } }
      : { c2c: { peerUin: BigInt(numericUin(peerUin, 'QQ private peer')), peerUid } }
  const body = privateFile
    ? { privateFile: privateFileContent(
        privateFile.spec, privateFile.upload, options.selfUid!, peerUid,
        options.nowSeconds ?? Math.floor(Date.now() / 1000),
      ) }
    : { richText: { elements: parts.flatMap((part) => directMessageElements(part, chatType)) } }
  return {
    command: 'MessageSvc.PbSendMsg',
    payload: binary(pb.SendMessageRequestSchema, {
      routing,
      content: { field1: 1, field2: 0, field3: 0, field4: 0 },
      body,
      clientSequence: options.clientSequence ?? randomPositiveInt64(),
      random: options.random ?? randomBytes(4).readUInt32BE(),
    }),
  }
}

export function decodeDirectMessageResponse(payload: Uint8Array): DirectMessageSendResponse {
  const response = fromBinary(pb.SendMessageResponseSchema, payload)
  if (response.result) throw new Error(`QQ protocol send failed: ${response.error} (${response.result})`)
  return {
    sendTime: response.sendTime,
    sequence: response.sequence,
    clientSequence: response.clientSequence,
  }
}

function directMessageElements(part: DirectMessagePart, chatType: 1 | 2): pb.Elem[] {
  if (part.kind === 'text') {
    return part.text ? [create(pb.ElemSchema, { text: { text: part.text } })] : []
  }
  if (part.kind === 'mention') {
    if (!part.text) return []
    const uin = optionalUnsigned(part.userUin)
    return [create(pb.ElemSchema, { text: {
      text: part.text,
      mention: binary(pb.MentionExtraSchema, {
        type: part.all ? 1 : 2, ...(uin === undefined ? {} : { uin: Number(uin) }),
        field5: 0, ...(part.userUid ? { uid: part.userUid } : {}),
      }),
    } })]
  }
  if (part.kind === 'face') return [directFaceElement(part.face)]
  if (part.kind === 'market-face') {
    const faceId = /^[\da-f]+$/i.test(part.face.emojiId) && part.face.emojiId.length % 2 === 0
      ? hex(part.face.emojiId)
      : Buffer.from(part.face.emojiId)
    return [create(pb.ElemSchema, { marketFace: {
      name: part.face.name.startsWith('[') ? part.face.name : `[${part.face.name}]`,
      itemType: 6, faceInfo: 1, faceId, packageId: part.face.packageId,
      subtype: 3, key: part.face.key, width: part.face.width ?? 300,
      height: part.face.height ?? 300, reserve: { field8: 1 },
    } })]
  }
  if (part.kind === 'reply') return [directReplyElement(part.reply, chatType)]
  if (part.kind === 'image') {
    const elements: pb.Elem[] = []
    if (part.upload.compatQMsg) {
      elements.push(create(pb.ElemSchema, chatType === 2
        ? { groupImage: part.upload.compatQMsg }
        : { c2cImage: part.upload.compatQMsg }))
    }
    elements.push(create(pb.ElemSchema, { common: {
      serviceType: 48, payload: part.upload.msgInfo, businessType: chatType === 2 ? 20 : 10,
    } }))
    return elements
  }
  if (chatType !== 2) throw new Error('private file must use the 0x211 message route')
  const extra = binary(pb.GroupFileExtraSchema, {
    type: 6, name: part.spec.name,
    body: { info: {
      type: 102, fileUuid: part.upload.fileUuid, size: BigInt(part.spec.size),
      name: part.spec.name, sha1: hex(part.spec.sha1), field7: '', md5: hex(part.spec.md5),
    } },
  })
  if (extra.length > 0xffff) throw new Error('group file message metadata is too large')
  const tlv = Buffer.allocUnsafe(extra.length + 3)
  tlv[0] = 1
  tlv.writeUInt16BE(extra.length, 1)
  extra.copy(tlv, 3)
  return [create(pb.ElemSchema, { trans: { type: 24, value: tlv } })]
}

function directFaceElement(face: DirectFaceSpec): pb.Elem {
  if (face.faceType === 3 || face.faceType === 4) {
    return create(pb.ElemSchema, { common: {
      serviceType: 37,
      payload: binary(pb.BigFaceExtraSchema, {
        ...(face.packId ? { packId: face.packId } : {}),
        ...(face.stickerId ? { stickerId: face.stickerId } : {}),
        faceId: face.faceId, sourceType: face.sourceType ?? 1, stickerType: face.stickerType ?? 0,
        ...(face.resultId ? { resultId: face.resultId } : {}), preview: '', randomType: 1,
      }),
      businessType: 1,
    } })
  }
  if (face.faceId < 260) return create(pb.ElemSchema, { face: { index: face.faceId } })
  return create(pb.ElemSchema, { common: {
    serviceType: 33,
    payload: binary(pb.SmallFaceExtraSchema, { faceId: face.faceId, preview: '', preview2: '' }),
    businessType: 1,
  } })
}

function directReplyElement(reply: DirectReplySpec, chatType: 1 | 2): pb.Elem {
  const messageId = optionalUnsigned(reply.messageId)
  const sequence = optionalUnsigned(chatType === 2 ? reply.sequence : reply.clientSequence ?? reply.sequence)
  const senderUin = optionalUnsigned(reply.senderUin)
  return create(pb.ElemSchema, { source: {
    originalSequences: sequence === undefined ? [] : [Number(sequence)],
    ...(senderUin === undefined ? {} : { senderUin }),
    ...(reply.time ? { time: reply.time } : {}),
    reserve: {
      ...(messageId === undefined ? {} : { messageId }),
      ...(reply.senderUid ? { senderUid: reply.senderUid } : {}),
      ...(reply.receiverUid ? { receiverUid: reply.receiverUid } : {}),
      ...(chatType === 1 && sequence !== undefined ? { friendSequence: Number(sequence) } : {}),
    },
    toUin: 0n,
  } })
}

function privateFileContent(
  spec: DirectFileSpec,
  upload: PreparedFileUpload,
  selfUid: string,
  peerUid: string,
  nowSeconds: number,
): pb.PrivateFileContent {
  assertFileSpec(spec)
  if (!upload.fileHash) throw new Error('private file upload response contained no file hash')
  if (!upload.privateMetadata) throw new Error('private file upload has no message metadata')
  const metadata = upload.privateMetadata
  return create(pb.PrivateFileContentSchema, {
    file: {
      field1: 0, fileUuid: upload.fileUuid, first10mMd5: hex(spec.file10MMd5),
      name: spec.name, size: BigInt(spec.size), field9: 1, field50: 0,
      expiresAt: nowSeconds + 7 * 24 * 60 * 60, fileHash: upload.fileHash,
    },
    details: { details: {
      field1: metadata.field1, fileUuid: upload.fileUuid, name: spec.name,
      field6: metadata.field6, field7: metadata.field7, field8: metadata.field8,
      timestamp1: metadata.timestamp1, fileHash: upload.fileHash,
      selfUid, peerUid,
    } },
  })
}

function binary<Desc extends DescMessage>(schema: Desc, init: MessageInitShape<Desc>): Buffer {
  return Buffer.from(toBinary(schema, create(schema, init)))
}

function encodeOidb(command: number, subCommand: number, body: Uint8Array, reserved: boolean): Buffer {
  return binary(pb.OidbEnvelopeSchema, {
    command, subCommand, body, reserved: reserved ? 1 : 0,
  })
}

function decodeOidb(payload: Uint8Array): Buffer {
  const envelope = fromBinary(pb.OidbEnvelopeSchema, payload)
  if (envelope.result) throw new Error(`QQ OIDB request failed: ${envelope.error} (${envelope.result})`)
  return requiredBuffer(envelope.body, 'OIDB response body')
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is missing`)
  return value
}

function requiredBuffer(value: Uint8Array | undefined, name: string): Buffer {
  if (!value?.length) throw new Error(`${name} is missing`)
  return Buffer.from(value)
}

function hex(value: string): Buffer {
  return Buffer.from(value, 'hex')
}

function optionalUnsigned(value: string | undefined): bigint | undefined {
  if (!value || !/^\d+$/.test(value)) return
  return BigInt(value)
}

function ipv4(value: number): string {
  const ip = value >>> 0
  return [ip & 0xff, (ip >>> 8) & 0xff, (ip >>> 16) & 0xff, (ip >>> 24) & 0xff].join('.')
}

function numericPeer(value: string): number {
  return numericUin(value, 'QQ group peer')
}

function numericUin(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a numeric UIN`)
  return parsed
}

function assertFileSpec(spec: DirectFileSpec): void {
  assertHash(spec.md5, 'MD5', 32)
  assertHash(spec.sha1, 'SHA-1', 40)
  assertHash(spec.file10MMd5, '10 MiB MD5', 32)
  if (!Number.isSafeInteger(spec.size) || spec.size < 0) {
    throw new Error('file size must be a non-negative safe integer')
  }
}

function assertHash(value: string, name: string, length: number): void {
  if (!new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value)) {
    throw new Error(`${name} must be ${length} hexadecimal characters`)
  }
}

function randomPositiveInt64(): bigint {
  return randomBytes(8).readBigUInt64BE() & 0x7fff_ffff_ffff_ffffn
}
