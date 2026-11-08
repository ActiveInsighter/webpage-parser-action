import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import type { CrawlPlan } from '@/core/contract'

export function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests/fixtures', name), 'utf8')
}

export function dom(html: string, url = 'https://blog.example.com/posts/event-loop'): Document {
  return new JSDOM(html, { url }).window.document
}

export function plan(overrides: Partial<CrawlPlan> = {}): CrawlPlan {
  return {
    steps: [],
    keepHtml: false,
    generic: false,
    deadline: Date.now() + 10_000,
    requestedUrl: 'https://blog.example.com/posts/event-loop',
    scope: 'target',
    maxItems: 1,
    ...overrides,
  }
}
