import { crawlJobSchema, type CrawlJob, type CrawlResult } from '@/core/contract'
import type { ErrorCode } from '@/core/errors'

/**
 * The executor's side of the crawl routes (`/api/anyworkflow/crawl/*` in AnyWorkflow-workers).
 * Both executors use it unchanged; only the credential differs: the owner's session in the
 * extension, the crawler service's token in the cloud.
 */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export interface ExecutorInfo {
  workerId: string
  version: string
  label: string
  /** Cloud only: the dispatch (workflow run) this executor works for. */
  dispatch?: string
}

export interface ClaimReply {
  job: CrawlJob | null
  /** Cloud only: the dispatch takes no more jobs, so the executor should stop. */
  closed: boolean
}

export interface RenewReply {
  accepted: boolean
  cancelRequested: boolean
}

export interface CompleteReply {
  status: 'succeeded' | 'partial'
  document: string
  changed: boolean
}

/** What the rest of an executor needs from the server; tests supply a fake. */
export interface CrawlApi {
  claim(executor: ExecutorInfo, leaseId: string): Promise<ClaimReply>
  renew(jobId: string, leaseId: string, status?: string): Promise<RenewReply>
  complete(jobId: string, leaseId: string, result: CrawlResult): Promise<CompleteReply>
  fail(jobId: string, leaseId: string, failure: { code: ErrorCode; message: string }): Promise<void>
  /** Cloud only: stop taking jobs for this dispatch before the queue is empty. */
  closeDispatch?(dispatchId: string): Promise<void>
}

const REQUEST_TIMEOUT_MS = 15_000
const UPLOAD_TIMEOUT_MS = 60_000

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  token?: string | null
  timeoutMs?: number
}

export async function requestJson<T>(baseUrl: string, path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'POST',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: options.token } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!response.ok) {
    const message = (payload as { message?: unknown } | null)?.message
    throw new ApiError(typeof message === 'string' && message ? message : `请求失败（${response.status}）`, response.status)
  }
  return payload as T
}

export function createCrawlApi(baseUrl: string, token: () => Promise<string | null>): CrawlApi {
  const call = async <T>(path: string, body: unknown, timeoutMs?: number) =>
    requestJson<T>(baseUrl, `/api/anyworkflow/crawl${path}`, { body, token: await token(), timeoutMs })
  const job = (id: string) => `/jobs/${encodeURIComponent(id)}`

  return {
    async claim(executor, leaseId) {
      const reply = await call<{ job: unknown; closed?: boolean }>('/claim', { ...executor, leaseId })
      return { job: reply.job ? crawlJobSchema.parse(reply.job) : null, closed: reply.closed === true }
    },
    renew: (jobId, leaseId, status) => call<RenewReply>(`${job(jobId)}/renew`, { leaseId, status }),
    complete: (jobId, leaseId, result) => call<CompleteReply>(`${job(jobId)}/complete`, { leaseId, result }, UPLOAD_TIMEOUT_MS),
    async fail(jobId, leaseId, failure) {
      await call(`${job(jobId)}/fail`, { leaseId, ...failure })
    },
    async closeDispatch(dispatchId) {
      await call(`/dispatches/${encodeURIComponent(dispatchId)}/close`, {})
    },
  }
}
