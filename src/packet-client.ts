import type { KernelMsgService } from './kernel-types.js'
import { log } from './log.js'
import { loadPacketAddon, type PacketAddon } from './packet-addon.js'
import type { NativeDirectUrl, NativePacketRequest, NativeSysFace } from './packet-addon.js'
import type { QQMediaLocator } from './protocol.js'
import {
  decodeDirectMessageResponse, decodeFileUploadResponse, decodeGroupFileFeedResponse, decodeHighwayResponse, decodeHighwaySessionResponse,
  decodeImageUploadResponse, decodePrivateFileMetadataResponse, decodeVideoUploadResponse, encodeDirectMessageRequest,
  encodeFileUploadRequest, encodeGroupFileFeedRequest, encodeHighwayFrame, encodeHighwaySessionRequest, encodeImageHighwayExt,
  encodeImageUploadRequest, encodePrivateFileMetadataRequest, encodeVideoHighwayExt, encodeVideoUploadRequest,
  HIGHWAY_BLOCK_SIZE, type DirectFileSpec, type DirectImageSpec, type DirectVideoSpec,
  type DirectVideoThumbnailSpec, type HighwaySession,
  type DirectMessagePart, type DirectMessageSendResponse, type PreparedFileUpload, type PreparedImageUpload,
  type PreparedVideoUpload, videoThumbnailSpec, VIDEO_THUMBNAIL_BYTES,
} from './upload-protocol.js'

const PRIVATE_IMAGE_APP_ID = '1406'
const PRIVATE_IMAGE_RKEY_KIND = 10
const GROUP_IMAGE_RKEY_KIND = 20
const QQ_IMAGE_ORIGIN = 'https://multimedia.nt.qq.com.cn'
const DEFAULT_PACKET_TIMEOUT_MS = 10_000

type PacketResponse = Buffer | Uint8Array | {
  result?: number
  errMsg?: string
  rspbuffer?: Buffer | Uint8Array
}

export interface QQPacketClientOptions {
  addon?: PacketAddon
  loadAddon?: () => PacketAddon
  now?: () => number
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

interface RkeyCache {
  expiresAt: number
  values: Map<number, string>
}

export interface QQDirectUrl {
  url: string
  expiresAt: number
}

export interface DirectHighwayUpload {
  session: HighwaySession
  extendInfo: Buffer
  commandId: number
  sequenceStart: number
}

export interface PreparedDirectUpload<T> {
  upload: T
  highway?: DirectHighwayUpload
}

export interface PreparedDirectVideoUpload extends PreparedDirectUpload<PreparedVideoUpload> {
  thumbnail: DirectVideoThumbnailSpec
  thumbnailHighway?: DirectHighwayUpload
}

/** Sends OIDB packets through QQNT's native message-service binding. */
export class QQPacketClient {
  private readonly loadAddon: () => PacketAddon
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch
  private cache?: RkeyCache
  private refresh?: Promise<RkeyCache>
  private readonly directUrls = new Map<string, QQDirectUrl>()
  private readonly directUrlRefreshes = new Map<string, Promise<QQDirectUrl | undefined>>()
  private sysFaces?: Map<string, NativeSysFace>
  private sysFaceRefresh?: Promise<Map<string, NativeSysFace>>
  private located = false
  private highwaySession?: { value: HighwaySession, createdAt: number }
  private highwaySessionRefresh?: Promise<HighwaySession>
  private highwaySequence = 0

  constructor(
    private readonly msgService: Pick<KernelMsgService, 'sendSsoCmdReqByContend'>,
    options: QQPacketClientOptions = {},
  ) {
    this.loadAddon = options.addon ? () => options.addon! : options.loadAddon ?? loadPacketAddon
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PACKET_TIMEOUT_MS
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  async uploadImage(
    chatType: 1 | 2,
    peerUid: string,
    selfUin: string,
    spec: DirectImageSpec,
    source: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<PreparedImageUpload> {
    const plan = await this.prepareImageUpload(chatType, peerUid, spec)
    const upload = plan.upload
    const chunks = exactBlocks(source, spec.size, HIGHWAY_BLOCK_SIZE, signal)
    if (!plan.highway) {
      for await (const _chunk of chunks) { /* drain a fast-upload request body */ }
      return upload
    }
    const { session, extendInfo, commandId, sequenceStart } = plan.highway
    let offset = 0
    let blockIndex = 0
    for await (const chunk of chunks) {
      const frame = encodeHighwayFrame({
        selfUin, commandId, sequence: sequenceStart + blockIndex++, ticket: session.ticket,
        fileSize: spec.size, offset, fileMd5: spec.md5, extendInfo, body: chunk,
      })
      await this.uploadHighwayBlock(session, selfUin, frame, signal)
      offset += chunk.length
    }
    return upload
  }

  async prepareImageUpload(
    chatType: 1 | 2,
    peerUid: string,
    spec: DirectImageSpec,
  ): Promise<PreparedDirectUpload<PreparedImageUpload>> {
    const addon = this.loadAddon()
    const request = encodeImageUploadRequest(chatType, peerUid, spec)
    const upload = decodeImageUploadResponse(await this.sendPacket(addon, request))
    if (!upload.ukey) return { upload }
    return {
      upload,
      highway: {
        session: await this.getHighwaySession(addon),
        extendInfo: encodeImageHighwayExt(upload, spec.sha1),
        commandId: chatType === 2 ? 1004 : 1003,
        sequenceStart: this.reserveHighwaySequences(spec.size),
      },
    }
  }

  async uploadFile(
    chatType: 1 | 2,
    peerUid: string,
    selfUin: string,
    selfUid: string,
    spec: DirectFileSpec,
    source: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<PreparedFileUpload> {
    const plan = await this.prepareFileUpload(chatType, peerUid, selfUin, selfUid, spec)
    const upload = plan.upload
    const chunks = exactBlocks(source, spec.size, HIGHWAY_BLOCK_SIZE, signal)
    if (!plan.highway) {
      for await (const _chunk of chunks) { /* drain a fast-upload request body */ }
    } else {
      const { session, extendInfo, commandId, sequenceStart } = plan.highway
      let offset = 0
      let blockIndex = 0
      for await (const chunk of chunks) {
        const frame = encodeHighwayFrame({
          selfUin, commandId, sequence: sequenceStart + blockIndex++,
          ticket: session.ticket, fileSize: spec.size, offset,
          fileMd5: spec.md5, extendInfo, body: chunk,
        })
        await this.uploadHighwayBlock(session, selfUin, frame, signal)
        offset += chunk.length
      }
    }
    await this.completeFileUpload(chatType, peerUid, selfUid, upload)
    return upload
  }

  async prepareFileUpload(
    chatType: 1 | 2,
    peerUid: string,
    selfUin: string,
    selfUid: string,
    spec: DirectFileSpec,
  ): Promise<PreparedDirectUpload<PreparedFileUpload>> {
    const addon = this.loadAddon()
    const request = encodeFileUploadRequest(chatType, peerUid, selfUid, spec)
    const upload = decodeFileUploadResponse(
      chatType, await this.sendPacket(addon, request), selfUin, peerUid, spec,
    )
    if (upload.exists) return { upload }
    if (!upload.extendInfo) throw new Error('file upload response has no Highway metadata')
    return {
      upload,
      highway: {
        session: await this.getHighwaySession(addon),
        extendInfo: upload.extendInfo,
        commandId: upload.commandId,
        sequenceStart: this.reserveHighwaySequences(spec.size),
      },
    }
  }

  async completeFileUpload(
    chatType: 1 | 2,
    peerUid: string,
    selfUid: string,
    upload: PreparedFileUpload,
  ): Promise<void> {
    if (chatType !== 1) return
    if (!upload.fileHash) throw new Error('private file upload response contained no file hash')
    const metadataRequest = encodePrivateFileMetadataRequest(
      selfUid, peerUid, upload.fileUuid, upload.fileHash,
    )
    upload.privateMetadata = decodePrivateFileMetadataResponse(
      await this.sendPacket(this.loadAddon(), metadataRequest),
    )
  }

  async sendDirectMessage(
    chatType: 1 | 2,
    peerUid: string,
    peerUin: string,
    parts: DirectMessagePart[],
    selfUid: string,
  ): Promise<DirectMessageSendResponse> {
    const addon = this.loadAddon()
    const request = encodeDirectMessageRequest(chatType, peerUid, peerUin, parts, { selfUid })
    const response = decodeDirectMessageResponse(await this.sendPacket(addon, request))
    log('info', `QQ protocol message accepted conversation=${peerUid} sequence=${response.sequence} clientSequence=${response.clientSequence}`)
    return response
  }

  async uploadVideo(
    chatType: 1 | 2,
    peerUid: string,
    selfUin: string,
    spec: DirectVideoSpec,
    source: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<PreparedVideoUpload> {
    if (spec.thumbnail) {
      throw new Error('direct video upload with a custom thumbnail requires a prepared CDN upload plan')
    }
    const plan = await this.prepareVideoUpload(chatType, peerUid, spec)
    const chunks = exactBlocks(source, spec.size, HIGHWAY_BLOCK_SIZE, signal)
    if (plan.highway) {
      await this.uploadHighwaySource(plan.highway, selfUin, spec.size, spec.md5, chunks, signal)
    } else {
      for await (const _chunk of chunks) { /* drain a fast-upload request body */ }
    }
    if (plan.thumbnailHighway) {
      await this.uploadHighwaySource(
        plan.thumbnailHighway,
        selfUin,
        plan.thumbnail.size,
        plan.thumbnail.md5,
        [VIDEO_THUMBNAIL_BYTES],
        signal,
      )
    }
    return plan.upload
  }

  async prepareVideoUpload(
    chatType: 1 | 2,
    peerUid: string,
    spec: DirectVideoSpec,
  ): Promise<PreparedDirectVideoUpload> {
    const addon = this.loadAddon()
    const thumbnail = videoThumbnailSpec(spec)
    const request = encodeVideoUploadRequest(chatType, peerUid, spec)
    const upload = decodeVideoUploadResponse(await this.sendPacket(addon, request))
    if (!upload.videoUkey && !upload.thumbnailUkey) return { upload, thumbnail }
    const session = await this.getHighwaySession(addon)
    return {
      upload,
      thumbnail,
      ...(upload.videoUkey ? { highway: {
        session,
        extendInfo: encodeVideoHighwayExt(upload, 'video', spec.sha1),
        commandId: chatType === 2 ? 1005 : 1001,
        sequenceStart: this.reserveHighwaySequences(spec.size),
      } } : {}),
      ...(upload.thumbnailUkey ? { thumbnailHighway: {
        session,
        extendInfo: encodeVideoHighwayExt(upload, 'thumbnail', thumbnail.sha1),
        commandId: chatType === 2 ? 1006 : 1002,
        sequenceStart: this.reserveHighwaySequences(thumbnail.size),
      } } : {}),
    }
  }

  async publishGroupFile(peerUin: string, fileUuid: string): Promise<{ published: true }> {
    const addon = this.loadAddon()
    const request = encodeGroupFileFeedRequest(peerUin, fileUuid)
    decodeGroupFileFeedResponse(await this.sendPacket(addon, request))
    log('info', `QQ protocol group file published conversation=${peerUin} file=${fileUuid}`)
    return { published: true }
  }

  private async uploadHighwaySource(
    highway: DirectHighwayUpload,
    selfUin: string,
    fileSize: number,
    fileMd5: string,
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<void> {
    let offset = 0
    let blockIndex = 0
    for await (const chunk of source) {
      const frame = encodeHighwayFrame({
        selfUin,
        commandId: highway.commandId,
        sequence: highway.sequenceStart + blockIndex++,
        ticket: highway.session.ticket,
        fileSize,
        offset,
        fileMd5,
        extendInfo: highway.extendInfo,
        body: chunk,
      })
      await this.uploadHighwayBlock(highway.session, selfUin, frame, signal)
      offset += chunk.length
    }
  }

  async getImageDirectUrl(locator: QQMediaLocator): Promise<string | undefined> {
    if (locator.kind !== 'image' || !locator.originImageUrl) return
    try {
      // Current QQNT builds expose originImageUrl as /download?... while some
      // older builds include the multimedia host. Normalize both shapes before
      // selecting and appending the refreshed RKey.
      const original = new URL(locator.originImageUrl, QQ_IMAGE_ORIGIN)
      if (locator.imageSpec !== undefined) {
        original.searchParams.set('spec', String(locator.imageSpec))
      }
      const kind = original.searchParams.get('appid') === PRIVATE_IMAGE_APP_ID
        ? PRIVATE_IMAGE_RKEY_KIND
        : GROUP_IMAGE_RKEY_KIND
      const rkeys = await this.getRkeys()
      const rkey = rkeys.get(kind)
      if (!rkey) throw new Error(`FetchRkey response did not contain kind ${kind}`)
      return this.loadAddon().refreshImageUrl(original.toString(), rkey)
    } catch (error) {
      log('warn', `QQ image direct URL unavailable message=${locator.messageId} element=${locator.elementId}: ${errorMessage(error)}`)
      return
    }
  }

  async getSysFace(faceId: string): Promise<NativeSysFace | undefined> {
    if (!this.sysFaces) {
      this.sysFaceRefresh ??= this.fetchSysFaces().finally(() => {
        this.sysFaceRefresh = undefined
      })
      await this.sysFaceRefresh
    }
    return this.sysFaces?.get(faceId)
  }

  private async fetchSysFaces(): Promise<Map<string, NativeSysFace>> {
    const addon = this.loadAddon()
    const request = addon.encodeFetchSysFacesRequest()
    const faces = addon.decodeFetchSysFacesResponse(await this.sendPacket(addon, request))
    if (!faces.length) throw new Error('FetchSysFaces response was empty')
    const catalog = new Map(faces.filter((face) => face.faceId).map((face) => [face.faceId, face]))
    if (!catalog.size) throw new Error('FetchSysFaces response contained no usable faces')
    this.sysFaces = catalog
    return catalog
  }

  async getMediaDirectUrl(locator: QQMediaLocator, selfUid: string): Promise<QQDirectUrl | undefined> {
    if (locator.avatarUrl) {
      const url = httpUrl(locator.avatarUrl)
      return url ? { url, expiresAt: Number.MAX_SAFE_INTEGER } : undefined
    }
    if (locator.avatarUin) {
      if (!/^\d+$/.test(locator.avatarUin)) return
      const url = new URL('https://q1.qlogo.cn/g')
      url.search = new URLSearchParams({ b: 'qq', nk: locator.avatarUin, s: '640' }).toString()
      return { url: url.toString(), expiresAt: Number.MAX_SAFE_INTEGER }
    }
    if (locator.kind === 'image') {
      const url = await this.getImageDirectUrl(locator)
      return url ? { url, expiresAt: this.cache?.expiresAt ?? this.now() } : undefined
    }
    if (!locator.fileUuid) return
    const key = JSON.stringify([
      locator.chatType, locator.peerUid, locator.fileUuid,
      locator.videoCodecFormat === undefined ? 'file' : 'video', locator.file10MMd5 ?? '',
    ])
    const cached = this.directUrls.get(key)
    if (cached && this.now() < cached.expiresAt) return cached
    const active = this.directUrlRefreshes.get(key)
    if (active) return active
    const refresh = this.fetchMediaDirectUrl(locator, selfUid)
      .then((value) => {
        if (value) this.rememberDirectUrl(key, value)
        return value
      })
      .finally(() => this.directUrlRefreshes.delete(key))
    this.directUrlRefreshes.set(key, refresh)
    return refresh
  }

  private async fetchMediaDirectUrl(locator: QQMediaLocator, selfUid: string): Promise<QQDirectUrl | undefined> {
    try {
      const addon = this.loadAddon()
      let request: NativePacketRequest
      let decode: (payload: Buffer) => NativeDirectUrl
      if (locator.videoCodecFormat !== undefined) {
        request = addon.encodeVideoDownloadRequest(locator.chatType, locator.peerUid, selfUid, locator.fileUuid!)
        decode = addon.decodeVideoDownloadResponse.bind(addon)
      } else if (locator.chatType === 2) {
        request = addon.encodeGroupFileDownloadRequest(locator.peerUid, locator.fileUuid!)
        decode = addon.decodeGroupFileDownloadResponse.bind(addon)
      } else {
        if (!locator.file10MMd5) throw new Error('private QQ file locator has no 10 MiB MD5')
        request = addon.encodePrivateFileDownloadRequest(selfUid, locator.fileUuid!, locator.file10MMd5)
        decode = addon.decodePrivateFileDownloadResponse.bind(addon)
      }
      const result = decode(await this.sendPacket(addon, request))
      return { url: result.url, expiresAt: directUrlExpiry(result, this.now()) }
    } catch (error) {
      log('warn', `QQ media direct URL unavailable message=${locator.messageId} element=${locator.elementId}: ${errorMessage(error)}`)
      return
    }
  }

  private async getRkeys(): Promise<Map<number, string>> {
    const now = this.now()
    if (this.cache && now < this.cache.expiresAt) return this.cache.values
    if (!this.refresh) {
      this.refresh = this.fetchRkeys().finally(() => {
        this.refresh = undefined
      })
    }
    return (await this.refresh).values
  }

  private async fetchRkeys(): Promise<RkeyCache> {
    const addon = this.loadAddon()
    const request = addon.encodeFetchRkeyRequest()
    const response = await this.sendPacketRaw(addon, request)
    if (response && typeof response === 'object' && !Buffer.isBuffer(response) && !(response instanceof Uint8Array)) {
      log('info', `QQ packet response command=${request.command} result=${response.result ?? '<unset>'} err=${JSON.stringify(response.errMsg ?? '')} bytes=${response.rspbuffer?.byteLength ?? 0}`)
    }
    const payload = responsePayload(response)
    const decoded = addon.decodeFetchRkeyResponse(payload)
    if (!decoded.length) throw new Error('FetchRkey response was empty')

    const now = this.now()
    const values = new Map<number, string>()
    let expiresAt = Number.POSITIVE_INFINITY
    for (const rkey of decoded) {
      if (!rkey.value) continue
      const ttlSeconds = Number(rkey.ttlSeconds)
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 0) continue
      values.set(rkey.kind, rkey.value)
      const createdAt = rkey.createdAt > 0 ? rkey.createdAt * 1_000 : now
      expiresAt = Math.min(expiresAt, createdAt + ttlSeconds * 1_000)
    }
    if (!values.size) throw new Error('FetchRkey response contained no usable keys')
    // Expire all keys together at the shortest server-provided TTL. A small
    // safety window avoids returning a key while it is expiring at the CDN.
    const remaining = Math.max(0, expiresAt - now)
    const safetyWindow = Math.min(30_000, Math.floor(remaining / 10))
    const cache = { values, expiresAt: Math.max(now, expiresAt - safetyWindow) }
    this.cache = cache
    return cache
  }

  private rememberDirectUrl(key: string, value: QQDirectUrl): void {
    this.directUrls.delete(key)
    this.directUrls.set(key, value)
    while (this.directUrls.size > 1_024) this.directUrls.delete(this.directUrls.keys().next().value!)
  }

  private async sendPacket(addon: PacketAddon, request: NativePacketRequest): Promise<Buffer> {
    return responsePayload(await this.sendPacketRaw(addon, request))
  }

  private async getHighwaySession(addon: PacketAddon): Promise<HighwaySession> {
    const cached = this.highwaySession
    if (cached && this.now() - cached.createdAt < 12 * 60 * 60_000) return cached.value
    if (!this.highwaySessionRefresh) {
      this.highwaySessionRefresh = this.sendPacket(addon, encodeHighwaySessionRequest())
        .then(decodeHighwaySessionResponse)
        .then((value) => {
          this.highwaySession = { value, createdAt: this.now() }
          return value
        })
        .finally(() => { this.highwaySessionRefresh = undefined })
    }
    return this.highwaySessionRefresh
  }

  private reserveHighwaySequences(fileSize: number): number {
    const blocks = Math.max(1, Math.ceil(fileSize / HIGHWAY_BLOCK_SIZE))
    if (this.highwaySequence + blocks >= 0x7fff_ffff) this.highwaySequence = 0
    const sequenceStart = this.highwaySequence + 1
    this.highwaySequence += blocks
    return sequenceStart
  }

  private async uploadHighwayBlock(
    session: HighwaySession,
    selfUin: string,
    frame: Buffer,
    signal?: AbortSignal,
  ): Promise<void> {
    let lastError: unknown
    for (const server of session.servers) {
      try {
        const response = await this.fetchImpl(
          `http://${server.host}:${server.port}/cgi-bin/httpconn?htcmd=0x6FF0087&uin=${encodeURIComponent(selfUin)}`,
          {
            method: 'POST', body: frame, signal,
            headers: { connection: 'keep-alive', 'content-type': 'application/octet-stream' },
          },
        )
        if (!response.ok) throw new Error(`Highway HTTP ${response.status}: ${await response.text()}`)
        decodeHighwayResponse(new Uint8Array(await response.arrayBuffer()))
        return
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error
        lastError = error
      }
    }
    throw new Error(`all Highway upload servers failed: ${errorMessage(lastError)}`)
  }

  private async sendPacketRaw(addon: PacketAddon, request: NativePacketRequest): Promise<PacketResponse> {
    this.locateBinding(addon)
    const send = this.msgService.sendSsoCmdReqByContend
    if (typeof send !== 'function') throw new Error('sendSsoCmdReqByContend is unavailable in this QQNT build')
    return withTimeout(
      Promise.resolve(addon.sendPacket(send.bind(this.msgService), request.command, Buffer.from(request.payload))),
      this.timeoutMs,
      `QQ packet request timed out after ${this.timeoutMs}ms`,
    ) as Promise<PacketResponse>
  }

  private locateBinding(addon: PacketAddon): void {
    if (this.located) return
    const location = addon.installSendHook()
    this.located = true
    log('info', `QQNT packet hook installed module=${location.moduleBase} profile=${location.profile} timeDateStamp=0x${location.timeDateStamp.toString(16)} sizeOfImage=0x${location.sizeOfImage.toString(16)} anchorRva=0x${location.anchorRva.toString(16)} xrefRva=0x${location.xrefRva.toString(16)} functionRva=0x${location.functionRva.toString(16)} converterRva=0x${location.converterRva.toString(16)} responseRva=0x${location.responseRva.toString(16)}`)
  }
}

function httpUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function directUrlExpiry(result: NativeDirectUrl, now: number): number {
  const createdAt = result.createdAt > 0 ? result.createdAt * 1_000 : now
  const ttl = Math.max(1, result.ttlSeconds || 300) * 1_000
  const remaining = Math.max(0, createdAt + ttl - now)
  return Math.max(now, now + remaining - Math.min(30_000, Math.floor(remaining / 10)))
}

function responsePayload(response: PacketResponse): Buffer {
  if (Buffer.isBuffer(response) || response instanceof Uint8Array) return Buffer.from(response)
  if (!response || typeof response !== 'object') throw new Error('QQ packet response has an invalid shape')
  if (response.rspbuffer) return Buffer.from(response.rspbuffer)
  if (response.result !== undefined && response.result !== 0) {
    throw new Error(`QQ packet request failed: ${response.errMsg ?? ''} (${response.result})`)
  }
  throw new Error('QQ packet response did not contain rspbuffer')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function* exactBlocks(
  source: AsyncIterable<Uint8Array>,
  expectedSize: number,
  blockSize: number,
  signal?: AbortSignal,
): AsyncIterable<Buffer> {
  let buffered = Buffer.alloc(0)
  let received = 0
  for await (const value of source) {
    if (signal?.aborted) throw signal.reason ?? new Error('upload aborted')
    const chunk = Buffer.from(value)
    if (!chunk.length) continue
    received += chunk.length
    if (received > expectedSize) throw new Error(`upload exceeded declared size ${expectedSize}`)
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk
    while (buffered.length >= blockSize) {
      yield buffered.subarray(0, blockSize)
      buffered = Buffer.from(buffered.subarray(blockSize))
    }
  }
  if (received !== expectedSize) throw new Error(`incomplete upload: expected ${expectedSize} bytes, received ${received}`)
  if (buffered.length) yield buffered
}
