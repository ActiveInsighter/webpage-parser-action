import type { RealtimeCommand } from '@/extension/messages'

const DOCUMENT = 'offscreen.html'

/** Keeps the offscreen realtime connection in step with the session; null closes it. */
export async function syncRealtime(connection: { baseUrl: string; token: string } | null): Promise<void> {
  const open = await chrome.offscreen.hasDocument()
  if (!connection) {
    if (open) await chrome.offscreen.closeDocument()
    return
  }
  if (!open) {
    await chrome.offscreen.createDocument({
      url: DOCUMENT,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Hold the realtime connection that announces new crawl jobs.',
    })
  }
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'realtime.connect', ...connection } satisfies RealtimeCommand)
}
