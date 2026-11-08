import type { Browser, BrowserContext, Page, Route } from 'playwright'
import type { AgentReply, CrawlJob, CrawlPlan, Transport } from '@/core/contract'
import { CrawlError } from '@/core/errors'
import { checkUrl, type UrlPolicy } from '@/core/url-policy'
import type { AgentMethod, LoadState, PageDriver, PageHandle } from '@/engine/driver'
import type { SiteProfile } from '@/sites/types'
import { fetchPage } from './http-fetch'

/**
 * The cloud executor's PageDriver. Every page gets a fresh browser context: no cookies, no
 * storage, nothing signed in. Two routes:
 *
 *   http     one plain request (http-fetch.ts), shown to Chromium with page scripts forbidden by
 *            CSP and subresources other than stylesheets refused: the page as a crawler sees it
 *   browser  a live navigation, scripts and all
 *
 * Either way the page agent (the same agent.js the extension injects) runs in an isolated world
 * created over the DevTools protocol, so page scripts cannot see or tamper with it.
 */
export interface PlaywrightDriverOptions {
  browser: () => Promise<Browser>
  agentSource: string
  policy: UrlPolicy
  /** Used for both routes; a headless browser announcing itself is refused by many sites. */
  userAgent: string
  httpUserAgent: string
  /** Test hook: extra Chromium context options. */
  contextOptions?: Parameters<Browser['newContext']>[0]
}

const NAVIGATION_TIMEOUT_MS = 30_000
const STATIC_CSP = "script-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'"
const READABLE = /^(?:text\/html|application\/xhtml\+xml|text\/plain)$/u
const WORLD = 'anyworkflow-crawler'

export function transportRoutes(job: CrawlJob, profile: SiteProfile | null): readonly string[] {
  // Waiting for an element or scrolling needs a live page.
  const live = Boolean(job.options.waitFor || job.options.scroll)
  const transport: Transport = job.options.transport ?? profile?.transport ?? 'browser'
  if (transport === 'http' && !live) return ['http']
  if (transport === 'auto' && !live) return ['http', 'browser']
  return ['browser']
}

type Decision = 'continue' | 'abort' | 'handled'

/** Requests the page makes are checked like the job URL: no local or private addresses. */
async function guard(context: BrowserContext, policy: UrlPolicy, decide: (route: Route) => Promise<Decision>): Promise<void> {
  await context.route('**/*', async (route) => {
    const url = route.request().url()
    if (!url.startsWith('data:') && !url.startsWith('blob:') && !checkUrl(url, policy).ok) return route.abort('blockedbyclient')
    const decision = await decide(route)
    if (decision === 'continue') return route.continue()
    if (decision === 'abort') return route.abort('blockedbyclient')
  })
}

/** The main document's status, from the navigation the page itself made. */
function waitForLoad(page: Page, timeoutMs: number): Promise<LoadState> {
  if (timeoutMs <= 0) return Promise.resolve('timeout')
  return page.waitForLoadState('load', { timeout: timeoutMs }).then(() => 'complete' as const, () => 'timeout' as const)
}

function classifyNavigation(error: unknown): CrawlError {
  const message = error instanceof Error ? error.message : String(error)
  if (/ERR_BLOCKED_BY_CLIENT/u.test(message)) return new CrawlError('URL_BLOCKED', '页面跳转到了不允许的地址', { cause: error })
  if (/Timeout/u.test(message)) return new CrawlError('TIMEOUT', '页面打开超时', { cause: error })
  if (/ERR_ABORTED/u.test(message)) return new CrawlError('UNSUPPORTED_CONTENT', undefined, { cause: error })
  return new CrawlError('NAVIGATION_FAILED', undefined, { cause: error })
}

/**
 * Calls the agent in a fresh isolated world of the page's main frame. The agent is stateless
 * between calls, so loading it each time also covers a navigation between prepare and extract.
 */
async function callAgent<T>(page: Page, source: string, method: AgentMethod, plan: CrawlPlan): Promise<T> {
  const session = await page.context().newCDPSession(page)
  try {
    const { frameTree } = await session.send('Page.getFrameTree')
    const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD })
    const loaded = await session.send('Runtime.evaluate', { expression: `${source}\n;void 0`, contextId: executionContextId })
    if (loaded.exceptionDetails) throw new CrawlError('INTERNAL', '页面解析程序加载失败')
    const reply = await session.send('Runtime.evaluate', {
      expression: `globalThis.__awCrawler.${method}(${JSON.stringify(plan)})`,
      contextId: executionContextId,
      awaitPromise: true,
      returnByValue: true,
    })
    if (reply.exceptionDetails) throw new CrawlError('INTERNAL', '页面解析程序出错')
    const value = reply.result.value as AgentReply<T> | undefined
    if (!value) throw new CrawlError('PAGE_GONE')
    if (!value.ok) throw new CrawlError(value.code, value.message)
    return value.value
  } catch (error) {
    if (error instanceof CrawlError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (/Target closed|Session closed|has been closed|context was destroyed|Cannot find context/iu.test(message)) {
      throw new CrawlError('PAGE_GONE', undefined, { cause: error })
    }
    throw new CrawlError('INTERNAL', message, { cause: error })
  } finally {
    await session.detach().catch(() => {})
  }
}

export function createPlaywrightDriver(options: PlaywrightDriverOptions): PageDriver {
  const { policy } = options

  async function newPage(): Promise<{ context: BrowserContext; page: Page }> {
    const browser = await options.browser()
    const context = await browser.newContext({
      userAgent: options.userAgent,
      locale: 'zh-CN',
      viewport: { width: 1280, height: 900 },
      serviceWorkers: 'block',
      acceptDownloads: false,
      ...options.contextOptions,
    })
    return { context, page: await context.newPage() }
  }

  function handle(context: BrowserContext, page: Page, navigation: Promise<unknown>): PageHandle {
    let failed: CrawlError | null = null
    const navigated = navigation.catch((error: unknown) => {
      failed = classifyNavigation(error)
    })
    return {
      async loaded(timeoutMs) {
        await Promise.race([navigated, new Promise((resolve) => setTimeout(resolve, timeoutMs))])
        if (failed) throw failed
        return waitForLoad(page, Math.max(0, timeoutMs))
      },
      url: async () => {
        if (page.isClosed()) throw new CrawlError('PAGE_GONE')
        return page.url()
      },
      call: (method, plan) => callAgent(page, options.agentSource, method, plan),
      close: () => context.close(),
    }
  }

  async function openLive(url: string): Promise<PageHandle> {
    const { context, page } = await newPage()
    await guard(context, policy, async () => 'continue')
    return handle(context, page, page.goto(url, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS }))
  }

  async function openStatic(url: string): Promise<PageHandle> {
    const fetched = await fetchPage(url, { policy, userAgent: options.httpUserAgent, timeoutMs: NAVIGATION_TIMEOUT_MS })
    if (fetched.status === 404 || fetched.status === 410) throw new CrawlError('NOT_FOUND')
    if (fetched.status === 429 || fetched.status >= 500) throw new CrawlError('HTTP_ERROR', `服务器返回 ${fetched.status}`)
    if (fetched.contentType === 'application/pdf') throw new CrawlError('UNSUPPORTED_CONTENT', 'PDF 请使用文件转换')
    if (fetched.contentType && !READABLE.test(fetched.contentType)) throw new CrawlError('UNSUPPORTED_CONTENT')
    const { context, page } = await newPage()
    await guard(context, policy, async (route) => {
      const request = route.request()
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && request.url() === fetched.url) {
        await route.fulfill({
          status: fetched.status,
          headers: { 'content-type': fetched.contentType || 'text/html', 'content-security-policy': STATIC_CSP },
          body: fetched.body,
        })
        return 'handled'
      }
      // Stylesheets keep visibility honest; nothing else is needed to read a static page.
      return request.resourceType() === 'stylesheet' ? 'continue' : 'abort'
    })
    return handle(context, page, page.goto(fetched.url, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS }))
  }

  return {
    routes: transportRoutes,
    open: (url, route) => (route === 'http' ? openStatic(url) : openLive(url)),
  }
}
