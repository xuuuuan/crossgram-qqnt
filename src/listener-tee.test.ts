import { describe, expect, it, vi } from 'vitest'
import type { KernelBuddyService, KernelMsgService } from './kernel-types.js'
import { markBridgeListener, markBridgeMessageListener, teeBuddyService, teeMsgService } from './listener-tee.js'

describe('message listener tee', () => {
  it('keeps the QQ listener as the only native registration and fans out stable callbacks', () => {
    let nativeListener: Record<string, (...args: unknown[]) => unknown> | undefined
    const native = {
      addKernelMsgListener: vi.fn((listener) => {
        nativeListener = listener
        return 'native-qq-listener'
      }),
      removeKernelMsgListener: vi.fn(),
    } as unknown as KernelMsgService
    const service = teeMsgService(native)
    const bridge = markBridgeMessageListener({ onRecvMsg: vi.fn() })
    const qqCallback = vi.fn()
    const qq = { onRecvMsg: qqCallback, label: 'qq-listener' }

    const bridgeId = service.addKernelMsgListener(bridge)
    const qqId = service.addKernelMsgListener(qq)

    expect(bridgeId).toBe('qqnt-bridge-message-tee-1')
    expect(qqId).toBe('native-qq-listener')
    expect(native.addKernelMsgListener).toHaveBeenCalledOnce()
    expect(native.addKernelMsgListener).toHaveBeenCalledWith(qq)
    expect(nativeListener?.label).toBe('qq-listener')
    expect(nativeListener?.onRecvMsg).toBe(nativeListener?.onRecvMsg)

    nativeListener?.onRecvMsg([{ msgId: '1' }])
    expect(qqCallback).toHaveBeenCalledWith([{ msgId: '1' }])
    expect(bridge.onRecvMsg).toHaveBeenCalledWith([{ msgId: '1' }])

    service.removeKernelMsgListener(bridgeId)
    nativeListener?.onRecvMsg([{ msgId: '2' }])
    expect(qqCallback).toHaveBeenCalledTimes(2)
    expect(bridge.onRecvMsg).toHaveBeenCalledOnce()
    expect(native.removeKernelMsgListener).not.toHaveBeenCalled()

    service.removeKernelMsgListener(qqId)
    expect(native.removeKernelMsgListener).toHaveBeenCalledWith('native-qq-listener')
  })

  it('applies the same single-native-listener rule to other kernel services', () => {
    let nativeListener: Record<string, (...args: unknown[]) => unknown> | undefined
    const native = {
      addKernelBuddyListener: vi.fn((listener) => {
        nativeListener = listener
        return 'native-qq-buddy-listener'
      }),
      removeKernelBuddyListener: vi.fn(),
    } as unknown as KernelBuddyService
    const service = teeBuddyService(native)
    const qqCallback = vi.fn()
    const bridgeCallback = vi.fn()

    const bridgeId = service.addKernelBuddyListener(markBridgeListener({ onBuddyListChange: bridgeCallback }))
    const qq = { onBuddyListChange: qqCallback }
    const qqId = service.addKernelBuddyListener(qq)

    expect(bridgeId).toBe('qqnt-bridge-buddy-tee-1')
    expect(qqId).toBe('native-qq-buddy-listener')
    expect(native.addKernelBuddyListener).toHaveBeenCalledOnce()
    expect(native.addKernelBuddyListener).toHaveBeenCalledWith(qq)

    nativeListener?.onBuddyListChange([{ buddyList: [] }])
    expect(qqCallback).toHaveBeenCalledOnce()
    expect(bridgeCallback).toHaveBeenCalledOnce()
  })
})
