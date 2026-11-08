import { Readability } from '@mozilla/readability'
import Defuddle from 'defuddle/full'
import type { CrawlPlan } from '@/core/contract'
import type { FieldRule, SiteContext, SiteFields, SiteProfile } from '@/sites/types'
import { cleanText, queryAll, queryFirst } from '../ops/dom'
import { findJsonLd, readJsonLd, readMeta } from './metadata'
import { countWords } from './text'

/** One strategy's reading of the page: content HTML plus whatever fields it could fill. */
export interface Candidate extends SiteFields {
  strategy: string
  html: string
}

/** Defuddle may trim a chosen container; losing more than this falls back to its raw HTML. */
const MAX_TRIMMED_SHARE = 0.5
const MIN_CONTAINER_WORDS = 10

/** Context-sensitive table elements need their parents to survive HTML fragment parsing. */
function containerMarkup(element: Element): string {
  const html = element.outerHTML
  switch (element.tagName.toLowerCase()) {
    case 'td':
    case 'th': return `<table><tbody><tr>${html}</tr></tbody></table>`
    case 'tr':
    case 'thead':
    case 'tbody':
    case 'tfoot':
    case 'caption':
    case 'colgroup': return `<table>${html}</table>`
    case 'col': return `<table><colgroup>${html}</colgroup></table>`
    default: return html
  }
}

function runDefuddle(doc: Document, url: string, contentSelector?: string) {
  // useAsync stays off: async extractors would send the page URL to third-party services.
  // A site rule already identifies the article. Pattern-based tail pruning can mistake a
  // short final section with standalone images/pre blocks for a CTA and discard real content.
  // Keep selector-based advertising removal, scoring and standardization for these containers.
  return new Defuddle(doc, { url, useAsync: false, contentSelector, removeContentPatterns: !contentSelector }).parse()
}

/** Standardization otherwise trims indentation and compresses blank lines before Markdown runs. */
function protectCodeWhitespace(root: Element): Map<string, string> {
  const replacements = new Map<string, string>()
  let prefix = 'AWCaptureCode'
  while (root.outerHTML.includes(prefix)) prefix += 'X'
  const blocks = root.matches('pre') ? [root, ...root.querySelectorAll('pre')] : [...root.querySelectorAll('pre')]
  for (const pre of blocks) {
    let code = pre.querySelector('code')
    if (!code) {
      // Preserve plain preformatted blocks; complex code widgets still use their own cleanup.
      if (pre.children.length) continue
      code = root.ownerDocument.createElement('code')
      code.textContent = pre.textContent
      pre.replaceChildren(code)
    }
    const source = code.cloneNode(true) as Element
    for (const control of source.querySelectorAll('script, style, button')) control.remove()
    const escaped = root.ownerDocument.createElement('code')
    escaped.textContent = source.textContent
    const marker = `${prefix}${replacements.size}END`
    replacements.set(marker, escaped.innerHTML)
    code.textContent = marker
  }
  return replacements
}

/** Generic reading of the whole page. Defuddle carries its own per-site extractors too. */
export function defuddleCandidate(doc: Document, url: string): Candidate | null {
  const parsed = runDefuddle(doc, url)
  if (!parsed.content?.trim()) return null
  return {
    // extractorType is a class name, which minification reduces to a letter; only its presence means anything.
    strategy: parsed.extractorType ? 'defuddle:site' : 'defuddle',
    html: parsed.content,
    title: parsed.title,
    byline: parsed.author,
    publishedAt: parsed.published,
    siteName: parsed.site,
    description: parsed.description,
    leadImage: parsed.image,
  }
}

export function readabilityCandidate(doc: Document): Candidate | null {
  const parsed = new Readability(doc.cloneNode(true) as Document, { charThreshold: 200 }).parse()
  if (!parsed?.content?.trim()) return null
  return {
    strategy: 'readability',
    html: parsed.content,
    title: parsed.title ?? '',
    byline: parsed.byline ?? '',
    publishedAt: parsed.publishedTime ?? '',
    siteName: parsed.siteName ?? '',
    description: parsed.excerpt ?? '',
  }
}

/**
 * Reads one container through Defuddle, so site rules share its cleanup of code blocks and
 * footnotes, and keeps the raw HTML when that cleanup removed most of what the rule selected.
 */
function containerHtml(doc: Document, url: string, selector: string, element: Element): string {
  const raw = containerMarkup(element)
  const rawWords = countWords(containerText(element))
  try {
    // The chosen selector can match hidden/empty copies before this element. Mark the exact
    // node in a clone, otherwise the parser would query the original selector and pick again.
    const copy = doc.cloneNode(true) as Document
    const selected = queryAll(selector, copy)[queryAll(selector, doc).indexOf(element)]
    if (!selected) return raw
    for (const node of copy.querySelectorAll('[data-aw-selected-content]')) node.removeAttribute('data-aw-selected-content')
    selected.setAttribute('data-aw-selected-content', '')
    const code = protectCodeWhitespace(selected)
    const parsed = runDefuddle(copy, url, '[data-aw-selected-content]')
    let html = parsed.content
    for (const [marker, source] of code) html = html.replaceAll(marker, () => source)
    const kept = countWords(new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '')
    return kept >= rawWords * (1 - MAX_TRIMMED_SHARE) ? html : raw
  } catch {
    return raw
  }
}

/** Ignore scripts and explicitly hidden copies when deciding which layout contains an article. */
function containerText(element: Element): string {
  const copy = element.cloneNode(true) as Element
  for (const node of copy.querySelectorAll('script, style, noscript, template, [hidden], [aria-hidden="true"]')) node.remove()
  for (const node of copy.querySelectorAll<HTMLElement>('[style]')) {
    if (node.style?.display === 'none') node.remove()
  }
  return cleanText(copy.textContent)
}

function hiddenContainer(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return true
    // visibility:hidden is deliberately allowed: WeChat uses it on its real article container.
    if ((current as HTMLElement).style?.display === 'none') return true
  }
  return false
}

/** The first selector whose element holds real text, which skips empty layout shells. */
function pickContainer(doc: Document, selectors: readonly string[]): { selector: string; element: Element } | null {
  for (const selector of selectors) {
    for (const element of queryAll(selector, doc)) {
      if (!hiddenContainer(element) && countWords(containerText(element)) >= MIN_CONTAINER_WORDS) return { selector, element }
    }
  }
  return null
}

/** The container named on the job. The user asked for exactly this, so it is not second-guessed. */
export function manualCandidate(doc: Document, url: string, selector: string): Candidate | null {
  const element = queryFirst(selector, doc)
  if (!element) return null
  // A manual selection is exact. Running an article detector again can silently discard tables,
  // short paragraphs or images, and innerHTML loses a selected pre/table/list's own semantics.
  return { strategy: 'manual', html: containerMarkup(element) }
}

function readRule(doc: Document, rule: FieldRule): string {
  if (typeof rule === 'string') return cleanText(queryFirst(rule, doc)?.textContent)
  const [selector, attribute] = rule
  return cleanText(queryFirst(selector, doc)?.getAttribute(attribute))
}

function readField(doc: Document, rules: readonly FieldRule[] | undefined): string {
  for (const rule of rules ?? []) {
    const value = readRule(doc, rule)
    if (value) return value
  }
  return ''
}

function createContext(doc: Document, url: string, plan: CrawlPlan): SiteContext {
  const nodes = readJsonLd(doc)
  return {
    document: doc,
    url: new URL(url),
    requestedUrl: new URL(plan.requestedUrl || url),
    scope: plan.scope,
    maxItems: plan.maxItems,
    text: (selector) => cleanText(queryFirst(selector, doc)?.textContent),
    attr: (selector, attribute) => cleanText(queryFirst(selector, doc)?.getAttribute(attribute)),
    html: (selector) => queryFirst(selector, doc)?.innerHTML ?? '',
    all: (selector) => queryAll(selector, doc),
    meta: (name) => readMeta(doc, name),
    jsonLd: (type) => (type ? findJsonLd(nodes, type) : (nodes[0] ?? null)),
  }
}

/**
 * Applies a profile. Fields are returned even when no container matched, so a stale content rule
 * still improves the generic result. `html` stays empty in that case.
 */
export function siteCandidate(doc: Document, url: string, profile: SiteProfile, plan: CrawlPlan): Candidate {
  const { fields } = profile
  const candidate: Candidate = {
    strategy: `site:${profile.id}`,
    html: '',
    title: readField(doc, fields?.title),
    byline: readField(doc, fields?.byline),
    publishedAt: readField(doc, fields?.publishedAt),
    siteName: readField(doc, fields?.siteName),
    description: readField(doc, fields?.description),
    leadImage: readField(doc, fields?.leadImage),
  }
  const container = profile.content ? pickContainer(doc, profile.content.selectors) : null
  if (container) candidate.html = containerHtml(doc, url, container.selector, container.element)

  const custom = profile.extract?.(createContext(doc, url, plan))
  if (custom) {
    const { extras, html, ...rest } = custom
    for (const [key, value] of Object.entries(rest)) {
      if (value) (candidate as unknown as Record<string, unknown>)[key] = value
    }
    if (html) candidate.html = html
    if (extras) candidate.extras = extras
  }
  return candidate
}
