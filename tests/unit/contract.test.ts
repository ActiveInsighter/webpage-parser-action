import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { crawlOptionsSchema, type CrawlResult } from '@/core/contract'
import { ERROR_CODES } from '@/core/errors'
import { ACCEPTABLE_SCORE, LIMITS } from '@/core/limits'
import { isLocalHost } from '@/core/url-policy'

/**
 * The server half of the contract, as vendored from AnyWorkflow-workers by
 * scripts/sync-pocketbase.mjs. Both sides must agree on these, or a job the server accepts is one
 * the crawler refuses (or the other way round).
 */
const require = createRequire(import.meta.url)
const server = require(join(process.cwd(), 'tests/fixtures/pocketbase/pb_hooks/crawl_validation.js')) as {
  ERROR_CODES: Record<string, boolean>
  OPTION_KEYS: string[]
  ACCEPTABLE_SCORE: number
  isLocalHost(host: string): boolean
  normalizeOptions(raw: unknown): Record<string, unknown>
  normalizeResult(raw: unknown): Record<string, unknown>
}

describe('contract with the server', () => {
  it('knows the same error codes and retries the same ones', () => {
    const serverOnly = ['LEASE_LOST', 'NO_WORKER']
    expect(Object.keys(server.ERROR_CODES).filter((code) => !serverOnly.includes(code)).sort()).toEqual(Object.keys(ERROR_CODES).sort())
    for (const [code, spec] of Object.entries(ERROR_CODES)) expect([code, server.ERROR_CODES[code]]).toEqual([code, spec.retryable])
  })

  it('takes the same options, and what the server keeps the crawler parses', () => {
    expect([...server.OPTION_KEYS].sort()).toEqual(Object.keys(crawlOptionsSchema.shape).sort())
    const stored = server.normalizeOptions({ waitFor: 'main', removeSelectors: ['.ad'], scroll: true, timeoutSeconds: 280, scope: 'visible', maxItems: LIMITS.maxItemsOption, transport: 'auto' })
    expect(crawlOptionsSchema.safeParse(stored).success).toBe(true)
  })

  it('judges hosts alike', () => {
    for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '[::1]', 'printer.local', 'intranet', 'example.com', 'x.com', '8.8.8.8']) {
      expect([host, server.isLocalHost(host)]).toEqual([host, isLocalHost(host)])
    }
  })

  it('keeps every field a result carries, and judges quality on the same line', () => {
    expect(server.ACCEPTABLE_SCORE).toBe(ACCEPTABLE_SCORE)
    const result: Omit<CrawlResult, 'trace'> = {
      identity: 'x:status:1', url: 'https://x.com/a/status/1', canonicalUrl: '', host: 'x.com', title: 't', byline: '', siteName: 'X',
      language: '', description: '', publishedAt: '', leadImage: '', markdown: 'm', html: '', wordCount: 1, items: [{ id: '1' }],
      links: [], images: [], structuredData: [], extras: {}, extractor: 'site:x', profile: 'x@1', qualityScore: 40, warnings: [],
      httpStatus: 200, crawlerVersion: '0.2.0',
    }
    expect(Object.keys(server.normalizeResult({ ...result, trace: {} })).sort()).toEqual([...Object.keys(result), 'trace'].sort())
  })
})
