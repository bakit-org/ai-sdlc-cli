'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, makeBundle, writeBundle, newProject, runCli, walk } = require('./helpers');

async function tryInstall(bundleFile, project = newProject()) {
  const r = await runCli(['install', '--project', project, '--from-bundle', bundleFile, '--yes']);
  return { ...r, project, files: walk(project).filter((f) => !f.includes(`${path.sep}.git${path.sep}`)) };
}

test('a tampered file inside the bundle is rejected before anything is written', async () => {
  const bundle = makeBundle();
  bundle.contents['.claude/agents/alpha.md'] = '# evil\n';
  const r = await tryInstall(writeBundle(tmpDir(), bundle));
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /hash mismatch/);
  assert.deepStrictEqual(r.files, []);
});

test('a bundle that no longer matches its .sha256 is rejected', async () => {
  const dir = tmpDir();
  const file = writeBundle(dir, makeBundle());
  fs.appendFileSync(file, ' \n');
  const r = await tryInstall(file);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /checksum mismatch/);
  assert.deepStrictEqual(r.files, []);
});

test('a doctored .sha256 sidecar is rejected', async () => {
  const dir = tmpDir();
  const file = writeBundle(dir, makeBundle());
  fs.writeFileSync(`${file}.sha256`, `${'0'.repeat(64)}  x\n`);
  assert.strictEqual((await tryInstall(file)).code, 1);
  fs.writeFileSync(`${file}.sha256`, 'not-hex\n');
  assert.strictEqual((await tryInstall(file)).code, 1);
});

test('a missing sidecar only warns', async () => {
  const r = await tryInstall(writeBundle(tmpDir(), makeBundle(), { sidecar: false }));
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.err, /integrity not verified/);
});

test('min_cli_version above the running CLI is rejected', async () => {
  const r = await tryInstall(writeBundle(tmpDir(), makeBundle({ minCli: '99.0.0' })));
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /needs ai-sdlc-cli >= 99\.0\.0/);
  assert.deepStrictEqual(r.files, []);
});

test('an unsupported payload_schema is rejected', async () => {
  const r = await tryInstall(writeBundle(tmpDir(), makeBundle({ schema: 2 })));
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /payload_schema/);
});

const escapes = ['../outside.md', '/etc/passwd', 'C:/x.md', '.claude/../../up.md', '.claude\\win.md', '.claude//x.md'];
for (const bad of escapes) {
  test(`manifest path "${bad}" is rejected`, async () => {
    const bundle = makeBundle({ files: [{ path: 'ai-sdlc/ok.md', class: 'user-once', text: 'ok\n' }, { path: bad, class: 'user-once', text: 'x\n' }] });
    const r = await tryInstall(writeBundle(tmpDir(), bundle));
    assert.strictEqual(r.code, 1);
    assert.match(r.err, /unsafe bundle path/);
    assert.deepStrictEqual(r.files, []);
  });
}

test('managed files outside .claude/ and a CLAUDE.md that is not a block are rejected', async () => {
  const outside = makeBundle({ files: [{ path: 'src/app.js', class: 'managed', text: 'x\n' }] });
  assert.strictEqual((await tryInstall(writeBundle(tmpDir(), outside))).code, 1);
  const clobber = makeBundle({ files: [{ path: 'CLAUDE.md', class: 'user-once', text: 'x\n' }] });
  assert.strictEqual((await tryInstall(writeBundle(tmpDir(), clobber))).code, 1);
  const settings = makeBundle({ files: [{ path: '.claude/settings.json', class: 'managed', text: '{}\n' }] });
  assert.strictEqual((await tryInstall(writeBundle(tmpDir(), settings))).code, 1);
});

test('a symlink inside the project cannot be used to write outside it', async () => {
  const project = newProject();
  const outside = tmpDir();
  fs.mkdirSync(path.join(project, '.claude'));
  fs.symlinkSync(outside, path.join(project, '.claude/agents'), 'dir');
  const r = await tryInstall(writeBundle(tmpDir(), makeBundle()), project);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /outside the project/);
  assert.deepStrictEqual(fs.readdirSync(outside), []);
});

test('contents entries that the manifest does not list are rejected', async () => {
  const bundle = makeBundle();
  bundle.contents['.claude/extra.md'] = 'sneaky\n';
  assert.strictEqual((await tryInstall(writeBundle(tmpDir(), bundle))).code, 1);
});

test('base64 files round-trip byte-exactly', async () => {
  const raw = Buffer.from([0, 255, 1, 2, 128]);
  const bundle = makeBundle({ files: [{ path: '.claude/data.bin', class: 'managed', base64: raw.toString('base64') }] });
  const r = await tryInstall(writeBundle(tmpDir(), bundle));
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(fs.readFileSync(path.join(r.project, '.claude/data.bin')).equals(raw));
});
