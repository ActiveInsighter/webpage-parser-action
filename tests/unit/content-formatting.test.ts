import { describe, expect, it } from 'vitest'
import { fitMarkdown, toMarkdown } from '@/page/extract/markdown'
import { normalizeContent } from '@/page/extract/normalize'
import { LIMITS } from '@/core/limits'

const url = 'https://example.com/posts/article'

describe('portable article content', () => {
  it('removes explicitly hidden content before discarding presentation attributes', () => {
    const content = normalizeContent(`<p>Readable paragraph.</p>
      <section hidden><p>Hidden recommendations</p><img src="/tracking.png"></section>
      <p style="display: none !important">Invisible duplicate</p>
      <p style="visibility: hidden; opacity: 0">Article awaiting initialization</p>
      <p style="color: red">Visible emphasis</p>`, url)

    expect(content.text).toBe('Readable paragraph. Article awaiting initialization Visible emphasis')
    expect(content.images).toEqual([])
    expect(content.html).not.toContain('style=')
  })

  it('separates adjacent blocks while preserving words split by inline markup', () => {
    const content = normalizeContent('<p>one</p><p>two<br>three</p><div><span>inter</span><em>national</em></div>', url)
    expect(content.text).toBe('one two three international')
  })

  it('keeps MathML formulas without requiring HTML style properties', () => {
    expect(normalizeContent('<math><mi>x</mi><mo>+</mo><mn>1</mn></math>', url).html).toContain('<math>')
  })

  it('does not manufacture article URLs for missing or blank image sources', () => {
    const content = normalizeContent('<img alt="Missing diagram"><img src="  " alt="Blank diagram">', url)
    expect(content.images).toEqual([])
    expect(content.html).not.toContain('<img')
    expect(content.text).toContain('Missing diagram')
    expect(content.text).toContain('Blank diagram')
  })

  it('normalizes compact srcsets and picture sources without keeping unsafe candidates', () => {
    const content = normalizeContent(`<picture>
      <source srcset="/small.webp 1x,/large.webp 2x">
      <img src="/fallback.png" srcset="/small.png 400w, javascript:alert(1) 600w,/large.png 800w">
    </picture>`, url)
    expect(content.html).toContain('srcset="https://example.com/small.webp 1x, https://example.com/large.webp 2x"')
    expect(content.html).toContain('srcset="https://example.com/small.png 400w, https://example.com/large.png 800w"')
    expect(content.html).not.toContain('javascript:')
  })

  it('removes active embedded documents and normalizes media poster URLs', () => {
    const content = normalizeContent(`<iframe src="https://example.net/player" srcdoc="untrusted"></iframe>
      <video poster="/poster.jpg" src="javascript:alert(1)"></video>
      <video poster="javascript:alert(2)"><source src="/movie.mp4"></video>`, url)
    expect(content.html).not.toMatch(/iframe|srcdoc|javascript:/u)
    expect(content.html).toContain('poster="https://example.com/poster.jpg"')
    expect(content.html).toContain('src="https://example.com/movie.mp4"')
  })
})

describe('article Markdown fidelity', () => {
  it('preserves code indentation, repeated blank lines, and embedded fences', () => {
    const code = '    nested()\n\n\n    print("```")\n'
    const markdown = toMarkdown(`<pre><code class="language-python">${code}</code></pre>`, url)
    expect(markdown).toBe('````python\n    nested()\n\n\n    print("```")\n````')
  })

  it('treats plain preformatted text as code without flattening its lines', () => {
    expect(toMarkdown('<pre>    one\n\n\n    two\n</pre>', url)).toBe('```\n    one\n\n\n    two\n```')
  })

  it('keeps code inside a blockquote quoted when restoring blank lines', () => {
    const markdown = toMarkdown('<blockquote><pre><code>  a\n\n\n  b</code></pre></blockquote>', url)
    expect(markdown).toBe('> ```\n>   a\n> \n> \n>   b\n> ```')
  })

  it('closes a code fence when a very long block is truncated', () => {
    const input = `Opening paragraph\n\n\`\`\`text\n${'x'.repeat(LIMITS.markdownChars)}\n\`\`\``
    const result = fitMarkdown(input)
    expect(result.truncated).toBe(true)
    expect(result.markdown.length).toBeLessThanOrEqual(LIMITS.markdownChars)
    expect(result.markdown.startsWith('Opening paragraph\n\n```text\n')).toBe(true)
    expect(result.markdown.endsWith('\n```')).toBe(true)
  })

  it('does not close a shorter fence found within a longer fenced block', () => {
    const input = `\`\`\`\`md\nExample:\n\n\`\`\`js\nx()\n\`\`\`\n\n${'x'.repeat(LIMITS.markdownChars)}`
    const result = fitMarkdown(input)
    expect(result.markdown.endsWith('\n````')).toBe(true)
    expect(result.markdown.length).toBeLessThanOrEqual(LIMITS.markdownChars)
  })

  it('does not add an orphan closing fence when reserving space removes its opening', () => {
    const input = `${'x'.repeat(LIMITS.markdownChars - 5)}\n\`\`\`text\ncode\n\`\`\``
    const result = fitMarkdown(input)
    expect(result.markdown).not.toContain('```')
    expect(result.markdown.length).toBeLessThanOrEqual(LIMITS.markdownChars)
  })
})
