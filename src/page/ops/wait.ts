import { queryFirst, visibleText } from './dom'
import { budget } from './time'

/**
 * Waits use timers and MutationObserver only. A capture may run in a tab Chrome considers hidden,
 * where requestAnimationFrame never fires and rendering-driven callbacks are not dependable.
 */
export function waitForSelector(selector: string, timeoutMs: number): Promise<Element | null> {
  const present = queryFirst(selector)
  if (present) return Promise.resolve(present)
  return new Promise((resolve) => {
    const finish = (element: Element | null) => {
      clearTimeout(timer)
      clearInterval(poll)
      observer.disconnect()
      resolve(element)
    }
    const check = () => {
      const element = queryFirst(selector)
      if (element) finish(element)
    }
    const observer = new MutationObserver(check)
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
    // Observers are batched behind the event loop on busy pages; the poll bounds that delay.
    const poll = setInterval(check, 500)
    const timer = setTimeout(() => finish(null), timeoutMs)
  })
}

export interface QuietOptions {
  quietMs?: number
  timeoutMs?: number
  /** Silence alone proves nothing while an app waits on its API: also require this much text. */
  minChars?: number
}

/**
 * Resolves after `quietMs` without a DOM change, once the page holds `minChars` of text; or at
 * `timeoutMs` on pages that never stop changing (clocks, carousels) or stay short. Returns
 * whether the page really settled.
 */
export function waitForQuiet({ quietMs = 600, timeoutMs = 5_000, minChars = 0 }: QuietOptions = {}): Promise<boolean> {
  const hasContent = () => visibleText(document).length >= minChars
  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout>
    const finish = (quiet: boolean) => {
      clearTimeout(quietTimer)
      clearTimeout(limit)
      observer.disconnect()
      resolve(quiet)
    }
    const arm = () => {
      clearTimeout(quietTimer)
      quietTimer = setTimeout(() => {
        if (hasContent()) finish(true)
        else arm()
      }, quietMs)
    }
    const observer = new MutationObserver(arm)
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
    const limit = setTimeout(() => finish(false), timeoutMs)
    arm()
  })
}

export function waitWithin(deadline: number, selector: string, timeoutMs: number): Promise<Element | null> {
  return waitForSelector(selector, budget(deadline, timeoutMs))
}
