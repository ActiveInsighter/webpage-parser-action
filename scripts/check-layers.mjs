// Fails when a module imports from a layer it must not know. The layers, lowest first:
//
//   core       contract, errors, limits, URL policy     knows nothing else; no runtime APIs
//   sites      declarative site profiles                core
//   page       the page agent: ops, extract, steps      core, sites; DOM only, no chrome.*
//   engine     job lifecycle over a PageDriver port     core, sites; page for types only
//   extension  the browser executor (Chrome)            everything but action
//   action     the cloud executor (Node + Playwright)   everything but extension
//
// Both executors reach the parser only through page/agent.ts, injected into the page.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')
const allowed = {
  core: ['core'],
  sites: ['core', 'sites'],
  page: ['core', 'sites', 'page'],
  engine: ['core', 'sites', 'engine'],
  extension: ['core', 'sites', 'page', 'engine', 'extension'],
  action: ['core', 'sites', 'page', 'engine', 'action'],
}
const typeOnly = { engine: ['page'] }
const forbiddenGlobals = { core: /\b(?:chrome|document|window)\./u, sites: /\bchrome\./u, page: /\bchrome\./u, engine: /\b(?:chrome|document)\./u }

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? files(full) : /\.ts$/u.test(name) ? [full] : []
  })
}

const problems = []
for (const file of files(root)) {
  const layer = path.relative(root, file).split(path.sep)[0]
  if (!allowed[layer]) {
    problems.push(`${path.relative(root, file)}: not in a known layer`)
    continue
  }
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(/^import\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gmu)) {
    const [, isType, specifier] = match
    let target = null
    if (specifier.startsWith('@/')) target = specifier.slice(2).split('/')[0]
    else if (specifier.startsWith('.')) target = path.relative(root, path.resolve(path.dirname(file), specifier)).split(path.sep)[0]
    if (!target || target === layer) continue
    const ok = allowed[layer].includes(target) || (isType && typeOnly[layer]?.includes(target))
    if (!ok) problems.push(`${path.relative(root, file)}: ${layer} must not import ${specifier}`)
  }
  const globals = forbiddenGlobals[layer]
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '')
  if (globals && globals.test(code)) problems.push(`${path.relative(root, file)}: ${layer} uses a runtime API it must not know`)
}

if (problems.length) {
  console.error(`Layer check failed:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log('Layers OK')
