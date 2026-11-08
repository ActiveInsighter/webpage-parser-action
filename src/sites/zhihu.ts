import { defineSite, type SiteContext, type SiteFields } from './types'

type Entity = Record<string, unknown>

/**
 * Zhihu ships the page's data as JSON in `#js-initialData`, which outlives its class names, so
 * that comes first and the selectors below are the fallback. Field names vary between
 * camelCase and snake_case across pages, hence the pairs.
 */
function readEntities(context: SiteContext): Record<string, Record<string, Entity>> | null {
  const raw = context.document.querySelector('script#js-initialData')?.textContent
  if (!raw) return null
  try {
    const data = JSON.parse(raw) as { initialState?: { entities?: Record<string, Record<string, Entity>> } }
    return data.initialState?.entities ?? null
  } catch {
    return null
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function authorName(author: unknown, users: Record<string, Entity> | undefined): string {
  if (typeof author === 'string') return text(users?.[author]?.name)
  return author && typeof author === 'object' ? text((author as Entity).name) : ''
}

function timestamp(entity: Entity): string {
  const value = entity.created ?? entity.createdTime ?? entity.created_time
  return typeof value === 'number' ? String(value) : ''
}

function fromEntity(entity: Entity, title: string, users: Record<string, Entity> | undefined): SiteFields | null {
  const html = text(entity.content)
  if (!html) return null
  return {
    title,
    html,
    byline: authorName(entity.author, users),
    publishedAt: timestamp(entity),
    description: text(entity.excerpt),
    extras: {
      voteupCount: entity.voteupCount ?? entity.voteup_count ?? null,
      commentCount: entity.commentCount ?? entity.comment_count ?? null,
    },
  }
}

export const zhihu = defineSite({
  id: 'zhihu',
  version: 1,
  hosts: ['zhuanlan.zhihu.com', 'www.zhihu.com'],
  paths: [/^\/p\/\d+/u, /^\/question\/\d+/u],
  prepare: [
    { op: 'click', selector: '.Modal-closeButton', optional: true, pauseMs: 300 },
    { op: 'click', selector: '.ContentItem-expandButton', all: true, optional: true, pauseMs: 300 },
  ],
  content: { selectors: ['.Post-RichTextContainer', '.QuestionAnswer-content .RichContent-inner', '.RichContent-inner'] },
  fields: {
    title: ['.Post-Title', '.QuestionHeader-title'],
    byline: ['.AuthorInfo-name'],
    publishedAt: [['.ContentItem-time a', 'data-tooltip']],
  },
  blockers: [{ code: 'CAPTCHA', url: /\/account\/unhuman/u, message: '知乎要求安全验证，请在运行扩展的浏览器中完成后重试' }],
  extract(context) {
    const entities = readEntities(context)
    if (!entities) return null
    const { pathname } = context.url
    const article = /^\/p\/(\d+)/u.exec(pathname)?.[1]
    if (article) {
      const entity = entities.articles?.[article]
      return entity ? fromEntity(entity, text(entity.title), entities.users) : null
    }
    const [, question, answer] = /^\/question\/(\d+)(?:\/answer\/(\d+))?/u.exec(pathname) ?? []
    const title = question ? text(entities.questions?.[question]?.title) : ''
    const entity = answer ? entities.answers?.[answer] : undefined
    return entity ? fromEntity(entity, title, entities.users) : title ? { title } : null
  },
})
