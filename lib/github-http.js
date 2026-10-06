'use strict';
// One HTTP request against the GitHub API with timeouts, retries and manual
// redirect handling. The Authorization header goes only to the API origin: an
// asset download that redirects to a storage host is fetched without it.
const { CliError } = require('./errors');
const { isAllowedUrl } = require('./config');

const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const OFFLINE_HINT = 'check your network, or install from a local file with --from-bundle <file>';

// Sleeps, but wakes early (rejecting with the signal's reason) when the signal aborts.
function sleepMs(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    return undefined;
  });
}

class NetworkError extends Error {}

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) throw new CliError(`GitHub response is larger than the ${maxBytes} byte limit`);
  const chunks = [];
  let total = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) throw new CliError(`GitHub response is larger than the ${maxBytes} byte limit`);
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

// A single attempt, following redirects by hand.
async function attempt(startUrl, o, signal) {
  const base = new URL(o.apiBase);
  let url = new URL(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const headers = { 'User-Agent': 'ai-sdlc-cli', Accept: o.accept };
    if (url.origin === base.origin) {
      headers['X-GitHub-Api-Version'] = '2022-11-28';
      if (o.token) headers.Authorization = `Bearer ${o.token}`;
    }
    const res = await o.fetchImpl(url, { redirect: 'manual', headers, signal });
    if (!REDIRECTS.has(res.status)) return { status: res.status, headers: res.headers, body: await readCapped(res, o.maxBytes) };
    const location = res.headers.get('location');
    if (res.body) await res.body.cancel().catch(() => {});
    if (!location) throw new CliError('GitHub sent a redirect without a target');
    url = new URL(location, url);
    if (!isAllowedUrl(url, o.apiBase)) throw new CliError(`refusing to follow a redirect to an unsafe address (${url.protocol}//${url.host})`);
  }
  throw new CliError('too many redirects from GitHub');
}

function networkMessage(err, timedOut, host, timeoutMs) {
  if (timedOut) return `request to ${host} timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}; ${OFFLINE_HINT}`;
  const code = (err && err.cause && err.cause.code) || (err && err.code);
  return `cannot reach ${host}${typeof code === 'string' ? ` (${code})` : ''}; ${OFFLINE_HINT}`;
}

// Resolves { status, headers, body } for any final response (4xx included).
// Network errors, timeouts and 5xx are retried `retries` times with backoff.
async function request(url, options) {
  const o = {
    accept: 'application/vnd.github+json', fetchImpl: globalThis.fetch, timeoutMs: 20000, retries: 2, backoffMs: 400, maxBytes: 5 * 1024 * 1024,
    ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
  };
  if (typeof o.fetchImpl !== 'function') throw new CliError('this Node.js has no fetch; Node 18 or newer is required');
  const host = new URL(url).host;
  let last;
  for (let n = 0; n <= o.retries; n += 1) {
    if (n > 0) await sleepMs(o.backoffMs * 2 ** (n - 1), o.signal);
    if (o.signal && o.signal.aborted) throw o.signal.reason;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs);
    const onCancel = () => controller.abort();
    if (o.signal) o.signal.addEventListener('abort', onCancel, { once: true });
    try {
      const res = await attempt(url, o, controller.signal);
      if (res.status < 500 || n === o.retries) return res;
      last = res;
    } catch (err) {
      if (o.signal && o.signal.aborted) throw o.signal.reason;
      if (err instanceof CliError) throw err;
      last = new NetworkError(networkMessage(err, controller.signal.aborted, host, o.timeoutMs));
      if (n === o.retries) throw new CliError(last.message);
    } finally {
      clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener('abort', onCancel);
    }
  }
  return last;
}

module.exports = { request, OFFLINE_HINT };
