/**
 * Why a crawl failed. `retryable` mirrors the server's table (`ERROR_CODES` in
 * `pb_hooks/crawl_validation.js`), which is what decides whether another attempt is queued;
 * `nextRoute` says whether the cloud executor should try its next way of opening the page first.
 */
export const ERROR_CODES = {
  URL_BLOCKED: { retryable: false, nextRoute: false, message: '该地址不允许抓取' },
  NAVIGATION_FAILED: { retryable: true, nextRoute: true, message: '页面打开失败' },
  HTTP_ERROR: { retryable: true, nextRoute: false, message: '服务器返回错误' },
  NOT_FOUND: { retryable: false, nextRoute: false, message: '页面不存在' },
  LOGIN_REQUIRED: { retryable: false, nextRoute: false, message: '页面需要登录' },
  CAPTCHA: { retryable: false, nextRoute: false, message: '页面要求人机验证' },
  ACCESS_DENIED: { retryable: false, nextRoute: false, message: '站点拒绝了这次访问' },
  UNSUPPORTED_CONTENT: { retryable: false, nextRoute: false, message: '不是网页内容' },
  EMPTY_CONTENT: { retryable: true, nextRoute: true, message: '没有解析到正文' },
  TARGET_NOT_FOUND: { retryable: false, nextRoute: true, message: '页面上没有找到链接指向的内容' },
  STEP_FAILED: { retryable: false, nextRoute: false, message: '页面操作步骤失败' },
  TIMEOUT: { retryable: true, nextRoute: false, message: '抓取超时' },
  PAGE_GONE: { retryable: true, nextRoute: false, message: '抓取中页面被关闭或跳转' },
  CANCELED: { retryable: false, nextRoute: false, message: '任务已取消' },
  INTERNAL: { retryable: true, nextRoute: false, message: '抓取时发生内部错误' },
} as const

export type ErrorCode = keyof typeof ERROR_CODES

export class CrawlError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message?: string, options?: ErrorOptions) {
    super(message || ERROR_CODES[code].message, options)
    this.name = 'CrawlError'
    this.code = code
  }

  get retryable(): boolean {
    return ERROR_CODES[this.code].retryable
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value)
}

/** Any thrown value, as the CrawlError reported to the server. */
export function toCrawlError(error: unknown): CrawlError {
  if (error instanceof CrawlError) return error
  return new CrawlError('INTERNAL', error instanceof Error ? error.message : String(error), { cause: error })
}
