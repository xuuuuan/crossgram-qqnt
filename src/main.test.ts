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

afterEach(() => vi.unstubAllEnvs())

describe('wrapSession AVSDK listener facade', () => {
  it('keeps the bridge listener tap pending and fans out from the sole native primary', () => {
    let nativeListener: Record<string, (...args: unknown[]) => unknown> | undefined
    const native = {
      addKernelAVSDKListener: vi.fn((listener) => {
        nativeListener = listener as Record<string, (...args: unknown[]) => unknown>
        return 'native-avsdk-listener'
      }),
      removeKernelAVSDKListener: vi.fn(),
    } as unknown as KernelAVSDKService
    const nativeSession = { getAVSDKService: vi.fn(() => native) } as unknown as KernelSession
    const kernel = { NodeIQQNTWrapperSession: { prototype: { init() {} } } } as unknown as KernelModule
    const service = wrapSession(kernel, nativeSession, {} as QQKernelBridge).getAVSDKService!()
    const bridgeCallback = vi.fn()
    const primaryCallback = vi.fn()

    const tapId = service.addKernelAVSDKListener(markBridgeListener({ onFutureCallState: bridgeCallback }))
    const primaryId = service.addKernelAVSDKListener({ onFutureCallState: primaryCallback })

    expect(tapId).toBe('qqnt-bridge-avsdk-tee-1')
    expect(primaryId).toBe('native-avsdk-listener')
    expect(native.addKernelAVSDKListener).toHaveBeenCalledOnce()
    nativeListener!.onFutureCallState({ state: 'ringing' })
    expect(primaryCallback).toHaveBeenCalledOnce()
    expect(bridgeCallback).toHaveBeenCalledOnce()
    service.removeKernelAVSDKListener(tapId)
    service.removeKernelAVSDKListener(primaryId)
    expect(native.removeKernelAVSDKListener).toHaveBeenCalledWith('native-avsdk-listener')
  })

  it.each([
    'QQNT_BRIDGE_AVSDK_TAP',
    'QQNT_BRIDGE_AVSDK_RAW',
    'QQNT_BRIDGE_AVSDK_ACTION_PROBE',
  ])('does not intercept native actions when %s is set', (flag) => {
    vi.stubEnv(flag, '1')
    const result = { result: 0 }
    const setActionFromAVSDK = vi.fn(function (this: unknown) { return result })
    const native = {
      addKernelAVSDKListener: vi.fn(),
      removeKernelAVSDKListener: vi.fn(),
      setActionFromAVSDK,
    } as KernelAVSDKService
    const nativeSession = { getAVSDKService: vi.fn(() => native) } as unknown as KernelSession
    const kernel = { NodeIQQNTWrapperSession: { prototype: { init() {} } } } as unknown as KernelModule
    const bridge = new QQKernelBridge()
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    const service = wrapSession(kernel, nativeSession, bridge).getAVSDKService!()
    expect(service.setActionFromAVSDK(0, new Uint8Array())).toBe(result)
    expect(setActionFromAVSDK).toHaveBeenCalledOnce()
    expect(setActionFromAVSDK.mock.contexts[0]).toBe(native)
    expect(consoleLog.mock.calls.map(([message]) => String(message)).join('\n')).not.toContain('avsdk-action')
  })
})
