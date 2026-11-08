import { describe, expect, it } from 'vitest'
import { detectBlocker } from '@/page/blockers'
import { defineSite } from '@/sites/types'
import { dom } from './helpers'

const page = 'https://site.example/post/1'
const long = '这是一篇正文内容很长的文章。'.repeat(100)

describe('detectBlocker', () => {
  it('passes ordinary pages, even articles about these topics', () => {
    const article = `<title>How CAPTCHA works</title><body><p>${long}</p><div class="g-recaptcha"></div></body>`
    expect(detectBlocker(dom(article, page), page, page, null)).toBeNull()
  })

  it('spots a challenge page', () => {
    expect(detectBlocker(dom('<title>Just a moment...</title><body>Checking your browser</body>', page), page, page, null)?.code).toBe('CAPTCHA')
    expect(detectBlocker(dom('<body><iframe src="https://challenges.cloudflare.com/x"></iframe></body>', page), page, page, null)?.code).toBe('CAPTCHA')
  })

  it('sees through a challenge page padded with inline script', () => {
    const padded = `<title>Just a moment...</title><body><script>window._cf_chl_opt = "${'x'.repeat(5000)}"</script></body>`
    expect(detectBlocker(dom(padded, page), page, page, null)?.code).toBe('CAPTCHA')
  })

  it('reads a verification notice in Chinese, but only on a sparse page', () => {
    const wall = '<title>Weixin Official Accounts Platform</title><body><h2>环境异常</h2><p>当前环境异常，完成验证后即可继续访问。</p></body>'
    expect(detectBlocker(dom(wall, page), page, page, null)?.code).toBe('CAPTCHA')
    const article = `<body><p>本文讨论服务器环境异常的排查方法。${long}</p></body>`
    expect(detectBlocker(dom(article, page), page, page, null)).toBeNull()
  })

  it('treats a bare 403 as a refusal, and a full page with a 403 as a page', () => {
    expect(detectBlocker(dom('<body>Forbidden</body>', page), page, page, null, 403)?.code).toBe('ACCESS_DENIED')
    expect(detectBlocker(dom(`<body><p>${long}</p></body>`, page), page, page, null, 403)).toBeNull()
  })

  it('spots a redirect to a login form', () => {
    const final = 'https://site.example/login?next=/post/1'
    const form = `<body><p>${long}</p><input type="password"></body>`
    expect(detectBlocker(dom(form, final), final, page, null)?.code).toBe('LOGIN_REQUIRED')
  })

  it('leaves a page the user asked for at a login path alone unless it is only a form', () => {
    const login = 'https://site.example/login'
    const withText = `<body><p>${long}</p><input type="password"></body>`
    expect(detectBlocker(dom(withText, login), login, login, null)).toBeNull()
  })

  it('spots a bare password wall on the same URL', () => {
    expect(detectBlocker(dom('<body><input type="password"></body>', page), page, page, null)?.code).toBe('LOGIN_REQUIRED')
  })

  it('applies site rules first, with all parts of a rule required', () => {
    const profile = defineSite({
      id: 's',
      version: 1,
      hosts: ['site.example'],
      blockers: [{ code: 'CAPTCHA', selector: '.verify', text: /环境异常/u, message: '站点要求验证' }],
    })
    const blocked = detectBlocker(dom(`<body><div class="verify">环境异常</div><p>${long}</p></body>`, page), page, page, profile)
    expect(blocked).toMatchObject({ code: 'CAPTCHA', message: '站点要求验证' })
    expect(detectBlocker(dom(`<body><div class="verify">正常</div><p>${long}</p></body>`, page), page, page, profile)).toBeNull()
  })
})
