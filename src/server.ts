import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { Readable } from 'node:stream'
import {
  PROTOCOL_VERSION, type QQMediaLocator, type QQStickerReference, type SendManifest,
} from './protocol.js'
import { QQKernelBridge } from './qq-kernel.js'
import { log, recordSlowHttpRequest, slowHttpLogPath } from './log.js'

export interface BridgeServerOptions {
  host?: string
  port?: number
  token?: string
  slowRequestThresholdMs?: number
  slowRequestPath?: string
}

export class QQBridgeServer {
  private server?: Server
  private requestSequence = 0
  readonly host: string
  readonly port: number
  readonly token?: string
  readonly slowRequestThresholdMs: number
  readonly slowRequestPath: string

  constructor(readonly bridge: QQKernelBridge, options: BridgeServerOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 18767
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
        if (durationMs <= this.slowRequestThresholdMs || isLongLivedRequest(target)) return
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
    this.server.keepAliveTimeout = 65_000
    this.server.headersTimeout = 70_000
    this.server.requestTimeout = 0
    this.server.listen(this.port, this.host)
    try {
      await once(this.server, 'listening')
    } catch (error) {
      this.server.close()
      this.server = undefined
      throw error
    }
    log('info', `listening on http://${this.host}:${this.address().port}/v1`)
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    server.close()
    await once(server, 'close')
  }

  address(): { host: string, port: number } {
    const address = this.server?.address()
    if (!address || typeof address === 'string') throw new Error('bridge server is not listening')
    return { host: this.host, port: address.port }
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
    if (request.method === 'GET' && path === '/v1/events') {
      await this.events(request, response, requestId)
      return
    }
    if (request.method === 'GET' && path === '/v1/dialogs') {
      const page = await this.bridge.getDialogs(
        url.searchParams.get('cursor') ?? undefined,
        numberParam(url, 'limit', 100),
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
      const asset = await this.bridge.openSticker(
        reference,
        numberHeader(request, 'x-qqnt-offset', 0),
        optionalNumberHeader(request, 'x-qqnt-limit'),
      )
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

    const conversationMatch = /^\/v1\/conversations\/([^/]+)(?:\/(history|members))?$/.exec(path)
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
      const body = await readJson<{ from: string, to: string, messageIds: string[] }>(request)
      await this.bridge.forwardMessages(
        this.bridge.getConversation(body.from),
        body.messageIds,
        this.bridge.getConversation(body.to),
      )
      log('info', `HTTP API forward messages id=${requestId} from=${body.from} to=${body.to} messages=${body.messageIds.join(',')}`)
      json(response, 200, { ok: true })
      return
    }
    if (request.method === 'GET' && path.startsWith('/v1/users/')) {
      const user = await this.bridge.getUser(decodeURIComponent(path.slice('/v1/users/'.length)))
      log('info', `HTTP API user id=${requestId} found=${Boolean(user)} user=${user?.id ?? '<none>'} avatar=${user?.avatar?.id ?? '<none>'}`)
      if (!user) json(response, 404, { error: 'user not found' })
      else json(response, 200, user)
      return
    }
    if (request.method === 'POST' && path === '/v1/media/open') {
      const locator = await readJson<QQMediaLocator>(request)
      const offset = numberHeader(request, 'x-qqnt-offset', 0)
      const limit = optionalNumberHeader(request, 'x-qqnt-limit')
      log('info', `HTTP API media open id=${requestId} kind=${locator.kind} message=${locator.messageId} element=${locator.elementId} peer=${locator.peerUid} offset=${offset} limit=${limit ?? '<all>'} pathPresent=${Boolean(locator.filePath)}`)
      const stream = await this.bridge.openMedia(locator, offset, limit)
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        'transfer-encoding': 'chunked',
      })
      await pipe(stream, response)
      return
    }
    json(response, 404, { error: 'not found' })
  }

  private async events(request: IncomingMessage, response: ServerResponse, requestId: number): Promise<void> {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.flushHeaders()
    const queue = this.bridge.subscribe()
    log('info', `SSE subscriber connected request=${requestId} subscribers=${this.bridge.events.size}`)
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
    const close = () => this.bridge.unsubscribe(queue)
    request.once('close', close)
    try {
      for await (const event of queue) {
        log('info', `SSE event write request=${requestId} ${wireEventSummary(event)}`)
        if (!response.write(`data: ${JSON.stringify(event)}\n\n`)) await once(response, 'drain')
      }
    } finally {
      clearInterval(heartbeat)
      request.off('close', close)
      this.bridge.unsubscribe(queue)
      log('info', `SSE subscriber disconnected request=${requestId} subscribers=${this.bridge.events.size}`)
      response.end()
    }
  }

  private authorize(request: IncomingMessage): boolean {
    if (!this.token) return true
    return request.headers.authorization === `Bearer ${this.token}`
  }
}

function isLongLivedRequest(target: string): boolean {
  try {
    return new URL(target, 'http://localhost').pathname === '/v1/events'
  } catch {
    return false
  }
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

function numberHeader(request: IncomingMessage, name: string, fallback: number): number {
  const value = request.headers[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`header ${name} must be a non-negative integer`)
  return parsed
}

function optionalNumberHeader(request: IncomingMessage, name: string): number | undefined {
  return request.headers[name] === undefined ? undefined : numberHeader(request, name, 0)
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
