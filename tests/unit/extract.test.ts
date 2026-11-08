import { describe, expect, it } from 'vitest'
import { assessContent } from '@/page/extract/quality'
import { findJsonLd, readJsonLd, readMetadata } from '@/page/extract/metadata'
import { fitMarkdown, toMarkdown } from '@/page/extract/markdown'
import { normalizeContent } from '@/page/extract/normalize'
import { extractPage } from '@/page/extract/pipeline'
import { countWords, normalizeDate } from '@/page/extract/text'
import { LIMITS } from '@/core/limits'
import { defineSite } from '@/sites/types'
import { dom, fixture, plan } from './helpers'

const url = 'https://blog.example.com/posts/event-loop'

describe('text', () => {
  it('counts CJK characters and Latin words together', () => {
    expect(countWords('事件循环 is the core 机制')).toBe(9)
    expect(countWords("it's well-known")).toBe(2)
    expect(countWords('   ')).toBe(0)
  })

  it.each([
    ['2026-03-05T08:30:00+08:00', '', '2026-03-05T00:30:00.000Z'],
    ['2026年3月5日', '', '2026-03-04T16:00:00.000Z'],
    ['2026年03月05日 12:30', '', '2026-03-05T04:30:00.000Z'],
    ['2026-03-05 12:30:15', 'zh-CN', '2026-03-05T04:30:15.000Z'],
    ['2026-03-05 12:30', 'en', '2026-03-05T12:30:00.000Z'],
    ['1772668800', '', '2026-03-05T00:00:00.000Z'],
    ['昨天', '', ''],
    ['', '', ''],
  ])('reads the date %s', (raw, language, expected) => {
    expect(normalizeDate(raw, language)).toBe(expected)
  })
})

describe('metadata', () => {
  it('reads meta tags and JSON-LD, skipping broken blocks', () => {
    const meta = readMetadata(dom(fixture('article.html')), url)
    expect(meta).toMatchObject({
      title: '深入理解事件循环',
      byline: '李明',
      siteName: '技术周刊',
      language: 'zh-CN',
      publishedAt: '2026-03-05T00:30:00.000Z',
      canonicalUrl: 'https://blog.example.com/posts/event-loop',
    })
    expect(meta.structuredData).toHaveLength(1)
  })

  it('finds nodes by type and flattens @graph', () => {
    const nodes = readJsonLd(dom(fixture('article.html')))
    expect(findJsonLd(nodes, 'BlogPosting')?.headline).toBe('深入理解事件循环')
    expect(findJsonLd(nodes, 'Recipe')).toBeNull()
  })
})

describe('normalizeContent', () => {
  it('removes active content and unsafe URLs', () => {
    const { html } = normalizeContent(
      `<p onclick="steal()" style="color:red">text</p>
       <script>alert(1)</script><style>p{}</style><iframe src="https://x.example"></iframe>
       <a href="javascript:alert(1)">bad link</a>
       <img src="javascript:alert(2)" alt="bad image">
       <form><input value="secret"><button>go</button></form>
       <svg><symbol id="icon"><path d="M0 0"></path></symbol></svg>`,
      url,
    )
    expect(html).not.toMatch(/onclick|style=|<script|<style|javascript:|<input|<button|<svg|<path/u)
    expect(html).toContain('bad link')
    expect(html).toContain('bad image')
  })

  it('makes URLs absolute, strips tracking, and lists links and images once', () => {
    const content = normalizeContent(
      `<a href="/a?utm_source=x&id=1">A</a><a href="/a?id=1">again</a><a href="#top">anchor</a>
       <img src="/i.png" alt="i"><img src="/i.png">
       <img src="data:image/png;base64,AAAA" alt="inline">`,
      url,
    )
    expect(content.links).toEqual([{ href: 'https://blog.example.com/a?id=1', text: 'A' }])
    expect(content.images).toEqual([{ src: 'https://blog.example.com/i.png', alt: 'i' }])
    expect(content.html).toContain('href="https://blog.example.com/a?id=1"')
    expect(content.html).not.toContain('data:image')
    expect(content.html).toContain('inline')
  })

  it('keeps code language classes for Markdown', () => {
    expect(normalizeContent('<pre><code class="language-js">x</code></pre>', url).html).toContain('language-js')
  })
})

describe('assessContent', () => {
  const body = (text: string, extra = {}) => ({ html: '', text, links: [], images: [], blocks: 0, linkDensity: 0, ...extra })

  it('rewards substantial structured text', () => {
    const { score, warnings } = assessContent(body('字'.repeat(1500), { blocks: 8 }), { title: 't' })
    expect(score).toBe(100)
    expect(warnings).toEqual([])
  })

  it('flags thin, untitled and link-heavy pages', () => {
    const { score, warnings } = assessContent(body('words here', { linkDensity: 0.9 }), { title: '' })
    expect(score).toBeLessThan(40)
    expect(warnings).toEqual(['short_content', 'link_heavy', 'no_title'])
  })
})

describe('markdown', () => {
  it('converts tables and fenced code', () => {
    const markdown = toMarkdown('<table><tr><th>a</th></tr><tr><td>1</td></tr></table><pre><code class="language-js">x()</code></pre>', url)
    expect(markdown).toMatch(/\| a \|/u)
    expect(markdown).toContain('```js')
  })

  it('truncates on a paragraph boundary', () => {
    const paragraph = `${'字'.repeat(1000)}\n\n`
    const { markdown, truncated } = fitMarkdown(paragraph.repeat(LIMITS.markdownChars / 1000))
    expect(truncated).toBe(true)
    expect(markdown.length).toBeLessThanOrEqual(LIMITS.markdownChars)
    expect(markdown.endsWith('字')).toBe(true)
  })
})

describe('extractPage', () => {
  it('reads a page generically', () => {
    const result = extractPage(dom(fixture('article.html')), url, plan(), null)
    expect(result.extractor).toBe('defuddle')
    expect(result.title).toContain('深入理解事件循环')
    expect(result.byline).toBe('李明')
    expect(result.publishedAt).toBe('2026-03-05T00:30:00.000Z')
    expect(result.markdown).toContain('## 宏任务与微任务')
    expect(result.markdown).toContain('```js')
    expect(result.markdown).toContain('https://blog.example.com/img/queue.png')
    expect(result.markdown).not.toContain('推荐一')
    expect(result.markdown).not.toContain('2026 技术周刊')
    expect(result.links.map((link) => link.href)).toContain('https://blog.example.com/posts/promise?id=7')
    expect(result.qualityScore).toBeGreaterThanOrEqual(70)
    expect(result.html).toBe('')
    expect(result.profile).toBe('')
  })

  it('keeps HTML only when asked', () => {
    expect(extractPage(dom(fixture('article.html')), url, plan({ keepHtml: true }), null).html).toContain('<h2')
  })

  const profile = defineSite({
    id: 'weekly',
    version: 3,
    hosts: ['blog.example.com'],
    content: { selectors: ['.missing-layout', '.post-body'] },
    fields: { title: ['.post h1'], byline: [['meta[name="missing"]', 'content'], '.meta'] },
    extract: ({ url: pageUrl, all }) => ({ extras: { slug: pageUrl.pathname.split('/').at(-1), headings: all('.post-body h2').length } }),
  })

  it('prefers a matching site profile and falls through its selector list', () => {
    const result = extractPage(dom(fixture('article.html')), url, plan(), profile)
    expect(result.extractor).toBe('site:weekly')
    expect(result.profile).toBe('weekly@3')
    expect(result.title).toBe('深入理解事件循环')
    expect(result.byline).toBe('作者 李明 · 2026 年 3 月 5 日')
    expect(result.extras).toEqual({ slug: 'event-loop', headings: 2 })
    expect(result.markdown).toContain('宏任务与微任务')
    expect(result.warnings).not.toContain('site_profile_fell_back')
  })

  it('falls back to generic parsing when a profile is out of date, keeping its fields', () => {
    const stale = defineSite({ ...profile, content: { selectors: ['.layout-from-2019'] } })
    const result = extractPage(dom(fixture('article.html')), url, plan(), stale)
    expect(result.extractor).toBe('defuddle')
    expect(result.warnings).toContain('site_profile_fell_back')
    expect(result.title).toBe('深入理解事件循环')
  })

  it('ignores the profile for a generic comparison', () => {
    const result = extractPage(dom(fixture('article.html')), url, plan({ generic: true }), profile)
    expect(result.extractor).toBe('defuddle')
    expect(result.profile).toBe('')
  })

  it('uses the selector on the job above everything else', () => {
    const result = extractPage(dom(fixture('article.html')), url, plan({ contentSelector: '.related' }), profile)
    expect(result.extractor).toBe('manual')
    expect(result.markdown).toContain('推荐一')
  })

  it('fails clearly when the selector on the job matches nothing', () => {
    expect(() => extractPage(dom(fixture('article.html')), url, plan({ contentSelector: '#nope' }), null)).toThrowError(/正文选择器/u)
  })

  it('reports an empty page instead of saving nothing', () => {
    expect(() => extractPage(dom('<!doctype html><html><head><title>x</title></head><body></body></html>'), url, plan(), null)).toThrowError()
  })
})
