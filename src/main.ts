import Module from 'node:module'
import type {
  InitSessionConfig, KernelBuddyService, KernelGroupService, KernelModule, KernelMsgService,
  KernelProfileService, KernelRecentService, KernelSession,
} from './kernel-types.js'
import { teeBuddyService, teeGroupService, teeMsgService, teeProfileService, teeRecentService } from './listener-tee.js'
import { log, logPath } from './log.js'
import { QQLoginController, wrapLoginServiceConstructor } from './login-controller.js'
import { createPacketBindingProber, createPacketHookInstaller, type PacketBindingProbe } from './packet-addon.js'
import { QQKernelBridge } from './qq-kernel.js'
import { QQBridgeServer } from './server.js'

declare const __QQNT_BRIDGE_BUILD_MODE__: string | undefined

const processType = (process as NodeJS.Process & { type?: string }).type
const bootstrapKey = Symbol.for('qqnt-bridge.bootstrap')
const bootstrapState = globalThis as typeof globalThis & { [bootstrapKey]?: boolean }

// NODE_OPTIONS is inherited by Electron child processes. Only initialize in
// Electron's browser (main) process; plain Node remains useful for diagnostics.
if ((processType === undefined || processType === 'browser') && !bootstrapState[bootstrapKey]) {
  bootstrapState[bootstrapKey] = true
  const bridge = new QQKernelBridge()
  const login = new QQLoginController({
    autoRequestQRCode: process.env.QQNT_BRIDGE_MANAGE_LOGIN !== '0',
    enableAutoLogin: process.env.QQNT_BRIDGE_AUTO_LOGIN !== '0',
  })
  const server = new QQBridgeServer(bridge, {
    host: process.env.QQNT_BRIDGE_HOST ?? '127.0.0.1',
    port: Number(process.env.QQNT_BRIDGE_PORT ?? 18767),
    webSocketHost: process.env.QQNT_BRIDGE_WS_HOST,
    webSocketPort: process.env.QQNT_BRIDGE_WS_PORT === undefined
      ? undefined
      : Number(process.env.QQNT_BRIDGE_WS_PORT),
    token: process.env.QQNT_BRIDGE_TOKEN,
    login,
  })

  installKernelRequireHook(bridge, login)
  void startServer(server)
  const buildMode = typeof __QQNT_BRIDGE_BUILD_MODE__ === 'string' ? __QQNT_BRIDGE_BUILD_MODE__ : 'development'
  log('info', `injected mode=${buildMode} processType=${processType ?? 'node'} pid=${process.pid}; log file: ${logPath}`)
}

async function startServer(server: QQBridgeServer): Promise<void> {
  while (true) {
    try {
      await server.start()
      return
    } catch (error) {
      log('error', 'server start failed; retrying in one second', error)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
}

/**
 * Native QQNT classes expose read-only prototypes, so assigning
 * NodeIQQNTWrapperSession.prototype.init is not possible. Intercept CommonJS
 * module loading instead and return a copy of the native export object whose
 * session constructor is a construct proxy. The proxy wraps each new session
 * instance and observes init() without mutating the native object.
 */
function installKernelRequireHook(bridge: QQKernelBridge, login: QQLoginController): void {
  type Loader = (request: string, parent: NodeModule | null, isMain: boolean) => unknown
  const moduleWithLoad = Module as unknown as { _load: Loader }
  const originalLoad = moduleWithLoad._load
  const wrappedModules = new WeakMap<object, KernelModule>()
  const originalDlopen = process.dlopen
  const probePacketBinding = createPacketBindingProber()
  const installPacketHook = createPacketHookInstaller()

  moduleWithLoad._load = function qqntBridgeLoad(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain)
    if (!isKernelModule(loaded)) return loaded
    const cached = wrappedModules.get(loaded)
    if (cached) return cached
    const wrapped = wrapKernelModule(loaded, bridge, login)
    wrappedModules.set(loaded, wrapped)
    log('info', `wrapped QQNT kernel module requested as ${request}`)
    return wrapped
  }

  // QQ's webpack node-loader invokes process.dlopen(module, path) directly,
  // bypassing Module._load. Wrap module.exports immediately after the native
  // addon populates it.
  process.dlopen = function qqntBridgeDlopen(module, filename, flags) {
    const result = originalDlopen.apply(this, arguments as unknown as Parameters<typeof originalDlopen>)
    const nativeModule = module as { exports: unknown }
    if (isKernelModule(nativeModule.exports)) {
      probeLinuxPacketBinding()
      const raw = nativeModule.exports
      let wrapped = wrappedModules.get(raw)
      if (!wrapped) {
        wrapped = wrapKernelModule(raw, bridge, login)
        wrappedModules.set(raw, wrapped)
      }
      nativeModule.exports = wrapped
      log('info', `wrapped QQNT kernel through process.dlopen: ${filename}`)
    }
    return result
  }

  function probeLinuxPacketBinding(): void {
    if (process.platform !== 'linux') return
    try {
      const probe = probePacketBinding()
      if (!probe) return
      logLinuxPacketProbe(probe)
      installLinuxPacketHook()
    } catch (error) {
      log('warn', 'QQNT Linux packet binding probe unavailable', error)
    }
  }

  function installLinuxPacketHook(): void {
    try {
      const location = installPacketHook()
      if (!location) return
      log('info', `QQNT Linux packet hook installed module=${location.moduleBase} profile=${location.profile} converterRva=0x${location.converterRva.toString(16)} resolverRva=0x${location.responseRva.toString(16)}`)
    } catch (error) {
      log('error', 'QQNT Linux packet hook install failed; packet media URLs will be unavailable', error)
    }
  }
}

function logLinuxPacketProbe(probe: PacketBindingProbe): void {
  log('info', `QQNT Linux packet profile verified profile=${probe.profile} buildIdPrefix=${probe.buildId.slice(0, 16)} sha256Prefix=${probe.sha256.slice(0, 16)} nameSlotRva=${probe.nameSlotRva} bindingNameRva=${probe.bindingNameRva} napiCallbackSlotRva=${probe.napiCallbackSlotRva} napiCallbackRva=${probe.napiCallbackRva} responseActionSlotRva=${probe.responseActionSlotRva} responseActionRva=${probe.responseActionRva} converterRva=${probe.converterRva} resolveActionRva=${probe.resolveActionRva}`)
}

function isKernelModule(value: unknown): value is KernelModule & object {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false
  const candidate = value as Partial<KernelModule>
  return typeof candidate.NodeIQQNTWrapperSession === 'function'
}

function wrapKernelModule(kernel: KernelModule, bridge: QQKernelBridge, login: QQLoginController): KernelModule {
  login.attachKernel(kernel)
  const NativeSession = kernel.NodeIQQNTWrapperSession as unknown as new (...args: unknown[]) => KernelSession
  const wrappedSessions = new WeakMap<object, KernelSession>()
  const wrapOnce = (session: KernelSession): KernelSession => {
    const object = session as object
    const cached = wrappedSessions.get(object)
    if (cached) return cached
    const wrapped = wrapSession(kernel, session, bridge, login)
    wrappedSessions.set(object, wrapped)
    return wrapped
  }
  function SessionFacade(this: unknown, ...args: unknown[]) {
    log('info', 'NodeIQQNTWrapperSession constructed')
    return wrapOnce(Reflect.construct(NativeSession, args, NativeSession))
  }
  SessionFacade.prototype = NativeSession.prototype
  for (const [property, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(NativeSession))) {
    if (property === 'prototype' || property === 'name' || property === 'length') continue
    const value = descriptor.value
    if ((property === 'getNTWrapperSession' || property === 'create') && typeof value === 'function') {
      Object.defineProperty(SessionFacade, property, {
        ...descriptor,
        value: (...args: unknown[]) => {
          log('info', `NodeIQQNTWrapperSession.${property} invoked`)
          const session = Reflect.apply(value, NativeSession, args) as KernelSession
          return session ? wrapOnce(session) : session
        },
      })
    } else {
      Object.defineProperty(SessionFacade, property, descriptor)
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(kernel)
  descriptors.NodeIQQNTWrapperSession = {
    ...descriptors.NodeIQQNTWrapperSession,
    value: SessionFacade,
  }
  if (kernel.NodeIKernelLoginService && descriptors.NodeIKernelLoginService) {
    descriptors.NodeIKernelLoginService = {
      ...descriptors.NodeIKernelLoginService,
      value: wrapLoginServiceConstructor(kernel.NodeIKernelLoginService, login, kernel),
    }
  }
  return Object.defineProperties({}, descriptors) as KernelModule
}

function wrapSession(
  kernel: KernelModule,
  nativeSession: KernelSession,
  bridge: QQKernelBridge,
  login: QQLoginController,
): KernelSession {
  let attached = false
  let msgServiceFacade: KernelMsgService | undefined
  let buddyServiceFacade: KernelBuddyService | undefined
  let profileServiceFacade: KernelProfileService | undefined
  let groupServiceFacade: KernelGroupService | undefined
  let recentServiceFacade: KernelRecentService | undefined
  let facade: KernelSession
  facade = new Proxy(nativeSession, {
    get(target, property) {
      const value = Reflect.get(target as object, property, target)
      if (property === 'init' && typeof value === 'function') {
        return (config: InitSessionConfig, ...args: unknown[]) => {
          log('info', `QQNT session init invoked for ${config.selfUin}`)
          const result = Reflect.apply(value, target, [config, ...args])
          login.attachSession(facade)
          if (!attached) {
            attached = true
            try {
              bridge.attach(kernel, facade, config)
              log('info', `attached QQ account ${config.selfUin}`)
            } catch (error) {
              attached = false
              log('error', 'failed to attach QQNT session', error)
            }
          }
          return result
        }
      }
      if (property === 'getMsgService' && typeof value === 'function') {
        return () => {
          if (msgServiceFacade) return msgServiceFacade
          const nativeService = Reflect.apply(value, target, []) as KernelMsgService | undefined
          if (!nativeService) return nativeService
          return msgServiceFacade = teeMsgService(nativeService)
        }
      }
      if (property === 'getBuddyService' && typeof value === 'function') {
        return () => {
          if (buddyServiceFacade) return buddyServiceFacade
          const nativeService = Reflect.apply(value, target, []) as KernelBuddyService | undefined
          if (!nativeService) return nativeService
          return buddyServiceFacade = teeBuddyService(nativeService)
        }
      }
      if (property === 'getProfileService' && typeof value === 'function') {
        return () => {
          if (profileServiceFacade) return profileServiceFacade
          const nativeService = Reflect.apply(value, target, []) as KernelProfileService | undefined
          if (!nativeService) return nativeService
          return profileServiceFacade = teeProfileService(nativeService)
        }
      }
      if (property === 'getGroupService' && typeof value === 'function') {
        return () => {
          if (groupServiceFacade) return groupServiceFacade
          const nativeService = Reflect.apply(value, target, []) as KernelGroupService | undefined
          if (!nativeService) return nativeService
          return groupServiceFacade = teeGroupService(nativeService)
        }
      }
      if (property === 'getRecentContactService' && typeof value === 'function') {
        return () => {
          if (recentServiceFacade) return recentServiceFacade
          const nativeService = Reflect.apply(value, target, []) as KernelRecentService | undefined
          if (!nativeService) return nativeService
          return recentServiceFacade = teeRecentService(nativeService)
        }
      }
      // Native methods reject a JS Proxy as their receiver. Always bind them
      // back to the real native instance.
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return facade
}
