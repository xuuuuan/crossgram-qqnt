import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPacketBindingProber, linuxPacketMode, loadPacketAddon, type PacketBindingProbe } from './packet-addon.js'

describe('native packet addon', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('crosses the N-API boundary to invoke a packet sender', async () => {
    const addon = loadPacketAddon()
    const calls: Array<[string, Buffer]> = []
    const response = await addon.sendPacket((command, payload) => {
      calls.push([command, payload])
      return Promise.resolve({ rspbuffer: Buffer.from('response') })
    }, 'Test.Command', Buffer.from('request')) as { rspbuffer: Buffer }

    expect(calls).toEqual([['Test.Command', Buffer.from('request')]])
    expect(response.rspbuffer).toEqual(Buffer.from('response'))
  })

  it('encodes FetchRkey and refreshes an existing QQ image URL', () => {
    const addon = loadPacketAddon()
    const request = addon.encodeFetchRkeyRequest()
    expect(request.command).toBe('OidbSvcTrpcTcp.0x9067_202')
    expect(request.payload.toString('hex')).toBe(
      '08e7a00210ca01221c0a130a05080110ca011206a80602b006011a02080222050a030a14026001',
    )
    expect(addon.refreshImageUrl(
      'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc&rkey=expired&spec=0',
      '&rkey=fresh',
    )).toBe('https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc&spec=0&rkey=fresh')
  })

  it.runIf(process.platform === 'linux')('parses Linux packet mode fail closed', () => {
    vi.stubEnv('QQNT_BRIDGE_LINUX_PACKET_MODE', undefined)
    expect(linuxPacketMode()).toBe('disabled')
    vi.stubEnv('QQNT_BRIDGE_LINUX_PACKET_MODE', 'probe')
    expect(linuxPacketMode()).toBe('probe')
    vi.stubEnv('QQNT_BRIDGE_LINUX_PACKET_MODE', 'hook')
    expect(linuxPacketMode()).toBe('hook')
    vi.stubEnv('QQNT_BRIDGE_LINUX_PACKET_MODE', 'unexpected')
    expect(linuxPacketMode).toThrow('invalid QQNT_BRIDGE_LINUX_PACKET_MODE: unexpected')
  })

  it('prevents synchronous recursive probes and restores the prober state', () => {
    const result: PacketBindingProbe = {
      moduleBase: '0x1', modulePath: '/qqnt/wrapper.node', profile: 'linux-xref-v1',
      buildId: 'build-id', sha256: 'sha256', nameSlotRva: '0x1', bindingNameRva: '0x2',
      bindingName: 'sendSsoCmdReqByContend', napiCallbackSlotRva: '0x3', napiCallbackRva: '0x4',
      napiCallbackFingerprint: 'fingerprint', responseActionSlotRva: '0x5', responseActionRva: '0x6',
      responseActionFingerprint: 'fingerprint', converterRva: '0x7', converterFingerprint: 'fingerprint',
      resolveActionRva: '0x8', resolveActionFingerprint: 'fingerprint',
    }
    let prober!: () => PacketBindingProbe | undefined
    const probePacketBinding = vi.fn(() => {
      expect(prober()).toBeUndefined()
      return result
    })
    const loadAddon = vi.fn(() => ({ probePacketBinding }))
    prober = createPacketBindingProber(loadAddon)

    expect(prober()).toBe(result)
    expect(loadAddon).toHaveBeenCalledOnce()
    expect(probePacketBinding).toHaveBeenCalledOnce()

    expect(prober()).toBe(result)
    expect(loadAddon).toHaveBeenCalledTimes(2)
    expect(probePacketBinding).toHaveBeenCalledTimes(2)
  })

  it('reports platform-appropriate errors outside a QQ process', () => {
    const addon = loadPacketAddon()
    if (process.platform === 'win32') {
      expect(() => addon.locateSendBinding()).toThrow(
        /wrapper\.node is not loaded in this process/,
      )
      return
    }

    if (process.platform === 'linux') {
      expect(() => addon.probePacketBinding()).toThrow(/wrapper\.node is not loaded in this process/)
    } else {
      expect(() => addon.probePacketBinding()).toThrow(/only supported on Linux/)
    }
    expect(() => addon.locateSendBinding()).toThrow(/only supported on Windows/)
    expect(() => addon.installSendHook()).toThrow(/only supported on Windows/)
  })
})
