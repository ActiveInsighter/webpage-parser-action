import { defineSite } from './types'

/** Juejin appends the article's summary to `<title>`, so the title comes from the page itself. */
export const juejin = defineSite({
  id: 'juejin',
  version: 1,
  hosts: ['juejin.cn'],
  paths: [/^\/post\/\d+/u],
  prepare: [{ op: 'wait', selector: '.article-viewer', timeoutMs: 10_000, optional: true }],
  content: { selectors: ['.article-viewer'] },
  fields: {
    title: ['h1.article-title'],
    byline: ['.author-info-block .username'],
    publishedAt: [['.meta-box time', 'datetime']],
  },
  extract: ({ all }) => ({
    siteName: '稀土掘金',
    extras: { tags: all('.tag-list .tag-title').map((tag) => tag.textContent?.trim()).filter(Boolean) },
  }),
})
