import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { decode, encode } from 'silk-wasm'

const execFileAsync = promisify(execFile)
const SAMPLE_RATE = 24_000
export const MAX_VOICE_INPUT_BYTES = 32 * 1024 * 1024
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_DURATION_MS = 10 * 60 * 1_000
const MAX_PCM_BYTES = SAMPLE_RATE * 2 * MAX_DURATION_MS / 1_000
const FFMPEG_TIMEOUT_MS = 30_000

export async function encodePtt(inputPath: string, outputPath: string): Promise<number> {
  if ((await stat(inputPath)).size > MAX_VOICE_INPUT_BYTES) throw new Error('voice input exceeds the 32 MiB limit')
  await assertFfmpegAvailable()
  const pcm = await ffmpegBytes(['-i', inputPath, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1'])
  const encoded = await encode(pcm, SAMPLE_RATE)
  if (!encoded.data.byteLength || !Number.isFinite(encoded.duration) || encoded.duration < 0 || encoded.duration > MAX_DURATION_MS) {
    throw new Error('voice encoding produced an invalid duration')
  }
  await writeFile(outputPath, encoded.data)
  return Math.ceil(encoded.duration / 1_000)
}

export async function decodePttTo(inputPath: string, outputPath: string): Promise<void> {
  await assertPttInput(inputPath)
  await assertFfmpegAvailable()
  const pcmPath = `${outputPath}.${randomUUID()}.pcm`
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
  try {
    const silk = normalizeSilkPayload(await readFile(inputPath))
    const decoded = await decode(silk, SAMPLE_RATE)
    if (!decoded.data.byteLength
      || decoded.data.byteLength > MAX_PCM_BYTES
      || !Number.isFinite(decoded.duration)
      || decoded.duration <= 0
      || decoded.duration > MAX_DURATION_MS) {
      throw new Error('voice decoding produced an invalid duration')
    }
    await writeFile(pcmPath, decoded.data, { mode: 0o600 })
    await ffmpegFile(['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', pcmPath, '-c:a', 'libopus', '-f', 'ogg', outputPath])
    await assertUsableOgg(outputPath)
  } catch (error) {
    await rm(outputPath, { force: true })
    throw error
  } finally {
    await rm(pcmPath, { force: true })
  }
}

export async function transcodePttFallbackTo(inputPath: string, outputPath: string): Promise<void> {
  await assertPttInput(inputPath)
  await assertFfmpegAvailable()
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
  try {
    await ffmpegFile(['-i', inputPath, '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'libopus', '-f', 'ogg', outputPath])
    await assertUsableOgg(outputPath)
  } catch (error) {
    await rm(outputPath, { force: true })
    throw error
  }
}

function normalizeSilkPayload(input: Buffer): Buffer {
  // QQ desktop sometimes stores Tencent Silk with a 0x03 framing byte even
  // though the decoder accepts the otherwise identical 0x02 framing variant.
  if (input[0] !== 0x03 || input.subarray(1, 10).toString('ascii') !== '#!SILK_V3') return input
  const normalized = Buffer.from(input)
  normalized[0] = 0x02
  return normalized
}

export async function assertFfmpegAvailable(): Promise<void> {
  try {
    await execFileAsync('ffmpeg', ['-version'], {
      maxBuffer: 16 * 1024, timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL',
    })
  } catch {
    throw new Error('ffmpeg is required for QQ voice messages but is unavailable')
  }
}

async function assertPttInput(inputPath: string): Promise<void> {
  const size = (await stat(inputPath)).size
  if (size <= 0 || size > MAX_VOICE_INPUT_BYTES) throw new Error('voice input exceeds the 32 MiB limit')
}

async function assertUsableOgg(outputPath: string): Promise<void> {
  const size = (await stat(outputPath)).size
  if (size <= 0 || size > MAX_OUTPUT_BYTES) throw new Error('voice OGG exceeds the 32 MiB limit')
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', outputPath,
    ], { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 16 * 1024 })
    const duration = Number.parseFloat(stdout.trim())
    if (!Number.isFinite(duration) || duration <= 0 || duration * 1_000 > MAX_DURATION_MS) {
      throw new Error('voice OGG has an invalid duration')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'voice OGG has an invalid duration') throw error
    throw new Error('ffprobe is required to validate QQ voice OGG output', { cause: error })
  }
}

async function ffmpegBytes(args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('ffmpeg', ['-nostdin', '-v', 'error', ...args], {
    encoding: 'buffer', maxBuffer: MAX_PCM_BYTES, timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL',
  })
  if (stdout.byteLength > MAX_PCM_BYTES) throw new Error('voice PCM exceeds the 10 minute limit')
  return stdout
}

async function ffmpegFile(args: string[]): Promise<void> {
  await execFileAsync('ffmpeg', ['-nostdin', '-y', '-v', 'error', ...args], {
    maxBuffer: 64 * 1024, timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL',
  })
}
