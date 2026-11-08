// End-to-end check of the cloud executor: the real dist/action/crawler.mjs in a real Chromium,
// against real PocketBase hooks (vendored from AnyWorkflow-workers), on a local fixture site.
//
//   npm run build:action && POCKETBASE_BINARY=/opt/pocketbase/pocketbase npm run test:cloud
//
// It plays the scheduler's part by hand: plans a dispatch, marks it dispatched, then runs the
// crawler as the workflow would, and checks what PocketBase holds afterwards.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startFixtureSite } from '../support/fixture-site.mjs'
import { DOCUMENTS, jobsOf, startPocketBase } from '../support/pocketbase.mjs'

const root = resolve(import.meta.dirname, '../..')
const binary = process.env.POCKETBASE_BINARY
if (!binary) throw new Error('Set POCKETBASE_BINARY')
const scratchRoot = join(root, '.e2e')
mkdirSync(scratchRoot, { recursive: true })
const scratch = mkdtempSync(join(scratchRoot, 'cloud-'))
const pb = await startPocketBase({ binary, root: join(scratch, 'pb') })
const site = await startFixtureSite()
const { enqueue, job, documentOf } = jobsOf(pb)
const fixture = (path) => `${site.base}${path}`

/** Runs the crawler as crawl.yml does; returns its exit code and everything it printed. */
function crawler(dispatch, extra = {}) {
  return new Promise((done) => {
    const child = spawn('node', [join(root, 'dist/action/crawler.mjs'), 'dispatch', '--id', dispatch], {
      env: { ...process.env, POCKETBASE_URL: pb.base, CRAWLER_TOKEN: pb.service, CRAWLER_ALLOW_LOCAL: '1', CRAWLER_E2E: '1', ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('close', (code) => done({ code, output }))
  })
}

async function openDispatch() {
  const plan = await pb.call('/api/anyworkflow/crawl/dispatches/plan', { token: pb.admin, body: { limit: 3 } })
  assert.ok(plan.created >= 1, JSON.stringify(plan))
  const { items } = await pb.call(`/api/collections/aw_crawl_dispatches/records?filter=${encodeURIComponent('status="queued"')}`, { token: pb.admin, method: 'GET' })
  // What the scheduler's GitHub executor writes once the workflow is dispatched.
  await pb.call(`/api/collections/aw_crawl_dispatches/records/${items[0].id}`, { token: pb.admin, method: 'PATCH', body: { status: 'pending', githubRunId: '1' } })
  return items[0].id
}

const cases = {
  'a dispatch drains the cloud queue and leaves documents, public logs and a closed dispatch': async () => {
    const ids = {
      article: await enqueue(fixture('/article'), { transport: 'http' }, 'cloud'),
      spa: await enqueue(fixture('/spa'), {}, 'cloud'),
      missing: await enqueue(fixture('/missing'), { transport: 'http' }, 'cloud'),
      browserOnly: await enqueue(fixture('/article'), {}, 'browser'),
    }
    const dispatch = await openDispatch()
    const { code, output } = await crawler(dispatch)
    assert.equal(code, 0, output)

    const article = await job(ids.article)
    assert.equal(article.status, 'succeeded', article.error)
    assert.equal(article.dispatch, dispatch)
    const doc = await documentOf(article)
    assert.equal(doc.runner, 'cloud')
    assert.equal(doc.title, '静态文章')
    assert.match(doc.markdown, /静态第 6 段/u)
    assert.equal(doc.trace.route, 'http')
    assert.match(doc.contentHash, /^[a-f0-9]{64}$/u)

    const spa = await job(ids.spa)
    assert.equal(spa.status, 'succeeded', spa.error)
    const rendered = await documentOf(spa)
    assert.equal(rendered.trace.route, 'browser')
    assert.match(rendered.markdown, /脚本第 6 段/u, 'the browser route runs page scripts')

    const missing = await job(ids.missing)
    assert.equal(missing.status, 'failed')
    assert.equal(missing.errorCode, 'NOT_FOUND')
    assert.equal((await job(ids.browserOnly)).status, 'queued', 'browser jobs wait for an extension')

    const dispatchRow = await pb.call(`/api/collections/aw_crawl_dispatches/records/${dispatch}`, { token: pb.admin, method: 'GET' })
    assert.notEqual(dispatchRow.closedAt, '', 'an empty queue closed the dispatch')
    assert.equal(dispatchRow.claimedCount, 3)
    // The repository's runs are public: no URL, host or page text may reach the log.
    assert.doesNotMatch(output, /127\.0\.0\.1|静态|fixture|\/article|\/spa/u, output)
    assert.match(output, /"event":"crawl.dispatch-done"/u)
  },
  'the same page again updates one document and says it did not change': async () => {
    const first = await enqueue(fixture('/article'), { transport: 'http' }, 'cloud')
    const dispatch = await openDispatch()
    assert.equal((await crawler(dispatch)).code, 0)
    const row = await job(first)
    assert.equal(row.status, 'succeeded', row.error)
    assert.equal(row.changed, false)
    const { items } = await pb.call(`${DOCUMENTS}?perPage=50`, { token: pb.token, method: 'GET' })
    assert.equal(items.filter((item) => item.url === fixture('/article')).length, 1)
  },
  'a closed dispatch takes nothing and the crawler exits cleanly': async () => {
    const id = await enqueue(fixture('/article'), { transport: 'http' }, 'cloud')
    const dispatch = await openDispatch()
    await pb.call(`/api/anyworkflow/crawl/dispatches/${dispatch}/close`, { token: pb.service })
    const { code } = await crawler(dispatch)
    assert.equal(code, 0)
    assert.equal((await job(id)).status, 'queued')
    await pb.call(`/api/anyworkflow/crawl/jobs/${id}/cancel`, { token: pb.token })
  },
  'a refused credential fails the run and leaves the job queued': async () => {
    const id = await enqueue(fixture('/article'), { transport: 'http' }, 'cloud')
    const dispatch = await openDispatch()
    const { code } = await crawler(dispatch, { CRAWLER_TOKEN: 'not-a-token' })
    assert.equal(code, 1)
    assert.equal((await job(id)).status, 'queued')
    await pb.call(`/api/anyworkflow/crawl/jobs/${id}/cancel`, { token: pb.token })
  },
}

let failures = 0
try {
  for (const [name, run] of Object.entries(cases)) {
    const started = Date.now()
    try {
      await run()
      console.log(`PASS  ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    } catch (error) {
      failures += 1
      console.log(`FAIL  ${name}\n      ${String(error?.message ?? error).split('\n').slice(0, 8).join('\n      ')}`)
    }
  }
} finally {
  pb.stop()
  await site.stop()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} failed` : '\nAll cloud checks passed')
process.exit(failures ? 1 : 0)
