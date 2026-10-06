'use strict';
const { UsageError } = require('./errors');

// Where the release bundles live. Overridable per process for tests and mirrors.
const DEFAULT_PAYLOAD_REPO = 'bakit-org/ai-sdlc-kit';
const DEFAULT_API_BASE = 'https://api.github.com';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function payloadRepo(env = process.env) {
  const repo = (env.AI_SDLC_PAYLOAD_REPO || '').trim() || DEFAULT_PAYLOAD_REPO;
  if (!REPO_RE.test(repo) || repo.includes('..')) throw new UsageError('AI_SDLC_PAYLOAD_REPO must look like <owner>/<repo>');
  return repo;
}

// The API base must be https; plain http is allowed only for a loopback host (local test servers).
function apiBase(env = process.env) {
  const raw = (env.AI_SDLC_GITHUB_API || '').trim() || DEFAULT_API_BASE;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError('AI_SDLC_GITHUB_API is not a valid URL');
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!secure || url.username || url.password) throw new UsageError('AI_SDLC_GITHUB_API must be an https URL (http only for localhost)');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

// Whether a URL may be fetched given the configured API base (https, or loopback http when the base itself is loopback).
function isAllowedUrl(url, base) {
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname) && new URL(base).protocol === 'http:';
}

// Tokens found on the machine (gh, git credential helper, GH_TOKEN, GITHUB_TOKEN) belong to github.com
// and are only used against the public API; any other base needs an explicit AI_SDLC_GITHUB_TOKEN.
const isDefaultApiBase = (base) => base === DEFAULT_API_BASE;

module.exports = { DEFAULT_PAYLOAD_REPO, DEFAULT_API_BASE, payloadRepo, apiBase, isAllowedUrl, isDefaultApiBase };
