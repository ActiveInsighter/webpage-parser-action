import { LIMITS } from './limits'

/**
 * Which URLs an executor will open. A job row is remote input, and the browser executor runs in a
 * browser signed in to real accounts, so this is the last line of defence: only public http(s)
 * pages, never local services (the browser's own debugging port included), and never a host the
 * user blocked. Parsing goes through URL so decimal, hex and short IPv4 forms are normalised
 * before the checks run. `crawl_validation.js` applies the same rules when a job is created.
 */
export type UrlVerdict = { ok: true; url: string; host: string } | { ok: false; reason: string }

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa']

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(host)
  if (!match) return false
  const a = Number(match[1])
  const b = Number(match[2])
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function isPrivateIpv6(host: string): boolean {
  if (!host.startsWith('[')) return false
  const address = host.slice(1, -1).toLowerCase()
  if (address === '::' || address === '::1') return true
  if (/^f[cd]/u.test(address) || /^fe[89ab]/u.test(address)) return true
  // IPv4-mapped, which URL prints in hex (::ffff:7f00:1).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address)
  if (!mapped) return false
  const high = Number.parseInt(mapped[1]!, 16)
  const low = Number.parseInt(mapped[2]!, 16)
  return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
}

export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '')
  return (
    host === 'localhost' ||
    !host.includes('.') && !host.startsWith('[') ||
    LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host)
  )
}

/** `example.com` also covers `www.example.com`; `*.example.com` covers subdomains only. */
export function hostMatches(host: string, pattern: string): boolean {
  const target = host.toLowerCase()
  const rule = pattern.trim().toLowerCase()
  if (!rule) return false
  if (rule.startsWith('*.')) return target.endsWith(rule.slice(1))
  return target === rule || target.endsWith(`.${rule}`)
}

export interface UrlPolicy {
  blockedHosts: readonly string[]
  /** Test builds point at a local fixture server. Never set in a production build. */
  allowLocal?: boolean
}

export function checkUrl(raw: string, policy: UrlPolicy): UrlVerdict {
  if (raw.length > LIMITS.urlChars) return { ok: false, reason: '地址过长' }
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, reason: '地址格式无效' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: '只支持 http 和 https 页面' }
  if (url.username || url.password) return { ok: false, reason: '地址不能包含账号或密码' }
  const host = url.hostname.toLowerCase()
  if (!policy.allowLocal && isLocalHost(host)) return { ok: false, reason: '不能抓取本机或内网地址' }
  if (policy.blockedHosts.some((pattern) => hostMatches(host, pattern))) return { ok: false, reason: '该域名已被屏蔽' }
  return { ok: true, url: url.href, host }
}

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_[ce]id|igshid|spm|vd_source|from_source)$/iu

/** Outbound-link interstitials that carry the real address in a query parameter. */
const LINK_WRAPPERS: Record<string, string> = {
  'link.zhihu.com': 'target',
  'link.juejin.cn': 'target',
  'link.csdn.net': 'target',
  'www.jianshu.com': 'url',
  'gitee.com': 'target',
}

function unwrap(url: URL): URL {
  const parameter = LINK_WRAPPERS[url.hostname]
  const target = parameter ? url.searchParams.get(parameter) : null
  if (!target) return url
  try {
    const inner = new URL(target)
    return inner.protocol === 'http:' || inner.protocol === 'https:' ? inner : url
  } catch {
    return url
  }
}

/** A link as its author meant it: no interstitial, no tracking. Unparseable input is unchanged. */
export function cleanLink(raw: string): string {
  try {
    const url = unwrap(new URL(raw))
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key)
    }
    return url.href
  } catch {
    return raw
  }
}
