import { describe, expect, it } from 'vitest'
import { classifyInjectionError } from '@/extension/background/agent-bridge'
import { needsRefresh, tokenExpiry } from '@/extension/background/session'
import { sanitizeSettings } from '@/extension/background/settings'

describe('session', () => {
  const token = (exp: number) => `h.${btoa(JSON.stringify({ exp }))}.s`

  it('reads expiry and refreshes ahead of it', () => {
    const now = 1_000_000_000_000
    expect(tokenExpiry(token(now / 1000))).toBe(now)
    expect(needsRefresh(token(now / 1000 + 86_400), now)).toBe(true)
    expect(needsRefresh(token(now / 1000 + 30 * 86_400), now)).toBe(false)
    expect(tokenExpiry('garbage')).toBe(0)
  })
})

describe('settings', () => {
  it('clamps and cleans stored values', () => {
    expect(sanitizeSettings({ concurrency: 99, openMode: 'x' as never, blockedHosts: [' A.com ', 'a.com', ''] })).toMatchObject({
      concurrency: 4,
      openMode: 'window',
      blockedHosts: ['a.com'],
    })
    expect(sanitizeSettings(undefined).blockedHosts).toContain('mail.google.com')
  })
})

describe('classifyInjectionError', () => {
  it.each([
    ['Frame with ID 0 is showing error page', 'NAVIGATION_FAILED'],
    ['No tab with id: 12', 'PAGE_GONE'],
    ['The frame was removed.', 'PAGE_GONE'],
    ['Cannot access contents of the page', 'URL_BLOCKED'],
    ['something else', 'INTERNAL'],
  ])('%s → %s', (message, code) => {
    expect(classifyInjectionError(new Error(message)).code).toBe(code)
  })
})
