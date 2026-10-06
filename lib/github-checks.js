'use strict';
// Preflight checks for installing from the payload repository: which credential
// source is available (never its value) and whether the repository is readable.
// Each check is an async () => item | null, as the wizard's `extraChecks` expects.

function githubChecks(client) {
  let info = null;
  const describe = async (signal) => {
    info = info || (await client.describe({ signal }));
    return info;
  };

  const tokenCheck = async ({ signal } = {}) => {
    const { source, defaultBase, base } = await describe(signal);
    if (source) return { id: 'github-token', status: 'ok', label: 'GitHub token', detail: `found via ${source}`, segment: 'github token' };
    return {
      id: 'github-token', status: 'fail', label: 'GitHub token',
      detail: defaultBase
        ? 'not found: set AI_SDLC_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN, run `gh auth login`, or configure a git credential helper; or pass --from-bundle <file>'
        : `not found: ${base} needs AI_SDLC_GITHUB_TOKEN (other tokens are only used for the public GitHub API); or pass --from-bundle <file>`,
      segment: 'github token: missing',
    };
  };

  const accessCheck = async ({ signal } = {}) => {
    const { repo, source } = await describe(signal);
    if (!source) return null;
    try {
      await client.checkAccess({ signal });
      return { id: 'github-access', status: 'ok', label: `Access to ${repo}`, detail: 'read access confirmed', segment: 'repo access' };
    } catch (err) {
      if (signal && signal.aborted) throw signal.reason;
      const hint = err.message.includes('--from-bundle') ? '' : '; or pass --from-bundle <file> to use a local bundle';
      return {
        id: 'github-access', status: 'fail', label: `Access to ${repo}`, detail: `${err.message}${hint}`, segment: 'repo access: failed',
      };
    }
  };

  return [tokenCheck, accessCheck];
}

module.exports = { githubChecks };
