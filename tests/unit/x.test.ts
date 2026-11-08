import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractPage } from '@/page/extract/pipeline'
import { sites } from '@/sites'
import { findProfile } from '@/sites/registry'
import { readPosts, selectPosts, statusIdentity } from '@/sites/x'
import { dom, plan } from './helpers'

/** A signed-in card, as X's app renders it. */
function card(id: string, text = '正文', handle = 'alice', extra = ''): string {
  return `<article data-testid="tweet"><div data-testid="User-Name">${handle}</div>
<a href="/${handle}/status/${id}"><time datetime="2026-11-07T01:02:03Z">Nov 7</time></a>
<div data-testid="tweetText">${text}</div>${extra}</article>`
}

/** An anonymous card, as plain HTTP gets it: avatar link, tooltip status link, epoch in a script. */
function anonymousCard(id: string, text: string, handle = 'alice'): string {
  return `<article><div data-post-avatar="true"><a href="/${handle}"><img alt="@${handle}" src="https://pbs.twimg.com/profile_images/1/a_normal.jpg"></a></div>
<a href="/${handle}"><div>Alice Liddell</div></a><a href="/${handle}"><span>@${handle}</span></a>
<a href="/${handle}/status/${id}" data-base-ui-tooltip-trigger="" id="t-${id}">5h</a>
<script>window.__xClientTextFormatters?.run("t-${id}", "formatFullTimestamp", {"timestamp":1762477323000,"lang":"en"});</script>
<div class="text-primary whitespace-pre-wrap" dir="auto">${text}</div>
<img src="https://pbs.twimg.com/media/photo-${id}.jpg"><div role="group" aria-label="12 replies, 3 reposts, 1,204 likes, 9 bookmarks, 45,000 views"></div></article>`
}

const page = (body: string, url = 'https://x.com/alice/status/222') => dom(`<html><head><title>X</title></head><body>${body}</body></html>`, url)
const select = (html: string, url: string, scope: 'target' | 'visible' = 'target', max = 1) => selectPosts(readPosts(page(html, url)), url, scope, max)

describe('x identity', () => {
  it('accepts status aliases, tracking and media suffixes, and nothing else', () => {
    for (const url of ['https://twitter.com/alice/status/123?s=20', 'https://x.com/alice/status/123/photo/2', 'https://mobile.x.com/alice/status/123/video/1', 'https://x.com/i/web/status/123']) {
      expect(statusIdentity(url)?.id).toBe('123')
    }
    for (const url of ['https://evil.test/alice/status/123', 'https://x.com/alice/status/123junk', 'https://x.com/alice', 'https://x.com/alice/status/123/likes']) {
      expect(statusIdentity(url)).toBeNull()
    }
    expect(statusIdentity('https://x.com/i/status/9')).toEqual({ id: '9', handle: null, url: 'https://x.com/i/status/9' })
  })
})

describe('x posts', () => {
  it('returns the linked reply even when its parent comes first', () => {
    const { posts, target } = select(card('111', 'parent') + card('222', 'reply') + card('333', 'neighbour'), 'https://x.com/alice/status/222')
    expect(posts.map((post) => post.id)).toEqual(['222'])
    expect(target?.text).toBe('reply')
    expect(posts[0]?.relation).toBe('target')
  })

  it('never returns a parent or a quote in place of a missing target', () => {
    expect(() => select(card('111', 'parent', 'alice', card('222', 'quoted')), 'https://x.com/alice/status/222', 'visible', 5)).toThrow(expect.objectContaining({ code: 'TARGET_NOT_FOUND' }))
  })

  it('keeps a quote out of the card it is quoted in', () => {
    const quote = `<div data-testid="quoteTweet">${card('222', 'quote', 'alice', '<img src="https://pbs.twimg.com/media/quote.jpg"><div role="group" aria-label="999 likes"></div>')}</div>`
    const [post] = readPosts(page(card('111', 'own', 'alice', `${quote}<div role="group" aria-label="1 reply, 2 reposts, 3 likes"></div>`)))
    expect(post).toMatchObject({ text: 'own', images: [], metrics: { replies: 1, reposts: 2, likes: 3 }, quotedUrls: ['https://x.com/alice/status/222'] })
    expect(readPosts(page(card('111', 'own', 'alice', quote)))).toHaveLength(1)
  })

  it('reads engagement in the reader\'s language', () => {
    const [post] = readPosts(page(card('111', 'x', 'alice', '<div role="group" aria-label="1041 回复、858 转帖、14613 点赞、1185 书签、1278638 次观看"></div>')))
    expect(post?.metrics).toEqual({ replies: 1041, reposts: 858, likes: 14613, bookmarks: 1185, views: 1278638 })
  })

  it('keeps CJK, emoji and line breaks as written', () => {
    const [post] = readPosts(page(card('111', '中<span>文</span><br>line  two <img alt="😀" src="emoji.svg">')))
    expect(post?.text).toBe('中文\nline  two 😀')
  })

  it('accepts a quote-only post', () => {
    const html = card('111', '', 'alice', `<div data-testid="quoteTweet">${card('222')}</div>`).replace('<div data-testid="tweetText"></div>', '')
    expect(readPosts(page(html))[0]?.id).toBe('111')
  })

  it('lists visible posts target first, once each, without guessing reply relations', () => {
    const { posts } = select(card('111') + card('222') + card('222') + card('333'), 'https://x.com/alice/status/222', 'visible', 3)
    expect(posts.map((post) => post.id)).toEqual(['222', '111', '333'])
    expect(posts.map((post) => post.relation)).toEqual(['target', 'visible', 'visible'])
    expect(posts[1]?.isReply).toBeNull()
  })

  it('reads the anonymous layout: author, epoch time, media and metrics', () => {
    const [post] = readPosts(page(anonymousCard('222', '第一行\n第二行')))
    expect(post).toMatchObject({
      id: '222', handle: '@alice', author: 'Alice Liddell', text: '第一行\n第二行', postedAt: '2025-11-07T01:02:03.000Z',
      images: ['https://pbs.twimg.com/media/photo-222.jpg'], metrics: { replies: 12, reposts: 3, likes: 1204, bookmarks: 9, views: 45000 },
    })
  })
})

describe('x through the shared pipeline', () => {
  const profile = findProfile(sites, 'https://x.com/alice/status/222')

  it('turns the target post into one trusted document with its own identity', () => {
    const draft = extractPage(page(card('111', 'parent') + anonymousCard('222', '短帖')), 'https://x.com/alice/status/222', plan({ requestedUrl: 'https://x.com/alice/status/222' }), profile)
    expect(draft.identity).toBe('x:status:222')
    expect(draft.profile).toBe('x@1')
    expect(draft.extractor).toBe('site:x')
    expect(draft.title).toBe('Alice Liddell：短帖')
    expect(draft.publishedAt).toBe('2025-11-07T01:02:03.000Z')
    expect(draft.items).toHaveLength(1)
    expect(draft.markdown).toMatch(/^## Alice Liddell @alice\n\n\[2025-11-07 01:02 UTC\]\(https:\/\/x\.com\/alice\/status\/222\)\n\n短帖/u)
    expect(draft.markdown).not.toContain('parent')
    expect(draft.qualityScore).toBeGreaterThanOrEqual(40)
    expect(draft.warnings).not.toContain('short_content')
  })

  it('reads a profile page as a list under the page URL', () => {
    const draft = extractPage(page(card('111', 'one') + card('333', 'two'), 'https://x.com/alice'), 'https://x.com/alice', plan({ requestedUrl: 'https://x.com/alice', scope: 'visible', maxItems: 5 }), profile)
    expect(draft.identity).toBe('')
    expect(draft.items.map((item) => item.id)).toEqual(['111', '333'])
    expect(draft.markdown).toMatch(/one[\s\S]*two/u)
  })

  it('fails a page that lacks the linked post, so the cloud can try a browser', () => {
    expect(() => extractPage(page(card('111')), 'https://x.com/alice/status/222', plan({ requestedUrl: 'https://x.com/alice/status/222' }), profile))
      .toThrow(expect.objectContaining({ code: 'TARGET_NOT_FOUND' }))
  })

  // A page saved from x.com over plain HTTP; not committed (third-party content). Run with
  // X_REAL_PAGE=/path/to/page.html X_REAL_URL=https://x.com/<handle>/status/<id> npx vitest run tests/unit/x.test.ts
  const real = process.env.X_REAL_PAGE
  it.skipIf(!real || !existsSync(real))('reads a real anonymous page', () => {
    const url = process.env.X_REAL_URL!
    const draft = extractPage(dom(readFileSync(real!, 'utf8'), url), url, plan({ requestedUrl: url }), profile)
    expect(draft.identity).toBe(`x:status:${statusIdentity(url)!.id}`)
    expect((draft.items[0] as { text: string }).text.length).toBeGreaterThan(0)
    console.log(JSON.stringify({ title: draft.title, item: draft.items[0], markdown: draft.markdown.slice(0, 600) }, null, 2))
  })
})
