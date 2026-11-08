# AnyWorkflow Crawler

AnyWorkflow 的网页抓取：**一份解析代码，两个执行端**。

- **云端**：在 GitHub Actions 里运行，免费，用全新的匿名浏览器上下文，适合不需要登录的公开网页和 X 公开帖子。
- **浏览器**：作为 Chrome 扩展运行在你服务器上一直开着的浏览器里，复用你已登录的账号，适合社交媒体等需要登录才能看到的内容。

在 AnyWorkflow Remote 的「网页采集」页面里提交链接或保存页面（可设频率），选择在哪一端执行；结果按内容去重保存到 PocketBase，有变化时标出。

```
Remote 网页采集 ──创建任务──▶ PocketBase  aw_crawl_jobs (runner = cloud | browser)
                                │
       ┌────────────────────────┴─────────────────────────┐
       ▼ cloud                                             ▼ browser
 scheduler 打开 dispatch，派发 crawl.yml           扩展收到 realtime / 30 秒闹钟
 workflow 领取任务直到队列为空                        领取自己账号的任务
       │  Playwright 打开页面（HTTP 或浏览器）              │  在已登录的浏览器里开标签页
       └──────────────┬─────────────────────────────────────┘
                      ▼  同一个 agent.js：步骤 → 拦截识别 → 站点规则 / Defuddle / Readability → Markdown
               complete ──▶ aw_crawl_documents（按内容身份去重，contentHash / changedAt）
```

项目位置：`/home/dev/Documents/Project/webpage-parser-action`（本仓库由原来的 webpage-parser-action 和 Anyworkflow-capture 合并而成）。
仓库：https://github.com/ActiveInsighter/webpage-parser-action

## 能力

- **通用解析**：Defuddle → Readability 级联，统一清洗后转 Markdown，并给出 0–100 的质量分。
- **站点规则**：按链接匹配的声明式规则，内置 X、微信公众号、知乎、掘金、CSDN、OSCHINA、少数派。X 规则只返回链接指向的那条帖子（或主页上可见的帖子），结构化帖子存进 `items`。规则失效时退回通用解析。
- **页面操作**：等待元素、等待 DOM 安静、滚动加载、点击、移除元素、懒加载图片还原。
- **单次覆盖**：等待元素、正文选择器、移除元素、滚动、保留 HTML、超时、只用通用解析、读取范围和条目数、云端读取方式。
- **遇阻即报**：登录墙、验证码、403/404、PDF 都以明确的错误码结束，不尝试绕过任何验证。

## 使用

### 云端

不需要额外操作：Remote 里选「云端」提交即可。AnyWorkflow-workers 的 scheduler 看到排队的云端任务就派发 `crawl.yml`（需要它的 `CRAWL_GITHUB_TOKEN`），workflow 用仓库 Secret `WEBPAGE_POCKETBASE_TOKEN`（`aw_crawler_services` 的 token）领取和上报任务。workflow 必须在默认分支上。

```bash
sudo -n python3 scripts/configure_crawler_secret.py   # 创建 / 续签抓取服务账号并设置仓库 Secret（见下）
```

### 浏览器

```bash
npm ci
npm run build          # dist/extension 是扩展，dist/action 是云端执行端
```

1. 在 `chrome://extensions` 打开开发者模式，加载 `dist/extension/`。
2. 点扩展图标，用 AnyWorkflow 客户端账号（`aw_clients`）登录，打开「接收任务」。
3. 在这个浏览器里登录要抓取的网站。Remote 里选「浏览器」提交。页面会显示扩展是否在线。

弹窗还提供「采集当前页」、并发数（默认 2，最多 4）、打开方式（默认独立窗口）和屏蔽域名设置。构建时用 `CRAWLER_POCKETBASE_URL` 指定后端，默认 `https://pb.any1.tech`。

## 开发

```bash
npm test                 # 单元测试（vitest + jsdom），含与服务端的契约测试
npm run preflight        # 单元测试 + 类型检查 + 分层检查 + 两端构建
npm run crawl -- <url>   # 用云端执行端抓一个页面并打印 Markdown，不写数据库（先 npm run build:action）
```

端到端测试启动真实的 PocketBase（运行 `tests/fixtures/pocketbase/` 里的真实迁移和钩子）和真实的 Chromium，不接触生产数据：

```bash
npm run build:action && POCKETBASE_BINARY=/opt/pocketbase/pocketbase npm run test:cloud   # 云端执行端
POCKETBASE_BINARY=/opt/pocketbase/pocketbase npm run test:e2e                             # 浏览器扩展
```

设置 `WORKERS_DIR=../AnyWorkflow-workers` 时测试会先确认副本与后端一致；不一致就运行 `npm run sync:pocketbase -- ../AnyWorkflow-workers` 并一起提交。`REMOTE_DIR` 可选，用于顺带验证 Remote 页面。

调试真实页面：

```bash
npm run crawl -- https://x.com/<handle>/status/<id> --json       # 云端，看全部字段
npm run crawl -- https://x.com/<handle> --scope visible --max-items 5
node tests/e2e/live.mjs --md <url>                                # 浏览器扩展
node tests/e2e/replay.mjs <url> saved.html --md                   # 用保存的 HTML 复现
```

## 目录

```
src/
├── core/        契约、错误码、限额、URL 策略（两端共用，不依赖运行环境）
├── sites/       站点规则（见 docs/site-profiles.md）
├── page/        注入页面的代理：基础操作、步骤、拦截识别、通用解析；入口 agent.ts
├── engine/      任务引擎：计划、租约、打开方式回退、结果组装、PocketBase 客户端、PageDriver 接口
├── extension/   浏览器执行端：service worker、offscreen realtime、弹窗
└── action/      云端执行端：Playwright 驱动、HTTP 读取、公开日志、CLI（crawler.mjs）
```

## 文档

- [架构](docs/architecture.md)：分层、一次抓取的过程、两端的打开方式、数据库、安全模型
- [站点规则](docs/site-profiles.md)：如何新增规则、各站点验证情况
- [参考项目](docs/references.md)
- [采集质量验证](docs/quality-validation-2026-11-07.md)

## 抓取服务账号

```bash
sudo -n python3 scripts/configure_crawler_secret.py
```

复用服务器现有管理凭据创建/续签 `aw_crawler_services` 账号，并通过标准输入设置本仓库 `WEBPAGE_POCKETBASE_TOKEN` Secret。凭据保留于 root-only `/etc/anyworkflow/webpage-crawler.json`，不输出、不提交；token 有效 365 天，到期前重跑。workflow 从仓库 Variable `POCKETBASE_URL` 读取数据库地址，缺省 `https://pb.any1.tech`。

## 已知限制

- 浏览器执行端需要一个开着的 Chrome，且已加载扩展并登录；没有在线扩展时任务排队，24 小时后以 `NO_WORKER` 结束。
- 云端只能看到匿名可见的内容；X 匿名页面只有公开预览，不保证完整回复或长文。
- URL 策略只判断字面地址，不解析 DNS，无法发现解析到内网的公网域名（DNS rebinding）。
- 知乎、CSDN 的规则，以及 X 的登录版式，没有在真实页面上验证过，详见 [站点规则](docs/site-profiles.md)。
- PDF 不在这里处理，请用 Remote 的文件转换。
