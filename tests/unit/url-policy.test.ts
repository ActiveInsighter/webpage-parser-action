import { describe, expect, it } from 'vitest'
import { checkUrl, cleanLink, hostMatches, isLocalHost } from '@/core/url-policy'

const open = { blockedHosts: [] }

describe('checkUrl', () => {
  it('accepts public http(s) pages and normalises them', () => {
    expect(checkUrl('  https://Example.com/a?b=1#c ', open)).toEqual({ ok: true, url: 'https://example.com/a?b=1#c', host: 'example.com' })
    expect(checkUrl('http://8.8.8.8/x', open).ok).toBe(true)
  })

  it.each([
    'chrome://settings',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'chrome-extension://abc/popup.html',
    'ftp://example.com/',
    'not a url',
  ])('rejects non-web input: %s', (url) => {
    expect(checkUrl(url, open).ok).toBe(false)
  })

  it.each([
    'http://localhost:8080/',
    'http://127.0.0.1:40197/json/version',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://127.1/',
    'http://0.0.0.0/',
    'http://10.1.2.3/',
    'http://172.20.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://printer/',
    'http://nas.local/',
    'http://db.internal/',
  ])('rejects local and private targets: %s', (url) => {
    expect(checkUrl(url, open).ok).toBe(false)
  })

  it('rejects embedded credentials and oversized input', () => {
    expect(checkUrl('https://user:pw@example.com/', open).ok).toBe(false)
    expect(checkUrl(`https://example.com/${'a'.repeat(3000)}`, open).ok).toBe(false)
  })

  it('honours the user block list, subdomains included', () => {
    const policy = { blockedHosts: ['mail.google.com', '*.bank.example'] }
    expect(checkUrl('https://mail.google.com/mail/u/0', policy).ok).toBe(false)
    expect(checkUrl('https://x.mail.google.com/', policy).ok).toBe(false)
    expect(checkUrl('https://online.bank.example/', policy).ok).toBe(false)
    expect(checkUrl('https://bank.example/', policy).ok).toBe(true)
    expect(checkUrl('https://notmail.google.com/', policy).ok).toBe(true)
  })

  it('opens local targets only when a test build asks for it', () => {
    expect(checkUrl('http://127.0.0.1:4173/a', { ...open, allowLocal: true }).ok).toBe(true)
  })
})

describe('helpers', () => {
  it('does not treat public names as local', () => {
    expect(isLocalHost('example.com')).toBe(false)
    expect(isLocalHost('172.32.0.1')).toBe(false)
    expect(isLocalHost('[2606:4700::1111]')).toBe(false)
  })

  it('matches block patterns on label boundaries', () => {
    expect(hostMatches('a.example.com', 'example.com')).toBe(true)
    expect(hostMatches('badexample.com', 'example.com')).toBe(false)
    expect(hostMatches('example.com', '*.example.com')).toBe(false)
  })

  it('strips tracking parameters and keeps the rest', () => {
    expect(cleanLink('https://a.com/p?id=1&utm_source=x&fbclid=y#t')).toBe('https://a.com/p?id=1#t')
    expect(cleanLink('nonsense')).toBe('nonsense')
  })

  it('unwraps outbound interstitials, but only to web URLs', () => {
    expect(cleanLink('https://link.zhihu.com/?target=https%3A//github.com/a%3Futm_source%3Dx')).toBe('https://github.com/a')
    expect(cleanLink('https://link.juejin.cn/?target=https%3A%2F%2Fexample.com%2Fp')).toBe('https://example.com/p')
    expect(cleanLink('https://link.zhihu.com/?target=javascript%3Aalert(1)')).toBe('https://link.zhihu.com/?target=javascript%3Aalert(1)')
    expect(cleanLink('https://example.com/?target=https%3A//a.dev/')).toBe('https://example.com/?target=https%3A//a.dev/')
  })
})
