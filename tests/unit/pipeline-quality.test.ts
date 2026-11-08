import { describe, expect, it, vi } from 'vitest'
import { extractPage } from '@/page/extract/pipeline'
import * as strategies from '@/page/extract/strategies'
import { defineSite } from '@/sites/types'
import { dom, plan } from './helpers'

const url = 'https://blog.example.com/posts/quality'
const prose = '<p>正文描述了网页内容的完整性，采集时应当保留真实段落，避免导航和脚本挤占正文的位置。</p>'.repeat(6)
const article = () => dom(`<title>正文标题</title><article>${prose}</article>`, url)
const profile = defineSite({ id: 'quality', version: 1, hosts: ['blog.example.com'], content: { selectors: ['.post'] } })

describe('candidate quality and recovery', () => {
  it('falls back when a site container contains navigation instead of prose', () => {
    const navigation = Array.from({ length: 40 }, (_, i) => `<a href="/nav/${i}">navigation${i}</a>`).join(' ')
    vi.spyOn(strategies, 'siteCandidate').mockReturnValue({ strategy: 'site:quality', html: `<div>${navigation}</div>` })
    const result = extractPage(article(), url, plan(), profile)
    expect(result.extractor).toBe('defuddle')
    expect(result.markdown).toContain('保留真实段落')
    expect(result.markdown).not.toContain('navigation')
    expect(result.warnings).toContain('site_profile_fell_back')
  })

  it('does not let long link lists bypass the generic fallback', () => {
    const navigation = `<p><a href="/nav">${'navigation '.repeat(2000)}</a></p>`.repeat(5)
    vi.spyOn(strategies, 'defuddleCandidate').mockReturnValue({ strategy: 'defuddle', html: navigation })
    vi.spyOn(strategies, 'readabilityCandidate').mockReturnValue({ strategy: 'readability', html: prose })
    const result = extractPage(article(), url, plan(), null)
    expect(result.extractor).toBe('readability')
    expect(result.warnings).not.toContain('link_heavy')
  })

  it('uses Readability after Defuddle throws on page markup', () => {
    vi.spyOn(strategies, 'defuddleCandidate').mockImplementation(() => { throw new Error('unrecognized markup') })
    const result = extractPage(article(), url, plan(), null)
    expect(result.extractor).toBe('readability')
    expect(result.markdown).toContain('保留真实段落')
  })

  it('keeps a weak first candidate when the fallback parser throws', () => {
    vi.spyOn(strategies, 'defuddleCandidate').mockReturnValue({ strategy: 'defuddle', html: '<p>少量正文</p>' })
    vi.spyOn(strategies, 'readabilityCandidate').mockImplementation(() => { throw new Error('broken fallback') })
    expect(extractPage(article(), url, plan(), null).markdown).toBe('少量正文')
  })

  it('reports EMPTY_CONTENT if neither parser can produce content', () => {
    vi.spyOn(strategies, 'defuddleCandidate').mockImplementation(() => { throw new Error('broken parser') })
    vi.spyOn(strategies, 'readabilityCandidate').mockReturnValue(null)
    expect(() => extractPage(article(), url, plan(), null)).toThrow(expect.objectContaining({ code: 'EMPTY_CONTENT' }))
  })

  it('keeps a short site-only article when generic parsers have no result', () => {
    vi.spyOn(strategies, 'defuddleCandidate').mockReturnValue(null)
    vi.spyOn(strategies, 'readabilityCandidate').mockReturnValue(null)
    const short = defineSite({ ...profile, extract: () => ({ html: `<p>${'content '.repeat(35)}</p>` }) })
    const result = extractPage(dom('<html><body></body></html>', url), url, plan(), short)
    expect(result.extractor).toBe('site:quality')
    expect(result.markdown).toContain('content')
    expect(result.qualityScore).toBeLessThan(40)
    expect(result.warnings).toContain('short_content')
  })

  it('recovers from a broken site extractor', () => {
    const broken = defineSite({ ...profile, extract() { throw new Error('changed page data') } })
    const result = extractPage(article(), url, plan(), broken)
    expect(result.markdown).toContain('保留真实段落')
    expect(result.warnings).toContain('site_profile_fell_back')
  })

  it('skips hidden duplicate containers and script-only layout shells', () => {
    const doc = dom(`<title>标题</title><div hidden><div class="post">${'<p>stale hidden content </p>'.repeat(40)}</div></div>
      <div class="post"><script>${'embedded state '.repeat(100)}</script></div>
      <div class="post">${prose}</div>`, url)
    const result = extractPage(doc, url, plan(), profile)
    expect(result.extractor).toBe('site:quality')
    expect(result.markdown).toContain('保留真实段落')
    expect(result.markdown).not.toMatch(/stale|embedded/u)
  })
})

describe('explicit content selections', () => {
  it('keeps the table context of a selected row', () => {
    const doc = dom('<title>表格</title><table><tr id="row"><th>Field</th><th>Value</th></tr></table>', url)
    const result = extractPage(doc, url, plan({ contentSelector: '#row', keepHtml: true }), null)
    expect(result.markdown).toContain('| Field | Value |')
    expect(result.html).toContain('<table>')
  })

  it('keeps the selected code block and all of its whitespace', () => {
    const doc = dom('<title>代码</title><pre id="code"><code class="language-js">  const n = 1\n\n\n  run(n)</code></pre>', url)
    const result = extractPage(doc, url, plan({ contentSelector: '#code' }), null)
    expect(result.extractor).toBe('manual')
    expect(result.markdown).toContain('```js\n  const n = 1\n\n\n  run(n)\n```')
  })

  it('keeps every selected paragraph without rerunning article detection', () => {
    const doc = dom(`<title>标题</title><article id="selected">${prose}<aside><p>用户选定区域中的附注必须保留。</p></aside></article>`, url)
    expect(extractPage(doc, url, plan({ contentSelector: '#selected' }), null).markdown).toContain('用户选定区域中的附注必须保留')
  })

  it('keeps an image-only selection instead of treating missing text as empty', () => {
    const doc = dom('<title>图片</title><img id="chosen" src="/diagram.png" alt="流程图">', url)
    const result = extractPage(doc, url, plan({ contentSelector: '#chosen' }), null)
    expect(result.images).toEqual([{ src: 'https://blog.example.com/diagram.png', alt: '流程图' }])
    expect(result.markdown).toContain('![流程图]')
    expect(result.warnings).toContain('short_content')
  })
})

describe('merged metadata', () => {
  it('uses a title supplied by the profile when assessing generic content', () => {
    vi.spyOn(strategies, 'defuddleCandidate').mockReturnValue({ strategy: 'defuddle', html: prose })
    const titled = defineSite({ ...profile, extract: () => ({ title: '站点提供的标题' }) })
    const result = extractPage(dom(`<article>${prose}</article>`, url), url, plan(), titled)
    expect(result.title).toBe('站点提供的标题')
    expect(result.warnings).not.toContain('no_title')
  })

  it('resolves selected content and site cover images using the document base', () => {
    const doc = dom(`<head><title>标题</title><base href="https://cdn.example.com/assets/"></head>
      <body><article><p>正文 <a href="reference.html">参考</a></p><img src="diagram.png" alt="图"></article></body>`, url)
    const withCover = defineSite({ ...profile, extract: () => ({ leadImage: 'cover.png' }) })
    const result = extractPage(doc, url, plan({ contentSelector: 'article' }), withCover)
    expect(result.url).toBe(url)
    expect(result.images[0]?.src).toBe('https://cdn.example.com/assets/diagram.png')
    expect(result.links[0]?.href).toBe('https://cdn.example.com/assets/reference.html')
    expect(result.leadImage).toBe('https://cdn.example.com/assets/cover.png')
  })

  it('normalizes relative cover URLs from site fields', () => {
    const withCover = defineSite({ ...profile, extract: () => ({ leadImage: '../cover.png' }) })
    expect(extractPage(article(), url, plan(), withCover).leadImage).toBe('https://blog.example.com/cover.png')
  })

  it('tries another date and image when site fields are invalid', () => {
    vi.spyOn(strategies, 'defuddleCandidate').mockReturnValue({ strategy: 'defuddle', html: prose, publishedAt: '2026-11-01T00:00:00Z', leadImage: '/valid-cover.png' })
    const badFields = defineSite({ ...profile, extract: () => ({ publishedAt: 'not a date', leadImage: 'javascript:alert(1)' }) })
    const result = extractPage(article(), url, plan(), badFields)
    expect(result.publishedAt).toBe('2026-11-01T00:00:00.000Z')
    expect(result.leadImage).toBe('https://blog.example.com/valid-cover.png')
  })
})
