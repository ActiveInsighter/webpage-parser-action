import { WARNINGS, type CrawlJob, type CrawlPlan, type CrawlResult, type Runner } from '@/core/contract'
import { CrawlError, ERROR_CODES, toCrawlError } from '@/core/errors'
import { TIMING } from '@/core/limits'
import { checkUrl, type UrlPolicy } from '@/core/url-policy'
import type { PageDraft } from '@/page/extract/pipeline'
import type { StepOutcome } from '@/page/steps'
import { sites } from '@/sites'
import { findProfile } from '@/sites/registry'
import type { SiteProfile } from '@/sites/types'
import type { CrawlApi } from './api'
import type { PageDriver, PageHandle } from './driver'
import type { HostGate } from './host-gate'
import { keepLease, type Lease } from './lease'
import { buildPlan, jobTimeoutMs } from './plan'

export interface RunnerDeps {
  api: CrawlApi
  driver: PageDriver
  gate: HostGate
  /** Read per job, so a host the owner blocks applies from the next job on. */
  policy(): Promise<UrlPolicy>
  runner: Runner
  version: string
  log?(event: string, detail: Record<string, unknown>): void
}

export interface ClaimedJob {
  job: CrawlJob
  leaseId: string
}

/** Rejects as soon as the signal aborts, so a cancel does not wait for a slow page. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assertAllowed(url: string, policy: UrlPolicy): { url: string; host: string } {
  const verdict = checkUrl(url, policy)
  if (!verdict.ok) throw new CrawlError('URL_BLOCKED', verdict.reason)
  return verdict
}

interface Attempt {
  job: CrawlJob
  route: string
  requested: { url: string; host: string }
  policy: UrlPolicy
  deadline: number
  lease: Lease
  signal: AbortSignal
  mark(phase: string): void
}

interface AttemptResult {
  draft: PageDraft
  prepared: StepOutcome
  loadTimedOut: boolean
}

/** One way of opening the page, from open to extracted draft. The page is always closed. */
async function attempt(deps: RunnerDeps, run: Attempt): Promise<AttemptResult> {
  const { job, signal, policy, deadline, lease } = run
  let page: PageHandle | null = null
  try {
    await lease.report('opening')
    signal.throwIfAborted()
    // Not raced against the signal: the handle must be kept, or a cancel here leaks the page.
    page = await deps.driver.open(run.requested.url, run.route)
    signal.throwIfAborted()
    const load = await abortable(page.loaded(Math.min(TIMING.loadTimeoutMs, deadline - Date.now())), signal)
    run.mark(`${run.route}.loaded`)

    // Short links and redirects end somewhere else: judge and tune for where the page landed.
    const landed = assertAllowed(await page.url(), policy)
    const profile = job.options.generic ? null : findProfile(sites, landed.url)
    const plan: CrawlPlan = buildPlan(job, profile, run.requested.url, deadline)

    await lease.report('rendering')
    const prepared = await abortable(page.call<StepOutcome>('prepare', plan), signal)
    run.mark(`${run.route}.prepared`)

    await lease.report('extracting')
    const draft = await abortable(page.call<PageDraft>('extract', plan), signal)
    run.mark(`${run.route}.extracted`)
    assertAllowed(draft.url, policy)
    return { draft, prepared, loadTimedOut: load === 'timeout' }
  } finally {
    await page?.close().catch(() => {})
  }
}

/** One job from claim to report. Every path ends with its pages closed and the lease released. */
export function createRunner(deps: RunnerDeps) {
  return async function run({ job, leaseId }: ClaimedJob): Promise<void> {
    const started = Date.now()
    const phases: Record<string, number> = {}
    const mark = (phase: string) => {
      phases[phase] = Date.now() - started
    }
    const controller = new AbortController()
    let leaseLost = false
    const lease = keepLease(deps.api, job.id, leaseId, {
      onCancel: () => controller.abort(new CrawlError('CANCELED')),
      onLost: () => {
        leaseLost = true
        controller.abort(new CrawlError('CANCELED', '租约已被回收'))
      },
    })
    const signal = controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      if (job.runner !== deps.runner) throw new CrawlError('URL_BLOCKED', '任务不属于这个执行端')
      const policy = await deps.policy()
      const requested = assertAllowed(job.url, policy)
      const requestedProfile: SiteProfile | null = job.options.generic ? null : findProfile(sites, requested.url)
      const deadline = started + jobTimeoutMs(job, requestedProfile)
      timer = setTimeout(() => controller.abort(new CrawlError('TIMEOUT')), deadline - started)

      await abortable(delay(deps.gate.reserve(requested.host)), signal)
      const routes = deps.driver.routes(job, requestedProfile)
      const fellBack: string[] = []
      let outcome: AttemptResult | null = null
      let route = routes[0] ?? ''
      for (const [index, candidate] of routes.entries()) {
        route = candidate
        try {
          outcome = await attempt(deps, { job, route, requested, policy, deadline, lease, signal, mark })
          break
        } catch (error) {
          const failure = toCrawlError(signal.aborted ? signal.reason : error)
          if (signal.aborted || index === routes.length - 1 || !ERROR_CODES[failure.code].nextRoute) throw failure
          fellBack.push(`${candidate}: ${failure.code}`)
          deps.log?.('crawl.route-fell-back', { job: job.id, route: candidate, code: failure.code })
        }
      }
      if (!outcome) throw new CrawlError('INTERNAL', '没有可用的打开方式')

      await lease.report('uploading')
      const { draft, prepared, loadTimedOut } = outcome
      const warnings = [...new Set([
        ...draft.warnings,
        ...prepared.warnings,
        ...(loadTimedOut ? [WARNINGS.loadTimeout] : []),
        ...(fellBack.length ? [WARNINGS.routeFellBack] : []),
      ])]
      const result: CrawlResult = {
        ...draft,
        warnings,
        trace: { phases, steps: [...fellBack.map((line) => `fell back from ${line}`), ...prepared.log], route, runner: deps.runner },
        crawlerVersion: deps.version,
      }
      const reply = await deps.api.complete(job.id, leaseId, result)
      deps.log?.('crawl.done', { job: job.id, status: reply.status, route, extractor: result.extractor, score: result.qualityScore, changed: reply.changed })
    } catch (error) {
      const failure = toCrawlError(signal.aborted ? signal.reason : error)
      deps.log?.('crawl.failed', { job: job.id, code: failure.code, message: failure.message })
      // A lost lease means the job already belongs to someone else: nothing to report.
      if (!leaseLost) {
        await deps.api.fail(job.id, leaseId, { code: failure.code, message: failure.message }).catch((cause: unknown) => {
          deps.log?.('crawl.report-failed', { job: job.id, cause: String(cause) })
        })
      }
    } finally {
      clearTimeout(timer)
      lease.stop()
    }
  }
}
