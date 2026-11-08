import type { CrawlItem } from '@/core/contract'
import { CrawlError } from '@/core/errors'
import { defineSite, type SiteContext, type SiteFields } from './types'

/**
 * X (Twitter) posts. Reads only identified cards and never substitutes a neighbouring post: a
 * link to a reply returns that reply even when the page shows its parent first.
 *
 * Two layouts reach this profile. Signed in (the browser executor), X renders its app with
 * `article[data-testid="tweet"]`. Anonymous HTTP (the cloud executor) gets a static layout whose
 * cards carry `[data-post-avatar]`. Both are read by the same rules, which were ported from the
 * Python crawler this project replaced. See docs/site-profiles.md for how each was verified.
 */
export const X_HOSTS = ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']
// `/i/` is X's own namespace, so it is tried first: it is not a user called `i`.
const STATUS_PATH = /^\/(?:i\/(?:web\/)?status|([A-Za-z0-9_]{1,15})\/status)\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/u
const QUOTE_SELECTOR = 'article, [data-testid="quoteTweet"], [data-slot="embedded-tweet-frame"], [data-testid="card.wrapper"]'
const TEXT_SELECTOR = '[data-testid="tweetText"], div[dir="auto"].whitespace-pre-wrap'
// The engagement bar's label, in English or Chinese (X follows the reader's language).
const METRIC = /([\d,]+)\s*(repl(?:y|ies)|reposts?|likes?|bookmarks?|views?|回复|转帖|转推|点赞|喜欢|书签|次观看|观看)/giu
const METRIC_KEYS: Record<string, string> = {
  reply: 'replies', replies: 'replies', 回复: 'replies',
  repost: 'reposts', reposts: 'reposts', 转帖: 'reposts', 转推: 'reposts',
  like: 'likes', likes: 'likes', 点赞: 'likes', 喜欢: 'likes',
  bookmark: 'bookmarks', bookmarks: 'bookmarks', 书签: 'bookmarks',
  view: 'views', views: 'views', 次观看: 'views', 观看: 'views',
}
const EPOCH = /"timestamp"\s*:\s*(\d{10,16})/u

export interface StatusIdentity {
  id: string
  handle: string | null
  url: string
}

/** The post a link names, or null. Tracking parameters, `/photo/N` and `/i/web/status/` all count. */
export function statusIdentity(raw: string): StatusIdentity | null {
  let url: URL
  try {
    url = new URL(raw, 'https://x.com')
  } catch {
    return null
  }
  if (!X_HOSTS.includes(url.hostname) || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null
  const match = STATUS_PATH.exec(url.pathname)
  if (!match) return null
  const [, handle, id] = match as unknown as [string, string | undefined, string]
  return {
    id,
    handle: handle ? `@${handle}` : null,
    url: handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`,
  }
}

export interface XPost extends CrawlItem {
  id: string
  url: string
  handle: string | null
  author: string
  text: string
  postedAt: string | null
  postedAtText: string
  images: string[]
  videos: { url: string | null; poster: string | null; sources: string[] }[]
  hasVideo: boolean
  quotedUrls: string[]
  isReply: true | null
  replyToStatusId: string | null
  metrics?: Record<string, number>
  relation?: 'target' | 'visible'
}

/** Text as written: real whitespace, line breaks and emoji alt text, without hidden helpers. */
function postText(node: Element): string {
  const copy = node.cloneNode(true) as Element
  for (const element of copy.querySelectorAll('script, style, [aria-hidden="true"]')) element.remove()
  for (const element of copy.querySelectorAll('br')) element.replaceWith('\n')
  for (const element of copy.querySelectorAll('img[alt]')) element.replaceWith(element.getAttribute('alt') ?? '')
  return (copy.textContent ?? '').replace(/\r\n/gu, '\n').trim()
}

function squeeze(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim()
}

function hostOf(src: string): URL | null {
  try {
    return new URL(src)
  } catch {
    return null
  }
}

/** The anonymous layout keeps an exact epoch for its date formatter in an inline script. */
function postedAt(card: Element, link: Element, time: Element | null): string | null {
  const datetime = time?.getAttribute('datetime')
  if (datetime) return datetime
  const id = link.getAttribute('id')
  if (!id) return null
  for (const script of card.querySelectorAll('script')) {
    const raw = script.textContent ?? ''
    if (!raw.includes(`"${id}"`)) continue
    const epoch = EPOCH.exec(raw)?.[1]
    if (!epoch) continue
    const date = new Date(Number(epoch))
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return null
}

function metricsOf(card: Element): Record<string, number> | undefined {
  const label = card.querySelector('[role="group"][aria-label]')?.getAttribute('aria-label')
  if (!label) return undefined
  const metrics: Record<string, number> = {}
  for (const [, number, name] of label.matchAll(METRIC)) {
    const key = METRIC_KEYS[name!.toLowerCase()]
    if (key) metrics[key] = Number(number!.replace(/,/gu, ''))
  }
  return Object.keys(metrics).length ? metrics : undefined
}

function handleOf(href: string): string | null {
  try {
    return `@${new URL(href, 'https://x.com').pathname.replace(/^\/+|\/+$/gu, '')}`.toLowerCase()
  } catch {
    return null
  }
}

/** The card's own status link: its timestamp's, or in the anonymous layout a tooltip trigger. */
function statusLink(card: Element, avatar: Element | null, time: Element | null): Element | null {
  const timed = time?.closest('a[href]')
  if (timed && card.contains(timed)) return timed
  const avatarHandle = avatar ? handleOf(avatar.getAttribute('href') ?? '') : null
  for (const candidate of card.querySelectorAll('a[data-base-ui-tooltip-trigger][href]')) {
    const identity = statusIdentity(candidate.getAttribute('href') ?? '')
    if (!identity || (candidate.textContent ?? '').toLowerCase().includes('view')) continue
    if (avatarHandle && identity.handle && identity.handle.toLowerCase() !== avatarHandle) continue
    return candidate
  }
  return null
}

function readCard(original: Element): XPost | null {
  // Embedded posts go first, so identity, author, media and text all come from the card itself.
  const card = original.cloneNode(true) as Element
  const quotes: string[] = []
  for (const embedded of [...card.querySelectorAll(QUOTE_SELECTOR)]) {
    if (!card.contains(embedded)) continue
    let quote = statusIdentity(embedded.getAttribute('data-href') ?? '')
    if (!quote) {
      for (const anchor of embedded.querySelectorAll('a[href]')) {
        quote = statusIdentity(anchor.getAttribute('href') ?? '')
        if (quote) break
      }
    }
    if (quote) quotes.push(quote.url)
    embedded.remove()
  }

  const avatar = card.querySelector('[data-post-avatar] a[href]')
  if (card.getAttribute('data-testid') !== 'tweet' && !avatar) return null
  const time = card.querySelector('time[datetime]')
  const link = statusLink(card, avatar, time)
  const identity = link ? statusIdentity(link.getAttribute('href') ?? '') : null
  if (!link || !identity) return null

  const textNode = card.querySelector(TEXT_SELECTOR)
  const images = [...new Set([...card.querySelectorAll('img[src]')].map((image) => image.getAttribute('src') ?? '').filter((src) => {
    const url = hostOf(src)
    return url?.hostname === 'pbs.twimg.com' && url.pathname.startsWith('/media/')
  }))]
  const videos = [...card.querySelectorAll('video')].map((video) => ({
    url: video.getAttribute('src'),
    poster: video.getAttribute('poster'),
    sources: [...video.querySelectorAll('source[src]')].map((source) => source.getAttribute('src') ?? ''),
  }))
  const hasVideo = videos.length > 0 || Boolean(card.querySelector('[data-testid="videoPlayer"]'))
  if (!textNode && !images.length && !hasVideo && !quotes.length) return null

  let author: Element | null = card.querySelector('[data-testid="User-Name"]')
  if (!author && avatar) {
    const href = avatar.getAttribute('href')
    author = [...card.querySelectorAll('a[href]')].find((anchor) => {
      const label = squeeze(anchor.textContent)
      return anchor.getAttribute('href') === href && label && !label.startsWith('@')
    }) ?? null
  }
  const replyMarker = card.querySelector('[data-testid="replyingTo"], [data-reply-to-status-id]')
  const replyTo = card.getAttribute('data-reply-to-status-id') || replyMarker?.getAttribute('data-reply-to-status-id') || null
  const metrics = metricsOf(card)
  return {
    ...identity,
    author: author ? squeeze(author.textContent) : (identity.handle ?? ''),
    text: textNode ? postText(textNode) : '',
    postedAt: postedAt(card, link, time),
    postedAtText: squeeze(link.textContent),
    images,
    videos,
    hasVideo,
    quotedUrls: [...new Set(quotes)],
    isReply: replyMarker || replyTo ? true : null,
    replyToStatusId: replyTo,
    ...(metrics ? { metrics } : {}),
  }
}

/** Every identified top-level card on the page, once each; a repeated id keeps its longer text. */
export function readPosts(doc: Document): XPost[] {
  const posts: XPost[] = []
  const seen = new Map<string, number>()
  for (const article of doc.querySelectorAll('article')) {
    if (article.parentElement?.closest('article, [data-slot="embedded-tweet-frame"]')) continue
    const post = readCard(article)
    if (!post) continue
    const index = seen.get(post.id)
    if (index !== undefined) {
      if (post.text.length > posts[index]!.text.length) posts[index] = post
      continue
    }
    seen.set(post.id, posts.length)
    posts.push(post)
  }
  return posts
}

/**
 * The posts a job asked for. All cards are read before the limit applies: the requested reply
 * may follow its parent. Without a match the job fails rather than return a neighbour.
 */
export function selectPosts(posts: readonly XPost[], requestedUrl: string, scope: 'target' | 'visible', maxItems: number): { posts: XPost[]; target: XPost | null } {
  const identity = statusIdentity(requestedUrl)
  const target = identity ? posts.find((post) => post.id === identity.id) ?? null : null
  if (identity && !target) throw new CrawlError('TARGET_NOT_FOUND', '页面上没有找到链接指向的帖子，可能需要登录、已删除或页面结构有变化')
  if (scope === 'target') {
    if (!target) throw new CrawlError('STEP_FAILED', 'X 主页需要把读取范围设为「页面上的帖子」')
    return { posts: [{ ...target, relation: 'target' }], target }
  }
  const ordered = target ? [target, ...posts.filter((post) => post !== target)] : [...posts]
  const selected = ordered.slice(0, maxItems).map((post): XPost => ({ ...post, relation: post === target ? 'target' : 'visible' }))
  if (!selected.length) throw new CrawlError('EMPTY_CONTENT', '页面上没有可读取的公开帖子')
  return { posts: selected, target }
}

function escape(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
}

/**
 * Plain markup for the shared pipeline, which turns it into Markdown like any other page. Each
 * post is headed by its author at level 2: the converter keeps the page title for level 1.
 */
function postHtml(post: XPost): string {
  const who = [post.author, post.handle && post.author !== post.handle ? post.handle : ''].filter(Boolean).join(' ')
  const when = post.postedAt ? new Date(post.postedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : post.postedAtText
  const paragraphs = post.text.split(/\n{2,}/u).map((part) => `<p>${escape(part).replace(/\n/gu, '<br>')}</p>`).join('')
  const media = [
    ...post.images.map((src) => `<p><img src="${escape(src)}" alt=""></p>`),
    ...post.videos.flatMap((video) => (video.url ?? video.sources[0]) ? [`<p><a href="${escape((video.url ?? video.sources[0])!)}">视频</a></p>`] : []),
    ...post.quotedUrls.map((url) => `<blockquote><p>引用 <a href="${escape(url)}">${escape(url)}</a></p></blockquote>`),
  ].join('')
  return `<section><h2>${escape(who)}</h2><p><a href="${escape(post.url)}">${escape(when || post.url)}</a></p>${paragraphs}${media}</section>`
}

function readX(context: SiteContext): SiteFields | null {
  const { posts, target } = selectPosts(readPosts(context.document), context.requestedUrl.href, context.scope, context.maxItems)
  const lead = target ?? posts[0]!
  const single = context.scope === 'target'
  const summary = squeeze(lead.text).slice(0, 80)
  return {
    complete: true,
    identity: single ? `x:status:${lead.id}` : '',
    title: single ? `${lead.author}${summary ? `：${summary}` : ''}` : `${lead.handle ?? lead.author} 的帖子`,
    byline: single ? lead.author : '',
    publishedAt: single ? (lead.postedAt ?? '') : '',
    siteName: 'X',
    html: `<article>${posts.map(postHtml).join('<hr>')}</article>`,
    items: posts,
    extras: { coverage: 'visible_only', targetStatusId: statusIdentity(context.requestedUrl.href)?.id ?? null },
  }
}

export const x = defineSite({
  id: 'x',
  version: 1,
  hosts: X_HOSTS,
  // Anonymous X answers plain HTTP with readable cards; its app needs a login to show them.
  transport: 'auto',
  prepare: [{ op: 'wait', selector: 'article', timeoutMs: 15_000, optional: true }],
  extract: readX,
})
