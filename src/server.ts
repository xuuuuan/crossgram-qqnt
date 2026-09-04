import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { Duplex } from 'node:stream'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import WebSocket, { WebSocketServer } from 'ws'
import {
  PROTOCOL_VERSION, type QQFlashTransferManifest, type QQMediaLocator, type QQMultiForwardLocator, type QQSendMediaSpec, type QQStickerReference, type SendManifest,
} from './protocol.js'
import { GroupMsgMask } from './kernel-types.js'
import { QQMediaUploadRejectedError } from './upload-protocol.js'
import {
  QQCallControlAuthorizationError, QQCallControlUnavailableError, QQFlashTransferError,
  QQKernelBridge, QQMediaLeaseAuthorizationError,
  QQMediaLeaseUnavailableError, QQRequestApiUnavailableError, QQRequestConflictError, QQRequestCursorError,
  QQRequestRefreshError, QQRequestResolutionError, QQRequestSessionChangedError, QQRequestUnsupportedError,
  QQStickerAssetNotFoundError,
} from './qq-kernel.js'
import { log, recordSlowHttpRequest, slowHttpLogPath } from './log.js'
import type { QQLoginController } from './login-controller.js'

const MAX_FLASH_TRANSFER_BYTES = 100 * 1024 ** 3

export interface BridgeServerOptions {
  host?: string
  port?: number
  webSocketHost?: string
  webSocketPort?: number
  token?: string
  slowRequestThresholdMs?: number
  slowRequestPath?: string
  login?: QQLoginController
}

export class QQBridgeServer {
  private server?: Server
  private webSocketHttpServer?: Server
  private webSocketServer?: WebSocketServer
  private requestSequence = 0
  readonly host: string
  readonly port: number
  readonly webSocketHost: string
  readonly webSocketPort?: number
  readonly token?: string
  private readonly tokenDigest?: Buffer
  readonly slowRequestThresholdMs: number
  readonly slowRequestPath: string
  readonly login?: QQLoginController

  constructor(readonly bridge: QQKernelBridge, options: BridgeServerOptions = {},
  ) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 18767
    this.webSocketHost = options.webSocketHost ?? this.host
    this.webSocketPort = options.webSocketPort
    this.token = options.token
    this.tokenDigest = this.token
      ? normalizedTokenDigest(this.token)
      : undefined
    this.slowRequestThresholdMs = options.slowRequestThresholdMs ?? 500
    this.slowRequestPath = options.slowRequestPath ?? slowHttpLogPath
    this.login = options.login
  }

  async start(): Promise<void> {
    if (this.server) return
    this.server = createServer((request, response) => {
      const requestId = ++this.requestSequence
      const startedAt = Date.now()
      const method = request.method ?? '<unknown>'
      const target = httpLogTarget(method, request.url ?? '/'
      )
      const observe = (completed: boolean) => {
        const durationMs = Date.now() - startedAt
        if (durationMs <= this.slowRequestThresholdMs) return
        const message = `slow HTTP request method=${method} target=${JSON.stringify(target)} status=${response.statusCode} durationMs=${durationMs} completed=${completed}`
        log('warn', message)
        recordSlowHttpRequest({
          method, target, status: response.statusCode, durationMs, completed,
        }, this.slowRequestPath)
      }
      log('info', `HTTP request start id=${requestId} method=${method} target=${JSON.stringify(target)} remote=${request.socket.remoteAddress ?? '<unknown>'}`)
      response.once('finish', () => {
        const durationMs = Date.now() - startedAt
        log('info', `HTTP request complete id=${requestId} method=${method} target=${JSON.stringify(target)} status=${response.statusCode} durationMs=${durationMs} contentLength=${response.getHeader('content-length') ?? '<stream>'}`)
        observe(true)
      })
      response.once('close', () => {
        if (!response.writableEnded) {
          log('info', `HTTP request closed id=${requestId} method=${method} target=${JSON.stringify(target)} status=${response.statusCode} durationMs=${Date.now() - startedAt}`)
          observe(false)
        }
      })
      void this.route(request, response, requestId).catch((error) => {
        log('error', `HTTP request failed id=${requestId} method=${method} target=${JSON.stringify(target)}`, error)
        if (!response.headersSent) json(response, 500, { error: errorMessage(error) })
        else response.destroy(error instanceof Error ? error : new Error(String(error)))
      })
    })
    this.webSocketServer = new WebSocketServer({ noServer: true })
    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) =>
      this.handleWebSocketUpgrade(request, socket, head)
    if (this.webSocketPort === undefined) {
      this.server.on('upgrade', upgrade)
    } else {
      this.webSocketHttpServer = createServer((request, response) => {
        if (!this.authorize(request)) {
          json(response, 401, { error: 'unauthorized' })
        } else if (!this.bridge.status.ready) {
          json(response, 503, { error: 'QQNT kernel is not ready' })
        } else if (request.method === 'GET' && isWebSocketEventsRequest(request.url ?? '/')) {
          json(response, 426, { error: 'WebSocket upgrade required' })
        } else {
          json(response, 404, { error: 'not found' })
        }
      })
      this.webSocketHttpServer.on('upgrade', upgrade)
      this.webSocketHttpServer.keepAliveTimeout = 65_000
      this.webSocketHttpServer.headersTimeout = 70_000
      this.webSocketHttpServer.requestTimeout = 0
    }
    this.server.keepAliveTimeout = 65_000
    this.server.headersTimeout = 70_000
    this.server.requestTimeout = 0
    this.server.listen(this.port, this.host)
    try {
      await once(this.server, 'listening')
      if (this.webSocketHttpServer) {
        this.webSocketHttpServer.listen(this.webSocketPort, this.webSocketHost)
        await once(this.webSocketHttpServer, 'listening')
      }
    } catch (error) {
      this.server.close()
      this.webSocketHttpServer?.close()
      this.webSocketHttpServer = undefined
      this.server = undefined
      throw error
    }
    log('info', `listening on http://${this.host}:${this.address().port}/v1`)
    if (this.webSocketHttpServer) {
      const address = this.webSocketAddress()
      log('info', `WebSocket listening on ws://${address.host}:${address.port}/v1/events/ws`)
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    const webSocketHttpServer = this.webSocketHttpServer
    this.webSocketHttpServer = undefined
    const webSocketServer = this.webSocketServer
    this.webSocketServer = undefined
    for (const client of webSocketServer?.clients ?? []) client.terminate()
    webSocketServer?.close()
    server.close()
    webSocketHttpServer?.close()
    await Promise.all([
      once(server, 'close'),
      ...(webSocketHttpServer ? [once(webSocketHttpServer, 'close')] : []),
    ])
  }

  address(): { host: string, port: number } {
    const address = this.server?.address()
    if (!address || typeof address === 'string') throw new Error('bridge server is not listening')
    return { host: this.host, port: address.port }
  }

  webSocketAddress(): { host: string, port: number } {
    const server = this.webSocketHttpServer ?? this.server
    const address = server?.address()
    if (!address || typeof address === 'string') throw new Error('bridge WebSocket server is not listening')
    return { host: this.webSocketHttpServer ? this.webSocketHost : this.host, port: address.port }
  }

  private handleWebSocketUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const requestId = ++this.requestSequence
    const target = request.url ?? '/'
    if (!isWebSocketEventsRequest(target)) {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    if (!this.authorize(request)) {
      rejectUpgrade(socket, 401, 'Unauthorized')
      return
    }
    if (!this.bridge.status.ready) {
      rejectUpgrade(socket, 503, 'Service Unavailable')
      return
    }
    const lastEventId = new URL(target, `http://${request.headers.host ?? 'localhost'}`)
      .searchParams.get('lastEventId') ?? undefined
    log('info', `WebSocket upgrade request=${requestId} target=${JSON.stringify(target)} remote=${request.socket.remoteAddress ?? '<unknown>'}`)
    this.webSocketServer?.handleUpgrade(request, socket, head, (webSocket) => {
      void this.eventsWebSocket(webSocket, requestId, lastEventId).catch((error) => {
        log('error', `WebSocket event stream failed request=${requestId}`, error)
        webSocket.terminate()
      })
    })
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: number,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const path = url.pathname
    if (!this.authorize(request)) {
      json(response, 401, { error: 'unauthorized' })
      return
    }

    if (request.method === 'GET' && path === '/v1/status') {
      const status = { protocolVersion: PROTOCOL_VERSION, ...this.bridge.status, login: this.login?.status }
      log('info', `HTTP API status id=${requestId} ready=${status.ready} selfUin=${status.selfUin ?? ''}`)
      json(response, 200, status)
      return
    }
    if (request.method === 'GET' && path === '/v1/login/status') {
      if (!this.login) {
        json(response, 503, { error: 'QQNT login controller is unavailable' })
      } else {
        json(response, 200, this.login.status)
      }
      return
    }
    if (request.method === 'GET' && path === '/v1/login/qrcode.png') {
      const png = this.login?.qrCodePng
      if (!png) {
        json(response, 404, { error: 'QR code is not available' })
      } else {
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': png.length,
          'content-type': 'image/png',
        })
        response.end(png)
      }
      return
    }
    if (request.method === 'GET' && path === '/v1/login/qrcode/url') {
      const qrUrl = this.login?.qrcodeUrl
      if (!qrUrl) {
        json(response, 404, { error: 'QR code is not available' })
      } else {
        const body = Buffer.from(`${qrUrl}\n`)
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': body.length,
          'content-type': 'text/plain; charset=utf-8',
        })
        response.end(body)
      }
      return
    }
    if (request.method === 'POST' && path === '/v1/login/qrcode/refresh') {
      if (!this.login) {
        json(response, 503, { error: 'QQNT login controller is unavailable' })
      } else {
        await this.login.requestQRCode(true)
        json(response, 202, this.login.status)
      }
      return
    }
    if (!this.bridge.status.ready) {
      json(response, 503, { error: 'QQNT kernel is not ready' })
      return
    }
    if (request.method === 'GET' && path === '/v1/events/ws') {
      json(response, 426, { error: 'WebSocket upgrade required' })
      return
    }
    if (request.method === 'POST' && path === '/v1/calls/media-lease') {
      const body = await readJson<{ callId?: unknown }>(request)
      try {
        const lease = this.bridge.issueMediaLease(body?.callId)
        json(response, 200, {
          version: lease.version,
          socketPath: lease.socketPath,
          leaseId: lease.leaseId,
          token: lease.token.toString('base64url'),
          expiry: lease.expiry,
        })
      } catch (error) {
        if (error instanceof QQMediaLeaseUnavailableError)
          json(response, 503, { error: 'media lease unavailable' })
        else if (error instanceof QQMediaLeaseAuthorizationError)
          json(response, 403, { error: 'media lease unauthorized' })
        else throw error
      }
      return
    }
    if (request.method === 'GET' && path === '/v1/requests') {
      const kind = url.searchParams.get('kind')
      if (kind !== null && kind !== 'friend' && kind !== 'group-join') {
        json(response, 400, { error: 'invalid request kind' })
        return
      }
      const cursor = url.searchParams.get('cursor')
      const rawLimit = url.searchParams.get('limit')
      const limit = rawLimit === null ? 100 : Number(rawLimit)
      if ((cursor !== null && cursor.length > 2_048) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        json(response, 400, { error: 'invalid request pagination' })
        return
      }
      try {
        json(response, 200, await this.bridge.getRequests(
          kind ?? undefined,
          cursor ?? undefined,
          limit,
        ))
      } catch (error) {
        if (error instanceof QQRequestApiUnavailableError) json(response, 503, { error: error.message })
        else if (error instanceof QQRequestCursorError) json(response, 400, { error: error.message })
        else if (error instanceof QQRequestRefreshError) json(response, 502, { error: error.message })
        else if (error instanceof Error && error.message === 'invalid request kind') json(response, 400, { error: error.message })
        else throw error
      }
      return
    }
    const requestResolutionMatch = /^\/v1\/requests\/([^/]+)\/resolve$/.exec(path)
    if (request.method === 'POST' && requestResolutionMatch) {
      let id: string
      let body: { action?: unknown }
      try {
        id = decodeURIComponent(requestResolutionMatch[1])
        body = await readJson<{ action?: unknown }>(request)
      } catch {
        json(response, 400, { error: 'invalid request resolution' })
        return
      }
      if (!id || (body?.action !== 'accept' && body?.action !== 'reject')) {
        json(response, 400, { error: 'action must be accept or reject' })
        return
      }
      try {
        json(response, 200, await this.bridge.resolveRequest(id, body.action))
      } catch (error) {
        if (error instanceof QQRequestApiUnavailableError) json(response, 503, { error: error.message })
        else if (error instanceof QQRequestUnsupportedError) json(response, 400, { error: error.message })
        else if (error instanceof QQRequestResolutionError) json(response, 502, { error: 'QQNT request resolution failed' })
        else if (error instanceof QQRequestSessionChangedError) json(response, 503, { error: 'QQNT request session changed' })
        else if (error instanceof QQRequestConflictError) json(response, 409, { error: error.message })
        else if (error instanceof Error && error.message === 'request not found') json(response, 404, { error: error.message })
        else if (error instanceof Error && error.message === 'invalid request resolution') json(response, 400, { error: error.message })
        else throw error
      }
      return
    }
    if (request.method === 'POST' && path === '/v1/calls/control') {
      const body = await readJson<{ callId?: unknown, operation?: unknown }>(request)
      if (typeof body.callId !== 'string'
        || (body.operation !== 'accept' && body.operation !== 'reject' && body.operation !== 'hangup')) {
        json(response, 400, { error: 'callId and a valid operation are required' })
        return
      }
      try {
        await this.bridge.controlCall(body.callId, body.operation)
        json(response, 200, { ok: true })
      } catch (error) {
        if (error instanceof QQCallControlAuthorizationError)
          json(response, 403, { error: 'call control unauthorized' })
        else if (error instanceof QQCallControlUnavailableError)
          json(response, 503, { error: 'call control unavailable' })
        else throw error
      }
      return
    }
    if (request.method === 'GET' && path === '/v1/dialogs') {
      const page = await this.bridge.getDialogs(
        url.searchParams.get('cursor') ?? undefined,
        numberParam(url, 'limit', 100),
        url.searchParams.get('afterId') ?? undefined,
      )
      log(
        'info',
        `HTTP API dialogs id=${requestId} count=${page.conversations.length} next=${page.nextCursor ?? ''}`,
      )
      conditionalJson(request, response, page)
      return
    }
    if (request.method === 'GET' && path === '/v1/contacts') {
      const page = await this.bridge.getContacts(
        url.searchParams.get('cursor') ?? undefined,
        numberParam(url, 'limit', 500),
      )
      log(
        'info',
        `HTTP API contacts id=${requestId} count=${page.users.length} next=${page.nextCursor ?? ''}`,
      )
      json(response, 200, page)
      return
    }
    if (request.method === 'GET' && path === '/v1/reactions/catalog') {
      const catalog = await this.bridge.getReactionCatalog()
      log(
        'info',
        `HTTP API reaction catalog id=${requestId} available=${catalog.available.length}`,
      )
      json(response, 200, catalog)
      return
    }
    if (request.method === 'GET' && path === '/v1/stickers/packs') {
      json(
        response,
        200,
        await this.bridge.getStickerPacks(
        url.searchParams.get('cursor') ?? undefined,
        numberParam(url, 'limit', 100),
        ),
      )
      return
    }
    const stickerPackMatch = /^\/v1\/stickers\/packs\/([^/]+)$/.exec(path)
    if (request.method === 'GET' && stickerPackMatch) {
      const pack = await this.bridge.getStickerPack(decodeURIComponent(stickerPackMatch[1]))
      if (pack) json(response, 200, pack)
      else json(response, 404, { error: 'sticker pack not found' })
      return
    }
    if (request.method === 'GET' && path === '/v1/stickers/saved') {
      json(response, 200, await this.bridge.getSavedStickers(
        url.searchParams.get('cursor') ?? undefined,
        numberParam(url, 'limit', 200),
      ))
      return
    }
    const stickerMatch = /^\/v1\/stickers\/([^/]+)$/.exec(path)
    if (request.method === 'GET' && stickerMatch) {
      const sticker = await this.bridge.getSticker(decodeURIComponent(stickerMatch[1]))
      if (sticker) json(response, 200, sticker)
      else json(response, 404, { error: 'sticker not found' })
      return
    }
    if (request.method === 'POST' && path === '/v1/stickers/saved') {
      const body = await readJson<{ reference: QQStickerReference, saved: boolean }>(request)
      await this.bridge.setSavedSticker(body.reference, body.saved)
      json(response, 200, { ok: true })
      return
    }
    if (request.method === 'POST' && path === '/v1/stickers/asset') {
      const reference = await readJson<QQStickerReference>(request)
      const range = parseByteRange(request.headers.range)
      if (range === false) {
        response.writeHead(416, { 'content-range': 'bytes */*', 'cache-control': 'no-store' })
        response.end()
        return
      }
      let asset
      try {
        asset = await this.bridge.openSticker(reference)
      } catch (error) {
        if (error instanceof QQStickerAssetNotFoundError) {
          json(response, 404, { error: error.message })
          return
        }
        throw error
      }
      if (range && asset.size !== undefined && range.offset >= asset.size) {
        response.writeHead(416, {
          'content-range': `bytes */${asset.size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store',
        })
        response.end()
        asset.stream.destroy()
        return
      }
      const offset = range?.offset ?? 0
      const length = asset.size === undefined
        ? undefined
        : Math.min(range?.limit ?? asset.size - offset, asset.size - offset)
      response.writeHead(range && asset.size !== undefined ? 206 : 200, {
        'content-type': asset.mimeType,
        'x-qqnt-size': String(asset.size ?? ''),
        'cache-control': 'no-store',
        'accept-ranges': 'bytes',
        ...(length !== undefined ? { 'content-length': String(length) } : { 'transfer-encoding': 'chunked' }),
        ...(range && asset.size !== undefined
          ? { 'content-range': `bytes ${offset}-${offset + length! - 1}/${asset.size}` }
          : {}),
      })
      await pipe(asset.stream, response, range ?? {})
      return
    }
    if (request.method === 'GET' && path === '/v1/conversations/resolve') {
      const kind = url.searchParams.get('kind')
      const numericId = requiredParam(url, 'id')
      const conversation = await this.bridge.resolveConversation(kind === 'group' ? 2 : 1, numericId)
      log('info', `HTTP API resolve conversation id=${requestId} kind=${conversation.kind} conversation=${conversation.id} title=${JSON.stringify(conversation.title)} avatar=${conversation.avatar?.id ?? '<none>'}`)
      json(response, 200, conversation)
      return
    }

    const notificationMaskMatch = /^\/v1\/conversations\/(?<chatType>1|2)\/(?<peerUin>[^/]+)\/notification-mask$/.exec(path)
    if (request.method === 'POST' && notificationMaskMatch?.groups) {
      const chatType = Number(notificationMaskMatch.groups.chatType) as 1 | 2
      const peerUin = decodeURIComponent(notificationMaskMatch.groups.peerUin)
      const body = await readJson<{ msgMask?: unknown }>(request)
      const msgMask = body?.msgMask
      const validMasks = new Set<number>([
        GroupMsgMask.UNSPECIFIED,
        GroupMsgMask.NOTIFY,
        GroupMsgMask.ASSISTANT,
        GroupMsgMask.SHIELD,
        GroupMsgMask.RECEIVE,
      ])
      if (typeof msgMask !== 'number' || !validMasks.has(msgMask)) {
        json(response, 400, { error: 'msgMask must be one of 0, 1, 2, 3, 4' })
        return
      }
      if (chatType !== 2) {
        json(response, 400, { error: 'notification mask is only supported for group conversations' })
        return
      }
      try {
        await this.bridge.setGroupMsgMask(peerUin, msgMask as GroupMsgMask)
      } catch (error) {
        const message = errorMessage(error)
        if (/not ready|unavailable|expose/i.test(message)) {
          json(response, 503, { error: message })
        } else {
          json(response, 502, { error: message })
        }
        return
      }
      log('info', `HTTP API set notification mask id=${requestId} chatType=${chatType} peer=${peerUin} mask=${msgMask}`)
      json(response, 200, { ok: true, chatType, peerUin, msgMask })
      return
    }

    const memberRoleMatch = /^\/v1\/conversations\/([^/]+)\/members\/([^/]+)\/role$/.exec(path)
    if (request.method === 'POST' && memberRoleMatch) {
      const conversation = this.bridge.getConversation(decodeURIComponent(memberRoleMatch[1]))
      const userId = decodeURIComponent(memberRoleMatch[2])
      const body = await readJson<{ role?: unknown }>(request)
      if (body?.role !== 'administrator' && body?.role !== 'member') {
        json(response, 400, { error: 'role must be administrator or member' })
        return
      }
      if (conversation.chatType !== 2) {
        json(response, 400, { error: 'member roles are only supported for group conversations' })
        return
      }
      try {
        await this.bridge.setMemberRole(conversation, userId, body.role)
      } catch (error) {
        const message = errorMessage(error)
        if (/not ready|unavailable|expose/i.test(message)) {
          json(response, 503, { error: message })
        } else {
          json(response, 502, { error: message })
        }
        return
      }
      log('info', `HTTP API set member role id=${requestId} conversation=${conversation.id} user=${userId} role=${body.role}`)
      json(response, 200, { ok: true, conversationId: conversation.id, userId, role: body.role })
      return
    }

    const conversationMatch = /^\/v1\/conversations\/([^/]+)(?:\/(history|members|search|group-files))?$/.exec(path)
    if (request.method === 'GET' && conversationMatch) {
      const conversation = this.bridge.getConversation(decodeURIComponent(conversationMatch[1]))
      if (!conversationMatch[2]) {
        const details = await this.bridge.getConversationDetails(conversation.id)
        log('info', `HTTP API conversation details id=${requestId} conversation=${details.id} title=${JSON.stringify(details.title)} avatar=${details.avatar?.id ?? '<none>'}`)
        json(response, 200, details)
      } else if (conversationMatch[2] === 'history') {
        const page = await this.bridge.getHistory(conversation, {
          cursor: url.searchParams.get('cursor') ?? undefined,
          beforeId: url.searchParams.get('beforeId') ?? undefined,
          afterId: url.searchParams.get('afterId') ?? undefined,
          aroundUnreadSeq: url.searchParams.get('aroundUnreadSeq') ?? undefined,
          limit: numberParam(url, 'limit', 50),
        })
        log('info', `HTTP API history id=${requestId} conversation=${conversation.id} count=${page.messages.length} next=${page.nextCursor ?? ''}`)
        conditionalJson(request, response, page)
      } else if (conversationMatch[2] === 'search') {
        const requestedKind = url.searchParams.get('mediaKind')
        if (requestedKind && requestedKind !== 'image' && requestedKind !== 'file') {
          json(response, 400, { error: 'invalid mediaKind' })
          return
        }
        const page = await this.bridge.searchMessages(conversation, {
          query: url.searchParams.get('q') ?? '',
          cursor: url.searchParams.get('cursor') ?? undefined,
          limit: numberParam(url, 'limit', 50),
          fromUserId: url.searchParams.get('fromUserId') ?? undefined,
          minTimestamp: optionalNumberParam(url, 'minTimestamp'),
          maxTimestamp: optionalNumberParam(url, 'maxTimestamp'),
          mediaKind: (requestedKind as 'image' | 'file' | null) ?? undefined,
        })
        log('info', `HTTP API search id=${requestId} conversation=${conversation.id} query=${JSON.stringify(url.searchParams.get('q') ?? '')} count=${page.messages.length} next=${page.nextCursor ?? ''}`)
        json(response, 200, page)
      } else if (conversationMatch[2] === 'group-files') {
        const page = await this.bridge.getGroupFiles(conversation, {
          folderId: url.searchParams.get('folderId') ?? undefined,
          cursor: url.searchParams.get('cursor') ?? undefined,
          limit: numberParam(url, 'limit', 100),
        })
        log('info', `HTTP API group files id=${requestId} conversation=${conversation.id} folder=${JSON.stringify(url.searchParams.get('folderId') ?? '')} count=${page.items.length} next=${page.nextCursor ?? ''}`)
        json(response, 200, page)
      } else {
        const page = await this.bridge.getMembers(
          conversation,
          url.searchParams.get('cursor') ?? undefined,
          numberParam(url, 'limit', 100),
        )
        log('info', `HTTP API members id=${requestId} conversation=${conversation.id} count=${page.members.length} total=${page.total ?? ''} next=${page.nextCursor ?? ''}`)
        json(response, 200, page)
      }
      return
    }
    if (request.method === 'POST' && path === '/v1/uploads/prepare') {
      const body = await readJson<{ conversationId: string, media: QQSendMediaSpec }>(request)
      if (!body || typeof body.conversationId !== 'string' || !body.media) {
        throw new Error('invalid media upload preparation request')
      }
      log('info', `HTTP API upload prepare start id=${requestId} conversation=${body.conversationId} kind=${body.media.kind} name=${JSON.stringify(body.media.name)} size=${body.media.size ?? '?'}`)
      let plan
      try {
        plan = await this.bridge.prepareMediaUpload(body.conversationId, body.media)
      } catch (error) {
        if (error instanceof QQMediaUploadRejectedError) {
          json(response, 422, { error: error.message })
          return
        }
        throw error
      }
      log('info', `HTTP API upload prepare complete id=${requestId} conversation=${body.conversationId} kind=${body.media.kind} highway=${Boolean(plan.highway)} servers=${plan.highway?.servers.length ?? 0}`)
      json(response, 200, plan)
      return
    }
    if (request.method === 'POST' && path === '/v1/flash-transfers') {
      let manifest: QQFlashTransferManifest
      try {
        manifest = decodeFlashTransferManifest(request.headers['x-qqnt-flash-manifest'])
      } catch (error) {
        request.resume()
        json(response, 400, { error: errorMessage(error) })
        return
      }
      log('info', `HTTP API flash transfer start id=${requestId} files=${manifest.files.length} bytes=${manifest.files.reduce((sum, file) => sum + file.size, 0)}`)
      try {
        const result = await this.bridge.createFlashTransfer(manifest, request)
        log('info', `HTTP API flash transfer complete id=${requestId} fileSet=${result.fileSetId}`)
        json(response, 200, result)
      } catch (error) {
        if (error instanceof QQFlashTransferError) json(response, 502, { error: error.message })
        else throw error
      }
      return
    }
    if (request.method === 'POST' && path === '/v1/messages') {
      const manifest = decodeManifest(request.headers['x-qqnt-manifest'])
      const contentLength = Number(request.headers['content-length'])
      if (manifest.media?.some((media) => media.kind === 'voice')
        && Number.isSafeInteger(contentLength)
        && contentLength > this.bridge.voiceInputLimit) {
        request.resume()
        json(response, 413, { error: `voice input exceeds the ${this.bridge.voiceInputLimit} byte limit` })
        return
      }
      log('info', `HTTP API send start id=${requestId} conversation=${manifest.conversationId} textLength=${manifest.text?.length ?? 0} media=${manifest.media?.map((item) => `${item.kind}:${item.name}:${item.size ?? '?'}`).join(',') || '<none>'}`)
      let message
      try {
        message = await this.bridge.send(manifest, request)
      } catch (error) {
        if (error instanceof QQMediaUploadRejectedError) {
          json(response, 422, { error: error.message })
          return
        }
        throw error
      }
      log('info', `HTTP API send complete id=${requestId} conversation=${manifest.conversationId} message=${message.id} parts=${message.parts.length}`)
      json(response, 200, message)
      return
    }
    if (request.method === 'POST' && path === '/v1/messages/delete') {
      const body = await readJson<{
        conversationId: string
        messageIds: string[]
        forEveryone?: boolean
      }>(request)
      await this.bridge.deleteMessages(
        this.bridge.getConversation(body.conversationId),
        body.messageIds,
        body.forEveryone ?? true,
      )
      log('info', `HTTP API delete messages id=${requestId} conversation=${body.conversationId} messages=${body.messageIds.join(',')} forEveryone=${body.forEveryone ?? true}`)
      json(response, 200, { ok: true })
      return
    }
    const moderationMatch = /^\/v1\/conversations\/([^/]+)\/members\/([^/]+)\/moderate$/.exec(path)
    if (request.method === 'POST' && moderationMatch) {
      const conversation = this.bridge.getConversation(decodeURIComponent(moderationMatch[1]))
      const userId = decodeURIComponent(moderationMatch[2])
      const body = await readJson<{
        type?: unknown
        untilDate?: unknown
        rejectAddRequest?: unknown
      }>(request)
      if (body?.type !== 'mute' && body?.type !== 'unmute' && body?.type !== 'kick') {
        json(response, 400, { error: 'type must be mute, unmute, or kick' })
        return
      }
      try {
        await this.bridge.moderateMember(
          conversation,
          userId,
          body.type,
          typeof body.untilDate === 'number' ? body.untilDate : 0,
          body.rejectAddRequest === true,
        )
      } catch (error) {
        json(response, 502, { error: errorMessage(error) })
        return
      }
      json(response, 200, { ok: true, conversationId: conversation.id, userId, type: body.type })
      return
    }
    const blockMatch = /^\/v1\/users\/([^/]+)\/block$/.exec(path)
    if (request.method === 'POST' && blockMatch) {
      const userId = decodeURIComponent(blockMatch[1])
      const body = await readJson<{ blocked?: unknown }>(request)
      if (typeof body?.blocked !== 'boolean') {
        json(response, 400, { error: 'blocked must be boolean' })
        return
      }
      try {
        await this.bridge.setUserBlocked(userId, body.blocked)
      } catch (error) {
        json(response, 502, { error: errorMessage(error) })
        return
      }
      json(response, 200, { ok: true, userId, blocked: body.blocked })
      return
    }
    if (request.method === 'POST' && path === '/v1/messages/get') {
      const body = await readJson<{ conversationId: string, messageId: string }>(request)
      const message = await this.bridge.getMessage(
        this.bridge.getConversation(body.conversationId), body.messageId,
      )
      if (message) json(response, 200, message)
      else json(response, 404, { error: 'message not found' })
      return
    }
    if (request.method === 'POST' && path === '/v1/messages/inline-keyboard/click') {
      const body = await readJson<{
        conversationId: string
        messageId: string
        messageSequence?: string
        buttonId: string
        callbackData?: string
        botAppid: string
      }>(request)
      const result = await this.bridge.clickInlineKeyboardButton(
        this.bridge.getConversation(body.conversationId),
        body.messageId,
        body.buttonId,
        body.callbackData ?? '',
        body.botAppid,
        body.messageSequence,
      )
      log('info', `HTTP API inline keyboard click id=${requestId} conversation=${body.conversationId} message=${body.messageId} button=${body.buttonId} status=${result.status}`)
      json(response, 200, result)
      return
    }
    if (request.method === 'POST' && path === '/v1/messages/multi-forward') {
      const locator = await readJson<QQMultiForwardLocator>(request)
      const messages = await this.bridge.getMultiForwardMessages(locator)
      log('info', `HTTP API multi-forward id=${requestId} conversation=${locator.conversationId} root=${locator.rootMessageId} parent=${locator.parentMessageId ?? ''} messages=${messages.length}`)
      json(response, 200, { messages })
      return
    }
    if (request.method === 'GET' && path === '/v1/messages/reactions/list') {
      const conversation = this.bridge.getConversation(requiredParam(url, 'conversationId'))
      const messageId = requiredParam(url, 'messageId')
      const page = await this.bridge.getMessageReactionActors(
        conversation,
        messageId,
        url.searchParams.get('reactionKey') || undefined,
        url.searchParams.get('offset') || undefined,
        numberParam(url, 'limit', 100),
        url.searchParams.get('messageSequence') || undefined,
      )
      log('info', `HTTP API get reaction actors id=${requestId} conversation=${conversation.id} message=${messageId} actors=${page.actors.length} next=${Boolean(page.nextOffset)}`)
      json(response, 200, page)
      return
    }
    if (request.method === 'GET' && path === '/v1/messages/reactions') {
      const conversation = this.bridge.getConversation(requiredParam(url, 'conversationId'))
      const messageId = requiredParam(url, 'messageId')
      const context = await this.bridge.getMessageReactions(
        conversation,
        messageId,
        url.searchParams.get('messageSequence') || undefined,
      )
      log('info', `HTTP API get reactions id=${requestId} conversation=${conversation.id} message=${messageId} reactions=${context.reactions.length}`)
      json(response, 200, context)
      return
    }
    if (request.method === 'POST' && path === '/v1/messages/reactions') {
      const body = await readJson<{
        conversationId: string
        messageId: string
        messageSequence?: string
        reactionKeys: string[]
      }>(request)
      const context = await this.bridge.setMessageReactions(
        this.bridge.getConversation(body.conversationId),
        body.messageId,
        body.reactionKeys,
        body.messageSequence,
      )
      log('info', `HTTP API set reactions id=${requestId} conversation=${body.conversationId} message=${body.messageId} requested=${body.reactionKeys.join(',')} resulting=${context.reactions.length}`)
      json(response, 200, context)
      return
    }
    if (request.method === 'POST' && path === '/v1/messages/forward') {
      const body = await readJson<{
        from: string
        to: string
        messageIds: string[]
        merged?: boolean
        originRequestId?: string
      }>(request)
      const messages = await this.bridge.forwardMessages(
        this.bridge.getConversation(body.from),
        body.messageIds,
        this.bridge.getConversation(body.to),
        body.merged,
        body.originRequestId,
      )
      log('info', `HTTP API forward messages id=${requestId} from=${body.from} to=${body.to} merged=${Boolean(body.merged)} messages=${body.messageIds.join(',')} outputs=${messages.map((item) => item.id).join(',')}`)
      json(response, 200, { messages })
      return
    }
    if (request.method === 'GET' && path.startsWith('/v1/users/')) {
      const uid = decodeURIComponent(path.slice('/v1/users/'.length))
      if (!uid.trim()) {
        json(response, 400, { error: 'user ID is required' })
        return
      }
      const user = await this.bridge.getUser(uid)
      log('info', `HTTP API user id=${requestId} found=${Boolean(user)} user=${user?.id ?? '<none>'} avatar=${user?.avatar?.id ?? '<none>'}`)
      if (!user) json(response, 404, { error: 'user not found' })
      else json(response, 200, user)
      return
    }
    if (request.method === 'POST' && path === '/v1/files/direct-url') {
      const locator = await readJson<QQMediaLocator>(request)
      const result = await this.bridge.getDirectUrl(locator)
      if (!result) {
        json(response, 404, { error: 'direct URL is unavailable' })
        return
      }
      log('info', `HTTP API media direct URL id=${requestId} kind=${locator.kind} message=${locator.messageId} element=${locator.elementId} peer=${locator.peerUid}`)
      json(response, 200, result)
      return
    }
    if (request.method === 'POST' && path === '/v1/files/asset') {
      const locator = await readJson<QQMediaLocator>(request)
      const range = parseByteRange(request.headers.range)
      if (range === false) {
        response.writeHead(416, { 'content-range': 'bytes */*', 'cache-control': 'no-store' })
        response.end()
        return
      }
      const asset = await this.bridge.openMedia(locator, range ?? {})
      if (!asset) {
        json(response, 404, { error: 'media asset not found' })
        return
      }
      if (range && asset.offset >= asset.size) {
        response.writeHead(416, {
          'content-range': `bytes */${asset.size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store',
        })
        response.end()
        return
      }
      response.writeHead(range ? 206 : 200, {
        'content-type': asset.mimeType,
        'content-length': String(asset.length),
        ...(range ? { 'content-range': `bytes ${asset.offset}-${asset.offset + asset.length - 1}/${asset.size}` } : {}),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      })
      log('info', `HTTP API media asset id=${requestId} kind=${locator.kind} message=${locator.messageId} element=${locator.elementId} offset=${asset.offset} length=${asset.length} size=${asset.size}`)
      await pipe(asset.stream, response)
      return
    }
    if (request.method === 'POST' && path === '/v1/messages/voice/transcribe') {
      const locator = await readJson<QQMediaLocator>(request)
      const transcript = await this.bridge.transcribeVoice(locator)
      log('info', `HTTP API voice transcript id=${requestId} message=${locator.messageId} element=${locator.elementId}`)
      json(response, 200, { transcript })
      return
    }
    if (request.method === 'POST' && path === '/v1/messages/read') {
      const body = await readJson<{ conversationId: string, messageId: string }>(request)
      await this.bridge.markRead(this.bridge.getConversation(body.conversationId), body.messageId)
      log('info', `HTTP API mark read id=${requestId} conversation=${body.conversationId} message=${body.messageId}`)
      json(response, 200, { ok: true })
      return
    }
    if (request.method === 'POST' && path === '/v1/reactions/asset') {
      const locator = await readJson<{ reactionKey?: string }>(request)
      const range = parseByteRange(request.headers.range)
      if (range === false) {
        response.writeHead(416, { 'content-range': 'bytes */*', 'cache-control': 'no-store' })
        response.end()
        return
      }
      const asset = locator.reactionKey
        ? await this.bridge.openReactionResource(locator.reactionKey, range ?? {})
        : undefined
      if (!asset) {
        json(response, 404, { error: 'reaction resource not found' })
        return
      }
      if (range && asset.offset >= asset.size) {
        response.writeHead(416, {
          'content-range': `bytes */${asset.size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store',
        })
        response.end()
        return
      }
      response.writeHead(range ? 206 : 200, {
        'content-type': asset.mimeType,
        'content-length': String(asset.length),
        ...(range ? { 'content-range': `bytes ${asset.offset}-${asset.offset + asset.length - 1}/${asset.size}` } : {}),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      })
      log('info', `HTTP API reaction asset id=${requestId} key=${locator.reactionKey} offset=${asset.offset} length=${asset.length} size=${asset.size}`)
      await pipe(asset.stream, response)
      return
    }
    json(response, 404, { error: 'not found' })
  }

  private async eventsWebSocket(
    webSocket: WebSocket,
    requestId: number,
    lastEventId?: string,
  ): Promise<void> {
    const queue = this.bridge.subscribe(lastEventId)
    log('info', `WebSocket subscriber connected request=${requestId} lastEventId=${JSON.stringify(lastEventId ?? '')} subscribers=${this.bridge.events.size}`)
    const heartbeat = setInterval(() => {
      if (webSocket.readyState === WebSocket.OPEN) webSocket.ping()
    }, 15_000)
    const close = () => this.bridge.unsubscribe(queue)
    webSocket.once('close', close)
    webSocket.once('error', close)
    let replayWritten = 0
    let replayTotal = 0
    try {
      for await (const event of queue) {
        if (webSocket.readyState !== WebSocket.OPEN) break
        const eventId = this.bridge.eventId(event)
        const replay = this.bridge.consumeReplayEvent(queue)
        if (replay) {
          replayWritten = replay.index
          replayTotal = replay.total
        }
        if (
          !replay ||
          replay.index === 1 ||
          replay.last ||
          replay.index % 100 === 0
        ) {
          log('info', `WebSocket event write request=${requestId} replay=${replay ? `${replay.index}/${replay.total}` : 'live'} ${wireEventSummary(event)} streamEventId=${eventId ?? ''}`)
        }
        await sendWebSocket(webSocket, JSON.stringify({ id: eventId, event }))
        if (replay && !replay.last && replay.index % 50 === 0) await yieldEventLoop()
      }
    } finally {
      clearInterval(heartbeat)
      webSocket.off('close', close)
      webSocket.off('error', close)
      this.bridge.unsubscribe(queue)
      if (replayTotal) {
        log('info', `WebSocket replay complete request=${requestId} written=${replayWritten} total=${replayTotal} completed=${replayWritten === replayTotal}`)
      }
      log('info', `WebSocket subscriber disconnected request=${requestId} subscribers=${this.bridge.events.size}`)
      if (webSocket.readyState === WebSocket.OPEN) webSocket.close()
    }
  }

  private authorize(request: IncomingMessage): boolean {
    if (!this.tokenDigest) return true
    const authorization = request.headers.authorization
    const supplied =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : ''
    return timingSafeEqual(normalizedTokenDigest(supplied), this.tokenDigest)
  }
}

function httpLogTarget(_method: string, target: string): string {
  try {
    const path = new URL(target, 'http://localhost').pathname
    if (path === '/v1/calls/media-lease') return '/v1/calls/media-lease'
    // Redact group-join targets for every HTTP method, including percent-encoded
    // route separators, so future writes never log identifiers or query values.
    if (isGroupJoinRoute(path)) return '/v1/groups/join'
  } catch {
    if (target === '/v1/calls/media-lease' || target.startsWith('/v1/calls/media-lease?')) {
      return '/v1/calls/media-lease'
    }
    if (isGroupJoinRoute(target.split(/[?#]/, 1)[0])) return '/v1/groups/join'
  }
  return target
}

function isGroupJoinRoute(path: string): boolean {
  let normalized = path
  for (let depth = 0; depth < 64; depth++) {
    if (/^\/v1\/(?:groups\/join|group-join)(?:[/?#;]|%|$)/i.test(normalized)) return true
    try {
      const decoded = decodeURIComponent(normalized)
      if (decoded === normalized) return false
      normalized = decoded
    } catch {
      // Any malformed percent-encoded target is unsafe to log verbatim.
      return path.includes('%')
    }
  }
  // Excessive nesting is unsafe to log verbatim.
  return true
}

function isWebSocketEventsRequest(target: string): boolean {
  try {
    return new URL(target, 'http://localhost').pathname === '/v1/events/ws'
  } catch {
    return false
  }
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function sendWebSocket(webSocket: WebSocket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    webSocket.send(data, (error) => (error ? reject(error) : resolve()))
  })
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function wireEventSummary(event: { type: string, conversation?: { id?: string }, message?: { id?: string }, eventId?: string }): string {
  return `type=${event.type} conversation=${event.conversation?.id ?? ''} message=${event.message?.id ?? ''} eventId=${event.eventId ?? ''}`
}

function normalizedTokenDigest(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function conditionalJson(request: IncomingMessage, response: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value)
  const etag = `"${createHash('sha256').update(body).digest('base64url')}"`
  const cacheControl = 'private, no-cache'
  if (ifNoneMatch(request.headers['if-none-match'], etag)) {
    response.writeHead(304, { etag, 'cache-control': cacheControl, vary: 'authorization' })
    response.end()
    return
  }
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': cacheControl,
    etag,
    vary: 'authorization',
  })
  response.end(body)
}

function ifNoneMatch(value: string | string[] | undefined, etag: string): boolean {
  if (value === undefined) return false
  const header = Array.isArray(value) ? value.join(',') : value
  return header.split(',').some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, '')
    return normalized === '*' || normalized === etag
  })
}

function decodeManifest(value: string | string[] | undefined): SendManifest {
  if (typeof value !== 'string') throw new Error('x-qqnt-manifest is required')
  const manifest = JSON.parse(Buffer.from(value, 'base64url').toString()) as SendManifest
  if (!manifest || typeof manifest.conversationId !== 'string') throw new Error('invalid send manifest')
  return manifest
}

function decodeFlashTransferManifest(value: string | string[] | undefined): QQFlashTransferManifest {
  if (typeof value !== 'string') throw new Error('x-qqnt-flash-manifest is required')
  const manifest = JSON.parse(Buffer.from(value, 'base64url').toString()) as QQFlashTransferManifest
  if (!manifest || manifest.framing !== 'length-prefixed-v1' || !Array.isArray(manifest.files)
    || manifest.files.length < 1 || manifest.files.length > 100) {
    throw new Error('invalid flash transfer manifest')
  }
  if (manifest.name !== undefined && (typeof manifest.name !== 'string' || manifest.name.length > 255)) {
    throw new Error('invalid flash transfer name')
  }
  for (const file of manifest.files) {
    if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 255
      || !Number.isSafeInteger(file.size) || file.size < 0
      || (file.source !== 'upload' && file.source !== 'uploaded' && file.source !== 'qq-media')) {
      throw new Error('invalid flash transfer file')
    }
    if (file.source === 'uploaded'
      && (!/^[a-f0-9]{32}$/iu.test(file.md5) || !/^[a-f0-9]{40}$/iu.test(file.sha1))) {
      throw new Error('invalid uploaded flash transfer hashes')
    }
    if (file.source === 'qq-media' && !validFlashTransferLocator(file.locator)) {
      throw new Error('invalid QQ flash transfer media locator')
    }
  }
  const totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0)
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_FLASH_TRANSFER_BYTES) {
    throw new Error('flash transfer is too large')
  }
  return manifest
}

function validFlashTransferLocator(value: unknown): value is QQMediaLocator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const locator = value as Partial<QQMediaLocator>
  return typeof locator.messageId === 'string'
    && typeof locator.elementId === 'string'
    && (locator.chatType === 1 || locator.chatType === 2 || locator.chatType === 8 || locator.chatType === 134)
    && typeof locator.peerUid === 'string'
    && (locator.kind === 'image' || locator.kind === 'file' || locator.kind === 'voice')
    && typeof locator.fileName === 'string'
}

async function readJson<T>(request: IncomingMessage, max = 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > max) throw new Error('JSON request body is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name)
  if (!value) throw new Error(`query parameter ${name} is required`)
  return value
}

function numberParam(url: URL, name: string, fallback: number): number {
  const value = Number(url.searchParams.get(name) ?? fallback)
  if (!Number.isFinite(value)) throw new Error(`query parameter ${name} must be numeric`)
  return value
}

function optionalNumberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`invalid ${name}`)
  return value
}

function parseByteRange(value: string | undefined): { offset: number, limit?: number } | null | false {
  if (value === undefined) return null
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim())
  if (!match) return false
  const offset = Number(match[1])
  const end = match[2] ? Number(match[2]) : undefined
  if (!Number.isSafeInteger(offset) || offset < 0) return false
  if (end !== undefined && (!Number.isSafeInteger(end) || end < offset)) return false
  return { offset, ...(end === undefined ? {} : { limit: end - offset + 1 }) }
}

async function pipe(
  source: Readable,
  destination: ServerResponse,
  range: { offset?: number, limit?: number } = {},
): Promise<void> {
  try {
    await pipeline(
      source,
      async function* (chunks) {
        let skipped = 0
        let remaining = range.limit ?? Number.POSITIVE_INFINITY
        for await (const raw of chunks) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
          if (skipped + chunk.length <= (range.offset ?? 0)) {
            skipped += chunk.length
            continue
          }
          const start = Math.max(0, (range.offset ?? 0) - skipped)
          const accepted = chunk.subarray(start, start + remaining)
          skipped += chunk.length
          if (!accepted.length) continue
          remaining -= accepted.length
          yield accepted
          if (remaining <= 0) return
        }
      },
      destination,
    )
  } catch (error) {
    if (!destination.destroyed) throw error
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
