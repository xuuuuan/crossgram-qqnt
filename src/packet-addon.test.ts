import { describe, expect, it } from 'vitest'
import { loadPacketAddon } from './packet-addon.js'

describe('native packet addon', () => {
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

  it('reports a useful error outside a QQ process instead of reading arbitrary memory', () => {
    expect(() => loadPacketAddon().locateSendBinding()).toThrow(
      /wrapper\.node is not loaded in this process/,
    )
  })
})
