// Copies the crawl schema and hooks from AnyWorkflow-workers, which owns them, into
// tests/fixtures/pocketbase. The contract test and both end-to-end suites run against this copy.
//
//   node scripts/sync-pocketbase.mjs ../AnyWorkflow-workers
//
// Never edit the copy: change the workers repository, then sync and commit both.
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FILES = {
  pb_migrations: ['1794045600_crawled_contents.js', '1794200000_unified_crawl.js'],
  pb_hooks: ['aw_crawl.pb.js', 'crawl.js', 'crawl_validation.js'],
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(root, 'tests/fixtures/pocketbase')

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = process.argv[2] && path.resolve(process.argv[2])
  if (!source) throw new Error('usage: node scripts/sync-pocketbase.mjs <AnyWorkflow-workers checkout>')
  rmSync(target, { recursive: true, force: true })
  for (const [dir, names] of Object.entries(FILES)) {
    mkdirSync(path.join(target, dir), { recursive: true })
    const available = new Set(readdirSync(path.join(source, 'pocketbase', dir)))
    for (const name of names) {
      if (!available.has(name)) throw new Error(`${dir}/${name} is missing in ${source}`)
      copyFileSync(path.join(source, 'pocketbase', dir, name), path.join(target, dir, name))
    }
  }
  // The hooks are CommonJS (PocketBase's JSVM); this package is ESM.
  writeFileSync(path.join(target, 'package.json'), '{ "type": "commonjs" }\n')
  console.log(`Synced ${Object.values(FILES).flat().length} files from ${source}`)
}
