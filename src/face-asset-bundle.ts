import { inflateRawSync } from 'node:zlib'

/**
 * QQ hands out several face resources as ZIP bundles. The archive wraps the
 * real image inside an `<id>/<type>/<name>.png` tree (the same layout QQNT
 * keeps under `nt_data/Emoji/emoji-resource`), so relaying the archive verbatim
 * makes every Telegram client fail to decode the face. These helpers unwrap the
 * entry that matches the advertised face id and geometry.
 *
 * The observed bundles store their sizes in the central directory and use a
 * trailing data descriptor for the local entries, so entries are located
 * through the end-of-central-directory record instead of the local headers.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_HEADER = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50
const CENTRAL_HEADER_BYTES = 46
const LOCAL_HEADER_BYTES = 30
const STORED_METHOD = 0
const DEFLATED_METHOD = 8
const ZIP64_SENTINEL = 0xffffffff
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 64
const END_OF_CENTRAL_DIRECTORY_BYTES = 22
const MAX_END_OF_CENTRAL_DIRECTORY_TAIL = 0xffff + END_OF_CENTRAL_DIRECTORY_BYTES

export type FaceAssetMimeType = 'image/png' | 'image/apng' | 'image/gif' | 'image/webp'

export interface FaceAssetImage {
  bytes: Buffer
  mimeType: FaceAssetMimeType
  width?: number
  height?: number
}

/** Geometry the caller advertises for the requested face, when it is known. */
export interface FaceAssetTarget {
  /** Face id the caller asked for, for example `424` for the key `1:424`. */
  faceId?: string
  width?: number
  height?: number
}

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_CHUNK_HEADER_BYTES = 8

export function isZipPayload(bytes: Uint8Array): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/** Detects the image type and intrinsic size of a raw image payload. */
export function sniffFaceImage(bytes: Buffer): FaceAssetImage | undefined {
  const png = sniffPng(bytes)
  if (png) return png
  const gif = sniffGif(bytes)
  if (gif) return gif
  return sniffWebp(bytes)
}

/**
 * Returns the image a ZIP face bundle advertises for `target`, or `undefined`
 * when the payload is not a bundle this helper understands.
 */
export function resolveFaceAssetImage(
  payload: Buffer,
  target: FaceAssetTarget = {},
): FaceAssetImage | undefined {
  if (!isZipPayload(payload) || payload.length > MAX_ARCHIVE_BYTES) return undefined
  const entries = readZipEntries(payload)
  if (!entries?.length) return undefined
  const candidates: Array<{ name: string, image: FaceAssetImage }> = []
  let budget = MAX_ARCHIVE_BYTES
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    const data = readZipEntryData(payload, entry)
    if (!data || data.length > budget) continue
    const image = sniffFaceImage(data)
    if (!image) continue
    budget -= data.length
    candidates.push({ name: entry.name, image })
  }
  if (!candidates.length) return undefined
  return pickFaceImage(candidates, target)
}

/**
 * Prefers the entry that belongs to the requested face and whose aspect ratio
 * matches what we advertise for it, so a wide face is not stretched into the
 * inline square. Ties resolve to the canonical `<id>.png` entry.
 */
function pickFaceImage(
  candidates: Array<{ name: string, image: FaceAssetImage }>,
  target: FaceAssetTarget,
): FaceAssetImage {
  const declaredAspect = positiveRatio(target.width, target.height)
  const ranked = candidates.map((candidate) => {
    const stem = entryStem(candidate.name)
    const related = !target.faceId
      || stem === target.faceId
      || stem.startsWith(`${target.faceId}_`)
    return {
      candidate,
      related,
      canonical: !target.faceId || stem === target.faceId,
      aspect: aspectDistance(candidate.image, declaredAspect),
    }
  })
  ranked.sort((left, right) => {
    if (left.related !== right.related) return left.related ? -1 : 1
    if (left.aspect !== right.aspect) return left.aspect - right.aspect
    if (left.canonical !== right.canonical) return left.canonical ? -1 : 1
    return left.candidate.image.bytes.length - right.candidate.image.bytes.length
  })
  return ranked[0]!.candidate.image
}

function positiveRatio(width: number | undefined, height: number | undefined): number | undefined {
  if (!width || !height || width <= 0 || height <= 0) return undefined
  return width / height
}

function aspectDistance(image: FaceAssetImage, declaredAspect: number | undefined): number {
  const actual = positiveRatio(image.width, image.height)
  if (!declaredAspect || !actual) return Number.POSITIVE_INFINITY
  return Math.abs(Math.log(actual / declaredAspect))
}

function entryStem(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

function sniffPng(bytes: Buffer): FaceAssetImage | undefined {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return {
    bytes,
    mimeType: isAnimatedPng(bytes) ? 'image/apng' : 'image/png',
    width: width > 0 ? width : undefined,
    height: height > 0 ? height : undefined,
  }
}

function isAnimatedPng(bytes: Buffer): boolean {
  let offset = PNG_SIGNATURE.length
  while (offset + PNG_CHUNK_HEADER_BYTES <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    if (type === 'acTL') return true
    if (type === 'IDAT' || type === 'IEND') return false
    offset += PNG_CHUNK_HEADER_BYTES + length + 4
    if (length > bytes.length) return false
  }
  return false
}

function sniffGif(bytes: Buffer): FaceAssetImage | undefined {
  if (bytes.length < 10) return undefined
  const header = bytes.toString('latin1', 0, 6)
  if (header !== 'GIF87a' && header !== 'GIF89a') return undefined
  const width = bytes.readUInt16LE(6)
  const height = bytes.readUInt16LE(8)
  return {
    bytes,
    mimeType: 'image/gif',
    width: width > 0 ? width : undefined,
    height: height > 0 ? height : undefined,
  }
}

function sniffWebp(bytes: Buffer): FaceAssetImage | undefined {
  if (bytes.length < 30) return undefined
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return undefined
  if (bytes.toString('latin1', 12, 16) !== 'VP8X') return { bytes, mimeType: 'image/webp' }
  return {
    bytes,
    mimeType: 'image/webp',
    width: bytes.readUIntLE(24, 3) + 1,
    height: bytes.readUIntLE(27, 3) + 1,
  }
}

function readZipEntries(bytes: Buffer): ZipEntry[] | undefined {
  const directoryEnd = findEndOfCentralDirectory(bytes)
  if (directoryEnd === undefined) return undefined
  const entryCount = bytes.readUInt16LE(directoryEnd + 10)
  const directoryOffset = bytes.readUInt32LE(directoryEnd + 16)
  if (!entryCount || entryCount > MAX_ARCHIVE_ENTRIES || directoryOffset === ZIP64_SENTINEL) return undefined
  const entries: ZipEntry[] = []
  let cursor = directoryOffset
  for (let index = 0; index < entryCount; index++) {
    if (cursor + CENTRAL_HEADER_BYTES > bytes.length) return undefined
    if (bytes.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_HEADER) return undefined
    const method = bytes.readUInt16LE(cursor + 10)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42)
    const nameStart = cursor + CENTRAL_HEADER_BYTES
    if (nameStart + nameLength > bytes.length) return undefined
    entries.push({
      name: bytes.toString('utf8', nameStart, nameStart + nameLength),
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    })
    cursor = nameStart + nameLength + extraLength + commentLength
  }
  return entries
}

function readZipEntryData(bytes: Buffer, entry: ZipEntry): Buffer | undefined {
  if (entry.method !== STORED_METHOD && entry.method !== DEFLATED_METHOD) return undefined
  if (!entry.compressedSize || entry.uncompressedSize > MAX_ARCHIVE_BYTES) return undefined
  if (entry.compressedSize === ZIP64_SENTINEL || entry.uncompressedSize === ZIP64_SENTINEL) return undefined
  const start = entry.localHeaderOffset
  if (start + LOCAL_HEADER_BYTES > bytes.length || bytes.readUInt32LE(start) !== LOCAL_FILE_HEADER) return undefined
  const dataStart = start + LOCAL_HEADER_BYTES
    + bytes.readUInt16LE(start + 26)
    + bytes.readUInt16LE(start + 28)
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > bytes.length) return undefined
  const raw = bytes.subarray(dataStart, dataEnd)
  if (entry.method === STORED_METHOD) {
    return entry.uncompressedSize === raw.length ? Buffer.from(raw) : undefined
  }
  try {
    const inflated = inflateRawSync(raw)
    return inflated.length === entry.uncompressedSize ? inflated : undefined
  } catch {
    return undefined
  }
}

function findEndOfCentralDirectory(bytes: Buffer): number | undefined {
  const from = Math.max(0, bytes.length - MAX_END_OF_CENTRAL_DIRECTORY_TAIL)
  for (let offset = bytes.length - END_OF_CENTRAL_DIRECTORY_BYTES; offset >= from; offset--) {
    if (bytes.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset
  }
  return undefined
}
