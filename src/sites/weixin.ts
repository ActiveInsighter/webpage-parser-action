import { defineSite } from './types'

/** The page's own script fills `#publish_time`; the timestamp it uses sits in an inline script. */
const CREATE_TIME = /\bct\s*=\s*"(\d{10})"/u

/**
 * WeChat articles. `#js_content` starts out `visibility: hidden` and its images sit in `data-src`
 * until scripts run, which is why generic parsing cannot be trusted here. Machines without a
 * WeChat history often get a verification page; that is reported, not worked around.
 */
export const weixin = defineSite({
  id: 'weixin',
  version: 1,
  hosts: ['mp.weixin.qq.com'],
  paths: [/^\/s(?:\/|$)/u],
  content: { selectors: ['#js_content'] },
  fields: {
    title: ['#activity-name', ['meta[property="og:title"]', 'content']],
    byline: ['#js_author_name', ['meta[name="author"]', 'content']],
    siteName: ['#js_name'],
    publishedAt: ['#publish_time'],
    leadImage: [['meta[property="og:image"]', 'content']],
  },
  blockers: [
    { code: 'NOT_FOUND', selector: '.weui-msg', text: /已被发布者删除|已被删除|违规无法查看/u, message: '文章已被删除或无法查看' },
  ],
  extract({ all, text }) {
    if (text('#publish_time')) return null
    const script = all('script:not([src])').find((element) => CREATE_TIME.test(element.textContent ?? ''))
    return { publishedAt: CREATE_TIME.exec(script?.textContent ?? '')?.[1] ?? '' }
  },
})
