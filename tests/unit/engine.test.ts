import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transportRoutes } from '@/action/playwright-driver'
import { crawlJobSchema, type CrawlJob, type CrawlPlan } from '@/core/contract'
import { CrawlError } from '@/core/errors'
import type { CrawlApi, RenewReply } from '@/engine/api'
import type { AgentMethod, LoadState, PageHandle } from '@/engine/driver'
import { createHostGate } from '@/engine/host-gate'
import { buildPlan, jobTimeoutMs } from '@/engine/plan'
import { createRunner, type RunnerDeps } from '@/engine/runner'
import { createScheduler } from '@/engine/scheduler'
import { sites } from '@/sites'
import { findProfile } from '@/sites/registry'
import { defineSite } from '@/sites/types'

type Call = (method: AgentMethod, plan: CrawlPlan, route: string) => Promise<unknown>

const job = (overrides: Partial<CrawlJob> = {}): CrawlJob => ({
  id: 'job1',
  owner: 'owner1',
  url: 'https://example.com/post',
  runner: 'browser',
  category: 'webpage',
  options: {},
  attempts: 0,
  ...overrides,
})

const draft = {
  identity: '',
  url: 'https://example.com/post',
  canonicalUrl: '',
  host: 'example.com',
  title: 't',
  byline: '',
  siteName: '',
  language: '',
  description: '',
  publishedAt: '',
  leadImage: '',
  markdown: '# hello',
  html: '',
  wordCount: 1,
  items: [],
  links: [],
  images: [],
  structuredData: [],
  extras: {},
  extractor: 'defuddle',
  profile: '',
  qualityScore: 80,
  warnings: ['short_content'],
  httpStatus: 200,
}

function harness(options: {
  load?: LoadState
  landedUrl?: string
  call?: Call
  renew?: (jobId: string, leaseId: string, status?: string) => Promise<RenewReply>
  complete?: CrawlApi['complete']
  open?: () => Promise<PageHandle>
  blockedHosts?: string[]
  routes?: string[]
  runner?: RunnerDeps['runner']
} = {}) {
  const closed = vi.fn(async () => {})
  const defaultCall: Call = async (method) => (method === 'prepare' ? { warnings: ['step_skipped'], log: [] } : draft)
  const call = vi.fn(options.call ?? defaultCall)
  const pageFor = (route: string): PageHandle => ({
    loaded: async () => options.load ?? 'complete',
    url: async () => options.landedUrl ?? 'https://example.com/post',
    call: (async (method: AgentMethod, plan: CrawlPlan) => call(method, plan, route)) as PageHandle['call'],
    close: closed,
  })
  const api: CrawlApi = {
    claim: vi.fn(async () => ({ job: null, closed: false })),
    renew: vi.fn(options.renew ?? (async () => ({ accepted: true, cancelRequested: false }))),
    complete: vi.fn(options.complete ?? (async () => ({ status: 'succeeded' as const, document: 'd', changed: true }))),
    fail: vi.fn(async () => {}),
  }
  const open = vi.fn(async (_url: string, route: string) => (options.open ? options.open() : pageFor(route)))
  const deps: RunnerDeps = {
    api,
    driver: { routes: () => options.routes ?? ['live'], open },
    gate: createHostGate(0),
    policy: async () => ({ blockedHosts: options.blockedHosts ?? [] }),
    runner: options.runner ?? 'browser',
    version: '9.9.9',
  }
  return { run: createRunner(deps), api, call, openPage: open, closed }
}

describe('runner', () => {
  it('completes a crawl and closes the page', async () => {
    const { run, api, closed } = harness()
    await run({ job: job(), leaseId: 'lease' })

    expect(api.fail).not.toHaveBeenCalled()
    const [id, lease, result] = vi.mocked(api.complete).mock.calls[0]!
    expect([id, lease]).toEqual(['job1', 'lease'])
    expect(result.warnings).toEqual(['short_content', 'step_skipped'])
    expect(result.crawlerVersion).toBe('9.9.9')
    expect(result.trace).toMatchObject({ route: 'live', runner: 'browser' })
    expect(result.trace.phases).toHaveProperty('live.extracted')
    expect(vi.mocked(api.renew).mock.calls.map((call) => call[2])).toEqual(['opening', 'rendering', 'extracting', 'uploading'])
    expect(closed).toHaveBeenCalledOnce()
  })

  it('tries the next route only when a failure says it may help', async () => {
    const cloud = job({ runner: 'cloud' })
    const call: Call = async (method, _plan, route) => {
      if (route === 'http' && method === 'extract') throw new CrawlError('TARGET_NOT_FOUND')
      return method === 'prepare' ? { warnings: [], log: [] } : draft
    }
    const fallback = harness({ call, routes: ['http', 'browser'], runner: 'cloud' })
    await fallback.run({ job: cloud, leaseId: 'lease' })
    const [, , result] = vi.mocked(fallback.api.complete).mock.calls[0]!
    expect(result.trace.route).toBe('browser')
    expect(result.warnings).toContain('route_fell_back')
    expect(fallback.closed).toHaveBeenCalledTimes(2)

    const walled: Call = async () => {
      throw new CrawlError('CAPTCHA')
    }
    const stopped = harness({ call: walled, routes: ['http', 'browser'], runner: 'cloud' })
    await stopped.run({ job: cloud, leaseId: 'lease' })
    expect(stopped.openPage).toHaveBeenCalledOnce()
    expect(stopped.api.fail).toHaveBeenCalledWith('job1', 'lease', expect.objectContaining({ code: 'CAPTCHA' }))
  })

  it('refuses a job meant for the other executor', async () => {
    const { run, api, openPage } = harness({ runner: 'cloud' })
    await run({ job: job(), leaseId: 'lease' })
    expect(openPage).not.toHaveBeenCalled()
    expect(api.fail).toHaveBeenCalledWith('job1', 'lease', expect.objectContaining({ code: 'URL_BLOCKED' }))
  })

  it('records a slow load as a warning and still captures', async () => {
    const { run, api } = harness({ load: 'timeout' })
    await run({ job: job(), leaseId: 'lease' })
    expect(vi.mocked(api.complete).mock.calls[0]![2].warnings).toContain('load_timeout')
  })

  it('never opens a local target, whatever the row says', async () => {
    const { run, api, openPage } = harness()
    await run({ job: job({ url: 'http://127.0.0.1:40197/json' }), leaseId: 'lease' })
    expect(openPage).not.toHaveBeenCalled()
    expect(api.fail).toHaveBeenCalledWith('job1', 'lease', expect.objectContaining({ code: 'URL_BLOCKED' }))
  })

  it('stops when a redirect lands somewhere forbidden', async () => {
    const { run, api, call, closed } = harness({ landedUrl: 'http://192.168.1.1/admin' })
    await run({ job: job(), leaseId: 'lease' })
    expect(call).not.toHaveBeenCalled()
    expect(api.fail).toHaveBeenCalledWith('job1', 'lease', expect.objectContaining({ code: 'URL_BLOCKED' }))
    expect(closed).toHaveBeenCalledOnce()
  })

  it('applies the user block list', async () => {
    const { run, api, openPage } = harness({ blockedHosts: ['example.com'] })
    await run({ job: job(), leaseId: 'lease' })
    expect(openPage).not.toHaveBeenCalled()
    expect(api.fail).toHaveBeenCalledWith('job1', 'lease', expect.objectContaining({ code: 'URL_BLOCKED' }))
  })

  it('reports agent failures with their code and retry policy', async () => {
    const call: Call = async () => {
      throw new CrawlError('LOGIN_REQUIRED')
    }
    const { run, api, closed } = harness({ call })
    await run({ job: job(), leaseId: 'lease' })
    expect(api.fail).toHaveBeenCalledWith('job1', 'lease', expect.objectContaining({ code: 'LOGIN_REQUIRED' }))
    expect(closed).toHaveBeenCalledOnce()
  })

  it('wraps unexpected errors as retryable', async () => {
    const call: Call = async () => {
      throw new Error('boom')
    }
    const { run, api } = harness({ call })
    await run({ job: job(), leaseId: 'lease' })
    expect(api.fail).toHaveBeenCalledWith('job1', 'lease', { code: 'INTERNAL', message: 'boom' })
  })

  it('reports a failed upload so the job can be retried', async () => {
    const { run, api } = harness({
      complete: async () => {
        throw new Error('network')
      },
    })
    await run({ job: job(), leaseId: 'lease' })
    expect(api.fail).toHaveBeenCalledOnce()
  })

  const hang: Call = () => new Promise(() => {})
  const reply = (accepted: boolean, cancelRequested: boolean) => ({ accepted, cancelRequested })

  it('stops on a cancel from Remote', async () => {
    const renew = async (_id: string, _lease: string, status?: string) => reply(true, status === 'rendering')
    const { run, api, closed } = harness({ call: hang, renew })
    await run({ job: job(), leaseId: 'lease' })
    expect(api.fail).toHaveBeenCalledWith('job1', 'lease', expect.objectContaining({ code: 'CANCELED' }))
    expect(api.complete).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('does not open a page for a job canceled before it starts', async () => {
    const { run, api, openPage } = harness({ renew: async () => reply(true, true) })
    await run({ job: job(), leaseId: 'lease' })
    expect(openPage).not.toHaveBeenCalled()
    expect(api.fail).toHaveBeenCalledWith('job1', 'lease', expect.objectContaining({ code: 'CANCELED' }))
  })

  it('walks away quietly when the lease is lost', async () => {
    const renew = async (_id: string, _lease: string, status?: string) => reply(status !== 'rendering', false)
    const { run, api, closed } = harness({ call: hang, renew })
    await run({ job: job(), leaseId: 'lease' })
    expect(api.fail).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledOnce()
  })

  describe('with fake timers', () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it('closes a page whose opening overlapped a cancel', async () => {
      const closing = vi.fn(async () => {})
      const late: PageHandle = { loaded: async () => 'complete', url: async () => 'https://example.com/post', call: (async () => ({})) as PageHandle['call'], close: closing }
      let renewals = 0
      const { run, api } = harness({
        // The periodic renewal lands while the window is still opening.
        renew: async () => reply(true, ++renewals > 1),
        open: () => new Promise((resolve) => setTimeout(() => resolve(late), 30_000)),
      })
      const running = run({ job: job(), leaseId: 'lease' })
      await vi.advanceTimersByTimeAsync(31_000)
      await running
      expect(closing).toHaveBeenCalledOnce()
      expect(api.fail).toHaveBeenCalledWith('job1', 'lease', expect.objectContaining({ code: 'CANCELED' }))
    })

    it('times out a hung page', async () => {
      const { run, api, closed } = harness({ call: hang })
      const running = run({ job: job({ options: { timeoutSeconds: 10 } }), leaseId: 'lease' })
      await vi.advanceTimersByTimeAsync(11_000)
      await running
      expect(api.fail).toHaveBeenCalledWith('job1', 'lease', expect.objectContaining({ code: 'TIMEOUT' }))
      expect(closed).toHaveBeenCalledOnce()
    })

    it('keeps renewing while a job runs and stops afterwards', async () => {
      let release = () => {}
      const held = new Promise<void>((resolve) => (release = resolve))
      const call: Call = async (method) => {
        await held
        return method === 'prepare' ? { warnings: [], log: [] } : draft
      }
      const { run, api } = harness({ call })
      const running = run({ job: job(), leaseId: 'lease' })
      await vi.advanceTimersByTimeAsync(45_000)
      const during = vi.mocked(api.renew).mock.calls.filter((entry) => entry[2] === undefined).length
      expect(during).toBe(4)
      release()
      await vi.advanceTimersByTimeAsync(0)
      await running
      const settled = vi.mocked(api.renew).mock.calls.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(vi.mocked(api.renew).mock.calls.length).toBe(settled)
    })
  })
})

describe('scheduler', () => {
  function deferred() {
    let resolve = () => {}
    const promise = new Promise<void>((done) => (resolve = done))
    return { promise, resolve }
  }

  it('never exceeds the concurrency limit and refills when a job ends', async () => {
    const queue = ['a', 'b', 'c']
    const gates = new Map(queue.map((id) => [id, deferred()]))
    const started: string[] = []
    const scheduler = createScheduler<string>({
      claim: async () => queue.shift() ?? null,
      run: async (id) => {
        started.push(id)
        await gates.get(id)!.promise
      },
      concurrency: async () => 2,
    })
    await scheduler.tick()
    expect(started).toEqual(['a', 'b'])
    expect(scheduler.running()).toBe(2)

    gates.get('a')!.resolve()
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c']))
  })

  it('collapses overlapping ticks into one more pass', async () => {
    let claims = 0
    const release = deferred()
    const scheduler = createScheduler<string>({
      claim: async () => {
        claims += 1
        await release.promise
        return null
      },
      run: async () => {},
      concurrency: async () => 1,
    })
    const first = scheduler.tick()
    await vi.waitFor(() => expect(claims).toBe(1))
    await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()])
    release.resolve()
    await first
    expect(claims).toBe(2)
  })

  it('survives a failing claim and a failing job', async () => {
    const errors: unknown[] = []
    const scheduler = createScheduler<string>({
      claim: async () => {
        throw new Error('offline')
      },
      run: async () => {},
      concurrency: async () => 1,
      onError: (error) => errors.push(error),
    })
    await expect(scheduler.tick()).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })
})

describe('host gate', () => {
  it('spaces out one host and leaves others alone', () => {
    let clock = 1_000
    const gate = createHostGate(500, () => clock)
    expect(gate.reserve('a.com')).toBe(0)
    expect(gate.reserve('a.com')).toBe(500)
    expect(gate.reserve('a.com')).toBe(1_000)
    expect(gate.reserve('b.com')).toBe(0)
    clock = 5_000
    expect(gate.reserve('a.com')).toBe(0)
  })
})

describe('plan', () => {
  const profile = defineSite({
    id: 's',
    version: 1,
    hosts: ['example.com'],
    timeoutSeconds: 40,
    prepare: [{ op: 'wait', selector: '#app' }],
    content: { selectors: ['#c'], clean: ['.ad'] },
  })

  it('layers defaults, profile and job options in order', () => {
    const plan = buildPlan(
      job({ options: { waitFor: '.done', scroll: true, removeSelectors: ['.popup'], contentSelector: '#main', keepHtml: true } }),
      profile,
      'https://example.com/post',
      123,
    )
    expect(plan.steps.map((step) => step.op)).toEqual(['settle', 'wait', 'wait', 'scroll', 'settle', 'remove', 'remove'])
    expect(plan.steps.at(-1)).toEqual({ op: 'remove', selector: '.popup' })
    expect(plan).toMatchObject({ contentSelector: '#main', keepHtml: true, generic: false, deadline: 123, scope: 'target', maxItems: 1 })
  })

  it('reads a listing page for up to the asked number of entries', () => {
    expect(buildPlan(job({ options: { scope: 'visible' } }), null, 'https://x.com/a', 1)).toMatchObject({ scope: 'visible', maxItems: 20 })
    expect(buildPlan(job({ options: { scope: 'visible', maxItems: 5 } }), null, 'https://x.com/a', 1).maxItems).toBe(5)
  })

  it('takes the timeout from the job, then the profile, then the default', () => {
    expect(jobTimeoutMs(job({ options: { timeoutSeconds: 20 } }), profile)).toBe(20_000)
    expect(jobTimeoutMs(job(), profile)).toBe(40_000)
    expect(jobTimeoutMs(job(), null)).toBe(90_000)
  })
})

describe('contract', () => {
  const row = { id: 'a', owner: 'b', url: 'https://x.dev', runner: 'cloud' }
  it('drops unknown option keys, so a row cannot smuggle in steps or code', () => {
    const parsed = crawlJobSchema.parse({ ...row, options: { script: 'alert(1)', steps: [], scroll: true } })
    expect(parsed.options).toEqual({ scroll: true })
  })

  it('accepts a job with no options and rejects bad ones', () => {
    expect(crawlJobSchema.parse({ ...row, options: null }).options).toEqual({})
    for (const options of [{ timeoutSeconds: 9_999 }, { waitFor: 'a'.repeat(501) }, { scope: 'all' }, { maxItems: 51 }, { transport: 'curl' }]) {
      expect(crawlJobSchema.safeParse({ ...row, options }).success).toBe(false)
    }
    expect(crawlJobSchema.safeParse({ ...row, runner: 'phone' }).success).toBe(false)
  })
})

describe('cloud routes', () => {
  const x = findProfile(sites, 'https://x.com/a/status/1')
  it('follow the job, then the profile, and need a live page to wait or scroll', () => {
    expect(transportRoutes(job(), null)).toEqual(['browser'])
    expect(transportRoutes(job(), x)).toEqual(['http', 'browser'])
    expect(transportRoutes(job({ options: { transport: 'http' } }), null)).toEqual(['http'])
    expect(transportRoutes(job({ options: { transport: 'http', waitFor: 'main' } }), null)).toEqual(['browser'])
    expect(transportRoutes(job({ options: { transport: 'browser' } }), x)).toEqual(['browser'])
  })
})

