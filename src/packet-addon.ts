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

export interface NativeDirectUrl {
  url: string
  ttlSeconds: number
  createdAt: number
}

export interface NativeSysFace {
  faceId: string
  name: string
  url: string
  aniStickerType: number
  aniStickerPackId: number
  aniStickerId: number
  width: number
  height: number
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

export interface PacketBindingProbe {
  moduleBase: string
  modulePath: string
  profile: string
  buildId: string
  sha256: string
  nameSlotRva: string
  bindingNameRva: string
  bindingName: string
  napiCallbackSlotRva: string
  napiCallbackRva: string
  napiCallbackFingerprint: string
  responseActionSlotRva: string
  responseActionRva: string
  responseActionFingerprint: string
  converterRva: string
  converterFingerprint: string
  resolveActionRva: string
  resolveActionFingerprint: string
}

export type QrtcLifecycle = 'active' | 'closing' | 'destroyed'

/** Fixed, identifier-free status for the compile-time AVSDK loader identity probe. */
export interface AvsdkLoaderProbeStatus {
  prepared: boolean
  observed: boolean
  unique: boolean
  sameObject: boolean
  sameNamespace: boolean
  buildMatch: boolean
  flagsCompatible: boolean
  observationCount: number
}

/** Fixed, identifier-free QRTC lifecycle metadata for one authorized future observation. */
export interface QrtcMetadataSnapshot {
  lifecycle: QrtcLifecycle
  sameThread: boolean
  inFlight: number
  shutdownWasIdle: boolean
}

/** Deliberately a fixed snapshot surface, not an invocation or hook API. */
export interface QrtcMetadataAddon {
  qrtcMetadataStatus(): QrtcMetadataSnapshot
}

export interface PacketAddon {
  sendPacket(
    send: (command: string, payload: Buffer) => unknown,
    command: string,
    payload: Buffer,
  ): unknown
  encodeFetchRkeyRequest(): NativePacketRequest
  decodeFetchRkeyResponse(payload: Buffer): NativeRkey[]
  encodeFetchSysFacesRequest(): NativePacketRequest
  decodeFetchSysFacesResponse(payload: Buffer): NativeSysFace[]
  encodeVideoDownloadRequest(chatType: number, peer: string, selfUid: string, fileUuid: string): NativePacketRequest
  decodeVideoDownloadResponse(payload: Buffer): NativeDirectUrl
  encodeGroupFileDownloadRequest(group: string, fileUuid: string): NativePacketRequest
  decodeGroupFileDownloadResponse(payload: Buffer): NativeDirectUrl
  encodePrivateFileDownloadRequest(selfUid: string, fileUuid: string, fileHash: string): NativePacketRequest
  decodePrivateFileDownloadResponse(payload: Buffer): NativeDirectUrl
  refreshImageUrl(originalUrl: string, rkey: string): string
  probePacketBinding(): PacketBindingProbe
  locateSendBinding(): NativeSendBindingLocation
  installSendHook(): NativeSendBindingLocation
  avsdkLoaderProbeStatus?(): AvsdkLoaderProbeStatus
}

let loadedAddon: PacketAddon | undefined
const moduleFilename = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)
declare const __QQNT_BRIDGE_BUILD_DIST_DIR__: string | undefined
const buildDistDir = typeof __QQNT_BRIDGE_BUILD_DIST_DIR__ === 'string'
  ? __QQNT_BRIDGE_BUILD_DIST_DIR__
  : undefined

export function loadPacketAddon(): PacketAddon {
  if (loadedAddon) return loadedAddon
  const candidate = packetAddonCandidates().find(existsSync)
  if (!candidate) {
    throw new Error(`QQNT packet addon was not found; tried: ${packetAddonCandidates().join(', ')}`)
  }
  const required = createRequire(moduleFilename)(candidate) as Partial<PacketAddon>
  for (const name of [
    'sendPacket', 'encodeFetchRkeyRequest', 'decodeFetchRkeyResponse',
    'encodeFetchSysFacesRequest', 'decodeFetchSysFacesResponse',
    'encodeVideoDownloadRequest', 'decodeVideoDownloadResponse',
    'encodeGroupFileDownloadRequest', 'decodeGroupFileDownloadResponse',
    'encodePrivateFileDownloadRequest', 'decodePrivateFileDownloadResponse',
    'refreshImageUrl', 'probePacketBinding', 'locateSendBinding', 'installSendHook',
    'avsdkLoaderProbeStatus',
  ] satisfies Array<keyof PacketAddon>) {
    if (typeof required[name] !== 'function') throw new Error(`QQNT packet addon is missing ${name}`)
  }
  return loadedAddon = required as PacketAddon
}

export function loadQrtcMetadataAddon(
  loadAddon: () => Partial<QrtcMetadataAddon> = () => loadPacketAddon() as PacketAddon & Partial<QrtcMetadataAddon>,
): QrtcMetadataAddon {
  const addon = loadAddon()
  if (typeof addon.qrtcMetadataStatus !== 'function') {
    throw new Error('QQNT packet addon is missing qrtcMetadataStatus')
  }
  return addon as QrtcMetadataAddon
}

export function packetAddonCandidates(
  filename = moduleFilename,
  bundledDistDir = buildDistDir,
): string[] {
  const sourceDir = dirname(filename)
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
    bundledDistDir ? join(bundledDistDir, `qqnt_packet.${platformSuffix}.node`) : undefined,
    artifact ? join(artifactDir, artifact) : undefined,
  ].filter((candidate, index, candidates): candidate is string =>
    Boolean(candidate) && candidates.indexOf(candidate) === index)
}

export function createPacketBindingProber(
  loadAddon: () => Pick<PacketAddon, 'probePacketBinding'> = loadPacketAddon,
): () => PacketBindingProbe | undefined {
  let probing = false
  return () => {
    if (probing) return
    probing = true
    try {
      return loadAddon().probePacketBinding()
    } finally {
      probing = false
    }
  }
}

export function createPacketHookInstaller(
  loadAddon: () => Pick<PacketAddon, 'installSendHook'> = loadPacketAddon,
): () => NativeSendBindingLocation | undefined {
  let installing = false
  return () => {
    if (installing) return
    installing = true
    try {
      return loadAddon().installSendHook()
    } finally {
      installing = false
    }
  }
}

export function resetPacketAddonForTesting(): void {
  loadedAddon = undefined
}
