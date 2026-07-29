import { describe, expect, it, vi } from 'vitest'
import type { KernelLoginListener, KernelLoginService, KernelModule, KernelSession } from './kernel-types.js'
import { QQLoginController, wrapLoginServiceConstructor } from './login-controller.js'

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fixture'),
])

function loginFixture(options: ConstructorParameters<typeof QQLoginController>[0] = {}) {
  let listener: KernelLoginListener | undefined
  const service: KernelLoginService = {
    addKernelLoginListener: vi.fn((value) => { listener = value }),
    getQRCodePicture: vi.fn(() => true),
    startPolling: vi.fn(() => true),
    abortPolling: vi.fn(() => true),
  }
  const controller = new QQLoginController({ autoRequestQRCode: false, retryDelaysMs: [0], ...options })
  const kernel = {
    NodeIQQNTWrapperSession: { prototype: { init() {} } },
  } as KernelModule
  controller.attachService(service, kernel)
  return { controller, service, get listener() { return listener! } }
}

describe('QQLoginController', () => {
  it('captures the native PNG, scan progress, account, and expiration metadata', () => {
    const fixture = loginFixture()
    fixture.listener.onLoginConnected?.()
    fixture.listener.onQRCodeGetPicture?.({
      pngBase64QrcodeData: PNG.toString('base64'),
      qrcodeUrl: 'https://x.test/qr-ticket',
      expireTime: 120,
      pollTimeInterval: 2,
    })
    expect(fixture.controller.qrCodePng).toEqual(PNG)
    expect(fixture.controller.status).toMatchObject({
      phase: 'waiting-for-scan',
      connected: true,
      qrAvailable: true,
      qrcodeUrl: 'https://x.test/qr-ticket',
      pollIntervalMs: 2_000,
    })

    fixture.listener.onQRCodeSessionUserScaned?.(0, 'https://x.test/avatar.png')
    expect(fixture.controller.status).toMatchObject({ phase: 'scanned', scannedAvatarUrl: 'https://x.test/avatar.png' })
    fixture.listener.onQRCodeLoginSucceed?.({
      account: '10001', mainAccount: '10001', uin: '10001', uid: 'u_test', nickName: 'Test',
      gender: 0, age: 0, faceUrl: '',
    })
    expect(fixture.controller.status).toMatchObject({ phase: 'authenticated', uin: '10001', nickName: 'Test' })
    expect(fixture.controller.qrCodePng).toBeUndefined()
  })

  it('refreshes through the native service and begins polling after the callback', async () => {
    const fixture = loginFixture()
    await fixture.controller.requestQRCode(true)
    expect(fixture.service.abortPolling).toHaveBeenCalledOnce()
    expect(fixture.service.getQRCodePicture).toHaveBeenCalledOnce()
    expect(fixture.service.startPolling).not.toHaveBeenCalled()

    fixture.listener.onQRCodeGetPicture?.({
      pngBase64QrcodeData: `data:image/png;base64,${PNG.toString('base64')}`,
      qrcodeUrl: 'ticket', expireTime: 60, pollTimeInterval: 1,
    })
    expect(fixture.service.startPolling).toHaveBeenCalledOnce()
  })

  it('rejects invalid QR image bytes and reports the native failure', () => {
    const fixture = loginFixture()
    fixture.listener.onQRCodeGetPicture?.({
      pngBase64QrcodeData: Buffer.from('not png').toString('base64'),
      qrcodeUrl: 'bad', expireTime: 1, pollTimeInterval: 1,
    })
    expect(fixture.controller.status).toMatchObject({
      phase: 'failed', qrAvailable: false, error: 'QQNT returned an invalid QR code image',
    })
  })

  it('enables QQNT automatic login after a session attaches', async () => {
    const setAutoLoginSwitch = vi.fn(async () => ({ result: 0, errMsg: '' }))
    const controller = new QQLoginController({ autoRequestQRCode: false, retryDelaysMs: [0] })
    controller.attachSession({
      getSettingService: () => ({
        getAutoLoginSwitch: async () => ({ result: 0, errMsg: '', state: false }),
        setAutoLoginSwitch,
      }),
    } as KernelSession)
    await vi.waitFor(() => expect(setAutoLoginSwitch).toHaveBeenCalledWith(true))
    expect(controller.status.autoLogin).toBe('enabled')
  })

  it('announces a ready session even when automatic login management is disabled', () => {
    const onSessionReady = vi.fn()
    const controller = new QQLoginController({
      autoRequestQRCode: false, enableAutoLogin: false, onSessionReady,
    })
    controller.attachSession({} as KernelSession)
    expect(onSessionReady).toHaveBeenCalledOnce()
    expect(controller.status.autoLogin).toBe('disabled')
  })

  it('attaches when QQ constructs or retrieves the native login singleton', () => {
    let registered = 0
    class NativeService {
      static singleton = new NativeService()
      static get() { return this.singleton }
      addKernelLoginListener() { registered++ }
      getQRCodePicture() { return true }
      startPolling() { return true }
    }
    const kernel = {
      NodeIQQNTWrapperSession: { prototype: { init() {} } },
      NodeIKernelLoginService: NativeService,
    } as unknown as KernelModule
    const controller = new QQLoginController({ autoRequestQRCode: false })
    const Facade = wrapLoginServiceConstructor(kernel.NodeIKernelLoginService!, controller, kernel)
    expect(Facade.get?.()).toBeTruthy()
    expect(new Facade()).toBeTruthy()
    expect(registered).toBeGreaterThan(0)
  })

  it('removes the old listener when QQ replaces its login service', () => {
    const controller = new QQLoginController({ autoRequestQRCode: false })
    const kernel = { NodeIQQNTWrapperSession: { prototype: { init() {} } } } as KernelModule
    const remove = vi.fn()
    const first = {
      addKernelLoginListener: vi.fn(), removeKernelLoginListener: remove,
      getQRCodePicture: () => true, startPolling: () => true,
    }
    const second = {
      addKernelLoginListener: vi.fn(), getQRCodePicture: () => true, startPolling: () => true,
    }
    controller.attachService(first, kernel)
    controller.attachService(second, kernel)
    expect(remove).toHaveBeenCalledOnce()
  })
})
