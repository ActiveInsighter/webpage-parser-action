import type { ImageRef, LinkRef } from '@/core/contract'
import { LIMITS } from '@/core/limits'
import { cleanLink } from '@/core/url-policy'
import { cleanText } from '../ops/dom'
import { materializeImages, parseSrcset } from '../ops/images'

export interface NormalizedContent {
  html: string
  text: string
  links: LinkRef[]
  images: ImageRef[]
  /** Text blocks long enough to read as prose, list items and code included. */
  blocks: number
  /** Share of the text that sits inside links. */
  linkDensity: number
}

const DROPPED = 'script, style, noscript, template, link, meta, iframe, object, embed, applet, base, input, select, textarea, button, canvas, dialog, svg'
const KEPT_DATA_ATTRIBUTES = new Set(['data-lang', 'data-language'])
const BLOCK_SELECTOR = 'p, li, pre, blockquote, td, h1, h2, h3, h4, h5, h6'
const MIN_BLOCK_CHARS = 20
const TEXT_BOUNDARIES = 'address, article, aside, blockquote, dd, div, dl, dt, figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, table, td, th, tr, ul'

function absolute(value: string, base: string): string | null {
  if (!value.trim()) return null
  try {
    const url = new URL(value.trim(), base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function absoluteSrcset(value: string, base: string): string {
  return parseSrcset(value)
    .map(({ src, descriptor }) => {
      const url = absolute(src, base)
      return url ? [url, descriptor].filter(Boolean).join(' ') : ''
    })
    .filter(Boolean)
    .join(', ')
}

/** Preserve word boundaries between blocks without splitting words marked up by inline tags. */
function readableText(body: HTMLElement): string {
  const copy = body.cloneNode(true) as HTMLElement
  for (const element of copy.querySelectorAll(TEXT_BOUNDARIES)) {
    element.before(body.ownerDocument.createTextNode(' '))
    element.after(body.ownerDocument.createTextNode(' '))
  }
  for (const br of copy.querySelectorAll('br')) br.replaceWith(body.ownerDocument.createTextNode(' '))
  return cleanText(copy.textContent)
}

function stripAttributes(element: Element): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase()
    const unwanted = name.startsWith('on') || name === 'style' || (name.startsWith('data-') && !KEPT_DATA_ATTRIBUTES.has(name))
    if (unwanted) element.removeAttribute(attribute.name)
  }
}

/**
 * Turns extracted HTML into a portable fragment. Parsing happens in an inert document, so nothing
 * here runs or fetches. Output is stored and later displayed, so scripts, handlers and non-web
 * URLs do not survive; everything relative becomes absolute against the page's real URL.
 */
export function normalizeContent(html: string, baseUrl: string): NormalizedContent {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html')
  const body = doc.body
  materializeImages(body)
  for (const element of body.querySelectorAll(DROPPED)) element.remove()
  for (const element of body.querySelectorAll<HTMLElement>('*')) {
    // Opacity/visibility are also used while article loaders initialize (notably WeChat).
    // Only explicit hidden nodes and display:none are reliable signs of unwanted copies.
    if (element.hasAttribute('hidden') || element.style?.display.toLowerCase() === 'none') element.remove()
    else stripAttributes(element)
  }

  for (const element of body.querySelectorAll('img[srcset], source[srcset]')) {
    const srcset = absoluteSrcset(element.getAttribute('srcset') ?? '', baseUrl)
    if (srcset) element.setAttribute('srcset', srcset)
    else element.removeAttribute('srcset')
  }

  const links = new Map<string, LinkRef>()
  const page = cleanLink(baseUrl).split('#')[0]
  for (const anchor of body.querySelectorAll('a[href]')) {
    const href = absolute(anchor.getAttribute('href') ?? '', baseUrl)
    if (!href) {
      anchor.replaceWith(...anchor.childNodes)
      continue
    }
    const clean = cleanLink(href)
    anchor.setAttribute('href', clean)
    if (clean.split('#')[0] !== page && !links.has(clean) && links.size < LIMITS.links) {
      links.set(clean, { href: clean, text: cleanText(anchor.textContent).slice(0, 200) })
    }
  }

  const images = new Map<string, ImageRef>()
  for (const image of body.querySelectorAll('img')) {
    const src = absolute(image.getAttribute('src') ?? '', baseUrl)
    if (!src) {
      // Inline data URIs would dwarf the text; the alt text stands in for them.
      image.replaceWith(doc.createTextNode(cleanText(image.getAttribute('alt'))))
      continue
    }
    image.setAttribute('src', src)
    if (!images.has(src) && images.size < LIMITS.images) images.set(src, { src, alt: cleanText(image.getAttribute('alt')).slice(0, 200) })
  }
  for (const media of body.querySelectorAll('video[src], audio[src], source[src]')) {
    const src = absolute(media.getAttribute('src') ?? '', baseUrl)
    if (src) media.setAttribute('src', src)
    else media.removeAttribute('src')
  }
  for (const video of body.querySelectorAll('video[poster]')) {
    const poster = absolute(video.getAttribute('poster') ?? '', baseUrl)
    if (poster) video.setAttribute('poster', poster)
    else video.removeAttribute('poster')
  }

  const text = readableText(body)
  const linkChars = [...body.querySelectorAll('a')].reduce((sum, anchor) => sum + cleanText(anchor.textContent).length, 0)
  const blocks = [...body.querySelectorAll(BLOCK_SELECTOR)].filter((block) => cleanText(block.textContent).length >= MIN_BLOCK_CHARS).length

  return {
    html: body.innerHTML.trim(),
    text,
    links: [...links.values()],
    images: [...images.values()],
    blocks,
    linkDensity: text.length ? Math.min(1, linkChars / text.length) : 0,
  }
}
