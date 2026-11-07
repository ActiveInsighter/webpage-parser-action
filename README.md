# Webpage Parser Action · Crawl4AI

在 GitHub Actions runner 内运行开源 **Crawl4AI 0.9.5 + Chromium**，渲染 JavaScript 后提取内容，无需 Crawl4AI Cloud API Key 或 LLM。支持普通网页 CSS 提取与公开 X 帖子提取。

仓库：https://github.com/ActiveInsighter/webpage-parser-action

## 远程抓取 X 帖子

```bash
gh workflow run fetch-page.yml \
  --repo ActiveInsighter/webpage-parser-action --ref main \
  -f url='https://x.com/jack/status/20' \
  -f mode=x -f max_posts=1 -f delay=5 -f timeout=45 -f retries=0
```

一次抓取多条链接，将 `url` 设为换行分隔的字符串（最多 10 个地址）。例如从 Bash 发起：

```bash
gh workflow run fetch-page.yml \
  --repo ActiveInsighter/webpage-parser-action --ref main \
  -f url=$'https://x.com/jack/status/20\nhttps://x.com/NASA/status/2041557036274475228\nhttps://x.com/OpenAI/status/2047376561205325845' \
  -f mode=x -f max_posts=1 -f delay=5 -f timeout=45 -f retries=0
```

从普通 HTTP 客户端调用，预先在环境中设置 `GH_TOKEN`：

```bash
curl --fail-with-body --request POST \
  --header "Authorization: Bearer $GH_TOKEN" \
  --header 'Accept: application/vnd.github+json' \
  --header 'Content-Type: application/json' \
  'https://api.github.com/repos/ActiveInsighter/webpage-parser-action/actions/workflows/fetch-page.yml/dispatches' \
  --data '{"ref":"main","inputs":{"url":"https://x.com/jack/status/20","mode":"x","max_posts":"1","delay":"5","timeout":"45","retries":"0"}}'
```

令牌必须有权触发本仓库的工作流：fine-grained PAT 选择本仓库并授予 **Actions: write**。不要将令牌放入公开代码。任务异步运行，触发响应不直接返回抓取内容。

## 获取结果

```bash
gh run list --repo ActiveInsighter/webpage-parser-action \
  --workflow fetch-page.yml --event workflow_dispatch --limit 5
# 将 RUN_ID 替换为对应运行 ID；并发请求时核对时间及输入参数。
gh run watch RUN_ID --repo ActiveInsighter/webpage-parser-action --exit-status
gh run download RUN_ID --repo ActiveInsighter/webpage-parser-action --dir results
```

HTTP 客户端可查询 `/repos/ActiveInsighter/webpage-parser-action/actions/runs/{run_id}/artifacts`，再跟随附件的 `archive_download_url` 重定向下载 ZIP。

成功或失败都会尽量保留附件 30 天，不自动提交结果到仓库：

- `result.json`：结构化结果、成功状态和失败诊断。
- `page.html`：Chromium 渲染后的 DOM。
- `page.md`：Crawl4AI 生成的 Markdown。
- `page.png`：浏览器截图；导航失败时可能没有截图。

多地址任务对应 `page-01.*`、`page-02.*` 等；JSON 使用 `results` 数组，每项对应一个输入地址。单地址保持原来的顶层 `items`、`count`、`title` 等字段，并新增 `engine`、`mode`、`success`。

X 模式额外输出 `posts`：帖子 ID、原始链接、账号、可见正文、发布时间、图片 URL，以及页面提供的互动计数。旧版 DOM 的 `posted_at` 为 ISO 时间；新版仅显示日期文字时，保留 `posted_at_text`，`posted_at` 为 `null`，不推测时区。互动数据只是抓取时的快照。

X 模式仅统计识别到的帖子卡片；登录提示、错误页或空白页会设置 `success: false` 并使任务失败。批量任务任一地址失败时整体失败，同时保留其他地址的成功结果。

## 可修改参数

| 远程输入 | 默认值 | 说明 |
| --- | --- | --- |
| `url` | `TARGET_URL`，否则 `https://example.com` | 一个 URL 或换行分隔的多个 URL，最多 10 个 |
| `mode` | `PARSER_MODE`，否则 `auto` | `auto` 按域名判断；`page` 普通网页；`x` 帖子卡片 |
| `selector` | `PARSER_SELECTOR`，否则 `body` | 普通网页的 CSS 选择器 |
| `attribute` | `PARSER_ATTRIBUTE`，否则空 | 普通网页：空表示文字；可填 `href`、`src`、`content` 等 |
| `timeout` | `30` | 导航及可选 CSS 等待的超时秒数，范围 (0,120] |
| `retries` | `2` | 网络/导航失败、429 或临时 5xx 的重试次数，0–5 |
| `wait_for` | `PARSER_WAIT_FOR`，否则空 | 等待指定 CSS 元素出现；不接受 JavaScript 代码 |
| `delay` | `3` | 等待动态内容渲染的额外秒数，0–30 |
| `max_posts` | `5` | 每个页面最多返回多少条可见帖子，1–50 |

X 模式使用专门的卡片提取规则，`selector` 和 `attribute` 用于普通网页模式。帖子详情页可能显示回复，`max_posts=1` 通常只返回首条原帖。该参数限制返回数量，不保证页面加载到这么多条；当前不自动滚动或翻页。

未提供或为空的字符串会回退到仓库 Variables。手动任务的数值输入使用界面/API 的值；定时任务的 `delay`、`max_posts` 可由 `PARSER_DELAY`、`PARSER_MAX_POSTS` 控制，导航超时和重试默认 30 秒、2 次。

## 普通网页与定时任务

```bash
gh workflow run fetch-page.yml \
  --repo ActiveInsighter/webpage-parser-action \
  -f url='https://example.com' -f mode=page -f selector=title
```

每小时第 17 分钟（UTC）自动运行，读取仓库 **Settings → Secrets and variables → Actions → Variables**。例如：

```bash
gh variable set TARGET_URL --body 'https://x.com/jack/status/20' --repo ActiveInsighter/webpage-parser-action
gh variable set PARSER_MODE --body 'x' --repo ActiveInsighter/webpage-parser-action
gh variable set PARSER_MAX_POSTS --body '1' --repo ActiveInsighter/webpage-parser-action
```

频率在 [.github/workflows/fetch-page.yml](.github/workflows/fetch-page.yml) 修改。GitHub 定时任务可能延迟，公开仓库长期无活动时也可能自动停用。单次工作流上限为 20 分钟，包括依赖和浏览器安装。

## 在其他工作流复用

```yaml
permissions:
  contents: read
jobs:
  crawl:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: ActiveInsighter/webpage-parser-action@main
        id: webpage
        with:
          url: https://x.com/jack/status/20
          mode: x
          max-posts: '1'
          delay: '5'
      - if: always()
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: crawl-results
          path: results/
```

正式使用建议将 `main` 替换为审核后的提交 SHA。Action 使用 Linux runner，通过临时 Python 虚拟环境安装锁定依赖并安装 Chromium，提供 `count` 和 `result-path` 输出。组合 Action 参数使用 `wait-for`、`max-posts`；远程 workflow 输入使用 `wait_for`、`max_posts`。

## 本地开发

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r requirements.txt
.venv/bin/python -m playwright install --with-deps chromium
.venv/bin/python parser.py --url https://x.com/jack/status/20 --mode x --max-posts 1 --delay 5
.venv/bin/python -m unittest discover -s tests -v
```

更新依赖后使用 `uv pip compile requirements.in --python-version 3.12 --generate-hashes -o requirements.txt` 重新生成锁文件。浏览器缓存、日志放在项目 `.crawl4ai/` 下，抓取结果在 `results/`，均不提交。

当前使用未登录浏览器直接访问 X，无外部代抓服务，也未自动使用本机账号 Cookie。能否看到帖子取决于 X 返回的页面；登录要求、访问限制、已删除帖子或 DOM 变化仍可能导致失败。图片仅保存 URL，不下载原图或视频。公开仓库的日志及结果只适合处理公开内容。

参考：[Crawl4AI 开源库](https://github.com/unclecode/crawl4ai)、[浏览器配置](https://docs.crawl4ai.com/api/parameters/)、[动态内容等待](https://docs.crawl4ai.com/core/page-interaction/)、[GitHub 远程触发 API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。
