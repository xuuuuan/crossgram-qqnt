import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PCM_MEDIA_FRAME_BYTES, PCM_MEDIA_PROTOCOL_VERSION } from './protocol.js'
import {
  downmixStereoS16le, LocalPCMMediaGateway, localPCMMediaGatewayFromEnvironment, type MediaProcess,
} from './media-gateway.js'

const HEADER_BYTES = 5
const AUTH_FRAME = 1
const UPLINK_FRAME = 2
const READY_FRAME = 0x80
const DOWNLINK_FRAME = 0x81
const pulseSinks = async () => '0\tqq_mic_sink\tmodule-null-sink.c\ts16le 1ch 48000Hz\tIDLE\n1\tcustom_mic_sink\tmodule-null-sink.c\ts16le 1ch 48000Hz\tIDLE\n'

class FakeMediaProcess extends EventEmitter implements MediaProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly kill = vi.fn(() => true)
}

function frame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  header[0] = type
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

function authPayload(lease: { leaseId: string, token: Buffer }): Buffer {
  return Buffer.concat([Buffer.from([PCM_MEDIA_PROTOCOL_VERSION]), Buffer.from(lease.leaseId, 'hex'), lease.token])
}

function collectFrames(socket: Socket): Array<{ type: number, payload: Buffer }> {
  const frames: Array<{ type: number, payload: Buffer }> = []
  let pending = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= HEADER_BYTES) {
      const length = pending.readUInt32BE(1)
      if (pending.length < HEADER_BYTES + length) return
      frames.push({ type: pending[0]!, payload: pending.subarray(HEADER_BYTES, HEADER_BYTES + length) })
      pending = pending.subarray(HEADER_BYTES + length)
    }
  })
  return frames
}

async function connectedSocket(socketPath: string, sockets: Socket[]): Promise<Socket> {
  const socket = createConnection(socketPath)
  sockets.push(socket)
  await once(socket, 'connect')
  return socket
}

describe.skipIf(process.platform === 'win32')('LocalPCMMediaGateway', () => {
  const gateways: LocalPCMMediaGateway[] = []
  const directories: string[] = []
  const sockets: Socket[] = []

  afterEach(async () => {
    vi.unstubAllEnvs()
    for (const socket of sockets.splice(0)) socket.destroy()
    await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()))
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('is disabled unless the media feature flag is explicitly set', () => {
    vi.stubEnv('QQNT_BRIDGE_MEDIA_GATEWAY', '')
    expect(localPCMMediaGatewayFromEnvironment()).toBeUndefined()
  })

  it('downmixes one stereo capture frame into exactly one mono frame with bounded signed samples', () => {
    const stereo = Buffer.alloc(PCM_MEDIA_FRAME_BYTES * 2)
    stereo.writeInt16LE(12_000, 0)
    stereo.writeInt16LE(-4_000, 2)
    stereo.writeInt16LE(32_767, 4)
    stereo.writeInt16LE(32_767, 6)
    stereo.writeInt16LE(-32_768, 8)
    stereo.writeInt16LE(-32_768, 10)

    const mono = downmixStereoS16le(stereo)

    expect(mono).toHaveLength(PCM_MEDIA_FRAME_BYTES)
    expect(mono.readInt16LE(0)).toBe(4_000)
    expect(mono.readInt16LE(2)).toBe(32_767)
    expect(mono.readInt16LE(4)).toBe(-32_768)
  })

  it('authenticates a valid lease, captures stereo, downmixes it, and plays uplink into qq_mic_sink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qq-pcm-gateway-'))
    directories.push(directory)
    const processes: Array<{ command: string, args: readonly string[], process: FakeMediaProcess }> = []
    const gateway = new LocalPCMMediaGateway({
      socketPath: join(directory, 'media.sock'),
      processSpawner: (command, args) => {
        const process = new FakeMediaProcess()
        processes.push({ command, args, process })
        return process
      },
      pulseCommand: async () => pulseSinks(),
    })
    gateways.push(gateway)
    const lease = gateway.issueLease({ callId: 'private' })
    expect(lease.token).toHaveLength(32)
    await gateway.start()

    const socket = await connectedSocket(join(directory, 'media.sock'), sockets)
    const frames = collectFrames(socket)
    socket.write(frame(AUTH_FRAME, authPayload(lease)))

    await vi.waitFor(() => expect(frames).toContainEqual({ type: READY_FRAME, payload: Buffer.from([PCM_MEDIA_PROTOCOL_VERSION]) }))
    expect(processes.map(({ command }) => command)).toEqual(['parecord', 'pacat'])
    expect(processes[0]!.args).toEqual(expect.arrayContaining([
      '--raw', '--server=unix:/run/qq-pulse/native', '--device=qq_sink.monitor', '--format=s16le', '--rate=48000', '--channels=2',
    ]))
    expect(processes[1]!.args).toEqual(expect.arrayContaining([
      '--playback', '--raw', '--server=unix:/run/qq-pulse/native', '--device=qq_mic_sink', '--format=s16le', '--rate=48000', '--channels=1',
    ]))
    expect(processes[1]!.args).not.toContain('--device=qq_source')

    const uplink = Buffer.alloc(PCM_MEDIA_FRAME_BYTES, 7)
    const receivedUplink: Buffer[] = []
    processes[1]!.process.stdin.on('data', (chunk: Buffer) => receivedUplink.push(chunk))
    socket.write(frame(UPLINK_FRAME, uplink))
    await vi.waitFor(() => expect(Buffer.concat(receivedUplink)).toEqual(uplink))

    const downlink = Buffer.alloc(PCM_MEDIA_FRAME_BYTES * 2)
    for (let offset = 0; offset < downlink.length; offset += 4) {
      downlink.writeInt16LE(10, offset)
      downlink.writeInt16LE(20, offset + 2)
    }
    processes[0]!.process.stdout.write(downlink)
    const expectedDownlink = Buffer.alloc(PCM_MEDIA_FRAME_BYTES)
    expectedDownlink.fill(0)
    for (let offset = 0; offset < expectedDownlink.length; offset += 2) expectedDownlink.writeInt16LE(15, offset)
    await vi.waitFor(() => expect(frames).toContainEqual({ type: DOWNLINK_FRAME, payload: expectedDownlink }))

    socket.destroy()
    await vi.waitFor(() => {
      expect(processes[0]!.process.kill).toHaveBeenCalledWith('SIGTERM')
      expect(processes[1]!.process.kill).toHaveBeenCalledWith('SIGTERM')
    })
  })

  it('uses a configured microphone sink and rejects qq_source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qq-pcm-gateway-'))
    directories.push(directory)
    const processes: Array<{ args: readonly string[] }> = []
    const gateway = new LocalPCMMediaGateway({
      socketPath: join(directory, 'media.sock'), microphoneSink: 'custom_mic_sink',
      processSpawner: (_command, args) => {
        const process = new FakeMediaProcess()
        processes.push({ args })
        return process
      },
      pulseCommand: async () => pulseSinks(),
    })
    gateways.push(gateway)
    const lease = gateway.issueLease(undefined)
    await gateway.start()
    const socket = await connectedSocket(join(directory, 'media.sock'), sockets)
    socket.write(frame(AUTH_FRAME, authPayload(lease)))
    await vi.waitFor(() => expect(processes).toHaveLength(2))
    expect(processes[1]!.args).toContain('--device=custom_mic_sink')
    expect(() => new LocalPCMMediaGateway({ socketPath: join(directory, 'other.sock'), microphoneSink: 'qq_source' }))
      .toThrow('PCM media gateway configuration is invalid')
  })

  it('rejects wrong, expired, and replayed leases without spawning another audio session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qq-pcm-gateway-'))
    directories.push(directory)
    let now = 1
    const spawn = vi.fn(() => new FakeMediaProcess())
    const gateway = new LocalPCMMediaGateway({
      socketPath: join(directory, 'media.sock'), processSpawner: spawn, pulseCommand: async () => pulseSinks(), now: () => now,
    })
    gateways.push(gateway)
    await gateway.start()

    const wrongLease = gateway.issueLease(undefined)
    const wrong = await connectedSocket(join(directory, 'media.sock'), sockets)
    wrong.write(frame(AUTH_FRAME, Buffer.concat([Buffer.from([PCM_MEDIA_PROTOCOL_VERSION]), Buffer.from(wrongLease.leaseId, 'hex'), Buffer.alloc(32)])))
    await once(wrong, 'close')
    expect(spawn).not.toHaveBeenCalled()

    const expiredLease = gateway.issueLease(undefined)
    now += 10_000
    const expired = await connectedSocket(join(directory, 'media.sock'), sockets)
    expired.write(frame(AUTH_FRAME, authPayload(expiredLease)))
    await once(expired, 'close')
    expect(spawn).not.toHaveBeenCalled()

    const validLease = gateway.issueLease(undefined)
    const valid = await connectedSocket(join(directory, 'media.sock'), sockets)
    valid.write(frame(AUTH_FRAME, authPayload(validLease)))
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    valid.destroy()
    await once(valid, 'close')

    const replay = await connectedSocket(join(directory, 'media.sock'), sockets)
    replay.write(frame(AUTH_FRAME, authPayload(validLease)))
    await once(replay, 'close')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('allows only one connected client and cleans up started processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qq-pcm-gateway-'))
    directories.push(directory)
    const capture = new FakeMediaProcess()
    const playback = new FakeMediaProcess()
    const spawn = vi.fn().mockReturnValueOnce(capture).mockReturnValueOnce(playback)
    const gateway = new LocalPCMMediaGateway({
      socketPath: join(directory, 'media.sock'), processSpawner: spawn, pulseCommand: async () => pulseSinks(),
    })
    gateways.push(gateway)
    const lease = gateway.issueLease(undefined)
    await gateway.start()

    const first = await connectedSocket(join(directory, 'media.sock'), sockets)
    const second = await connectedSocket(join(directory, 'media.sock'), sockets)
    await once(second, 'close')
    first.write(frame(AUTH_FRAME, authPayload(lease)))
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    first.destroy()
    await vi.waitFor(() => {
      expect(capture.kill).toHaveBeenCalledWith('SIGTERM')
      expect(playback.kill).toHaveBeenCalledWith('SIGTERM')
    })
  })

  it('parses fragmented headers and payloads while accepting a bounded coalesced frame burst', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qq-pcm-gateway-'))
    directories.push(directory)
    const processes: FakeMediaProcess[] = []
    const gateway = new LocalPCMMediaGateway({
      socketPath: join(directory, 'media.sock'),
      processSpawner: () => {
        const process = new FakeMediaProcess()
        processes.push(process)
        return process
      },
      pulseCommand: async () => pulseSinks(),
    })
    gateways.push(gateway)
    const lease = gateway.issueLease()
    await gateway.start()
    const socket = await connectedSocket(join(directory, 'media.sock'), sockets)
    const frames = collectFrames(socket)
    const auth = frame(AUTH_FRAME, authPayload(lease))
    socket.write(auth.subarray(0, 2))
    socket.write(auth.subarray(2, 9))
    socket.write(auth.subarray(9))
    await vi.waitFor(() => expect(frames).toContainEqual({ type: READY_FRAME, payload: Buffer.from([PCM_MEDIA_PROTOCOL_VERSION]) }))

    const received: Buffer[] = []
    processes[1]!.stdin.on('data', (chunk: Buffer) => received.push(chunk))
    const uplinks = Array.from({ length: 4 }, (_, index) => frame(UPLINK_FRAME, Buffer.alloc(PCM_MEDIA_FRAME_BYTES, index + 1)))
    socket.write(Buffer.concat(uplinks))
    await vi.waitFor(() => expect(Buffer.concat(received)).toEqual(Buffer.concat(uplinks.map((wire) => wire.subarray(HEADER_BYTES)))))
    expect(socket.destroyed).toBe(false)
  })

  it('validates playback targets against Pulse sinks without exposing target details', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qq-pcm-gateway-'))
    directories.push(directory)
    for (const target of ['qq_sink.monitor', '@DEFAULT_SOURCE@', '@DEFAULT_MONITOR@', 'qq_source']) {
      expect(() => new LocalPCMMediaGateway({ socketPath: join(directory, `${target.length}.sock`), microphoneSink: target }))
        .toThrow('PCM media gateway configuration is invalid')
    }
    const gateway = new LocalPCMMediaGateway({
      socketPath: join(directory, 'media.sock'), microphoneSink: 'not_a_source',
      pulseCommand: async () => pulseSinks(),
    })
    gateways.push(gateway)
    await expect(gateway.start()).rejects.toThrow('PCM media playback target is unavailable')
  })

  it('fails closed for stale, live, and non-socket paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qq-pcm-gateway-'))
    directories.push(directory)
    const stalePath = join(directory, 'stale.sock')
    const child = spawn(process.execPath, ['--input-type=module', '--eval', [
      "import { createServer } from 'node:net'",
      `createServer().listen(${JSON.stringify(stalePath)}, () => process.stdout.write('ready\\n'))`,
      'setInterval(() => {}, 1_000)',
    ].join(';')], { stdio: ['ignore', 'pipe', 'ignore'] })
    await once(child.stdout!, 'data')
    child.kill('SIGKILL')
    await once(child, 'exit')
    expect((await lstat(stalePath)).isSocket()).toBe(true)
    const staleGateway = new LocalPCMMediaGateway({ socketPath: stalePath, pulseCommand: async () => pulseSinks() })
    gateways.push(staleGateway)
    await expect(staleGateway.start()).rejects.toThrow('PCM media socket path already exists')
    expect((await lstat(stalePath)).isSocket()).toBe(true)

    const livePath = join(directory, 'live.sock')
    const listener = createServer()
    listener.listen(livePath)
    await once(listener, 'listening')
    const liveGateway = new LocalPCMMediaGateway({ socketPath: livePath, pulseCommand: async () => pulseSinks() })
    gateways.push(liveGateway)
    await expect(liveGateway.start()).rejects.toThrow('PCM media socket path already exists')
    expect((await lstat(livePath)).isSocket()).toBe(true)
    await new Promise<void>((resolve) => listener.close(() => resolve()))

    const filePath = join(directory, 'not-a-socket')
    await writeFile(filePath, 'not a socket')
    const fileGateway = new LocalPCMMediaGateway({ socketPath: filePath, pulseCommand: async () => pulseSinks() })
    gateways.push(fileGateway)
    await expect(fileGateway.start()).rejects.toThrow('PCM media socket path already exists')
    await expect(readFile(filePath, 'utf8')).resolves.toBe('not a socket')
  })

  it('preserves a path replaced after the gateway server closes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qq-pcm-gateway-'))
    directories.push(directory)
    const socketPath = join(directory, 'media.sock')
    const gateway = new LocalPCMMediaGateway({ socketPath, pulseCommand: async () => pulseSinks() })
    gateways.push(gateway)
    await gateway.start()
    const internal = gateway as unknown as { server?: Server }
    internal.server!.once('close', () => writeFileSync(socketPath, 'replacement'))

    await gateway.stop()

    await expect(readFile(socketPath, 'utf8')).resolves.toBe('replacement')
  })

  it('closes sessions on capture and playback stream errors and zeroes revoked tokens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qq-pcm-gateway-'))
    directories.push(directory)
    const processes: FakeMediaProcess[] = []
    const gateway = new LocalPCMMediaGateway({
      socketPath: join(directory, 'media.sock'),
      processSpawner: () => {
        const process = new FakeMediaProcess()
        processes.push(process)
        return process
      },
      pulseCommand: async () => pulseSinks(),
    })
    gateways.push(gateway)
    const internal = gateway as unknown as { leases: Map<string, { token: Buffer, callIdentity?: Buffer }> }
    const revoked = gateway.issueLease({ callId: 'call' })
    const revokedToken = internal.leases.get(revoked.leaseId)!.token
    const revokedCallIdentity = internal.leases.get(revoked.leaseId)!.callIdentity!
    gateway.revokeCallLeases('call')
    expect(revokedToken.every((byte) => byte === 0)).toBe(true)
    expect(revokedCallIdentity.every((byte) => byte === 0)).toBe(true)

    const firstLease = gateway.issueLease()
    await gateway.start()
    const first = await connectedSocket(join(directory, 'media.sock'), sockets)
    first.write(frame(AUTH_FRAME, authPayload(firstLease)))
    await vi.waitFor(() => expect(processes).toHaveLength(2))
    processes[0]!.stdout.emit('error', new Error('capture failed'))
    await vi.waitFor(() => expect(processes[0]!.kill).toHaveBeenCalledWith('SIGTERM'))

    const secondLease = gateway.issueLease()
    const second = await connectedSocket(join(directory, 'media.sock'), sockets)
    second.write(frame(AUTH_FRAME, authPayload(secondLease)))
    await vi.waitFor(() => expect(processes).toHaveLength(4))
    processes[3]!.stdin.emit('error', new Error('playback failed'))
    await vi.waitFor(() => expect(processes[3]!.kill).toHaveBeenCalledWith('SIGTERM'))

    const pending = gateway.issueLease()
    const pendingToken = internal.leases.get(pending.leaseId)!.token
    await gateway.stop()
    expect(pendingToken.every((byte) => byte === 0)).toBe(true)
  })

  it('revokes only the authenticated session for its call identity and clears it exactly once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qq-pcm-gateway-'))
    directories.push(directory)
    const processes: FakeMediaProcess[] = []
    const gateway = new LocalPCMMediaGateway({
      socketPath: join(directory, 'media.sock'),
      processSpawner: () => {
        const process = new FakeMediaProcess()
        processes.push(process)
        return process
      },
      pulseCommand: async () => pulseSinks(),
    })
    gateways.push(gateway)
    const internal = gateway as unknown as {
      leases: Map<string, { token: Buffer, callIdentity?: Buffer }>
      session?: { callIdentity?: Buffer }
    }
    const callId = 'call-id-must-not-log'
    const lease = gateway.issueLease({ callId })
    const storedToken = internal.leases.get(lease.leaseId)!.token
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    await gateway.start()
    const socket = await connectedSocket(join(directory, 'media.sock'), sockets)
    socket.write(frame(AUTH_FRAME, authPayload(lease)))
    await vi.waitFor(() => expect(processes).toHaveLength(2))
    const activeIdentity = internal.session!.callIdentity!
    const callIdentity = (gateway as unknown as { callIdentity(callId: string): Buffer }).callIdentity(callId)
    expect(activeIdentity.equals(callIdentity)).toBe(true)
    callIdentity.fill(0)
    expect(storedToken.every((byte) => byte === 0)).toBe(true)

    gateway.revokeCallLeases('wrong-call-id')
    expect(socket.destroyed).toBe(false)
    expect(processes.flatMap((process) => process.kill.mock.calls)).toEqual([])

    const closed = once(socket, 'close')
    socket.resume()
    gateway.revokeCallLeases(callId)
    await closed
    expect(internal.session).toBeUndefined()
    for (const process of processes) expect(process.kill).toHaveBeenCalledTimes(1)
    expect(processes[0]!.stdout.destroyed).toBe(true)
    expect(processes[1]!.stdin.destroyed).toBe(true)
    expect(processes[0]!.listenerCount('error')).toBe(0)
    expect(processes[0]!.listenerCount('exit')).toBe(0)
    expect(processes[1]!.listenerCount('error')).toBe(0)
    expect(processes[1]!.listenerCount('exit')).toBe(0)
    expect(processes[0]!.stdout.listenerCount('data')).toBe(0)
    expect(processes[1]!.stdin.listenerCount('error')).toBe(0)
    expect(activeIdentity.every((byte) => byte === 0)).toBe(true)

    gateway.revokeCallLeases(callId)
    for (const process of processes) expect(process.kill).toHaveBeenCalledTimes(1)
    expect(consoleLog.mock.calls.map(([message]) => String(message)).join('\n')).not.toContain(callId)

    const replacementLease = gateway.issueLease({ callId: 'replacement-call' })
    const replacement = await connectedSocket(join(directory, 'media.sock'), sockets)
    replacement.write(frame(AUTH_FRAME, authPayload(replacementLease)))
    await vi.waitFor(() => expect(processes).toHaveLength(4))
    processes[0]!.emit('exit')
    expect(replacement.destroyed).toBe(false)
  })
})
