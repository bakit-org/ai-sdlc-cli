# Interactive mode

When you run the CLI in a terminal it can guide you with interactive screens that redraw in place (no alternate screen): a gradient banner, a status line, a filterable project list, a review step, a progress bar and a result panel. There are no extra dependencies; everything is built on Node's raw terminal mode and ANSI sequences.

## When it starts

| You run | In a terminal | Otherwise |
|---|---|---|
| `ai-sdlc init` | guided install (below) | same as `install` |
| `ai-sdlc` (no command) | menu: Install, Update, Doctor, Uninstall, Quit | usage text, exit `2` |
| `ai-sdlc update`, `doctor`, `uninstall` | coloured result views (checklist, panels); prompts as before | plain text |
| `ai-sdlc install` | unchanged (numbered picker, `[y/N]`) | unchanged |

"In a terminal" means stdin and stdout are both terminals. Interactive mode is never used when any of these is true, and the plain behaviour (output, prompts, exit codes `0`/`1`/`2`) is unchanged:

- `--json`, `--yes`/`-y` or `--no-tui` is given
- `TERM=dumb`
- `init --dry-run` (it prints the plan and exits, like `install --dry-run`)

`--project <path>` together with `init` skips the project list; the review step is still shown.

## The guided install (`ai-sdlc init`)

1. **Banner and checks.** A banner, a dim status line (`Using: node 24 | git ✔ | kit source: bundle file`) and one line per check: Node version, git, and the kit source. With `--from-bundle <file>` the source is that file. Without it the source line is marked *release download unavailable in this build* and the run ends with the existing usage error (exit `2`, "use --from-bundle"). Further checks (for example access to the release host) plug in through the `extraChecks` list of `runPreflight` in `lib/tui/flows/preflight.js`.
2. **Project.** A list of git repositories found one level under `--root` (default: the current directory and its parent) plus recently used projects, newest first. Each row has a badge: `not installed`, `installed vX → update`, or `no .git ⚠`. Type to filter; `Enter a path…` opens a path field with Tab / Shift-Tab completion. `~`, files, missing paths and filesystem roots are refused with an inline message.
3. **Review.** What will happen by class (managed files, starter files, the `CLAUDE.md` block, hooks) with a note that only the marked block of `CLAUDE.md` is managed. `d` toggles the full file list. Nothing has been written at this point.
4. **Install.** The project lock is taken, the plan is computed again under the lock, and the changes are applied with a progress bar showing the current file.
5. **Result.** What was written and the next steps: open the folder in Claude Code, fill in `ai-sdlc/project.md`, run `ai-sdlc doctor`.

### Keys

| Key | Action |
|---|---|
| Enter | choose / confirm / install |
| Esc | back one step; at the first step, cancel. In a filter or candidate list it first clears that |
| Ctrl-C | cancel immediately |
| Up / Down, Home / End, PgUp / PgDn | move in lists (lists wrap) |
| Tab / Shift-Tab | next / previous path completion |
| Left / Right, Home / End | move in text fields |
| Backspace, Delete | edit |
| Ctrl-A / Ctrl-E | start / end of line |
| Ctrl-U / Ctrl-W | delete to line start / previous word |
| `d` (review) | show or hide the full list |
| `1`-`5` (menu) | pick an entry |

Pasting works (bracketed paste); line breaks in pasted text are dropped. Enter sent as CRLF (Windows terminals) counts once. Resizing the window redraws the current screen.

## What the screens guard against

- **Typed-ahead keys.** Keys pressed before a screen is on display (for example Enter during the environment check) are dropped. The review ignores Enter and `y` for the first 150 ms after it appears. Only Ctrl-C survives typing ahead.
- **Closed input.** If stdin ends (pipe closed, terminal gone) between screens, the next screen cancels: exit `1`, nothing written.
- **Hostile text.** Folder names, versions, paths and messages come from disk, so control characters in them are shown as visible escapes (`^[`, `\n`, `\u009b`) and never sent to the terminal. Text typed or pasted into a field loses escape sequences and control characters. A manifest whose version is not a plain semantic version is treated as untrustworthy (a warning in the menu and the list).
- **Stale review.** The plan is computed again after the project lock is taken. If it differs from what was reviewed, the review is shown again with a note instead of installing something else.
- **Limits.** Fields hold at most 4096 characters; bracketed pastes are capped at 1 MB and abandoned after 2 s without an end marker; the project list shows at most 200 projects. A window smaller than 20x8 shows a single line asking for more room.

## Cancelling

Esc or Ctrl-C at any step writes nothing: the apply layer is only called after the final confirmation, and the project lock is not even taken before it. The command ends with `ai-sdlc: cancelled; nothing was changed` (or `interrupted; ...` for Ctrl-C) and exit code `1`, the same as declining the prompt in the plain flow. An external `SIGINT`/`SIGTERM` (for example `kill`) restores the terminal and exits `130`/`143`.

The terminal is always put back by one cleanup path (cursor shown, bracketed paste off, raw mode off), registered for normal exit, `SIGINT`, `SIGTERM` and uncaught exceptions, and run again from a `finally` when a screen ends or throws.

## Looks

- **Colour:** truecolor when `COLORTERM` says so (also iTerm, Windows Terminal); 16 colours otherwise on a colour terminal; none for `NO_COLOR`, `FORCE_COLOR=0`, `TERM=dumb` or when output is not a terminal. `FORCE_COLOR=1` forces colour on.
- **Banner** (chosen by terminal width): 120+ columns thick 2-pixel letters, 100+ the 1-pixel letters, 50+ a compact half-block version, below 50 columns, without colour, or without unicode a single line `> AI-SDLC`. `node lib/tui/logo.js` previews the banner for the current terminal.
- **Unicode:** box drawing, `❯ ✔ ⚠ ✖ →` need a UTF-8 locale. With `TERM=linux`, `TERM=dumb` or a `LANG`/`LC_ALL` that is not UTF-8 the screens use ASCII (`+--+`, `|`, `>`, `+ ! x`).
- Long lines are cut with an ellipsis, never wrapped; long paths keep their start and end.

## Recent projects

Project paths (nothing else) are remembered in `recent.json` under `$XDG_CONFIG_HOME/ai-sdlc/`, `%APPDATA%\ai-sdlc\` on Windows, or `~/.config/ai-sdlc/`. The file is replaced atomically, only paths of existing folders are shown, and any problem reading or writing it is ignored. Delete the file to forget everything.

## Layout of the code

```
lib/tui/
  keys.js          raw input -> key events (arrows, Home/End, Enter/CRLF, Esc, Tab, Ctrl-keys, paste)
  terminal.js      session: raw mode, live frame redraw, resize, single cleanup path
  theme.js         colour level, attribute support, unicode/ASCII symbols, gradient
  text-width.js    ANSI-aware width, truncation (end and middle)
  logo.js          banner variants; logo-fonts.js has the bitmap fonts
  launch.js        decides whether interactive mode may start
  widgets/         input-box select-list path-input confirm spinner progress-bar panel
  flows/           init-flow menu-flow result-views plus their helpers
```

Frames are pure functions of `(state, theme, width)` returning lines; the session draws them by moving the cursor up over the previous frame and clearing it (no alternate screen). Tests drive widgets and flows with scripted key bytes over in-memory streams (`tests/tui-*.test.js`).
