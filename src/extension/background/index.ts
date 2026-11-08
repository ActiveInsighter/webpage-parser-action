import { TIMING } from '@/core/limits'
import { checkUrl } from '@/core/url-policy'
import { ApiError, createCrawlApi, requestJson } from '@/engine/api'
import { createHostGate } from '@/engine/host-gate'
import { createRunner, type ClaimedJob } from '@/engine/runner'
import { createScheduler } from '@/engine/scheduler'
import type { PopupReply, PopupRequest, StatusReply, WakeMessage } from '@/extension/messages'
import { refreshSession, signInWithPassword } from './auth'
import { ALLOW_LOCAL_TARGETS, CRAWLER_VERSION, POCKETBASE_URL, REMOTE_PAGE_URL } from './config'
import { closeOrphanedPages, createChromeDriver } from './pages'
import { syncRealtime } from './realtime'
import { needsRefresh, readSession, writeSession } from './session'
import { readSettings, workerId, writeSettings } from './settings'

/**
 * The browser executor. It signs in as its owner, claims that owner's `browser` jobs and runs
 * them in tabs of this browser, where the owner's own logins apply. The job lifecycle, plan and
 * parsing are the shared engine's; this file only wires Chrome to it.
 */
const TICK_ALARM = 'crawl.tick'
const TICK_MINUTES = 0.5

let lastError = ''

const api = createCrawlApi(POCKETBASE_URL, async () => (await readSession())?.token ?? null)

const run = createRunner({
  api,
  driver: createChromeDriver(async () => (await readSettings()).openMode),
  gate: createHostGate(TIMING.hostIntervalMs),
  policy: async () => ({ blockedHosts: (await readSettings()).blockedHosts, allowLocal: ALLOW_LOCAL_TARGETS }),
  runner: 'browser',
  version: CRAWLER_VERSION,
  log: (event, detail) => console.info(event, detail),
})

async function workerInfo() {
  const platform = await chrome.runtime.getPlatformInfo()
  return { workerId: await workerId(), version: CRAWLER_VERSION, label: `Chrome · ${platform.os}` }
}

async function endSession(reason: string): Promise<void> {
  await writeSession(null)
  lastError = reason
  await refreshRuntime()
}

async function claim(): Promise<ClaimedJob | null> {
  const [session, settings] = await Promise.all([readSession(), readSettings()])
  if (!session || !settings.enabled) return null
  const leaseId = crypto.randomUUID()
  try {
    const { job } = await api.claim(await workerInfo(), leaseId)
    lastError = ''
    return job ? { job, leaseId } : null
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) await endSession('登录已失效，请重新登录')
    throw error
  }
}

const scheduler = createScheduler<ClaimedJob>({
  claim,
  run,
  concurrency: async () => (await readSettings()).concurrency,
  onChange: () => void updateBadge(),
  onError: (error) => {
    lastError = error instanceof Error ? error.message : String(error)
    void updateBadge()
  },
})

async function updateBadge(): Promise<void> {
  const session = await readSession()
  const running = scheduler.running()
  const text = !session ? '!' : running ? String(running) : ''
  await chrome.action.setBadgeText({ text })
  await chrome.action.setBadgeBackgroundColor({ color: session ? '#5b5bd6' : '#c2410c' })
}

/** Brings the alarm, realtime and badge in line with the session and settings. */
async function refreshRuntime(): Promise<void> {
  const [session, settings] = await Promise.all([readSession(), readSettings()])
  await chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES })
  const active = session && settings.enabled
  await Promise.all([
    syncRealtime(active ? { baseUrl: POCKETBASE_URL, token: session.token } : null).catch((error: unknown) => console.warn('realtime', error)),
    updateBadge(),
  ])
}

async function refreshTokenIfDue(): Promise<void> {
  const session = await readSession()
  if (!session || !needsRefresh(session.token, Date.now())) return
  try {
    await writeSession(await refreshSession(POCKETBASE_URL, session.token))
    await refreshRuntime()
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) await endSession('登录已失效，请重新登录')
  }
}

async function status(): Promise<StatusReply> {
  const [session, settings] = await Promise.all([readSession(), readSettings()])
  return { user: session?.user ?? null, settings, running: scheduler.running(), lastError, remoteUrl: REMOTE_PAGE_URL, version: CRAWLER_VERSION }
}

/** Queues the active tab through the same path as a link typed into Remote, for this browser. */
async function crawlActiveTab(): Promise<void> {
  const session = await readSession()
  if (!session) throw new Error('请先登录')
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const verdict = checkUrl(tab?.url ?? '', { blockedHosts: (await readSettings()).blockedHosts, allowLocal: ALLOW_LOCAL_TARGETS })
  if (!verdict.ok) throw new Error(verdict.reason)
  await requestJson(POCKETBASE_URL, '/api/collections/aw_crawl_jobs/records', {
    token: session.token,
    body: { owner: session.user.id, url: verdict.url, runner: 'browser' },
  })
  await scheduler.tick()
}

async function handlePopup(request: PopupRequest): Promise<StatusReply> {
  switch (request.type) {
    case 'status':
      break
    case 'signIn':
      await writeSession(await signInWithPassword(POCKETBASE_URL, request.email.trim(), request.password))
      lastError = ''
      await refreshRuntime()
      void scheduler.tick()
      break
    case 'signOut':
      await writeSession(null)
      await refreshRuntime()
      break
    case 'saveSettings':
      await writeSettings(request.patch)
      await refreshRuntime()
      void scheduler.tick()
      break
    case 'crawlActiveTab':
      await crawlActiveTab()
      break
  }
  return status()
}

chrome.runtime.onMessage.addListener((message: PopupRequest | WakeMessage, _sender, sendResponse) => {
  if ('target' in message) return false
  if (message.type === 'crawl.wake') {
    void scheduler.tick()
    return false
  }
  handlePopup(message).then(
    (value) => sendResponse({ ok: true, value } satisfies PopupReply),
    (error: unknown) => sendResponse({ ok: false, message: error instanceof Error ? error.message : String(error) } satisfies PopupReply),
  )
  return true
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TICK_ALARM) return
  void refreshTokenIfDue().then(() => scheduler.tick())
})

async function boot(): Promise<void> {
  await closeOrphanedPages()
  await refreshRuntime()
  await refreshTokenIfDue()
  await scheduler.tick()
}

chrome.runtime.onInstalled.addListener(() => void boot())
chrome.runtime.onStartup.addListener(() => void boot())
void boot()
