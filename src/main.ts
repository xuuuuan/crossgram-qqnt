import { createRequire } from 'node:module'
import type { InitSessionConfig, KernelModule, KernelSession } from './kernel-types.js'
import { QQKernelBridge } from './qq-kernel.js'
import { QQBridgeServer } from './server.js'

const kernelPath = process.env.QQNT_KERNEL_PATH
  ?? '/Applications/QQ.app/Contents/Resources/app/wrapper.node'
const require = createRequire(import.meta.url)
const bridge = new QQKernelBridge()
const server = new QQBridgeServer(bridge, {
  host: process.env.QQNT_BRIDGE_HOST ?? '127.0.0.1',
  port: Number(process.env.QQNT_BRIDGE_PORT ?? 18767),
  token: process.env.QQNT_BRIDGE_TOKEN,
})

try {
  const kernel = require(kernelPath) as KernelModule
  hookSession(kernel)
  void server.start().catch((error) => console.error('[qqnt-bridge] server failed', error))
} catch (error) {
  console.error('[qqnt-bridge] failed to load QQNT kernel', error)
}

function hookSession(kernel: KernelModule): void {
  const prototype = kernel.NodeIQQNTWrapperSession.prototype
  const original = prototype.init
  if ((original as unknown as { __mtprotoBridgeHooked?: boolean }).__mtprotoBridgeHooked) return
  function patched(this: KernelSession, config: InitSessionConfig, ...args: unknown[]) {
    const result = original.call(this as never, config, ...args)
    // init() creates the per-account services synchronously. Registering after
    // the original call avoids touching half-initialized native service objects.
    try {
      bridge.attach(kernel, this, config)
      console.log(`[qqnt-bridge] attached QQ account ${config.selfUin}`)
    } catch (error) {
      console.error('[qqnt-bridge] failed to attach QQNT session', error)
    }
    return result
  }
  ;(patched as unknown as { __mtprotoBridgeHooked: boolean }).__mtprotoBridgeHooked = true
  prototype.init = patched as typeof prototype.init
}
