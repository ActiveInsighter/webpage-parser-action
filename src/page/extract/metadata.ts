import { LIMITS } from '@/core/limits'
import { cleanText } from '../ops/dom'
import { normalizeDate } from './text'

export interface PageMetadata {
  title: string
  byline: string
  siteName: string
  language: string
  description: string
  publishedAt: string
  leadImage: string
  canonicalUrl: string
  structuredData: Record<string, unknown>[]
}

const ARTICLE_TYPES = /^(Article|NewsArticle|BlogPosting|TechArticle|ScholarlyArticle|Report|QAPage|DiscussionForumPosting)$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flatten(value: unknown, into: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, into)
  } else if (isRecord(value)) {
    if (Array.isArray(value['@graph'])) {
      // A graph container can itself be a typed article. Keep its fields without duplicating
      // the complete graph in structuredData, then visit the graph's individual nodes.
      const { '@graph': graph, ...node } = value
      if (Object.keys(node).some((key) => key !== '@context' && key !== '@id')) into.push(node)
      flatten(graph, into)
    } else into.push(value)
  }
}

/** Every JSON-LD node on the page. Broken blocks are common and simply skipped. */
export function readJsonLd(doc: Document): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = []
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      flatten(JSON.parse(script.textContent ?? ''), nodes)
    } catch {
      // Not valid JSON: nothing to keep from this block.
    }
  }
  return nodes
}

function typesOf(node: Record<string, unknown>): string[] {
  const type = node['@type']
  return (Array.isArray(type) ? type : [type]).filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.replace(/^https?:\/\/schema\.org\//u, ''))
}

export function findJsonLd(nodes: readonly Record<string, unknown>[], type: string | RegExp): Record<string, unknown> | null {
  const test = (name: string) => {
    if (typeof type === 'string') return name === type
    type.lastIndex = 0
    return type.test(name)
  }
  return nodes.find((node) => typesOf(node).some(test)) ?? null
}

/** References inside JSON-LD graphs commonly hold authors, publishers and images. */
function referenced(value: Record<string, unknown>, nodes: readonly Record<string, unknown>[]): Record<string, unknown> | undefined {
  const id = value['@id']
  return typeof id === 'string' ? nodes.find((node) => node !== value && node['@id'] === id) : undefined
}

function nameOf(value: unknown, nodes: readonly Record<string, unknown>[], seen = new Set<unknown>()): string {
  if (typeof value === 'string') return cleanText(value)
  if (!value || seen.has(value) || seen.size >= 32) return ''
  const next = new Set(seen).add(value)
  if (Array.isArray(value)) return value.map((entry) => nameOf(entry, nodes, next)).filter(Boolean).join(', ')
  return isRecord(value) ? nameOf(value.name, nodes, next) || nameOf(referenced(value, nodes), nodes, next) : ''
}

function imageOf(value: unknown, nodes: readonly Record<string, unknown>[], seen = new Set<unknown>()): string {
  if (typeof value === 'string') return value
  if (!value || seen.has(value) || seen.size >= 32) return ''
  const next = new Set(seen).add(value)
  if (Array.isArray(value)) return first(...value.map((entry) => imageOf(entry, nodes, next)))
  return isRecord(value) ? imageOf(value.contentUrl, nodes, next) || imageOf(value.url, nodes, next)
    || imageOf(referenced(value, nodes), nodes, next) : ''
}

export function readMeta(doc: Document, name: string): string {
  const quoted = name.replace(/["\\]/gu, '\\$&')
  const tags = doc.querySelectorAll(`meta[property="${quoted}"], meta[name="${quoted}"], meta[itemprop="${quoted}"]`)
  return first(...[...tags].map((tag) => cleanText(tag.getAttribute('content'))))
}

function first(...values: string[]): string {
  return values.find(Boolean) ?? ''
}

function limit(value: string, chars: number = LIMITS.fieldChars): string {
  return value.length > chars ? value.slice(0, chars) : value
}

function capStructuredData(nodes: Record<string, unknown>[]): Record<string, unknown>[] {
  const kept: Record<string, unknown>[] = []
  let size = 0
  for (const node of nodes) {
    size += JSON.stringify(node).length
    if (size > LIMITS.structuredDataChars) break
    kept.push(node)
  }
  return kept
}

export function readMetadata(doc: Document, pageUrl: string): PageMetadata {
  const meta = (name: string) => readMeta(doc, name)
  const nodes = readJsonLd(doc)
  const article = findJsonLd(nodes, ARTICLE_TYPES) ?? findJsonLd(nodes, 'WebPage')
  const language = first(cleanText(doc.documentElement.getAttribute('lang')), meta('og:locale').replace('_', '-'), meta('language'))
  const published = [
    meta('article:published_time'),
    typeof article?.datePublished === 'string' ? article.datePublished : '',
    meta('datePublished'),
    meta('pubdate'),
    meta('publishdate'),
    doc.querySelector('article time[datetime], time[datetime]')?.getAttribute('datetime') ?? '',
  ].map((value) => normalizeDate(value, language)).find(Boolean) ?? ''
  const base = resolve(doc.querySelector('base[href]')?.getAttribute('href') ?? '', pageUrl) || pageUrl
  const canonical = first(...[
    doc.querySelector('link[rel~="canonical" i]')?.getAttribute('href') ?? '', meta('og:url'),
  ].map((value) => resolve(value, base)))

  return {
    title: limit(first(meta('og:title'), meta('twitter:title'), typeof article?.headline === 'string' ? cleanText(article.headline) : '', cleanText(doc.title), cleanText(doc.querySelector('h1')?.textContent)), LIMITS.titleChars),
    byline: limit(first(nameOf(article?.author, nodes), meta('author'), meta('article:author'), meta('byl'))),
    siteName: limit(first(meta('og:site_name'), nameOf(article?.publisher, nodes), meta('application-name'))),
    language: limit(language, 32),
    description: limit(first(meta('description'), meta('og:description'), meta('twitter:description'), typeof article?.description === 'string' ? cleanText(article.description) : '')),
    publishedAt: published,
    leadImage: limit(first(...[meta('og:image'), meta('twitter:image'), imageOf(article?.image, nodes)].map((value) => resolve(value, base)))),
    canonicalUrl: canonical,
    structuredData: capStructuredData(nodes),
  }
}

function resolve(value: string, base: string): string {
  if (!value) return ''
  try {
    const url = new URL(value.trim(), base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}
