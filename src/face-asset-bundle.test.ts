import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { isZipPayload, resolveFaceAssetImage, sniffFaceImage } from './face-asset-bundle.js'

interface BundleEntry {
  name: string
  data: Buffer
  /** Stores the bytes uncompressed, like the ZIP entries that skip deflate. */
  stored?: boolean
}

/** Builds a bundle shaped like QQ's downloads: data descriptors, sizes only in the central directory. */
function buildBundle(entries: readonly BundleEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.stored ? entry.data : deflateRawSync(entry.data)
    const method = entry.stored ? 0 : 8
    const flags = entry.stored ? 0 : 0x0008
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(name.length, 26)
    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(data.length, 8)
    descriptor.writeUInt32LE(entry.data.length, 12)
    locals.push(local, name, data, descriptor)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length + descriptor.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

function pngBytes(width: number, height: number, options: { animated?: boolean } = {}): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const header = Buffer.alloc(8)
    header.writeUInt32BE(data.length, 0)
    header.write(type, 4, 'latin1')
    return Buffer.concat([header, data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const png = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ]
  if (options.animated) png.push(chunk('acTL', Buffer.alloc(8)))
  png.push(chunk('IDAT', Buffer.from([0x78, 0x9c, 0x00])), chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(png)
}

describe('face asset bundles', () => {
  it('recognizes ZIP payloads and sniffs plain images', () => {
    expect(isZipPayload(buildBundle([{ name: '424/png/424.png', data: pngBytes(8, 8) }]))).toBe(true)
    expect(isZipPayload(pngBytes(128, 128))).toBe(false)
    expect(sniffFaceImage(pngBytes(128, 96))).toMatchObject({
      mimeType: 'image/png', width: 128, height: 96,
    })
    expect(sniffFaceImage(pngBytes(128, 128, { animated: true }))).toMatchObject({
      mimeType: 'image/apng', width: 128, height: 128,
    })
    expect(sniffFaceImage(Buffer.from('not an image'))).toBeUndefined()
  })

  it('prefers the canonical square entry for a square face', () => {
    const canonical = pngBytes(128, 128)
    const canvas = pngBytes(512, 512)
    const bundle = buildBundle([
      { name: '424/png/424.png', data: canonical },
      { name: '424/png/424_0.png', data: canvas },
    ])
    const image = resolveFaceAssetImage(bundle, { faceId: '424', width: 128, height: 128 })
    expect(image?.bytes).toEqual(canonical)
    expect(image).toMatchObject({ mimeType: 'image/png', width: 128, height: 128 })
  })

  it('follows the advertised geometry for canvas faces', () => {
    const square = pngBytes(128, 128)
    const canvas = pngBytes(480, 190)
    const bundle = buildBundle([
      { name: '416/png/416.png', data: square },
      { name: '416/png/416_0.png', data: canvas },
    ])
    expect(resolveFaceAssetImage(bundle, { faceId: '416', width: 192, height: 76 })?.bytes).toEqual(canvas)
    expect(resolveFaceAssetImage(bundle, { faceId: '416' })?.bytes).toEqual(square)
  })

  it('serves stored entries and reports animated payloads', () => {
    const apng = pngBytes(240, 240, { animated: true })
    const bundle = buildBundle([{ name: '476/apng/476.png', data: apng, stored: true }])
    expect(resolveFaceAssetImage(bundle, { faceId: '476', width: 128, height: 128 })).toMatchObject({
      mimeType: 'image/apng', width: 240, height: 240,
    })
  })

  it('falls back to any image entry and rejects malformed bundles', () => {
    const square = pngBytes(128, 128)
    const bundle = buildBundle([
      { name: '415/png/415_0.png', data: square },
      { name: '415/png/415.txt', data: Buffer.from('ignore me') },
    ])
    expect(resolveFaceAssetImage(bundle, { faceId: '415', width: 128, height: 128 })?.bytes).toEqual(square)
    expect(resolveFaceAssetImage(bundle.subarray(0, 40), { faceId: '415' })).toBeUndefined()
    expect(resolveFaceAssetImage(buildBundle([]), { faceId: '415' })).toBeUndefined()
    expect(resolveFaceAssetImage(pngBytes(128, 128), { faceId: '415' })).toBeUndefined()
  })
})
