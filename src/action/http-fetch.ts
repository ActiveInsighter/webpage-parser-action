import { CrawlError } from '@/core/errors'
import { checkUrl, type UrlPolicy } from '@/core/url-policy'

/**
 * The cloud executor's plain HTTP read: one fresh anonymous request, no cookies, a bounded body.
 * Redirects are followed by hand so every hop passes the URL policy: an automatic redirect could
 * otherwise reach the runner's own metadata service.
 */
export interface FetchedPage {
  url: string
  status: number
  contentType: string
  body: Buffer
}

const MAX_BYTES = 20 * 1024 * 1024
const MAX_REDIRECTS = 5
const TRANSIENT = new Set([429, 500, 502, 503, 504])

async function readBounded(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (declared > MAX_BYTES) throw new CrawlError('UNSUPPORTED_CONTENT', '页面超过 20 MB')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > MAX_BYTES) throw new CrawlError('UNSUPPORTED_CONTENT', '页面超过 20 MB')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export interface FetchOptions {
  policy: UrlPolicy
  userAgent: string
  timeoutMs: number
  retries?: number
  fetchImpl?: typeof fetch
}

export async function fetchPage(rawUrl: string, options: FetchOptions): Promise<FetchedPage> {
  const fetchImpl = options.fetchImpl ?? fetch
  const retries = options.retries ?? 2
  for (let attempt = 0; ; attempt += 1) {
    let url = rawUrl
    try {
      for (let hop = 0; ; hop += 1) {
        const verdict = checkUrl(url, options.policy)
        if (!verdict.ok) throw new CrawlError('URL_BLOCKED', verdict.reason)
        const response = await fetchImpl(verdict.url, {
          redirect: 'manual',
          headers: { 'User-Agent': options.userAgent, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
          signal: AbortSignal.timeout(options.timeoutMs),
        })
        const location = response.headers.get('location')
        if (response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel()
          if (hop >= MAX_REDIRECTS) throw new CrawlError('NAVIGATION_FAILED', '跳转次数过多')
          url = new URL(location, verdict.url).href
          continue
        }
        if (TRANSIENT.has(response.status) && attempt < retries) {
          await response.body?.cancel()
          throw Object.assign(new Error('transient'), { transient: true })
        }
        return {
          url: verdict.url,
          status: response.status,
          contentType: (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase(),
          body: await readBounded(response),
        }
      }
    } catch (error) {
      if (error instanceof CrawlError) throw error
      if (attempt >= retries) throw new CrawlError('NAVIGATION_FAILED', '匿名 HTTP 请求失败', { cause: error })
      await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt * 1000, 8000)))
    }
  }
}
