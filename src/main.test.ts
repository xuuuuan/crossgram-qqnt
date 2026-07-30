import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { KernelAVSDKService, KernelModule, KernelSession } from './kernel-types.js'
import { markBridgeListener } from './listener-tee.js'
import { QQKernelBridge } from './qq-kernel.js'

let wrapSession: typeof import('./main.js').wrapSession

beforeAll(async () => {
  const processWithType = process as NodeJS.Process & { type?: string }
  const processType = processWithType.type
  processWithType.type = 'renderer'
  try {
    ({ wrapSession } = await import('./main.js'))
  } finally {
    processWithType.type = processType
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('wrapSession AVSDK listener facade', () => {
  it('intercepts addKernelAVSDKListener, keeps the bridge tap pending, and fans out from the sole native primary', () => {
    let nativeListener: Record<string, (...args: unknown[]) => unknown> | undefined
    const native = {
      addKernelAVSDKListener: vi.fn((listener) => {
        nativeListener = listener as Record<string, (...args: unknown[]) => unknown>
        return 'native-avsdk-listener'
      }),
      removeKernelAVSDKListener: vi.fn(),
    } as unknown as KernelAVSDKService
    const nativeSession = {
      getAVSDKService: vi.fn(() => native),
    } as unknown as KernelSession
    const kernel = {
      NodeIQQNTWrapperSession: { prototype: { init() {} } },
    } as unknown as KernelModule
    const session = wrapSession(kernel, nativeSession, {} as QQKernelBridge)
    const service = session.getAVSDKService!()
    const bridgeCallback = vi.fn()
    const primaryCallback = vi.fn()

    const tapId = service.addKernelAVSDKListener(markBridgeListener({ onFutureCallState: bridgeCallback }))
    const primaryId = service.addKernelAVSDKListener({ onFutureCallState: primaryCallback })

    expect(session.getAVSDKService!()).toBe(service)
    expect(tapId).toBe('qqnt-bridge-avsdk-tee-1')
    expect(primaryId).toBe('native-avsdk-listener')
    expect(native.addKernelAVSDKListener).toHaveBeenCalledOnce()
    expect(nativeListener).toBeDefined()

    nativeListener!.onFutureCallState({ state: 'ringing' })
    expect(primaryCallback).toHaveBeenCalledWith({ state: 'ringing' })
    expect(bridgeCallback).toHaveBeenCalledWith({ state: 'ringing' })

    service.removeKernelAVSDKListener(tapId)
    nativeListener!.onFutureCallState({ state: 'connected' })
    expect(primaryCallback).toHaveBeenCalledTimes(2)
    expect(bridgeCallback).toHaveBeenCalledOnce()
    expect(native.removeKernelAVSDKListener).not.toHaveBeenCalled()

    service.removeKernelAVSDKListener(primaryId)
    expect(native.removeKernelAVSDKListener).toHaveBeenCalledWith('native-avsdk-listener')
  })

  it('observes setActionFromAVSDK only after preserving its native call', async () => {
    vi.stubEnv('QQNT_BRIDGE_AVSDK_TAP', '1')
    vi.stubEnv('QQNT_BRIDGE_AVSDK_RAW', '1')
    const result = { result: 0 }
    let observed = false
    const setActionFromAVSDK = vi.fn(function (this: unknown, action: number, bytes: Uint8Array) {
      expect(observed).toBe(false)
      return result
    })
    const native = {
      addKernelAVSDKListener: vi.fn(),
      removeKernelAVSDKListener: vi.fn(),
      setActionFromAVSDK,
    } as KernelAVSDKService
    const nativeSession = {
      getAVSDKService: vi.fn(() => native),
    } as unknown as KernelSession
    const kernel = {
      NodeIQQNTWrapperSession: { prototype: { init() {} } },
    } as unknown as KernelModule
    const bridge = new QQKernelBridge()
    const originalObserve = bridge.observeAVSDKAction.bind(bridge)
    const observe = vi.spyOn(bridge, 'observeAVSDKAction').mockImplementation((action, bytes) => {
      observed = true
      originalObserve(action, bytes)
    })
    const subscription = bridge.subscribe()
    const event = subscription[Symbol.asyncIterator]().next()
    const action = 3
    const bytes = Buffer.from([1, 2, 3])
    const extra = { opaque: true }
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    const service = wrapSession(kernel, nativeSession, bridge).getAVSDKService!()
    const intercepted = service as unknown as { setActionFromAVSDK(...args: unknown[]): unknown }
    expect(intercepted.setActionFromAVSDK(action, bytes, extra)).toBe(result)
    expect(setActionFromAVSDK).toHaveBeenCalledOnce()
    expect(setActionFromAVSDK).toHaveBeenCalledWith(action, bytes, extra)
    expect(setActionFromAVSDK.mock.contexts[0]).toBe(native)
    expect(observe).toHaveBeenCalledWith(action, bytes)
    expect(consoleLog.mock.calls.map(([message]) => String(message)).join('\n')).toContain(
      'avsdk-call receipt source=action-intercept callback=setActionFromAVSDK',
    )
    await expect(event).resolves.toMatchObject({
      value: {
        type: 'native-avsdk', version: 1, callback: 'setActionFromAVSDK',
        args: [action, { type: 'binary', base64: 'AQID', length: 3 }],
      },
    })
    bridge.unsubscribe(subscription)
  })

  it('preserves setActionFromAVSDK when observation throws', () => {
    const result = { result: 0 }
    const setActionFromAVSDK = vi.fn(function (this: unknown, action: number, bytes: Uint8Array) {
      return result
    })
    const native = {
      addKernelAVSDKListener: vi.fn(),
      removeKernelAVSDKListener: vi.fn(),
      setActionFromAVSDK,
    } as KernelAVSDKService
    const nativeSession = {
      getAVSDKService: vi.fn(() => native),
    } as unknown as KernelSession
    const kernel = {
      NodeIQQNTWrapperSession: { prototype: { init() {} } },
    } as unknown as KernelModule
    const bridge = {
      observeAVSDKAction: vi.fn(() => { throw new Error('observer failed') }),
    } as unknown as QQKernelBridge
    const action = 4
    const bytes = Buffer.from([4, 5, 6])

    const service = wrapSession(kernel, nativeSession, bridge).getAVSDKService!()
    expect(service.setActionFromAVSDK(action, bytes)).toBe(result)
    expect(bridge.observeAVSDKAction).toHaveBeenCalledWith(action, bytes)
    expect(setActionFromAVSDK).toHaveBeenCalledOnce()
    expect(setActionFromAVSDK).toHaveBeenCalledWith(action, bytes)
    expect(setActionFromAVSDK.mock.contexts[0]).toBe(native)
  })

  it('preserves a native setActionFromAVSDK exception without observation', async () => {
    vi.stubEnv('QQNT_BRIDGE_AVSDK_TAP', '1')
    vi.stubEnv('QQNT_BRIDGE_AVSDK_RAW', '1')
    const sentinel = new Error('native failed')
    const setActionFromAVSDK = vi.fn(function (this: unknown, action: number, bytes: Uint8Array) {
      throw sentinel
    })
    const native = {
      addKernelAVSDKListener: vi.fn(),
      removeKernelAVSDKListener: vi.fn(),
      setActionFromAVSDK,
    } as KernelAVSDKService
    const nativeSession = {
      getAVSDKService: vi.fn(() => native),
    } as unknown as KernelSession
    const kernel = {
      NodeIQQNTWrapperSession: { prototype: { init() {} } },
    } as unknown as KernelModule
    const bridge = new QQKernelBridge()
    const observe = vi.spyOn(bridge, 'observeAVSDKAction')
    const subscription = bridge.subscribe()
    const action = 5
    const bytes = Buffer.from([7, 8, 9])
    const service = wrapSession(kernel, nativeSession, bridge).getAVSDKService!()

    expect(() => service.setActionFromAVSDK(action, bytes)).toThrow(sentinel)
    expect(setActionFromAVSDK).toHaveBeenCalledOnce()
    expect(setActionFromAVSDK).toHaveBeenCalledWith(action, bytes)
    expect(setActionFromAVSDK.mock.contexts[0]).toBe(native)
    expect(observe).not.toHaveBeenCalled()
    bridge.unsubscribe(subscription)
  })
})
