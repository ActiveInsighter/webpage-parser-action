import * as z from 'zod/mini'
import { ERROR_CODES, type ErrorCode } from './errors'
import { LIMITS, TIMING } from './limits'

/**
 * The shapes that cross a boundary: job rows from PocketBase (remote input, always parsed), the
 * declarative plan handed to the page agent, and the result sent back. Both executors use them
 * unchanged. Keep these in step with AnyWorkflow-workers: `pb_migrations/*_unified_crawl.js`,
 * `pb_hooks/crawl.js` and `pb_hooks/crawl_validation.js` (tests/unit/contract.test.ts reads the
 * vendored copy). zod/mini keeps the extension's service worker small.
 */
const selector = z.string().check(z.trim(), z.minLength(1), z.maxLength(LIMITS.selectorChars))

export const RUNNERS = ['cloud', 'browser'] as const
export type Runner = (typeof RUNNERS)[number]

/** How the cloud executor fetches a page: plain HTTP rendered without scripts, or a browser. */
export const TRANSPORTS = ['auto', 'http', 'browser'] as const
export type Transport = (typeof TRANSPORTS)[number]

/** Per-job overrides typed into Remote. Selectors and numbers only: a job can never carry code. */
export const crawlOptionsSchema = z.object({
  waitFor: z.optional(selector),
  contentSelector: z.optional(selector),
  removeSelectors: z.optional(z.array(selector).check(z.maxLength(LIMITS.selectorsPerList))),
  scroll: z.optional(z.boolean()),
  keepHtml: z.optional(z.boolean()),
  timeoutSeconds: z.optional(
    z.int().check(z.minimum(TIMING.minJobTimeoutMs / 1000), z.maximum(TIMING.maxJobTimeoutMs / 1000)),
  ),
  /** Skip every site profile, to compare against plain generic parsing. */
  generic: z.optional(z.boolean()),
  /** For pages that list entries (an X profile): only the one the link names, or all visible. */
  scope: z.optional(z.enum(['target', 'visible'])),
  maxItems: z.optional(z.int().check(z.minimum(1), z.maximum(LIMITS.maxItemsOption))),
  /** Cloud only; the browser executor always opens the live page. */
  transport: z.optional(z.enum(TRANSPORTS)),
})

export type CrawlOptions = z.infer<typeof crawlOptionsSchema>

export const crawlJobSchema = z.object({
  id: z.string().check(z.minLength(1)),
  owner: z.string().check(z.minLength(1)),
  url: z.string().check(z.minLength(1), z.maxLength(LIMITS.urlChars)),
  runner: z.enum(RUNNERS),
  category: z._default(z.string(), ''),
  options: z.pipe(z.transform((value) => value ?? {}), crawlOptionsSchema),
  attempts: z._default(z.int().check(z.minimum(0)), 0),
})

export type CrawlJob = z.infer<typeof crawlJobSchema>

/**
 * One step of page preparation, interpreted by the agent. Steps come only from site profiles in
 * this repository and from the plan builder: job rows reach them through the fields above.
 */
export type Step =
  | { op: 'wait'; selector: string; timeoutMs?: number; optional?: boolean }
  | { op: 'sleep'; ms: number }
  | { op: 'settle'; quietMs?: number; timeoutMs?: number; minChars?: number }
  | { op: 'scroll'; maxRounds?: number; pauseMs?: number }
  | { op: 'click'; selector: string; all?: boolean; optional?: boolean; pauseMs?: number }
  | { op: 'remove'; selector: string }

export interface CrawlPlan {
  steps: Step[]
  contentSelector?: string
  keepHtml: boolean
  generic: boolean
  deadline: number
  /** The URL the job asked for: tells a login redirect from a normal one, and names a target. */
  requestedUrl: string
  scope: 'target' | 'visible'
  maxItems: number
}

export const WARNINGS = {
  loadTimeout: 'load_timeout',
  shortContent: 'short_content',
  linkHeavy: 'link_heavy',
  noTitle: 'no_title',
  truncated: 'truncated',
  fellBack: 'site_profile_fell_back',
  stepSkipped: 'step_skipped',
  httpError: 'http_error',
  routeFellBack: 'route_fell_back',
} as const

export type ImageRef = { src: string; alt: string }
export type LinkRef = { href: string; text: string }
/** A structured entry a profile read off the page, such as one post. Plain JSON. */
export type CrawlItem = Record<string, unknown>

/** What a crawl produces and `complete` stores. Field names match `aw_crawl_documents`. */
export interface CrawlResult {
  /** The profile's own identity for the content (`x:status:…`); empty means the URL is. */
  identity: string
  url: string
  canonicalUrl: string
  host: string
  title: string
  byline: string
  siteName: string
  language: string
  description: string
  publishedAt: string
  leadImage: string
  markdown: string
  html: string
  wordCount: number
  items: CrawlItem[]
  links: LinkRef[]
  images: ImageRef[]
  structuredData: unknown[]
  extras: Record<string, unknown>
  extractor: string
  profile: string
  qualityScore: number
  warnings: string[]
  httpStatus: number
  /** How the crawl went: elapsed ms at each phase, what each step did, how the page was opened. */
  trace: { phases: Record<string, number>; steps: string[]; route: string; runner: Runner }
  crawlerVersion: string
}

/** The agent's answer: never a throw, so errors keep their code across the page boundary. */
export type AgentReply<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string }

export function agentFailure(code: ErrorCode, message?: string): AgentReply<never> {
  return { ok: false, code, message: message || ERROR_CODES[code].message }
}
