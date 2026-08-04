import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isSilk } from 'silk-wasm'
import { describe, expect, it } from 'vitest'
import { encodePtt, transcodePttFallbackTo } from './silk-audio.js'

const execFileAsync = promisify(execFile)

describe('recorded PTT conversion', () => {
  it('encodes a tiny generated WAV as QQ Silk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-silk-test-'))
    const wav = join(directory, 'voice.wav')
    const silk = join(directory, 'voice.silk')
    try {
      await execFileAsync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.04', wav])
      expect(await encodePtt(wav, silk)).toBeGreaterThan(0)
      expect(isSilk(await readFile(silk))).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('transcodes a bounded fallback source to validated OGG', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-fallback-test-'))
    const wav = join(directory, 'voice.wav')
    const ogg = join(directory, 'voice.ogg')
    try {
      await execFileAsync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.04', wav])
      await transcodePttFallbackTo(wav, ogg)
      expect((await readFile(ogg)).subarray(0, 4).toString()).toBe('OggS')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects inputs over the voice size limit before encoding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-silk-limit-'))
    const input = join(directory, 'oversized.ogg')
    try {
      await writeFile(input, Buffer.alloc(0))
      await truncate(input, 32 * 1024 * 1024 + 1)
      await expect(encodePtt(input, join(directory, 'voice.silk'))).rejects.toThrow('32 MiB')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
