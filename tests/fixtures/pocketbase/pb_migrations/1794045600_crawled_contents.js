/* Additive collection for webpage-parser-action and future Remote callers. */
migrate((app) => {
  // Separate machine identity: no API registration, no management of app users.
  app.save(new Collection({
    name: 'aw_crawler_services', type: 'auth',
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, manageRule: null,
    authRule: 'verified = true',
    passwordAuth: {enabled: true, identityFields: ['email']},
    authToken: {duration: 31536000},
    fields: [{name: 'label', type: 'text', max: 120}],
  }));
  const service = '@request.auth.id != "" && @request.auth.collectionName = "aw_crawler_services" && @request.auth.verified = true';
  const owner = '@request.auth.id != "" && @request.auth.collectionName = "aw_clients" && owner = @request.auth.id';
  app.save(new Collection({
    name: 'aw_crawled_contents', type: 'base',
    listRule: '(' + owner + ') || (' + service + ')', viewRule: '(' + owner + ') || (' + service + ')',
    createRule: '(@request.auth.id != "" && @request.auth.collectionName = "aw_clients" && @request.body.owner = @request.auth.id) || (' + service + ')',
    updateRule: '((' + owner + ') || (' + service + ')) && @request.body.owner:changed = false && @request.body.dedupeKey:changed = false && @request.body.platform:changed = false && @request.body.externalId:changed = false',
    deleteRule: owner,
    fields: [
      {name: 'owner', type: 'relation', required: true, collectionId: app.findCollectionByNameOrId('aw_clients').id, maxSelect: 1, cascadeDelete: true},
      {name: 'dedupeKey', type: 'text', required: true, min: 64, max: 64, pattern: '^[a-f0-9]{64}$'},
      {name: 'type', type: 'text', required: true, min: 1, max: 64},
      {name: 'platform', type: 'select', required: true, maxSelect: 1, values: ['x', 'web']},
      {name: 'source', type: 'url', required: true},
      {name: 'canonicalUrl', type: 'url', required: true},
      {name: 'externalId', type: 'text', max: 32},
      {name: 'title', type: 'text', max: 512},
      {name: 'content', type: 'text', max: 2097152},
      {name: 'author', type: 'text', max: 512},
      {name: 'handle', type: 'text', max: 64},
      {name: 'publishedAt', type: 'date'},
      {name: 'fetchedAt', type: 'date', required: true},
      {name: 'requestId', type: 'text', max: 128},
      {name: 'media', type: 'json', maxSize: 262144},
      {name: 'metrics', type: 'json', maxSize: 16384},
      {name: 'metadata', type: 'json', maxSize: 4194304},
      {name: 'created', type: 'autodate', onCreate: true, onUpdate: false},
      {name: 'updated', type: 'autodate', onCreate: false, onUpdate: true},
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_crawled_contents_owner_key ON aw_crawled_contents (owner, dedupeKey)',
      'CREATE INDEX idx_crawled_contents_owner_type_time ON aw_crawled_contents (owner, type, fetchedAt DESC)',
      'CREATE INDEX idx_crawled_contents_owner_request ON aw_crawled_contents (owner, requestId)',
    ],
  }));
}, (app) => {
  app.delete(app.findCollectionByNameOrId('aw_crawled_contents'));
  app.delete(app.findCollectionByNameOrId('aw_crawler_services'));
});
