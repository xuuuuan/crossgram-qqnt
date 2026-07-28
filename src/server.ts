import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { Duplex } from 'node:stream'
import type { Readable } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import {
  PROTOCOL_VERSION, type QQMediaLocator, type QQMultiForwardLocator, type QQSendMediaSpec, type QQStickerReference, type SendManifest,
} from './protocol.js'
import { QQKernelBridge, QQStickerAssetNotFoundError } from './qq-kernel.js'
import { log, recordSlowHttpRequest, slowHttpLogPath } from './log.js'

export interface BridgeServerOptions {
  host?: string
  port?: number
  webSocketHost?: string
  webSocketPort?: number
  token?: string
  slowRequestThresholdMs?: number
  slowRequestPath?: string
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
  readonly slowRequestThresholdMs: number
  readonly slowRequestPath: string

  constructor(readonly bridge: QQKernelBridge, options: BridgeServerOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 18767
    this.webSocketHost = options.webSocketHost ?? this.host
    this.webSocketPort = options.webSocketPort
    this.token = options.token
    this.slowRequestThresholdMs = options.slowRequestThresholdMs ?? 500
    this.slowRequestPath = options.slowRequestPath ?? slowHttpLogPath
  }

  async start(): Promise<void> {
    if (this.server) return
    this.server = createServer((request, response) => {
      const requestId = ++this.requestSequence
      const startedAt = Date.now()
      const method = request.method ?? '<unknown>'
      const target = request.url ?? '/'
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

  private async route(request: IncomingMessage, response: ServerResponse, requestId: number): Promise<void> {
    if (!this.authorize(request)) {
      json(response, 401, { error: 'unauthorized' })
      return
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const path = url.pathname

    if (request.method === 'GET' && path === '/v1/status') {
      const status = { protocolVersion: PROTOCOL_VERSION, ...this.bridge.status }
      log('info', `HTTP API status id=${requestId} ready=${status.ready} selfUin=${status.selfUin ?? ''}`)
      json(response, 200, status)
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
    if (request.method === 'GET' && path === '/v1/dialogs') {
      const page = await this.bridge.getDialogs(
        url.searchParams.get('cursor') ?? undefined,
        numberParam(url, 'limit', 100),
        url.searchParams.get('afterId') ?? undefined,
      )
      log('info', `HTTP API dialogs id=${requestId} count=${page.conversations.length} next=${page.nextCursor ?? ''}`)
      json(response, 200, page)
      return
    }
    if (request.method === 'GET' && path === '/v1/contacts') {
      const page = await this.bridge.getContacts(
        url.searchParams.get('cursor') ?? undefined,
        numberParam(url, 'limit', 500),
      )
      log('info', `HTTP API contacts id=${requestId} count=${page.users.length} next=${page.nextCursor ?? ''}`)
      json(response, 200, page)
      return
    }
    if (request.method === 'GET' && path === '/v1/reactions/catalog') {
      const catalog = await this.bridge.getReactionCatalog()
      log('info', `HTTP API reaction catalog id=${requestId} available=${catalog.available.length}`)
      json(response, 200, catalog)
      return
    }
    if (request.method === 'GET' && path === '/v1/stickers/packs') {
      json(response, 200, await this.bridge.getStickerPacks(
        url.searchParams.get('cursor') ?? undefined,
        numberParam(url, 'limit', 100),
      ))
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
      response.writeHead(200, {
        'content-type': asset.mimeType,
        'x-qqnt-size': String(asset.size ?? ''),
        'cache-control': 'no-store',
        'transfer-encoding': 'chunked',
      })
      await pipe(asset.stream, response)
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

    const conversationMatch = /^\/v1\/conversations\/([^/]+)(?:\/(history|members|search))?$/.exec(path)
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
        json(response, 200, page)
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
      const plan = await this.bridge.prepareMediaUpload(body.conversationId, body.media)
      log('info', `HTTP API upload prepare complete id=${requestId} conversation=${body.conversationId} kind=${body.media.kind} highway=${Boolean(plan.highway)} servers=${plan.highway?.servers.length ?? 0}`)
      json(response, 200, plan)
      return
    }
    if (request.method === 'POST' && path === '/v1/messages') {
      const manifest = decodeManifest(request.headers['x-qqnt-manifest'])
      log('info', `HTTP API send start id=${requestId} conversation=${manifest.conversationId} textLength=${manifest.text?.length ?? 0} media=${manifest.media?.map((item) => `${item.kind}:${item.name}:${item.size ?? '?'}`).join(',') || '<none>'}`)
      const message = await this.bridge.send(manifest, request)
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
    if (request.method === 'POST' && path === '/v1/messages/get') {
      const body = await readJson<{ conversationId: string, messageId: string }>(request)
      const message = await this.bridge.getMessage(
        this.bridge.getConversation(body.conversationId), body.messageId,
      )
      if (message) json(response, 200, message)
      else json(response, 404, { error: 'message not found' })
      return
    }
    if (request.method === 'POST' && path === '/v1/messages/multi-forward') {
      const locator = await readJson<QQMultiForwardLocator>(request)
      const messages = await this.bridge.getMultiForwardMessages(locator)
      log('info', `HTTP API multi-forward id=${requestId} conversation=${locator.conversationId} root=${locator.rootMessageId} parent=${locator.parentMessageId ?? ''} messages=${messages.length}`)
      json(response, 200, { messages })
      return
    }
    if (request.method === 'GET' && path === '/v1/messages/reactions') {
      const conversation = this.bridge.getConversation(requiredParam(url, 'conversationId'))
      const messageId = requiredParam(url, 'messageId')
      const context = await this.bridge.getMessageReactions(conversation, messageId)
      log('info', `HTTP API get reactions id=${requestId} conversation=${conversation.id} message=${messageId} reactions=${context.reactions.length}`)
      json(response, 200, context)
      return
    }
    if (request.method === 'POST' && path === '/v1/messages/reactions') {
      const body = await readJson<{ conversationId: string, messageId: string, reactionKeys: string[] }>(request)
      const context = await this.bridge.setMessageReactions(
        this.bridge.getConversation(body.conversationId),
        body.messageId,
        body.reactionKeys,
      )
      log('info', `HTTP API set reactions id=${requestId} conversation=${body.conversationId} message=${body.messageId} requested=${body.reactionKeys.join(',')} resulting=${context.reactions.length}`)
      json(response, 200, context)
      return
    }
    if (request.method === 'POST' && path === '/v1/messages/forward') {
      const body = await readJson<{ from: string, to: string, messageIds: string[], merged?: boolean }>(request)
      const messages = await this.bridge.forwardMessages(
        this.bridge.getConversation(body.from),
        body.messageIds,
        this.bridge.getConversation(body.to),
        body.merged,
      )
      log('info', `HTTP API forward messages id=${requestId} from=${body.from} to=${body.to} merged=${Boolean(body.merged)} messages=${body.messageIds.join(',')} outputs=${messages.map((item) => item.id).join(',')}`)
      json(response, 200, { messages })
      return
    }
    if (request.method === 'GET' && path.startsWith('/v1/users/')) {
      const user = await this.bridge.getUser(decodeURIComponent(path.slice('/v1/users/'.length)))
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

  private async eventsWebSocket(webSocket: WebSocket, requestId: number, lastEventId?: string): Promise<void> {
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
        if (event.type !== 'native-avsdk' && (!replay || replay.index === 1 || replay.last || replay.index % 100 === 0)) {
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
    if (!this.token) return true
    return request.headers.authorization === `Bearer ${this.token}`
  }
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
    webSocket.send(data, (error) => error ? reject(error) : resolve())
  })
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function wireEventSummary(event: { type: string, conversation?: { id?: string }, message?: { id?: string }, eventId?: string }): string {
  return `type=${event.type} conversation=${event.conversation?.id ?? ''} message=${event.message?.id ?? ''} eventId=${event.eventId ?? ''}`
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

function decodeManifest(value: string | string[] | undefined): SendManifest {
  if (typeof value !== 'string') throw new Error('x-qqnt-manifest is required')
  const manifest = JSON.parse(Buffer.from(value, 'base64url').toString()) as SendManifest
  if (!manifest || typeof manifest.conversationId !== 'string') throw new Error('invalid send manifest')
  return manifest
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

async function pipe(source: Readable, destination: ServerResponse): Promise<void> {
  for await (const chunk of source) {
    if (!destination.write(chunk)) await once(destination, 'drain')
  }
  destination.end()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
