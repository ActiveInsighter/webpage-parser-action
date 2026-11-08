import { JSDOM } from 'jsdom'

const INERT_SCRIPT_TYPE = 'application/x-aw-replay-data'
const DATA_SCRIPT_TYPES = new Set(['application/ld+json', 'application/json'])
const ACTIVE_EMBEDS = 'iframe, frame, frameset, object, embed, applet'

/**
 * Keep a saved page's DOM and embedded data, without running its application. JSDOM's default
 * parser runs no scripts and loads no resources. Inline script text stays readable to profiles
 * (for example a publication timestamp), but executable MIME types become inert data blocks.
 */
export function prepareReplayDocument(html, url) {
  const snapshot = new JSDOM(html, { url })
  try {
    const document = snapshot.window.document
    for (const embed of document.querySelectorAll(ACTIVE_EMBEDS)) embed.remove()
    for (const meta of document.querySelectorAll('meta[http-equiv]')) {
      const directive = meta.getAttribute('http-equiv')?.trim().toLowerCase()
      // Refresh would leave the snapshot; the original site's CSP could block our page agent.
      if (directive === 'refresh' || directive === 'content-security-policy' || directive === 'content-security-policy-report-only') meta.remove()
    }
    for (const script of document.querySelectorAll('script')) {
      if (script.hasAttribute('src')) {
        script.remove()
        continue
      }
      const type = script.getAttribute('type')?.trim().toLowerCase() ?? ''
      script.setAttribute('type', DATA_SCRIPT_TYPES.has(type) ? type : INERT_SCRIPT_TYPE)
    }
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase()
        if (name.startsWith('on') || name === 'srcdoc') element.removeAttribute(attribute.name)
        else if (['href', 'xlink:href', 'action', 'formaction'].includes(name)) {
          const value = attribute.value.replace(/[\u0000-\u0020]/gu, '')
          if (/^(?:javascript|vbscript|data):/iu.test(value)) element.removeAttribute(attribute.name)
        }
      }
    }
    return snapshot.serialize()
  } finally {
    snapshot.window.close()
  }
}
