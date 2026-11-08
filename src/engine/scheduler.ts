export interface SchedulerOptions<Job> {
  /** The next job, or null when there is none. */
  claim(): Promise<Job | null>
  run(job: Job): Promise<void>
  concurrency(): Promise<number>
  onChange?(running: number): void
  onError?(error: unknown): void
}

/**
 * Fills free slots with claimed jobs. Ticks arrive from alarms, realtime wake-ups and finishing
 * jobs; overlapping ticks collapse into one more pass, so two claims never race for one slot.
 */
export function createScheduler<Job>(options: SchedulerOptions<Job>) {
  let running = 0
  let ticking = false
  let again = false

  function start(job: Job): void {
    running += 1
    options.onChange?.(running)
    void options
      .run(job)
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        running -= 1
        options.onChange?.(running)
        void tick()
      })
  }

  async function tick(): Promise<void> {
    if (ticking) {
      again = true
      return
    }
    ticking = true
    try {
      do {
        again = false
        const limit = await options.concurrency()
        while (running < limit) {
          const job = await options.claim()
          if (!job) break
          start(job)
        }
      } while (again)
    } catch (error) {
      options.onError?.(error)
    } finally {
      ticking = false
    }
  }

  return { tick, running: () => running }
}
