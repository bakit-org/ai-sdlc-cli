# CLI reference

## Global behaviour

- Options: `--project <path>`, `--root <dir>`, `--from-bundle <file>`, `--dry-run`, `--force`, `--yes` (`-y`), `--json`.
- Exit codes: `0` ok, `1` failure, `2` usage error (unknown option, missing value, invalid target, missing `--project` / `--yes` without a terminal, download requested but not available).
- `--json` prints one JSON document on stdout and never prompts; it therefore needs `--project`, and `--yes` for runs that write.
- Target rules: the directory must exist, must not be your home directory or a filesystem root. A directory without `.git` is accepted with a warning.

## Choosing the project

1. `--project <path>` wins.
2. Otherwise, in a terminal: a numbered list of directories that contain `.git`, found one level under `--root` (default: the current directory, then its parent; the scanned directory itself is listed when it is a repository), plus `p` to type a path and `q` to cancel.
3. The plan is printed, then `Apply these changes? [y/N]` unless `--yes` or `--dry-run`.

## install

Verifies the bundle, then plans and applies. Refuses when a manifest already exists (use `update`, or `--force` to reinstall). A file already present at a managed path with different content is kept and the bundle's version is written beside it as `<file>.new`; `--force` overwrites instead.

## update

Three-way comparison per managed file: hash recorded at install, file on disk, file in the new bundle.

| Disk vs recorded | Bundle | Result |
|---|---|---|
| unchanged | changed | replaced |
| unchanged | same | nothing |
| edited | changed | kept, `<file>.new` written |
| edited | same | kept |
| missing | present | restored |
| unchanged | no longer shipped | deleted |
| edited | no longer shipped | kept, no longer tracked |
| not tracked | new in bundle | added (kept + `.new` if a different file is in the way) |

Starter files (`user-once`) are created only when they are new in the bundle. A starter file the previous install tracked and you have since deleted is not re-created by `update` (it is listed as `skip-deleted`; `doctor` still warns that it is missing). `install --force` does create it again. Existing starter files are never overwritten.

The `CLAUDE.md` block and the recorded hooks are re-rendered. A hook that is already registered identically stays where it is, so `settings.json` is not rewritten or reordered for it.

## doctor

Read-only. Reports Node version, a leftover run journal (even when the manifest is missing), manifest validity, managed files (modified = warning, missing = failure), registered hooks and hook scripts, the `CLAUDE.md` block, starter files, installed version (compared with `--from-bundle` when given), and a note about optional Python 3 only when installed scripts need it. A check that cannot run (symlink, permissions, bad encoding) is reported as a failed check rather than aborting the report, in `--json` too. Exit `1` if any check fails.

## uninstall

Deletes managed files that still match the manifest (never starter files), removes the exact hook entries and the block the CLI added, deletes files the CLI itself created if they are empty again (`CLAUDE.md`, `settings.json`), removes directories it emptied, and finally removes the manifest. Edited managed files, `<file>.new` leftovers and starter files stay.

## Bundle format

One JSON file: `{ manifest, contents }`.

- `manifest`: `version`, `payload_schema` (must be `1`), `min_cli_version`, `files[]` (`path`, `sha256`, `class`, `encoding`), optional `hooks[]` (`event`, optional `matcher`, `command`).
- `contents[path]`: file text (`utf8`) or base64 string; `sha256` is over the raw bytes.
- Classes: `managed` (under `.claude/`), `block` (`CLAUDE.md`, body without markers), `user-once`.
- Hook commands may contain `$CLAUDE_PROJECT_DIR`; it is written as is, not expanded.
- Optional `<bundle>.sha256` sidecar (`<hex>  <name>`): verified when present; when absent a warning is printed and listed under `warnings` in `--json` output.

Rejected before any write: a block body that contains the begin/end markers, checksum mismatch, per-file hash mismatch, `payload_schema` other than `1`, `min_cli_version` above the CLI version, unsafe paths (absolute, `..`, backslash, empty segment), managed files outside `.claude/`, a `CLAUDE.md` that is not a block, entries in `contents` the manifest does not list.

## Safety guarantees

- Every write is a temporary file plus rename, and an existing file keeps its permission bits. The manifest is written last.
- Each real (non `--dry-run`) run takes a per-project lock by creating `.claude/ai-sdlc.journal.json` exclusively, before planning. A second run fails with "another ai-sdlc run is in progress". Just before applying, the journal records the previous content of every path the run will touch. A failure inside the process rolls all of them back.
- If the process is killed, the journal stays. `doctor` reports it, and the next `install` / `update` / `uninstall` refuses until you pass `--force`, which first rolls the interrupted run back from the journal (CLAUDE.md, settings.json, payload files and manifest return to their earlier state) and then proceeds. A journal owned by a still-running process is never recovered, not even with `--force`.
- Paths are resolved against the real project path; a symlink that leads outside it is refused. A symlinked `CLAUDE.md` or `settings.json` is refused too (replace it with a regular file, or run against the directory holding the real file). A `.claude` directory that is a symlink inside the project works and is never removed.
- The same path rules apply to the bundle and to the installed manifest before anything is deleted: no absolute paths, `..`, backslashes, nothing under `.git/`, managed files only under `.claude/`, and `.claude/settings.json`, `.claude/settings.local.json`, the manifest and the journal are reserved.
- `CLAUDE.md` and `settings.json` must be valid UTF-8; otherwise the run stops before changing anything.
- `settings.json` is parsed strictly; invalid JSON or an unexpected shape aborts before any file changes. Existing indentation and line endings are kept. The original text is recorded in the manifest so uninstall can restore it exactly (see the note below).
- `CLAUDE.md` insertion records the exact separator it added, so removal restores the original bytes (including a missing final newline or CRLF endings).

## Plugging in release download

`lib/release-source.js` exports `resolveBundle(opts, { fetchLatestBundle })`, resolving to `{ bundlePath }` or `{ bundleObject }`. `fetchLatestBundle` is the extension point for fetching a release.

## Note on the manifest

`.claude/ai-sdlc.manifest.json` may contain a copy of the original `.claude/settings.json` text (base64) taken before hooks were merged in. Treat the manifest as local state: do not publish it or commit it to a public repository if your settings contain anything private.
