import { budget, sleep } from './time'

export interface ScrollOptions {
  maxRounds?: number
  pauseMs?: number
  deadline: number
}

function scroller(): Element {
  return document.scrollingElement ?? document.documentElement
}

/**
 * Walks the page one viewport at a time so lazy content loads, stopping once the height holds
 * through two pauses at the bottom. Ends back at the top, where some sites unmount far content.
 */
export async function autoScroll({ maxRounds = 30, pauseMs = 350, deadline }: ScrollOptions): Promise<number> {
  const page = scroller()
  const step = Math.max(window.innerHeight * 0.9, 400)
  let rounds = 0
  let stableAtBottom = 0
  let height = page.scrollHeight

  while (rounds < maxRounds && stableAtBottom < 2) {
    budget(deadline)
    window.scrollBy(0, step)
    // Scroll events ride on rendering frames, which an unrendered window never produces.
    window.dispatchEvent(new Event('scroll'))
    rounds += 1
    await sleep(pauseMs)
    const atBottom = page.scrollTop + window.innerHeight >= page.scrollHeight - 4
    stableAtBottom = atBottom && page.scrollHeight === height ? stableAtBottom + 1 : 0
    height = page.scrollHeight
  }
  window.scrollTo(0, 0)
  return rounds
}
