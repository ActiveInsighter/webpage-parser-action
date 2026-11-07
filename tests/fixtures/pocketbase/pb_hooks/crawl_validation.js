// Validation and schedule arithmetic for web crawling, free of PocketBase globals so it can be unit
// tested. The crawler (webpage-parser-action, webpage_parser/jobs.py) checks the same options again
// on the runner; rejecting here gives the owner the error at the moment they save a target.
/* global __hooks */
const capture = require(typeof __hooks === 'undefined' ? './capture_validation.js' : `${__hooks}/capture_validation.js`);

const MODES = ['auto', 'page', 'x'];
const TRANSPORTS = ['auto', 'http', 'browser'];
const X_SCOPES = ['target', 'visible'];
const X_HOSTS = ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'];
const X_STATUS_PATH = /^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/(?:web\/)?status)\/\d+(?:\/(?:photo|video)\/\d+)?\/?$/;
const ATTRIBUTE = /^[A-Za-z_:][-A-Za-z0-9_:.]{0,99}$/;
const RECORD_ID = /^[a-z0-9]{15}$/;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_SELECTOR = 500;
const MAX_ITEMS_PER_TARGET = 1000;
const MAX_RECORD_IDS = 100;

const MIN_INTERVAL_MINUTES = 30;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MAX_TARGETS_PER_RUN = 10;
const MINUTE = 60_000;

function iso(ms) {
  return new Date(ms).toISOString();
}

function text(value, label, { min = 0, max }) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length < min || result.length > max || CONTROL.test(result)) throw new Error(`${label}无效`);
  return result;
}

function number(value, label, { min, max, integer = false, minExclusive = false }) {
  const result = typeof value === 'string' && value.trim() ? Number(value) : value;
  const valid = typeof result === 'number' && Number.isFinite(result) && (minExclusive ? result > min : result >= min) &&
    result <= max && (!integer || Number.isInteger(result));
  if (!valid) throw new Error(`${label}无效`);
  return result;
}

function oneOf(value, values, label) {
  if (!values.includes(value)) throw new Error(`${label}无效`);
  return value;
}

function isXHost(host) {
  return X_HOSTS.includes(host);
}

/** Only https links that name one post can be matched exactly; profiles need the visible scope. */
function isXStatusUrl(url) {
  const match = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(url);
  return Boolean(match) && X_STATUS_PATH.test(match[1] || '/');
}

/** Same URL rules as page capture; scheme and host lowercased, fragment dropped: one page, one target. */
function normalizeUrl(raw) {
  const { url, host } = capture.normalizeUrl(raw);
  const canonical = url.replace(/#.*$/, '').replace(/^[^:]+:\/\/[^/?#]+/, origin => origin.toLowerCase());
  return { url: canonical, host };
}

/**
 * Crawl options in the record's camelCase; the crawler maps them to its own flags. Empty values are
 * dropped so a target only stores what its owner set.
 */
function normalizeOptions(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('抓取选项无效');
  const allowed = ['selector', 'attribute', 'waitFor', 'delay', 'timeout', 'xScope', 'maxPosts', 'transport'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) throw new Error('抓取选项包含未知参数');
  const options = {};
  const set = (key, value) => {
    if (value !== '' && value !== undefined && value !== null) options[key] = value;
  };
  set('selector', text(raw.selector, '选择器', { max: MAX_SELECTOR }));
  const attribute = text(raw.attribute, '属性名', { max: 100 });
  if (attribute && !ATTRIBUTE.test(attribute)) throw new Error('属性名无效');
  set('attribute', attribute);
  set('waitFor', text(raw.waitFor, '等待元素', { max: MAX_SELECTOR }));
  if (raw.delay !== undefined && raw.delay !== '') set('delay', number(raw.delay, '渲染等待', { min: 0, max: 30 }));
  if (raw.timeout !== undefined && raw.timeout !== '') set('timeout', number(raw.timeout, '超时', { min: 0, max: 120, minExclusive: true }));
  if (raw.xScope !== undefined && raw.xScope !== '') set('xScope', oneOf(raw.xScope, X_SCOPES, 'X 范围'));
  if (raw.maxPosts !== undefined && raw.maxPosts !== '') set('maxPosts', number(raw.maxPosts, '帖子数量', { min: 1, max: 50, integer: true }));
  if (raw.transport !== undefined && raw.transport !== '') set('transport', oneOf(raw.transport, TRANSPORTS, '抓取方式'));
  return options;
}

function normalizeInterval(value) {
  const minutes = value === undefined || value === null || value === '' ? 0 : number(value, '抓取频率', { min: 0, max: MAX_INTERVAL_MINUTES, integer: true });
  if (minutes !== 0 && minutes < MIN_INTERVAL_MINUTES) throw new Error(`抓取间隔不能少于 ${MIN_INTERVAL_MINUTES} 分钟`);
  return minutes;
}

/** Validates a whole target as it will be saved (create, or the record with an update applied). */
function normalizeTarget(input) {
  const { url, host } = normalizeUrl(input.url);
  const mode = oneOf(input.mode || 'auto', MODES, '抓取模式');
  const xPage = isXHost(host);
  if (mode === 'x' && !xPage) throw new Error('X 模式只支持 x.com 或 twitter.com 链接');
  const options = normalizeOptions(input.options);
  const crawlsX = mode === 'x' || (mode === 'auto' && xPage);
  if (crawlsX && options.xScope !== 'visible' && !isXStatusUrl(url)) throw new Error('X 主页需要把范围设为「可见帖子」');
  if (options.transport === 'http' && options.waitFor) throw new Error('等待元素需要浏览器抓取');
  const contentType = text(input.contentType, '分类', { max: 64 }) || (crawlsX ? 'social_media' : 'webpage');
  return {
    url,
    host,
    mode,
    options,
    contentType,
    name: text(input.name, '名称', { max: 120 }),
    intervalMinutes: normalizeInterval(input.intervalMinutes),
    enabled: input.enabled === true,
  };
}

/** A new or changed schedule first fires one interval from now. */
function firstRunAt(intervalMinutes, now) {
  return iso(now + intervalMinutes * MINUTE);
}

/**
 * The next slot strictly after `now` on the target's own grid. Slots missed while the scheduler was
 * away are skipped, not replayed: a crawl shows the page as it is now, so one catch-up run is enough.
 */
function nextSlot(dueMs, intervalMinutes, now) {
  const step = intervalMinutes * MINUTE;
  const elapsed = Math.max(0, Math.floor((now - dueMs) / step) + 1);
  return { at: dueMs + elapsed * step, missed: Math.max(0, elapsed - 1) };
}

/** What a run stores about each target, so later edits never change a queued run. */
function runItem(target) {
  return {
    target: target.id,
    url: target.url,
    name: target.name,
    mode: target.mode,
    contentType: target.contentType,
    options: target.options || {},
  };
}

/** One target's outcome as reported by the crawler. */
function normalizeReport(raw, targetIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('抓取结果无效');
  if (!targetIds.includes(raw.target)) throw new Error('抓取结果不属于这个批次');
  const recordIds = raw.recordIds === undefined ? [] : raw.recordIds;
  if (!Array.isArray(recordIds) || recordIds.length > MAX_RECORD_IDS || recordIds.some(id => !RECORD_ID.test(String(id)))) {
    throw new Error('入库记录无效');
  }
  const errorCode = typeof raw.errorCode === 'string' ? raw.errorCode : '';
  if (errorCode && !ERROR_CODE.test(errorCode)) throw new Error('错误代码无效');
  return {
    target: raw.target,
    status: oneOf(raw.status, ['succeeded', 'failed'], '抓取状态'),
    itemCount: number(raw.itemCount ?? 0, '内容数量', { min: 0, max: MAX_ITEMS_PER_TARGET, integer: true }),
    recordIds: [...new Set(recordIds)],
    title: typeof raw.title === 'string' ? raw.title.replace(CONTROL, ' ').trim().slice(0, 512) : '',
    error: typeof raw.error === 'string' ? raw.error.trim().slice(0, 2000) : '',
    errorCode,
    transport: oneOf(raw.transport || '', ['', 'http', 'browser'], '抓取方式'),
  };
}

/** Counters the lists show, derived from the per-target results. */
function summarize(results) {
  const outcomes = Object.values(results || {});
  return {
    reportedCount: outcomes.filter(outcome => outcome.status === 'succeeded' || outcome.status === 'failed').length,
    succeededCount: outcomes.filter(outcome => outcome.status === 'succeeded').length,
    itemCount: outcomes.reduce((sum, outcome) => sum + (outcome.itemCount || 0), 0),
  };
}

function finalStatus({ targetCount, succeededCount, canceled }) {
  if (canceled) return 'canceled';
  if (targetCount > 0 && succeededCount === targetCount) return 'succeeded';
  return succeededCount > 0 ? 'partial' : 'failed';
}

/** Why a target has no result when its workflow run ended, by the run's conclusion. */
function unreportedError(conclusion) {
  if (conclusion === 'timed_out') return '抓取超时，未返回这个页面的结果';
  if (conclusion === 'success') return '抓取程序没有返回这个页面的结果';
  return '抓取任务异常结束，可在 GitHub 运行记录中查看原因';
}

module.exports = {
  MAX_TARGETS_PER_RUN,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  isXStatusUrl,
  normalizeUrl,
  normalizeOptions,
  normalizeTarget,
  firstRunAt,
  nextSlot,
  runItem,
  normalizeReport,
  summarize,
  finalStatus,
  unreportedError,
};
