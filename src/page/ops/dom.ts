import { CrawlError } from '@/core/errors'

/** querySelectorAll that reports a malformed selector as a step failure, not a crash. */
export function queryAll(selector: string, root: ParentNode = document): Element[] {
  try {
    return [...root.querySelectorAll(selector)]
  } catch (cause) {
    throw new CrawlError('STEP_FAILED', `选择器无效：${selector}`, { cause })
  }
}

export function queryFirst(selector: string, root: ParentNode = document): Element | null {
  return queryAll(selector, root)[0] ?? null
}

export function removeAll(selector: string, root: ParentNode = document): number {
  const matches = queryAll(selector, root)
  for (const element of matches) element.remove()
  return matches.length
}

/** Whitespace-collapsed text, which is what metadata fields want. */
export function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim()
}

/**
 * What a reader would see. `textContent` also returns inline scripts, and a page's embedded JSON
 * state (or a challenge page's script) would make an empty shell look full of content.
 */
export function visibleText(doc: Document): string {
  const { body } = doc
  if (!body) return ''
  if (typeof body.innerText === 'string') return cleanText(body.innerText)
  const copy = body.cloneNode(true) as HTMLElement
  for (const element of copy.querySelectorAll('script, style, noscript, template')) element.remove()
  return cleanText(copy.textContent)
}

/** Dispatches a real click. Disabled controls are skipped rather than reported as clicked. */
export function click(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false
  if ((element as HTMLButtonElement).disabled) return false
  element.click()
  return true
}
