import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CrawlError } from '@/core/errors'
import { cleanText, click, queryAll, removeAll, visibleText } from '@/page/ops/dom'
import { materializeImages } from '@/page/ops/images'
import { budget } from '@/page/ops/time'
import { waitForQuiet, waitForSelector } from '@/page/ops/wait'
import { runSteps } from '@/page/steps'

const soon = () => Date.now() + 5_000

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('dom', () => {
  it('reports a malformed selector as a step failure', () => {
    expect(() => queryAll('div[')).toThrowError(CrawlError)
    try {
      queryAll('div[')
    } catch (error) {
      expect((error as CrawlError).code).toBe('STEP_FAILED')
    }
  })

  it('removes matches and collapses text', () => {
    document.body.innerHTML = '<p class="x">a</p><p class="x">b</p>'
    expect(removeAll('.x')).toBe(2)
    expect(document.querySelectorAll('p')).toHaveLength(0)
    expect(cleanText('  a\n\t b ')).toBe('a b')
  })

  it('does not count inline scripts as visible text', () => {
    document.body.innerHTML = `<div id="root">加载中</div><script>window.__STATE__ = ${JSON.stringify('x'.repeat(500))}</script><style>a{}</style>`
    expect(visibleText(document)).toBe('加载中')
  })

  it('skips disabled controls', () => {
    document.body.innerHTML = '<button disabled>x</button>'
    expect(click(document.querySelector('button')!)).toBe(false)
  })
})

describe('budget', () => {
  it('caps at the limit and throws when spent', () => {
    expect(budget(Date.now() + 10_000, 100)).toBe(100)
    expect(() => budget(Date.now() - 1)).toThrowError(CrawlError)
  })
})

describe('waits', () => {
  it('resolves when the element appears later', async () => {
    const waiting = waitForSelector('#late', 2_000)
    setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<div id="late"></div>'), 20)
    await expect(waiting).resolves.toBeInstanceOf(HTMLElement)
  })

  it('resolves null on timeout', async () => {
    await expect(waitForSelector('#never', 30)).resolves.toBeNull()
  })

  it('reports a page that never goes quiet', async () => {
    const churn = setInterval(() => document.body.insertAdjacentHTML('beforeend', '<i></i>'), 5)
    await expect(waitForQuiet({ quietMs: 40, timeoutMs: 120 })).resolves.toBe(false)
    clearInterval(churn)
    await expect(waitForQuiet({ quietMs: 10, timeoutMs: 500 })).resolves.toBe(true)
  })

  it('keeps waiting through silence until the content arrives', async () => {
    document.body.textContent = 'Loading…'
    setTimeout(() => (document.body.textContent = '字'.repeat(300)), 80)
    await expect(waitForQuiet({ quietMs: 20, minChars: 200, timeoutMs: 1_000 })).resolves.toBe(true)
    expect(document.body.textContent).toHaveLength(300)
  })

  it('gives up on a page that stays short', async () => {
    document.body.textContent = 'tiny'
    await expect(waitForQuiet({ quietMs: 10, minChars: 200, timeoutMs: 60 })).resolves.toBe(false)
  })
})

describe('materializeImages', () => {
  it('promotes lazy sources over placeholders and keeps real ones', () => {
    document.body.innerHTML = `
      <img id="a" src="data:image/gif;base64,R0lGOD" data-src="https://cdn/a.png">
      <img id="b" data-original="https://cdn/b.png">
      <img id="c" src="https://cdn/real.png" data-src="https://cdn/other.png">
      <img id="d" src="/img/blank.gif" data-actualsrc="https://cdn/d.png" data-srcset="https://cdn/d2.png 2x">`
    expect(materializeImages(document)).toBe(3)
    expect(document.querySelector('#a')!.getAttribute('src')).toBe('https://cdn/a.png')
    expect(document.querySelector('#b')!.getAttribute('src')).toBe('https://cdn/b.png')
    expect(document.querySelector('#c')!.getAttribute('src')).toBe('https://cdn/real.png')
    expect(document.querySelector('#d')!.getAttribute('srcset')).toBe('https://cdn/d2.png 2x')
  })

  it('recovers images held in noscript', () => {
    const fallback = document.createElement('noscript')
    fallback.textContent = '<img src="https://cdn/n.png" alt="n">'
    document.body.append(fallback)
    expect(materializeImages(document)).toBe(1)
    expect(document.querySelector('img')!.getAttribute('src')).toBe('https://cdn/n.png')
  })
})

describe('runSteps', () => {
  it('runs steps in order', async () => {
    document.body.innerHTML = '<button id="more">more</button><aside>ad</aside>'
    const clicked = vi.fn()
    document.querySelector('#more')!.addEventListener('click', () => {
      clicked()
      document.body.insertAdjacentHTML('beforeend', '<article id="full">x</article>')
    })
    const { log, warnings } = await runSteps(
      [{ op: 'click', selector: '#more', pauseMs: 0 }, { op: 'wait', selector: '#full' }, { op: 'remove', selector: 'aside' }],
      soon(),
    )
    expect(clicked).toHaveBeenCalledOnce()
    expect(document.querySelector('aside')).toBeNull()
    expect(log).toEqual(['page visible', 'click 1', 'wait #full', 'remove 1'])
    expect(warnings).toEqual([])
  })

  it('turns a failed optional step into a warning', async () => {
    const { warnings } = await runSteps([{ op: 'click', selector: '#absent', optional: true }], soon())
    expect(warnings).toEqual(['step_skipped'])
  })

  it('fails the job on a required step', async () => {
    await expect(runSteps([{ op: 'wait', selector: '#absent', timeoutMs: 20 }], soon())).rejects.toMatchObject({ code: 'STEP_FAILED' })
  })

  it('does not swallow a timeout on an optional step', async () => {
    await expect(runSteps([{ op: 'wait', selector: '#absent', optional: true }], Date.now() - 1)).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})
