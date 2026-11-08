/**
 * Size and time bounds shared by the executors and the page agent. The stored fields in
 * `aw_crawl_documents` use the same character limits, so a result that fits here always saves.
 */
export const LIMITS = {
  markdownChars: 2_000_000,
  htmlChars: 4_000_000,
  titleChars: 512,
  fieldChars: 2_000,
  links: 2_000,
  images: 500,
  structuredDataChars: 200_000,
  warnings: 32,
  urlChars: 2_048,
  selectorChars: 500,
  selectorsPerList: 20,
  stepsPerPlan: 24,
  /** Entries one result may carry (`items`), and the most a job may ask for. */
  items: 200,
  maxItemsOption: 50,
} as const

export const TIMING = {
  /** Default whole-job budget; `options.timeoutSeconds` and profiles may change it. */
  jobTimeoutMs: 90_000,
  minJobTimeoutMs: 10_000,
  maxJobTimeoutMs: 280_000,
  /** How long the main document may take before the agent runs on whatever has loaded. */
  loadTimeoutMs: 15_000,
  /** A lease is renewed well inside its server-side lifetime (see `crawl.js`, LEASE_MS). */
  leaseRenewMs: 10_000,
  /** Gap between two captures of one host, so a batch does not hammer a site. */
  hostIntervalMs: 2_500,
} as const

/** Below this a job ends as `partial`: something was captured, and a person should check it. */
export const ACCEPTABLE_SCORE = 40
