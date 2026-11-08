// Captures real pages through the real extension and prints what came back. This is the tool for
// writing and tuning a site profile: edit src/sites/, rerun, compare.
//
//   POCKETBASE_BINARY=… WORKERS_DIR=… node tests/e2e/live.mjs [--generic] [--md] <url>…
//
// --generic skips site profiles, for a before/after comparison. --md prints the whole Markdown.
// A site that shows this machine a verification wall can be checked with tests/e2e/replay.mjs.
import { startHarness } from './harness.mjs'

const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const urls = args.filter((arg) => !arg.startsWith('--'))
if (!urls.length) throw new Error('Pass at least one URL')

const harness = await startHarness()
try {
  await harness.signIn()
  for (const url of urls) {
    const options = flags.has('--generic') ? { generic: true } : {}
    const { row, result } = await harness.capture(url, options, 150_000)
    console.log(`\n━━ ${url}`)
    console.log(`status ${row.status}${row.errorCode ? ` ${row.errorCode}: ${row.error}` : ''} (attempts ${row.attempts})`)
    if (!result) continue
    const { title, byline, siteName, publishedAt, language, wordCount, qualityScore, extractor, profile, warnings, httpStatus, trace } = result
    console.log({ title, byline, siteName, publishedAt, language, wordCount, qualityScore, extractor, profile, warnings, httpStatus })
    console.log(`links ${result.links?.length ?? 0}, images ${result.images?.length ?? 0}, jsonld ${result.structuredData?.length ?? 0}`)
    console.log(`trace ${JSON.stringify(trace)}`)
    if (Object.keys(result.extras ?? {}).length) console.log('extras', result.extras)
    console.log(flags.has('--md') ? result.markdown : `--- head ---\n${result.markdown.slice(0, 500)}\n--- tail ---\n${result.markdown.slice(-300)}`)
  }
} finally {
  await harness.stop()
}
