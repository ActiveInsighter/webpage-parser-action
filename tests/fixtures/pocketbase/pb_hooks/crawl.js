/* global $app, $dbx, $security, ApiError, Record, __hooks */
// Crawling: targets, jobs, documents and cloud dispatches. PocketBase owns every transition.
//
// Two executors take jobs through the same lease routes. A browser extension signs in as the
// owner (aw_clients) and takes that owner's `browser` jobs; the cloud crawler signs in as the
// crawler service (aw_crawler_services) and takes `cloud` jobs of every owner, inside a dispatch
// (one GitHub workflow run). The scheduler decides when maintenance runs and how many dispatches
// are open; the crawler decides nothing about state beyond reporting what happened.
const validation = require(`${__hooks}/crawl_validation.js`);

const TARGETS = 'aw_crawl_targets';
const JOBS = 'aw_crawl_jobs';
const DOCUMENTS = 'aw_crawl_documents';
const DISPATCHES = 'aw_crawl_dispatches';
const WORKERS = 'aw_crawl_workers';
const CLIENTS = 'aw_clients';
const SERVICES = 'aw_crawler_services';
// Statuses map to the canonical states in crawlJobKind (src/platform/tasks/catalog.mjs).
const RUNNING = ['opening', 'rendering', 'extracting', 'uploading'];
const ACTIVE = ['queued', ...RUNNING];
const OPEN_DISPATCH = ['queued', 'dispatching', 'pending', 'running'];
const LEASE_MS = 90_000;
const MAX_ACTIVE_JOBS_PER_OWNER = 200;
const MAX_TARGETS_PER_OWNER = 500;
// A browser job waits a day for its owner's extension; the cloud is always there unless broken.
const UNCLAIMED_MS = { browser: 24 * 3600_000, cloud: 6 * 3600_000 };
const UNCLAIMED_MESSAGE = { browser: '24 小时内没有在线的浏览器扩展', cloud: '云端执行器 6 小时内没有启动' };
const WORKER_TOUCH_MS = 60_000;
const WORKER_RETENTION_MS = 30 * 24 * 3600_000;
const SWEEP_BATCH = 100;
const SCHEDULE_BATCH = 200;
// One dispatch works through the queue one page after another; more dispatches share a long one.
const JOBS_PER_DISPATCH = 20;
const MAX_OPEN_DISPATCHES = 10;
const LEASE_ID = /^[a-zA-Z0-9-]{16,64}$/;
const RECORD_ID = /^[a-z0-9]{15}$/;
const TARGET_FIELDS = ['id', 'owner', 'url', 'name', 'runner', 'category', 'options', 'intervalMinutes', 'enabled'];
const JOB_FIELDS = ['id', 'owner', 'target', 'url', 'runner', 'category', 'options', 'rerunOf'];
const FROM_TARGET = ['url', 'runner', 'category', 'options'];

function iso(ms) {
  return new Date(ms).toISOString();
}

/** PocketBase's filter literal, which uses a space where ISO 8601 has a T. */
function filterTime(ms) {
  return iso(ms).replace('T', ' ');
}

/** requestInfo bodies are Go values; a JSON round trip makes them plain JS values. */
function plain(value) {
  return value === undefined || value === null ? {} : JSON.parse(JSON.stringify(value));
}

/** JSON fields read as raw bytes in the JSVM, so the stored text is the dependable form. */
function jsonField(row, name) {
  const raw = row.getString(name);
  return raw ? JSON.parse(raw) : null;
}

function badRequest(work) {
  try {
    return work();
  } catch (error) {
    throw new ApiError(400, error.message);
  }
}

function statusFilter(statuses) {
  return `(${statuses.map(status => `status = "${status}"`).join(' || ')})`;
}

function inTransaction(event, work) {
  const originalApp = event.app;
  try {
    originalApp.runInTransaction(tx => {
      event.app = tx;
      work(tx);
    });
  } finally {
    event.app = originalApp;
  }
}

function rejectServerFields(event, allowed, message) {
  if (event.hasSuperuserAuth()) return;
  const body = plain(event.requestInfo().body);
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new ApiError(400, message);
}

function assertOwner(event, owner, message) {
  if (event.hasSuperuserAuth()) return;
  if (!event.auth || event.auth.collection().name !== CLIENTS || event.auth.id !== owner) throw new ApiError(403, message);
}

/**
 * Who is calling a lease route: the owner's extension takes browser jobs, the verified crawler
 * service takes cloud jobs. Anyone else is refused before a row is read.
 */
function executorOf(auth) {
  const collection = auth ? auth.collection().name : '';
  if (collection === CLIENTS) return { runner: 'browser', owner: auth.id };
  if (collection === SERVICES && auth.getBool('verified')) return { runner: 'cloud', owner: '' };
  throw new ApiError(403, '没有抓取执行权限');
}

function findOrNull(tx, collection, id) {
  try {
    return tx.findRecordById(collection, id);
  } catch {
    return null;
  }
}

/** A job the caller may act on as its executor; others look missing, not forbidden. */
function executorJob(tx, executor, id) {
  const row = findOrNull(tx, JOBS, id);
  if (!row || row.getString('runner') !== executor.runner || (executor.owner && row.getString('owner') !== executor.owner)) {
    throw new ApiError(404, '抓取任务不存在');
  }
  return row;
}

function ownedJob(tx, auth, id) {
  const row = findOrNull(tx, JOBS, id);
  if (!row || row.getString('owner') !== auth.id) throw new ApiError(404, '抓取任务不存在');
  return row;
}

function holdsLease(row, leaseId) {
  return RUNNING.includes(row.getString('status')) && typeof leaseId === 'string' && leaseId !== '' && row.getString('leaseId') === leaseId;
}

function releaseLease(row) {
  row.set('leaseId', '');
  row.set('leaseUntil', '');
  row.set('workerId', '');
}

function finish(row, status, now) {
  row.set('status', status);
  row.set('finishedAt', iso(now));
  row.set('nextAttemptAt', '');
  releaseLease(row);
}

/** Keeps the target's latest outcome next to it, so lists never read jobs. Gone targets are skipped. */
function recordOutcome(tx, job, now) {
  const id = job.getString('target');
  const target = id ? findOrNull(tx, TARGETS, id) : null;
  if (!target) return;
  const status = job.getString('status');
  const failed = status === 'failed';
  target.set('lastJob', job.id);
  target.set('lastRunAt', iso(now));
  target.set('lastStatus', status);
  target.set('lastErrorCode', failed ? job.getString('errorCode') : '');
  target.set('lastError', failed ? job.getString('error') : '');
  // Only a page that was read names it: a failure's title is usually the error page's.
  if (status === 'succeeded' || status === 'partial') {
    if (job.getString('title')) target.set('title', job.getString('title'));
    target.set('lastDocument', job.getString('document'));
  }
  tx.save(target);
}

/** Records a failed attempt: queued again with backoff while attempts remain, otherwise final. */
function settleFailure(tx, row, failure, now) {
  row.set('errorCode', failure.code);
  row.set('error', failure.message);
  if (failure.code === 'CANCELED' || row.getBool('cancelRequested')) {
    finish(row, 'canceled', now);
  } else if (failure.retryable && row.getInt('attempts') < validation.MAX_ATTEMPTS) {
    row.set('status', 'queued');
    row.set('nextAttemptAt', iso(now + validation.retryDelayMs(row.getInt('attempts'))));
    releaseLease(row);
  } else {
    finish(row, 'failed', now);
  }
  tx.save(row);
  if (row.getString('status') !== 'queued') recordOutcome(tx, row, now);
}

function activeJobOf(tx, targetId) {
  const rows = tx.findRecordsByFilter(JOBS, `target = {:target} && ${statusFilter(ACTIVE)}`, '', 1, 0, { target: targetId });
  return rows[0] || null;
}

function fillJob(row, owner, request, trigger, targetId) {
  row.set('owner', owner);
  row.set('target', targetId || '');
  row.set('url', request.url);
  row.set('host', request.host);
  row.set('runner', request.runner);
  row.set('category', request.category);
  row.set('options', request.options);
  row.set('trigger', trigger);
  row.set('status', 'queued');
  row.set('cancelRequested', false);
  row.set('attempts', 0);
}

function targetRequest(target) {
  return {
    url: target.getString('url'),
    host: target.getString('host'),
    runner: target.getString('runner'),
    category: target.getString('category'),
    options: jsonField(target, 'options') || {},
  };
}

/** Create and update requests: the owner edits what to crawl, the server owns schedule and outcome. */
function prepareTarget(event, creating) {
  rejectServerFields(event, TARGET_FIELDS, '抓取状态由服务端管理');
  const record = event.record;
  const owner = record.getString('owner');
  assertOwner(event, owner, '抓取页面归属无效');
  const target = badRequest(() => validation.normalizeTarget({
    url: record.getString('url'),
    name: record.getString('name'),
    runner: record.getString('runner'),
    category: record.getString('category'),
    options: jsonField(record, 'options'),
    intervalMinutes: record.getInt('intervalMinutes'),
    enabled: record.getBool('enabled'),
  }));
  for (const key of Object.keys(target)) record.set(key, target[key]);

  const original = creating ? null : record.original();
  const scheduled = target.enabled && target.intervalMinutes > 0;
  const rescheduled = creating || original.getBool('enabled') !== target.enabled || original.getInt('intervalMinutes') !== target.intervalMinutes;
  if (!scheduled) record.set('nextRunAt', '');
  else if (rescheduled || !record.getString('nextRunAt')) record.set('nextRunAt', validation.firstRunAt(target.intervalMinutes, Date.now()));

  inTransaction(event, tx => {
    if (creating && tx.countRecords(TARGETS, $dbx.hashExp({ owner })) >= MAX_TARGETS_PER_OWNER) {
      throw new ApiError(429, `最多保存 ${MAX_TARGETS_PER_OWNER} 个页面`);
    }
    const same = tx.findRecordsByFilter(TARGETS, 'owner = {:owner} && url = {:url} && id != {:id}', '', 1, 0, { owner, url: target.url, id: record.id });
    if (same.length) throw new ApiError(409, '这个页面已经在列表中');
    event.next();
  });
}

/**
 * An owner queues a crawl: of a saved page (`target`, whose settings are copied) or of a link
 * with its own settings. A page is crawled by one job at a time.
 */
function prepareJob(event) {
  rejectServerFields(event, JOB_FIELDS, '抓取状态由服务端管理');
  const record = event.record;
  const owner = record.getString('owner');
  assertOwner(event, owner, '抓取任务归属无效');
  const body = plain(event.requestInfo().body);
  const targetId = record.getString('target');

  inTransaction(event, tx => {
    const active = tx.countRecords(JOBS, $dbx.exp(`owner = {:owner} AND status IN ('${ACTIVE.join("','")}')`, { owner }));
    if (active >= MAX_ACTIVE_JOBS_PER_OWNER) throw new ApiError(429, `已有 ${MAX_ACTIVE_JOBS_PER_OWNER} 个抓取在排队，请稍后再试`);
    let request;
    if (targetId) {
      if (FROM_TARGET.some(key => body[key] !== undefined)) throw new ApiError(400, '页面的抓取使用页面自己的设置');
      const target = findOrNull(tx, TARGETS, targetId);
      if (!target || target.getString('owner') !== owner) throw new ApiError(404, '抓取页面不存在');
      if (activeJobOf(tx, targetId)) throw new ApiError(409, `「${target.getString('name') || target.getString('host')}」正在抓取`);
      request = targetRequest(target);
    } else {
      request = badRequest(() => validation.normalizeRequest({
        url: record.getString('url'),
        runner: record.getString('runner'),
        category: record.getString('category'),
        options: jsonField(record, 'options'),
      }));
    }
    const rerunOf = record.getString('rerunOf');
    if (rerunOf && !RECORD_ID.test(rerunOf)) throw new ApiError(400, '重新抓取的来源无效');
    fillJob(record, owner, request, 'manual', targetId);
    record.set('rerunOf', rerunOf);
    event.next();
  });
}

function touchWorker(tx, owner, body, now) {
  const workerId = String(body.workerId);
  let row;
  try {
    row = tx.findFirstRecordByFilter(WORKERS, 'owner = {:owner} && workerId = {:workerId}', { owner, workerId });
    if (now - Date.parse(row.getString('lastSeenAt').replace(' ', 'T')) < WORKER_TOUCH_MS) return;
  } catch {
    row = new Record(tx.findCollectionByNameOrId(WORKERS));
    row.set('owner', owner);
    row.set('workerId', workerId);
  }
  row.set('label', typeof body.label === 'string' ? body.label.slice(0, 120) : '');
  row.set('version', typeof body.version === 'string' ? body.version.slice(0, 32) : '');
  row.set('lastSeenAt', iso(now));
  tx.save(row);
}

function openDispatch(tx, id) {
  const row = typeof id === 'string' && RECORD_ID.test(id) ? findOrNull(tx, DISPATCHES, id) : null;
  return row && OPEN_DISPATCH.includes(row.getString('status')) && !row.getString('closedAt') ? row : null;
}

function claimPayload(row) {
  return {
    id: row.id,
    owner: row.getString('owner'),
    url: row.getString('url'),
    runner: row.getString('runner'),
    category: row.getString('category'),
    options: jsonField(row, 'options') || {},
    attempts: row.getInt('attempts'),
  };
}

/**
 * Hands the oldest due job to this executor; the claim is a transaction, so a job goes to one.
 * A cloud claim names its dispatch, and finding the queue empty closes that dispatch in the same
 * transaction: work queued a moment later is then planned into a new one, never stranded.
 */
function claim(app, auth, rawBody, now) {
  const executor = executorOf(auth);
  const body = plain(rawBody);
  if (!LEASE_ID.test(String(body.leaseId)) || !LEASE_ID.test(String(body.workerId))) throw new ApiError(400, '抓取租约无效');
  let reply = { job: null, closed: false };
  app.runInTransaction(tx => {
    let dispatch = null;
    if (executor.runner === 'cloud') {
      dispatch = openDispatch(tx, body.dispatch);
      if (!dispatch) {
        reply = { job: null, closed: true };
        return;
      }
    } else {
      touchWorker(tx, executor.owner, body, now);
    }
    const filter = `runner = {:runner} && status = "queued" && (nextAttemptAt = "" || nextAttemptAt <= {:now})${executor.owner ? ' && owner = {:owner}' : ''}`;
    const row = tx.findRecordsByFilter(JOBS, filter, 'created,id', 1, 0, { runner: executor.runner, owner: executor.owner, now: filterTime(now) })[0];
    if (!row) {
      if (dispatch) {
        dispatch.set('closedAt', iso(now));
        tx.save(dispatch);
        reply = { job: null, closed: true };
      }
      return;
    }
    row.set('status', 'opening');
    row.set('workerId', body.workerId);
    row.set('leaseId', body.leaseId);
    row.set('leaseUntil', iso(now + LEASE_MS));
    row.set('nextAttemptAt', '');
    row.set('attempts', row.getInt('attempts') + 1);
    row.set('errorCode', '');
    row.set('error', '');
    row.set('dispatch', dispatch ? dispatch.id : '');
    if (!row.getString('startedAt')) row.set('startedAt', iso(now));
    tx.save(row);
    if (dispatch) {
      dispatch.set('claimedCount', dispatch.getInt('claimedCount') + 1);
      tx.save(dispatch);
    }
    reply = { job: claimPayload(row), closed: false };
  });
  return reply;
}

function renew(app, auth, id, rawBody, now) {
  const executor = executorOf(auth);
  const body = plain(rawBody);
  let reply = { accepted: false, cancelRequested: false };
  app.runInTransaction(tx => {
    const row = executorJob(tx, executor, id);
    if (!holdsLease(row, body.leaseId)) return;
    if (body.status !== undefined) {
      if (!RUNNING.includes(body.status)) throw new ApiError(400, '抓取状态无效');
      row.set('status', body.status);
    }
    row.set('leaseUntil', iso(now + LEASE_MS));
    tx.save(row);
    reply = { accepted: true, cancelRequested: row.getBool('cancelRequested') };
  });
  return reply;
}

function setDocument(doc, job, result, identity, now) {
  for (const key of Object.keys(result)) {
    if (key !== 'identity') doc.set(key, result[key]);
  }
  doc.set('identity', identity);
  doc.set('job', job.id);
  doc.set('runner', job.getString('runner'));
  doc.set('category', job.getString('category'));
  if (job.getString('target')) doc.set('target', job.getString('target'));
  doc.set('fetchedAt', iso(now));
}

/**
 * Stores the result as the owner's document for its identity, in one transaction with the job.
 * The server hashes the Markdown, so `changed` and `changedAt` cannot be forged by a crawler.
 */
function complete(app, auth, id, rawBody, now) {
  const executor = executorOf(auth);
  const body = plain(rawBody);
  const result = badRequest(() => validation.normalizeResult(body.result));
  const identity = validation.documentIdentity(result);
  const key = $security.sha256(identity);
  const hash = $security.sha256(result.markdown);
  let reply = null;
  app.runInTransaction(tx => {
    const row = executorJob(tx, executor, id);
    if (!holdsLease(row, body.leaseId)) throw new ApiError(409, '抓取租约已失效');
    const owner = row.getString('owner');
    let doc;
    try {
      doc = tx.findFirstRecordByFilter(DOCUMENTS, 'owner = {:owner} && key = {:key}', { owner, key });
    } catch {
      doc = new Record(tx.findCollectionByNameOrId(DOCUMENTS));
      doc.set('owner', owner);
      doc.set('key', key);
    }
    const changed = doc.getString('contentHash') !== hash;
    setDocument(doc, row, result, identity, now);
    doc.set('contentHash', hash);
    if (changed || !doc.getString('changedAt')) doc.set('changedAt', iso(now));
    tx.save(doc);

    const status = validation.isPartial(result) ? 'partial' : 'succeeded';
    finish(row, status, now);
    row.set('errorCode', '');
    row.set('error', '');
    row.set('title', result.title);
    row.set('siteName', result.siteName.slice(0, 255));
    row.set('extractor', result.extractor);
    row.set('profile', result.profile);
    row.set('wordCount', result.wordCount);
    row.set('qualityScore', result.qualityScore);
    row.set('itemCount', result.items.length);
    row.set('document', doc.id);
    row.set('contentHash', hash);
    row.set('changed', changed);
    tx.save(row);
    recordOutcome(tx, row, now);
    reply = { accepted: true, status, document: doc.id, changed };
  });
  return reply;
}

function fail(app, auth, id, rawBody, now) {
  const executor = executorOf(auth);
  const body = plain(rawBody);
  const failure = validation.normalizeFailure(body);
  let reply = { accepted: false, status: '' };
  app.runInTransaction(tx => {
    const row = executorJob(tx, executor, id);
    if (!holdsLease(row, body.leaseId)) return;
    settleFailure(tx, row, failure, now);
    reply = { accepted: true, status: row.getString('status') };
  });
  return reply;
}

/** Queued jobs stop at once; a running one stops when its executor next renews. */
function cancel(app, auth, id, now) {
  let status = '';
  app.runInTransaction(tx => {
    const row = ownedJob(tx, auth, id);
    status = row.getString('status');
    if (status === 'queued') {
      row.set('errorCode', 'CANCELED');
      row.set('error', '');
      finish(row, 'canceled', now);
      tx.save(row);
      recordOutcome(tx, row, now);
      status = 'canceled';
    } else if (RUNNING.includes(status)) {
      row.set('cancelRequested', true);
      tx.save(row);
    }
  });
  return { status };
}

/** Recovers what no executor will finish: dead leases, jobs nobody claimed, long-gone installs. */
function sweep(app, now, summary) {
  app.runInTransaction(tx => {
    const stale = tx.findRecordsByFilter(
      JOBS, `${statusFilter(RUNNING)} && leaseUntil != "" && leaseUntil < {:now}`,
      'leaseUntil,id', SWEEP_BATCH, 0, { now: filterTime(now) },
    );
    for (const row of stale) {
      settleFailure(tx, row, { code: 'LEASE_LOST', message: '执行中断，任务未完成', retryable: true }, now);
      summary.requeued++;
    }
    for (const runner of validation.RUNNERS) {
      const unclaimed = tx.findRecordsByFilter(
        JOBS, 'runner = {:runner} && status = "queued" && updated < {:before}',
        'updated,id', SWEEP_BATCH, 0, { runner, before: filterTime(now - UNCLAIMED_MS[runner]) },
      );
      for (const row of unclaimed) {
        row.set('errorCode', 'NO_WORKER');
        row.set('error', UNCLAIMED_MESSAGE[runner]);
        finish(row, 'failed', now);
        tx.save(row);
        recordOutcome(tx, row, now);
        summary.expired++;
      }
    }
    const gone = tx.findRecordsByFilter(WORKERS, 'lastSeenAt < {:before}', 'lastSeenAt,id', 50, 0, { before: filterTime(now - WORKER_RETENTION_MS) });
    for (const row of gone) {
      tx.delete(row);
      summary.workers++;
    }
  });
  summary.more = summary.more || summary.requeued >= SWEEP_BATCH || summary.expired >= SWEEP_BATCH;
}

/**
 * Queues every due schedule, one transaction per owner. A target still crawling skips this slot;
 * either way its next slot is set, so a busy target never piles up jobs.
 */
function schedule(app, now, summary) {
  const due = app.findRecordsByFilter(
    TARGETS, 'enabled = true && intervalMinutes > 0 && nextRunAt != "" && nextRunAt <= {:now}',
    'nextRunAt,id', SCHEDULE_BATCH, 0, { now: filterTime(now) },
  );
  summary.more = summary.more || due.length === SCHEDULE_BATCH;
  const owners = new Map();
  for (const row of due) {
    const owner = row.getString('owner');
    if (!owners.has(owner)) owners.set(owner, []);
    owners.get(owner).push(row.id);
  }
  for (const [owner, ids] of owners) {
    try {
      app.runInTransaction(tx => {
        let active = tx.countRecords(JOBS, $dbx.exp(`owner = {:owner} AND status IN ('${ACTIVE.join("','")}')`, { owner }));
        for (const id of ids) {
          const target = tx.findRecordById(TARGETS, id);
          const interval = target.getInt('intervalMinutes');
          const dueAt = Date.parse(target.getString('nextRunAt').replace(' ', 'T'));
          if (!target.getBool('enabled') || interval <= 0 || !(dueAt <= now)) continue;
          const slot = validation.nextSlot(dueAt, interval, now);
          target.set('nextRunAt', iso(slot.at));
          tx.save(target);
          summary.missed += slot.missed;
          if (active >= MAX_ACTIVE_JOBS_PER_OWNER || activeJobOf(tx, id)) {
            summary.skipped++;
            continue;
          }
          const job = new Record(tx.findCollectionByNameOrId(JOBS));
          fillJob(job, owner, targetRequest(target), 'schedule', id);
          tx.save(job);
          active++;
          summary.created++;
        }
      });
    } catch (error) {
      // One owner's bad row must not stop the others; the next pass retries it.
      summary.failed++;
      $app.logger().error('crawl schedule failed', 'owner', owner, 'error', String(error));
    }
  }
}

/** The scheduler's maintenance pass: recover jobs, then queue due schedules. */
function maintain(app, now) {
  const summary = { requeued: 0, expired: 0, workers: 0, created: 0, skipped: 0, missed: 0, failed: 0, more: false };
  sweep(app, now, summary);
  schedule(app, now, summary);
  return summary;
}

/**
 * Opens enough dispatches for the due cloud queue: one per JOBS_PER_DISPATCH waiting jobs, at
 * most `limit` open at once. Open means not yet settled and still taking jobs.
 */
function planDispatches(app, rawBody, now) {
  const body = plain(rawBody);
  const limit = Math.min(MAX_OPEN_DISPATCHES, Math.max(1, Math.trunc(Number(body.limit)) || 1));
  const summary = { queued: 0, open: 0, created: 0 };
  app.runInTransaction(tx => {
    summary.queued = tx.countRecords(JOBS, $dbx.exp(
      'runner = \'cloud\' AND status = \'queued\' AND (nextAttemptAt = \'\' OR nextAttemptAt <= {:now})',
      { now: filterTime(now) },
    ));
    summary.open = tx.countRecords(DISPATCHES, $dbx.exp(`status IN ('${OPEN_DISPATCH.join("','")}') AND closedAt = ''`));
    const wanted = Math.min(limit, Math.ceil(summary.queued / JOBS_PER_DISPATCH));
    for (let index = summary.open; index < wanted; index++) {
      const row = new Record(tx.findCollectionByNameOrId(DISPATCHES));
      row.set('status', 'queued');
      row.set('claimedCount', 0);
      tx.save(row);
      summary.created++;
    }
  });
  return summary;
}

/** The crawler stops taking jobs (its time budget ran out) without waiting for the run to end. */
function closeDispatch(app, auth, id, now) {
  if (executorOf(auth).runner !== 'cloud') throw new ApiError(403, '没有抓取执行权限');
  app.runInTransaction(tx => {
    const row = findOrNull(tx, DISPATCHES, id);
    if (!row) throw new ApiError(404, '云端运行不存在');
    if (!row.getString('closedAt')) {
      row.set('closedAt', iso(now));
      tx.save(row);
    }
  });
  return { closed: true };
}

const CONCLUSIONS = { success: 'succeeded', cancelled: 'canceled' };

/**
 * The workflow run ended. Its jobs still holding a lease go back to the queue at once instead of
 * waiting for the lease to run out, and the dispatch takes its final status.
 */
function settleDispatch(app, id, rawBody, now) {
  const body = plain(rawBody);
  const conclusion = typeof body.conclusion === 'string' ? body.conclusion.slice(0, 32) : '';
  let reply = { status: '', requeued: 0 };
  app.runInTransaction(tx => {
    const row = findOrNull(tx, DISPATCHES, id);
    if (!row) throw new ApiError(404, '云端运行不存在');
    if (!OPEN_DISPATCH.includes(row.getString('status'))) {
      reply.status = row.getString('status');
      return;
    }
    const leased = tx.findRecordsByFilter(JOBS, `dispatch = {:dispatch} && ${statusFilter(RUNNING)}`, 'created,id', 200, 0, { dispatch: id });
    for (const job of leased) {
      settleFailure(tx, job, { code: 'LEASE_LOST', message: '云端运行结束时任务未完成', retryable: true }, now);
      reply.requeued++;
    }
    const status = CONCLUSIONS[conclusion] || 'failed';
    row.set('status', status);
    row.set('conclusion', conclusion);
    row.set('finishedAt', iso(now));
    if (!row.getString('closedAt')) row.set('closedAt', iso(now));
    row.set('error', status === 'failed' ? `云端运行异常结束（${conclusion || 'unknown'}）` : '');
    tx.save(row);
    reply.status = status;
  });
  return reply;
}

module.exports = {
  LEASE_MS,
  prepareTarget,
  prepareJob,
  claim,
  renew,
  complete,
  fail,
  cancel,
  maintain,
  planDispatches,
  closeDispatch,
  settleDispatch,
};
