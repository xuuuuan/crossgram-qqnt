import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { Readable } from 'node:stream'
import { PROTOCOL_VERSION, type QQMediaLocator, type SendManifest } from './protocol.js'
import { QQKernelBridge } from './qq-kernel.js'
import { log } from './log.js'

export interface BridgeServerOptions {
  host?: string
  port?: number
  token?: string
}

export class QQBridgeServer {
  private server?: Server
  readonly host: string
  readonly port: number
  readonly token?: string

  constructor(readonly bridge: QQKernelBridge, options: BridgeServerOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 18767
    this.token = options.token
  }

  async start(): Promise<void> {
    if (this.server) return
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error) => {
        log('error', 'request failed', error)
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

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorize(request)) {
      json(response, 401, { error: 'unauthorized' })
      return
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const path = url.pathname

    if (request.method === 'GET' && path === '/v1/status') {
      json(response, 200, { protocolVersion: PROTOCOL_VERSION, ...this.bridge.status })
      return
    }
    if (!this.bridge.status.ready) {
      json(response, 503, { error: 'QQNT kernel is not ready' })
      return
    }
    if (request.method === 'GET' && path === '/v1/events') {
      await this.events(request, response)
      return
    }
    if (request.method === 'GET' && path === '/v1/dialogs') {
      json(response, 200, await this.bridge.getDialogs(
        url.searchParams.get('cursor') ?? undefined,
        numberParam(url, 'limit', 100),
      ))
      return
    }
    if (request.method === 'GET' && path === '/v1/conversations/resolve') {
      const kind = url.searchParams.get('kind')
      const numericId = requiredParam(url, 'id')
      json(response, 200, await this.bridge.resolveConversation(kind === 'group' ? 2 : 1, numericId))
      return
    }

    const conversationMatch = /^\/v1\/conversations\/([^/]+)(?:\/(history|members))?$/.exec(path)
    if (request.method === 'GET' && conversationMatch) {
      const conversation = this.bridge.getConversation(decodeURIComponent(conversationMatch[1]))
      if (!conversationMatch[2]) {
        json(response, 200, conversation)
      } else if (conversationMatch[2] === 'history') {
        json(response, 200, await this.bridge.getHistory(conversation, {
          cursor: url.searchParams.get('cursor') ?? undefined,
          beforeId: url.searchParams.get('beforeId') ?? undefined,
          afterId: url.searchParams.get('afterId') ?? undefined,
          limit: numberParam(url, 'limit', 50),
        }))
      } else {
        json(response, 200, await this.bridge.getMembers(
          conversation,
          url.searchParams.get('cursor') ?? undefined,
          numberParam(url, 'limit', 100),
        ))
      }
      return
    }
    if (request.method === 'POST' && path === '/v1/messages') {
      const manifest = decodeManifest(request.headers['x-qqnt-manifest'])
      json(response, 200, await this.bridge.send(manifest, request))
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
      json(response, 200, { ok: true })
      return
    }
    if (request.method === 'POST' && path === '/v1/messages/forward') {
      const body = await readJson<{ from: string, to: string, messageIds: string[] }>(request)
      await this.bridge.forwardMessages(
        this.bridge.getConversation(body.from),
        body.messageIds,
        this.bridge.getConversation(body.to),
      )
      json(response, 200, { ok: true })
      return
    }
    if (request.method === 'GET' && path.startsWith('/v1/users/')) {
      const user = await this.bridge.getUser(decodeURIComponent(path.slice('/v1/users/'.length)))
      if (!user) json(response, 404, { error: 'user not found' })
      else json(response, 200, user)
      return
    }
    if (request.method === 'POST' && path === '/v1/media/open') {
      const locator = await readJson<QQMediaLocator>(request)
      const offset = numberHeader(request, 'x-qqnt-offset', 0)
      const limit = optionalNumberHeader(request, 'x-qqnt-limit')
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

  private async events(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.flushHeaders()
    const queue = this.bridge.subscribe()
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
    const close = () => this.bridge.unsubscribe(queue)
    request.once('close', close)
    try {
      for await (const event of queue) {
        if (!response.write(`data: ${JSON.stringify(event)}\n\n`)) await once(response, 'drain')
      }
    } finally {
      clearInterval(heartbeat)
      request.off('close', close)
      this.bridge.unsubscribe(queue)
      response.end()
    }
  }

  private authorize(request: IncomingMessage): boolean {
    if (!this.token) return true
    return request.headers.authorization === `Bearer ${this.token}`
  }
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
