# ai-sdlc-cli

Command-line installer for the ai-sdlc Claude Code harness. It puts the BA / Dev / Test agents, skills and hooks into a project repository of your choice, keeps them up to date without overwriting your edits, and removes them cleanly.

- Prerequisites: Node 18 or newer, and read access to the GitHub repository that publishes the kit (`bakit-org/ai-sdlc-kit`; ask its owner if you do not have it). No runtime dependencies.
- GitHub credentials come from what you already use, first match wins: the `AI_SDLC_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN` environment variable, then `gh auth login` (the GitHub CLI), then your git credential helper for `github.com`. The token is only sent to GitHub's API and is never printed or stored. Tokens found automatically (`GH_TOKEN`, `GITHUB_TOKEN`, `gh`, git credential helper) are only used for the public API at `https://api.github.com`; if `AI_SDLC_GITHUB_API` points anywhere else (for example GitHub Enterprise) only an explicit `AI_SDLC_GITHUB_TOKEN` is used. For a repository behind SAML SSO, authorize the token for the organization.
- Downloads use Node's built-in `fetch`, which does not honour `HTTPS_PROXY` / `HTTP_PROXY`. Behind a proxy that GitHub is only reachable through, download the release bundle by other means and use `--from-bundle <file>`.
- Everything is scoped to the project you pick. Nothing is written to `~/.claude`.
- Works for both the Claude Code CLI and the VS Code extension (they share `.claude/`, `CLAUDE.md` and `.claude/settings.json`).

## Commands

```
ai-sdlc init      [--project <path>] [--root <dir>] [--from-bundle <file> | --version <tag>] [--force] [--no-tui]
ai-sdlc install   [--project <path>] [--root <dir>] [--from-bundle <file> | --version <tag>] [--dry-run] [--force] [--yes] [--json]
ai-sdlc update    [--project <path>] [--root <dir>] [--from-bundle <file> | --version <tag>] [--dry-run] [--force] [--yes] [--json]
ai-sdlc doctor    [--project <path>] [--from-bundle <file>] [--json]
ai-sdlc uninstall [--project <path>] [--dry-run] [--yes] [--json]
ai-sdlc version   [--check] [--project <path>] [--json]
ai-sdlc                  # in a terminal: menu (Install / Update / Doctor / Uninstall / Quit)
```

Exit codes: `0` success, `1` the operation failed or you cancelled (Esc / Ctrl-C), `2` wrong usage. If the process is stopped from outside, the terminal is restored first and the exit code is `130` (SIGINT) or `143` (SIGTERM).

Without `--from-bundle`, `install` and `update` download the latest release of the payload repository (or the one named by `--version <tag>`, for example `--version 1.2.0`), check its `.sha256` and the per-file hashes, and install it. With `--from-bundle <file>` they use a local release bundle instead (the `<file>.sha256` beside it is verified when present) and never touch the network. `ai-sdlc version --check` shows the latest release and, for the current or `--project` directory, whether the installed payload is behind it.

Failures are plain messages: an invalid or expired token, a repository you cannot read (ask the repo owner to grant read access), a GitHub rate limit (with the reset time), or no network (use `--from-bundle`).

## Quick start

```sh
npm install -g ai-sdlc-cli        # once the package is published
gh auth login                     # or export GH_TOKEN=... (needs read access to the kit repository)
ai-sdlc install                   # downloads the latest kit release
ai-sdlc install --from-bundle ./ai-sdlc-0.1.0.bundle.json   # or install from a local bundle
```

Without `--project` the CLI lists the git repositories directly under the current directory (and its parent), or under `--root`, plus an "enter a path" option. It shows the full plan and asks before writing. In scripts and CI pass `--project <path> --yes`; without a terminal the CLI refuses to guess and exits with `2`.

Use `--dry-run` first to see exactly what a run would do. A real run performs the same list.

## Interactive mode

In a terminal, `ai-sdlc init` is a guided install: a gradient banner, an environment check, a filterable project list (git repositories next to you plus recent projects, with `installed` / `not installed` / `no .git` badges), a review of what will change, a progress bar and a result panel with next steps. Running `ai-sdlc` with no command opens a menu, and `update`, `doctor` and `uninstall` print coloured result views. Esc or Ctrl-C at any step writes nothing and restores the terminal.

It switches itself off for `--json`, `--yes`, `--no-tui`, `TERM=dumb` and whenever stdin or stdout is not a terminal; then the plain output and exit codes apply. Colours follow `NO_COLOR` and the terminal's capability, with an ASCII fallback. Details and key bindings: [docs/tui.md](docs/tui.md).

## What gets installed

| Path | Behaviour |
|---|---|
| `.claude/agents`, `.claude/skills`, `.claude/hooks`, ... | Managed: replaced on `update` only while still identical to what was installed. A file you edited is kept and the new version is written next to it as `<file>.new`. |
| `CLAUDE.md` | Only the block between `<!-- ai-sdlc:begin -->` and `<!-- ai-sdlc:end -->` is managed. The rest of the file is never touched. |
| `.claude/settings.json` | Only the hook entries the CLI added are managed. Invalid JSON aborts the run untouched. |
| Starter files (project notes, design folder, ...) | Created if absent, never overwritten, never removed. |
| `.claude/ai-sdlc.manifest.json` | Records what was installed; written last. |

`uninstall` removes unmodified managed files, the block and the hooks it added, and gives `CLAUDE.md` and `settings.json` back byte-for-byte as they were before install. Files you modified and all starter files stay.

Note: `.claude/ai-sdlc.manifest.json` may hold a copy of your original `.claude/settings.json` text so uninstall can restore it exactly. Do not publish it.

See [docs/cli.md](docs/cli.md) for the details (update rules, doctor checks, bundle format, safety guarantees).

## Development

```sh
npm test            # node:test, no dependencies
npm pack --dry-run  # shows the published file list
```
