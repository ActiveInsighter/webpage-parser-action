# 架构

一份解析代码，两个执行端：

| 执行端 | 运行位置 | 身份 | 打开页面的方式 | 适合 |
| --- | --- | --- | --- | --- |
| 云端 `cloud` | GitHub Actions（`.github/workflows/crawl.yml`） | 抓取服务账号 `aw_crawler_services` | 全新的 Playwright 上下文：HTTP 静态渲染，或浏览器 | 不需要登录的公开页面，免费 |
| 浏览器 `browser` | 你服务器上一直开着的 Chrome（扩展） | 你自己的 `aw_clients` 账号 | 扩展在这个浏览器里开的标签页 | 需要登录态的社交媒体等 |

两端都把同一个 `agent.js` 注入页面的隔离环境（isolated world）里执行步骤和解析，所以站点规则、清洗、质量评估、Markdown 转换完全一致；它们也用同一个任务引擎领取、续租、上报。区别只在「怎么打开页面」这一层。

## 分层

依赖只能从上往下，`npm run check:layers` 检查：

| 层 | 目录 | 职责 | 能依赖 |
| --- | --- | --- | --- |
| 契约 | `src/core` | 任务、选项、计划、结果的格式，错误码，限额，URL 策略 | — |
| 站点规则 | `src/sites` | 针对具体站点的声明式规则（含 X） | core |
| 页面代理 | `src/page` | 在页面里运行：基础操作、步骤、拦截识别、通用解析；入口 `agent.ts` | core、sites |
| 引擎 | `src/engine` | 一个任务从领取到上报：计划、租约、打开方式回退、结果组装；PocketBase 客户端；`PageDriver` 接口 | core、sites（page 只引类型） |
| 浏览器执行端 | `src/extension` | MV3：service worker、offscreen realtime、弹窗；`PageDriver` 用 `chrome.tabs` + `chrome.scripting` 实现 | 以上全部 |
| 云端执行端 | `src/action` | Node CLI：`PageDriver` 用 Playwright + DevTools 协议实现；HTTP 读取；公开日志 | 以上全部 |

```
         ┌─────────────── src/page/agent.ts ───────────────┐   同一个 agent.js
         │ prepare(plan): 检查状态 → 识别拦截 → 执行步骤     │   注入页面隔离环境
         │ extract(plan): 站点规则 → Defuddle → Readability │
         └─────────────────────────▲───────────────────────┘
                                   │ PageHandle.call()
   src/engine/runner.ts ── PageDriver.routes() / open() ──┬── extension: chrome.tabs + scripting
   (plan · lease · 回退 · 上报)                            └── action: Playwright + CDP isolated world
```

## 一次抓取

1. Remote 创建 `aw_crawl_jobs`（直接填链接，或引用已保存的页面 `target`）。钩子校验链接和选项，复制页面设置，状态 `queued`。
2. 执行端领取（`POST /api/anyworkflow/crawl/claim`）：
   - 浏览器扩展：realtime 唤醒或 30 秒闹钟，领取**自己账号**的 `browser` 任务；
   - 云端：scheduler 发现有排队的 `cloud` 任务，打开一个 dispatch 并派发 `crawl.yml`；workflow 在这个 dispatch 里逐个领取所有账号的 `cloud` 任务，直到队列为空（空队列在同一事务里关闭 dispatch）或用完 30 分钟预算。
3. 引擎：`plan.ts` 合成默认步骤、站点规则和任务选项；`host-gate.ts` 让同一站点至少间隔 2.5 秒；依次尝试 `PageDriver.routes()` 给出的打开方式。
4. 页面代理先 `prepare` 再 `extract`。站点规则可以给出结构化 `items`、内容身份 `identity`，或声明 `complete`。
5. 引擎调用 `complete`。服务端在一个事务里按「账号 + 内容身份」更新文档、计算 `contentHash`、判断有没有变化，结束任务，并把结果写回页面的「最近一次」字段。
6. 期间每 10 秒续租（租约 90 秒），续租响应带回取消请求。

### 云端的打开方式

| 方式 | 做法 | 用在 |
| --- | --- | --- |
| `http` | Node 发一次匿名请求（手动跟随跳转，每一跳都过 URL 策略，最多 5 跳、20 MB），再交给 Chromium 显示：CSP 禁止页面脚本，除样式表外的子资源全部拦掉 | 选项 `transport: http`；X 默认先用它 |
| `browser` | 全新上下文里正常打开，页面脚本照常执行，页面发出的每个请求都过 URL 策略 | 默认；`waitFor`、`scroll` 必须用它 |

`transport: auto`（X 规则的默认值）先 `http`，在 `EMPTY_CONTENT`、`TARGET_NOT_FOUND`、`NAVIGATION_FAILED` 时换 `browser`；遇到验证、拒绝访问等不会换，因为换了也一样。结果的 `trace.route` 和 `route_fell_back` 警告记录实际用的方式。浏览器扩展只有一种方式 `live`。

### 状态

```
queued → opening → rendering → extracting → uploading → succeeded
                                                      ↘ partial   质量分低于 40，或内容被截断（服务端判断）
任意进行中状态 → failed / canceled
失败且可重试 → queued（指数退避，30 秒起，最多尝试 3 次；是否重试由服务端按错误码决定）
```

状态映射在 `AnyWorkflow-workers/src/platform/tasks/catalog.mjs`（`crawlJobKind`），Remote 的任务中心直接复用。

### 容错

- **租约过期**：scheduler 每分钟调用 `maintain`，把过期任务以 `LEASE_LOST` 放回队列。
- **云端运行结束**：scheduler 查到 GitHub 运行完成后调用 `settle`，这次运行仍持有租约的任务立即放回队列。
- **没有执行端**：浏览器任务 24 小时、云端任务 6 小时无人领取，以 `NO_WORKER` 结束。
- **扩展 service worker 被回收**：打开的窗口记录在 `storage.session`，重启后关闭；任务由租约过期回收。
- **取消**：排队中的立即取消；进行中的在下次续租时停止，页面随之关闭。

## 错误码

`src/core/errors.ts` 与服务端 `crawl_validation.js` 的 `ERROR_CODES` 一致（`tests/unit/contract.test.ts` 检查）：

| 错误码 | 含义 | 重试 | 云端换方式 |
| --- | --- | --- | --- |
| `URL_BLOCKED` | 不允许的地址 | 否 | 否 |
| `NAVIGATION_FAILED` | 页面打不开 | 是 | 是 |
| `HTTP_ERROR` | 429 或 5xx | 是 | 否 |
| `NOT_FOUND` | 404 / 410 | 否 | 否 |
| `LOGIN_REQUIRED` | 需要登录（云端可改用浏览器执行） | 否 | 否 |
| `CAPTCHA` | 需要人工验证 | 否 | 否 |
| `ACCESS_DENIED` | 401 / 403 | 否 | 否 |
| `UNSUPPORTED_CONTENT` | PDF 等非网页内容 | 否 | 否 |
| `EMPTY_CONTENT` | 没有解析出内容 | 是 | 是 |
| `TARGET_NOT_FOUND` | 页面上没有链接指向的内容（如 X 帖子） | 否 | 是 |
| `STEP_FAILED` | 必需的步骤失败，比如等待元素未出现 | 否 | 否 |
| `TIMEOUT` | 超时 | 是 | 否 |
| `PAGE_GONE` | 页面被关闭 | 是 | 否 |
| `CANCELED` | 已取消 | 否 | 否 |
| `INTERNAL` | 内部错误 | 是 | 否 |
| `LEASE_LOST` / `NO_WORKER` | 服务端写入：执行中断 / 没有执行端 | 是 / 否 | — |

## 数据库

结构由 AnyWorkflow-workers 维护：迁移 `pocketbase/pb_migrations/1794200000_unified_crawl.js`，钩子 `pb_hooks/aw_crawl.pb.js`、`crawl.js`、`crawl_validation.js`。本仓库在 `tests/fixtures/pocketbase/` 保存一份副本供测试使用，用 `npm run sync:pocketbase -- ../AnyWorkflow-workers` 更新，不要手改。

| 集合 | 用途 |
| --- | --- |
| `aw_crawl_targets` | 保存的页面：链接、执行端、分类、选项、频率、下次时间、最近一次结果（任务、状态、错误、文档、标题） |
| `aw_crawl_jobs` | 一次抓取一个链接：请求快照、状态、租约、错误、结果摘要（标题、字数、质量分、条目数、文档、是否变化） |
| `aw_crawl_documents` | 按「账号 + 内容身份」保存最新内容：元数据、Markdown、可选 HTML、`items`、链接、图片、`contentHash`、`changedAt` |
| `aw_crawl_dispatches` | 云端运行（一次 GitHub workflow run），只有 superuser 可读 |
| `aw_crawl_workers` | 在线的浏览器扩展 |

任务和文档分开：列表频繁轮询，只读小而固定的 `aw_crawl_jobs`；可能有数 MB 的正文放在 `aw_crawl_documents`，打开时才读。文档只保存最新版本，`changedAt` 只有内容哈希变化时才更新，任务上的 `changed` 记录那一次抓取有没有带来变化。

所有生命周期字段都只能通过 `/api/anyworkflow/crawl/*` 修改。

## 安全模型

任务记录是远端输入，而浏览器执行端是一个已登录的浏览器，所以按不可信输入处理：

- **URL**：只允许 http/https；拒绝本机和内网地址（包括十进制、八进制 IPv4 和 IPv4 映射的 IPv6）、带用户名密码的地址，以及用户屏蔽的域名。默认屏蔽邮箱、账号、支付类站点和 AnyWorkflow 自身。服务端建任务时校验，执行端打开前、跳转落地后、解析结果时再各校验一次；云端还检查 HTTP 的每一跳和页面发出的每个请求，避免读到 runner 自己的元数据服务。只按字面地址判断，不解析 DNS，所以解析到内网的公网域名（DNS rebinding）防不住。
- **选项**：只有选择器和数字，未知字段丢弃，长度有上限。没有执行脚本的入口。
- **页面代理**：运行在隔离环境，页面脚本读不到它；云端每次调用新建一个隔离环境。
- **云端日志**：仓库公开，运行日志也公开。workflow 只收到 dispatch id，日志只打印任务 id、错误码和计数（`src/action/log.ts` 按白名单过滤），不打印链接、选择器、正文和错误信息，也不上传 artifact。
- **身份**：云端只用 `aw_crawler_services`，它只能领取 `cloud` 任务、读写自己领到的任务，不能读文档列表、改页面或管理用户；扩展用户只能领取自己账号的 `browser` 任务。
- **页面内容**：Remote 始终按文本显示，链接经过 `safeHref` 过滤，不渲染为 HTML、不加载图片。

## 隐藏窗口的注意事项（浏览器执行端）

扩展的采集窗口默认是不抢焦点的独立窗口，部分能力在这里不可靠：

- `requestAnimationFrame` 不触发，等待全部用定时器和 `MutationObserver`。
- 滚动后要手动派发 `scroll` 事件，有些懒加载依赖它。
- http 页面不是安全上下文，没有 `crypto.subtle`（内容哈希由服务端计算）。
- SPA 的 `load` 事件来得很早，`settle` 步骤要等到至少 200 字可见文本。
