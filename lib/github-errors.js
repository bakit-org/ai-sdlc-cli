'use strict';
// Turns a non-success GitHub response into a CliError with an actionable message.
// Response bodies are never echoed: they are not needed and could carry request details.
const { CliError } = require('./errors');
const { OFFLINE_HINT } = require('./github-http');

const header = (res, name) => (res.headers && res.headers.get(name)) || '';

function resetText(res) {
  const epoch = Number(header(res, 'x-ratelimit-reset'));
  if (Number.isFinite(epoch) && epoch > 0) return `resets at ${new Date(epoch * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  const wait = Number(header(res, 'retry-after'));
  if (Number.isFinite(wait) && wait > 0) return `try again in ${Math.ceil(wait)}s`;
  return 'try again later';
}

const isRateLimited = (res) => res.status === 429 || (res.status === 403 && (header(res, 'x-ratelimit-remaining') === '0' || header(res, 'retry-after') !== ''));

function failureFor(res, { repo, source, notFound }) {
  if (res.status === 401) {
    return new CliError(`GitHub rejected the token from ${source} (invalid or expired); renew it, or run \`gh auth login\` and try again`);
  }
  if (res.status === 403 && header(res, 'x-github-sso')) {
    return new CliError(`${repo} sits behind SAML single sign-on: authorize the token for the organization (GitHub: Settings > Developer settings > Personal access tokens > Configure SSO), then try again`);
  }
  if (isRateLimited(res)) return new CliError(`GitHub rate limit reached; ${resetText(res)}. Use --from-bundle <file> to install without GitHub`);
  if (res.status === 404 && notFound) {
    const err = new CliError(notFound);
    err.kind = 'not-found';
    return err;
  }
  if (res.status === 403 || res.status === 404) {
    return new CliError(`no read access to ${repo} — ask the repo owner to grant read access (or install from a local file with --from-bundle <file>)`);
  }
  if (res.status >= 500) return new CliError(`GitHub is unavailable (HTTP ${res.status}); try again later. ${OFFLINE_HINT}`);
  return new CliError(`unexpected response from GitHub (HTTP ${res.status})`);
}

module.exports = { failureFor };
