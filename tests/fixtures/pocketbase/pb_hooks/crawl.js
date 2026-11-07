/* global $app, $dbx, $security, ApiError, Record, __hooks */
// Web crawling: targets, runs and stored contents. PocketBase owns every transition; the scheduler
// decides when to sweep (`schedule`) and when a workflow run has ended (`settle`), and the crawler
// service reports each target as it finishes (`report`).
const validation = require(`${__hooks}/crawl_validation.js`);

const TARGETS = 'aw_crawl_targets';
const RUNS = 'aw_crawl_runs';
const CONTENTS = 'aw_crawled_contents';
// Statuses map to the canonical states in webCrawlKind (src/platform/tasks/catalog.mjs).
const ACTIVE = ['queued', 'dispatching', 'pending', 'running'];
const REPORTABLE = ['dispatching', 'pending', 'running'];
const MAX_TARGETS_PER_OWNER = 200;
const MAX_ACTIVE_RUNS_PER_OWNER = 20;
const SWEEP_BATCH = 200;
const TARGET_FIELDS = ['id', 'owner', 'url', 'name', 'mode', 'contentType', 'options', 'intervalMinutes', 'enabled'];
const RUN_FIELDS = ['id', 'owner', 'targets'];

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

function statusFilter(statuses) {
  return `(${statuses.map(status => `status = "${status}"`).join(' || ')})`;
}

function findRun(app, id) {
  try {
    return app.findRecordById(RUNS, id);
  } catch {
    throw new ApiError(404, '抓取记录不存在');
  }
}

function targetData(row) {
  return {
    id: row.id,
    url: row.getString('url'),
    name: row.getString('name'),
    mode: row.getString('mode'),
    contentType: row.getString('contentType'),
    options: jsonField(row, 'options') || {},
  };
}

/** Targets already in an owner's active runs; a target is crawled by one run at a time. */
function busyTargets(tx, owner) {
  const runs = tx.findRecordsByFilter(RUNS, `owner = {:owner} && ${statusFilter(ACTIVE)}`, '', MAX_ACTIVE_RUNS_PER_OWNER * 5, 0, { owner });
  const busy = new Set();
  for (const run of runs) for (const id of run.getStringSlice('targets')) busy.add(id);
  return { busy, activeRuns: runs.length };
}

function fillRun(row, owner, targets, trigger) {
  row.set('owner', owner);
  row.set('targets', targets.map(target => target.id));
  row.set('trigger', trigger);
  row.set('items', targets.map(target => validation.runItem(targetData(target))));
  row.set('results', {});
  row.set('status', 'queued');
  row.set('cancelRequested', false);
  row.set('targetCount', targets.length);
  row.set('reportedCount', 0);
  row.set('succeededCount', 0);
  row.set('itemCount', 0);
}

/** Keeps the target's latest outcome next to it, so lists never read runs. Gone targets are skipped. */
function recordOutcome(tx, targetId, runId, outcome, now) {
  let target;
  try {
    target = tx.findRecordById(TARGETS, targetId);
  } catch {
    return;
  }
  target.set('lastRunAt', iso(now));
  target.set('lastRun', runId);
  target.set('lastStatus', outcome.status);
  target.set('lastError', outcome.status === 'failed' ? outcome.error : '');
  target.set('lastErrorCode', outcome.status === 'failed' ? outcome.errorCode : '');
  target.set('lastItemCount', outcome.itemCount);
  if (outcome.title) target.set('pageTitle', outcome.title);
  tx.save(target);
}

function applyResults(row, results) {
  row.set('results', results);
  const summary = validation.summarize(results);
  row.set('reportedCount', summary.reportedCount);
  row.set('succeededCount', summary.succeededCount);
  row.set('itemCount', summary.itemCount);
  return summary;
}

/** Create and update requests: the owner edits what to crawl, the server owns schedule and outcome. */
function prepareTarget(event, creating) {
  rejectServerFields(event, TARGET_FIELDS, '抓取状态由服务端管理');
  const record = event.record;
  const owner = record.getString('owner');
  if (!event.hasSuperuserAuth() && (!event.auth || event.auth.collection().name !== 'aw_clients' || event.auth.id !== owner)) {
    throw new ApiError(403, '抓取页面归属无效');
  }
  const target = badRequest(() => validation.normalizeTarget({
    url: record.getString('url'),
    name: record.getString('name'),
    mode: record.getString('mode'),
    contentType: record.getString('contentType'),
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
      throw new ApiError(429, `最多保存 ${MAX_TARGETS_PER_OWNER} 个抓取页面`);
    }
    const same = tx.findRecordsByFilter(TARGETS, 'owner = {:owner} && url = {:url} && id != {:id}', '', 1, 0, { owner, url: target.url, id: record.id });
    if (same.length) throw new ApiError(409, '这个页面已经在列表中');
    event.next();
  });
}

/** An owner starts a crawl of up to 10 of their targets; the server snapshots them. */
function prepareRun(event) {
  rejectServerFields(event, RUN_FIELDS, '抓取状态由服务端管理');
  const record = event.record;
  const owner = record.getString('owner');
  if (!event.hasSuperuserAuth() && (!event.auth || event.auth.collection().name !== 'aw_clients' || event.auth.id !== owner)) {
    throw new ApiError(403, '抓取记录归属无效');
  }
  const ids = [...new Set(record.getStringSlice('targets'))];
  if (ids.length === 0) throw new ApiError(400, '请选择要抓取的页面');
  if (ids.length > validation.MAX_TARGETS_PER_RUN) throw new ApiError(400, `一次最多抓取 ${validation.MAX_TARGETS_PER_RUN} 个页面`);

  inTransaction(event, tx => {
    const { busy, activeRuns } = busyTargets(tx, owner);
    if (activeRuns >= MAX_ACTIVE_RUNS_PER_OWNER) throw new ApiError(429, `已有 ${MAX_ACTIVE_RUNS_PER_OWNER} 批抓取在进行，请稍后再试`);
    const targets = ids.map(id => {
      let target;
      try {
        target = tx.findRecordById(TARGETS, id);
      } catch {
        throw new ApiError(404, '抓取页面不存在');
      }
      if (target.getString('owner') !== owner) throw new ApiError(404, '抓取页面不存在');
      if (busy.has(id)) throw new ApiError(409, `「${target.getString('name') || target.getString('host')}」正在抓取`);
      return target;
    });
    fillRun(record, owner, targets, 'manual');
    event.next();
  });
}

/**
 * Stored contents: relations must stay within one owner, and the hash and change time are derived
 * here so no writer can forge them.
 */
function prepareContent(event, creating) {
  const record = event.record;
  const owner = record.getString('owner');
  for (const [field, collection] of [['target', TARGETS], ['run', RUNS]]) {
    const id = record.getString(field);
    if (!id || (!creating && id === record.original().getString(field))) continue;
    let related;
    try {
      related = event.app.findRecordById(collection, id);
    } catch {
      throw new ApiError(400, '关联的抓取记录不存在');
    }
    if (related.getString('owner') !== owner) throw new ApiError(400, '关联的抓取记录归属无效');
    if (field === 'run' && !event.hasSuperuserAuth() && !REPORTABLE.includes(related.getString('status'))) {
      throw new ApiError(409, '抓取批次已经结束');
    }
  }
  const hash = $security.sha256(record.getString('content'));
  const previous = creating ? null : record.original();
  record.set('contentHash', hash);
  if (!previous || previous.getString('contentHash') !== hash || !previous.getString('changedAt')) {
    record.set('changedAt', record.getString('fetchedAt') || iso(Date.now()));
  } else {
    record.set('changedAt', previous.getString('changedAt'));
  }
  event.next();
}

/** Queued runs stop at once; a dispatched one is canceled on GitHub by the scheduler. */
function cancel(app, auth, id, now) {
  let status = '';
  app.runInTransaction(tx => {
    const row = findRun(tx, id);
    if (row.getString('owner') !== auth.id) throw new ApiError(404, '抓取记录不存在');
    status = row.getString('status');
    if (status === 'queued') {
      row.set('status', 'canceled');
      row.set('finishedAt', iso(now));
      tx.save(row);
      status = 'canceled';
    } else if (ACTIVE.includes(status)) {
      row.set('cancelRequested', true);
      tx.save(row);
    }
  });
  return { status };
}

/** The crawler reports one target. A retried report overwrites; the reply says whether to stop. */
function report(app, id, rawBody, now) {
  const body = plain(rawBody);
  let reply = null;
  app.runInTransaction(tx => {
    const row = findRun(tx, id);
    if (!REPORTABLE.includes(row.getString('status'))) throw new ApiError(409, '抓取批次已经结束');
    const items = jsonField(row, 'items') || [];
    const outcome = badRequest(() => validation.normalizeReport(body, items.map(item => item.target)));
    const results = jsonField(row, 'results') || {};
    const { target, ...stored } = outcome;
    results[target] = { ...stored, reportedAt: iso(now) };
    applyResults(row, results);
    if (!row.getString('startedAt')) row.set('startedAt', iso(now));
    tx.save(row);
    recordOutcome(tx, target, row.id, outcome, now);
    reply = { accepted: true, cancelRequested: row.getBool('cancelRequested') };
  });
  return reply;
}

/** The workflow run ended: fill in targets it never reported and set the final status once. */
function settle(app, id, rawBody, now) {
  const body = plain(rawBody);
  const conclusion = typeof body.conclusion === 'string' ? body.conclusion.slice(0, 32) : '';
  let status = '';
  app.runInTransaction(tx => {
    const row = findRun(tx, id);
    status = row.getString('status');
    if (!ACTIVE.includes(status)) return;
    const canceled = row.getBool('cancelRequested') || conclusion === 'cancelled' || body.canceled === true;
    const results = jsonField(row, 'results') || {};
    const items = jsonField(row, 'items') || [];
    for (const item of items) {
      if (results[item.target]) continue;
      if (canceled) {
        results[item.target] = { status: 'canceled', itemCount: 0, recordIds: [], error: '', errorCode: 'canceled' };
      } else {
        const outcome = { status: 'failed', itemCount: 0, recordIds: [], title: '', error: validation.unreportedError(conclusion), errorCode: 'not_reported' };
        results[item.target] = { ...outcome, reportedAt: iso(now) };
        recordOutcome(tx, item.target, row.id, outcome, now);
      }
    }
    const summary = applyResults(row, results);
    status = validation.finalStatus({ targetCount: row.getInt('targetCount'), succeededCount: summary.succeededCount, canceled });
    const failures = Object.values(results).filter(outcome => outcome.status === 'failed');
    row.set('status', status);
    row.set('conclusion', conclusion);
    row.set('finishedAt', iso(now));
    if (status === 'partial') row.set('error', `${failures.length} 个页面抓取失败`);
    else if (status === 'failed') row.set('error', (failures[0] && failures[0].error) || validation.unreportedError(conclusion));
    else row.set('error', '');
    tx.save(row);
  });
  return { status };
}

/**
 * Starts every due schedule. Each owner's targets are grouped into runs of up to 10, in one
 * transaction per owner. A target that is still crawling, or an owner at the active-run cap, skips
 * this slot; either way the next slot is set, so a busy target never piles up runs.
 */
function schedule(app, now) {
  const summary = { created: 0, targets: 0, skipped: 0, missed: 0, failed: 0, more: false };
  const due = app.findRecordsByFilter(
    TARGETS,
    'enabled = true && intervalMinutes > 0 && nextRunAt != "" && nextRunAt <= {:now}',
    'nextRunAt,id', SWEEP_BATCH, 0, { now: filterTime(now) },
  );
  summary.more = due.length === SWEEP_BATCH;
  const owners = new Map();
  for (const row of due) {
    const owner = row.getString('owner');
    if (!owners.has(owner)) owners.set(owner, []);
    owners.get(owner).push(row.id);
  }
  for (const [owner, ids] of owners) {
    try {
      app.runInTransaction(tx => {
        const { busy, activeRuns } = busyTargets(tx, owner);
        const ready = [];
        for (const id of ids) {
          const target = tx.findRecordById(TARGETS, id);
          const interval = target.getInt('intervalMinutes');
          const dueAt = Date.parse(target.getString('nextRunAt').replace(' ', 'T'));
          if (!target.getBool('enabled') || interval <= 0 || !(dueAt <= now)) continue;
          const slot = validation.nextSlot(dueAt, interval, now);
          target.set('nextRunAt', iso(slot.at));
          tx.save(target);
          summary.missed += slot.missed;
          if (busy.has(id)) summary.skipped++;
          else ready.push(target);
        }
        let runs = activeRuns;
        for (let start = 0; start < ready.length; start += validation.MAX_TARGETS_PER_RUN) {
          const batch = ready.slice(start, start + validation.MAX_TARGETS_PER_RUN);
          if (runs >= MAX_ACTIVE_RUNS_PER_OWNER) {
            summary.skipped += batch.length;
            continue;
          }
          const run = new Record(tx.findCollectionByNameOrId(RUNS));
          fillRun(run, owner, batch, 'schedule');
          tx.save(run);
          runs++;
          summary.created++;
          summary.targets += batch.length;
        }
      });
    } catch (error) {
      // One owner's bad row must not stop the others; the next sweep retries it.
      summary.failed++;
      $app.logger().error('crawl schedule failed', 'owner', owner, 'error', String(error));
    }
  }
  return summary;
}

module.exports = { prepareTarget, prepareRun, prepareContent, cancel, report, settle, schedule };
