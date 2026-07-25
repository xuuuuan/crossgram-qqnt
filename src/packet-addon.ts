import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface NativePacketRequest {
  command: string
  payload: Buffer
}

export interface NativeRkey {
  value: string
  ttlSeconds: string
  createdAt: number
  kind: number
}

export interface NativeSendBindingLocation {
  moduleBase: string
  profile: string
  timeDateStamp: number
  sizeOfImage: number
  anchorRva: number
  xrefRva: number
  functionRva: number
  converterRva: number
  responseRva: number
}

export interface PacketAddon {
  sendPacket(
    send: (command: string, payload: Buffer) => unknown,
    command: string,
    payload: Buffer,
  ): unknown
  encodeFetchRkeyRequest(): NativePacketRequest
  decodeFetchRkeyResponse(payload: Buffer): NativeRkey[]
  refreshImageUrl(originalUrl: string, rkey: string): string
  locateSendBinding(): NativeSendBindingLocation
  installSendHook(): NativeSendBindingLocation
}

let loadedAddon: PacketAddon | undefined
const moduleFilename = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)

export function loadPacketAddon(): PacketAddon {
  if (loadedAddon) return loadedAddon
  const candidate = packetAddonCandidates().find(existsSync)
  if (!candidate) {
    throw new Error(`QQNT packet addon was not found; tried: ${packetAddonCandidates().join(', ')}`)
  }
  const required = createRequire(moduleFilename)(candidate) as Partial<PacketAddon>
  for (const name of [
    'sendPacket', 'encodeFetchRkeyRequest', 'decodeFetchRkeyResponse',
    'refreshImageUrl', 'locateSendBinding', 'installSendHook',
  ] satisfies Array<keyof PacketAddon>) {
    if (typeof required[name] !== 'function') throw new Error(`QQNT packet addon is missing ${name}`)
  }
  return loadedAddon = required as PacketAddon
}

function packetAddonCandidates(): string[] {
  const sourceDir = dirname(moduleFilename)
  const artifactDir = join(sourceDir, '..', 'native', 'packet-addon', 'artifacts')
  const artifact = existsSync(artifactDir)
    ? readdirSync(artifactDir).find((name) => name.endsWith('.node'))
    : undefined
  const platformSuffix = process.platform === 'win32'
    ? `${process.platform}-${process.arch}-msvc`
    : `${process.platform}-${process.arch}-gnu`
  return [
    process.env.QQNT_BRIDGE_PACKET_ADDON,
    join(sourceDir, `qqnt_packet.${platformSuffix}.node`),
    artifact ? join(artifactDir, artifact) : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate))
}

export function resetPacketAddonForTesting(): void {
  loadedAddon = undefined
}
