import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { prepareReplayDocument } from '../e2e/replay-document.mjs'

const url = 'https://mp.weixin.qq.com/s/saved-article'

describe('saved-page replay quality', () => {
  it('preserves JSON-LD, initial JSON and inline publication data while disabling executable scripts', () => {
    const json = { initialState: { entities: { articles: { '42': { title: 'Saved article', content: '<p>Content</p>' } } } } }
    const html = prepareReplayDocument(`<script type="application/ld+json">{"@type":"Article","headline":"Saved article"}</script>
      <script id="js-initialData" type="application/json">${JSON.stringify(json)}</script>
      <script id="timestamp">var ct = "1772668800"; window.location.href = '/redirect';</script>
      <script id="module" type="module">throw new Error('must not execute')</script>
      <script src="https://example.com/application.js"></script><article>Content</article>`, url)
    const snapshot = new JSDOM(html, { url })
    try {
      const document = snapshot.window.document
      expect(JSON.parse(document.querySelector('script[type="application/ld+json"]')!.textContent!)).toMatchObject({ headline: 'Saved article' })
      expect(JSON.parse(document.querySelector('script#js-initialData')!.textContent!)).toEqual(json)
      expect(document.querySelector('#timestamp')?.textContent).toContain('ct = "1772668800"')
      expect(document.querySelector('#timestamp')?.getAttribute('type')).toBe('application/x-aw-replay-data')
      expect(document.querySelector('#module')?.getAttribute('type')).toBe('application/x-aw-replay-data')
      expect(document.querySelector('script[src]')).toBeNull()
    } finally {
      snapshot.window.close()
    }
  })

  it('removes automatic navigation, embedded contexts, inline handlers and active URL attributes', () => {
    const html = prepareReplayDocument(`<meta HTTP-EQUIV="refresh" content="0;url=https://example.com/redirect">
      <meta http-equiv="Content-Security-Policy" content="script-src 'none'">
      <body onload="window.__savedExecuted=true"><iframe srcdoc="<script>alert(1)</script>"></iframe>
      <object data="data:text/html,active"></object><img id="image" src="/photo.jpg" onerror="window.__savedExecuted=true">
      <a id="link" href="java&#10;script:alert(1)">link</a>
      <script>window.__savedExecuted=true</script><article>Saved content</article></body>`, url)
    const snapshot = new JSDOM(html, { url, runScripts: 'dangerously' })
    try {
      const { document } = snapshot.window
      expect(document.querySelector('meta[http-equiv], iframe, object, [onload], [onerror], [srcdoc]')).toBeNull()
      expect(document.querySelector('#link')?.hasAttribute('href')).toBe(false)
      document.querySelector('#image')?.dispatchEvent(new snapshot.window.Event('error'))
      expect(snapshot.window.__savedExecuted).toBeUndefined()
      expect(document.querySelector('article')?.textContent).toBe('Saved content')
      const agent = document.createElement('script')
      agent.textContent = 'window.__agentAllowed = true'
      document.body.append(agent)
      expect(snapshot.window.__agentAllowed).toBe(true)
    } finally {
      snapshot.window.close()
    }
  })

  it('never executes the original saved page while preparing its DOM', () => {
    expect(() => prepareReplayDocument('<script>throw new Error("original page executed")</script><p>Saved</p>', url)).not.toThrow()
  })
})
