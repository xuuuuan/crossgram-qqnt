export interface ClosableWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  getBounds(): { width: number, height: number }
  close(): void
}

export function closeLargestVisibleWindow(windows: ClosableWindow[]): ClosableWindow | undefined {
  const main = windows
    .filter((window) => !window.isDestroyed() && window.isVisible())
    .map((window) => ({ window, area: area(window) }))
    .sort((left, right) => right.area - left.area)[0]?.window
  main?.close()
  return main
}

function area(window: ClosableWindow): number {
  try {
    const bounds = window.getBounds()
    return Math.max(0, bounds.width) * Math.max(0, bounds.height)
  } catch {
    return 0
  }
}
