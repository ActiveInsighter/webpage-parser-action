import { createMarkdownContent } from 'defuddle/full'
import { LIMITS } from '@/core/limits'

export function toMarkdown(html: string, url: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const codes = new Map<string, string>()
  let prefix = 'AW_CAPTURE_CODE_'
  while (html.includes(prefix)) prefix += '_'

  for (const pre of doc.querySelectorAll('pre')) {
    // The converter intentionally renders code in table cells inline to keep table rows valid.
    if (pre.closest('table')) continue
    let code = pre.querySelector('code')
    if (!code) {
      code = doc.createElement('code')
      code.textContent = pre.textContent
      pre.replaceChildren(code)
    }
    const source = (code.textContent ?? '').replace(/\n$/u, '')
    const backticks = (source.match(/`+/gu) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0)
    // Keep a backtick run in the marker so the converter chooses a fence longer than the code.
    const marker = `${prefix}${codes.size}END${'`'.repeat(backticks)}`
    codes.set(marker, source)
    code.textContent = marker
  }

  let markdown = createMarkdownContent(doc.body.innerHTML, url).replace(/\n{3,}/gu, '\n\n').trim()
  for (const [marker, source] of codes) {
    markdown = markdown.replace(marker, (_match, offset: number) => {
      const linePrefix = markdown.slice(markdown.lastIndexOf('\n', offset) + 1, offset)
      const continuation = /^[ \t>]*$/u.test(linePrefix) ? linePrefix : ''
      return source.replace(/\n/gu, `\n${continuation}`)
    })
  }
  return markdown
}

/** The active fenced block, including quote/list indentation needed by its closing fence. */
function closingFence(markdown: string): string {
  let active: { fence: string; prefix: string } | null = null
  for (const match of markdown.matchAll(/^([ \t>]*)(`{3,}|~{3,})([^\n]*)$/gmu)) {
    const [, prefix = '', fence = '', tail = ''] = match
    if (active) {
      if (fence[0] === active.fence[0] && fence.length >= active.fence.length && !tail.trim()) active = null
    } else if (fence[0] !== '`' || !tail.includes('`')) {
      active = { fence, prefix }
    }
  }
  return active ? `\n${active.prefix}${active.fence}` : ''
}

/** Prefer a nearby paragraph boundary and close any fenced code cut off by the size limit. */
export function fitMarkdown(markdown: string): { markdown: string; truncated: boolean } {
  if (markdown.length <= LIMITS.markdownChars) return { markdown, truncated: false }
  const paragraph = markdown.lastIndexOf('\n\n', LIMITS.markdownChars)
  const cut = paragraph >= LIMITS.markdownChars / 2 ? paragraph : LIMITS.markdownChars
  let fitted = markdown.slice(0, cut).trimEnd()
  let closing = closingFence(fitted)
  while (fitted.length + closing.length > LIMITS.markdownChars) {
    fitted = fitted.slice(0, Math.max(0, LIMITS.markdownChars - closing.length)).trimEnd()
    closing = closingFence(fitted)
  }
  // Do not leave half of a UTF-16 surrogate pair if a paragraph itself exceeds the limit.
  if (/[\uD800-\uDBFF]$/u.test(fitted)) fitted = fitted.slice(0, -1)
  return { markdown: fitted + closing, truncated: true }
}
