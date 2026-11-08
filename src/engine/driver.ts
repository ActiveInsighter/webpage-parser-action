import type { CrawlJob, CrawlPlan } from '@/core/contract'
import type { PageAgent } from '@/page/agent'
import type { SiteProfile } from '@/sites/types'

/**
 * The port each executor implements: how to open a page and talk to the page agent in it. The
 * extension opens a tab in the owner's browser; the cloud opens a Playwright page, live or from
 * a plain HTTP response. Everything above this line (plan, lease, result) is shared.
 */
export type AgentMethod = keyof PageAgent
export type LoadState = 'complete' | 'timeout'

export interface PageHandle {
  loaded(timeoutMs: number): Promise<LoadState>
  /** Where the page is now, after redirects. */
  url(): Promise<string>
  /** Runs an agent method in the page, loading the agent first when it is missing. */
  call<T>(method: AgentMethod, plan: CrawlPlan): Promise<T>
  close(): Promise<void>
}

export interface PageDriver {
  /**
   * The ways this driver can open a job's page, tried in order while a failure says the next
   * may do better (`nextRoute` in ERROR_CODES). One entry for a driver with one way.
   */
  routes(job: CrawlJob, profile: SiteProfile | null): readonly string[]
  open(url: string, route: string): Promise<PageHandle>
}
