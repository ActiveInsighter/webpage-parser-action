export interface SessionUser {
  id: string
  email: string
  name: string
}

export interface Session {
  token: string
  user: SessionUser
}

const KEY = 'session'

export async function readSession(): Promise<Session | null> {
  const stored = await chrome.storage.local.get(KEY)
  return (stored[KEY] as Session | undefined) ?? null
}

export async function writeSession(session: Session | null): Promise<void> {
  if (session) await chrome.storage.local.set({ [KEY]: session })
  else await chrome.storage.local.remove(KEY)
}

/** The token's expiry in epoch ms, or 0 when it cannot be read. */
export function tokenExpiry(token: string): number {
  try {
    const payload = token.split('.')[1]
    if (!payload) return 0
    const claims = JSON.parse(atob(payload.replace(/-/gu, '+').replace(/_/gu, '/'))) as { exp?: unknown }
    return typeof claims.exp === 'number' ? claims.exp * 1000 : 0
  } catch {
    return 0
  }
}

const REFRESH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

/** Refresh ahead of expiry. Remote's sessions run for days, and a capture must not die mid-queue. */
export function needsRefresh(token: string, now: number): boolean {
  return tokenExpiry(token) - now < REFRESH_WINDOW_MS
}
