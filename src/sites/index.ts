import { csdn } from './csdn'
import { juejin } from './juejin'
import { oschina } from './oschina'
import { sspai } from './sspai'
import type { SiteProfile } from './types'
import { weixin } from './weixin'
import { x } from './x'
import { zhihu } from './zhihu'

/**
 * Every site profile, narrowest first. A site earns one by doing better than generic parsing:
 * cnblogs and SegmentFault, for example, read well without. See docs/site-profiles.md.
 */
export const sites: readonly SiteProfile[] = [weixin, zhihu, juejin, csdn, oschina, sspai, x]
