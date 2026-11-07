/* global Collection, DateField, RelationField, TextField, migrate */

// Scheduled web crawling, executed by the webpage-parser-action GitHub workflow.
//
//   aw_crawl_targets     pages an owner keeps crawling: URL, options, schedule and the latest outcome
//   aw_crawl_runs        one workflow run over up to 10 targets (task kind `web-crawl`)
//   aw_crawled_contents  what the crawls found, one row per owner and content identity (1794045600)
//
// Owners edit targets through the records API; pb_hooks/crawl.js validates them and keeps the
// schedule and outcome fields server-owned. Runs change only through the hook routes: owners create
// and cancel them, the crawler service reports each target, and the scheduler settles them.
const OWNER_RULE = '@request.auth.id != "" && @request.auth.collectionName = "aw_clients" && owner = @request.auth.id';
const CREATE_RULE = '@request.auth.id != "" && @request.auth.collectionName = "aw_clients" && @request.body.owner = @request.auth.id';
const SERVICE_RULE = '@request.auth.id != "" && @request.auth.collectionName = "aw_crawler_services" && @request.auth.verified = true';
const TERMINAL = '(status = "succeeded" || status = "partial" || status = "failed" || status = "canceled")';
const TARGETS = 'aw_crawl_targets';
const RUNS = 'aw_crawl_runs';
const CONTENTS = 'aw_crawled_contents';
const CONTENT_FIELDS = ['target', 'run', 'contentHash', 'changedAt'];
const CONTENT_INDEXES = [
  `CREATE INDEX idx_crawled_contents_owner_target_time ON ${CONTENTS} (owner, target, fetchedAt DESC)`,
  `CREATE INDEX idx_crawled_contents_run ON ${CONTENTS} (run)`,
];

function findOptionalCollection(app, name) {
  try {
    return app.findCollectionByNameOrId(name);
  } catch {
    return undefined;
  }
}

migrate((app) => {
  const clients = app.findCollectionByNameOrId('aw_clients').id;
  const owner = { name: 'owner', type: 'relation', required: true, collectionId: clients, maxSelect: 1, cascadeDelete: true };
  const timestamps = [
    { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
    { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
  ];

  if (!findOptionalCollection(app, TARGETS)) {
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
        // What to crawl and how. Validated and normalized by pb_hooks/crawl_validation.js.
        { name: 'url', type: 'text', required: true, max: 2048 },
        { name: 'host', type: 'text', max: 255 },
        { name: 'name', type: 'text', max: 120 },
        { name: 'mode', type: 'select', required: true, maxSelect: 1, values: ['auto', 'page', 'x'] },
        { name: 'contentType', type: 'text', required: true, min: 1, max: 64 },
        { name: 'options', type: 'json', maxSize: 16384 },
        // Schedule. 0 minutes means on demand only; the scheduler fires enabled targets at nextRunAt.
        { name: 'intervalMinutes', type: 'number', min: 0, max: 10080, onlyInt: true },
        { name: 'enabled', type: 'bool' },
        { name: 'nextRunAt', type: 'date' },
        // Latest outcome, written when the crawler reports a target, so lists never read runs.
        { name: 'lastRunAt', type: 'date' },
        { name: 'lastRun', type: 'text', max: 15 },
        { name: 'lastStatus', type: 'select', maxSelect: 1, values: ['succeeded', 'failed'] },
        { name: 'lastError', type: 'text', max: 2000 },
        { name: 'lastErrorCode', type: 'text', max: 64 },
        { name: 'lastItemCount', type: 'number', min: 0, onlyInt: true },
        { name: 'pageTitle', type: 'text', max: 512 },
        ...timestamps,
      ],
      indexes: [
        `CREATE UNIQUE INDEX idx_crawl_targets_owner_url ON ${TARGETS} (owner, url)`,
        `CREATE INDEX idx_crawl_targets_owner_created ON ${TARGETS} (owner, created DESC, id DESC)`,
        `CREATE INDEX idx_crawl_targets_due ON ${TARGETS} (enabled, nextRunAt)`,
      ],
    }));
  }

  if (!findOptionalCollection(app, RUNS)) {
    app.save(new Collection({
      name: RUNS,
      type: 'base',
      // The crawler reads the snapshot of the run it was dispatched for, by id only.
      listRule: OWNER_RULE,
      viewRule: `(${OWNER_RULE}) || (${SERVICE_RULE})`,
      createRule: CREATE_RULE,
      updateRule: null,
      deleteRule: `${OWNER_RULE} && ${TERMINAL}`,
      fields: [
        owner,
        { name: 'targets', type: 'relation', collectionId: app.findCollectionByNameOrId(TARGETS).id, maxSelect: 10, cascadeDelete: false },
        { name: 'trigger', type: 'select', required: true, maxSelect: 1, values: ['manual', 'schedule'] },
        // Targets as they were when the run was created; editing a target never changes a queued run.
        { name: 'items', type: 'json', maxSize: 262144 },
        // Per-target outcome reported by the crawler, keyed by target id.
        { name: 'results', type: 'json', maxSize: 262144 },
        // Lifecycle. Statuses match webCrawlKind in src/platform/tasks/catalog.mjs.
        {
          name: 'status',
          type: 'select',
          required: true,
          maxSelect: 1,
          values: ['queued', 'dispatching', 'pending', 'running', 'succeeded', 'partial', 'failed', 'canceled'],
        },
        { name: 'cancelRequested', type: 'bool' },
        { name: 'targetCount', type: 'number', min: 0, max: 10, onlyInt: true },
        { name: 'reportedCount', type: 'number', min: 0, max: 10, onlyInt: true },
        { name: 'succeededCount', type: 'number', min: 0, max: 10, onlyInt: true },
        { name: 'itemCount', type: 'number', min: 0, onlyInt: true },
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
        `CREATE INDEX idx_crawl_runs_owner_created ON ${RUNS} (owner, created DESC, id DESC)`,
        `CREATE INDEX idx_crawl_runs_status ON ${RUNS} (status, created)`,
      ],
    }));
  }

  // Link stored contents to what produced them; the hash lets lists show what changed.
  const contents = app.findCollectionByNameOrId(CONTENTS);
  const additions = [
    new RelationField({ name: 'target', collectionId: app.findCollectionByNameOrId(TARGETS).id, maxSelect: 1, cascadeDelete: false }),
    new RelationField({ name: 'run', collectionId: app.findCollectionByNameOrId(RUNS).id, maxSelect: 1, cascadeDelete: false }),
    new TextField({ name: 'contentHash', max: 64 }),
    new DateField({ name: 'changedAt' }),
  ];
  for (const field of additions) {
    if (!contents.fields.getByName(field.name)) contents.fields.add(field);
  }
  const indexes = contents.indexes || [];
  for (const index of CONTENT_INDEXES) {
    if (!indexes.includes(index)) indexes.push(index);
  }
  contents.indexes = indexes;
  app.save(contents);
}, (app) => {
  const contents = findOptionalCollection(app, CONTENTS);
  if (contents) {
    for (const name of CONTENT_FIELDS) contents.fields.removeByName(name);
    contents.indexes = contents.indexes.filter(index => !CONTENT_INDEXES.includes(index));
    app.save(contents);
  }
  for (const name of [RUNS, TARGETS]) {
    const collection = findOptionalCollection(app, name);
    if (collection) app.delete(collection);
  }
});
