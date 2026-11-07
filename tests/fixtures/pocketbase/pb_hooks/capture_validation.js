// Validation for page capture, free of PocketBase globals so it can be unit tested.
//
// Jobs are written by clients and later opened in a browser signed in to real accounts. The
// extension applies the same URL rules as the last line of defence (src/shared/url-policy.ts in
// Anyworkflow-capture); rejecting here gives the user the error at the moment they submit.
const MAX_URL = 2048;
const MAX_SELECTOR = 500;
const MAX_SELECTORS = 20;
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa'];

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

function normalizeUrl(raw) {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!url) throw new Error('请填写链接');
  if (url.length > MAX_URL) throw new Error('链接过长');
  const match = /^(https?):\/\/([^/?#\s]+)([/?#]\S*)?$/i.exec(url);
  if (!match) throw new Error('只支持 http 和 https 链接');
  const authority = match[2];
  if (authority.includes('@')) throw new Error('链接不能包含账号或密码');
  const host = authority.replace(/:\d*$/, '').toLowerCase();
  if (!host || isLocalHost(host)) throw new Error('不能采集本机或内网地址');
  return { url, host };
}

function selector(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_SELECTOR) throw new Error(`${label}无效`);
  return value.trim();
}

function normalizeOptions(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('采集选项无效');
  const allowed = ['waitFor', 'contentSelector', 'removeSelectors', 'scroll', 'keepHtml', 'timeoutSeconds', 'generic'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) throw new Error('采集选项包含未知参数');
  const options = {};
  if (raw.waitFor !== undefined) options.waitFor = selector(raw.waitFor, '等待元素');
  if (raw.contentSelector !== undefined) options.contentSelector = selector(raw.contentSelector, '正文选择器');
  if (raw.removeSelectors !== undefined) {
    if (!Array.isArray(raw.removeSelectors) || raw.removeSelectors.length > MAX_SELECTORS) throw new Error('移除元素无效');
    options.removeSelectors = raw.removeSelectors.map(value => selector(value, '移除元素'));
  }
  for (const key of ['scroll', 'keepHtml', 'generic']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') throw new Error('采集选项无效');
    options[key] = raw[key];
  }
  if (raw.timeoutSeconds !== undefined) {
    if (!Number.isInteger(raw.timeoutSeconds) || raw.timeoutSeconds < 10 || raw.timeoutSeconds > 280) throw new Error('超时时间应为 10–280 秒');
    options.timeoutSeconds = raw.timeoutSeconds;
  }
  return options;
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
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

/** Copies known fields with their limits, so a client cannot write anything else into a result. */
function normalizeResult(raw) {
  const value = record(raw);
  const markdown = typeof value.markdown === 'string' ? value.markdown : '';
  if (!markdown.trim()) throw new Error('采集结果没有正文');
  if (!/^https?:\/\//i.test(text(value.url, MAX_URL))) throw new Error('采集结果地址无效');
  if (value.contentHash !== undefined && !/^[a-f0-9]{64}$/.test(String(value.contentHash))) throw new Error('内容校验值无效');
  return {
    url: text(value.url, MAX_URL),
    canonicalUrl: text(value.canonicalUrl, MAX_URL),
    host: text(value.host, 255),
    httpStatus: count(value.httpStatus, 599),
    title: text(value.title, 512),
    byline: text(value.byline, 2000),
    siteName: text(value.siteName, 2000),
    language: text(value.language, 32),
    description: text(value.description, 2000),
    publishedAt: isoDate(value.publishedAt),
    leadImage: text(value.leadImage, MAX_URL),
    markdown,
    html: typeof value.html === 'string' ? value.html : '',
    contentHash: text(value.contentHash, 64),
    wordCount: count(value.wordCount, 100000000),
    links: list(value.links),
    images: list(value.images),
    structuredData: list(value.structuredData),
    extras: record(value.extras),
    extractor: text(value.extractor, 64),
    profile: text(value.profile, 64),
    qualityScore: count(value.qualityScore, 100),
    warnings: list(value.warnings).filter(item => typeof item === 'string').slice(0, 32),
    trace: record(value.trace),
    extensionVersion: text(value.extensionVersion, 32),
  };
}

module.exports = { isLocalHost, normalizeUrl, normalizeOptions, normalizeResult };
