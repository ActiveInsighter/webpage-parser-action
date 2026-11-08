import { describe, expect, it } from 'vitest'
import { detectBlocker } from '@/page/blockers'
import { extractPage } from '@/page/extract/pipeline'
import { sites } from '@/sites'
import { findProfile } from '@/sites/registry'
import { dom, plan } from './helpers'

/** Markup below mirrors the real pages, as read from them with tests/e2e/live.mjs. */
const body = '<p>这是一段足够长的正文内容，用来代表站点文章里的真实段落。</p>'.repeat(6)

function capture(url: string, html: string) {
  return extractPage(dom(html, url), url, plan({ requestedUrl: url }), findProfile(sites, url))
}

describe('registry', () => {
  it.each([
    ['https://mp.weixin.qq.com/s/abc', 'weixin'],
    ['https://mp.weixin.qq.com/s?__biz=x&mid=1', 'weixin'],
    ['https://zhuanlan.zhihu.com/p/656686642', 'zhihu'],
    ['https://www.zhihu.com/question/1/answer/2', 'zhihu'],
    ['https://juejin.cn/post/7637856870833635343', 'juejin'],
    ['https://blog.csdn.net/user/article/details/135554178', 'csdn'],
    ['https://www.oschina.net/news/503428', 'oschina'],
    ['https://sspai.com/post/118541', 'sspai'],
  ])('routes %s to %s', (url, id) => {
    expect(findProfile(sites, url)?.id).toBe(id)
  })

  it.each(['https://mp.weixin.qq.com/', 'https://www.zhihu.com/hot', 'https://juejin.cn/', 'https://example.com/post/1', 'not a url'])(
    'leaves %s to generic parsing',
    (url) => {
      expect(findProfile(sites, url)).toBeNull()
    },
  )

  it('keeps ids unique, since results record them', () => {
    expect(new Set(sites.map((site) => site.id)).size).toBe(sites.length)
  })
})

describe('weixin', () => {
  const url = 'https://mp.weixin.qq.com/s/abc'
  const page = `<html><head><title></title><meta name="author" content="元信息作者"><meta property="og:site_name" content="微信公众平台">
    <meta property="og:image" content="http://mmbiz.qpic.cn/cover.jpg"></head><body><div id="js_article">
    <h1 class="rich_media_title" id="activity-name"> 文章标题 </h1>
    <span id="js_author_name">小帥童學</span><a id="js_name">公众号名</a><em id="publish_time">2026年3月5日 12:30</em>
    <div id="js_content" style="visibility: hidden; opacity: 0;">${body}<img data-src="http://mmbiz.qpic.cn/a.png" alt=""></div></div></body></html>`

  it('reads the hidden content, real images and the account', () => {
    const result = capture(url, page)
    expect(result.extractor).toBe('site:weixin')
    expect(result).toMatchObject({ title: '文章标题', byline: '小帥童學', siteName: '公众号名', publishedAt: '2026-03-05T04:30:00.000Z' })
    expect(result.markdown).toContain('真实段落')
    expect(result.images[0]?.src).toBe('http://mmbiz.qpic.cn/a.png')
  })

  it('falls back to the timestamp in the inline script while #publish_time is empty', () => {
    const unset = page.replace('2026年3月5日 12:30', '').replace('</body>', '<script>var ct = "1772668800";</script></body>')
    expect(capture(url, unset).publishedAt).toBe('2026-03-05T00:00:00.000Z')
  })

  it('reports a deleted article', () => {
    const notice = '<html><body><div class="weui-msg"><p>该内容已被发布者删除</p></div></body></html>'
    expect(detectBlocker(dom(notice, url), url, url, findProfile(sites, url))?.code).toBe('NOT_FOUND')
  })
})

describe('zhihu', () => {
  const state = (entities: unknown) => `<script id="js-initialData" type="text/json">${JSON.stringify({ initialState: { entities } })}</script>`

  it('reads a column article from the embedded data', () => {
    const url = 'https://zhuanlan.zhihu.com/p/123'
    const page = `<html><head><title>x - 知乎</title></head><body>${state({
      articles: { 123: { title: '专栏标题', content: body, author: { name: '作者甲' }, created: 1772668800, excerpt: '摘要', voteupCount: 12, commentCount: 3 } },
    })}</body></html>`
    const result = capture(url, page)
    expect(result.extractor).toBe('site:zhihu')
    expect(result).toMatchObject({ title: '专栏标题', byline: '作者甲', publishedAt: '2026-03-05T00:00:00.000Z', description: '摘要' })
    expect(result.extras).toEqual({ voteupCount: 12, commentCount: 3 })
  })

  it('reads one answer, with the question as title and the author by reference', () => {
    const url = 'https://www.zhihu.com/question/1/answer/2'
    const page = `<html><body>${state({
      questions: { 1: { title: '问题标题' } },
      answers: { 2: { content: body, author: 'user-1', created_time: 1772668800, voteup_count: 5 } },
      users: { 'user-1': { name: '答主' } },
    })}</body></html>`
    expect(capture(url, page)).toMatchObject({ title: '问题标题', byline: '答主' })
  })

  it('falls back to the DOM when the embedded data is missing or broken', () => {
    const url = 'https://zhuanlan.zhihu.com/p/123'
    const rich = `<h1 class="Post-Title">DOM 标题</h1><div class="Post-RichTextContainer">${body}</div>`
    for (const extra of ['', '<script id="js-initialData" type="text/json">{broken</script>', state({ articles: {} })]) {
      const result = capture(url, `<html><body>${extra}${rich}</body></html>`)
      expect(result.extractor).toBe('site:zhihu')
      expect(result.title).toBe('DOM 标题')
    }
  })

  it('reports the anti-bot page', () => {
    const url = 'https://www.zhihu.com/account/unhuman?need_login=true'
    const page = 'https://zhuanlan.zhihu.com/p/123'
    const profile = findProfile(sites, page)
    expect(detectBlocker(dom('<html><body>x</body></html>', url), url, page, profile)?.code).toBe('CAPTCHA')
  })
})

describe('juejin', () => {
  it('takes the title from the page and collects tags', () => {
    const url = 'https://juejin.cn/post/7637856870833635343'
    const page = `<html><head><title>标题和摘要混在一起 - 掘金</title></head><body><h1 class="article-title"> 真实标题 </h1>
      <div class="author-info-block"><a class="username">深小乐</a><div class="meta-box"><time datetime="2026-05-10T02:17:48.000Z">2026-05-10</time></div></div>
      <div class="article-viewer markdown-body"><style>.x{}</style>${body}</div>
      <div class="tag-list"><span class="tag-title">人工智能</span><span class="tag-title">前端</span></div></body></html>`
    const result = capture(url, page)
    expect(result).toMatchObject({ title: '真实标题', byline: '深小乐', siteName: '稀土掘金', publishedAt: '2026-05-10T02:17:48.000Z' })
    expect(result.extras).toEqual({ tags: ['人工智能', '前端'] })
    expect(result.markdown).not.toContain('.x{}')
  })
})

describe('oschina', () => {
  it('reads the editor block and the meta row', () => {
    const url = 'https://www.oschina.net/news/503428'
    const page = `<html><head><title>OSCHINA - 开源 × AI · 开发者生态社区</title></head><body><div class="news-content"><h1 class="news-content-title">新闻标题</h1>
      <div class="ant-space"><div class="ant-space-item">来源：投稿</div><div class="ant-space-item">编辑:gewumind</div><div class="ant-space-item">2026-11-05</div></div>
      <div class="news-content-AiDesc">总结由社区平台通过AI大模型技术生成</div><div class="editor heti">${body}</div></div></body></html>`
    const result = capture(url, page)
    expect(result).toMatchObject({ title: '新闻标题', byline: 'gewumind', siteName: 'OSCHINA' })
    expect(result.publishedAt).toMatch(/^2026-11-05/u)
    expect(result.markdown).not.toContain('总结由社区平台')
  })
})

describe('sspai', () => {
  it('cleans the title and site name, and leaves the content to generic parsing without a warning', () => {
    const url = 'https://sspai.com/post/118498'
    const page = `<html lang="zh-CN"><head><title>派早报：今日要闻 - 少数派</title><meta name="author" content="少数派编辑部"></head><body><main><article><h1>今日要闻</h1>${body}</article></main></body></html>`
    const result = capture(url, page)
    expect(result).toMatchObject({ title: '派早报：今日要闻', siteName: '少数派', extractor: 'defuddle' })
    expect(result.warnings).not.toContain('site_profile_fell_back')
  })
})

describe('csdn', () => {
  it('reads the post and drops code-block chrome', () => {
    const url = 'https://blog.csdn.net/user/article/details/135554178'
    const page = `<html><body><h1 class="title-article">博客标题</h1><a class="follow-nickName">博主</a>
      <div class="article-bar-top"><span class="time">于 2024-01-12 17:41:00 发布</span></div>
      <div id="content_views">${body}<pre><code>x()</code></pre></div></body></html>`
    const result = capture(url, page)
    expect(result).toMatchObject({ title: '博客标题', byline: '博主', siteName: 'CSDN' })
    expect(result.publishedAt).toMatch(/^2024-01-12/u)
  })
})
