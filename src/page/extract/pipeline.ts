import { WARNINGS, type CrawlPlan, type CrawlResult } from '@/core/contract'
import { CrawlError } from '@/core/errors'
import { LIMITS } from '@/core/limits'
import { profileLabel, type SiteProfile } from '@/sites/types'
import { materializeImages } from '../ops/images'
import { fitMarkdown, toMarkdown } from './markdown'
import { readMetadata, type PageMetadata } from './metadata'
import { normalizeContent, type NormalizedContent } from './normalize'
import { ACCEPTABLE_SCORE, assessContent, type Assessment } from './quality'
import { defuddleCandidate, manualCandidate, readabilityCandidate, siteCandidate, type Candidate } from './strategies'
import { normalizeDate } from './text'

/** Everything the page can determine. The executor adds timings and its version. */
export type PageDraft = Omit<CrawlResult, 'trace' | 'crawlerVersion'>

interface Scored {
  candidate: Candidate
  content: NormalizedContent
  assessment: Assessment
}

const MIN_SITE_WORDS = 30

function score(candidate: Candidate, url: string, title: string): Scored {
  const content = normalizeContent(candidate.html, url)
  return { candidate, content, assessment: assessContent(content, { title: candidate.title || title }) }
}

/**
 * A profile that names the content completely (an X post) is trusted: a short post is still the
 * whole post, so it is neither replaced by generic parsing nor marked weak for being short.
 */
function trusted(candidate: Candidate, url: string, title: string): Scored {
  const scored = score(candidate, url, title)
  const warnings = scored.assessment.warnings.filter((warning) => warning !== WARNINGS.shortContent)
  return { ...scored, assessment: { ...scored.assessment, score: Math.max(scored.assessment.score, ACCEPTABLE_SCORE), warnings } }
}

function tryCandidate(read: () => Candidate | null, url: string, title: string): Scored | null {
  try {
    const candidate = read()
    return candidate?.html ? score(candidate, url, title) : null
  } catch {
    // Parsers encounter malformed DOM and site-specific markup. One parser's failure should
    // still leave the other parser a chance to read the page.
    return null
  }
}

function acceptable(value: Scored): boolean {
  return value.assessment.score >= ACCEPTABLE_SCORE && !value.assessment.warnings.includes(WARNINGS.linkHeavy)
}

/** Resolve relative assets using the page's declared base, without changing its source URL. */
function contentBase(doc: Document, url: string): string {
  return webImage(doc.querySelector('base[href]')?.getAttribute('href') ?? '', url) || url
}

/**
 * The cascade: the job's own selector, then the site profile, then generic parsing. Readability
 * only runs when Defuddle's result is weak, and the better of the two is kept. Trying candidates
 * in sequence and comparing them is the idea behind Trafilatura's fallbacks.
 */
function chooseCandidate(doc: Document, url: string, plan: CrawlPlan, site: Candidate | null, namesContent: boolean, title: string, warnings: string[]): Scored {
  const base = contentBase(doc, url)
  if (plan.contentSelector) {
    const manual = manualCandidate(doc, url, plan.contentSelector)
    if (manual) return score(manual, base, title)
    throw new CrawlError('STEP_FAILED', `正文选择器没有匹配到内容：${plan.contentSelector}`)
  }

  if (site?.complete && site.html) return trusted(site, base, title)
  const siteFallback = site?.html ? tryCandidate(() => site, base, title) : null
  if (siteFallback && siteFallback.assessment.wordCount >= MIN_SITE_WORDS && acceptable(siteFallback)) return siteFallback
  if (namesContent) warnings.push(WARNINGS.fellBack)

  const first = tryCandidate(() => defuddleCandidate(doc, url), base, title)
  if (first && acceptable(first)) return first
  const second = tryCandidate(() => readabilityCandidate(doc), base, title)
  if (second && acceptable(second)) return second
  // A short article supplied by a profile can be the only readable content in a script-driven
  // page. Keep it as a partial result if neither generic parser found anything better.
  const best = [first, second, siteFallback].filter((value): value is Scored => value !== null)
    .sort((a, b) => b.assessment.score - a.assessment.score)[0]
  if (!best) throw new CrawlError('EMPTY_CONTENT')
  return best
}

function pick(...values: (string | undefined)[]): string {
  return values.find((value) => value?.trim())?.trim() ?? ''
}

function webImage(value: string | undefined, base: string): string {
  if (!value?.trim()) return ''
  try {
    const url = new URL(value, base)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : ''
  } catch {
    return ''
  }
}

function mergeFields(meta: PageMetadata, site: Candidate | null, chosen: Candidate, url: string) {
  const field = (key: 'title' | 'byline' | 'siteName' | 'description' | 'leadImage') => pick(site?.[key], chosen[key], meta[key])
  return {
    title: field('title').slice(0, LIMITS.titleChars),
    byline: field('byline').slice(0, LIMITS.fieldChars),
    siteName: field('siteName').slice(0, LIMITS.fieldChars),
    description: field('description').slice(0, LIMITS.fieldChars),
    leadImage: pick(...[site?.leadImage, chosen.leadImage, meta.leadImage].map((value) => webImage(value, url))).slice(0, LIMITS.fieldChars),
    publishedAt: pick(...[site?.publishedAt, chosen.publishedAt, meta.publishedAt].map((value) => normalizeDate(value ?? '', meta.language))),
  }
}

/** Runs extraction on the current page. The live document is read, not rewritten for strategies. */
export function extractPage(doc: Document, url: string, plan: CrawlPlan, profile: SiteProfile | null, httpStatus = 0): PageDraft {
  materializeImages(doc)
  const meta = readMetadata(doc, url)
  const warnings: string[] = httpStatus >= 400 ? [WARNINGS.httpError] : []
  let site: Candidate | null = null
  let siteFailed = false
  if (profile && !plan.generic) {
    try {
      site = siteCandidate(doc, url, profile, plan)
    } catch (error) {
      // A profile reporting what the page lacks is an answer; anything else is a stale rule.
      if (error instanceof CrawlError) throw error
      siteFailed = true
    }
  }
  const namesContent = Boolean(profile && !plan.generic && (profile.content || siteFailed))
  const { candidate, content, assessment } = chooseCandidate(doc, url, plan, site, namesContent, pick(site?.title, meta.title), warnings)

  const markdown = toMarkdown(content.html, url)
  if (!markdown) throw new CrawlError('EMPTY_CONTENT')
  const fitted = fitMarkdown(markdown)
  if (fitted.truncated) warnings.push(WARNINGS.truncated)

  const fields = mergeFields(meta, site, candidate, contentBase(doc, url))
  return {
    ...fields,
    identity: site?.identity ?? '',
    url,
    canonicalUrl: meta.canonicalUrl,
    host: new URL(url).hostname,
    language: meta.language,
    markdown: fitted.markdown,
    html: plan.keepHtml && content.html.length <= LIMITS.htmlChars ? content.html : '',
    wordCount: assessment.wordCount,
    links: content.links,
    images: content.images,
    structuredData: meta.structuredData,
    items: (site?.items ?? []).slice(0, LIMITS.items),
    extras: site?.extras ?? {},
    extractor: candidate.strategy,
    profile: profile && !plan.generic ? profileLabel(profile) : '',
    qualityScore: assessment.score,
    httpStatus,
    warnings: [...new Set([...warnings, ...assessment.warnings])].slice(0, LIMITS.warnings),
  }
}
