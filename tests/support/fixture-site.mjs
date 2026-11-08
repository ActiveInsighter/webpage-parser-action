import { createServer } from 'node:http'

/** A local site with the page shapes that break naive capture. */
const article = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<meta name="author" content="测试作者"><meta property="og:site_name" content="夹具站"></head>
<body><nav><a href="/">首页</a></nav><main><article><h1>${title}</h1>${body}</article></main><footer>页脚内容</footer></body></html>`

const paragraphs = (label, count = 6) =>
  Array.from({ length: count }, (_, index) => `<p>${label}第 ${index + 1} 段：这是一段足够长的正文内容，用来模拟真实文章的段落结构，保证解析器能够把它识别为主要内容而不是页面噪音。</p>`).join('')

const codeSample = [
  '  const fence = "```"', '', '',
  '  function render() {', '    return fence', '  }',
  ...Array.from({ length: 250 }, (_, index) => `  // retained-code-line-${index}`),
  '  // final-code-line', '',
].join('\n')

const html = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(body)
}

const routes = {
  '/article': (_req, res) => html(res, article('静态文章', `${paragraphs('静态')}<pre><code class="language-js">console.log('code')</code></pre><p><a href="/next?utm_source=x">下一篇文章的链接</a></p>`)),
  '/spa': (_req, res) => html(res, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>单页应用</title></head><body><div id="root">加载中…</div>
    <script>setTimeout(() => { document.querySelector('#root').innerHTML = ${JSON.stringify(`<article><h1>脚本渲染的标题</h1>${paragraphs('脚本')}</article>`)} }, 900)</script></body></html>`),
  '/wait-for': (_req, res) => html(res, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>慢内容</title></head><body><main id="m"><h1>慢内容</h1>${paragraphs('先到')}</main>
    <script>setTimeout(() => { document.querySelector('#m').insertAdjacentHTML('beforeend', ${JSON.stringify(`<section id="late">${paragraphs('后到')}</section>`)}) }, 5000)</script></body></html>`),
  '/lazy': (_req, res) => html(res, article('懒加载图片', `${paragraphs('图文')}<img id="lazy" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/image/real.png" alt="真实图片">`)),
  '/quality-code': (_req, res) => html(res, article('代码保真', `${paragraphs('代码说明')}<pre id="quality-code"><code class="language-js">${codeSample}</code></pre>`)),
  '/quality-responsive': (_req, res) => html(res, article('响应式图片', `${paragraphs('响应式图文')}<img srcset="/image/real.png?size=320 320w,/image/real.png?size=1280 1280w" alt="只有 srcset 的高清图片">`)),
  '/quality-metadata': (_req, res) => html(res, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>带站点后缀的页面标题</title>
    <link rel="Canonical" href="/quality-metadata?canonical=1">
    <meta property="article:published_time" content="2026-02-31">
    <meta property="og:image" content="javascript:alert(1)">
    <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [
      { '@type': 'NewsArticle', '@id': '#article', headline: '图谱正文标题', author: { '@id': '#author' }, publisher: { '@id': '#publisher' }, image: { '@id': '#cover' }, datePublished: '2026-11-05T08:30:00+08:00' },
      { '@type': 'Person', '@id': '#author', name: '图谱作者' },
      { '@type': 'Organization', '@id': '#publisher', name: '图谱出版社' },
      { '@type': 'ImageObject', '@id': '#cover', contentUrl: '/image/real.png?cover=1' },
    ] })}</script></head><body><article><h1>图谱正文标题</h1>${paragraphs('可见正文')}
    <section hidden><p>隐藏旧版正文噪音</p><img src="/image/real.png?tracking=1" alt="隐藏跟踪图片"></section>
    <p style="display: none !important">不可见的重复推荐内容</p>
    </article></body></html>`),
  '/infinite': (_req, res) => html(res, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>无限滚动</title></head><body><main id="feed"><h1>无限滚动</h1>${paragraphs('第一屏', 12)}</main>
    <script>let page = 1; addEventListener('scroll', () => {
      if (page < 4 && innerHeight + scrollY >= document.documentElement.scrollHeight - 50) {
        page += 1; const n = page;
        setTimeout(() => document.querySelector('#feed').insertAdjacentHTML('beforeend', '<section><h2>第 ' + n + ' 批内容</h2><p>' + '滚动后才出现的正文内容。'.repeat(40) + '</p></section>'), 100);
      }
    });</script></body></html>`),
  '/noise': (_req, res) => html(res, article('带噪音的页面', `${paragraphs('有用')}<div class="promo">${paragraphs('广告内容')}</div>`)),
  '/redirect': (_req, res) => {
    res.writeHead(302, { Location: '/article' })
    res.end()
  },
  '/js-redirect': (_req, res) => html(res, `<!doctype html><title>跳转中</title><script>location.replace('/article')</script>`),
  '/missing': (_req, res) => html(res, article('页面不存在', '<p>404</p>'), 404),
  '/server-error': (_req, res) => html(res, '<h1>Internal Server Error</h1>', 500),
  '/members': (_req, res) => {
    res.writeHead(302, { Location: '/login?next=/members' })
    res.end()
  },
  '/login': (_req, res) => html(res, `<!doctype html><title>登录</title><form><input name="u"><input type="password" name="p"><button>登录</button></form>`),
  '/challenge': (_req, res) => html(res, `<!doctype html><title>Just a moment...</title><body><div id="cf-challenge-running">Verifying you are human</div></body>`),
  '/refused': (_req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end('{"error":{"message":"请求存在异常，暂时限制本次访问","code":40362}}')
  },
  '/verify': (_req, res) => html(res, `<!doctype html><title>Weixin Official Accounts Platform</title><body><h2>环境异常</h2><p>当前环境异常，完成验证后即可继续访问。</p></body>`),
  '/never-loads': (_req, res) => html(res, article('永不结束的页面', `${paragraphs('慢资源')}<img src="/hang.png" alt="挂起">`)),
  '/hang.png': () => {},
  '/empty': (_req, res) => html(res, `<!doctype html><html><head><title>空页面</title></head><body></body></html>`),
  '/thin': (_req, res) => html(res, `<!doctype html><html><head><title>很短</title></head><body><p>只有一句话。</p></body></html>`),
  '/doc.pdf': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf' })
    res.end('%PDF-1.4\n%%EOF\n')
  },
  '/image/real.png': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' })
    res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
  },
}

export async function startFixtureSite() {
  const hits = new Map()
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://fixture')
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1)
    const route = routes[pathname]
    if (route) route(req, res)
    else html(res, 'not found', 404)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, hits, stop: () => (server.closeAllConnections(), new Promise((resolve) => server.close(resolve))) }
}
