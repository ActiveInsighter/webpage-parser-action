/**
 * The cloud executor's log. Its runs are public (the repository is), so it prints ids, codes and
 * counts only: never a URL, a selector, page text or an error message that could carry them.
 */
const SAFE_FIELDS = new Set(['job', 'dispatch', 'status', 'code', 'route', 'extractor', 'score', 'changed', 'claimed', 'running', 'reason', 'elapsedMs'])

export function publicLog(event: string, detail: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(detail)) {
    if (SAFE_FIELDS.has(key) && (typeof value !== 'string' || /^[\w.:@-]{0,64}$/u.test(value))) safe[key] = value
  }
  console.log(JSON.stringify({ event, ...safe }))
}
