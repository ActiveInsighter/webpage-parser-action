/* global Collection, migrate */

// One crawling system for both executors (AnyWorkflow Crawler, the former webpage-parser-action
// and Anyworkflow-capture). A job is one URL; it runs either in the cloud (the crawler's GitHub
// workflow, anonymous) or in the owner's browser (the crawler's extension, signed in). Both claim
// jobs through the same lease routes in pb_hooks/crawl.js and write the same document shape.
//
//   aw_crawl_targets     pages an owner keeps: URL, executor, options, schedule, latest outcome
//   aw_crawl_jobs        one crawl of one URL; light rows the task center and lists poll
//   aw_crawl_documents   the latest content per owner and content identity, read on demand
//   aw_crawl_dispatches  cloud executor runs (one GitHub workflow run drains the cloud queue)
//   aw_crawl_workers     browser extension installs, so Remote can say whether one is online
//
// The previous capture and crawl collections are dropped without a copy: their data is not kept.
// Clients never write lifecycle fields: jobs, documents and dispatches change through the routes.
const OWNER_RULE = '@request.auth.id != "" && @request.auth.collectionName = "aw_clients" && owner = @request.auth.id';
const CREATE_RULE = '@request.auth.id != "" && @request.auth.collectionName = "aw_clients" && @request.body.owner = @request.auth.id';
const TERMINAL = '(status = "succeeded" || status = "partial" || status = "failed" || status = "canceled")';
const TARGETS = 'aw_crawl_targets';
const JOBS = 'aw_crawl_jobs';
const DOCUMENTS = 'aw_crawl_documents';
const DISPATCHES = 'aw_crawl_dispatches';
const WORKERS = 'aw_crawl_workers';
const RETIRED = ['aw_capture_results', 'aw_capture_jobs', 'aw_capture_workers', 'aw_crawled_contents', 'aw_crawl_runs', 'aw_crawl_targets'];
const RUNNERS = ['cloud', 'browser'];
const OUTCOMES = ['succeeded', 'partial', 'failed', 'canceled'];

function findOptionalCollection(app, name) {
  try {
    return app.findCollectionByNameOrId(name);
  } catch {
    return undefined;
  }
}

migrate((app) => {
  // Already on the new schema (a re-run): the new targets collection carries `runner`.
  const existing = findOptionalCollection(app, TARGETS);
  if (existing && existing.fields.getByName('runner') && findOptionalCollection(app, JOBS)) return;
  for (const name of RETIRED) {
    const collection = findOptionalCollection(app, name);
    if (collection) app.delete(collection);
  }

  const clients = app.findCollectionByNameOrId('aw_clients').id;
  const owner = { name: 'owner', type: 'relation', required: true, collectionId: clients, maxSelect: 1, cascadeDelete: true };
  const timestamps = [
    { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
    { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
  ];

  app.save(new Collection({
    name: TARGETS,
    type: 'base',
    listRule: OWNER_RULE,
    viewRule: OWNER_RULE,
    createRule: CREATE_RULE,
    updateRule: `${OWNER_RULE} && @request.body.owner:changed = false`,
    deleteRule: OWNER_RULE,
    fields: [
      owner,
      // What to crawl and where. Validated and normalized by pb_hooks/crawl_validation.js.
      { name: 'url', type: 'text', required: true, max: 2048 },
      { name: 'host', type: 'text', max: 255 },
      { name: 'name', type: 'text', max: 120 },
      { name: 'runner', type: 'select', required: true, maxSelect: 1, values: RUNNERS },
      { name: 'category', type: 'text', required: true, min: 1, max: 64 },
      { name: 'options', type: 'json', maxSize: 16384 },
      // Schedule. 0 minutes means on demand only; the scheduler queues enabled targets at nextRunAt.
      { name: 'intervalMinutes', type: 'number', min: 0, max: 10080, onlyInt: true },
      { name: 'enabled', type: 'bool' },
      { name: 'nextRunAt', type: 'date' },
      // Latest outcome, written when a job of this target ends, so lists never read jobs.
      { name: 'lastJob', type: 'text', max: 15 },
      { name: 'lastRunAt', type: 'date' },
      { name: 'lastStatus', type: 'select', maxSelect: 1, values: OUTCOMES },
      { name: 'lastErrorCode', type: 'text', max: 64 },
      { name: 'lastError', type: 'text', max: 2000 },
      { name: 'lastDocument', type: 'text', max: 15 },
      { name: 'title', type: 'text', max: 512 },
      ...timestamps,
    ],
    indexes: [
      `CREATE UNIQUE INDEX idx_crawl_targets_owner_url ON ${TARGETS} (owner, url)`,
      `CREATE INDEX idx_crawl_targets_owner_created ON ${TARGETS} (owner, created DESC, id DESC)`,
      `CREATE INDEX idx_crawl_targets_due ON ${TARGETS} (enabled, nextRunAt)`,
    ],
  }));

  app.save(new Collection({
    name: JOBS,
    type: 'base',
    listRule: OWNER_RULE,
    viewRule: OWNER_RULE,
    createRule: CREATE_RULE,
    updateRule: null,
    deleteRule: `${OWNER_RULE} && ${TERMINAL}`,
    fields: [
      owner,
      // A saved page's job keeps a link to it; deleting the page keeps its history.
      { name: 'target', type: 'relation', collectionId: app.findCollectionByNameOrId(TARGETS).id, maxSelect: 1, cascadeDelete: false },
      // What was asked for, snapshot at creation: editing a target never changes a queued job.
      { name: 'url', type: 'text', required: true, max: 2048 },
      { name: 'host', type: 'text', max: 255 },
      { name: 'runner', type: 'select', required: true, maxSelect: 1, values: RUNNERS },
      { name: 'category', type: 'text', required: true, min: 1, max: 64 },
      { name: 'options', type: 'json', maxSize: 16384 },
      { name: 'trigger', type: 'select', required: true, maxSelect: 1, values: ['manual', 'schedule'] },
      { name: 'rerunOf', type: 'text', max: 15 },
      // Lifecycle. Statuses match crawlJobKind in src/platform/tasks/catalog.mjs.
      {
        name: 'status',
        type: 'select',
        required: true,
        maxSelect: 1,
        values: ['queued', 'opening', 'rendering', 'extracting', 'uploading', ...OUTCOMES],
      },
      { name: 'cancelRequested', type: 'bool' },
      // Scheduling, written by the routes only.
      { name: 'attempts', type: 'number', min: 0, onlyInt: true },
      { name: 'nextAttemptAt', type: 'date' },
      { name: 'workerId', type: 'text', max: 64 },
      { name: 'leaseId', type: 'text', max: 64 },
      { name: 'leaseUntil', type: 'date' },
      { name: 'dispatch', type: 'text', max: 15 },
      { name: 'errorCode', type: 'text', max: 64 },
      { name: 'error', type: 'text', max: 2000 },
      { name: 'startedAt', type: 'date' },
      { name: 'finishedAt', type: 'date' },
      // Summary of the result, so lists never read documents.
      { name: 'title', type: 'text', max: 512 },
      { name: 'siteName', type: 'text', max: 255 },
      { name: 'extractor', type: 'text', max: 64 },
      { name: 'profile', type: 'text', max: 64 },
      { name: 'wordCount', type: 'number', min: 0, onlyInt: true },
      { name: 'qualityScore', type: 'number', min: 0, max: 100, onlyInt: true },
      { name: 'itemCount', type: 'number', min: 0, onlyInt: true },
      { name: 'document', type: 'text', max: 15 },
      { name: 'contentHash', type: 'text', max: 64 },
      { name: 'changed', type: 'bool' },
      ...timestamps,
    ],
    indexes: [
      `CREATE INDEX idx_crawl_jobs_owner_created ON ${JOBS} (owner, created DESC, id DESC)`,
      `CREATE INDEX idx_crawl_jobs_claim ON ${JOBS} (runner, status, owner, nextAttemptAt, created)`,
      `CREATE INDEX idx_crawl_jobs_lease ON ${JOBS} (status, leaseUntil)`,
      `CREATE INDEX idx_crawl_jobs_target ON ${JOBS} (target, created DESC)`,
      `CREATE INDEX idx_crawl_jobs_dispatch ON ${JOBS} (dispatch)`,
    ],
  }));

  app.save(new Collection({
    name: DOCUMENTS,
    type: 'base',
    listRule: OWNER_RULE,
    viewRule: OWNER_RULE,
    createRule: null,
    updateRule: null,
    deleteRule: OWNER_RULE,
    fields: [
      owner,
      // sha256 of the content identity: a profile's own id (an X post) or the canonical URL.
      { name: 'key', type: 'text', required: true, min: 64, max: 64, pattern: '^[a-f0-9]{64}$' },
      { name: 'identity', type: 'text', max: 2048 },
      { name: 'target', type: 'relation', collectionId: app.findCollectionByNameOrId(TARGETS).id, maxSelect: 1, cascadeDelete: false },
      { name: 'job', type: 'text', max: 15 },
      { name: 'runner', type: 'select', required: true, maxSelect: 1, values: RUNNERS },
      { name: 'category', type: 'text', required: true, min: 1, max: 64 },
      // Where it came from, after redirects.
      { name: 'url', type: 'text', required: true, max: 2048 },
      { name: 'canonicalUrl', type: 'text', max: 2048 },
      { name: 'host', type: 'text', max: 255 },
      { name: 'httpStatus', type: 'number', min: 0, max: 599, onlyInt: true },
      // What it is.
      { name: 'title', type: 'text', max: 512 },
      { name: 'byline', type: 'text', max: 2000 },
      { name: 'siteName', type: 'text', max: 2000 },
      { name: 'language', type: 'text', max: 32 },
      { name: 'description', type: 'text', max: 2000 },
      { name: 'publishedAt', type: 'date' },
      { name: 'leadImage', type: 'text', max: 2048 },
      // The content. `html` is only kept when the job asks for it; `items` holds structured
      // entries a profile read (posts of an X page), each with its own identity.
      { name: 'markdown', type: 'text', required: true, max: 2000000 },
      { name: 'html', type: 'text', max: 4000000 },
      { name: 'wordCount', type: 'number', min: 0, onlyInt: true },
      { name: 'items', type: 'json', maxSize: 1048576 },
      { name: 'links', type: 'json', maxSize: 1048576 },
      { name: 'images', type: 'json', maxSize: 524288 },
      { name: 'structuredData', type: 'json', maxSize: 524288 },
      { name: 'extras', type: 'json', maxSize: 262144 },
      // How it was read, for tuning site profiles.
      { name: 'extractor', type: 'text', max: 64 },
      { name: 'profile', type: 'text', max: 64 },
      { name: 'qualityScore', type: 'number', min: 0, max: 100, onlyInt: true },
      { name: 'warnings', type: 'json', maxSize: 8192 },
      { name: 'trace', type: 'json', maxSize: 16384 },
      { name: 'crawlerVersion', type: 'text', max: 32 },
      // Change tracking: the hash is the server's sha256 of `markdown`; changedAt moves only with it.
      { name: 'contentHash', type: 'text', max: 64 },
      { name: 'fetchedAt', type: 'date', required: true },
      { name: 'changedAt', type: 'date' },
      ...timestamps,
    ],
    indexes: [
      `CREATE UNIQUE INDEX idx_crawl_documents_owner_key ON ${DOCUMENTS} (owner, key)`,
      `CREATE INDEX idx_crawl_documents_owner_fetched ON ${DOCUMENTS} (owner, fetchedAt DESC, id DESC)`,
      `CREATE INDEX idx_crawl_documents_owner_category ON ${DOCUMENTS} (owner, category, fetchedAt DESC)`,
      `CREATE INDEX idx_crawl_documents_target ON ${DOCUMENTS} (target, fetchedAt DESC)`,
    ],
  }));

  app.save(new Collection({
    name: DISPATCHES,
    type: 'base',
    // Executor bookkeeping across owners: only the scheduler's superuser credential reads it.
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      // Statuses match crawlDispatchKind in src/platform/tasks/catalog.mjs.
      {
        name: 'status',
        type: 'select',
        required: true,
        maxSelect: 1,
        values: ['queued', 'dispatching', 'pending', 'running', 'succeeded', 'failed', 'canceled'],
      },
      { name: 'cancelRequested', type: 'bool' },
      // Set when the workflow stops taking jobs; a closed dispatch no longer counts as capacity.
      { name: 'closedAt', type: 'date' },
      { name: 'claimedCount', type: 'number', min: 0, onlyInt: true },
      // GitHub Actions executor fields (src/platform/tasks/executors/github-actions.mjs).
      { name: 'githubRunId', type: 'text', max: 32 },
      { name: 'conclusion', type: 'text', max: 32 },
      { name: 'dispatchStartedAt', type: 'date' },
      { name: 'startedAt', type: 'date' },
      { name: 'finishedAt', type: 'date' },
      { name: 'syncFailures', type: 'number', min: 0, onlyInt: true },
      { name: 'error', type: 'text', max: 2000 },
      ...timestamps,
    ],
    indexes: [
      `CREATE INDEX idx_crawl_dispatches_status ON ${DISPATCHES} (status, created)`,
    ],
  }));

  app.save(new Collection({
    name: WORKERS,
    type: 'base',
    listRule: OWNER_RULE,
    viewRule: OWNER_RULE,
    createRule: null,
    updateRule: null,
    deleteRule: OWNER_RULE,
    fields: [
      owner,
      { name: 'workerId', type: 'text', required: true, max: 64 },
      { name: 'label', type: 'text', max: 120 },
      { name: 'version', type: 'text', max: 32 },
      { name: 'lastSeenAt', type: 'date', required: true },
      ...timestamps,
    ],
    indexes: [
      `CREATE UNIQUE INDEX idx_crawl_workers_owner_worker ON ${WORKERS} (owner, workerId)`,
      `CREATE INDEX idx_crawl_workers_seen ON ${WORKERS} (lastSeenAt)`,
    ],
  }));
}, (app) => {
  // The retired collections are not restored: their data was dropped on the way up.
  for (const name of [WORKERS, DISPATCHES, DOCUMENTS, JOBS, TARGETS]) {
    const collection = findOptionalCollection(app, name);
    if (collection) app.delete(collection);
  }
});
