import type {
  KernelBuddyService, KernelGroupService, KernelMsgService, KernelProfileService, KernelRecentService,
} from './kernel-types.js'
import { log } from './log.js'

type Listener = Record<PropertyKey, unknown>
type ListenerService = Record<PropertyKey, unknown>

const services = new WeakMap<object, object>()
const bridgeListeners = new WeakSet<object>()

export function markBridgeListener<T>(listener: T): T {
  if (listener && (typeof listener === 'object' || typeof listener === 'function')) {
    bridgeListeners.add(listener as object)
  }
  return listener
}

export const markBridgeMessageListener = markBridgeListener

/**
 * QQNT 6.9.98 does not reliably broadcast callbacks to multiple native
 * listeners. Keep QQ's listener as the sole native registration for every
 * service and fan the same callback out to bridge taps in JavaScript.
 */
export function teeMsgService(nativeService: KernelMsgService): KernelMsgService {
  return teeListenerService(nativeService, 'message', 'addKernelMsgListener', 'removeKernelMsgListener')
}

export function teeBuddyService(nativeService: KernelBuddyService): KernelBuddyService {
  return teeListenerService(nativeService, 'buddy', 'addKernelBuddyListener', 'removeKernelBuddyListener')
}

export function teeProfileService(nativeService: KernelProfileService): KernelProfileService {
  return teeListenerService(nativeService, 'profile', 'addKernelProfileListener', 'removeKernelProfileListener')
}

export function teeGroupService(nativeService: KernelGroupService): KernelGroupService {
  return teeListenerService(nativeService, 'group', 'addKernelGroupListener', 'removeKernelGroupListener')
}

export function teeRecentService(nativeService: KernelRecentService): KernelRecentService {
  return teeListenerService(nativeService, 'recent', 'addKernelRecentContactListener', 'removeKernelRecentContactListener')
}

function teeListenerService<T extends object>(
  nativeService: T,
  serviceName: string,
  addMethod: PropertyKey,
  removeMethod: PropertyKey,
): T {
  const cached = services.get(nativeService as object)
  if (cached) return cached as T

  const taps = new Map<string, Listener>()
  const wrappedPrimaries = new WeakSet<object>()
  let sequence = 0
  let primaryId: string | undefined

  const targetService = nativeService as ListenerService
  const facade = new Proxy(nativeService, {
    get(target, property) {
      if (property === addMethod) {
        return (listener: Listener) => {
          if (!primaryId && !bridgeListeners.has(listener as object)) {
            const wrapped = wrappedPrimaries.has(listener as object)
              ? 0
              : teeListenerInPlace(listener, taps, serviceName)
            wrappedPrimaries.add(listener as object)
            const add = targetService[addMethod]
            if (typeof add !== 'function') throw new TypeError(`${String(addMethod)} is unavailable`)
            primaryId = Reflect.apply(add, target, [listener]) as string
            log('info', `native ${serviceName} listener primary registered id=${primaryId || '<empty>'} callbacks=${listenerCallbackCount(listener)} wrapped=${wrapped}`)
            return primaryId
          }

          const id = `qqnt-bridge-${serviceName}-tee-${++sequence}`
          taps.set(id, listener)
          log('info', `${serviceName} listener attached as JavaScript tap id=${id} taps=${taps.size} primary=${primaryId ?? '<pending>'}`)
          return id
        }
      }
      if (property === removeMethod) {
        return (id: string) => {
          if (taps.delete(id)) {
            log('info', `${serviceName} listener tap removed id=${id} taps=${taps.size}`)
            return
          }
          const remove = targetService[removeMethod]
          if (typeof remove === 'function') Reflect.apply(remove, target, [id])
          if (id === primaryId) primaryId = undefined
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  services.set(nativeService as object, facade)
  return facade as T
}

function teeListenerInPlace(primary: Listener, taps: Map<string, Listener>, serviceName: string): number {
  let wrapped = 0
  for (const event of Reflect.ownKeys(primary)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(primary, event)
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') continue
    const original = descriptor.value as (...args: unknown[]) => unknown
    const callback = function (this: unknown, ...args: unknown[]) {
      let result: unknown
      let primaryError: unknown
      try {
        result = Reflect.apply(original, this, args)
      } catch (error) {
        primaryError = error
        log('error', `primary ${serviceName} callback failed event=${String(event)}`, error)
      }
      for (const [id, listener] of [...taps]) {
        try {
          const handler = listener[event]
          if (typeof handler === 'function') Reflect.apply(handler, listener, args)
        } catch (error) {
          log('error', `${serviceName} listener tap failed id=${id} event=${String(event)}`, error)
        }
      }
      if (primaryError) throw primaryError
      return result
    }
    try {
      if (Reflect.defineProperty(primary, event, { ...descriptor, value: callback })) wrapped++
      else log('error', `${serviceName} listener callback could not be wrapped event=${String(event)}`)
    } catch (error) {
      log('error', `${serviceName} listener callback could not be wrapped event=${String(event)}`, error)
    }
  }
  return wrapped
}

function listenerCallbackCount(listener: Listener): number {
  return Reflect.ownKeys(listener).filter((key) => typeof listener[key] === 'function').length
}
