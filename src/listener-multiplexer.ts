import type { KernelModule, KernelMsgService } from './kernel-types.js'
import { log } from './log.js'

export const MULTIPLEXED_MSG_SERVICE = Symbol('qqnt-bridge.multiplexed-msg-service')

type Listener = Record<PropertyKey, unknown>
type MultiplexedMsgService = KernelMsgService & { [MULTIPLEXED_MSG_SERVICE]: true }

const services = new WeakMap<object, MultiplexedMsgService>()

/**
 * QQNT currently keeps only one native message listener. Install one stable
 * native dispatcher and expose independent synthetic registrations to QQ and
 * the bridge so neither registration replaces the other.
 */
export function multiplexMsgService(kernel: KernelModule, nativeService: KernelMsgService): MultiplexedMsgService {
  const cached = services.get(nativeService as object)
  if (cached) return cached

  const listeners = new Map<string, Listener>()
  let sequence = 0
  let nativeListenerId: string | undefined
  const callbacks = new Proxy({} as Listener, {
    get(_target, event) {
      if (event === 'then') return undefined
      return (...args: unknown[]) => {
        for (const [id, listener] of [...listeners]) {
          try {
            const handler = listener[event]
            if (typeof handler === 'function') Reflect.apply(handler, listener, args)
          } catch (error) {
            log('error', `multiplexed native callback failed listener=${id} event=${String(event)}`, error)
          }
        }
      }
    },
  })
  const NativeListener = kernel.NodeIKernelMsgListener
  const dispatcher = NativeListener
    ? new NativeListener(callbacks as Record<string, (...args: never[]) => unknown>)
    : callbacks

  const facade = new Proxy(nativeService as KernelMsgService & object, {
    get(target, property) {
      if (property === MULTIPLEXED_MSG_SERVICE) return true
      if (property === 'addKernelMsgListener') {
        return (listener: Listener) => {
          const id = `qqnt-bridge-mux-${++sequence}`
          listeners.set(id, listener)
          if (!nativeListenerId) {
            nativeListenerId = Reflect.apply(target.addKernelMsgListener, target, [dispatcher])
            log('info', `native message listener dispatcher registered id=${nativeListenerId || '<empty>'}`)
          }
          log('info', `message listener attached to dispatcher id=${id} listeners=${listeners.size}`)
          return id
        }
      }
      if (property === 'removeKernelMsgListener') {
        return (id: string) => {
          if (!listeners.delete(id)) {
            // Preserve compatibility for a native listener ID created before
            // the session facade was installed.
            return Reflect.apply(target.removeKernelMsgListener, target, [id])
          }
          log('info', `message listener detached from dispatcher id=${id} listeners=${listeners.size}`)
          if (!listeners.size && nativeListenerId) {
            Reflect.apply(target.removeKernelMsgListener, target, [nativeListenerId])
            nativeListenerId = undefined
          }
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as MultiplexedMsgService
  services.set(nativeService as object, facade)
  return facade
}
