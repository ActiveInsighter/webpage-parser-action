/* global onRecordCreateRequest, onRecordUpdateRequest, routerAdd, $apis, __hooks */
onRecordCreateRequest(event => require(`${__hooks}/crawl.js`).prepareTarget(event, true), 'aw_crawl_targets');
onRecordUpdateRequest(event => require(`${__hooks}/crawl.js`).prepareTarget(event, false), 'aw_crawl_targets');
onRecordCreateRequest(event => require(`${__hooks}/crawl.js`).prepareRun(event), 'aw_crawl_runs');
onRecordCreateRequest(event => require(`${__hooks}/crawl.js`).prepareContent(event, true), 'aw_crawled_contents');
onRecordUpdateRequest(event => require(`${__hooks}/crawl.js`).prepareContent(event, false), 'aw_crawled_contents');

routerAdd('POST', '/api/anyworkflow/crawl/runs/{id}/cancel', event => {
  return event.json(200, require(`${__hooks}/crawl.js`).cancel(event.app, event.auth, event.request.pathValue('id'), Date.now()));
}, $apis.requireAuth('aw_clients'), $apis.bodyLimit(1024));

// The crawler service (webpage-parser-action) reports each target of the run it was dispatched for.
routerAdd('POST', '/api/anyworkflow/crawl/runs/{id}/report', event => {
  return event.json(200, require(`${__hooks}/crawl.js`).report(event.app, event.request.pathValue('id'), event.requestInfo().body, Date.now()));
}, $apis.requireAuth('aw_crawler_services'), $apis.bodyLimit(16384));

// Scheduler is the sole timer owner. Only its server credential settles runs and sweeps schedules.
routerAdd('POST', '/api/anyworkflow/crawl/runs/{id}/settle', event => {
  return event.json(200, require(`${__hooks}/crawl.js`).settle(event.app, event.request.pathValue('id'), event.requestInfo().body, Date.now()));
}, $apis.requireSuperuserAuth(), $apis.bodyLimit(1024));

routerAdd('POST', '/api/anyworkflow/crawl/schedule', event => {
  return event.json(200, require(`${__hooks}/crawl.js`).schedule(event.app, Date.now()));
}, $apis.requireSuperuserAuth(), $apis.bodyLimit(1024));
