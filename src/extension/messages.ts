import type { Settings } from '@/extension/background/settings'
import type { SessionUser } from '@/extension/background/session'

/** Popup → background. */
export type PopupRequest =
  | { type: 'status' }
  | { type: 'signIn'; email: string; password: string }
  | { type: 'signOut' }
  | { type: 'saveSettings'; patch: Partial<Settings> }
  | { type: 'crawlActiveTab' }

export interface StatusReply {
  user: SessionUser | null
  settings: Settings
  running: number
  lastError: string
  remoteUrl: string
  version: string
}

export type PopupReply<T = StatusReply> = { ok: true; value: T } | { ok: false; message: string }

/** Background → offscreen document. */
export type RealtimeCommand = { target: 'offscreen'; type: 'realtime.connect'; baseUrl: string; token: string }

/** Offscreen document → background: work may be waiting. */
export type WakeMessage = { type: 'crawl.wake' }
