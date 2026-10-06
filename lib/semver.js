'use strict';

// Only plain major.minor.patch ordering is needed; pre-release tags are ignored.
function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Returns -1, 0 or 1; null when either side is not a version.
function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// Strict semantic version text (no stray characters), used for versions that are shown to the user.
const STRICT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const isStrict = (v) => typeof v === 'string' && v.length <= 64 && STRICT.test(v);

// A release version as typed by a user: 1.2.0 or v1.2.0 (optionally with a pre-release / build suffix).
const isReleaseTag = (v) => typeof v === 'string' && v.length <= 64 && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(v);

module.exports = { parse, compare, isStrict, isReleaseTag };
