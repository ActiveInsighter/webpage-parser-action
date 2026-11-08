import type { BlockerRule, SiteProfile } from '@/sites/types'
import { CrawlError } from '@/core/errors'
import { cleanText, queryFirst, visibleText } from './ops/dom'

/**
 * Tells a real page from a wall. A capture only reports these, and a person resolves them in the
 * browser. Generic rules all require a nearly empty page, so an article about CAPTCHAs is safe.
 */
const SPARSE_PAGE_CHARS = 800
const CHALLENGE_SELECTORS = [
  '#challenge-form',
  '#cf-challenge-running',
  'script[src*="/cdn-cgi/challenge-platform/"]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha.com"]',
  'iframe[src*="challenges.cloudflare.com"]',
  '.g-recaptcha',
  '.h-captcha',
].join(',')
const CHALLENGE_TITLE = /^(just a moment|attention required|请稍候|安全验证|人机验证|verify you are human)/iu
const CHALLENGE_TEXT = /环境异常|完成验证后|安全验证|人机验证|滑动验证|拖动滑块|verify you are (?:a )?human|unusual traffic/iu
const LOGIN_PATH = /\/(?:log-?in|sign-?in|passport|sso|auth(?:orize)?)(?:[/?#.]|$)/iu

function matchesRule(rule: BlockerRule, doc: Document, url: string, text: string): boolean {
  if (rule.url && !rule.url.test(url)) return false
  if (rule.selector && !queryFirst(rule.selector, doc)) return false
  if (rule.text && !rule.text.test(text)) return false
  return Boolean(rule.url || rule.selector || rule.text)
}

export function detectBlocker(doc: Document, url: string, requestedUrl: string, profile: SiteProfile | null, httpStatus = 0): CrawlError | null {
  const text = visibleText(doc)

  for (const rule of profile?.blockers ?? []) {
    if (matchesRule(rule, doc, url, text)) return new CrawlError(rule.code, rule.message)
  }

  const sparse = text.length < SPARSE_PAGE_CHARS
  if (sparse && (doc.querySelector(CHALLENGE_SELECTORS) || CHALLENGE_TITLE.test(cleanText(doc.title)) || CHALLENGE_TEXT.test(text))) {
    return new CrawlError('CAPTCHA')
  }
  const movedToLogin = LOGIN_PATH.test(new URL(url).pathname) && !LOGIN_PATH.test(new URL(requestedUrl).pathname)
  if (doc.querySelector('input[type="password"]') && (movedToLogin || sparse)) return new CrawlError('LOGIN_REQUIRED')
  if (sparse && (httpStatus === 401 || httpStatus === 403)) return new CrawlError('ACCESS_DENIED')
  return null
}
