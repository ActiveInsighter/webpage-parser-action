/* global onRecordCreateRequest, onRecordUpdateRequest, routerAdd, $apis, __hooks */
onRecordCreateRequest(event => require(`${__hooks}/crawl.js`).prepareTarget(event, true), 'aw_crawl_targets');
onRecordUpdateRequest(event => require(`${__hooks}/crawl.js`).prepareTarget(event, false), 'aw_crawl_targets');
onRecordCreateRequest(event => require(`${__hooks}/crawl.js`).prepareJob(event), 'aw_crawl_jobs');

// Executor routes. The owner's browser extension (aw_clients) takes browser jobs; the cloud
// crawler (aw_crawler_services) takes cloud jobs inside a dispatch. crawl.js tells them apart.
const executor = $apis.requireAuth('aw_clients', 'aw_crawler_services');

routerAdd('POST', '/api/anyworkflow/crawl/claim', event => {
  return event.json(200, require(`${__hooks}/crawl.js`).claim(event.app, event.auth, event.requestInfo().body, Date.now()));
}, executor, $apis.bodyLimit(4096));

routerAdd('POST', '/api/anyworkflow/crawl/jobs/{id}/renew', event => {
  return event.json(200, require(`${__hooks}/crawl.js`).renew(event.app, event.auth, event.request.pathValue('id'), event.requestInfo().body, Date.now()));
}, executor, $apis.bodyLimit(1024));

// The largest result: 2 MB of Markdown and 4 MB of HTML as UTF-8, plus items, links and images.
routerAdd('POST', '/api/anyworkflow/crawl/jobs/{id}/complete', event => {
  return event.json(200, require(`${__hooks}/crawl.js`).complete(event.app, event.auth, event.request.pathValue('id'), event.requestInfo().body, Date.now()));
}, executor, $apis.bodyLimit(32 * 1024 * 1024));

routerAdd('POST', '/api/anyworkflow/crawl/jobs/{id}/fail', event => {
  return event.json(200, require(`${__hooks}/crawl.js`).fail(event.app, event.auth, event.request.pathValue('id'), event.requestInfo().body, Date.now()));
}, executor, $apis.bodyLimit(8192));

routerAdd('POST', '/api/anyworkflow/crawl/dispatches/{id}/close', event => {
  return event.json(200, require(`${__hooks}/crawl.js`).closeDispatch(event.app, event.auth, event.request.pathValue('id'), Date.now()));
}, $apis.requireAuth('aw_crawler_services'), $apis.bodyLimit(1024));

// Owner route.
routerAdd('POST', '/api/anyworkflow/crawl/jobs/{id}/cancel', event => {
  return event.json(200, require(`${__hooks}/crawl.js`).cancel(event.app, event.auth, event.request.pathValue('id'), Date.now()));
}, $apis.requireAuth('aw_clients'), $apis.bodyLimit(1024));

// Scheduler routes: it is the sole timer owner, and only its superuser credential reaches them.
routerAdd('POST', '/api/anyworkflow/crawl/maintain', event => {
  return event.json(200, require(`${__hooks}/crawl.js`).maintain(event.app, Date.now()));
}, $apis.requireSuperuserAuth(), $apis.bodyLimit(1024));

routerAdd('POST', '/api/anyworkflow/crawl/dispatches/plan', event => {
  return event.json(200, require(`${__hooks}/crawl.js`).planDispatches(event.app, event.requestInfo().body, Date.now()));
}, $apis.requireSuperuserAuth(), $apis.bodyLimit(1024));

routerAdd('POST', '/api/anyworkflow/crawl/dispatches/{id}/settle', event => {
  return event.json(200, require(`${__hooks}/crawl.js`).settleDispatch(event.app, event.request.pathValue('id'), event.requestInfo().body, Date.now()));
}, $apis.requireSuperuserAuth(), $apis.bodyLimit(1024));
