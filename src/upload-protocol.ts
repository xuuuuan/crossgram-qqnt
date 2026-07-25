import { createHash, randomBytes } from 'node:crypto'

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

export type DirectMessagePart =
  | { kind: 'text', text: string }
  | { kind: 'image', upload: PreparedImageUpload }
  | { kind: 'file', spec: DirectFileSpec, upload: PreparedFileUpload }

export interface DirectMessageSendResponse {
  sequence: bigint
  clientSequence: bigint
  sendTime: number
}

export function encodeHighwaySessionRequest(): PacketRequest {
  const httpConn = message([
    uint(3, 16), uint(4, 1), uint(6, 3),
    ...[1, 5, 10, 21].map((value) => uint(7, value)),
    uint(9, 2), uint(10, 9), uint(11, 8), string(15, '1.0.1'),
  ])
  return { command: 'HttpConn.0x6ff_501', payload: message([bytes(0x501, httpConn)]) }
}

export function decodeHighwaySessionResponse(payload: Uint8Array): HighwaySession {
  const root = requiredBytes(fields(payload), 0x501, 'HttpConn response')
  const response = fields(root)
  const ticket = requiredBytes(response, 1, 'Highway sigSession')
  const servers = allBytes(response, 3)
    .map((server) => fields(server))
    .filter((server) => number(server, 1) === 1)
    .flatMap((server) => allBytes(server, 2))
    .map((encoded) => {
      const address = fields(encoded)
      return {
        host: ipv4(fixed32(address, 2)),
        port: number(address, 3),
      }
    })
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
  if (!Number.isSafeInteger(spec.size) || spec.size < 0) throw new Error('image size must be a non-negative safe integer')
  const isGroup = chatType === 2
  const command = isGroup ? 0x11c4 : 0x11c5
  const sceneTarget = isGroup
    ? bytes(202, message([uint(1, numericPeer(peerUid))]))
    : bytes(201, message([uint(1, 2), string(2, peerUid)]))
  const scene = message([
    uint(101, 2), uint(102, 1), uint(200, chatType), sceneTarget,
  ])
  const fileInfo = message([
    uint(1, spec.size), string(2, spec.md5.toUpperCase()), string(3, spec.sha1.toUpperCase()),
    string(4, spec.name), bytes(5, message([uint(1, 1), uint(2, spec.picType)])),
    uint(6, spec.width ?? 0), uint(7, spec.height ?? 0), uint(9, 1),
  ])
  const subtype = spec.picSubType ?? 0
  const pic = message([
    uint(1, subtype), string(2, '[图片]'),
    bytes(isGroup ? 12 : 11, message([uint(1, subtype)])),
  ])
  const upload = message([
    bytes(1, message([bytes(1, fileInfo), uint(2, 0)])),
    bool(2, true), bool(3, false), uint(4, randomPositiveInt64()), uint(5, chatType),
    bytes(6, message([
      bytes(1, pic), bytes(2, message([bytes(3, Buffer.alloc(0))])),
      bytes(3, message([bytes(11, Buffer.alloc(0)), bytes(12, Buffer.alloc(0)), bytes(13, Buffer.alloc(0))])),
    ])),
    uint(7, 0), bool(8, false),
  ])
  const body = message([
    bytes(1, message([
      bytes(1, message([uint(1, 1), uint(2, 100)])),
      bytes(2, scene), bytes(3, message([uint(1, 2)])),
    ])),
    bytes(2, upload),
  ])
  return {
    command: `OidbSvcTrpcTcp.0x${command.toString(16)}_100`,
    payload: oidb(command, 100, body, true),
  }
}

export function decodeImageUploadResponse(payload: Uint8Array): PreparedImageUpload {
  const body = decodeOidb(payload)
  const root = fields(body)
  const responseHead = optionalBytes(root, 1)
  if (responseHead) {
    const head = fields(responseHead)
    const code = number(head, 2)
    if (code) throw new Error(`QQ image upload preparation failed: ${text(head, 3)} (${code})`)
  }
  const upload = fields(requiredBytes(root, 2, 'image upload response'))
  const msgInfo = fields(requiredBytes(upload, 6, 'image MsgInfo'))
  const msgInfoBodies = allBytes(msgInfo, 1)
  const firstBody = fields(msgInfoBodies[0] ?? missing('image MsgInfo body'))
  const index = fields(requiredBytes(firstBody, 1, 'image index'))
  const fileUuid = text(index, 2)
  if (!fileUuid) throw new Error('image upload response contained no file UUID')
  const ipv4s = allBytes(upload, 3).map((encoded) => {
    const address = fields(encoded)
    return { host: ipv4(number(address, 1)), port: number(address, 2) }
  })
  return {
    ukey: text(upload, 1) || undefined,
    fileUuid,
    ipv4s,
    msgInfo: requiredBytes(upload, 6, 'image MsgInfo'),
    msgInfoBodies,
    compatQMsg: optionalBytes(upload, 8),
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
  const body = message([
    uint(1, 800), uint(2, 0), bytes(10, message([
      string(10, selfUid), string(20, peerUid), string(30, fileUuid), string(40, fileHash),
    ])),
    uint(101, 3), uint(102, 1), uint(200, 1),
  ])
  return { command: 'OidbSvcTrpcTcp.0xe37_800', payload: oidb(0xe37, 800, body, false) }
}

export function decodePrivateFileMetadataResponse(payload: Uint8Array): PrivateFileMetadata {
  const root = fields(decodeOidb(payload))
  const response = fields(requiredBytes(root, 10, 'private file metadata response'))
  const code = number(response, 10)
  if (code) throw new Error(`QQ private file metadata failed (${code})`)
  const metadata = fields(requiredBytes(response, 30, 'private file metadata'))
  return {
    field1: number(metadata, 110),
    field6: number(metadata, 3),
    field7: requiredBytes(metadata, 101, 'private file metadata field 101'),
    field8: requiredBytes(metadata, 100, 'private file metadata field 100'),
    timestamp1: number(metadata, 130),
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
    const group = numericPeer(peerUid)
    const upload = message([
      uint(1, group), uint(2, 4), uint(3, 102), uint(4, 6), string(5, '/'),
      string(6, spec.name), string(7, `/${spec.name}`), uint(8, spec.size),
      bytes(9, Buffer.from(spec.sha1, 'hex')), bytes(10, Buffer.alloc(0)),
      bytes(11, Buffer.from(spec.md5, 'hex')), bool(15, true),
    ])
    return {
      command: 'OidbSvcTrpcTcp.0x6d6_0',
      payload: oidb(0x6d6, 0, message([bytes(1, upload)]), true),
    }
  }
  if (!selfUid || !peerUid) throw new Error('private file upload requires self and peer UID')
  const upload = message([
    string(10, selfUid), string(20, peerUid), uint(30, spec.size), string(40, spec.name),
    bytes(50, Buffer.from(spec.file10MMd5, 'hex')), bytes(60, Buffer.from(spec.sha1, 'hex')),
    string(70, '/'), bytes(110, Buffer.from(spec.md5, 'hex')), bytes(120, Buffer.alloc(0)),
  ])
  return {
    command: 'OidbSvcTrpcTcp.0xe37_1700',
    payload: oidb(0xe37, 1700, message([
      uint(1, 1700), uint(2, 0), bytes(19, upload), uint(101, 3), uint(102, 1), uint(200, 1),
    ]), false),
  }
}

export function decodeFileUploadResponse(
  chatType: 1 | 2,
  payload: Uint8Array,
  selfUin: string,
  peerUid: string,
  spec: DirectFileSpec,
): PreparedFileUpload {
  assertFileSpec(spec)
  const root = fields(decodeOidb(payload))
  if (chatType === 2) {
    const upload = fields(requiredBytes(root, 1, 'group file upload response'))
    const returnCode = number(upload, 1)
    if (returnCode) throw new Error(`QQ group file upload preparation failed: ${text(upload, 3) || text(upload, 2)} (${returnCode})`)
    const response: PreparedFileUpload = {
      fileUuid: text(upload, 7), exists: Boolean(number(upload, 10)), commandId: 71 as const,
    }
    if (!response.fileUuid) throw new Error('group file upload response contained no file UUID')
    if (response.exists) return response
    const checkKey = requiredBytes(upload, 8, 'group file check key')
    const uploadKey = requiredBytes(upload, 9, 'group file upload key')
    response.extendInfo = fileUploadExt({
      selfUin, peerUin: numericPeer(peerUid), spec, fileUuid: response.fileUuid,
      checkKey, uploadKey, host: text(upload, 4), port: number(upload, 14), group: true,
    })
    return response
  }
  const upload = fields(requiredBytes(root, 19, 'private file upload response'))
  const returnCode = number(upload, 10)
  if (returnCode) throw new Error(`QQ private file upload preparation failed: ${text(upload, 20)} (${returnCode})`)
  const response: PreparedFileUpload = {
    fileUuid: text(upload, 90), fileHash: text(upload, 200) || undefined,
    exists: Boolean(number(upload, 110)), commandId: 95,
  }
  if (!response.fileUuid) throw new Error('private file upload response contained no file UUID')
  if (response.exists) return response
  const mediaAddressBytes = allBytes(upload, 210)[0]
  const mediaAddress = mediaAddressBytes ? fields(mediaAddressBytes) : []
  const mediaIp = number(mediaAddress, 3) || number(mediaAddress, 1)
  response.extendInfo = fileUploadExt({
    selfUin, spec, fileUuid: response.fileUuid, checkKey: Buffer.from(spec.sha1, 'hex'),
    uploadKey: requiredBytes(upload, 220, 'private file media upload key'),
    host: mediaIp ? ipv4(mediaIp) : text(upload, 60),
    port: number(mediaAddress, 4) || number(mediaAddress, 2) || number(upload, 80),
    group: false,
  })
  return response
}

export function encodeImageHighwayExt(upload: PreparedImageUpload, sha1Hex: string): Buffer {
  assertHash(sha1Hex, 'SHA-1', 40)
  if (!upload.ukey) throw new Error('image upload has no ukey')
  const network = message(upload.ipv4s.map(({ host, port }) => bytes(1, message([
    bytes(1, message([bool(1, true), string(2, host)])), uint(2, port),
  ]))))
  return message([
    string(1, upload.fileUuid), string(2, upload.ukey), bytes(5, network),
    ...upload.msgInfoBodies.map((body) => bytes(6, body)),
    uint(10, HIGHWAY_BLOCK_SIZE), bytes(11, message([bytes(1, Buffer.from(sha1Hex, 'hex'))])),
  ])
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
  const selfUin = numericUin(options.selfUin, 'self UIN')
  if (!options.host || !options.port) throw new Error('file upload response contained no Highway endpoint')
  const business = message([
    uint(100, selfUin),
    ...(options.group ? [uint(200, options.peerUin!), uint(400, options.peerUin!)] : []),
  ])
  const entry = message([
    bytes(100, business),
    bytes(200, message([
      uint(100, options.spec.size), bytes(200, Buffer.from(options.spec.md5, 'hex')),
      bytes(300, options.checkKey), bytes(400, Buffer.from(options.spec.md5, 'hex')),
      string(600, options.fileUuid), bytes(700, options.uploadKey),
    ])),
    bytes(300, message([
      uint(100, 3), string(200, '100'), uint(300, 3), string(400, '1.1.1'), uint(600, 4),
    ])),
    bytes(400, message([string(100, options.spec.name)])),
    bytes(500, message([bytes(200, message([
      bytes(1, message([uint(1, 1), string(2, options.host)])), uint(2, options.port),
    ]))])),
  ])
  return message([
    uint(1, 100), uint(2, 1), ...(!options.group ? [uint(3, 0)] : []),
    bytes(100, entry), uint(200, options.group ? 0 : 1),
  ])
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
  const chunkMd5 = createHash('md5').update(options.body).digest()
  const base = message([
    uint(1, 1), string(2, options.selfUin), string(3, 'PicUp.DataUp'),
    uint(4, options.sequence), uint(6, HIGHWAY_APP_ID), uint(7, 16), uint(8, options.commandId),
  ])
  const segment = message([
    uint(2, options.fileSize), uint(3, options.offset), uint(4, options.body.length),
    bytes(6, options.ticket), bytes(8, chunkMd5), bytes(9, Buffer.from(options.fileMd5, 'hex')),
  ])
  const head = message([
    bytes(1, base), bytes(2, segment), bytes(3, options.extendInfo), uint(4, 0),
    bytes(5, message([uint(1, 8), uint(3, HIGHWAY_APP_ID)])),
  ])
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
  const head = fields(buffer.subarray(9, 9 + headLength))
  const errorCode = number(head, 3)
  const segment = optionalBytes(head, 2)
  const returnCode = segment ? number(fields(segment), 5) : 0
  if (errorCode || returnCode) throw new Error(`Highway upload rejected block: error=${errorCode} return=${returnCode}`)
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
  const clientSequence = options.clientSequence ?? randomPositiveInt64()
  const random = options.random ?? randomBytes(4).readUInt32BE()
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  const route = privateFile
    ? bytes(15, message([uint(1, numericUin(peerUin, 'QQ private peer')), uint(2, 4), string(8, peerUid)]))
    : chatType === 2
      ? bytes(2, message([uint(1, numericPeer(peerUin || peerUid))]))
      : bytes(1, message([uint(1, numericUin(peerUin, 'QQ private peer')), string(2, peerUid)]))
  const contentHead = message([uint(1, 1), uint(2, 0), uint(3, 0), uint(4, 0)])
  const body = privateFile
    ? message([bytes(2, privateFileContent(privateFile.spec, privateFile.upload, options.selfUid!, peerUid, nowSeconds))])
    : message([bytes(1, message(parts.flatMap((part) => directMessageElements(part, chatType))))])
  return {
    command: 'MessageSvc.PbSendMsg',
    payload: message([
      bytes(1, message([route])), bytes(2, contentHead), bytes(3, body),
      uint(4, clientSequence), uint(5, random),
    ]),
  }
}

export function decodeDirectMessageResponse(payload: Uint8Array): DirectMessageSendResponse {
  const response = fields(payload)
  const result = number(response, 1)
  if (result) throw new Error(`QQ protocol send failed: ${text(response, 2)} (${result})`)
  return {
    sendTime: number(response, 3),
    sequence: bigintValue(response, 11),
    clientSequence: bigintValue(response, 14),
  }
}

function directMessageElements(part: DirectMessagePart, chatType: 1 | 2): Buffer[] {
  if (part.kind === 'text') return part.text ? [bytes(2, message([bytes(1, message([string(1, part.text)]))]))] : []
  if (part.kind === 'image') {
    const compat = part.upload.compatQMsg
      ? [bytes(2, message([bytes(chatType === 2 ? 8 : 4, part.upload.compatQMsg)]))]
      : []
    const common = message([uint(1, 48), bytes(2, part.upload.msgInfo), uint(3, chatType === 2 ? 20 : 10)])
    return [...compat, bytes(2, message([bytes(53, common)]))]
  }
  if (chatType !== 2) throw new Error('private file must use the 0x211 message route')
  const info = message([
    uint(1, 102), string(2, part.upload.fileUuid), uint(3, part.spec.size), string(4, part.spec.name),
    bytes(6, Buffer.from(part.spec.sha1, 'hex')), string(7, ''), bytes(8, Buffer.from(part.spec.md5, 'hex')),
  ])
  const extra = message([uint(1, 6), string(2, part.spec.name), bytes(7, message([bytes(2, info)]))])
  if (extra.length > 0xffff) throw new Error('group file message metadata is too large')
  const tlv = Buffer.allocUnsafe(extra.length + 3)
  tlv[0] = 1
  tlv.writeUInt16BE(extra.length, 1)
  extra.copy(tlv, 3)
  return [bytes(2, message([bytes(5, message([uint(1, 24), bytes(2, tlv)]))]))]
}

function privateFileContent(
  spec: DirectFileSpec,
  upload: PreparedFileUpload,
  selfUid: string,
  peerUid: string,
  nowSeconds: number,
): Buffer {
  assertFileSpec(spec)
  if (!upload.fileHash) throw new Error('private file upload response contained no file hash')
  if (!upload.privateMetadata) throw new Error('private file upload has no message metadata')
  const metadata = upload.privateMetadata
  const file = message([
    uint(1, 0), string(3, upload.fileUuid), bytes(4, Buffer.from(spec.file10MMd5, 'hex')),
    string(5, spec.name), uint(6, spec.size), uint(9, 1), uint(50, 0),
    uint(55, nowSeconds + 7 * 24 * 60 * 60), string(57, upload.fileHash),
  ])
  const details = message([
    uint(1, metadata.field1), string(4, upload.fileUuid), string(5, spec.name),
    uint(6, metadata.field6), bytes(7, metadata.field7), bytes(8, metadata.field8),
    uint(9, metadata.timestamp1), string(14, upload.fileHash), string(15, selfUid), string(16, peerUid),
  ])
  return message([bytes(1, file), bytes(6, message([bytes(2, details)]))])
}

type WireValue = bigint | Buffer
interface WireField { tag: number, wire: number, value: WireValue }

function fields(input: Uint8Array): WireField[] {
  const buffer = Buffer.from(input)
  const result: WireField[] = []
  let offset = 0
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset); offset = key.offset
    const tag = Number(key.value >> 3n)
    const wire = Number(key.value & 7n)
    if (!tag) throw new Error('protobuf field tag must not be zero')
    if (wire === 0) {
      const value = readVarint(buffer, offset); offset = value.offset
      result.push({ tag, wire, value: value.value })
    } else if (wire === 2) {
      const length = readVarint(buffer, offset); offset = length.offset
      const size = Number(length.value)
      if (!Number.isSafeInteger(size) || offset + size > buffer.length) throw new Error('truncated protobuf bytes field')
      result.push({ tag, wire, value: buffer.subarray(offset, offset + size) })
      offset += size
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) throw new Error('truncated protobuf fixed32 field')
      result.push({ tag, wire, value: BigInt(buffer.readUInt32LE(offset)) })
      offset += 4
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) throw new Error('truncated protobuf fixed64 field')
      result.push({ tag, wire, value: buffer.subarray(offset, offset + 8) })
      offset += 8
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`)
    }
  }
  return result
}

function message(parts: Uint8Array[]): Buffer { return Buffer.concat(parts.map(Buffer.from)) }
function uint(tag: number, value: number | bigint): Buffer {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`invalid uint field ${tag}`)
  return Buffer.concat([varint(BigInt(tag << 3)), varint(BigInt(value))])
}
function bool(tag: number, value: boolean): Buffer { return uint(tag, value ? 1 : 0) }
function string(tag: number, value: string): Buffer { return bytes(tag, Buffer.from(value)) }
function bytes(tag: number, value: Uint8Array): Buffer {
  return Buffer.concat([varint(BigInt((tag << 3) | 2)), varint(BigInt(value.length)), Buffer.from(value)])
}
function varint(value: bigint): Buffer {
  if (value < 0n) throw new Error('negative protobuf varint is unsupported')
  const output: number[] = []
  do {
    let byte = Number(value & 0x7fn); value >>= 7n
    if (value) byte |= 0x80
    output.push(byte)
  } while (value)
  return Buffer.from(output)
}
function readVarint(buffer: Buffer, start: number): { value: bigint, offset: number } {
  let value = 0n
  let shift = 0n
  for (let offset = start; offset < buffer.length && offset < start + 10; offset++) {
    const byte = buffer[offset]!
    value |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return { value, offset: offset + 1 }
    shift += 7n
  }
  throw new Error('invalid protobuf varint')
}

function oidb(command: number, subCommand: number, body: Uint8Array, reserved: boolean): Buffer {
  return message([uint(1, command), uint(2, subCommand), bytes(4, body), uint(12, reserved ? 1 : 0)])
}
function decodeOidb(payload: Uint8Array): Buffer {
  const envelope = fields(payload)
  const code = number(envelope, 3)
  if (code) throw new Error(`QQ OIDB request failed: ${text(envelope, 5)} (${code})`)
  return requiredBytes(envelope, 4, 'OIDB response body')
}
function allBytes(input: WireField[], tag: number): Buffer[] {
  return input.filter((field) => field.tag === tag && field.wire === 2).map((field) => Buffer.from(field.value as Buffer))
}
function optionalBytes(input: WireField[], tag: number): Buffer | undefined { return allBytes(input, tag)[0] }
function requiredBytes(input: WireField[], tag: number, name: string): Buffer {
  return optionalBytes(input, tag) ?? missing(name)
}
function number(input: WireField[], tag: number): number {
  const field = input.find((candidate) => candidate.tag === tag && (candidate.wire === 0 || candidate.wire === 5))
  return field ? Number(field.value) : 0
}
function bigintValue(input: WireField[], tag: number): bigint {
  const field = input.find((candidate) => candidate.tag === tag && candidate.wire === 0)
  return field ? field.value as bigint : 0n
}
function fixed32(input: WireField[], tag: number): number { return number(input, tag) >>> 0 }
function text(input: WireField[], tag: number): string { return optionalBytes(input, tag)?.toString() ?? '' }
function missing(name: string): never { throw new Error(`${name} is missing`) }
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
  if (!Number.isSafeInteger(spec.size) || spec.size < 0) throw new Error('file size must be a non-negative safe integer')
}
function assertHash(value: string, name: string, length: number): void {
  if (!new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value)) throw new Error(`${name} must be ${length} hexadecimal characters`)
}
function randomPositiveInt64(): bigint { return randomBytes(8).readBigUInt64BE() & 0x7fff_ffff_ffff_ffffn }
