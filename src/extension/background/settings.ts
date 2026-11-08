export type OpenMode = 'window' | 'tab'

export interface Settings {
  /** Claim new jobs. Off pauses the extension without signing out. */
  enabled: boolean
  concurrency: number
  /**
   * `window` gives each capture the active tab of its own unfocused window, so the page renders
   * normally. `tab` is quieter, but Chrome throttles hidden tabs and lazy content may not load.
   */
  openMode: OpenMode
  blockedHosts: string[]
}

/** Account, mail and payment hosts stay closed by default, whatever a job row asks for. */
export const DEFAULT_BLOCKED_HOSTS = [
  'accounts.google.com',
  'myaccount.google.com',
  'mail.google.com',
  'login.microsoftonline.com',
  'account.microsoft.com',
  'outlook.live.com',
  'outlook.office.com',
  'mail.qq.com',
  'mail.163.com',
  'pay.weixin.qq.com',
  'alipay.com',
  'paypal.com',
  '1password.com',
  'bitwarden.com',
  'pb.any1.tech',
  'awremote.any1.tech',
]

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  concurrency: 2,
  openMode: 'window',
  blockedHosts: DEFAULT_BLOCKED_HOSTS,
}

export const MAX_CONCURRENCY = 4
const KEY = 'settings'

export function sanitizeSettings(value: Partial<Settings> | undefined): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...value }
  return {
    enabled: Boolean(merged.enabled),
    concurrency: Math.min(MAX_CONCURRENCY, Math.max(1, Math.trunc(Number(merged.concurrency)) || DEFAULT_SETTINGS.concurrency)),
    openMode: merged.openMode === 'tab' ? 'tab' : 'window',
    blockedHosts: [...new Set((merged.blockedHosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean))],
  }
}

export async function readSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY)
  return sanitizeSettings(stored[KEY] as Partial<Settings> | undefined)
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await readSettings()), ...patch })
  await chrome.storage.local.set({ [KEY]: next })
  return next
}

/** This browser's stable identity, so Remote can tell two installs apart. */
export async function workerId(): Promise<string> {
  const stored = await chrome.storage.local.get('workerId')
  if (typeof stored.workerId === 'string') return stored.workerId
  const id = crypto.randomUUID()
  await chrome.storage.local.set({ workerId: id })
  return id
}
