// Validation and schedule arithmetic for crawling, free of PocketBase globals so it can be unit
// tested. Jobs are remote input: a browser job is opened in a browser signed in to real accounts.
// The crawler applies the same rules again before it opens anything (AnyWorkflow Crawler:
// src/core/url-policy.ts and src/core/contract.ts); rejecting here tells the owner at once.
//
// Keep in step with the crawler: option names and bounds, error codes and which of them retry,
// result field limits. Its contract test reads this file.
const MAX_URL = 2048;
const MAX_SELECTOR = 500;
const MAX_SELECTORS = 20;
const MAX_IDENTITY = 2048;
const MAX_ITEMS = 200;
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa'];
const CONTROL = /[\u0000-\u001f\u007f]/;

const RUNNERS = ['cloud', 'browser'];
const SCOPES = ['target', 'visible'];
const TRANSPORTS = ['auto', 'http', 'browser'];
const X_HOSTS = ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'];
const X_STATUS_PATH = /^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/(?:web\/)?status)\/\d+(?:\/(?:photo|video)\/\d+)?\/?$/;

/** Error codes a crawler may report, and whether the server queues another attempt. */
const ERROR_CODES = {
  URL_BLOCKED: false,
  NAVIGATION_FAILED: true,
  HTTP_ERROR: true,
  NOT_FOUND: false,
  LOGIN_REQUIRED: false,
  CAPTCHA: false,
  ACCESS_DENIED: false,
  UNSUPPORTED_CONTENT: false,
  EMPTY_CONTENT: true,
  TARGET_NOT_FOUND: false,
  STEP_FAILED: false,
  TIMEOUT: true,
  PAGE_GONE: true,
  CANCELED: false,
  INTERNAL: true,
  // Set by the server, never by a crawler.
  LEASE_LOST: true,
  NO_WORKER: false,
};
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30_000;
/** Below this score a result is `partial`: something was read, and a person should check it. */
const ACCEPTABLE_SCORE = 40;

const MIN_INTERVAL_MINUTES = 30;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MINUTE = 60_000;

function iso(ms) {
  return new Date(ms).toISOString();
}

function isPrivateIpv4(host) {
  const parts = host.split('.').map(Number);
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function isLocalHost(host) {
  if (host.startsWith('[')) {
    const address = host.slice(1, -1);
    return address === '::' || address === '::1' || /^f[cd]/.test(address) || /^fe[89ab]/.test(address) || address.startsWith('::ffff:');
  }
  const name = host.replace(/\.$/, '');
  if (name === 'localhost' || !name.includes('.') || LOCAL_SUFFIXES.some(suffix => name.endsWith(suffix))) return true;
  // Browsers read a host ending in a number as an IPv4 address (127.1, 0x7f.0.0.1, 2130706433).
  const last = name.split('.').pop();
  if (/^(?:\d+|0x[0-9a-f]*)$/.test(last)) {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(name) || name.split('.').some(part => Number(part) > 255)) return true;
    return isPrivateIpv4(name);
  }
  return false;
}

/**
 * http(s) only, no credentials, no local or private address. Scheme and host are lowercased and
 * the fragment dropped, so one page is one target.
 */
function normalizeUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new Error('请填写链接');
  if (value.length > MAX_URL) throw new Error('链接过长');
  const match = /^(https?):\/\/([^/?#\s]+)([/?#]\S*)?$/i.exec(value);
  if (!match) throw new Error('只支持 http 和 https 链接');
  const authority = match[2];
  if (authority.includes('@')) throw new Error('链接不能包含账号或密码');
  const host = authority.replace(/:\d*$/, '').toLowerCase();
  if (!host || isLocalHost(host)) throw new Error('不能抓取本机或内网地址');
  const rest = (match[3] || '').replace(/#.*$/, '');
  return { url: `${match[1].toLowerCase()}://${authority.toLowerCase()}${rest || '/'}`, host };
}

function isXHost(host) {
  return X_HOSTS.includes(host);
}

/** Only links that name one post can be matched exactly; other X pages need the visible scope. */
function isXStatusUrl(url) {
  const match = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(url);
  return Boolean(match) && X_STATUS_PATH.test(match[1] || '/');
}

function text(value, label, max, min = 0) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length < min || result.length > max || CONTROL.test(result)) throw new Error(`${label}无效`);
  return result;
}

function selector(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_SELECTOR || CONTROL.test(value)) throw new Error(`${label}无效`);
  return value.trim();
}

function integer(value, label, min, max) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}应为 ${min}–${max}`);
  return number;
}

function oneOf(value, values, label) {
  if (!values.includes(value)) throw new Error(`${label}无效`);
  return value;
}

const OPTION_KEYS = ['waitFor', 'contentSelector', 'removeSelectors', 'scroll', 'keepHtml', 'generic', 'timeoutSeconds', 'scope', 'maxItems', 'transport'];

/**
 * Per-job overrides. Selectors and numbers only: a job never carries code. Empty values are
 * dropped so a record stores only what its owner set.
 */
function normalizeOptions(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('抓取选项无效');
  if (Object.keys(raw).some(key => !OPTION_KEYS.includes(key))) throw new Error('抓取选项包含未知参数');
  const options = {};
  const present = key => raw[key] !== undefined && raw[key] !== null && raw[key] !== '';
  if (present('waitFor')) options.waitFor = selector(raw.waitFor, '等待元素');
  if (present('contentSelector')) options.contentSelector = selector(raw.contentSelector, '正文选择器');
  if (raw.removeSelectors !== undefined && raw.removeSelectors !== null) {
    if (!Array.isArray(raw.removeSelectors) || raw.removeSelectors.length > MAX_SELECTORS) throw new Error('移除元素无效');
    const list = raw.removeSelectors.map(value => selector(value, '移除元素'));
    if (list.length) options.removeSelectors = list;
  }
  for (const key of ['scroll', 'keepHtml', 'generic']) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (typeof raw[key] !== 'boolean') throw new Error('抓取选项无效');
    if (raw[key]) options[key] = true;
  }
  if (present('timeoutSeconds')) options.timeoutSeconds = integer(raw.timeoutSeconds, '超时时间（秒）', 10, 280);
  if (present('scope')) options.scope = oneOf(raw.scope, SCOPES, '读取范围');
  if (present('maxItems')) options.maxItems = integer(raw.maxItems, '条目数量', 1, 50);
  if (present('transport')) options.transport = oneOf(raw.transport, TRANSPORTS, '云端读取方式');
  return options;
}

function defaultCategory(host) {
  return isXHost(host) ? 'social_media' : 'webpage';
}

/**
 * What a job or target asks for, checked as a whole. Options that only one executor reads are
 * dropped for the other, so the stored record says what will really happen.
 */
function normalizeRequest(input) {
  const { url, host } = normalizeUrl(input.url);
  const runner = oneOf(input.runner || 'cloud', RUNNERS, '执行位置');
  const options = normalizeOptions(input.options);
  if (runner === 'browser') delete options.transport;
  if (options.transport === 'http' && (options.waitFor || options.scroll)) throw new Error('等待元素和滚动需要浏览器读取');
  if (isXHost(host) && !isXStatusUrl(url) && options.scope !== 'visible') throw new Error('X 主页需要把读取范围设为「页面上的帖子」');
  const category = text(input.category, '分类', 64) || defaultCategory(host);
  return { url, host, runner, options, category };
}

function normalizeInterval(value) {
  const minutes = value === undefined || value === null || value === '' ? 0 : integer(value, '抓取频率（分钟）', 0, MAX_INTERVAL_MINUTES);
  if (minutes !== 0 && minutes < MIN_INTERVAL_MINUTES) throw new Error(`抓取间隔不能少于 ${MIN_INTERVAL_MINUTES} 分钟`);
  return minutes;
}

/** A target as it will be saved (a create, or the record with an update applied). */
function normalizeTarget(input) {
  return {
    ...normalizeRequest(input),
    name: text(input.name, '名称', 120),
    intervalMinutes: normalizeInterval(input.intervalMinutes),
    enabled: input.enabled === true,
  };
}

/** A new or changed schedule first fires one interval from now. */
function firstRunAt(intervalMinutes, now) {
  return iso(now + intervalMinutes * MINUTE);
}

/**
 * The next slot strictly after `now` on the target's own grid. Slots missed while the scheduler
 * was away are skipped, not replayed: a crawl shows the page as it is now.
 */
function nextSlot(dueMs, intervalMinutes, now) {
  const step = intervalMinutes * MINUTE;
  const elapsed = Math.max(0, Math.floor((now - dueMs) / step) + 1);
  return { at: dueMs + elapsed * step, missed: Math.max(0, elapsed - 1) };
}

function clip(value, max) {
  return typeof value === 'string' ? value.replace(CONTROL, ' ').slice(0, max) : '';
}

function count(value, max) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(number, max) : 0;
}

function isoDate(value) {
  const time = typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? '' : new Date(time).toISOString();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function httpUrl(value) {
  const url = clip(value, MAX_URL);
  return /^https?:\/\//i.test(url) ? url : '';
}

/** Copies known fields with their limits, so a crawler cannot write anything else. */
function normalizeResult(raw) {
  const value = record(raw);
  const markdown = typeof value.markdown === 'string' ? value.markdown : '';
  if (!markdown.trim()) throw new Error('抓取结果没有正文');
  const url = httpUrl(value.url);
  if (!url) throw new Error('抓取结果地址无效');
  const items = list(value.items);
  if (items.length > MAX_ITEMS || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('抓取条目无效');
  return {
    identity: clip(value.identity, MAX_IDENTITY).trim(),
    url,
    canonicalUrl: httpUrl(value.canonicalUrl),
    host: clip(value.host, 255),
    httpStatus: count(value.httpStatus, 599),
    title: clip(value.title, 512),
    byline: clip(value.byline, 2000),
    siteName: clip(value.siteName, 2000),
    language: clip(value.language, 32),
    description: clip(value.description, 2000),
    publishedAt: isoDate(value.publishedAt),
    leadImage: httpUrl(value.leadImage),
    markdown,
    html: typeof value.html === 'string' ? value.html : '',
    wordCount: count(value.wordCount, 100000000),
    items,
    links: list(value.links),
    images: list(value.images),
    structuredData: list(value.structuredData),
    extras: record(value.extras),
    extractor: clip(value.extractor, 64),
    profile: clip(value.profile, 64),
    qualityScore: count(value.qualityScore, 100),
    warnings: list(value.warnings).filter(item => typeof item === 'string').map(item => item.slice(0, 64)).slice(0, 32),
    trace: record(value.trace),
    crawlerVersion: clip(value.crawlerVersion, 32),
  };
}

/**
 * The identity a document is stored under: the profile's own (`x:status:…`) when it names one,
 * otherwise the canonical or final URL without its fragment.
 */
function documentIdentity(result) {
  if (result.identity) return result.identity;
  return (result.canonicalUrl || result.url).replace(/#.*$/, '');
}

function isPartial(result) {
  return result.qualityScore < ACCEPTABLE_SCORE || result.warnings.includes('truncated');
}

/** A reported failure, with the server's own view of whether it retries. */
function normalizeFailure(raw) {
  const value = record(raw);
  const code = typeof value.code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, value.code) ? value.code : 'INTERNAL';
  const message = clip(value.message, 2000).trim() || '抓取失败';
  return { code, message, retryable: ERROR_CODES[code] };
}

function retryDelayMs(attempts) {
  return RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
}

module.exports = {
  ACCEPTABLE_SCORE,
  ERROR_CODES,
  MAX_ATTEMPTS,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  OPTION_KEYS,
  RUNNERS,
  defaultCategory,
  documentIdentity,
  firstRunAt,
  isLocalHost,
  isPartial,
  isXStatusUrl,
  nextSlot,
  normalizeFailure,
  normalizeOptions,
  normalizeRequest,
  normalizeResult,
  normalizeTarget,
  normalizeUrl,
  retryDelayMs,
};
