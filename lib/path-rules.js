'use strict';

const MANIFEST_REL = '.claude/ai-sdlc.manifest.json';
const JOURNAL_REL = '.claude/ai-sdlc.journal.json';

// Paths the installer owns or that belong to the user's own tooling.
const RESERVED = new Set([MANIFEST_REL, JOURNAL_REL, '.claude/settings.json', '.claude/settings.local.json']);

// Class/location rules shared by freshly downloaded bundles and by the manifest
// of an earlier install (which is just as untrusted before something is deleted
// on its say-so). Returns a reason string, or null when the path is acceptable.
// Syntax checks (absolute, "..", backslash) live in fs-safe.assertRelPath.
function installPathProblem(rel, cls) {
  const lower = rel.toLowerCase();
  if (lower.split('/').includes('.git')) return 'paths inside .git are not allowed';
  if (RESERVED.has(lower)) return 'reserved for the installer or the user';
  if (cls === 'block') return lower === 'claude.md' ? null : 'only CLAUDE.md may use class "block"';
  if (lower === 'claude.md') return 'CLAUDE.md must use class "block"';
  if (cls === 'managed' && !rel.startsWith('.claude/')) return 'managed files must live under .claude/';
  return null;
}

module.exports = { MANIFEST_REL, JOURNAL_REL, RESERVED, installPathProblem };
