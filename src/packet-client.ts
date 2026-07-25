import type { KernelMsgService } from './kernel-types.js'
import { log } from './log.js'
import { loadPacketAddon, type PacketAddon } from './packet-addon.js'
import type { QQMediaLocator } from './protocol.js'

const PRIVATE_IMAGE_APP_ID = '1406'
const PRIVATE_IMAGE_RKEY_KIND = 10
const GROUP_IMAGE_RKEY_KIND = 20
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
}

interface RkeyCache {
  expiresAt: number
  values: Map<number, string>
}

/** Sends OIDB packets through QQNT's native message-service binding. */
export class QQPacketClient {
  private readonly loadAddon: () => PacketAddon
  private readonly now: () => number
  private readonly timeoutMs: number
  private cache?: RkeyCache
  private refresh?: Promise<RkeyCache>
  private located = false

  constructor(
    private readonly msgService: Pick<KernelMsgService, 'sendSsoCmdReqByContend'>,
    options: QQPacketClientOptions = {},
  ) {
    this.loadAddon = options.addon ? () => options.addon! : options.loadAddon ?? loadPacketAddon
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PACKET_TIMEOUT_MS
  }

  async getImageDirectUrl(locator: QQMediaLocator): Promise<string | undefined> {
    if (locator.kind !== 'image' || !locator.originImageUrl) return
    try {
      const original = new URL(locator.originImageUrl)
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
    this.locateBinding(addon)
    const send = this.msgService.sendSsoCmdReqByContend
    if (typeof send !== 'function') throw new Error('sendSsoCmdReqByContend is unavailable in this QQNT build')

    const request = addon.encodeFetchRkeyRequest()
    const response = await withTimeout(
      Promise.resolve(addon.sendPacket(send.bind(this.msgService), request.command, request.payload)),
      this.timeoutMs,
      `QQ packet request timed out after ${this.timeoutMs}ms`,
    ) as PacketResponse
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

  private locateBinding(addon: PacketAddon): void {
    if (this.located) return
    const location = addon.locateSendBinding()
    this.located = true
    log('info', `QQNT packet binding located module=${location.moduleBase} anchorRva=0x${location.anchorRva.toString(16)} xrefRva=0x${location.xrefRva.toString(16)} functionRva=0x${location.functionRva.toString(16)}`)
  }
}

function responsePayload(response: PacketResponse): Buffer {
  if (Buffer.isBuffer(response) || response instanceof Uint8Array) return Buffer.from(response)
  if (!response || typeof response !== 'object') throw new Error('QQ packet response has an invalid shape')
  if (response.result !== undefined && response.result !== 0) {
    throw new Error(`QQ packet request failed: ${response.errMsg ?? ''} (${response.result})`)
  }
  if (!response.rspbuffer) throw new Error('QQ packet response did not contain rspbuffer')
  return Buffer.from(response.rspbuffer)
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
