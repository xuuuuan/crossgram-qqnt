import { describe, expect, it, vi } from 'vitest'
import { callControlScript, ElectronCallController } from './call-controller.js'

describe('ElectronCallController', () => {
  it('uses QQ source-backed pickup and hangup handlers', () => {
    const accept = callControlScript('accept')
    const hangup = callControlScript('hangup')

    expect(accept).toContain('.pickup-icon')
    expect(accept).toContain('onPickupClick')
    expect(accept).toContain('onAcceptClick')
    expect(accept).toContain('pickupFromAio')
    expect(hangup).toContain('.hangup-icon')
    expect(hangup).toContain('onHangupClick')
    expect(hangup).toContain('rejectFromAio')
  })

  it('searches live renderer contents newest first and stops after a real handler', async () => {
    const stale = {
      id: 2,
      executeJavaScript: vi.fn().mockResolvedValue({ handled: false }),
    }
    const active = {
      id: 7,
      getType: () => 'window',
      executeJavaScript: vi.fn().mockResolvedValue({
        handled: true, route: 'vue-handler:onPickupClick',
      }),
    }
    const older = {
      id: 1,
      executeJavaScript: vi.fn().mockResolvedValue({ handled: true }),
    }
    const controller = new ElectronCallController({
      webContents: { getAllWebContents: () => [older, stale, active] },
    })

    await expect(controller.control('accept')).resolves.toBeUndefined()
    expect(active.executeJavaScript).toHaveBeenCalledOnce()
    expect(stale.executeJavaScript).not.toHaveBeenCalled()
    expect(older.executeJavaScript).not.toHaveBeenCalled()
    expect(active.executeJavaScript.mock.calls[0]?.[0]).toContain('onPickupClick')
    expect(active.executeJavaScript.mock.calls[0]?.[1]).toBe(true)
  })

  it('fails closed when QQ has no mounted call component', async () => {
    const controller = new ElectronCallController({
      webContents: { getAllWebContents: () => [{
        id: 1,
        executeJavaScript: vi.fn().mockResolvedValue({ handled: false }),
      }] },
    }, { attempts: 1 })

    await expect(controller.control('reject')).rejects.toThrow('not mounted')
  })
})
