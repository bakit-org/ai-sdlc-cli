'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { run } = require('../lib/commands');
const { shouldUseTui, shouldRunWizard } = require('../lib/tui/launch');
const { tmpDir, makeBundle, writeBundle, newProject, exists, read, runCli } = require('./helpers');
const { makeTerm, KEYS } = require('./tui-helpers');

const ESC = /\x1b\[/;
const setup = () => ({ bundle: writeBundle(tmpDir(), makeBundle()), home: tmpDir(), xdg: tmpDir() });
const termFor = (xdg, env = {}) => makeTerm({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: xdg, ...env } });

test('launch rules: only a real terminal on both ends, and none of the scripted flags', () => {
  const tty = { env: {}, stdin: { isTTY: true, setRawMode() {} }, stdout: { isTTY: true } };
  assert.strictEqual(shouldUseTui({}, tty), true);
  assert.strictEqual(shouldUseTui({ json: true }, tty), false);
  assert.strictEqual(shouldUseTui({ yes: true }, tty), false);
  assert.strictEqual(shouldUseTui({ noTui: true }, tty), false);
  assert.strictEqual(shouldUseTui({}, { ...tty, env: { TERM: 'dumb' } }), false);
  assert.strictEqual(shouldUseTui({}, { ...tty, stdin: {} }), false);
  assert.strictEqual(shouldUseTui({}, { ...tty, stdout: {} }), false);
  assert.strictEqual(shouldUseTui({}, { ...tty, stdin: { isTTY: true } }), false, 'no raw mode available');
  assert.strictEqual(shouldUseTui({}, { ...tty, tui: false }), false);
  assert.strictEqual(shouldUseTui({}, { env: {}, stdin: {}, stdout: {}, tui: true }), true);
  assert.strictEqual(shouldRunWizard({ dryRun: true }, tty), false);
  assert.strictEqual(shouldRunWizard({ project: '/x' }, tty), true);
});

test('init without a terminal is exactly install', async () => {
  const { bundle } = setup();
  const a = newProject();
  const b = newProject();
  const viaInit = await runCli(['init', '--project', a, '--from-bundle', bundle, '--yes']);
  const viaInstall = await runCli(['install', '--project', b, '--from-bundle', bundle, '--yes']);
  assert.strictEqual(viaInit.code, 0);
  assert.strictEqual(viaInit.out.replaceAll(a, 'P'), viaInstall.out.replaceAll(b, 'P'));
  assert.strictEqual(read(a, '.claude/ai-sdlc.manifest.json').length, read(b, '.claude/ai-sdlc.manifest.json').length);
  assert.strictEqual((await runCli(['init'])).code, 2, 'still needs --project without a terminal');
  assert.strictEqual((await runCli(['init', '--project', newProject(), '--from-bundle', bundle])).code, 2, 'and --yes');
  assert.strictEqual((await runCli(['init', '--project', newProject(), '--yes'])).code, 2, 'and a bundle');
});

test('--yes, --json, --no-tui and TERM=dumb keep the plain flow even on a terminal', async () => {
  const { bundle, xdg, home } = setup();
  for (const [extra, env] of [[['--yes'], {}], [['--json', '--yes'], {}], [['--no-tui', '--yes'], {}], [['--yes'], { TERM: 'dumb' }]]) {
    const project = newProject();
    const term = termFor(xdg, env);
    const code = await run(['init', '--project', project, '--from-bundle', bundle, ...extra], term.runEnv({ cwd: project, home }));
    assert.strictEqual(code, 0, `${extra} ${JSON.stringify(env)}: ${term.stderrText()}`);
    assert.deepStrictEqual(term.stdin.rawCalls, [], 'raw mode never touched');
    assert.doesNotMatch(term.raw(), ESC);
    assert.ok(exists(project, '.claude/ai-sdlc.manifest.json'));
  }
});

test('--no-tui and TERM=dumb fall back to the numbered picker and the y/N prompt', async () => {
  for (const [flag, env] of [[['--no-tui'], {}], [[], { TERM: 'dumb' }]]) {
    const { bundle, xdg, home } = setup();
    const root = tmpDir();
    fs.mkdirSync(path.join(root, 'app', '.git'), { recursive: true });
    const term = termFor(xdg, env);
    term.stdin.write('1\ny\n');
    const code = await run(['init', '--root', root, '--from-bundle', bundle, ...flag], term.runEnv({ cwd: root, home }));
    assert.strictEqual(code, 0, term.stderrText());
    assert.match(term.raw(), /1\) .*app/);
    assert.match(term.raw(), /Apply these changes\? \[y\/N\]/);
    assert.deepStrictEqual(term.stdin.rawCalls, []);
    assert.doesNotMatch(term.raw(), ESC);
  }
});

test('init --dry-run on a terminal prints the plain plan and writes nothing', async () => {
  const { bundle, xdg, home } = setup();
  const project = newProject();
  const term = termFor(xdg);
  const code = await run(['init', '--project', project, '--from-bundle', bundle, '--dry-run'], term.runEnv({ cwd: project, home }));
  assert.strictEqual(code, 0);
  assert.match(term.raw(), /dry run/);
  assert.ok(!exists(project, '.claude'));
  assert.deepStrictEqual(term.stdin.rawCalls, []);
});

test('bare ai-sdlc: without a terminal it prints usage and exits 2, as before', async () => {
  const r = await runCli([]);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /Usage: ai-sdlc/);
  const { xdg } = setup();
  const term = termFor(xdg);
  assert.strictEqual(await run(['--no-tui'], term.runEnv({ cwd: tmpDir() })), 2);
  assert.match(term.stderrText(), /Usage: ai-sdlc/);
});

test('doctor, update and uninstall print coloured result views on a terminal; --no-tui and --json keep the plain text', async () => {
  const { bundle, xdg, home } = setup();
  const project = newProject();
  assert.strictEqual((await runCli(['install', '--project', project, '--from-bundle', bundle, '--yes'])).code, 0);
  const colour = { COLORTERM: 'truecolor', NO_COLOR: undefined };

  const doc = termFor(xdg, colour);
  assert.strictEqual(await run(['doctor', '--project', project], doc.runEnv({ cwd: project, home, probePython: () => null })), 0);
  assert.match(doc.raw(), /\x1b\[38;2;\d+;\d+;\d+m✔/);
  assert.match(doc.plain(), /Healthy/);
  assert.doesNotMatch(doc.plain(), /\[ok\]/);

  fs.rmSync(path.join(project, '.claude/agents/alpha.md'));
  const bad = termFor(xdg, colour);
  assert.strictEqual(await run(['doctor', '--project', project], bad.runEnv({ cwd: project, home, probePython: () => null })), 1);
  assert.match(bad.plain(), /✖ managed file\s+missing: \.claude\/agents\/alpha\.md/);
  assert.match(bad.plain(), /Problems found/);

  for (const flag of ['--no-tui', '--json']) {
    const plain = termFor(xdg, colour);
    const code = await run(['doctor', '--project', project, flag], plain.runEnv({ cwd: project, home, probePython: () => null }));
    const expected = await runCli(['doctor', '--project', project, flag]);
    assert.strictEqual(code, expected.code);
    assert.strictEqual(plain.raw(), expected.out, flag);
  }

  const upd = termFor(xdg, colour);
  upd.stdin.write('y\n');
  assert.strictEqual(await run(['update', '--project', project, '--from-bundle', bundle], upd.runEnv({ cwd: project, home })), 0, upd.stderrText());
  assert.match(upd.plain(), /ai-sdlc update/);
  assert.match(upd.plain(), /restore\s+\.claude\/agents\/alpha\.md/);
  assert.match(upd.plain(), /Done/);
  assert.strictEqual(read(project, '.claude/agents/alpha.md'), '# alpha v1\n');
  assert.doesNotMatch(upd.plain(), /^done\.$/m);

  const un = termFor(xdg, colour);
  un.stdin.write('y\n');
  assert.strictEqual(await run(['uninstall', '--project', project], un.runEnv({ cwd: project, home })), 0, un.stderrText());
  assert.match(un.plain(), /delete\s+\.claude\/agents\/alpha\.md/);
  assert.ok(!exists(project, '.claude/ai-sdlc.manifest.json'));
  assert.deepStrictEqual(un.stdin.rawCalls, [], 'views are printed, no raw mode');
});

test('declining the prompt after a result view still changes nothing (exit 1)', async () => {
  const { bundle, xdg, home } = setup();
  const project = newProject();
  assert.strictEqual((await runCli(['install', '--project', project, '--from-bundle', bundle, '--yes'])).code, 0);
  const term = termFor(xdg);
  term.stdin.write('n\n');
  assert.strictEqual(await run(['uninstall', '--project', project], term.runEnv({ cwd: project, home })), 1);
  assert.ok(exists(project, '.claude/ai-sdlc.manifest.json'));
});


test('the banner on screen follows colour support and terminal width', async () => {
  const { xdg, home } = setup();
  const cwd = newProject();
  const cases = [
    { columns: 130, env: { COLORTERM: 'truecolor', NO_COLOR: undefined }, has: /\x1b\[38;2;71;150;228m██/, rows: 10 },
    { columns: 105, env: { COLORTERM: 'truecolor', NO_COLOR: undefined }, has: /██/, rows: 8 },
    { columns: 70, env: { COLORTERM: 'truecolor', NO_COLOR: undefined }, has: /▀|▄/, rows: 4 },
    { columns: 40, env: { COLORTERM: 'truecolor', NO_COLOR: undefined }, has: /\x1b\[38;2;71;150;228m>/, rows: 1 },
    { columns: 130, env: { NO_COLOR: '1' }, has: /> AI-SDLC/, rows: 1 },
    { columns: 130, env: { TERM: 'linux', LANG: 'C', COLORTERM: 'truecolor', NO_COLOR: undefined }, has: /\x1b\[38;2;71;150;228m>/, rows: 1 },
  ];
  for (const c of cases) {
    const term = makeTerm({ columns: c.columns, env: { LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: xdg, ...c.env } });
    const done = run([], term.runEnv({ cwd, home }));
    await term.waitFor(/What would you like to do/);
    const lines = term.plain().split('\n');
    const first = lines.findIndex((l) => /\S/.test(l));
    const folder = lines.findIndex((l) => /Folder/.test(l));
    assert.strictEqual(lines.slice(first, folder).filter((l) => /\S/.test(l)).length, c.rows, JSON.stringify(c.env) + c.columns);
    assert.match(term.raw(), c.has);
    await term.send(KEYS.esc);
    assert.strictEqual(await done, 0);
  }
});
