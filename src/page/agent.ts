import { agentFailure, type AgentReply, type CrawlPlan } from '@/core/contract'
import { CrawlError, toCrawlError } from '@/core/errors'
import { sites } from '@/sites'
import { findProfile } from '@/sites/registry'
import { detectBlocker } from './blockers'
import { extractPage, type PageDraft } from './extract/pipeline'
import { runSteps, type StepOutcome } from './steps'

/**
 * Injected into the page's isolated world, so the page cannot see or call any of this. The
 * background drives it in two calls, and each returns a plain AgentReply: a thrown error would
 * lose its code on the way through executeScript.
 */
export interface PageAgent {
  prepare(plan: CrawlPlan): Promise<AgentReply<StepOutcome>>
  extract(plan: CrawlPlan): Promise<AgentReply<PageDraft>>
}

function profileFor(plan: CrawlPlan) {
  return plan.generic ? null : findProfile(sites, location.href)
}

async function reply<T>(work: () => T | Promise<T>): Promise<AgentReply<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    const failure = toCrawlError(error)
    return agentFailure(failure.code, failure.message)
  }
}

/** The main document's HTTP status, or 0 where the browser does not report one. */
function httpStatus(): number {
  const [navigation] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
  return navigation?.responseStatus ?? 0
}

const READABLE_TYPE = /^(?:text\/html|application\/xhtml\+xml|text\/plain)$/u

/** A status says what went wrong before the body does: a refusal often arrives as JSON. */
function assertOpen(plan: CrawlPlan): void {
  const status = httpStatus()
  if (status === 404 || status === 410) throw new CrawlError('NOT_FOUND')
  if (status === 429 || status >= 500) throw new CrawlError('HTTP_ERROR', `服务器返回 ${status}`)
  const readable = READABLE_TYPE.test(document.contentType)
  if ((status === 401 || status === 403) && !readable) throw new CrawlError('ACCESS_DENIED')
  if (document.contentType === 'application/pdf') throw new CrawlError('UNSUPPORTED_CONTENT', 'PDF 请使用文件转换')
  if (!readable) throw new CrawlError('UNSUPPORTED_CONTENT')
  const blocker = detectBlocker(document, location.href, plan.requestedUrl, profileFor(plan), status)
  if (blocker) throw blocker
}

const agent: PageAgent = {
  prepare: (plan) =>
    reply(async () => {
      assertOpen(plan)
      return runSteps(plan.steps, plan.deadline)
    }),
  extract: (plan) =>
    reply(() => {
      assertOpen(plan)
      if (Date.now() > plan.deadline) throw new CrawlError('TIMEOUT')
      return extractPage(document, location.href, plan, profileFor(plan), httpStatus())
    }),
}

;(globalThis as unknown as { __awCrawler: PageAgent }).__awCrawler = agent
