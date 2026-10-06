# Changelog

## Unreleased

- The "no read access" message now also shows the repository URL (`https://github.com/<owner>/<repo>`) next to the line to ask the repo owner to grant read access.
- Test coverage for `update` when a release renames a skill folder (old unmodified files removed, a user-edited old file kept, new files added).
- Test coverage for `update` when a release renames agent files (the payload's `sdlc-` agent namespace): old unmodified agent files removed, a user-edited old agent file kept, new agent files added.

## 0.1.0 - 2026-10-06

Initial release.

### Commands

- `install`, `update`, `uninstall`, `doctor`, `version [--check]` and `init`, with `--project`, `--root`, `--from-bundle`, `--version`, `--dry-run`, `--force`, `--yes` and `--json`.
- Exit codes: `0` success, `1` failure or cancel, `2` usage error, `130` / `143` on an external SIGINT / SIGTERM.
- `update` does a three-way comparison per managed file (recorded hash, file on disk, new bundle): unmodified files are replaced, edited files are kept and the new version is written as `<file>.new`, starter files are never overwritten.
- `doctor` is read-only and checks Node, run journal, manifest, managed files, hooks, the `CLAUDE.md` block, starter files and installed version; it reports optional Python 3 only when installed scripts need it.

### Interactive mode

- `ai-sdlc init` is a guided install: banner, environment check, filterable project list with install badges and recent projects, review step, progress bar, result panel.
- `ai-sdlc` without a command opens a menu in a terminal; `update`, `doctor` and `uninstall` print coloured result views.
- Switches itself off for `--json`, `--yes`, `--no-tui`, `TERM=dumb` and non-terminal stdin or stdout. Honours `NO_COLOR`, with an ASCII fallback. Esc or Ctrl-C writes nothing. No dependencies.

### GitHub fetch and access

- Downloads the latest (or `--version <tag>`) release of `bakit-org/ai-sdlc-kit`, verifies the `.sha256` asset and the per-file hashes, and cleans up its temporary files. `AI_SDLC_PAYLOAD_REPO` selects another repository.
- Credentials, first match wins: `AI_SDLC_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `gh auth token`, `git credential fill` (non-interactive, 8 s timeout). Only the source name is ever shown.
- Automatically found tokens are used only for `https://api.github.com`; with `AI_SDLC_GITHUB_API` set to another base only `AI_SDLC_GITHUB_TOKEN` is used. The `Authorization` header is not forwarded on redirects to other hosts.
- Plain messages for no credentials, SAML SSO, invalid token, no read access (owner contact), rate limit (reset time) and offline (suggests `--from-bundle`). Timeouts and retries with backoff on network errors and 5xx.
- `--from-bundle <file>` installs without any network access.

### Safety

- Atomic writes (temporary file plus rename), manifest written last, per-project lock and run journal with rollback; `--force` recovers an interrupted run.
- `CLAUDE.md` is managed only between `<!-- ai-sdlc:begin -->` and `<!-- ai-sdlc:end -->`; only the hook entries the CLI added are managed in `.claude/settings.json`. Uninstall restores both byte for byte.
- Strict path rules for bundle and manifest (no absolute paths, `..`, backslashes, symlinks leading outside the project), refusal of unsafe targets (home directory, filesystem root), strict JSON and UTF-8 checks before any change.
- Bundles are rejected before any write for checksum or per-file hash mismatch, unsupported `payload_schema`, or a `min_cli_version` above the CLI version.

### Known limits

- Node's `fetch` ignores `HTTPS_PROXY` / `HTTP_PROXY`; use `--from-bundle` behind such a proxy.
- Windows consoles have not been verified.
