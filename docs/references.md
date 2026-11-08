# 参考项目

| 项目 | 许可 | 借鉴的内容 | 没有采用的部分 |
| --- | --- | --- | --- |
| [Defuddle](https://github.com/kepano/defuddle) | MIT | 直接依赖，作为主要的通用解析器，也用它的站点适配和 Markdown 转换 | 关闭异步抓取（`useAsync: false`），解析时不访问第三方服务 |
| [Mozilla Readability](https://github.com/mozilla/readability) | Apache-2.0 | 直接依赖，作为备用解析器 | — |
| [Postlight Parser](https://github.com/postlight/parser) | Apache-2.0 / MIT | 声明式站点规则：选择器列表、回退、`clean` | 没有依赖它，也没有用它的规则集 |
| [Trafilatura](https://github.com/adbar/trafilatura) | Apache-2.0 | 多个候选结果比较后再选，而不是相信单一算法 | Python 实现，只参考思路 |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | Apache-2.0 | `wait_for`、页面操作步骤的抽象 | 不接受任务携带 JS，步骤只有选择器 |
| [Zotero translators](https://github.com/zotero/translators) | AGPL-3.0 | 按链接匹配规则、规则可独立维护的思路 | 没有使用其中的代码 |
| [Chrome offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen) | — | 在 offscreen 文档里保持 EventSource | — |

`package.json` 固定了 Defuddle 和 Readability 的版本。升级后要跑端到端测试，并用 `live.mjs` 抽查几个真实页面，解析结果可能悄悄变化。
