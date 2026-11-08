import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { FILES } from '../../scripts/sync-pocketbase.mjs'

const fixtures = resolve(import.meta.dirname, '../fixtures/pocketbase')

export function freePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

export const ACCOUNT = { email: 'crawler-owner@example.invalid', password: 'password-123456' }
export const SERVICE = { email: 'crawler-service@example.invalid', password: 'password-123456' }
export const ADMIN = { email: 'admin@example.invalid', password: 'password-123456' }
export const JOBS = '/api/collections/aw_crawl_jobs/records'
export const DOCUMENTS = '/api/collections/aw_crawl_documents/records'

/** With WORKERS_DIR set, the vendored copy must match the backend it was taken from. */
function checkFixtures() {
  const workers = process.env.WORKERS_DIR && resolve(process.env.WORKERS_DIR)
  if (!workers) return
  for (const [dir, names] of Object.entries(FILES)) {
    for (const name of names) {
      if (readFileSync(join(workers, 'pocketbase', dir, name), 'utf8') !== readFileSync(join(fixtures, dir, name), 'utf8')) {
        throw new Error(`tests/fixtures/pocketbase/${dir}/${name} differs from ${workers}: run npm run sync:pocketbase -- ${process.env.WORKERS_DIR}`)
      }
    }
  }
}

/**
 * A scratch PocketBase running the real crawl migration and hooks (vendored from
 * AnyWorkflow-workers), with an owner, a crawler service account and a superuser.
 */
export async function startPocketBase({ binary, root }) {
  checkFixtures()
  const migrations = join(root, 'migrations')
  const hooks = join(root, 'hooks')
  mkdirSync(migrations, { recursive: true })
  mkdirSync(hooks, { recursive: true })
  writeFileSync(join(migrations, '1700000000_clients.js'), `
    migrate((app) => {
      const clients = new Collection({ id: 'awclients0000001', type: 'auth', name: 'aw_clients',
        listRule: 'id = @request.auth.id', viewRule: 'id = @request.auth.id',
        passwordAuth: { enabled: true, identityFields: ['email'] } });
      app.save(clients);
      const user = new Record(clients);
      user.setEmail(${JSON.stringify(ACCOUNT.email)}); user.setPassword(${JSON.stringify(ACCOUNT.password)}); user.setVerified(true);
      app.save(user);
    }, () => {});
  `)
  for (const [dir, names] of Object.entries(FILES)) {
    for (const name of names) copyFileSync(join(fixtures, dir, name), join(dir === 'pb_hooks' ? hooks : migrations, name))
  }
  // Fixture pages live on 127.0.0.1, which the real create hook rightly refuses. These test-only
  // routes queue them directly, so the executors still receive ordinary rows.
  writeFileSync(join(hooks, 'zz_test.pb.js'), `
    routerAdd('POST', '/api/test/enqueue', event => {
      const body = JSON.parse(JSON.stringify(event.requestInfo().body));
      const row = new Record($app.findCollectionByNameOrId('aw_crawl_jobs'));
      row.set('owner', event.auth.id); row.set('url', body.url); row.set('host', '127.0.0.1');
      row.set('runner', body.runner || 'browser'); row.set('category', 'webpage'); row.set('trigger', 'manual');
      row.set('options', body.options || {}); row.set('status', 'queued'); row.set('attempts', 0);
      $app.save(row);
      return event.json(200, { id: row.id });
    }, $apis.requireAuth('aw_clients'));
  `)
  const dir = join(root, 'data')
  const args = ['--dir', dir, '--migrationsDir', migrations, '--hooksDir', hooks, '--hooksWatch=false', '--automigrate=false']
  const migrated = spawnSync(binary, ['migrate', 'up', ...args], { encoding: 'utf8', timeout: 30_000 })
  if (migrated.status !== 0) throw new Error(migrated.stdout + migrated.stderr)
  const superuser = spawnSync(binary, ['superuser', 'upsert', ADMIN.email, ADMIN.password, ...args], { encoding: 'utf8', timeout: 30_000 })
  if (superuser.status !== 0) throw new Error(superuser.stdout + superuser.stderr)
  const port = await freePort()
  const child = spawn(binary, ['serve', '--http', `127.0.0.1:${port}`, ...args], { stdio: 'ignore' })
  const base = `http://127.0.0.1:${port}`
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break
    } catch {
      // Still starting.
    }
    if (attempt > 100) throw new Error('PocketBase did not start')
    await new Promise((done) => setTimeout(done, 100))
  }

  async function call(path, { token, method = 'POST', body } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(json)}`)
    return json
  }
  const login = (collection, { email, password }) => call(`/api/collections/${collection}/auth-with-password`, { body: { identity: email, password } })

  const admin = (await login('_superusers', ADMIN)).token
  await call('/api/collections/aw_crawler_services/records', {
    token: admin,
    body: { email: SERVICE.email, password: SERVICE.password, passwordConfirm: SERVICE.password, verified: true, label: 'e2e' },
  })
  const owner = await login('aw_clients', ACCOUNT)
  const service = (await login('aw_crawler_services', SERVICE)).token
  return { base, call, admin, service, token: owner.token, ownerId: owner.record.id, stop: () => child.kill() }
}

export const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'canceled'])
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Helpers over a started PocketBase: queue, wait for and read crawl jobs as the owner. */
export function jobsOf(pb) {
  const enqueue = async (url, options = {}, runner = 'browser') => (await pb.call('/api/test/enqueue', { token: pb.token, body: { url, options, runner } })).id
  const job = (id) => pb.call(`${JOBS}/${id}`, { token: pb.token, method: 'GET' })
  async function settled(id, timeoutMs = 60_000) {
    const end = Date.now() + timeoutMs
    for (;;) {
      const row = await job(id)
      if (TERMINAL.has(row.status)) return row
      if (Date.now() > end) throw new Error(`Job ${id} stuck in ${row.status}: ${JSON.stringify(row)}`)
      await sleep(150)
    }
  }
  const documentOf = async (row) => (row.document ? pb.call(`${DOCUMENTS}/${row.document}`, { token: pb.token, method: 'GET' }) : undefined)
  return { enqueue, job, settled, documentOf }
}
