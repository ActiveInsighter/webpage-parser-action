import type { CrawlItem, Step, Transport } from '@/core/contract'
import type { ErrorCode } from '@/core/errors'

/**
 * A site profile tunes capture for one site. Most need only data: where the content lives, how to
 * read each field, and what to do before reading. Each list is tried in order and the first
 * non-empty match wins, so a profile can list old and new layouts side by side. When nothing
 * matches, the generic strategies take over, so an outdated profile degrades instead of failing.
 */

/** A CSS selector, read as text; or a selector and the attribute to read. */
export type FieldRule = string | readonly [selector: string, attribute: string]

export interface FieldRules {
  title?: readonly FieldRule[]
  byline?: readonly FieldRule[]
  publishedAt?: readonly FieldRule[]
  siteName?: readonly FieldRule[]
  description?: readonly FieldRule[]
  leadImage?: readonly FieldRule[]
}

export interface ContentRules {
  /** Candidates for the content container, tried in order. */
  selectors: readonly string[]
  /** Elements inside the page to drop before reading. Applied to the live page as a step. */
  clean?: readonly string[]
}

export interface BlockerRule {
  code: Extract<ErrorCode, 'LOGIN_REQUIRED' | 'CAPTCHA' | 'ACCESS_DENIED' | 'NOT_FOUND'>
  selector?: string
  /** Tested against the final URL. */
  url?: RegExp
  /** Tested against the visible body text. */
  text?: RegExp
  message?: string
}

export interface SiteFields {
  title?: string
  byline?: string
  publishedAt?: string
  siteName?: string
  description?: string
  leadImage?: string
  /** Replaces the selected container's HTML. */
  html?: string
  /** Site-specific values, stored as they are in `extras`. */
  extras?: Record<string, unknown>
  /** Structured entries (posts), stored in `items`. */
  items?: CrawlItem[]
  /** The content's own identity, so a re-crawl of another URL for it updates one document. */
  identity?: string
  /**
   * `html` is the whole content, built from data the profile matched exactly (an X post). It is
   * used as it is: generic parsing never replaces it, and a short one is not marked weak.
   */
  complete?: boolean
}

export interface SiteContext {
  readonly document: Document
  readonly url: URL
  /** Where the job pointed, before redirects: names the entry a `target` scope wants. */
  readonly requestedUrl: URL
  readonly scope: 'target' | 'visible'
  readonly maxItems: number
  text(selector: string): string
  attr(selector: string, attribute: string): string
  html(selector: string): string
  all(selector: string): Element[]
  meta(name: string): string
  jsonLd(type?: string): Record<string, unknown> | null
}

export interface SiteProfile {
  id: string
  /** Bump when rules change; each result records `id@version`, so captures trace to their rules. */
  version: number
  /** Exact hosts; a leading `*.` matches subdomains. */
  hosts: readonly string[]
  /** Narrows the match to these URL paths. */
  paths?: readonly RegExp[]
  /** Runs after the page loads, before reading. */
  prepare?: readonly Step[]
  /** Whole-job budget for slow sites. A job's own `timeoutSeconds` still wins. */
  timeoutSeconds?: number
  /** How the cloud executor opens this site by default; a job's own `transport` still wins. */
  transport?: Transport
  content?: ContentRules
  fields?: FieldRules
  blockers?: readonly BlockerRule[]
  /**
   * The escape hatch for what selectors cannot express. Runs in the page, after the rules. It may
   * throw a CrawlError (TARGET_NOT_FOUND) when the page lacks what the job asked for.
   */
  extract?: (context: SiteContext) => SiteFields | null
}

export function defineSite(profile: SiteProfile): SiteProfile {
  return profile
}

export function profileLabel(profile: SiteProfile): string {
  return `${profile.id}@${profile.version}`
}
