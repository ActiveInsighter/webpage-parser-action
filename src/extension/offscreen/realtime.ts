import type { RealtimeCommand, WakeMessage } from '@/extension/messages'

/**
 * PocketBase realtime in the one context that can hold it. A service worker has no EventSource
 * and is not allowed to stay alive, so this document keeps the stream open and wakes the worker
 * when a job is queued. Purely a latency improvement: if it fails, the alarm still finds the job.
 */
const TOPIC = 'aw_crawl_jobs/*'

let source: EventSource | null = null
let connection = ''

function wake(): void {
  void chrome.runtime.sendMessage({ type: 'crawl.wake' } satisfies WakeMessage).catch(() => {})
}

async function subscribe(baseUrl: string, token: string, clientId: string): Promise<void> {
  await fetch(`${baseUrl}/api/realtime`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ clientId, subscriptions: [TOPIC] }),
  })
  // Anything queued while the stream was down would otherwise wait for the next alarm.
  wake()
}

function connect({ baseUrl, token }: RealtimeCommand): void {
  const key = `${baseUrl}\n${token}`
  if (key === connection) return
  connection = key
  source?.close()
  source = new EventSource(`${baseUrl}/api/realtime`)
  // Fires on every reconnect with a new client id, and each one needs subscribing again.
  source.addEventListener('PB_CONNECT', (event) => {
    const { clientId } = JSON.parse((event as MessageEvent<string>).data) as { clientId: string }
    subscribe(baseUrl, token, clientId).catch(() => {})
  })
  source.addEventListener(TOPIC, (event) => {
    const { record } = JSON.parse((event as MessageEvent<string>).data) as { record?: { status?: string; runner?: string } }
    // Cloud jobs of this owner arrive here too; the cloud executor takes those.
    if (record?.status === 'queued' && record.runner === 'browser') wake()
  })
}

chrome.runtime.onMessage.addListener((message: RealtimeCommand) => {
  if (message.target === 'offscreen' && message.type === 'realtime.connect') connect(message)
})
