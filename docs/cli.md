# CLI reference

## Global behaviour

- Options: `--project <path>`, `--root <dir>`, `--from-bundle <file>`, `--version <tag>` (install/update), `--check` (version), `--dry-run`, `--force`, `--yes` (`-y`), `--json`, `--no-tui`.
- Exit codes: `0` ok, `1` failure or a cancelled interactive screen, `2` usage error (unknown option, missing value, invalid target, missing `--project` / `--yes` without a terminal, `--version` that is not a release version or is combined with `--from-bundle`). Access and network failures of a download (no credentials, rejected token, no read access, rate limit, offline) exit `1`.
- `--json` prints one JSON document on stdout and never prompts; it therefore needs `--project`, and `--yes` for runs that write.
- Target rules: the directory must exist, must not be your home directory or a filesystem root. A directory without `.git` is accepted with a warning.

- `init` is `install` with a guided wizard when stdin and stdout are terminals and none of `--yes`, `--json`, `--no-tui`, `--dry-run` or `TERM=dumb` applies; in every other case it behaves exactly like `install`. Without a command, a terminal gets a menu (usage text and exit `2` otherwise). `update`, `doctor` and `uninstall` print coloured result views on a terminal. `--no-tui` always gives the plain text. See [tui.md](tui.md).
- Cancelling an interactive screen with Esc or Ctrl-C changes nothing and exits `1`. A `SIGINT` or `SIGTERM` that arrives from outside restores the terminal and exits `130` or `143`.

## Choosing the project

1. `--project <path>` wins.
2. Otherwise, in a terminal: a numbered list of directories that contain `.git`, found one level under `--root` (default: the current directory, then its parent; the scanned directory itself is listed when it is a repository), plus `p` to type a path and `q` to cancel.
3. The plan is printed, then `Apply these changes? [y/N]` unless `--yes` or `--dry-run`.

## Where the bundle comes from

- `--from-bundle <file>`: a local bundle, no network.
- Otherwise `install` and `update` (and the `init` wizard) download it from the payload repository's GitHub release: `bakit-org/ai-sdlc-kit` by default; `AI_SDLC_PAYLOAD_REPO=<owner>/<repo>` points at another repository.
- `--version <tag>` pins a release (`1.2.0` and `v1.2.0` both work); without it the latest published release is used.

Steps: find credentials, check read access to the repository, look up the release, download `ai-sdlc-<version>.bundle.json` and its `.sha256` through the API (`Accept: application/octet-stream`) into a private temporary directory (mode `0600`), verify the checksum and the per-file hashes with the same checks as a local bundle, install, and delete the temporary files. A release without a checksum asset is refused.

Credentials, first match wins: environment `AI_SDLC_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`; the GitHub CLI (`gh auth token`, when `gh` is on the PATH); `git credential fill` for `github.com` (run with `core.askPass` and `credential.interactive` off and `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_TERMINAL_PROMPT` disabled, so no prompt or askpass dialog can appear; times out after 8 s). Only the name of the source is ever shown.

**Custom API base.** Tokens found on the machine (`GH_TOKEN`, `GITHUB_TOKEN`, `gh`, the git credential helper) belong to github.com and are used only when the API base is exactly `https://api.github.com`. With `AI_SDLC_GITHUB_API` set to anything else (GitHub Enterprise, a mirror, a local test server) only an explicit `AI_SDLC_GITHUB_TOKEN` is used, and neither `gh` nor `git` is started. The wizard shows the non-default base next to the kit source. The token is sent only to the API origin: when an asset download redirects to another host (GitHub's storage), the `Authorization` header is not forwarded. Only `https` is used (plain `http` only for a `localhost` API override). Requests time out after 20 s and are retried twice with backoff on network errors and 5xx.

| Situation | Message / exit |
|---|---|
| no credentials | lists the env vars, `gh auth login` and the git credential helper; exit `1` |
| 403 with an SSO header | the organization uses SAML SSO: authorize the token for it; exit `1` |
| 401 | token invalid or expired (names the source, not the value); exit `1` |
| 403 / 404 on the repository | `no read access to <owner>/<repo> — ask the repo owner to grant read access`; exit `1` |
| rate limit (403/429) | shows the reset time (or the retry delay); exit `1` |
| offline, DNS, timeout | suggests `--from-bundle <file>`; exit `1` |
| release without bundle or checksum asset | names what is missing; exit `1` |

`ai-sdlc version --check` runs the access check and the release lookup (no download) and prints the latest payload version; with `--project <path>` (or an installed project in the current directory) it also compares the installed version. `--json` gives `{ version, repo, latest, installed, status }`.

Integrity: the `.sha256` asset comes from the same release as the bundle, so the check detects corruption or a partial download, not tampering by someone who can edit the release. The CLI also refuses a bundle whose payload version differs from its release tag. Redirect targets that carry a user name or password, or that are not https, are refused.

Proxies: Node's built-in `fetch` ignores `HTTPS_PROXY` / `HTTP_PROXY`. Where GitHub is reachable only through a proxy, get the bundle another way and use `--from-bundle <file>`.

Cancelling: in the guided install, Ctrl-C or Esc during the environment check or the download stops the in-flight request, removes the temporary files and ends with exit `1` (nothing written). In plain runs, `SIGINT` / `SIGTERM` during a download delete the temporary directory first and exit `130` / `143`.

Flag checks happen first, before any network access: `--version` only applies to `install`, `update` and `init`, cannot be combined with `--from-bundle` and must look like `1.2.0` or `v1.2.0`; `--check` only applies to `version`. Violations exit `2`.

Environment overrides meant for tests: `AI_SDLC_GITHUB_API` (API base URL).

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

## Code map for the download

`lib/release-source.js` exports `resolveBundle(opts, { fetchLatestBundle })` (resolving to `{ bundlePath }` or `{ bundleObject }`, plus an optional `cleanup()`) and `loadReleaseBundle`, which loads, verifies and then cleans up. `lib/github-release.js` is the default `fetchLatestBundle`; `github-auth.js` finds the token, `github-http.js` does timeouts, retries and redirects, `github-errors.js` maps responses to messages, `config.js` holds the repository and API settings.

## Note on the manifest

`.claude/ai-sdlc.manifest.json` may contain a copy of the original `.claude/settings.json` text (base64) taken before hooks were merged in. Treat the manifest as local state: do not publish it or commit it to a public repository if your settings contain anything private.
