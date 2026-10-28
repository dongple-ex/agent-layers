import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { splitPathKey, pathKey, isPathPrefix } from '../src/formats/jsonmerge.js';
import { parseTomlValue } from '../src/formats/toml.js';

const BIN = fileURLToPath(new URL('../bin/agent-layers.js', import.meta.url));
const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const OTHER_OS = OS_NAME === 'linux' ? 'macos' : 'linux';

const tempRoots = [];
after(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-forget-'));
  tempRoots.push(root);
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  fs.mkdirSync(home, { recursive: true });
  return { root, home, source };
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function cli(sb, args) {
  const r = spawnSync(process.execPath, [BIN, '--home', sb.home, '--source', sb.source, ...args], {
    encoding: 'utf8',
    cwd: sb.root,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function manifest(sb, targets) {
  write(path.join(sb.source, 'agent-layers.jsonc'), JSON.stringify({ version: 1, targets, options: { secrets: { backend: 'file', mode: 'auto' }, claude: { mcp: 'json' } } }));
  write(path.join(sb.source, 'base', 'instructions', '00-core.md'), '# Core\n\n- Be precise.\n');
}

function settings(sb, name, text) {
  write(path.join(sb.source, 'base', 'settings', name), text);
}

function recordFor(sb, fileName) {
  const state = JSON.parse(read(path.join(sb.home, '.agent-layers', 'state.json')));
  return Object.values(state.outputs).find((r) => path.basename(r.path) === fileName) || null;
}

const managedKeys = (rec) => (rec?.managed || []).map((m) => pathKey(m.path));

test('forget: setting keys round-trip through the dotted key notation', () => {
  assert.deepEqual(splitPathKey('plugins.documents@openai.enabled'), ['plugins', 'documents@openai', 'enabled']);
  assert.deepEqual(splitPathKey('env.A\\.B'), ['env', 'A.B']);
  assert.equal(pathKey(splitPathKey('env.A\\.B')), 'env.A\\.B');
  assert.ok(isPathPrefix(['plugins'], ['plugins', 'a', 'enabled']));
  assert.ok(!isPathPrefix(['plugin'], ['plugins', 'a']));
});

test('forget (toml): keys removed from the source stay in place, unchanged or edited, and stop being managed', () => {
  const sb = sandbox();
  manifest(sb, ['codex']);
  settings(sb, 'codex.toml', 'model = "m1"\nmodel_reasoning_effort = "high"\nservice_tier = "default"\n');
  let r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  const config = path.join(sb.home, '.codex', 'config.toml');
  write(config, read(config).replace('"high"', '"low"'));
  const before = read(config);

  settings(sb, 'codex.toml', 'service_tier = "default"\n');
  settings(sb, '_forget.jsonc', '// stop managing per-machine model choices\n{ "codex": ["model", "model_reasoning_effort"] }\n');
  r = cli(sb, ['plan']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /= model \(no longer managed; value kept\)/);
  assert.match(r.out, /= model_reasoning_effort \(no longer managed; value kept\)/);
  assert.doesNotMatch(r.out, /drift|- model/);

  r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(config), before);
  assert.doesNotMatch(r.out, /Backups:/);
  const rec = recordFor(sb, 'config.toml');
  assert.deepEqual(managedKeys(rec), ['service_tier']);
  assert.deepEqual(rec.forgotten.map((f) => [pathKey(f.path), f.layer]), [['model', 'base'], ['model_reasoning_effort', 'base']]);

  r = cli(sb, ['plan']);
  assert.doesNotMatch(r.out, /update\s+codex\s+toml/);
  fs.rmSync(path.join(sb.source, 'base', 'settings', '_forget.jsonc'));
  r = cli(sb, ['plan']);
  assert.doesNotMatch(r.out, /config\.toml/);
  assert.match(read(config), /model = "m1"/);
});

test('forget (json): files with comments are not rewritten and edited values are not drift', () => {
  const sb = sandbox();
  manifest(sb, ['claude']);
  settings(sb, 'claude.json', JSON.stringify({ model: 'm1', effortLevel: 'high', theme: 'dark' }));
  let r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  const file = path.join(sb.home, '.claude', 'settings.json');
  write(file, `// my own note\n${read(file).replace('"m1"', '"m2"')}`);
  const before = read(file);

  settings(sb, 'claude.json', JSON.stringify({ theme: 'dark' }));
  settings(sb, '_forget.jsonc', JSON.stringify({ claude: ['model', 'effortLevel'] }));
  r = cli(sb, ['plan']);
  assert.match(r.out, /= model \(no longer managed; value kept\)/);
  assert.match(r.out, /= effortLevel \(no longer managed; value kept\)/);
  assert.doesNotMatch(r.out, /drift|conflict/);

  r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(file), before);
  assert.deepEqual(managedKeys(recordFor(sb, 'settings.json')), ['theme']);
});

test('forget: a parent key releases every managed key below it', () => {
  const sb = sandbox();
  manifest(sb, ['codex']);
  settings(sb, 'codex.toml', 'service_tier = "default"\n\n[plugins."a@x"]\nenabled = true\n\n[plugins."b@x"]\nenabled = false\n');
  let r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);

  settings(sb, 'codex.toml', 'service_tier = "default"\n');
  settings(sb, '_forget.jsonc', JSON.stringify({ codex: ['plugins'] }));
  r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  const config = parseTomlValue(read(path.join(sb.home, '.codex', 'config.toml')));
  assert.deepEqual(config.plugins, { 'a@x': { enabled: true }, 'b@x': { enabled: false } });
  assert.deepEqual(managedKeys(recordFor(sb, 'config.toml')), ['service_tier']);
});

test('forget: when a whole settings file leaves the source, only the forgotten keys are kept', () => {
  const sb = sandbox();
  manifest(sb, ['codex']);
  settings(sb, 'codex.toml', 'model = "m1"\nmodel_reasoning_effort = "high"\nservice_tier = "default"\n');
  let r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);

  fs.rmSync(path.join(sb.source, 'base', 'settings', 'codex.toml'));
  settings(sb, '_forget.jsonc', JSON.stringify({ codex: ['model'] }));
  r = cli(sb, ['plan']);
  assert.match(r.out, /= model \(no longer managed; value kept\)/);
  assert.match(r.out, /- model_reasoning_effort/);
  r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  const config = read(path.join(sb.home, '.codex', 'config.toml'));
  assert.match(config, /model = "m1"/);
  assert.doesNotMatch(config, /model_reasoning_effort|service_tier/);
  assert.equal(recordFor(sb, 'config.toml'), null);
});

test('forget: @os files apply only on that operating system', () => {
  const sb = sandbox();
  manifest(sb, ['codex']);
  settings(sb, 'codex.toml', 'model = "m1"\nmodel_reasoning_effort = "high"\nservice_tier = "default"\n');
  let r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);

  settings(sb, 'codex.toml', 'service_tier = "default"\n');
  settings(sb, `_forget@${OS_NAME}.jsonc`, JSON.stringify({ codex: ['model'] }));
  settings(sb, `_forget@${OTHER_OS}.jsonc`, JSON.stringify({ codex: ['model_reasoning_effort'] }));
  r = cli(sb, ['plan']);
  assert.match(r.out, /= model \(no longer managed; value kept\)/);
  assert.match(r.out, /- model_reasoning_effort/);
});

test('forget: contradicting or malformed entries stop validate and apply before anything is written', () => {
  const cases = [
    [{ codex: ['model'] }, /codex setting "model" is also set/],
    [{ codx: ['model'] }, /unknown agent/],
    [{ codex: 'model' }, /"codex" must be a list of setting keys/],
  ];
  for (const [forget, message] of cases) {
    const sb = sandbox();
    manifest(sb, ['codex']);
    settings(sb, 'codex.toml', 'model = "m1"\n');
    settings(sb, '_forget.jsonc', JSON.stringify(forget));
    let r = cli(sb, ['validate']);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, message);
    r = cli(sb, ['apply', '--yes']);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, message);
    assert.ok(!fs.existsSync(path.join(sb.home, '.codex', 'config.toml')));
  }
});

test('forget: uninstall after a forget keeps the released keys', () => {
  const sb = sandbox();
  manifest(sb, ['codex']);
  settings(sb, 'codex.toml', 'model = "m1"\nservice_tier = "default"\n');
  let r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  settings(sb, 'codex.toml', 'service_tier = "default"\n');
  settings(sb, '_forget.jsonc', JSON.stringify({ codex: ['model'] }));
  r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);

  r = cli(sb, ['uninstall', '--yes']);
  assert.equal(r.code, 0, r.out);
  const config = read(path.join(sb.home, '.codex', 'config.toml'));
  assert.match(config, /model = "m1"/);
  assert.doesNotMatch(config, /service_tier/);
});
