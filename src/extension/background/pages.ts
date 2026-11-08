import { CrawlError } from '@/core/errors'
import type { LoadState, PageDriver, PageHandle } from '@/engine/driver'
import { agentBridge } from './agent-bridge'
import type { OpenMode } from './settings'

export interface TabHandle extends Omit<PageHandle, 'call'> {
  readonly tabId: number
}

const OPEN_PAGES_KEY = 'openPages'
const WINDOW_SIZE = { width: 1280, height: 900 }

type OpenPage = { tabId: number; windowId?: number }

async function readOpenPages(): Promise<OpenPage[]> {
  const stored = await chrome.storage.session.get(OPEN_PAGES_KEY)
  return (stored[OPEN_PAGES_KEY] as OpenPage[] | undefined) ?? []
}

async function remember(page: OpenPage): Promise<void> {
  await chrome.storage.session.set({ [OPEN_PAGES_KEY]: [...(await readOpenPages()), page] })
}

async function forget(tabId: number): Promise<void> {
  const pages = await readOpenPages()
  await chrome.storage.session.set({ [OPEN_PAGES_KEY]: pages.filter((page) => page.tabId !== tabId) })
}

async function closePage({ tabId, windowId }: OpenPage): Promise<void> {
  try {
    if (windowId !== undefined) await chrome.windows.remove(windowId)
    else await chrome.tabs.remove(tabId)
  } catch {
    // Already closed by the user or the browser.
  }
}

/**
 * Pages left by a worker that died mid-job. Jobs live in worker memory, so at startup every
 * remembered page is an orphan; the server re-queues their jobs when the lease runs out.
 */
export async function closeOrphanedPages(): Promise<void> {
  const pages = await readOpenPages()
  if (!pages.length) return
  await Promise.all(pages.map(closePage))
  await chrome.storage.session.remove(OPEN_PAGES_KEY)
}

function waitForComplete(tabId: number, timeoutMs: number): Promise<LoadState> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.tabs.onRemoved.removeListener(onRemoved)
    }
    const onUpdated = (id: number, change: { status?: string }) => {
      if (id !== tabId || change.status !== 'complete') return
      stop()
      resolve('complete')
    }
    const onRemoved = (id: number) => {
      if (id !== tabId) return
      stop()
      reject(new CrawlError('PAGE_GONE'))
    }
    const timer = setTimeout(() => {
      stop()
      resolve('timeout')
    }, timeoutMs)
    // Listen first, then read: a load finishing in between cannot be missed.
    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.tabs.onRemoved.addListener(onRemoved)
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status !== 'complete' || tab.url === 'about:blank') return
        stop()
        resolve('complete')
      },
      () => {
        stop()
        reject(new CrawlError('PAGE_GONE'))
      },
    )
  })
}

async function createTab(url: string, mode: OpenMode): Promise<OpenPage> {
  if (mode === 'tab') {
    const tab = await chrome.tabs.create({ url, active: false })
    if (tab.id === undefined) throw new CrawlError('NAVIGATION_FAILED')
    return { tabId: tab.id }
  }
  const window = await chrome.windows.create({ url, focused: false, type: 'normal', ...WINDOW_SIZE })
  const tabId = window?.tabs?.[0]?.id
  if (!window || window.id === undefined || tabId === undefined) throw new CrawlError('NAVIGATION_FAILED')
  return { tabId, windowId: window.id }
}

export async function openPage(url: string, mode: OpenMode): Promise<TabHandle> {
  const page = await createTab(url, mode)
  await remember(page)
  return {
    tabId: page.tabId,
    loaded: (timeoutMs) => waitForComplete(page.tabId, timeoutMs),
    async url() {
      try {
        const tab = await chrome.tabs.get(page.tabId)
        return tab.url ?? tab.pendingUrl ?? ''
      } catch (cause) {
        throw new CrawlError('PAGE_GONE', undefined, { cause })
      }
    },
    async close() {
      await closePage(page)
      await forget(page.tabId)
    },
  }
}

/**
 * The extension's PageDriver: one way to open a page, a tab in the owner's own browser, signed in
 * wherever they are. The agent runs in the tab's isolated world.
 */
export function createChromeDriver(openMode: () => Promise<OpenMode>): PageDriver {
  return {
    routes: () => ['live'],
    async open(url) {
      const tab = await openPage(url, await openMode())
      return {
        loaded: tab.loaded,
        url: tab.url,
        close: tab.close,
        call: (method, plan) => agentBridge.call(tab.tabId, method, plan),
      }
    },
  }
}
