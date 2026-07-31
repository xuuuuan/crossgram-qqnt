import { execFile, spawn } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, lstat } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import { isAbsolute } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  PCM_MEDIA_CHANNELS, PCM_MEDIA_FRAME_BYTES, PCM_MEDIA_FRAME_TYPES, PCM_MEDIA_PROTOCOL_VERSION, PCM_MEDIA_SAMPLE_FORMAT,
  PCM_MEDIA_SAMPLE_RATE,
} from './protocol.js'

const { auth: AUTH_FRAME, uplink: UPLINK_FRAME, ready: READY_FRAME, downlink: DOWNLINK_FRAME } = PCM_MEDIA_FRAME_TYPES
const FRAME_HEADER_BYTES = 5
const LEASE_ID_BYTES = 16
const LEASE_TOKEN_BYTES = 32
const LEASE_AUTH_BYTES = 1 + LEASE_ID_BYTES + LEASE_TOKEN_BYTES
const LEASE_TTL_MS = 10_000
const MAX_LEASES = 32
const MAX_RETAINED_INPUT_BYTES = FRAME_HEADER_BYTES + PCM_MEDIA_FRAME_BYTES
const MAX_COMPLETE_INPUT_FRAMES = 32
const PCM_CAPTURE_CHANNELS = 2
const PCM_CAPTURE_FRAME_BYTES = PCM_MEDIA_FRAME_BYTES * PCM_CAPTURE_CHANNELS
const MAX_CAPTURE_BUFFER_BYTES = PCM_CAPTURE_FRAME_BYTES * 32
const MAX_PLAYBACK_BACKLOG_BYTES = PCM_MEDIA_FRAME_BYTES * 32
const MAX_SOCKET_BACKLOG_BYTES = PCM_MEDIA_FRAME_BYTES * 32
const PULSE_SERVER = 'unix:/run/qq-pulse/native'
const PULSE_MONITOR = 'qq_sink.monitor'
const DEFAULT_PULSE_MICROPHONE_SINK = 'qq_mic_sink'
const DEFAULT_SOCKET_PATH = '/run/qq-pulse/qqnt-media.sock'
const CALL_IDENTITY_DOMAIN = Buffer.from('qqnt-pcm-media-call-identity-v1', 'ascii')

export interface MediaProcess {
  stdin: Writable | null
  stdout: Readable | null
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: string, listener: (...args: unknown[]) => void): unknown
  removeAllListeners?(event?: string): unknown
}

export type MediaProcessSpawner = (command: string, args: readonly string[]) => MediaProcess
export type PulseCommand = (command: string, args: readonly string[]) => Promise<string>

export interface LocalPCMMediaGatewayOptions {
  socketPath?: string
  microphoneSink?: string
  processSpawner?: MediaProcessSpawner
  pulseCommand?: PulseCommand
  now?: () => number
}

export interface PCMMediaLease {
  version: number
  socketPath: string
  leaseId: string
  token: Buffer
  expiry: number
}

interface Lease {
  callIdentity?: Buffer
  token: Buffer
  expiry: number
  expiryTimer: NodeJS.Timeout
}

interface MediaSession {
  socket: Socket
  authenticated: boolean
  callIdentity?: Buffer
  input: Buffer
  captureBuffer: Buffer
  authTimeout: NodeJS.Timeout
  capture?: MediaProcess
  playback?: MediaProcess
  childrenStopped: boolean
}

/**
 * Local-only PCM gateway. Each connection exchanges 20 ms, 48 kHz mono s16le
 * PCM frames after authenticating with a single-use, short-lived lease.
 */
export class LocalPCMMediaGateway {
  private server?: Server
  private session?: MediaSession
  private readonly processSpawner: MediaProcessSpawner
  private readonly pulseCommand: PulseCommand
  private readonly socketPath: string
  private readonly microphoneSink: string
  private readonly now: () => number
  private readonly leases = new Map<string, Lease>()
  private readonly callIdentitySecret = randomBytes(LEASE_TOKEN_BYTES)
  private readonly dummyLeaseToken = Buffer.alloc(LEASE_TOKEN_BYTES)
  private readonly exitHandler = () => this.stopChildren()

  constructor(options: LocalPCMMediaGatewayOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH
    this.microphoneSink = options.microphoneSink ?? DEFAULT_PULSE_MICROPHONE_SINK
    if (!isAbsolute(this.socketPath)) throw new Error('PCM media socket path must be absolute')
    if (!isCandidatePulseSink(this.microphoneSink)) throw new Error('PCM media gateway configuration is invalid')
    this.processSpawner = options.processSpawner ?? spawnMediaProcess
    this.pulseCommand = options.pulseCommand ?? runPulseCommand
    this.now = options.now ?? performance.now.bind(performance)
  }

  get isRunning(): boolean {
    return Boolean(this.server)
  }

  issueLease(callContext?: { callId?: string }): PCMMediaLease {
    this.removeExpiredLeases()
    if (this.leases.size >= MAX_LEASES) throw new Error('too many active PCM media leases')
    const leaseIdBytes = randomBytes(LEASE_ID_BYTES)
    const leaseId = leaseIdBytes.toString('hex')
    const token = randomBytes(LEASE_TOKEN_BYTES)
    const expiry = this.now() + LEASE_TTL_MS
    const expiryTimer = setTimeout(() => this.revokeLease(leaseId), LEASE_TTL_MS)
    expiryTimer.unref()
    this.leases.set(leaseId, { callIdentity: this.callIdentity(callContext?.callId), token, expiry, expiryTimer })
    return {
      version: PCM_MEDIA_PROTOCOL_VERSION, socketPath: this.socketPath, leaseId, token: Buffer.from(token), expiry,
    }
  }

  revokeCallLeases(callId: string): void {
    const callIdentity = this.callIdentity(callId)
    if (!callIdentity) return
    try {
      for (const [leaseId, lease] of this.leases) if (sameCallIdentity(lease.callIdentity, callIdentity)) this.revokeLease(leaseId)
      const session = this.session
      if (session?.authenticated && sameCallIdentity(session.callIdentity, callIdentity)) this.closeSession(session.socket)
    } finally {
      callIdentity.fill(0)
    }
  }

  async start(): Promise<void> {
    if (this.server) return
    await this.validateMicrophoneSink()
    await refuseExistingSocket(this.socketPath)
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.socketPath, resolve)
      })
      await chmod(this.socketPath, 0o600)
      process.once('exit', this.exitHandler)
    } catch (error) {
      this.server = undefined
      server.close()
      throw error
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    process.off('exit', this.exitHandler)
    this.closeSession()
    this.revokeAllLeases()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async validateMicrophoneSink(): Promise<void> {
    try {
      const output = await this.pulseCommand('pactl', ['--server', PULSE_SERVER, 'list', 'short', 'sinks'])
      if (!listPulseSinks(output).has(this.microphoneSink)) throw new Error('not a sink')
    } catch {
      throw new Error('PCM media playback target is unavailable')
    }
  }

  private accept(socket: Socket): void {
    if (this.session) {
      socket.destroy()
      return
    }
    socket.setNoDelay(true)
    const authTimeout = setTimeout(() => this.closeSession(socket), 5_000)
    authTimeout.unref()
    const session: MediaSession = {
      socket, authenticated: false, input: Buffer.alloc(0), captureBuffer: Buffer.alloc(0), authTimeout, childrenStopped: false,
    }
    this.session = session
    socket.on('data', (chunk: Buffer) => this.onInput(session, chunk))
    socket.once('close', () => this.closeSession(socket))
    socket.once('error', () => this.closeSession(socket))
  }

  private onInput(session: MediaSession, chunk: Buffer): void {
    if (this.session !== session) return
    session.input = Buffer.concat([session.input, chunk])
    let completeFrames = 0
    while (session.input.length >= FRAME_HEADER_BYTES) {
      const type = session.input[0]!
      const length = session.input.readUInt32BE(1)
      if (length > PCM_MEDIA_FRAME_BYTES) {
        this.closeSession()
        return
      }
      const frameBytes = FRAME_HEADER_BYTES + length
      if (session.input.length < frameBytes) {
        if (session.input.length > MAX_RETAINED_INPUT_BYTES) this.closeSession()
        return
      }
      if (++completeFrames > MAX_COMPLETE_INPUT_FRAMES) {
        this.closeSession()
        return
      }
      const payload = session.input.subarray(FRAME_HEADER_BYTES, frameBytes)
      session.input = session.input.subarray(frameBytes)
      if (!this.onFrame(session, type, payload)) return
    }
    if (session.input.length > MAX_RETAINED_INPUT_BYTES) this.closeSession()
  }

  private onFrame(session: MediaSession, type: number, payload: Buffer): boolean {
    if (!session.authenticated) {
      const callIdentity = this.consumeLease(payload)
      if (type !== AUTH_FRAME || !callIdentity) {
        this.closeSession(session.socket)
        return false
      }
      session.authenticated = true
      session.callIdentity = callIdentity.length ? callIdentity : undefined
      clearTimeout(session.authTimeout)
      if (!this.startAudio(session)) return false
      this.writeFrame(session, READY_FRAME, Buffer.from([PCM_MEDIA_PROTOCOL_VERSION]))
      return this.session === session
    }
    if (type !== UPLINK_FRAME || payload.length !== PCM_MEDIA_FRAME_BYTES || !session.playback?.stdin) {
      this.closeSession()
      return false
    }
    if (session.playback.stdin.writableLength > MAX_PLAYBACK_BACKLOG_BYTES || !session.playback.stdin.write(payload)
      || session.playback.stdin.writableLength > MAX_PLAYBACK_BACKLOG_BYTES) this.closeSession()
    return this.session === session
  }

  private consumeLease(payload: Buffer): Buffer | undefined {
    const validShape = payload.length === LEASE_AUTH_BYTES && payload[0] === PCM_MEDIA_PROTOCOL_VERSION
    const leaseId = validShape ? payload.subarray(1, 1 + LEASE_ID_BYTES).toString('hex') : ''
    const lease = validShape ? this.leases.get(leaseId) : undefined
    const candidate = normalizedLeaseToken(validShape ? payload.subarray(1 + LEASE_ID_BYTES) : undefined)
    try {
      const tokenMatches = timingSafeEqual(candidate, lease?.token ?? this.dummyLeaseToken)
      if (!validShape || !lease) return
      if (lease.expiry <= this.now()) {
        this.revokeLease(leaseId)
        return
      }
      if (!tokenMatches) return
      const callIdentity = lease.callIdentity ? Buffer.from(lease.callIdentity) : Buffer.alloc(0)
      this.revokeLease(leaseId)
      return callIdentity
    } finally {
      candidate.fill(0)
    }
  }

  private startAudio(session: MediaSession): boolean {
    let capture: MediaProcess | undefined
    let playback: MediaProcess | undefined
    try {
      capture = this.processSpawner('parecord', pulseArgs(PULSE_MONITOR, false, PCM_CAPTURE_CHANNELS))
      playback = this.processSpawner('pacat', pulseArgs(this.microphoneSink, true, PCM_MEDIA_CHANNELS))
      if (!capture.stdout || !playback.stdin) {
        stopProcess(capture)
        stopProcess(playback)
        this.closeSession()
        return false
      }
      session.capture = capture
      session.playback = playback
      capture.stdout.on('data', (chunk: Buffer) => this.onCapture(session, chunk))
      capture.stdout.once('error', () => this.closeSession(session.socket))
      playback.stdin.once('error', () => this.closeSession(session.socket))
      capture.once('error', () => this.closeSession(session.socket))
      capture.once('exit', () => this.closeSession(session.socket))
      playback.once('error', () => this.closeSession(session.socket))
      playback.once('exit', () => this.closeSession(session.socket))
      return true
    } catch {
      stopProcess(capture)
      stopProcess(playback)
      this.closeSession()
      return false
    }
  }

  private onCapture(session: MediaSession, chunk: Buffer): void {
    if (this.session !== session || !session.authenticated) return
    if (session.captureBuffer.length + chunk.length > MAX_CAPTURE_BUFFER_BYTES) {
      this.closeSession()
      return
    }
    session.captureBuffer = Buffer.concat([session.captureBuffer, chunk])
    while (session.captureBuffer.length >= PCM_CAPTURE_FRAME_BYTES) {
      const stereoFrame = session.captureBuffer.subarray(0, PCM_CAPTURE_FRAME_BYTES)
      session.captureBuffer = session.captureBuffer.subarray(PCM_CAPTURE_FRAME_BYTES)
      if (!this.writeFrame(session, DOWNLINK_FRAME, downmixStereoS16le(stereoFrame))) return
    }
  }

  private writeFrame(session: MediaSession, type: number, payload: Buffer): boolean {
    if (this.session !== session || session.socket.destroyed || session.socket.writableLength > MAX_SOCKET_BACKLOG_BYTES) {
      this.closeSession()
      return false
    }
    const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES)
    header[0] = type
    header.writeUInt32BE(payload.length, 1)
    session.socket.write(header)
    session.socket.write(payload)
    if (session.socket.writableLength > MAX_SOCKET_BACKLOG_BYTES) {
      this.closeSession()
      return false
    }
    return true
  }

  private closeSession(socket?: Socket): void {
    const session = this.session
    if (!session || (socket && session.socket !== socket)) return
    // Disconnect first so delayed child events cannot affect a replacement session.
    this.session = undefined
    clearTimeout(session.authTimeout)
    session.input.fill(0)
    session.input = Buffer.alloc(0)
    session.captureBuffer.fill(0)
    session.captureBuffer = Buffer.alloc(0)
    session.callIdentity?.fill(0)
    session.callIdentity = undefined
    this.stopChildren(session)
    session.socket.removeAllListeners()
    if (!session.socket.destroyed) session.socket.destroy()
  }

  private stopChildren(session = this.session): void {
    if (!session || session.childrenStopped) return
    session.childrenStopped = true
    session.capture?.stdout?.removeAllListeners()
    session.playback?.stdin?.removeAllListeners()
    session.capture?.removeAllListeners?.()
    session.playback?.removeAllListeners?.()
    session.capture?.stdout?.destroy()
    session.playback?.stdin?.destroy()
    stopProcess(session.capture)
    stopProcess(session.playback)
  }

  private removeExpiredLeases(): void {
    for (const [leaseId, lease] of this.leases) if (lease.expiry <= this.now()) this.revokeLease(leaseId)
  }

  private revokeLease(leaseId: string): void {
    const lease = this.leases.get(leaseId)
    if (!lease) return
    clearTimeout(lease.expiryTimer)
    lease.token.fill(0)
    lease.callIdentity?.fill(0)
    lease.callIdentity = undefined
    this.leases.delete(leaseId)
  }

  private revokeAllLeases(): void {
    for (const leaseId of this.leases.keys()) this.revokeLease(leaseId)
  }

  private callIdentity(callId: string | undefined): Buffer | undefined {
    if (callId === undefined) return
    return createHmac('sha256', this.callIdentitySecret).update(CALL_IDENTITY_DOMAIN).update(callId).digest()
  }
}

export function localPCMMediaGatewayFromEnvironment(): LocalPCMMediaGateway | undefined {
  if (process.env.QQNT_BRIDGE_MEDIA_GATEWAY !== '1') return undefined
  return new LocalPCMMediaGateway({
    socketPath: process.env.QQNT_BRIDGE_MEDIA_SOCKET ?? DEFAULT_SOCKET_PATH,
    microphoneSink: process.env.QQNT_BRIDGE_MEDIA_MIC_SINK ?? DEFAULT_PULSE_MICROPHONE_SINK,
  })
}

export function downmixStereoS16le(stereoFrame: Buffer): Buffer {
  if (stereoFrame.length !== PCM_CAPTURE_FRAME_BYTES) throw new Error('expected one stereo PCM media frame')
  const monoFrame = Buffer.allocUnsafe(PCM_MEDIA_FRAME_BYTES)
  for (let sourceOffset = 0, targetOffset = 0; sourceOffset < stereoFrame.length; sourceOffset += 4, targetOffset += 2) {
    const mixed = Math.trunc((stereoFrame.readInt16LE(sourceOffset) + stereoFrame.readInt16LE(sourceOffset + 2)) / 2)
    monoFrame.writeInt16LE(Math.max(-32_768, Math.min(32_767, mixed)), targetOffset)
  }
  return monoFrame
}

function pulseArgs(device: string, playback: boolean, channels: number): string[] {
  return [
    ...(playback ? ['--playback'] : []), '--raw', `--server=${PULSE_SERVER}`, `--device=${device}`,
    `--format=${PCM_MEDIA_SAMPLE_FORMAT}`, `--rate=${PCM_MEDIA_SAMPLE_RATE}`, `--channels=${channels}`,
  ]
}

function spawnMediaProcess(command: string, args: readonly string[]): MediaProcess {
  return spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
}

function runPulseCommand(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function isCandidatePulseSink(value: string): boolean {
  return Boolean(value) && !value.includes('\0') && value !== 'qq_source'
    && value !== '@DEFAULT_SOURCE@' && value !== '@DEFAULT_MONITOR@' && !value.endsWith('.monitor')
}

function listPulseSinks(output: string): Set<string> {
  return new Set(output.split(/\r?\n/).flatMap((line) => {
    const fields = line.split('\t')
    return fields.length >= 2 && fields[1] ? [fields[1]] : []
  }))
}

function normalizedLeaseToken(token: Uint8Array | undefined): Buffer {
  const normalized = Buffer.alloc(LEASE_TOKEN_BYTES)
  if (token) normalized.set(token.subarray(0, LEASE_TOKEN_BYTES))
  return normalized
}

function sameCallIdentity(left: Buffer | undefined, right: Buffer): boolean {
  return Boolean(left && left.length === right.length && timingSafeEqual(left, right))
}

function stopProcess(process: MediaProcess | undefined): void {
  try {
    process?.kill('SIGTERM')
  } catch {
    // Cleanup must not keep the gateway session alive.
  }
}

async function refuseExistingSocket(socketPath: string): Promise<void> {
  try {
    await lstat(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  // This pathname is configured outside the gateway, so no existing entry can
  // be proven ours. Fail closed rather than racing a listener or replacement.
  throw new Error('PCM media socket path already exists')
}
