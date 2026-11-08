// Runs the built page agent against saved HTML at its source URL in an isolated browser.
// This checks parsing of the saved DOM and embedded data; it does not verify live page loading.
//
//   npm run build && node tests/e2e/replay.mjs "<url>" saved.html [--md]
//
// Original application scripts stay inert. The capture agent is the only injected executable.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { prepareReplayDocument } from './replay-document.mjs'

const [url, file] = process.argv.slice(2)
if (!url || !file) throw new Error('Usage: replay.mjs <url> <saved.html> [--md]')

const html = prepareReplayDocument(await readFile(file, 'utf8'), url)
const browser = await chromium.launch({ args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  const target = new URL(url)
  target.hash = ''
  let served = false
  await page.route('**/*', (route) => {
    const request = route.request()
    if (!served && request.isNavigationRequest() && request.frame() === page.mainFrame() && request.url() === target.href) {
      served = true
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
    }
    return route.abort()
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.addScriptTag({ path: resolve(import.meta.dirname, '../../dist/action/agent.js') })
  const plan = { steps: [], keepHtml: false, generic: false, deadline: Date.now() + 30_000, requestedUrl: url }
  const reply = await page.evaluate((input) => globalThis.__awCrawler.extract(input), plan)
  if (!reply.ok) {
    console.log(reply)
    process.exitCode = 1
  } else {
    const { markdown, links, images, structuredData, html: _html, ...fields } = reply.value
    console.log(fields)
    console.log(`links ${links.length}, images ${images.length}, jsonld ${structuredData.length}, markdown ${markdown.length} chars`)
    console.log(process.argv.includes('--md') ? markdown : `--- head ---\n${markdown.slice(0, 600)}\n--- tail ---\n${markdown.slice(-300)}`)
  }
} finally {
  await browser.close()
}
