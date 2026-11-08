import { describe, expect, it } from 'vitest'
import { extractPage } from '@/page/extract/pipeline'
import { defineSite } from '@/sites/types'
import { dom, plan } from './helpers'

const url = 'https://blog.example.com/posts/media'
const prose = '<p>这是用于采集验证的文章正文，图片和代码即使放在简短的最后一节，也属于文章本身，不能因为缺少长段落就当作推广内容删除。这里继续说明正文结构，确保文章长度足够触发尾部段落过滤。</p>'.repeat(6)
const profile = defineSite({ id: 'media', version: 1, hosts: ['blog.example.com'], content: { selectors: ['#post'] } })
const capture = (ending: string) => extractPage(dom(`<title>采集媒体</title><article id="post">${prose}${ending}</article>`, url), url, plan(), profile)

describe('media in explicitly selected article containers', () => {
  it('keeps an unwrapped responsive image and its short final section', () => {
    const result = capture('<h2>完整内容标记</h2><p>回放仍保留完整内容。</p><img srcset="/small.jpg 400w,/large.jpg 1200w" alt="正文示意图">')
    expect(result.extractor).toBe('site:media')
    expect(result.markdown).toContain('## 完整内容标记')
    expect(result.markdown).toContain('回放仍保留完整内容。')
    expect(result.images).toEqual([{ src: 'https://blog.example.com/large.jpg', alt: '正文示意图' }])
  })

  it('keeps a short plain preformatted example at the end of an article', () => {
    const result = capture('<h2>最小示例</h2><pre>  first()\n\n\n  second()</pre>')
    expect(result.markdown).toContain('## 最小示例')
    expect(result.markdown).toContain('```\n  first()\n\n\n  second()\n```')
  })

  it('continues removing marked advertising while preserving the article illustration', () => {
    const result = capture('<h2>结果图</h2><img src="/plot.png" alt="实验结果"><div class="advertisement"><img src="/ad.png" alt="advertisement"></div>')
    expect(result.images.map((image) => image.src)).toEqual(['https://blog.example.com/plot.png'])
    expect(result.markdown).not.toContain('/ad.png')
  })

  it('keeps ordinary generic filtering of advertising and navigation', () => {
    const document = dom(`<title>文章</title><nav>导航链接</nav><main><article>${prose}
      <img src="/plot.png" alt="实验结果"><div class="advertisement"><img src="/ad.png" alt="advertisement"></div>
      </article></main><aside>相关推荐</aside>`, url)
    const result = extractPage(document, url, plan({ generic: true }), profile)
    expect(result.markdown).not.toMatch(/导航链接|相关推荐|ad\.png/u)
    expect(result.images.map((image) => image.src)).toContain('https://blog.example.com/plot.png')
  })

  it('skips a layout shell whose text is entirely inside display:none children', () => {
    const document = dom(`<title>文章</title><div class="post"><div style="display:none">${prose}过期文章</div></div>
      <div class="post">${prose}<p>当前文章标记。</p></div>`, url)
    const withAlternatives = defineSite({ ...profile, content: { selectors: ['.post'] } })
    const result = extractPage(document, url, plan(), withAlternatives)
    expect(result.extractor).toBe('site:media')
    expect(result.markdown).toContain('当前文章标记')
    expect(result.markdown).not.toContain('过期文章')
  })
})
