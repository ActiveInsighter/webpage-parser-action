// Renders public/icons/*.png from the SVG below. Run by hand after changing the mark.
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons')
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#5b5bd6"/>
  <path d="M38 50V38h12M90 50V38H78M38 78v12h12M90 78v12H78" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M52 56h24M52 72h16" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"/>
</svg>`

await mkdir(out, { recursive: true })
const browser = await chromium.launch()
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`)
  await page.screenshot({ path: path.join(out, `${size}.png`), omitBackground: true })
  await page.close()
}
await browser.close()
