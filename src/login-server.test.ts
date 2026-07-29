import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KernelLoginListener, KernelLoginService, KernelModule } from './kernel-types.js'
import { QQLoginController } from './login-controller.js'
import { QQKernelBridge } from './qq-kernel.js'
import { QQBridgeServer } from './server.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('login HTTP API', () => {
  let server: QQBridgeServer | undefined
  afterEach(async () => { await server?.stop() })

  it('serves protected login state and QR data before the message kernel is ready', async () => {
    let listener: KernelLoginListener | undefined
    const service: KernelLoginService = {
      addKernelLoginListener: (value) => { listener = value },
      getQRCodePicture: vi.fn(() => true),
      startPolling: vi.fn(() => true),
      abortPolling: vi.fn(() => true),
    }
    const login = new QQLoginController({ autoRequestQRCode: false })
    login.attachService(service, {
      NodeIQQNTWrapperSession: { prototype: { init() {} } },
    } as KernelModule)
    listener!.onQRCodeGetPicture?.({
      pngBase64QrcodeData: PNG.toString('base64'), qrcodeUrl: 'https://x.test/ticket',
      expireTime: 120, pollTimeInterval: 2,
    })

    server = new QQBridgeServer(new QQKernelBridge(), { port: 0, token: 'secret', login })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}`
    expect((await fetch(`${base}/v1/login/status`)).status).toBe(401)

    const headers = { Authorization: 'Bearer secret' }
    const status = await fetch(`${base}/v1/login/status`, { headers })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ phase: 'waiting-for-scan', qrAvailable: true })

    const image = await fetch(`${base}/v1/login/qrcode.png`, { headers })
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG)
    expect(await (await fetch(`${base}/v1/login/qrcode/url`, { headers })).text()).toBe('https://x.test/ticket\n')

    const refresh = await fetch(`${base}/v1/login/qrcode/refresh`, { method: 'POST', headers })
    expect(refresh.status).toBe(202)
    expect(service.abortPolling).toHaveBeenCalledOnce()
    expect(service.getQRCodePicture).toHaveBeenCalledOnce()
  })
})
