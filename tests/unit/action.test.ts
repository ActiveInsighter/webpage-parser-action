import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPage } from '@/action/http-fetch'
import { publicLog } from '@/action/log'

const policy = { blockedHosts: [] }
const options = { policy, userAgent: 'test', timeoutMs: 1_000, retries: 0 }

function reply(status: number, headers: Record<string, string> = {}, body = '<p>ok</p>'): Response {
  return new Response(status >= 300 && status < 400 ? null : body, { status, headers })
}

describe('cloud HTTP reads', () => {
  it('follows redirects by hand and refuses one into a private address', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === 'https://example.com/a' ? reply(302, { location: 'http://169.254.169.254/latest/meta-data/' }) : reply(200))
    await expect(fetchPage('https://example.com/a', { ...options, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({ code: 'URL_BLOCKED' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('returns where the page landed, its status and type', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) =>
      url === 'https://example.com/a' ? reply(301, { location: '/b' }) : reply(200, { 'content-type': 'text/html; charset=utf-8' }))
    const page = await fetchPage('https://example.com/a', { ...options, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(page).toMatchObject({ url: 'https://example.com/b', status: 200, contentType: 'text/html' })
    expect(page.body.toString()).toBe('<p>ok</p>')
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' })
  })

  it('stops after five redirects and retries a transient status', async () => {
    let hops = 0
    const loop = vi.fn(async () => reply(302, { location: `/r${++hops}` }))
    await expect(fetchPage('https://example.com/', { ...options, fetchImpl: loop as unknown as typeof fetch })).rejects.toMatchObject({ code: 'NAVIGATION_FAILED' })
    let calls = 0
    const flaky = vi.fn(async () => (++calls === 1 ? reply(503) : reply(200)))
    vi.useFakeTimers()
    const pending = fetchPage('https://example.com/', { ...options, retries: 1, fetchImpl: flaky as unknown as typeof fetch })
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await pending).status).toBe(200)
    vi.useRealTimers()
  })
})

describe('public log', () => {
  afterEach(() => void vi.restoreAllMocks())
  it('prints ids, codes and counts, never a URL or a message', () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line))
    publicLog('crawl.failed', { job: 'abc123', code: 'STEP_FAILED', message: '等待元素超时：#secret', url: 'https://private.example/x', route: 'http' })
    publicLog('crawl.done', { job: 'https://leak.example/a' })
    expect(lines).toEqual(['{"event":"crawl.failed","job":"abc123","code":"STEP_FAILED","route":"http"}', '{"event":"crawl.done"}'])
  })
})
