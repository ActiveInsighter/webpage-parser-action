import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { ACCOUNT, jobsOf, startPocketBase } from '../support/pocketbase.mjs'

const root = resolve(import.meta.dirname, '../..')

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function build(outdir, env) {
  return new Promise((done, fail) => {
    const child = spawn('node', ['scripts/build.mjs', `--outdir=${outdir}`, '--only=extension'], { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore' })
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`build exited ${code}`))))
  })
}

/** The real extension in its own Chromium profile, wired to a scratch PocketBase. */
export async function startHarness() {
  const binary = process.env.POCKETBASE_BINARY
  if (!binary) throw new Error('Set POCKETBASE_BINARY')

  const scratchRoot = join(root, '.e2e')
  mkdirSync(scratchRoot, { recursive: true })
  const scratch = mkdtempSync(join(scratchRoot, 'run-'))
  let pb, context, worker
  try {
    pb = await startPocketBase({ binary, root: join(scratch, 'pb') })
    const outDir = join(scratch, 'dist')
    await build(outDir, { CRAWLER_POCKETBASE_URL: pb.base, CRAWLER_ALLOW_LOCAL: '1' })
    const distDir = join(outDir, 'extension')
    context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, '--no-sandbox'],
    })
    worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  } catch (error) {
    await context?.close().catch(() => {})
    pb?.stop()
    rmSync(scratch, { recursive: true, force: true })
    throw error
  }
  const extensionId = new URL(worker.url()).host

  async function signIn() {
    const popup = await context.newPage()
    await popup.goto(`chrome-extension://${extensionId}/popup.html`)
    await popup.fill('input[type=email]', ACCOUNT.email)
    await popup.fill('input[type=password]', ACCOUNT.password)
    await popup.click('button[type=submit]')
    await popup.waitForSelector('text=等待任务', { timeout: 10_000 })
    return popup
  }

  const { enqueue, job, settled, documentOf } = jobsOf(pb)

  async function capture(url, options, timeoutMs) {
    const id = await enqueue(url, options, 'browser')
    const row = await settled(id, timeoutMs)
    return { row, result: await documentOf(row) }
  }

  async function stop() {
    await context.close().catch(() => {})
    pb.stop()
    rmSync(scratch, { recursive: true, force: true })
  }

  return { context, worker, extensionId, pb, signIn, enqueue, job, settled, documentOf, capture, stop }
}
