'use strict';
// Finds a GitHub token from the user's existing credentials. The token value is
// only ever held in memory and sent as a request header: it is never printed,
// logged or stored, and `redact` scrubs it from any text that might carry it.
const { spawn } = require('child_process');

const ENV_SOURCES = ['AI_SDLC_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
const COMMAND_TIMEOUT_MS = 8000;
const MAX_OUTPUT = 16 * 1024;
const MAX_TOKEN = 1024;

// A header-safe token: printable ASCII without spaces (rules out header injection).
const plausible = (t) => typeof t === 'string' && t.length > 0 && t.length <= MAX_TOKEN && /^[\x21-\x7e]+$/.test(t);

// Runs a command without a shell. Never rejects: failure, timeout, abort and a
// missing program all resolve with code null. { input, env, timeoutMs, signal } are optional.
function runCommand(cmd, args, { input, env, timeoutMs = COMMAND_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let child;
    const stop = () => {
      if (child) child.kill();
      done(null);
    };
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', stop);
      resolve({ code, stdout: out });
    };
    const timer = setTimeout(stop, timeoutMs);
    if (signal) {
      if (signal.aborted) return done(null);
      signal.addEventListener('abort', stop, { once: true });
    }
    try {
      child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return done(null);
    }
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
    child.stdout.on('data', (c) => {
      if (out.length < MAX_OUTPUT) out += c;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
    return undefined;
  });
}

const fromEnv = (env) => {
  for (const name of ENV_SOURCES) {
    const value = (env[name] || '').trim();
    if (plausible(value)) return { token: value, source: name };
  }
  return null;
};

async function fromGh(env, run, signal) {
  const r = await run('gh', ['auth', 'token', '--hostname', 'github.com'], { env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, signal });
  const token = r && r.code === 0 ? String(r.stdout || '').trim() : '';
  return plausible(token) ? { token, source: 'gh auth login' } : null;
}

// Neither the terminal nor any askpass program (GIT_ASKPASS, core.askPass, SSH_ASKPASS) may be
// started: the lookup has to stay silent.
const GIT_ARGS = ['-c', 'core.askPass=', '-c', 'credential.interactive=false', 'credential', 'fill'];

async function fromGitCredential(env, run, signal) {
  const r = await run('git', GIT_ARGS, {
    input: 'protocol=https\nhost=github.com\n\n',
    env: { ...env, GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    signal,
  });
  if (!r || r.code !== 0) return null;
  const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('password='));
  const token = line ? line.slice('password='.length).trim() : '';
  return plausible(token) ? { token, source: 'git credential helper' } : null;
}

// Order: env vars, `gh auth token`, `git credential fill`. Resolves { token, source } or null.
// With `explicitOnly` (a non-default API base) only AI_SDLC_GITHUB_TOKEN counts, so credentials
// that belong to github.com are never offered to another host. An aborted signal rejects with its reason.
async function resolveToken({ env = process.env, runCommand: run = runCommand, signal, explicitOnly = false } = {}) {
  const stopIfAborted = () => {
    if (signal && signal.aborted) throw signal.reason;
  };
  if (explicitOnly) {
    const value = (env.AI_SDLC_GITHUB_TOKEN || '').trim();
    return plausible(value) ? { token: value, source: 'AI_SDLC_GITHUB_TOKEN' } : null;
  }
  const found = fromEnv(env) || (await fromGh(env, run, signal)) || (stopIfAborted(), await fromGitCredential(env, run, signal));
  stopIfAborted();
  return found;
}

const NO_TOKEN_MESSAGE = 'no GitHub credentials found: set AI_SDLC_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN, run `gh auth login`, '
  + 'or configure a git credential helper for github.com (or install from a local file with --from-bundle <file>)';

const customBaseMessage = (base) => `no credentials for the API at ${base}: set AI_SDLC_GITHUB_TOKEN `
  + '(tokens from GH_TOKEN, GITHUB_TOKEN, `gh` or git credential helpers are only used for https://api.github.com), or use --from-bundle <file>';

// Removes every occurrence of the token from text (and its URL-encoded form).
function redact(text, token) {
  let s = String(text);
  if (token) {
    for (const form of [token, encodeURIComponent(token)]) s = s.split(form).join('[redacted]');
  }
  return s;
}

module.exports = { resolveToken, redact, runCommand, NO_TOKEN_MESSAGE, customBaseMessage, ENV_SOURCES };
