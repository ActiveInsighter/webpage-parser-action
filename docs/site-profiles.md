# 站点规则

通用解析已经能处理大部分文章页。规则只用来修它做不好的地方，能不写就不写：博客园和 SegmentFault 的通用解析效果够好，所以没有规则。

规则在页面里运行，云端和浏览器两个执行端用的是同一份规则（`src/sites/`，打包进 `agent.js`）。

## 什么时候写规则

用 `--generic` 抓一次，看结果差在哪里：

| 现象 | 做法 |
| --- | --- |
| 字段不对（标题带后缀、站点名错） | 只写 `fields` 或 `extract` |
| 正文混入导航、评论，或选错区域 | 写 `content.selectors` 和 `clean` |
| 内容加载晚 | 写 `prepare` 等待元素 |
| 被拦截却算成功 | 写 `blockers` |

## 结构

```ts
export const example = defineSite({
  id: 'example',
  version: 1,                        // 改规则时加一，结果里能看出是哪一版
  hosts: ['example.com'],            // 含子域名
  paths: [/^\/post\/\d+/u],          // 可选
  prepare: [{ op: 'wait', selector: '.article', timeoutMs: 20_000, optional: true }],
  content: { selectors: ['.article-new', '.article-old'], clean: ['.ad'] },
  fields: { title: ['h1.title'], publishedAt: [['time', 'datetime']] },
  blockers: [{ code: 'LOGIN_REQUIRED', url: /\/login/u }],
  transport: 'auto',                 // 云端默认读取方式：auto 先 HTTP 再浏览器，http，browser
  extract: ({ document }) => ({ siteName: '示例' }),   // 只有声明式写不了才用
})
```

`extract` 能拿到 `requestedUrl`（任务原本的链接）、`scope`（`target` 只要链接指向的那条，`visible` 页面上可见的全部）和 `maxItems`。它可以返回：

- `items`：结构化条目（如帖子），存进文档的 `items`；
- `identity`：内容自己的身份（如 `x:status:<id>`），同一内容从不同链接抓到时更新同一份文档；
- `complete: true`：`html` 就是完整内容（来自精确匹配的数据），通用解析不会替换它，内容短也不算质量差。

页面上没有任务要的东西时，`extract` 抛出 `CrawlError('TARGET_NOT_FOUND')`：云端会换下一种打开方式重试，两端最终都以这个错误码结束，不会拿相邻内容顶替。

每个列表按顺序尝试，第一个有内容的生效，所以新旧版式可以并列。写好后加到 `src/sites/index.ts`，并在 `tests/unit/sites.test.ts` 里用最小 HTML 覆盖。

规则只能使用选择器和步骤，不能在页面里执行任意代码，也不要写绕过验证或付费墙的逻辑。

## 验证情况

截至 2026-11-06，从开发机出口 IP 验证。「真实页面」指扩展实际打开线上页面；「保存的 HTML」指线上页面的 HTML 经 `replay.mjs` 回放。

| 站点 | 规则 | 验证方式 | 结果 |
| --- | --- | --- | --- |
| 少数派 `sspai` | 只修字段 | 真实页面 | 正常 |
| 掘金 `juejin` | 正文 + 字段 | 真实页面 | 正常 |
| OSCHINA `oschina` | 等待 + 正文 + 字段 | 真实页面 | 正常 |
| 微信公众号 `weixin` | 正文 + 字段 + 内联日期 | 保存的 HTML | 解析正常；开发机访问时被验证页拦截，报 `CAPTCHA` |
| 知乎 `zhihu` | 页面 JSON → DOM → 通用 | **未验证** | 开发机访问返回 403，报 `ACCESS_DENIED`；选择器依据公开版式编写 |
| CSDN `csdn` | 正文 + 字段 | **未验证** | 开发机访问返回 403/521；选择器依据公开版式编写 |
| 博客园、SegmentFault | 无 | 真实页面 | 通用解析足够 |
| X `x` | 帖子卡片 → `items`，正文由帖子生成 | 真实页面（云端 HTTP，2026-11-08） | 单条帖子、主页可见帖子都正常；规则从旧的 Python 抓取器移植，单元测试覆盖登录版式和匿名版式 |

X 的登录版式（`article[data-testid="tweet"]`，浏览器执行端）只用最小 HTML 验证过，没有在登录状态的真实页面上验证。

未验证的规则如果不命中，会退回通用解析，并在结果里带上 `site_profile_fell_back` 警告。用已登录的日常浏览器第一次跑这些站点时，建议看一下这个警告和正文。

## 调试

```bash
npm run build:action && npm run crawl -- <url>          # 云端执行端，匿名，打印 Markdown（--json 看全部字段）
npm run crawl -- <url> --transport browser               # 强制用浏览器打开
node tests/e2e/live.mjs --md <url>                       # 浏览器扩展，真实页面
node tests/e2e/live.mjs --generic --md <url>             # 不用规则，对比
node tests/e2e/replay.mjs <url> saved.html --md          # 被拦截时用保存的 HTML
```

`replay.mjs` 会禁用保存页面的应用脚本、内联事件和自动跳转，但保留 JSON-LD、页面 JSON 和内联时间戳文本供解析器读取。它只验证保存的 DOM 和数据解析，不能验证真实页面的等待、滚动或站点访问情况。结果里的 `trace.steps` 记录了每一步，`extractor` 和 `profile` 记录了最终用的是什么。
