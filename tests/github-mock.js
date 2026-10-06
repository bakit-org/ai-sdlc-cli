'use strict';
// A local stand-in for the GitHub API plus a separate "asset host" on another port
// (a different origin, like the storage host a real asset download redirects to).
const http = require('http');
const { makeBundle, tmpDir, sha } = require('./helpers');

const REPO = 'acme/kit';
// Not a real credential; the tests assert it never shows up anywhere.
const CANARY = 'ghp_CANARY0123456789abcdefghijklmnopqrstuv';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
});

// bundles: { '1.0.0': bundleObject }. Returns { env, log, hooks, close, ... }.
async function startMock({ bundles = { '1.0.0': makeBundle() }, token = CANARY, repo = REPO } = {}) {
  const log = [];
  const hooks = []; // (req, res, mock) => true when a test handles the request itself
  const files = {}; // asset id -> { name, body }
  const releases = {}; // tag -> release json
  let nextId = 10;
  const assetHost = http.createServer((req, res) => {
    log.push({ host: 'assets', url: req.url, auth: req.headers.authorization });
    const id = /^\/blob\/(\d+)/.exec(req.url);
    const f = id && files[id[1]];
    if (!f) return res.writeHead(404).end();
    return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(f.body);
  });
  const api = http.createServer((req, res) => {
    log.push({ host: 'api', url: req.url, auth: req.headers.authorization, accept: req.headers.accept });
    const json = (code, obj, extra = {}) => res.writeHead(code, { 'content-type': 'application/json', ...extra }).end(JSON.stringify(obj));
    if (hooks.some((h) => h(req, res, mock))) return undefined;
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { message: 'Bad credentials' });
    if (req.url === `/repos/${repo}`) return json(200, { full_name: repo });
    if (req.url === `/repos/${repo}/releases/latest`) return json(200, releases[mock.latest]);
    const tag = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/(.+)$/.exec(req.url);
    if (tag) return releases[decodeURIComponent(tag[1])] ? json(200, releases[decodeURIComponent(tag[1])]) : json(404, { message: 'Not Found' });
    const asset = /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/.exec(req.url);
    if (asset && files[asset[1]]) {
      if (req.headers.accept !== 'application/octet-stream') return json(415, { message: 'wrong accept' });
      if (mock.direct) return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(files[asset[1]].body);
      return res.writeHead(302, { location: `${mock.assetUrl}/blob/${asset[1]}?sig=signed` }).end();
    }
    return json(404, { message: 'Not Found' });
  });
  const mock = { log, hooks, files, releases, latest: null, token, repo, direct: false };
  mock.apiUrl = await listen(api);
  mock.assetUrl = await listen(assetHost);
  mock.close = () => Promise.all([close(api), close(assetHost)]);
  mock.publish = (version, bundle, { tag = `v${version}`, sidecar = true, latest = true } = {}) => {
    const json = `${JSON.stringify(bundle)}\n`;
    const name = `ai-sdlc-${version}.bundle.json`;
    const add = (n, body) => {
      nextId += 1;
      files[nextId] = { name: n, body };
      return { id: nextId, name: n };
    };
    const assets = [add(name, json)];
    if (sidecar) assets.push(add(`${name}.sha256`, `${sha(Buffer.from(json))}  ${name}\n`));
    releases[tag] = { tag_name: tag, assets };
    if (latest) mock.latest = tag;
  };
  for (const [v, b] of Object.entries(bundles)) mock.publish(v, b);
  // Options for lib/commands.run() through tests/helpers.runCli.
  mock.inject = ({ env = {}, tmp = tmpDir(), runCommand, release = {} } = {}) => ({
    env: { AI_SDLC_PAYLOAD_REPO: repo, AI_SDLC_GITHUB_API: mock.apiUrl, AI_SDLC_GITHUB_TOKEN: token, ...env },
    runCommand: runCommand || (async () => ({ code: null, stdout: '' })),
    releaseOptions: { timeoutMs: 1500, backoffMs: 1, tmpDir: tmp, ...release },
    tmp,
  });
  // Options that talk to this mock while the CLI believes it uses the public GitHub API (default base):
  // requests for https://api.github.com are redirected to the mock and assets are streamed by the API itself.
  mock.asPublicApi = ({ env = {}, tmp = tmpDir(), runCommand, release = {} } = {}) => {
    mock.direct = true;
    return {
      env: { AI_SDLC_PAYLOAD_REPO: repo, ...env },
      runCommand: runCommand || (async () => ({ code: null, stdout: '' })),
      fetch: (url, init) => globalThis.fetch(String(url).replace('https://api.github.com', mock.apiUrl), init),
      releaseOptions: { timeoutMs: 1500, backoffMs: 1, tmpDir: tmp, ...release },
      tmp,
    };
  };
  return mock;
}

module.exports = { startMock, REPO, CANARY };
