/**
 * Spaces out captures of one host. Each caller books the next free slot synchronously, so
 * concurrent jobs queue up rather than all waking at the same moment.
 */
export function createHostGate(intervalMs: number, now: () => number = Date.now) {
  const nextSlot = new Map<string, number>()

  return {
    /** Milliseconds this capture must wait before opening `host`. */
    reserve(host: string): number {
      const current = now()
      const slot = Math.max(current, nextSlot.get(host) ?? 0)
      nextSlot.set(host, slot + intervalMs)
      for (const [key, value] of nextSlot) {
        if (value < current) nextSlot.delete(key)
      }
      return slot - current
    },
  }
}

export type HostGate = ReturnType<typeof createHostGate>
