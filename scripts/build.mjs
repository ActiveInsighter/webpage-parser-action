// Builds both executors from the same sources.
//
//   node scripts/build.mjs [--watch] [--outdir=dist] [--only=extension|action]
//
//   dist/extension/  the unpacked browser extension (load it in chrome://extensions)
//   dist/action/     the cloud executor for GitHub Actions: crawler.mjs and the page agent
//
// agent.js is the one parser both use. The extension injects it with chrome.scripting, the cloud
// executor through the DevTools protocol, so it must be a classic script with no imports.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const flag = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=')[1]
const watch = process.argv.includes('--watch')
const outroot = path.resolve(root, flag('outdir') || 'dist')
const only = flag('only')
const outdir = path.join(outroot, 'extension')
const actionDir = path.join(outroot, 'action')

const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
const pocketbaseUrl = (process.env.CRAWLER_POCKETBASE_URL || 'https://pb.any1.tech').replace(/\/$/u, '')
const allowLocal = process.env.CRAWLER_ALLOW_LOCAL === '1'
if (allowLocal && outroot === path.join(root, 'dist')) {
  throw new Error('CRAWLER_ALLOW_LOCAL opens local addresses to job rows: build it to a separate --outdir, never to dist')
}

const manifest = {
  manifest_version: 3,
  name: 'AnyWorkflow Crawler',
  version,
  description: '用这个浏览器的登录状态，执行 AnyWorkflow 控制台里的网页抓取任务。',
  minimum_chrome_version: '120',
  icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  action: { default_popup: 'popup.html', default_title: 'AnyWorkflow Crawler', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
  background: { service_worker: 'background.js', type: 'module' },
  permissions: ['alarms', 'offscreen', 'scripting', 'storage', 'tabs'],
  host_permissions: ['http://*/*', 'https://*/*'],
}

const shared = {
  absWorkingDir: root,
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: 'chrome120',
  legalComments: 'none',
  logLevel: 'info',
  define: {
    __POCKETBASE_URL__: JSON.stringify(pocketbaseUrl),
    __ALLOW_LOCAL_TARGETS__: JSON.stringify(allowLocal),
    __CRAWLER_VERSION__: JSON.stringify(version),
  },
}

const extensionBuilds = [
  { entryPoints: { background: 'src/extension/background/index.ts' }, format: 'esm' },
  { entryPoints: { agent: 'src/page/agent.ts', popup: 'src/extension/popup/popup.ts', offscreen: 'src/extension/offscreen/realtime.ts' }, format: 'iife' },
].map((options) => ({ ...shared, ...options, outdir }))

// The cloud executor runs on Node; Playwright stays an installed dependency, not bundled.
const actionBuilds = [
  { entryPoints: { agent: 'src/page/agent.ts' }, format: 'iife', outdir: actionDir },
  {
    entryPoints: { crawler: 'src/action/main.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    packages: 'external',
    outdir: actionDir,
  },
].map((options) => ({ ...shared, ...options }))

const builds = [...(only === 'action' ? [] : extensionBuilds), ...(only === 'extension' ? [] : actionBuilds)]

async function copyStatic() {
  await cp(path.join(root, 'public'), outdir, { recursive: true })
  for (const file of ['src/extension/popup/popup.html', 'src/extension/popup/popup.css', 'src/extension/offscreen/offscreen.html']) {
    await cp(path.join(root, file), path.join(outdir, path.basename(file)))
  }
  await writeFile(path.join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

for (const dir of [only === 'action' ? null : outdir, only === 'extension' ? null : actionDir]) {
  if (!dir) continue
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
}
if (only !== 'action') await copyStatic()

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch()
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)))
  console.log(`Built ${version} → ${path.relative(root, outroot)}/${only ?? '{extension,action}'} (PocketBase ${pocketbaseUrl})`)
}
