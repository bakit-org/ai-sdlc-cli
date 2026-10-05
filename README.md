# ai-sdlc-cli

Command-line installer for the ai-sdlc Claude Code harness. It puts the BA / Dev / Test agents, skills and hooks into a project repository of your choice, keeps them up to date without overwriting your edits, and removes them cleanly.

- Node 18 or newer is the only requirement. No runtime dependencies.
- Everything is scoped to the project you pick. Nothing is written to `~/.claude`.
- Works for both the Claude Code CLI and the VS Code extension (they share `.claude/`, `CLAUDE.md` and `.claude/settings.json`).

## Commands

```
ai-sdlc install   [--project <path>] [--root <dir>] --from-bundle <file> [--dry-run] [--force] [--yes] [--json]
ai-sdlc update    [--project <path>] [--root <dir>] --from-bundle <file> [--dry-run] [--force] [--yes] [--json]
ai-sdlc doctor    [--project <path>] [--from-bundle <file>] [--json]
ai-sdlc uninstall [--project <path>] [--dry-run] [--yes] [--json]
ai-sdlc version
```

Exit codes: `0` success, `1` the operation failed, `2` wrong usage.

Downloading the latest release is not implemented yet, so `install` and `update` currently need `--from-bundle <file>` (a release bundle; the `<file>.sha256` beside it is verified when present).

## Quick start

```sh
npm install -g ai-sdlc-cli        # once the package is published
ai-sdlc install --from-bundle ./ai-sdlc-0.1.0.bundle.json
```

Without `--project` the CLI lists the git repositories directly under the current directory (and its parent), or under `--root`, plus an "enter a path" option. It shows the full plan and asks before writing. In scripts and CI pass `--project <path> --yes`; without a terminal the CLI refuses to guess and exits with `2`.

Use `--dry-run` first to see exactly what a run would do. A real run performs the same list.

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
