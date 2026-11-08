const LAZY_SOURCES = ['data-src', 'data-original', 'data-actualsrc', 'data-lazy-src', 'data-original-src', 'data-url']
const LAZY_SRCSETS = ['data-srcset', 'data-lazy-srcset']

function isPlaceholder(src: string): boolean {
  return !src.trim() || /^data:/iu.test(src.trim()) || /(?:^|\/)(?:blank|spacer|loading|placeholder|pixel)\.(?:gif|png|svg)(?:[?#]|$)/iu.test(src)
}

interface SrcsetCandidate {
  src: string
  descriptor: string
  density: number
}

/** Read srcset without splitting commas inside URLs (including data URLs). */
export function parseSrcset(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = []
  let position = 0
  while (position < value.length) {
    while (position < value.length && /[\s,]/u.test(value[position]!)) position += 1
    const start = position
    while (position < value.length && !/\s/u.test(value[position]!)) position += 1
    let src = value.slice(start, position)
    if (!src) break
    let descriptor = ''
    if (src.endsWith(',')) src = src.replace(/,+$/u, '')
    else {
      const descriptorStart = position
      while (position < value.length && value[position] !== ',') position += 1
      descriptor = value.slice(descriptorStart, position).trim()
    }
    if (position < value.length && value[position] === ',') position += 1
    if (!src || (descriptor && !/^(?:[1-9]\d*w|(?:\d+(?:\.\d+)?|\.\d+)x)$/u.test(descriptor))) continue
    const density = descriptor ? Number.parseFloat(descriptor) : 1
    if (density > 0) candidates.push({ src, descriptor, density })
  }
  return candidates
}

function usableSource(src: string): boolean {
  // Relative URLs are resolved against the target page by normalization. Its inert document
  // may have about:blank as its base, so do not require a document URL here.
  const scheme = /^[a-z][a-z\d+.-]*:/iu.exec(src.trim())?.[0]
  return !isPlaceholder(src) && (!scheme || /^https?:$/iu.test(scheme))
}

function bestSrcset(value: string): string {
  return parseSrcset(value).filter((candidate) => usableSource(candidate.src))
    .sort((a, b) => b.density - a.density)[0]?.src ?? ''
}

/**
 * Copies lazy-load attributes into src/srcset, including responsive-only images. Works on any
 * root, so loaders depending on IntersectionObserver need not run in an unrendered tab.
 */
export function materializeImages(root: ParentNode): number {
  let changed = 0
  // A browser with scripting enabled stores noscript HTML as text; inert DOM parsers can
  // instead give it actual children. Recover both before normalization drops noscript.
  for (const fallback of root.querySelectorAll('noscript')) {
    const parsed = fallback.querySelector('img')
      ?? new DOMParser().parseFromString(fallback.textContent ?? '', 'text/html').querySelector('img')
    if (!parsed) continue
    const previous = fallback.previousElementSibling
    if (previous?.tagName === 'IMG') {
      if (usableSource(previous.getAttribute('src') ?? '')) {
        fallback.remove()
        continue
      }
      previous.replaceWith(parsed)
      fallback.remove()
    } else fallback.replaceWith(parsed)
    changed += 1
  }

  for (const image of root.querySelectorAll('img')) {
    if (!image.getAttribute('srcset')) {
      const srcset = LAZY_SRCSETS.map((name) => image.getAttribute(name)).find(Boolean)
      if (srcset) image.setAttribute('srcset', srcset)
    }
    if (usableSource(image.getAttribute('src') ?? '')) continue
    const lazySource = LAZY_SOURCES.map((name) => image.getAttribute(name) ?? '').find(usableSource)
    const picture = image.closest('picture')
    const view = image.ownerDocument.defaultView
    const pictureSource = picture ? [...picture.querySelectorAll('source')].filter((source) => {
      const media = source.getAttribute('media')
      return !media || !view?.matchMedia || view.matchMedia(media).matches
    }).map((source) => bestSrcset(source.getAttribute('srcset')
      || LAZY_SRCSETS.map((name) => source.getAttribute(name)).find(Boolean) || '')).find(Boolean) : ''
    const source = lazySource || pictureSource || bestSrcset(image.getAttribute('srcset') ?? '')
    if (source) {
      image.setAttribute('src', source)
      changed += 1
    }
  }
  return changed
}
