const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

/** Word count that also works for Chinese: each CJK character counts as one word. */
export function countWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  const rest = text.replace(CJK, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0
  return cjk + rest
}

const UTC_PLUS_8 = '+08:00'
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const NAMED_MONTH = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
const DAY_FIRST = new RegExp(`\\b(\\d{1,2})\\s+${NAMED_MONTH}\\s+(\\d{4})\\b`, 'iu')
const MONTH_FIRST = new RegExp(`\\b${NAMED_MONTH}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'iu')

function pad(value: string | undefined): string {
  return (value ?? '0').padStart(2, '0')
}

/** Date silently rolls February 31 into March, so validate the source fields first. */
function validCalendar(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): boolean {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0)
    && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59
}

/**
 * A timestamp as ISO 8601, or '' when it cannot be read. Dates without a zone are read as China
 * time on Chinese pages (the browser's own zone says nothing about the site) and UTC otherwise.
 */
export function normalizeDate(raw: string, language = ''): string {
  const value = raw.trim()
  if (!value) return ''
  const local = /^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?(?:[\sT]+(\d{1,2})[:时](\d{1,2})(?:[:分](\d{1,2})(\.\d{1,9})?)?秒?(?:\s*(Z|[+-]\d{2}:?\d{2}|UTC|GMT))?)?$/iu.exec(value)
  if (local) {
    const [, year, month, day, hour, minute, second, fraction = '', explicitZone] = local
    if (!validCalendar(Number(year), Number(month), Number(day), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0))) return ''
    if (explicitZone?.startsWith('+') || explicitZone?.startsWith('-')) {
      const offset = explicitZone.slice(1).replace(':', '')
      if (Number(offset.slice(0, 2)) > 23 || Number(offset.slice(2)) > 59) return ''
    }
    const zone = explicitZone
      ? (/^(?:UTC|GMT|Z)$/iu.test(explicitZone) ? 'Z' : explicitZone)
      : (value.includes('年') || language.toLowerCase().startsWith('zh') ? UTC_PLUS_8 : 'Z')
    const parsed = new Date(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${fraction}${zone}`)
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
  }
  if (/^\d{10}$/u.test(value)) return new Date(Number(value) * 1000).toISOString()
  if (/^\d{13}$/u.test(value)) return new Date(Number(value)).toISOString()

  // Keep RFC and named-month dates, while refusing Date's guesses for stray numbers,
  // partial dates and invalid calendar values such as "31 Feb 2026".
  const dayFirst = DAY_FIRST.exec(value)
  const monthFirst = MONTH_FIRST.exec(value)
  const named = dayFirst ?? monthFirst
  if (!named) return ''
  const [, first = '', second = '', year = ''] = named
  const month = MONTH_NAMES.indexOf((dayFirst ? second : first).slice(0, 3).toLowerCase()) + 1
  const day = Number(dayFirst ? first : second)
  const time = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/u.exec(value)
  if (!validCalendar(Number(year), month, day, Number(time?.[1] ?? 0), Number(time?.[2] ?? 0), Number(time?.[3] ?? 0))) return ''
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
}
