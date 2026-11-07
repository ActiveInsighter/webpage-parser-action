# Webpage Parser Action

在 GitHub Actions 中匿名抓取普通网页、X 帖子及回复，可直接保存到 AnyWorkflow 使用的 PocketBase。没有前端，不读取本机浏览器 Cookie，不使用第三方代抓服务或 LLM。

项目位置：`/home/dev/Documents/Project/webpage-parser-action`。
仓库：https://github.com/ActiveInsighter/webpage-parser-action

## X 链接匹配

默认 `mode=auto`、`x_scope=target`、`transport=auto`：

1. 从 X / Twitter 链接解析 status ID，支持跟踪参数、`/photo/N`、`/video/N`、`/i/status/ID` 和 `/i/web/status/ID`。
2. 先匿名 HTTP 读取公开 HTML；缺少目标时使用 Crawl4AI 0.9.5 + 全新 Chromium 上下文渲染。普通网页默认使用 Chromium。
3. 扫描帖子卡片，排除嵌入引用帖，去重后按 ID 匹配；限制数量在匹配之后应用。
4. 默认只返回目标。因此回复页先显示上文原帖时，仍返回链接指向的回复。目标缺失即失败，不用邻近内容代替。

`x_scope=visible` 可返回目标及页面上其他公开卡片，目标始终排第一，数量受 `max_posts` 限制；主页也须显式使用该范围。其他卡片标记 `relation=visible`，不能据页面顺序认定它们都是回复。未明确提供回复关系时，`is_reply` 和 `reply_to_status_id` 为 `null`。

匿名页面只能取得公开预览，无法保证完整回复、完整历史或完整长文；不自动滚动或登录。HTTP 200 而目标缺失、登录墙、删除或限流都可能失败。429 重试耗尽后不会再启动浏览器请求。`coverage=visible_only` 明确表达此限制。媒体保存 URL、视频可见 source/poster，不下载文件或保证可播放。

## remote 调用

仍使用 `fetch-page.yml` 的 `workflow_dispatch`，保留原有九个输入，并以一个 `options` JSON 输入传递后端参数：

```bash
gh workflow run fetch-page.yml \
  --repo ActiveInsighter/webpage-parser-action --ref main \
  -f url='https://x.com/theo/status/2118569423653204185' \
  -f mode=x -f max_posts=1 \
  -f options='{"x_scope":"target","transport":"auto","request_id":"remote-crawl-001"}'
```

抓取并入库，`owner` 替换为当前用户的 `aw_clients` 记录 ID：

```bash
gh workflow run fetch-page.yml \
  --repo ActiveInsighter/webpage-parser-action --ref main \
  -f url='https://x.com/theo/status/2118569423653204185' \
  -f mode=x \
  -f options='{"save_to":"pocketbase","owner":"OWNER_RECORD_ID","content_type":"social_media","request_id":"remote-crawl-001"}'
```

HTTP 调用示例，`GH_TOKEN` 须有本仓库 Actions write 权限：

```bash
curl --fail-with-body --request POST \
  --header "Authorization: Bearer $GH_TOKEN" \
  --header 'Accept: application/vnd.github+json' \
  --header 'Content-Type: application/json' \
  'https://api.github.com/repos/ActiveInsighter/webpage-parser-action/actions/workflows/fetch-page.yml/dispatches' \
  --data '{"ref":"main","inputs":{"url":"https://x.com/theo/status/2118569423653204185","mode":"x","options":"{\"save_to\":\"pocketbase\",\"owner\":\"OWNER_RECORD_ID\",\"content_type\":\"social_media\",\"request_id\":\"remote-crawl-001\"}"}}'
```

调用是异步的，派发响应不直接返回正文。Remote 后端应从已验证会话确定 `owner`，生成 `request_id`，派发后轮询 GitHub run，或查询 PocketBase 的 `owner + requestId` 获取入库结果。`request_id` 用于关联；派发调用超时时需先对账，不保证 GitHub 任务只执行一次。内容入库另有稳定去重键。

批量把 `url` 设为换行分隔的字符串，最多 10 条；任一抓取或入库失败，任务整体失败，其他地址的成功结果仍保留。

## 参数

| workflow 输入 | 默认值 | 说明 |
| --- | --- | --- |
| `url` | `vars.TARGET_URL` 或 example.com | 一个或换行分隔的多个 URL |
| `mode` | auto | auto / page / x |
| `selector` | body | 普通网页 CSS 选择器 |
| `attribute` | 空 | 普通网页属性名；空表示文字 |
| `timeout` | 30 | 单次导航/等待或 HTTP 请求秒数，(0,120] |
| `retries` | 2 | 临时 HTTP / 网络错误重试，0–5 |
| `wait_for` | 空 | CSS 等待；auto 将直接使用浏览器，http 不支持 |
| `delay` | 3 | 浏览器额外渲染等待，0–30 秒；HTTP 不等待 |
| `max_posts` | 1 | visible 范围最多 1–50 条；target 始终一条 |
| `options` | `{}` | 以下 JSON 配置，所有值均为字符串 |

| options 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `x_scope` | target | target / visible |
| `transport` | auto | auto / http / browser |
| `save_to` | none | none / pocketbase；启用但写入失败时任务失败 |
| `content_type` | social_media | 类型，可改成 `社交媒体` 或其他 1–64 字符的分类 |
| `owner` | 空 | 启用入库时必填，15 字符的 aw_clients ID |
| `request_id` | 空 | 调用方关联标识，至多 128 字符，无控制字符 |

不接受 JSON 中未知键、非字符串值或凭据。`options` 覆盖对应的独立 action / CLI 参数。

定时任务每小时 UTC 第 17 分钟执行，使用仓库 Variables：`TARGET_URL`、`PARSER_MODE`、`PARSER_SELECTOR`、`PARSER_ATTRIBUTE`、`PARSER_WAIT_FOR`、`PARSER_DELAY`、`PARSER_MAX_POSTS`、`PARSER_OPTIONS`。手动/API 的数值参数优先，包括合法的零值。手动输入 options 默认 `{}`；定时配置中的入库选项不会隐式影响手动抓取。

## 数据库

新增 `aw_crawled_contents`，沿用现有 PocketBase，未引入另一套数据库。

| 字段 | 用途 |
| --- | --- |
| `owner` | 所属 aw_clients 用户；删除用户时级联清理 |
| `type`, `platform` | 可编辑内容类型，以及 x / web 来源平台 |
| `source`, `canonicalUrl`, `externalId` | 原始输入链接、规范内容链接、X status ID |
| `content`, `title` | 正文与页面标题；无正文的媒体帖允许空正文 |
| `author`, `handle`, `publishedAt` | 作者、账号和明确给出的发布时间 |
| `fetchedAt`, `created`, `updated` | 抓取时间和记录时间 |
| `media`, `metrics`, `metadata` | 图片/视频 URL、可见计数、完整结构化帖子及关系 |
| `requestId`, `dedupeKey` | 调用关联标识、稳定内容身份的 SHA-256 |

唯一索引为 `(owner, dedupeKey)`：同一用户同一个 X status ID 重抓会更新原记录（含类型、来源、计数和 requestId）；不同用户分别保存。普通网页按最终 URL 去重。并发插入发生冲突或写入响应丢失时会查回记录再更新，不会创建重复行。多个请求同时更新同一内容时以最后成功写入为准，表保留当前内容，不是每次抓取的历史流水。失败抓取不入库；入库失败会使任务失败，同时保留正文和已写入的 record IDs，批量/多卡片写入不保证整体事务。

普通用户只能访问自己的内容。`aw_crawler_services` 是独立机器身份，只在新内容集合上授予读、创建、更新权限；不能删除内容或管理用户、集合。Actions 使用其 token，未使用管理员 token。

部署迁移：`pocketbase/pb_migrations/1794045600_crawled_contents.js`。已经同步到当前维护后端 `/home/dev/Documents/Project/AnyWorkflow-workers/.worktrees/retire-automa/pocketbase/pb_migrations/`。在现有本机部署上可执行：

```bash
sudo -n python3 scripts/deploy_collection.py
sudo -n python3 scripts/configure_crawler_secret.py
```

第一个命令备份、在一致性副本上验证迁移与既有业务记录数，再仅安装本迁移并重启 PocketBase；已应用时不重复执行。第二个命令复用服务器现有管理凭据创建/续签受限抓取身份，并通过标准输入设置本仓库 `WEBPAGE_POCKETBASE_TOKEN` Secret。凭据保留于 root-only `/etc/anyworkflow/webpage-crawler.json`，不输出、不提交；token 有效 365 天，到期前重跑第二个命令。

workflow 从仓库 Variable `POCKETBASE_URL` 读取数据库 origin，缺省 `https://pb.any1.tech`。凭据只从 Secret 读取，不通过 dispatch 输入传递；仅抓取时不需要数据库凭据。

## 结果与复用

附件保留 30 天：`result.json` 是结构化契约，`content.md` 仅含选中的内容；`page.html`、`page.md`、可用时的 `page.png` 是整个页面的诊断证据，可能含上下文。HTTP 模式没有截图，浏览器导航失败也可能没有截图。多地址证据为 `page-01.*` 等。

单地址结果保留 `items/count/success`，增加 `schema_version=2`、`authenticated=false`、`transport`、`target_status_id`、`target`、`posts`、`coverage`、`request_id`；入库时增加 `storage.status/record_ids`。多地址在 `results[]` 中保留对应结果，顶层 `success` 为整体状态。抓取已成功但入库失败时，`crawl_success=true`、`success=false`。调用方必须检查成功状态，不以 count 判断成功。

```bash
gh run list --repo ActiveInsighter/webpage-parser-action --workflow fetch-page.yml --limit 5
gh run watch RUN_ID --repo ActiveInsighter/webpage-parser-action --exit-status
gh run download RUN_ID --repo ActiveInsighter/webpage-parser-action --dir results/remote
```

组合 action 支持所有原参数，新增 `x-scope`、`transport`、`save-to`、`content-type`、`owner`、`request-id`、`options`、`pocketbase-url`、`pocketbase-token`；远程 workflow 和 JSON 使用下划线。输出 `count`、`success`、`record-ids`（JSON 数组）、`request-id`、`result-path`。失败步骤之后读取输出时需使用 `if: always()`。

```yaml
- uses: ActiveInsighter/webpage-parser-action@main
  id: crawl
  with:
    url: https://x.com/theo/status/2118569423653204185
    save-to: pocketbase
    content-type: social_media
    owner: ${{ vars.CRAWL_OWNER_ID }}
    request-id: remote-crawl-001
    pocketbase-url: https://pb.any1.tech
    pocketbase-token: ${{ secrets.WEBPAGE_POCKETBASE_TOKEN }}
```

也支持跨仓库 `workflow_call`，输入与 dispatch 相同，显式传入 `WEBPAGE_POCKETBASE_TOKEN` secret；job 输出为 `count/success/record_ids/request_id`。抓取仓库需允许调用方访问；正式调用推荐固定已验证的提交 SHA。

## 本地开发

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r requirements.txt
.venv/bin/python -m playwright install --with-deps chromium
.venv/bin/python parser.py --url https://x.com/theo/status/2118569423653204185 --mode x
POCKETBASE_BINARY=/opt/pocketbase/pocketbase .venv/bin/python -m unittest discover -s tests -v
```

CLI 入库使用 `--save-to pocketbase --owner ID --content-type social_media --request-id ID`，数据库 origin 与 token 分别从 `POCKETBASE_URL`、`POCKETBASE_TOKEN` 环境变量读取；不接受 token 命令行参数。浏览器与结果目录均在项目内并已忽略。

CI 安装校验 SHA-256 的 PocketBase 0.39.10，在临时数据库验证真实迁移、权限、唯一索引和写入；本机也验证 0.40.4。没有 PocketBase 二进制时本地数据库测试会明确跳过，CI 不跳过。更新 Python 依赖后，用 `uv pip compile requirements.in --python-version 3.12 --generate-hashes -o requirements.txt` 重生成锁文件。

参考：[PocketBase migrations](https://pocketbase.io/docs/js-migrations/)、[API rules](https://pocketbase.io/docs/api-rules-and-filters/)、[Crawl4AI 动态页面](https://docs.crawl4ai.com/core/page-interaction/)、[GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。
