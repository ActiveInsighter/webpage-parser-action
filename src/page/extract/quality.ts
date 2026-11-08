import { WARNINGS } from '@/core/contract'
import { ACCEPTABLE_SCORE } from '@/core/limits'
import type { NormalizedContent } from './normalize'
import { countWords } from './text'

export interface Assessment {
  score: number
  wordCount: number
  warnings: string[]
}

export { ACCEPTABLE_SCORE }

const SHORT_WORDS = 80
const LINK_HEAVY = 0.5

/**
 * How much the extraction looks like real content, 0–100. Length has diminishing returns, so a
 * good short article still passes; link-heavy text (navigation, indexes) pays a penalty.
 */
export function assessContent(content: NormalizedContent, fields: { title: string }): Assessment {
  const wordCount = countWords(content.text)
  const warnings: string[] = []

  const length = Math.min(60, 60 * (Math.log10(wordCount + 1) / Math.log10(1000)))
  const structure = Math.min(25, content.blocks * 5)
  const titled = fields.title ? 15 : 0
  const penalty = content.linkDensity > LINK_HEAVY ? (content.linkDensity - LINK_HEAVY) * 80 : 0
  const score = Math.max(0, Math.min(100, Math.round(length + structure + titled - penalty)))

  if (wordCount < SHORT_WORDS) warnings.push(WARNINGS.shortContent)
  if (content.linkDensity > LINK_HEAVY) warnings.push(WARNINGS.linkHeavy)
  if (!fields.title) warnings.push(WARNINGS.noTitle)
  return { score, wordCount, warnings }
}
