import type { CrawlJob, CrawlPlan, Step } from '@/core/contract'
import { TIMING } from '@/core/limits'
import type { SiteProfile } from '@/sites/types'

const WAIT_FOR_MS = 15_000
/** An app shell ("Loading…") has less text than this; a real page rarely does. */
const FIRST_CONTENT_CHARS = 200
/** Entries kept from a listing page when the job does not say. */
const DEFAULT_VISIBLE_ITEMS = 20

export function jobTimeoutMs(job: CrawlJob, profile: SiteProfile | null): number {
  const seconds = job.options.timeoutSeconds ?? profile?.timeoutSeconds
  return seconds ? seconds * 1000 : TIMING.jobTimeoutMs
}

/**
 * Merges the defaults, the site profile and the job's overrides into one plan. Order matters:
 * site preparation first, then what the user asked for, then removals on the finished page.
 */
export function buildPlan(job: CrawlJob, profile: SiteProfile | null, requestedUrl: string, deadline: number): CrawlPlan {
  const { options } = job
  const steps: Step[] = [{ op: 'settle', quietMs: 500, timeoutMs: 6_000, minChars: FIRST_CONTENT_CHARS }, ...(profile?.prepare ?? [])]
  if (options.waitFor) steps.push({ op: 'wait', selector: options.waitFor, timeoutMs: WAIT_FOR_MS })
  if (options.scroll) steps.push({ op: 'scroll' }, { op: 'settle', quietMs: 500, timeoutMs: 3_000 })
  for (const selector of [...(profile?.content?.clean ?? []), ...(options.removeSelectors ?? [])]) {
    steps.push({ op: 'remove', selector })
  }
  const scope = options.scope ?? 'target'
  return {
    steps,
    contentSelector: options.contentSelector,
    keepHtml: options.keepHtml ?? false,
    generic: options.generic ?? false,
    deadline,
    requestedUrl,
    scope,
    maxItems: scope === 'target' ? 1 : (options.maxItems ?? DEFAULT_VISIBLE_ITEMS),
  }
}
