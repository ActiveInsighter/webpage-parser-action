# 网页采集质量验证（2026-11-07）

项目：`/home/dev/Documents/Project/Anyworkflow-capture`。本轮验证使用独立 Chromium、真实扩展及临时 PocketBase；现用执行浏览器没有重新加载开发构建。用户原有 README 和架构文档改动已保留。

## 修复范围

- **正文选择**：手动选择器完整保留选定区域，包括只有图片的区域、根节点为代码块或表格行的区域。站点选择器跳过隐藏旧版正文和脚本空壳，并将精确选中的节点交给解析器，避免第二次查询又命中旧容器。
- **候选回退**：站点正文需要同时通过长度、质量分和链接密度判断；单个解析器或站点函数异常时继续回退。通用解析无结果时保留已有的低分站点正文，以便返回 `partial`。
- **文章末节**：明确站点正文容器不再使用容易误删短末段、裸图片和代码的尾段模式裁剪，继续使用广告选择器与评分过滤；通用解析保持原有去噪策略。
- **图片与地址**：恢复无 `src` 的响应式图片、lazy srcset、picture 和 noscript 图片，避免占位图重复和空地址被记成文章 URL；链接、图片、视频封面按有效 `<base>` 转为 HTTP(S) 绝对地址。
- **元数据**：优先使用文章类型 JSON-LD，支持图谱引用中的作者、出版方、封面与完整 schema 类型地址；无效日期和危险地址不再阻断有效后备值。
- **日期**：校验闰年、月份、日、时分秒和时区；拒绝二月 31 日自动滚到三月、短数字被猜成年月日等错误。
- **内容格式**：清理隐藏噪声和嵌入文档，修正英文块级文本黏连。Markdown 保留输入代码的缩进、多空行和嵌套围栏，超长内容截断时正确闭合围栏；手动和站点正文额外保护解析前的代码空白。
- **验证工具**：回放保留 JSON-LD、页面 JSON、内联日期文本，同时禁用原页面脚本、事件和自动跳转。端到端测试目录放在项目 `.e2e/`，启动前检查后端版本，初始化失败时清理临时资源。

## 单元测试与构建

基线为 **139 项单测通过**。最终 `npm run preflight` 为 **218 项单测通过**，并通过 TypeScript 检查和生产构建。构建输出为 `dist/`；service worker 约 41.5 KB，页面 agent 约 834.3 KB。

日志：[preflight-final.log](../.e2e/preflight-final.log)。

最终完整端到端验证 **28 项全部通过**，包括真实扩展与 PocketBase 的静态/动态正文、等待、滚动、图片、代码和元数据、HTTP 与验证码识别、重试、取消、并发限制、工作进程重启恢复，以及 Remote 列表和结果查看。新加入的三个质量场景以实际内容断言验收，不只检查质量分。

日志：[e2e-final.log](../.e2e/e2e-final.log)。界面截图：[任务列表](../.e2e/screenshots/remote-list.png)、[正文结果](../.e2e/screenshots/remote-result.png)。

## 旧版与新版对照

在同一个已安装依赖版本下，将旧提交 `7f66993befd22ad0305cad651f4173d06b50243b` 和当前工作区分别编译为页面 agent，用独立 Chromium 对同一组**合成 HTML**进行回放。所有站点请求都在本地响应，未将这些结果算作真实站点验证。

| 场景 | 旧版 | 新版 |
| --- | --- | --- |
| 手选代码块 | 首行缩进和连续空行改变 | 与预期代码及围栏逐字一致 |
| 只有 srcset 的图片 | 图片清单误记为文章 URL | 清单和 Markdown 都指向高清图片 |
| 隐藏旧版正文排在前面 | 采到旧正文，仍给出 100 分 | 采到当前正文，排除隐藏副本 |
| JSON-LD 引用和错误日期 | 作者、出版方缺失，日期滚动，封面为危险地址 | 图谱字段与合法日期正确 |

**4/4 场景均为旧版失败、新版通过。** 这说明具体缺陷已修复，不代表所有网页的通用准确率；内置质量分也不能代替正文内容核对。

证据与完整旧新 Markdown：[results.json](../.e2e/quality-comparison/results.json)、[复现说明](../.e2e/quality-comparison/README.md)。

## 真实页面实采

通过真实扩展队列打开以下公开线上文章，检查开头和结尾内容标记、作者、日期、图片地址与去重；结果保存为完整 JSON 和 Markdown。三篇最终均为 HTTP 200、`succeeded`、无警告。

| 真实页面 | 正文计数 | 图片 | 解析方式 | 核对内容 |
| --- | ---: | ---: | --- | --- |
| [少数派 118541](https://sspai.com/post/118541) | 2,199 | 11 | Defuddle + 站点字段 | 耳机壳段落、结尾投稿红包、作者和日期 |
| [掘金 7637856870833635343](https://juejin.cn/post/7637856870833635343) | 1,345 | 2 | 站点规则 | 开头经历、末段结论、作者和日期 |
| [OSCHINA 503428](https://www.oschina.net/news/503428) | 1,290 | 0 | 站点规则 | 第一节、第六节和最后一句，正文不含站点转载页脚 |

计数沿用项目规则：每个中日韩文字字符计一词，其他文字按词计数。它不是全站采集成功率或与原文全文逐字比对的召回率。

额外运行了掘金和 OSCHINA 的 `--generic` 对比。OSCHINA 的纯通用结果混入摘要、复制提示和站点页脚，站点规则排除了这些内容。首轮 OSCHINA 曾出现 `load_timeout`，正文仍完整返回；最终带内容断言的复验无该警告。

真实实采证据：[results.json](../.e2e/live-quality/results.json)、[少数派正文](../.e2e/live-quality/sspai.md)、[掘金正文](../.e2e/live-quality/juejin.md)、[OSCHINA 正文](../.e2e/live-quality/oschina.md)。

微信本轮另用**合成 HTML**验证离线回放的 `ct` 日期和 JSON-LD 保留，最终正确保留 1 张响应式图片和完整末节；不能据此宣称线上访问已验证。回放日志：[replay-final.log](../.e2e/replay-final.log)。知乎、CSDN 的真实页面验证状态仍见[站点规则](site-profiles.md)。

纯通用解析仍可能由 Defuddle 提前标准化代码的共同缩进和空行。需要逐字保留原始代码时，应使用正文选择器或明确站点正文规则；本轮已对这两条路径做了原文保护，没有改变通用解析器的正文识别权重。

## 复验命令

当前机器的 workers 和 Remote 主目录检出的是不含采集功能的旧分支，本轮使用已有采集工作树，没有切换或修改这些项目：

```bash
npm run preflight

POCKETBASE_BINARY=/opt/pocketbase/pocketbase \
WORKERS_DIR=../AnyWorkflow-workers/.worktrees/page-capture \
REMOTE_DIR=../Anyworkflow-remote/.worktrees/page-capture \
SCREENSHOT_DIR=.e2e/screenshots \
npm run test:e2e

POCKETBASE_BINARY=/opt/pocketbase/pocketbase \
WORKERS_DIR=../AnyWorkflow-workers/.worktrees/page-capture \
node .e2e/live-quality/verify.mjs

node .e2e/quality-comparison/compare.mjs
node tests/e2e/replay.mjs https://mp.weixin.qq.com/s/replay-quality .e2e/synthetic-weixin-replay.html --md
```

`.e2e/` 中的日志、截图、实采输出与对照脚本为本机验证附件，已被 git 忽略；需要长期归档时应另行保存该目录。
