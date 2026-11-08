import { hostMatches } from '@/core/url-policy'
import type { SiteProfile } from './types'

function matches(profile: SiteProfile, url: URL): boolean {
  const host = url.hostname.toLowerCase()
  if (!profile.hosts.some((pattern) => hostMatches(host, pattern))) return false
  return !profile.paths || profile.paths.some((path) => path.test(url.pathname))
}

/** The first matching profile, so a narrower entry listed earlier wins over a broader one. */
export function findProfile(profiles: readonly SiteProfile[], rawUrl: string): SiteProfile | null {
  try {
    const url = new URL(rawUrl)
    return profiles.find((profile) => matches(profile, url)) ?? null
  } catch {
    return null
  }
}
