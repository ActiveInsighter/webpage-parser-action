import { TIMING } from '@/core/limits'
import type { CrawlApi } from './api'

export interface LeaseEvents {
  onCancel(): void
  onLost(): void
}

export interface Lease {
  /** Publishes the job's phase, which also renews the lease. */
  report(status: string): Promise<void>
  stop(): void
}

/**
 * Keeps a claimed job alive on the server and carries signals back: `cancelRequested` for a
 * cancel from Remote, `accepted: false` when the server gave the job to someone else. A failed
 * renewal is only a network blip until the lease really runs out, so it is retried quietly.
 */
export function keepLease(api: CrawlApi, jobId: string, leaseId: string, events: LeaseEvents): Lease {
  let stopped = false

  async function renew(status?: string): Promise<void> {
    if (stopped) return
    try {
      const reply = await api.renew(jobId, leaseId, status)
      if (stopped) return
      if (!reply.accepted) events.onLost()
      else if (reply.cancelRequested) events.onCancel()
    } catch {
      // The next tick tries again; the server decides when the lease has actually ended.
    }
  }

  const timer = setInterval(() => void renew(), TIMING.leaseRenewMs)
  return {
    report: renew,
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}
