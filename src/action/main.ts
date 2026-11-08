import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { chromium, type Browser } from 'playwright'
import { crawlJobSchema, type CrawlResult } from '@/core/contract'
import { TIMING } from '@/core/limits'
import { ApiError, createCrawlApi, type CrawlApi } from '@/engine/api'
import { createHostGate } from '@/engine/host-gate'
import { createRunner, type ClaimedJob } from '@/engine/runner'
import { createScheduler } from '@/engine/scheduler'
import { publicLog } from './log'
import { createPlaywrightDriver } from './playwright-driver'

declare const __CRAWLER_VERSION__: string

/**
 * The cloud executor, run by `.github/workflows/crawl.yml`:
 *
 *   node dist/action/crawler.mjs dispatch --id <dispatch id>   claim cloud jobs until the queue is empty
 *   node dist/action/crawler.mjs crawl <url> [--transport auto|http|browser] [--scope visible] [--json]
 *                                                              one page, printed, nothing stored
 *
 * `dispatch` signs in as the crawler service (CRAWLER_TOKEN) and works like the extension does:
 * claim, renew, complete or fail through the shared engine. It exits 0 when the queue is done,
 * whatever the pages did: each job's outcome is recorded on the job, not in this process.
 */
const VERSION = __CRAWLER_VERSION__
const HTTP_USER_AGENT = `AnyWorkflowCrawler/${VERSION} (+https://github.com/ActiveInsighter/webpage-parser-action)`
/** Stop claiming well inside the workflow's timeout, so running jobs can finish and report. */
const DEFAULT_BUDGET_MINUTES = 30
const CLAIM_RETRIES = 3

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? '').trim() || fallback
}

async function launchBrowser(): Promise<{ get: () => Promise<Browser>; close: () => Promise<void>; userAgent: () => Promise<string> }> {
  let pending: Promise<Browser> | null = null
  const get = () => {
    // Started on the first page that needs it; a queue of plain HTTP pages never starts it.
    pending ??= chromium.launch({ headless: true, ...(env('CRAWLER_CHROME_CHANNEL') ? { channel: env('CRAWLER_CHROME_CHANNEL') } : {}) })
    return pending
  }
  return {
    get,
    close: async () => {
      if (pending) await (await pending).close()
    },
    // The browser's own version, without the "Headless" marker that many sites refuse.
    userAgent: async () => {
      const major = (await get()).version().split('.')[0]
      return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
    },
  }
}

async function agentSource(): Promise<string> {
  return readFile(new URL('./agent.js', import.meta.url), 'utf8')
}

async function createDriver(browser: Awaited<ReturnType<typeof launchBrowser>>, allowLocal: boolean) {
  let userAgent = ''
  const source = await agentSource()
  const policy = { blockedHosts: [], allowLocal }
  const driver = createPlaywrightDriver({
    browser: async () => {
      const instance = await browser.get()
      userAgent ||= await browser.userAgent()
      return instance
    },
    agentSource: source,
    policy,
    get userAgent() {
      return userAgent
    },
    httpUserAgent: HTTP_USER_AGENT,
  })
  return { driver, policy }
}

/** Only the end-to-end suite opens local fixture pages; a workflow run never may. */
function allowLocal(): boolean {
  if (env('CRAWLER_ALLOW_LOCAL') !== '1') return false
  if (env('GITHUB_ACTIONS') === 'true' && env('CRAWLER_E2E') !== '1') throw new Error('CRAWLER_ALLOW_LOCAL is for local tests only')
  return true
}

async function retrying<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work()
    } catch (error) {
      // A refused credential will not get better by waiting.
      if (attempt >= CLAIM_RETRIES || (error instanceof ApiError && (error.status === 401 || error.status === 403))) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 3_000))
    }
  }
}

async function dispatch(id: string): Promise<void> {
  if (!/^[a-z0-9]{15}$/u.test(id)) throw new Error('--id must be a 15-character record id')
  const baseUrl = env('POCKETBASE_URL', 'https://pb.any1.tech').replace(/\/$/u, '')
  const token = env('CRAWLER_TOKEN')
  if (!token) throw new Error('CRAWLER_TOKEN is not set')
  const concurrency = Math.min(4, Math.max(1, Number(env('CRAWLER_CONCURRENCY', '2')) || 2))
  const budgetEnd = Date.now() + Number(env('CRAWLER_BUDGET_MINUTES', String(DEFAULT_BUDGET_MINUTES))) * 60_000
  const api: CrawlApi = createCrawlApi(baseUrl, async () => token)
  const browser = await launchBrowser()
  const { driver, policy } = await createDriver(browser, allowLocal())
  const executor = { workerId: `gha-${randomUUID()}`, version: VERSION, label: 'GitHub Actions', dispatch: id }
  const started = Date.now()
  let claimed = 0
  let stopping = false

  const run = createRunner({
    api,
    driver,
    gate: createHostGate(TIMING.hostIntervalMs),
    policy: async () => policy,
    runner: 'cloud',
    version: VERSION,
    log: (event, detail) => publicLog(event, detail),
  })

  async function claim(): Promise<ClaimedJob | null> {
    if (stopping) return null
    if (Date.now() > budgetEnd) {
      stopping = true
      await api.closeDispatch?.(id)
      publicLog('crawl.budget-spent', { dispatch: id, claimed })
      return null
    }
    const leaseId = randomUUID()
    const reply = await retrying(() => api.claim(executor, leaseId))
    if (reply.closed || !reply.job) {
      stopping = true
      return null
    }
    claimed += 1
    publicLog('crawl.claimed', { job: reply.job.id, claimed })
    return { job: reply.job, leaseId }
  }

  let failure: unknown = null
  await new Promise<void>((resolve) => {
    const scheduler = createScheduler<ClaimedJob>({
      claim,
      run,
      concurrency: async () => concurrency,
      onChange: (running) => {
        if (running === 0 && stopping) resolve()
      },
      onError: (error) => {
        // Claiming failed for good: stop taking work, let running jobs finish.
        failure = error
        stopping = true
      },
    })
    void scheduler.tick().then(() => {
      if (scheduler.running() === 0 && stopping) resolve()
    })
  })
  await browser.close()
  publicLog('crawl.dispatch-done', { dispatch: id, claimed, elapsedMs: Date.now() - started })
  if (failure) throw failure
}

/** One page, printed: the same engine with an in-memory server, for debugging and the e2e suite. */
async function crawlOnce(url: string, values: { transport?: string; scope?: string; 'max-items'?: string; json?: boolean; 'allow-local'?: boolean }): Promise<number> {
  const browser = await launchBrowser()
  const { driver, policy } = await createDriver(browser, values['allow-local'] === true)
  let result: CrawlResult | null = null
  let failure: { code: string; message: string } | null = null
  const job = crawlJobSchema.parse({
    id: 'local',
    owner: 'local',
    url,
    runner: 'cloud',
    options: {
      ...(values.transport ? { transport: values.transport } : {}),
      ...(values.scope ? { scope: values.scope } : {}),
      ...(values['max-items'] ? { maxItems: Number(values['max-items']) } : {}),
    },
  })
  const api: CrawlApi = {
    claim: async () => ({ job: null, closed: true }),
    renew: async () => ({ accepted: true, cancelRequested: false }),
    complete: async (_id, _lease, value) => {
      result = value
      return { status: 'succeeded', document: '', changed: true }
    },
    fail: async (_id, _lease, value) => {
      failure = value
    },
  }
  const run = createRunner({ api, driver, gate: createHostGate(0), policy: async () => policy, runner: 'cloud', version: VERSION })
  await run({ job, leaseId: 'local' })
  await browser.close()
  if (failure) {
    console.error(JSON.stringify(failure))
    return 1
  }
  const done = result as CrawlResult | null
  console.log(values.json ? JSON.stringify(done, null, 2) : done?.markdown)
  return 0
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === 'dispatch') {
    const { values } = parseArgs({ args: rest, options: { id: { type: 'string' } } })
    await dispatch(values.id ?? '')
    return 0
  }
  if (command === 'crawl') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { transport: { type: 'string' }, scope: { type: 'string' }, 'max-items': { type: 'string' }, json: { type: 'boolean' }, 'allow-local': { type: 'boolean' } },
    })
    if (!positionals[0]) throw new Error('crawl needs a URL')
    return crawlOnce(positionals[0], values)
  }
  console.error('usage: crawler.mjs dispatch --id <dispatch id> | crawl <url> [--transport auto|http|browser] [--scope visible] [--max-items N] [--json]')
  return 2
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    // The message may name a URL only for `crawl`; `dispatch` errors are infrastructure ones.
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)
