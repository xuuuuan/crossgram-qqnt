import { hostname } from 'node:os'
import type {
  KernelLoginListener, KernelLoginService, KernelModule, KernelSession, QRCodeInfo, QRCodeLoginResult,
} from './kernel-types.js'
import { log } from './log.js'

export type LoginPhase =
  | 'initializing'
  | 'connected'
  | 'waiting-for-scan'
  | 'scanned'
  | 'authenticated'
  | 'logged-in'
  | 'failed'

export interface QQLoginStatus {
  phase: LoginPhase
  connected: boolean
  qrAvailable: boolean
  qrcodeUrl?: string
  expiresAt?: string
  pollIntervalMs?: number
  scannedAvatarUrl?: string
  uin?: string
  nickName?: string
  error?: string
  autoLogin: 'pending' | 'enabled' | 'disabled' | 'unsupported' | 'failed'
}

export interface LoginControllerOptions {
  autoRequestQRCode?: boolean
  enableAutoLogin?: boolean
  requestDelayMs?: number
  retryDelaysMs?: number[]
  setTimeout?: typeof setTimeout
  onSessionReady?: () => void
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export class QQLoginController {
  private readonly options: Required<Omit<LoginControllerOptions, 'setTimeout' | 'onSessionReady'>>
  private readonly schedule: typeof setTimeout
  private readonly onSessionReady?: () => void
  private phase: LoginPhase = 'initializing'
  private connected = false
  private service?: KernelLoginService
  private listener?: KernelLoginListener
  private qr?: { png: Buffer, url: string, expiresAt: number, pollIntervalMs: number }
  private scannedAvatarUrl?: string
  private account?: QRCodeLoginResult
  private error?: string
  private autoLogin: QQLoginStatus['autoLogin']
  private requestTimer?: NodeJS.Timeout
  private startPollingWhenReady = false
  private settingAttempt = 0

  constructor(options: LoginControllerOptions = {}) {
    this.options = {
      autoRequestQRCode: options.autoRequestQRCode ?? true,
      enableAutoLogin: options.enableAutoLogin ?? true,
      requestDelayMs: options.requestDelayMs ?? 1_500,
      retryDelaysMs: options.retryDelaysMs ?? [0, 500, 2_000, 5_000, 10_000],
    }
    this.schedule = options.setTimeout ?? setTimeout
    this.onSessionReady = options.onSessionReady
    this.autoLogin = this.options.enableAutoLogin ? 'pending' : 'disabled'
  }

  get status(): QQLoginStatus {
    return {
      phase: this.phase,
      connected: this.connected,
      qrAvailable: Boolean(this.qr),
      qrcodeUrl: this.qr?.url,
      expiresAt: this.qr ? new Date(this.qr.expiresAt).toISOString() : undefined,
      pollIntervalMs: this.qr?.pollIntervalMs,
      scannedAvatarUrl: this.scannedAvatarUrl,
      uin: this.account?.uin,
      nickName: this.account?.nickName,
      error: this.error,
      autoLogin: this.autoLogin,
    }
  }

  get qrCodePng(): Buffer | undefined {
    return this.qr?.png
  }

  get qrcodeUrl(): string | undefined {
    return this.qr?.url
  }

  attachKernel(kernel: KernelModule): void {
    if (!kernel.NodeIKernelLoginService) return
    try {
      const NativeService = kernel.NodeIKernelLoginService
      const candidate = typeof NativeService.get === 'function'
        ? NativeService.get()
        : Reflect.construct(NativeService, [])
      const service = candidate && typeof candidate.get === 'function' ? candidate.get() : candidate
      if (service) this.attachService(service, kernel)
    } catch (error) {
      // QQ normally creates the singleton itself. The wrapped constructor will
      // call attachService when that happens, so an eager attach failure is not
      // fatal on builds that forbid direct construction.
      log('info', 'QQNT login service will be attached by the application', error)
    }
  }

  attachService(service: KernelLoginService, kernel: KernelModule): void {
    if (this.service === service && this.listener) return
    if (this.service && this.listener) {
      try {
        this.service.removeKernelLoginListener?.(this.listener)
      } catch (error) {
        log('warn', 'failed to replace the previous QQNT login listener', error)
      }
    }
    this.service = service
    const handlers: KernelLoginListener = {
      onLoginConnected: () => this.onConnected(),
      onLoginDisConnected: () => this.onDisconnected(),
      onLoginConnecting: () => this.onConnecting(),
      onQRCodeGetPicture: (info) => this.onQRCode(info),
      onQRCodeLoginPollingStarted: (expireTime, pollTimeInterval) =>
        this.onPollingStarted(expireTime, pollTimeInterval),
      onQRCodeSessionUserScaned: (_code, avatarUrl) => this.onScanned(avatarUrl),
      onLoginState: (state) => this.onLoginState(state),
      onQRCodeLoginSucceed: (result) => this.onLoginSucceeded(result),
      onQRCodeSessionFailed: (_type, _code, message) => this.onFailed(message),
      onLoginFailed: (_type, info) => this.onFailed(info.message || info.title),
      onUserLoggedIn: (uin) => this.onUserLoggedIn(uin),
      onQRCodeSessionQuickLoginFailed: (_code, message, result) => {
        if (result?.pngBase64QrcodeData) this.onQRCode(result)
        else this.onFailed(message)
      },
    }
    const Listener = kernel.NodeIKernelLoginListener
    this.listener = Listener ? Reflect.construct(Listener, [handlers]) as KernelLoginListener : handlers
    service.addKernelLoginListener(this.listener)
    log('info', 'QQNT login listener registered')
  }

  attachSession(session: KernelSession): void {
    this.onSessionReady?.()
    if (!this.options.enableAutoLogin) return
    this.settingAttempt = 0
    void this.tryEnableAutoLogin(session)
  }

  async requestQRCode(refresh = false): Promise<void> {
    const service = this.service
    if (!service) throw new Error('QQNT login service is not ready')
    if (refresh) service.abortPolling?.()
    this.cancelRequestTimer()
    this.qr = undefined
    this.scannedAvatarUrl = undefined
    this.error = undefined
    this.phase = this.connected ? 'connected' : 'initializing'
    this.startPollingWhenReady = true
    if (!service.getQRCodePicture()) {
      this.startPollingWhenReady = false
      throw new Error('QQNT rejected the QR code request')
    }
  }

  private onConnecting(): void {
    this.connected = false
    this.phase = 'initializing'
    this.error = undefined
  }

  private onConnected(): void {
    this.connected = true
    this.phase = this.qr ? 'waiting-for-scan' : 'connected'
    this.error = undefined
    if (this.options.autoRequestQRCode && !this.qr) this.scheduleQRCodeRequest(this.options.requestDelayMs)
  }

  private onDisconnected(): void {
    this.connected = false
    this.cancelRequestTimer()
    if (this.phase !== 'logged-in') this.phase = 'initializing'
  }

  private onQRCode(info: QRCodeInfo): void {
    const png = decodePng(info.pngBase64QrcodeData)
    if (!png) {
      this.onFailed('QQNT returned an invalid QR code image')
      return
    }
    const now = Date.now()
    this.qr = {
      png,
      url: info.qrcodeUrl,
      expiresAt: now + Math.max(1, info.expireTime) * 1_000,
      pollIntervalMs: Math.max(0, info.pollTimeInterval) * 1_000,
    }
    this.phase = 'waiting-for-scan'
    this.error = undefined
    this.scannedAvatarUrl = undefined
    this.cancelRequestTimer()
    if (this.startPollingWhenReady) {
      this.startPollingWhenReady = false
      this.service?.startPolling()
    }
    log('info', `QQNT login QR code available expiresIn=${info.expireTime}s`)
  }

  private onPollingStarted(expireTime: number, pollTimeInterval: number): void {
    if (!this.qr) return
    this.qr.expiresAt = Date.now() + Math.max(1, expireTime) * 1_000
    this.qr.pollIntervalMs = Math.max(0, pollTimeInterval) * 1_000
  }

  private onScanned(avatarUrl: string): void {
    this.phase = 'scanned'
    this.scannedAvatarUrl = avatarUrl || undefined
    this.error = undefined
  }

  private onLoginState(state: number): void {
    if (state === 3) this.phase = 'authenticated'
  }

  private onLoginSucceeded(result: QRCodeLoginResult): void {
    this.account = result
    this.phase = 'authenticated'
    this.qr = undefined
    this.error = undefined
    this.cancelRequestTimer()
    log('info', `QQNT QR login succeeded uin=${result.uin}`)
  }

  private onUserLoggedIn(uin: string): void {
    this.account = { ...this.account, uin } as QRCodeLoginResult
    this.phase = 'logged-in'
    this.qr = undefined
    this.error = undefined
    this.cancelRequestTimer()
  }

  private onFailed(message: string): void {
    this.phase = 'failed'
    this.qr = undefined
    this.error = message || 'QQNT login failed'
    this.startPollingWhenReady = false
    if (this.options.autoRequestQRCode && this.connected) this.scheduleQRCodeRequest(5_000)
    log('warn', `QQNT login failed: ${this.error}`)
  }

  private scheduleQRCodeRequest(delayMs: number): void {
    this.cancelRequestTimer()
    const timer = this.schedule(() => {
      this.requestTimer = undefined
      if (this.qr || this.phase === 'logged-in' || this.phase === 'authenticated') return
      void this.requestQRCode().catch((error) => {
        this.onFailed(error instanceof Error ? error.message : String(error))
      })
    }, delayMs)
    timer.unref?.()
    this.requestTimer = timer
  }

  private cancelRequestTimer(): void {
    if (this.requestTimer) clearTimeout(this.requestTimer)
    this.requestTimer = undefined
  }

  private async tryEnableAutoLogin(session: KernelSession): Promise<void> {
    const attempt = this.settingAttempt++
    const delay = this.options.retryDelaysMs[attempt]
    if (delay === undefined) {
      this.autoLogin = session.getSettingService ? 'failed' : 'unsupported'
      return
    }
    if (delay > 0) await new Promise<void>((resolve) => {
      const timer = this.schedule(resolve, delay)
      timer.unref?.()
    })
    try {
      const settings = session.getSettingService?.()
      if (!settings) throw new Error('QQNT setting service is not ready')
      const current = await settings.getAutoLoginSwitch?.()
      if (current?.result === 0 && current.state) {
        this.autoLogin = 'enabled'
        return
      }
      const result = await settings.setAutoLoginSwitch(true)
      if (result.result !== 0) throw new Error(result.errMsg || `result ${result.result}`)
      this.autoLogin = 'enabled'
      log('info', 'QQNT automatic login enabled')
    } catch (error) {
      log('warn', `failed to enable QQNT automatic login attempt=${attempt + 1}`, error)
      await this.tryEnableAutoLogin(session)
    }
  }
}

export function wrapLoginServiceConstructor(
  NativeService: NonNullable<KernelModule['NodeIKernelLoginService']>,
  controller: QQLoginController,
  kernel: KernelModule,
): NonNullable<KernelModule['NodeIKernelLoginService']> {
  const wrapped = new WeakMap<object, KernelLoginService>()
  const wrapOnce = (service: KernelLoginService): KernelLoginService => {
    if (!service || (typeof service !== 'object' && typeof service !== 'function')) return service
    const object = service as object
    const cached = wrapped.get(object)
    if (cached) return cached
    const facade = new Proxy(service, {
      get(target, property) {
        const value = Reflect.get(target as object, property, target)
        if (property === 'get' && typeof value === 'function') {
          return (...args: unknown[]) => {
            const singleton = Reflect.apply(value, target, args) as KernelLoginService
            const result = singleton ? wrapOnce(singleton) : singleton
            return result
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    wrapped.set(object, facade)
    controller.attachService(service, kernel)
    return facade
  }
  function LoginServiceFacade(this: unknown, ...args: unknown[]) {
    return wrapOnce(Reflect.construct(NativeService, args, NativeService) as KernelLoginService)
  }
  LoginServiceFacade.prototype = NativeService.prototype
  for (const [property, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(NativeService))) {
    if (property === 'prototype' || property === 'name' || property === 'length') continue
    const value = descriptor.value
    if ((property === 'get' || property === 'create') && typeof value === 'function') {
      Object.defineProperty(LoginServiceFacade, property, {
        ...descriptor,
        value: (...args: unknown[]) => {
          const service = Reflect.apply(value, NativeService, args) as KernelLoginService
          return service ? wrapOnce(service) : service
        },
      })
    } else {
      Object.defineProperty(LoginServiceFacade, property, descriptor)
    }
  }
  return LoginServiceFacade as unknown as NonNullable<KernelModule['NodeIKernelLoginService']>
}

function decodePng(value: string): Buffer | undefined {
  const encoded = value.replace(/^data:image\/png;base64,/, '')
  try {
    const png = Buffer.from(encoded, 'base64')
    return png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? png : undefined
  } catch {
    return undefined
  }
}

export function defaultLoginInitConfig(commonPath: string, clientVer: string) {
  return {
    commonPath,
    clientVer,
    machineId: '',
    platVer: process.platform,
    hostName: hostname(),
  }
}
