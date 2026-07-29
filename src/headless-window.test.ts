import { describe, expect, it, vi } from 'vitest'
import { closeLargestVisibleWindow, type ClosableWindow } from './headless-window.js'

function window(width: number, height: number, visible = true, destroyed = false): ClosableWindow {
  return {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    getBounds: () => ({ width, height }),
    close: vi.fn(),
  }
}

describe('headless main-window cleanup', () => {
  it('closes only the largest visible, live QQ window', () => {
    const hidden = window(2_000, 2_000, false)
    const popup = window(400, 300)
    const main = window(1_200, 800)
    const destroyed = window(3_000, 3_000, true, true)
    expect(closeLargestVisibleWindow([hidden, popup, main, destroyed])).toBe(main)
    expect(main.close).toHaveBeenCalledOnce()
    expect(popup.close).not.toHaveBeenCalled()
    expect(hidden.close).not.toHaveBeenCalled()
  })

  it('leaves hidden background windows running', () => {
    const hidden = window(1_200, 800, false)
    expect(closeLargestVisibleWindow([hidden])).toBeUndefined()
    expect(hidden.close).not.toHaveBeenCalled()
  })
})
