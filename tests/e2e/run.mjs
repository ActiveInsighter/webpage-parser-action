// End-to-end check of the real extension in a real browser against real PocketBase hooks.
//
//   POCKETBASE_BINARY=/opt/pocketbase/pocketbase npm run test:e2e
//
// Uses its own Chromium profile and a scratch database, so it touches no live data or browser.
// Set REMOTE_DIR to a Remote checkout to also drive the console page, and SCREENSHOT_DIR to keep
// its screenshots.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startFixtureSite } from '../support/fixture-site.mjs'
import { sleep, startHarness } from './harness.mjs'
import { freePort } from '../support/pocketbase.mjs'

const remoteDir = process.env.REMOTE_DIR && resolve(process.env.REMOTE_DIR)
const screenshots = process.env.SCREENSHOT_DIR && resolve(process.env.SCREENSHOT_DIR)
const only = process.argv.slice(2)

const { context, worker, pb, signIn, enqueue, job, settled, capture, stop } = await startHarness()
const site = await startFixtureSite()
const fixture = (path) => `${site.base}${path}`
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'canceled'])

const openWindows = async () => context.pages().filter((page) => page.url().startsWith(site.base)).length

const cases = {
  'static article becomes Markdown with metadata': async () => {
    const { row, result } = await capture(fixture('/article'))
    assert.equal(row.status, 'succeeded', row.error)
    assert.equal(result.title, '静态文章')
    assert.equal(result.byline, '测试作者')
    assert.equal(result.siteName, '夹具站')
    assert.equal(result.language, 'zh-CN')
    assert.equal(result.httpStatus, 200)
    assert.match(result.markdown, /静态第 6 段/u)
    assert.match(result.markdown, /```js/u)
    assert.doesNotMatch(result.markdown, /页脚内容/u)
    assert.match(result.contentHash, /^[a-f0-9]{64}$/u)
    assert.equal(result.links[0].href, `${site.base}/next`, 'tracking parameters are stripped')
    assert.ok(result.trace.phases['live.extracted'] > 0)
    assert.equal(result.trace.runner, 'browser')
    assert.equal(result.runner, 'browser')
    assert.ok(result.trace.steps.length > 0)
    assert.equal(row.title, '静态文章')
    assert.equal(row.wordCount, result.wordCount)
  },
  'script-rendered content is waited for': async () => {
    const { row, result } = await capture(fixture('/spa'))
    assert.equal(row.status, 'succeeded', row.error)
    assert.match(result.markdown, /脚本第 6 段/u)
    assert.doesNotMatch(result.markdown, /加载中/u)
  },
  'waitFor holds extraction for a slow element': async () => {
    const { result } = await capture(fixture('/wait-for'), { waitFor: '#late' })
    assert.match(result.markdown, /后到第 6 段/u)
  },
  'waitFor on a missing element fails without retrying': async () => {
    const { row } = await capture(fixture('/article'), { waitFor: '#absent', timeoutSeconds: 40 })
    assert.equal(row.status, 'failed')
    assert.equal(row.errorCode, 'STEP_FAILED')
    assert.equal(row.attempts, 1)
  },
  'lazy images resolve to their real source': async () => {
    const { result } = await capture(fixture('/lazy'))
    assert.equal(result.images[0].src, `${site.base}/image/real.png`)
    assert.match(result.markdown, /image\/real\.png/u)
  },
  'quality: a selected pre preserves long code, blank lines and embedded fences': async () => {
    const { row, result } = await capture(fixture('/quality-code'), { contentSelector: '#quality-code', keepHtml: true })
    assert.equal(row.status, 'succeeded', row.error)
    assert.equal(result.extractor, 'manual')
    assert.ok(result.markdown.startsWith('````js\n  const fence = "```"\n\n\n  function render() {'), 'opening fence and code whitespace are preserved')
    assert.ok(result.markdown.includes('\n    return fence\n  }\n'), 'nested code indentation survives')
    assert.ok(result.markdown.includes('\n  // retained-code-line-249\n'), 'the full selected code block survives')
    assert.ok(result.markdown.endsWith('\n  // final-code-line\n````'), 'a longer closing fence follows the last code line')
    assert.match(result.html, /^<pre\b/u)
    assert.doesNotMatch(result.markdown, /代码说明第|页脚内容/u)
  },
  'quality: an image with only srcset keeps its high resolution source': async () => {
    const { row, result } = await capture(fixture('/quality-responsive'), { contentSelector: 'article', keepHtml: true })
    assert.equal(row.status, 'succeeded', row.error)
    assert.deepEqual(result.images, [{ src: `${site.base}/image/real.png?size=1280`, alt: '只有 srcset 的高清图片' }])
    assert.ok(result.markdown.includes(`![只有 srcset 的高清图片](${site.base}/image/real.png?size=1280)`))
    assert.ok(result.html.includes(`srcset="${site.base}/image/real.png?size=320 320w, ${site.base}/image/real.png?size=1280 1280w"`), 'responsive candidates become absolute URLs')
    assert.match(result.markdown, /响应式图文第 6 段/u)
  },
  'quality: JSON-LD references supply metadata while hidden noise is removed': async () => {
    const { row, result } = await capture(fixture('/quality-metadata'), { contentSelector: 'article', keepHtml: true })
    assert.equal(row.status, 'succeeded', row.error)
    assert.equal(result.title, '图谱正文标题')
    assert.equal(result.byline, '图谱作者')
    assert.equal(result.siteName, '图谱出版社')
    assert.equal(new Date(result.publishedAt).toISOString(), '2026-11-05T00:30:00.000Z', 'an invalid meta date must not shadow the graph date')
    assert.equal(result.leadImage, `${site.base}/image/real.png?cover=1`, 'the referenced cover replaces an unsafe meta URL')
    assert.equal(result.canonicalUrl, fixture('/quality-metadata?canonical=1'))
    assert.ok(result.structuredData.some((node) => node['@id'] === '#author' && node.name === '图谱作者'))
    assert.match(result.markdown, /可见正文第 6 段/u)
    assert.doesNotMatch(result.markdown, /隐藏旧版|重复推荐|跟踪图片/u)
    assert.doesNotMatch(result.html, /隐藏旧版|重复推荐|tracking=|javascript:/u)
    assert.deepEqual(result.images, [])
  },
  'scroll option loads infinite content': async () => {
    const without = await capture(fixture('/infinite'))
    assert.doesNotMatch(without.result.markdown, /第 4 批内容/u)
    const { result } = await capture(fixture('/infinite'), { scroll: true })
    assert.match(result.markdown, /第 4 批内容/u, JSON.stringify(result.trace))
  },
  'removeSelectors and contentSelector shape the result': async () => {
    const removed = await capture(fixture('/noise'), { removeSelectors: ['.promo'] })
    assert.doesNotMatch(removed.result.markdown, /广告内容/u)
    const chosen = await capture(fixture('/noise'), { contentSelector: '.promo' })
    assert.equal(chosen.result.extractor, 'manual')
    assert.match(chosen.result.markdown, /广告内容/u)
    assert.doesNotMatch(chosen.result.markdown, /有用第 1 段/u)
  },
  'keepHtml stores clean HTML': async () => {
    const { result } = await capture(fixture('/article'), { keepHtml: true })
    assert.match(result.html, /<p>/u)
    assert.doesNotMatch(result.html, /<script/u)
  },
  'a redirect is followed and recorded': async () => {
    const { row, result } = await capture(fixture('/redirect'))
    assert.equal(row.status, 'succeeded', row.error)
    assert.equal(result.url, `${site.base}/article`)
  },
  'a script redirect is followed': async () => {
    const { row, result } = await capture(fixture('/js-redirect'))
    assert.equal(row.status, 'succeeded', row.error)
    assert.equal(result.url, `${site.base}/article`)
  },
  'a 404 fails at once': async () => {
    const { row } = await capture(fixture('/missing'))
    assert.equal(row.status, 'failed')
    assert.equal(row.errorCode, 'NOT_FOUND')
    assert.equal(row.attempts, 1)
  },
  'a 500 is retried': async () => {
    const id = await enqueue(fixture('/server-error'))
    for (;;) {
      const row = await job(id)
      if (row.status === 'queued' && row.attempts === 1) {
        assert.equal(row.errorCode, 'HTTP_ERROR')
        assert.ok(row.nextAttemptAt)
        break
      }
      assert.ok(!TERMINAL.has(row.status), JSON.stringify(row))
      await sleep(150)
    }
    await pb.call(`/api/anyworkflow/crawl/jobs/${id}/cancel`, { token: pb.token })
  },
  'a login wall is reported': async () => {
    const { row } = await capture(fixture('/members'))
    assert.equal(row.status, 'failed')
    assert.equal(row.errorCode, 'LOGIN_REQUIRED')
  },
  'a challenge page is reported': async () => {
    const { row } = await capture(fixture('/challenge'))
    assert.equal(row.status, 'failed')
    assert.equal(row.errorCode, 'CAPTCHA')
  },
  'a verification wall fails instead of saving the wall as content': async () => {
    const { row, result } = await capture(fixture('/verify'))
    assert.equal(row.status, 'failed', JSON.stringify(result))
    assert.equal(row.errorCode, 'CAPTCHA')
  },
  'a refusal sent as JSON reads as a refusal': async () => {
    const { row } = await capture(fixture('/refused'))
    assert.equal(row.status, 'failed')
    assert.equal(row.errorCode, 'ACCESS_DENIED', row.error)
  },
  'a PDF points to file conversion': async () => {
    const { row } = await capture(fixture('/doc.pdf'))
    assert.equal(row.status, 'failed', JSON.stringify(row))
    assert.equal(row.errorCode, 'UNSUPPORTED_CONTENT', `${row.errorCode}: ${row.error}`)
    assert.match(row.error, /文件转换/u)
  },
  'a thin page is kept as partial': async () => {
    const { row, result } = await capture(fixture('/thin'))
    assert.equal(row.status, 'partial', row.error)
    assert.ok(result.warnings.includes('short_content'))
  },
  'a page that never finishes loading is still captured': async () => {
    const { row, result } = await capture(fixture('/never-loads'), { timeoutSeconds: 60 })
    assert.equal(row.status, 'succeeded', row.error)
    assert.match(result.markdown, /慢资源第 6 段/u)
    assert.ok(result.warnings.includes('load_timeout'), JSON.stringify(result.warnings))
  },
  'a queued job starts within seconds, without waiting for the alarm': async () => {
    await sleep(1_500)
    const started = Date.now()
    const id = await enqueue(fixture('/article'))
    for (;;) {
      const row = await job(id)
      if (row.status !== 'queued') break
      assert.ok(Date.now() - started < 8_000, 'still queued after 8 s: realtime did not wake the worker')
      await sleep(50)
    }
    await settled(id)
  },
  'canceling a running job stops it and closes the page': async () => {
    const id = await enqueue(fixture('/article'), { waitFor: '#absent', timeoutSeconds: 60 })
    for (;;) {
      const row = await job(id)
      if (row.status === 'rendering') break
      await sleep(50)
    }
    await pb.call(`/api/anyworkflow/crawl/jobs/${id}/cancel`, { token: pb.token })
    const row = await settled(id, 40_000)
    assert.equal(row.status, 'canceled')
    await sleep(300)
    assert.equal(await openWindows(), 0)
  },
  'a batch runs within the concurrency limit, and every page closes': async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => enqueue(fixture('/spa'))))
    let peak = 0
    const watching = setInterval(async () => {
      peak = Math.max(peak, await openWindows())
    }, 50)
    const rows = await Promise.all(ids.map((id) => settled(id, 90_000)))
    clearInterval(watching)
    assert.ok(rows.every((row) => row.status === 'succeeded'), JSON.stringify(rows.map((row) => row.status)))
    assert.ok(peak <= 2, `peak ${peak} pages`)
    await sleep(300)
    assert.equal(await openWindows(), 0)
  },
  'the worker reports in': async () => {
    const { items } = await pb.call('/api/collections/aw_crawl_workers/records', { token: pb.token, method: 'GET' })
    assert.equal(items.length, 1)
    assert.equal(items[0].version, JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')).version)
    assert.match(items[0].label, /^Chrome/u)
  },
  'a killed service worker closes its orphaned page and keeps working': async () => {
    const id = await enqueue(fixture('/article'), { waitFor: '#absent', timeoutSeconds: 60 })
    for (;;) {
      if ((await job(id)).status === 'rendering') break
      await sleep(50)
    }
    assert.equal(await openWindows(), 1)
    // What Chrome does to an idle worker: the extension itself stays installed.
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('ServiceWorker.enable')
    await cdp.send('ServiceWorker.stopAllWorkers')
    await page.close()

    // The offscreen document or the alarm brings the worker back; a new job proves it.
    const next = await enqueue(fixture('/article'))
    assert.equal((await settled(next, 45_000)).status, 'succeeded')
    assert.equal(await openWindows(), 0, 'the orphaned page was closed')
    await pb.call(`/api/anyworkflow/crawl/jobs/${id}/cancel`, { token: pb.token })
  },
}

async function driveRemote() {
  const port = await freePort()
  const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: remoteDir, stdio: 'ignore', detached: true })
  const base = `http://127.0.0.1:${port}`
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        if ((await fetch(base)).ok) break
      } catch {
        // Still starting.
      }
      if (attempt > 150) throw new Error('Remote dev server did not start')
      await sleep(100)
    }
    const page = await context.newPage()
    await page.setViewportSize({ width: 1440, height: 1000 })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(([token, id, baseUrl]) => {
      localStorage.setItem('anyworkflow.auth.session.v1', JSON.stringify({ token, record: { id }, baseUrl }))
    }, [pb.token, pb.ownerId, pb.base])
    await page.goto(`${base}/page-capture`)
    await page.getByRole('heading', { name: '网页采集' }).waitFor()
    await page.getByText('扩展在线').waitFor({ timeout: 15_000 })

    // Finished rows from the cases above are already listed; the real page is what matters here.
    await page.getByRole('button', { name: '查看内容' }).first().waitFor()
    if (screenshots) await page.screenshot({ path: join(screenshots, 'remote-list.png') })
    await page.getByRole('button', { name: '查看内容' }).first().click()
    await page.getByRole('tab', { name: '正文' }).waitFor()
    await page.getByText('Markdown', { exact: true }).waitFor()
    if (screenshots) await page.screenshot({ path: join(screenshots, 'remote-result.png') })
    await page.getByRole('tab', { name: '信息' }).click()
    await page.getByText('解析方式').waitFor()
    assert.deepEqual(errors, [])
    await page.close()
  } finally {
    try {
      process.kill(-vite.pid)
    } catch {
      // Already gone.
    }
  }
}

let failures = 0
try {
  if (screenshots) mkdirSync(screenshots, { recursive: true })
  await signIn()
  const logs = []
  worker.on('console', (message) => logs.push(message.text()))
  const names = Object.keys(cases).filter((name) => !only.length || only.some((term) => name.includes(term)))
  for (const name of names) {
    const started = Date.now()
    try {
      await cases[name]()
      console.log(`PASS  ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    } catch (error) {
      failures += 1
      console.log(`FAIL  ${name}\n      ${String(error?.message ?? error).split('\n').slice(0, 6).join('\n      ')}`)
    }
  }
  if (remoteDir) {
    try {
      await driveRemote()
      console.log('PASS  Remote page lists jobs and opens a result')
    } catch (error) {
      failures += 1
      console.log(`FAIL  Remote page\n      ${String(error?.stack ?? error).split('\n').slice(0, 8).join('\n      ')}`)
    }
  }
} finally {
  await stop()
  await site.stop()
}
console.log(failures ? `\n${failures} failed` : '\nAll end-to-end checks passed')
process.exit(failures ? 1 : 0)
