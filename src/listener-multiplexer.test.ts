import { describe, expect, it, vi } from 'vitest'
import type { KernelModule, KernelMsgService } from './kernel-types.js'
import { MULTIPLEXED_MSG_SERVICE, multiplexMsgService } from './listener-multiplexer.js'

describe('message listener multiplexer', () => {
  it('keeps one native registration and fans callbacks out to every listener', () => {
    let nativeListener: Record<string, (...args: unknown[]) => unknown> | undefined
    const native = {
      addKernelMsgListener: vi.fn((listener) => {
        nativeListener = listener
        return 'native-listener'
      }),
      removeKernelMsgListener: vi.fn(),
      getMsgs: vi.fn(),
    } as unknown as KernelMsgService
    const service = multiplexMsgService({
      NodeIQQNTWrapperSession: class {},
    } as unknown as KernelModule, native)
    const bridge = { onRecvMsg: vi.fn() }
    const qq = { onRecvMsg: vi.fn(), onMsgInfoListUpdate: vi.fn() }

    const bridgeId = service.addKernelMsgListener(bridge)
    const qqId = service.addKernelMsgListener(qq)
    nativeListener?.onRecvMsg([{ msgId: '1' }])
    nativeListener?.onMsgInfoListUpdate([{ msgId: '2' }])

    expect(service[MULTIPLEXED_MSG_SERVICE]).toBe(true)
    expect(native.addKernelMsgListener).toHaveBeenCalledOnce()
    expect(bridge.onRecvMsg).toHaveBeenCalledWith([{ msgId: '1' }])
    expect(qq.onRecvMsg).toHaveBeenCalledWith([{ msgId: '1' }])
    expect(qq.onMsgInfoListUpdate).toHaveBeenCalledWith([{ msgId: '2' }])

    service.removeKernelMsgListener(bridgeId)
    expect(native.removeKernelMsgListener).not.toHaveBeenCalled()
    service.removeKernelMsgListener(qqId)
    expect(native.removeKernelMsgListener).toHaveBeenCalledWith('native-listener')
  })

  it('supports listener wrapper constructors and keeps native receivers intact', () => {
    let handlers: Record<string, (...args: unknown[]) => unknown> | undefined
    class Listener {
      constructor(readonly callbacks: Record<string, (...args: unknown[]) => unknown>) {}
    }
    const native = {
      addKernelMsgListener: vi.fn((listener: Listener) => {
        handlers = listener.callbacks
        return 'native-listener'
      }),
      removeKernelMsgListener: vi.fn(),
      getMsgs: vi.fn(function (this: unknown) {
        expect(this).toBe(native)
        return Promise.resolve({ result: 0, errMsg: '', msgList: [] })
      }),
    } as unknown as KernelMsgService
    const service = multiplexMsgService({
      NodeIQQNTWrapperSession: class {},
      NodeIKernelMsgListener: Listener,
    } as unknown as KernelModule, native)
    const callback = vi.fn()

    service.addKernelMsgListener({ onRecvMsg: callback })
    handlers?.onRecvMsg([])
    void service.getMsgs({ chatType: 1, peerUid: 'u', guildId: '' }, '0', 1, true)

    expect(callback).toHaveBeenCalledOnce()
  })
})
