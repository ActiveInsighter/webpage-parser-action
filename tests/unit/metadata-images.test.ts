import { describe, expect, it } from 'vitest'
import { readJsonLd, readMetadata } from '@/page/extract/metadata'
import { materializeImages, parseSrcset } from '@/page/ops/images'
import { normalizeContent } from '@/page/extract/normalize'
import { dom } from './helpers'

const url = 'https://blog.example.com/posts/article'
const jsonLd = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`

describe('metadata quality regressions', () => {
  it('prefers the article over a preceding WebPage and resolves graph references', () => {
    const metadata = readMetadata(dom(`<title>Site title</title>${jsonLd({ '@graph': [
      { '@type': 'WebPage', name: 'Home', datePublished: '2020-01-01' },
      { '@type': ['Thing', 'BlogPosting'], headline: 'Article headline', description: 'Article description',
        author: [{ '@id': '#author' }, { name: 'Second author' }], publisher: { '@id': '#publisher' },
        image: { '@id': '#image' }, datePublished: '2026-03-05T08:30:00+08:00' },
      { '@id': '#author', '@type': 'Person', name: 'First author' },
      { '@id': '#publisher', '@type': 'Organization', name: 'Publisher' },
      { '@id': '#image', '@type': 'ImageObject', contentUrl: '/cover.jpg' },
    ] })}`), url)
    expect(metadata).toMatchObject({
      title: 'Article headline', description: 'Article description', byline: 'First author, Second author',
      siteName: 'Publisher', leadImage: 'https://blog.example.com/cover.jpg', publishedAt: '2026-03-05T00:30:00.000Z',
    })
  })

  it('retains a typed graph container and accepts schema-qualified type names', () => {
    const document = dom(jsonLd({ '@type': 'https://schema.org/NewsArticle', headline: 'News headline',
      '@graph': [{ '@type': 'Person', name: 'Writer' }] }))
    expect(readJsonLd(document)).toHaveLength(2)
    expect(readMetadata(document, url).title).toBe('News headline')
  })

  it('skips invalid dates and unsafe metadata URLs when valid fallbacks exist', () => {
    const metadata = readMetadata(dom(`<meta property="article:published_time" content="unknown">
      <meta property="og:image" content="javascript:alert(1)"><meta name="twitter:image" content="/safe.jpg">
      <link rel="canonical alternate" href="javascript:alert(1)"><meta property="og:url" content="/canonical">
      ${jsonLd({ '@type': 'Article', datePublished: '2026-03-05T00:00:00Z' })}`), url)
    expect(metadata).toMatchObject({ publishedAt: '2026-03-05T00:00:00.000Z',
      leadImage: 'https://blog.example.com/safe.jpg', canonicalUrl: 'https://blog.example.com/canonical' })
  })

  it('uses document base URLs and handles cyclic graph references without recursion errors', () => {
    const metadata = readMetadata(dom(`<base href="https://cdn.example.com/assets/">
      <meta property="og:image" content="cover.jpg"><link rel="canonical alternate" href="../article">
      ${jsonLd({ '@graph': [{ '@type': 'Article', author: { '@id': '#cycle' } }, { '@id': '#cycle', name: { '@id': '#cycle' } }] })}`), url)
    expect(metadata.leadImage).toBe('https://cdn.example.com/assets/cover.jpg')
    expect(metadata.canonicalUrl).toBe('https://cdn.example.com/article')
    expect(metadata.byline).toBe('')
  })
})

describe('image quality regressions', () => {
  it('parses descriptor separators without damaging URL commas or treating data payloads as URLs', () => {
    expect(parseSrcset('/small.jpg 400w,/large.jpg 1200w').map((entry) => entry.src)).toEqual(['/small.jpg', '/large.jpg'])
    expect(parseSrcset('https://cdn.example.com/image?crop=1,2 1x, /large.jpg 2x').map((entry) => entry.src))
      .toEqual(['https://cdn.example.com/image?crop=1,2', '/large.jpg'])
    const document = dom('<img srcset="data:image/png;base64,AAAA 1x,/real.jpg 2x">')
    materializeImages(document)
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/real.jpg')
  })

  it('recovers srcset-only and lazy srcset images into Markdown-compatible sources', () => {
    const content = normalizeContent(`<img alt="responsive" srcset="/small.jpg 320w, /large.jpg 1280w">
      <img alt="lazy" src="/loading.gif" data-srcset="/one.jpg 1x, /two.jpg 2x">`, url)
    expect(content.images).toEqual([
      { src: 'https://blog.example.com/large.jpg', alt: 'responsive' },
      { src: 'https://blog.example.com/two.jpg', alt: 'lazy' },
    ])
  })

  it('recovers picture source images while preserving an existing usable img src', () => {
    const document = dom(`<picture><source srcset="/photo.webp 1x, /photo-2.webp 2x"><img alt="photo"></picture>
      <img id="existing" src="/keep.jpg" srcset="/change.jpg 2x">`)
    materializeImages(document)
    expect(document.querySelector('picture img')?.getAttribute('src')).toBe('/photo-2.webp')
    expect(document.querySelector('#existing')?.getAttribute('src')).toBe('/keep.jpg')
  })

  it('replaces placeholder images with noscript fallbacks without duplicate images', () => {
    const document = dom('<img src="/placeholder.gif" alt="placeholder"><noscript></noscript>')
    document.querySelector('noscript')!.textContent = '<img src="/real.jpg" alt="real">'
    expect(materializeImages(document)).toBe(1)
    expect(document.querySelectorAll('img')).toHaveLength(1)
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/real.jpg')
  })

  it('handles parsed noscript DOM children and skips unsafe source alternatives', () => {
    const document = dom('<body><noscript><img src="/fallback.jpg" alt="fallback"></noscript><img data-src="javascript:alert(1)" data-original="/safe.jpg"></body>')
    materializeImages(document)
    expect(document.querySelector('noscript')).toBeNull()
    expect([...document.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual(['/fallback.jpg', '/safe.jpg'])
  })
})
