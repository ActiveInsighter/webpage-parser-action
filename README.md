# Webpage Parser Action

自动请求 HTML 网页，通过 CSS 选择器提取文字或属性，输出 JSON。支持每小时定时执行、GitHub 页面手动执行、远程 API 调用，以及在其他工作流中复用。

仓库：https://github.com/ActiveInsighter/webpage-parser-action

## 远程调用

已登录 GitHub CLI 时，执行下面的命令。更改 `url`、`selector`、`attribute` 即可；`attribute` 留空表示提取文字。

```bash
gh workflow run fetch-page.yml \
  --repo ActiveInsighter/webpage-parser-action --ref main \
  -f url='https://example.com' \
  -f selector='title' \
  -f attribute='' \
  -f timeout=30 -f retries=2
```

提取链接可使用 `selector='a[href]'` 和 `attribute='href'`。

不使用 CLI 时，也可以从远程服务调用 GitHub REST API。事先在运行环境设置 `GH_TOKEN`，不要将真实令牌写进代码。令牌需要能够触发本仓库的工作流：fine-grained PAT 选择本仓库并授予 **Actions: write** 权限；经典 PAT 对公开仓库可以使用 `public_repo`。

```bash
curl --fail-with-body --request POST \
  --header "Authorization: Bearer $GH_TOKEN" \
  --header 'Accept: application/vnd.github+json' \
  --header 'Content-Type: application/json' \
  'https://api.github.com/repos/ActiveInsighter/webpage-parser-action/actions/workflows/fetch-page.yml/dispatches' \
  --data '{"ref":"main","inputs":{"url":"https://example.com","selector":"title","attribute":"","timeout":"30","retries":"2"}}'
```

这是异步任务，触发响应不会直接返回网页内容。执行完成后下载对应运行的 JSON 附件：

```bash
gh run list --repo ActiveInsighter/webpage-parser-action \
  --workflow fetch-page.yml --event workflow_dispatch --limit 5
# 将 RUN_ID 替换成上一步中对应任务的 ID（并发调用时按调用时间和参数确认）。
gh run watch RUN_ID --repo ActiveInsighter/webpage-parser-action --exit-status
gh run download RUN_ID --repo ActiveInsighter/webpage-parser-action --dir results
```

如果从普通 HTTP 客户端取结果，先查询 `/repos/ActiveInsighter/webpage-parser-action/actions/runs/{run_id}/artifacts`，再跟随所选附件 `archive_download_url` 的重定向下载 ZIP。下载附件需要登录并拥有仓库读取权限。

## 可修改参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `url` | 仓库变量 `TARGET_URL`，否则 `https://example.com` | 完整 HTTP/HTTPS 地址 |
| `selector` | 仓库变量 `PARSER_SELECTOR`，否则 `body` | CSS 选择器，如 `h1`、`article p`、`.item a` |
| `attribute` | 仓库变量 `PARSER_ATTRIBUTE`，否则空 | 空表示文字；可填 `href`、`src`、`content` 等 |
| `timeout` | `30` | 每次连接/读取的超时秒数，大于 0 且不超过 120 |
| `retries` | `2` | 临时错误的重试次数，0–5；429、500、502、503、504 等会重试 |

手动调用中空字符串会回退到仓库变量。若希望默认提取文字，不要设置 `PARSER_ATTRIBUTE`，或删除已有的该变量。没有匹配元素时仍成功，结果为 `count: 0`；HTTP 错误、无效参数或选择器会令任务失败。

## 定时任务

在仓库 **Settings → Secrets and variables → Actions → Variables** 中配置默认值，或使用 CLI：

```bash
gh variable set TARGET_URL --body 'https://example.com' --repo ActiveInsighter/webpage-parser-action
gh variable set PARSER_SELECTOR --body 'title' --repo ActiveInsighter/webpage-parser-action
# 需要提取属性时再设置；留空则提取文字。
# gh variable set PARSER_ATTRIBUTE --body 'href' --repo ActiveInsighter/webpage-parser-action
```

默认在每小时第 17 分钟（UTC）请求一次，读取上述 Variables。频率可在 [.github/workflows/fetch-page.yml](.github/workflows/fetch-page.yml) 中修改。GitHub 定时任务可能延迟，公开仓库连续 60 天无活动时定时工作流可能自动停用；可在 Actions 页面重新启用。

## 输出

每次成功运行会生成 `results/result.json`，以 `webpage-result-运行ID-重跑次数` 为附件名保存 30 天，不自动提交到 Git 仓库。

```json
{
  "requested_url": "https://example.com",
  "final_url": "https://example.com/",
  "fetched_at": "2026-11-07T00:00:00+00:00",
  "status_code": 200,
  "selector": "title",
  "attribute": null,
  "title": "Example Domain",
  "items": ["Example Domain"],
  "count": 1
}
```

文字会合并空白并移除脚本、样式等节点。`href`、`src`、`action` 属性会根据重定向后的地址和 HTML `<base>` 转换为绝对地址，缺少属性的元素会跳过。

## 作为 Action 复用

在其他仓库的工作流中使用（正式使用建议将 `main` 替换为审核后的提交 SHA）：

```yaml
permissions:
  contents: read
jobs:
  parse:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: ActiveInsighter/webpage-parser-action@main
        id: webpage
        with:
          url: https://example.com
          selector: title
          attribute: ''
          timeout: '30'
          retries: '2'
      - run: cat results/result.json
```

Action 提供 `count` 和 `result-path` 两个输出。复用时如需长期保存结果，请在调用方增加上传附件步骤。本 Action 在 Linux runner 上运行，使用独立的临时 Python 虚拟环境安装带哈希锁定的依赖。

## 本地开发

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r requirements.txt
.venv/bin/python parser.py --url https://example.com --selector title
.venv/bin/python -m unittest discover -s tests -v
```

依赖定义在 `requirements.in`，更新后使用 `uv pip compile requirements.in --generate-hashes -o requirements.txt` 重新生成锁文件。

当前解析服务器返回的静态 HTML，不执行 JavaScript；依赖浏览器渲染或登录的内容需要另行适配。单次响应最多 10 MiB；工作流最长运行 15 分钟。仓库及运行日志公开，附件中也可能包含网页数据，请仅向本任务传入适合公开处理的地址。

参考：[GitHub 远程触发 API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)、[定时任务](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)、[组合 Action](https://docs.github.com/en/actions/tutorials/create-actions/create-a-composite-action)、[Beautiful Soup](https://www.crummy.com/software/BeautifulSoup/bs4/doc/)。
