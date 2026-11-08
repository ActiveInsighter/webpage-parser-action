import { CrawlError } from '@/core/errors'

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Milliseconds left before `deadline`, capped at `limit`. Throws once the budget is spent. */
export function budget(deadline: number, limit = Number.POSITIVE_INFINITY): number {
  const left = deadline - Date.now()
  if (left <= 0) throw new CrawlError('TIMEOUT')
  return Math.min(left, limit)
}
