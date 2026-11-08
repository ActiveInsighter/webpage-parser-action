import { defineSite } from './types'

const DATE = /\d{4}-\d{2}-\d{2}/u

/** OSCHINA renders news from an API several seconds after load, with an empty `h1` until then. */
export const oschina = defineSite({
  id: 'oschina',
  version: 1,
  hosts: ['www.oschina.net'],
  paths: [/^\/news\/\d+/u],
  prepare: [{ op: 'wait', selector: 'h1.news-content-title:not(:empty)', timeoutMs: 20_000, optional: true }],
  content: { selectors: ['.news-content .editor'] },
  fields: { title: ['h1.news-content-title'] },
  extract: ({ all }) => {
    const meta = all('.news-content .ant-space-item').map((item) => item.textContent?.trim() ?? '')
    return {
      siteName: 'OSCHINA',
      publishedAt: meta.find((value) => DATE.test(value)) ?? '',
      byline: meta.find((value) => value.startsWith('编辑'))?.replace(/^编辑[:：]\s*/u, '') ?? '',
    }
  },
})
