import { defineSite } from './types'

/**
 * Fields only. Generic parsing reads 少数派 well, and a morning-paper post spreads its text over
 * several blocks, so naming one container here would lose content. What it gets wrong is small:
 * the site name, which it takes from the byline, and the suffix left on the title.
 */
export const sspai = defineSite({
  id: 'sspai',
  version: 1,
  hosts: ['sspai.com'],
  paths: [/^\/post\/\d+/u],
  fields: { title: ['h1.article__header__title'] },
  extract: ({ document }) => ({ title: document.title.replace(/\s*-\s*少数派\s*$/u, ''), siteName: '少数派' }),
})
