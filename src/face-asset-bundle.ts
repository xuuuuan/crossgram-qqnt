import { crc32 as nodeCrc32, inflateRawSync } from 'node:zlib'

/**
 * QQ hands out several face resources as ZIP bundles. The archive wraps the
 * real image inside an `<id>/<type>/<name>.png` tree (the same layout QQNT
 * keeps under `nt_data/Emoji/emoji-resource`), so relaying the archive verbatim
 * makes every Telegram client fail to decode the face.
 *
 * These helpers expose two views of a bundle:
 *
 * - {@link resolveFaceAssetMetaFromDirectory} reads only the end of the archive
 *   (end-of-central-directory record plus the central directory). QQ writes the
 *   real sizes and CRC-32 there and keeps data descriptors in the local
 *   headers, so a small ranged read is enough to learn the exact size and
 *   content identity of the image without downloading it.
 * - {@link resolveFaceAssetImage} inflates the chosen entry for serving.
 *
 * Both use {@link pickFaceAssetEntry} so the announced metadata always matches
 * the bytes that are served.
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

/** Identity of the archive entry a bundle offers for one face. */
export interface FaceAssetMeta {
  /** Entry name inside the archive, for diagnostics. */
  name: string
  /** Uncompressed image length in bytes. */
  size: number
  /** CRC-32 of the uncompressed image; changes whenever the remote asset does. */
  version: number
  /** ZIP compression method, so callers can tell whether inflating is needed. */
  method: number
}

/** Geometry and animation the caller advertises for the requested face. */
export interface FaceAssetTarget {
  /** Face id the caller asked for, for example `424` for the key `1:424`. */
  faceId?: string
  width?: number
  height?: number
  /**
   * Whether the caller expects an animated face. When the value is known,
   * entries under an `apng/` directory win (or lose) so the bytes that are
   * served carry the animation the catalog advertises.
   */
  animated?: boolean
}

export interface FaceAssetCandidate {
  name: string
  size: number
}

interface ZipEntry {
  name: string
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_CHUNK_HEADER_BYTES = 8
const IMAGE_ENTRY_PATTERN = /\.(?:png|apng|gif|webp|jpg|jpeg)$/i

export function isZipPayload(bytes: Uint8Array): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/** CRC-32 of an image, used as the content identity of a face resource. */
export function faceAssetVersion(bytes: Uint8Array): number {
  if (typeof nodeCrc32 === 'function') return nodeCrc32(bytes) >>> 0
  return crc32Fallback(bytes)
}

/**
 * Ranks the archive entries that could represent `target`. The square
 * `<id>.png` entry is the inline face; canvas variants carry an underscore
 * suffix (`<id>_0.png`) and match the geometry QQ advertises for faces that
 * animate on a wider canvas.
 */
export function rankFaceAssetEntries<T extends FaceAssetCandidate>(
  candidates: readonly T[],
  target: FaceAssetTarget = {},
): T[] {
  const faceId = target.faceId
  const square = isSquareGeometry(target.width, target.height)
  const ranked = candidates.map((candidate) => {
    const stem = entryStem(candidate.name)
    const suffixed = /_\d+$/.test(stem)
    const related = !faceId || stem === faceId || stem.startsWith(`${faceId}_`)
    const canonical = faceId ? stem === faceId : !suffixed
    // Bundles wrap the animated face under `apng/` and its static fallback
    // under `png/`; the advertised animation decides between them.
    const animated = /(?:^|\/)apng\//i.test(candidate.name)
    return {
      candidate,
      related,
      // A square face is served by its canonical entry, a wide one by the
      // canvas variant; without a known geometry prefer the canonical entry.
      preferred: square ? canonical : related && suffixed,
      canonical,
      format: target.animated === undefined || target.animated === animated ? 0 : 1,
    }
  })
  ranked.sort((left, right) => {
    if (left.related !== right.related) return left.related ? -1 : 1
    if (left.preferred !== right.preferred) return left.preferred ? -1 : 1
    if (left.format !== right.format) return left.format - right.format
    if (left.canonical !== right.canonical) return left.canonical ? -1 : 1
    return left.candidate.size - right.candidate.size
  })
  return ranked.map((item) => item.candidate)
}

/** Alias kept for callers that only need the single best entry. */
export function pickFaceAssetEntry<T extends FaceAssetCandidate>(
  candidates: readonly T[],
  target: FaceAssetTarget = {},
): T | undefined {
  return rankFaceAssetEntries(candidates, target)[0]
}

/**
 * Reads the central directory of a bundle, which is enough for the size and
 * content identity of the served image. `directory` may be a tail of the
 * archive (as returned by a ranged request) because the central directory never
 * needs the file payload.
 */
export function resolveFaceAssetMetaFromDirectory(
  directory: Buffer,
  target: FaceAssetTarget = {},
): FaceAssetMeta | undefined {
  if (!directory.length) return undefined
  const entries = readZipEntries(directory)
  if (!entries?.length) return undefined
  const ranked = rankFaceAssetEntries(entries.map((entry) => ({
    name: entry.name, size: entry.uncompressedSize,
  })), target)
  for (const candidate of ranked) {
    const entry = entries.find((item) => item.name === candidate.name)
    if (!entry) continue
    if (!entry.uncompressedSize || entry.uncompressedSize === ZIP64_SENTINEL) continue
    if (entry.uncompressedSize > MAX_ARCHIVE_BYTES) continue
    return {
      name: entry.name, size: entry.uncompressedSize, version: entry.crc32 >>> 0, method: entry.method,
    }
  }
  return undefined
}

/** Detects the image type and intrinsic size of a raw image payload. */
export function sniffFaceImage(bytes: Buffer): FaceAssetImage | undefined {
  const png = sniffPng(bytes)
  if (png) return png
  const gif = sniffGif(bytes)
  if (gif) return gif
  return sniffWebp(bytes)
}

/** Returns the image a ZIP face bundle serves for `target`. */
export function resolveFaceAssetImage(
  payload: Buffer,
  target: FaceAssetTarget = {},
): FaceAssetImage | undefined {
  if (!isZipPayload(payload) || payload.length > MAX_ARCHIVE_BYTES) return undefined
  const entries = readZipEntries(payload)
  if (!entries?.length) return undefined
  const ranked = rankFaceAssetEntries(entries.map((entry) => ({
    name: entry.name, size: entry.uncompressedSize,
  })), target)
  for (const candidate of ranked) {
    const entry = entries.find((item) => item.name === candidate.name)
    if (!entry) continue
    const data = readZipEntryData(payload, entry)
    if (!data || data.length > MAX_ARCHIVE_BYTES) continue
    const image = sniffFaceImage(data)
    if (image) return image
  }
  return undefined
}

/** Returns true when the entry name looks like an image this module can serve. */
export function isFaceAssetEntryName(name: string): boolean {
  return IMAGE_ENTRY_PATTERN.test(name) && !name.endsWith('/')
}

export function inflateFaceAssetEntry(payload: Buffer, meta: FaceAssetMeta): Buffer | undefined {
  const entries = readZipEntries(payload)
  const entry = entries?.find((item) => item.name === meta.name)
  if (!entry) return undefined
  return readZipEntryData(payload, entry)
}

function isSquareGeometry(width: number | undefined, height: number | undefined): boolean {
  const ratio = positiveRatio(width, height)
  if (!ratio) return true
  return Math.abs(Math.log(ratio)) < 0.05
}

function positiveRatio(width: number | undefined, height: number | undefined): number | undefined {
  if (!width || !height || width <= 0 || height <= 0) return undefined
  return width / height
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
    const crc32 = bytes.readUInt32LE(cursor + 16)
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
      method, crc32, compressedSize, uncompressedSize, localHeaderOffset,
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

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32Fallback(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (let index = 0; index < bytes.length; index++) {
    value = CRC32_TABLE[(value ^ bytes[index]!) & 0xff]! ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}
