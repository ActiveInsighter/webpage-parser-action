import { defineSite } from './types'

const DATE_TIME = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/u

/** Long posts hide behind a "read more" button, and code blocks carry copy-button chrome. */
export const csdn = defineSite({
  id: 'csdn',
  version: 1,
  hosts: ['blog.csdn.net'],
  paths: [/\/article\/details\/\d+/u],
  prepare: [{ op: 'click', selector: '.btn-readmore', optional: true, pauseMs: 300 }],
  content: {
    selectors: ['#content_views', '#article_content'],
    clean: ['.hljs-button', '.pre-numbering', '.hide-preCode-box'],
  },
  fields: { title: ['h1.title-article'], byline: ['.follow-nickName', '#uid'] },
  extract: ({ text }) => ({ siteName: 'CSDN', publishedAt: DATE_TIME.exec(text('.article-bar-top .time'))?.[0] ?? '' }),
})
