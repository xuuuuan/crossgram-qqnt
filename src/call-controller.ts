import { log } from './log.js'
import type { QQCallController, QQCallOperation } from './qq-kernel.js'

interface ElectronCallWebContents {
  id: number
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  getType?: () => string
  isDestroyed?: () => boolean
}

export interface ElectronCallControllerHost {
  webContents: {
    getAllWebContents(): ElectronCallWebContents[]
  }
}

interface CallControlResult {
  handled: boolean
  route?: string
}

/**
 * Invoke QQ's own mounted call component handlers. These names and selectors
 * come from QQ 3.2.31-51102's compiled renderer source:
 *
 * - PickupBtn.onPickupClick / AVCallStatus.onAcceptClick
 * - HangupBtn.onHangupClick / AVCallStatus.onHangupClick
 *
 * QQ remains responsible for constructing QRTC commands, room IDs, sequence
 * numbers, reject reasons, and every native state transition.
 */
export class ElectronCallController implements QQCallController {
  private readonly attempts: number
  private readonly retryDelayMs: number

  constructor(
    private readonly electron: ElectronCallControllerHost,
    options: { attempts?: number, retryDelayMs?: number } = {},
  ) {
    this.attempts = options.attempts ?? 20
    this.retryDelayMs = options.retryDelayMs ?? 100
  }

  async control(operation: QQCallOperation): Promise<void> {
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const contents = this.electron.webContents.getAllWebContents()
        .filter((item) => !item.isDestroyed?.())
        .sort((left, right) => right.id - left.id)
      for (const item of contents) {
        let result: unknown
        try {
          result = await item.executeJavaScript(callControlScript(operation), true)
        } catch {
          continue
        }
        if (!isHandled(result)) continue
        log('info', `QQ renderer call control operation=${operation} contents=${item.id} type=${item.getType?.() ?? 'unknown'} route=${result.route ?? 'unknown'}`)
        return
      }
      if (attempt < this.attempts) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs))
      }
    }
    throw new Error('QQ call controls are not mounted')
  }
}

function isHandled(value: unknown): value is CallControlResult & { handled: true } {
  return Boolean(value && typeof value === 'object'
    && (value as { handled?: unknown }).handled === true)
}

export function callControlScript(operation: QQCallOperation): string {
  const names = operation === 'accept'
    ? ['onPickupClick', 'onAcceptClick', 'pickupInAudio', 'pickupFromAio']
    : ['onHangupClick', 'rejectFromAio']
  const selector = operation === 'accept' ? '.pickup-icon' : '.hangup-icon'
  return `(() => {
    const visible = (element) => {
      if (!(element instanceof Element) || !element.getClientRects().length) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
    };
    const icon = [...document.querySelectorAll(${JSON.stringify(selector)})].find(visible);
    if (icon) {
      const target = icon.closest('button,[role="button"],.q-button,.btn-wrapper') || icon;
      if (typeof target.click === 'function') {
        target.click();
        return { handled: true, route: 'component-click:${selector}' };
      }
    }
    const methodNames = ${JSON.stringify(names)};
    const seen = new Set();
    for (const element of document.querySelectorAll('*')) {
      if (!visible(element)) continue;
      let component = element.__vueParentComponent;
      while (component && !seen.has(component)) {
        seen.add(component);
        const sources = [component.proxy, component.exposed, component.setupState, component.ctx];
        for (const name of methodNames) {
          for (const source of sources) {
            let method;
            try { method = source && source[name]; } catch { continue; }
            if (typeof method !== 'function') continue;
            Reflect.apply(method, source, []);
            return { handled: true, route: 'vue-handler:' + name };
          }
        }
        component = component.parent;
      }
    }
    return { handled: false };
  })()`
}
