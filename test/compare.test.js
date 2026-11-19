import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { sha256 } from '../src/util/fsx.js';

const bin = fileURLToPath(new URL('../bin/agent-layers.js', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-compare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return { root, home: path.join(root, 'home'), source: path.join(root, 'setup') };
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function cli(sb, ...args) {
  const result = spawnSync(process.execPath, [bin, '--home', sb.home, '--source', sb.source, ...args], {
    cwd: sb.root, env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8',
  });
  assert.ifError(result.error);
  return result;
}

test('status --json preserves the empty and mixed-scope legacy bytes after a local edit', (t) => {
  const sb = fixture(t);
  function check(outputs, projects) {
    const result = cli(sb, 'status', '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify({ outputs, projects }, null, 2) + '\n');
  }
  check({}, {});
  const file = path.join(sb.home, '.codex', 'AGENTS.md');
  const project = path.join(sb.root, 'demo');
  const appliedAt = '2026-01-01T00:00:00Z';
  const user = { scopeKey: 'user', type: 'file', path: file, adapters: ['codex'], hash: sha256('sample\n'), appliedAt };
  const record = { ...user, scopeKey: 'project:demo:' + project, project: 'demo', root: project, path: path.join(project, 'AGENTS.md') };
  const outputs = { ['user|file|' + file]: user, [record.scopeKey + '|file|' + record.path]: record };
  const projects = { demo: { root: project, appliedAt } };
  write(file, 'sample\n');
  write(path.join(sb.home, '.agent-layers', 'state.json'), JSON.stringify({ version: 1, outputs, projects }));
  check(outputs, projects);
  write(file, 'edited\n');
  check(outputs, projects);
  assert.match(cli(sb, 'status').stdout, /modified/);
});

function git(sb, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-C', sb.source, ...args], { encoding: 'utf8' });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function setup(sb, manifest, files) {
  write(path.join(sb.source, 'agent-layers.jsonc'), JSON.stringify({ version: 1, ...manifest }));
  for (const [file, contents] of Object.entries(files)) {
    write(path.join(sb.source, 'base', file), contents);
  }
  git(sb, 'init', '-q');
  git(sb, 'add', '.');
  git(sb, 'commit', '-qm', 'Fixture');
}

function apply(sb) {
  const r = cli(sb, 'apply', '--yes');
  assert.equal(r.status, 0, r.stdout + r.stderr);
}

function capture(sb, name) {
  const file = path.join(sb.root, name + '.json');
  const r = cli(sb, 'compare', 'capture', '--out', file);
  assert.equal(r.status, 0, r.stderr);
  return { file, report: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function compare(sb, a, b, status) {
  const r = cli(sb, 'compare', 'diff', a.file, b.file, '--json');
  assert.equal(r.status, status, r.stdout + r.stderr);
  assert.equal(r.stderr, '');
  return JSON.parse(r.stdout);
}

test('two offline reports locate a deleted Codex table and preserve legacy state and the source index', (t) => {
  const a = fixture(t);
  const b = { ...a, home: path.join(a.root, 'other-home') };
  setup(a, { targets: ['codex'] }, {
    'mcp/demo.json': JSON.stringify({ command: 'fixture-server', args: ['private-argument-3475'] }),
    'instructions/rule.md.tmpl': 'Home {{home}}\n',
    'settings/codex.json': '{"model":"private-model-1239"}',
  });
  apply(a);
  apply(b);
  const index = path.join(a.source, '.git', 'index');
  const state = path.join(a.home, '.agent-layers', 'state.json');
  const config = path.join(a.home, '.codex', 'config.toml');
  const snapshot = () => [index, state, config].map((f) => [fs.readFileSync(f), fs.statSync(f).mtimeMs]);
  const before = snapshot();
  const left = capture(a, 'a');
  const right = capture(b, 'b');
  assert.deepEqual(snapshot(), before);
  assert.equal(left.report.sourceNow[0].commit, git(a, 'rev-parse', 'HEAD'));
  assert.equal(left.report.sourceNow[0].dirty, false);
  assert.equal(left.report.sourceAtApply, null);
  assert.equal(left.report.coverage, 'complete', JSON.stringify(left.report.issues));
  const shared = fs.readFileSync(left.file, 'utf8');
  for (const privateText of [a.root, 'private-model-1239', 'private-argument-3475', 'fixture-server']) {
    assert.ok(!shared.includes(privateText), privateText);
  }
  for (const rec of Object.values(JSON.parse(fs.readFileSync(state, 'utf8')).outputs)) {
    const hashes = [rec.hash, ...[...(rec.managed || []), ...(rec.tables || [])].map((key) => key.hash)];
    for (const hash of hashes.filter((h) => typeof h === 'string')) {
      assert.ok(!shared.includes(hash), 'shared a managed value hash');
    }
  }
  assert.equal(compare(a, left, right, 0).result, 'no_findings');
  write(path.join(b.home, '.codex', 'config.toml'), 'model = "private-model-1239"\n');
  const drift = capture(b, 'b-changed');
  const table = drift.report.items.find((item) => item.id.join('/') === 'user/codex/mcp/demo');
  assert.equal(table?.vsApplied, 'missing');
  assert.equal(table.vsCurrent, 'different');
  const nowhere = { ...a, home: path.join(a.root, 'invalid-home'), source: path.join(a.root, 'absent') };
  write(path.join(nowhere.home, '.agent-layers', 'config.jsonc'), '{broken');
  const result = compare(nowhere, left, drift, 1);
  assert.equal(result.firstDifference, 'managed');
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0].id, table.id);
  const text = cli(nowhere, 'compare', 'diff', left.file, drift.file);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /demo/);
  assert.deepEqual(compare(nowhere, left, drift, 1), result);
});

test('captures distinguish changes to setup HEAD, an unapplied update, and identical drift on both PCs', (t) => {
  const a = fixture(t);
  const b = { ...a, home: path.join(a.root, 'second') };
  setup(a, { targets: ['codex'] }, { 'settings/codex.json': '{"model":"first"}' });
  apply(a);
  apply(b);
  const first = capture(a, 'old');
  write(path.join(a.source, 'base', 'settings', 'codex.json'), '{"model":"second"}');
  git(a, 'commit', '-qam', 'Update setting');
  apply(a);
  const updated = capture(a, 'updated');
  assert.equal(compare(a, first, updated, 1).firstDifference, 'source');
  const pending = capture(b, 'not-applied');
  const key = pending.report.items.find((i) => i.id.at(-1) === 'model');
  assert.equal(key?.vsApplied, 'ok');
  assert.equal(key.vsCurrent, 'different');
  assert.equal(compare(a, updated, pending, 1).firstDifference, 'managed');
  apply(b);
  assert.equal(compare(a, updated, capture(b, 'applied'), 0).result, 'no_findings');
  for (const sb of [a, b]) {
    write(path.join(sb.home, '.codex', 'config.toml'), '');
  }
  assert.equal(compare(a, capture(a, 'missing-a'), capture(b, 'missing-b'), 1).firstDifference, null);
});

test('missing versus damaged records, missing source and local template variables remain distinguishable', (t) => {
  const sb = fixture(t);
  setup(sb, { targets: ['claude'], vars: { region: 'default' } }, {
    'settings/claude.json': '{"region":"{{vars.region}}","path":"{{home}}","other":null}',
  });
  write(path.join(sb.home, '.agent-layers', 'config.jsonc'), '{"vars":{"region":"private-city-982"}}');
  const empty = capture(sb, 'empty');
  const region = (report) => report.items.find((i) => i.id.at(-1) === 'region');
  assert.equal(region(empty.report)?.vsApplied, 'unrecorded');
  apply(sb);
  const healthy = capture(sb, 'with-record');
  assert.equal(region(healthy.report).localVariable, true);
  assert.equal(region(healthy.report).vsCurrent, 'match');
  assert.equal(healthy.report.items.find((i) => i.id.at(-1) === 'path').localVariable, false);
  assert.equal(healthy.report.items.find((i) => i.id.at(-1) === 'other').vsCurrent, 'match');
  assert.ok(!fs.readFileSync(healthy.file, 'utf8').includes('private-city-982'));
  assert.equal(compare(sb, healthy, healthy, 3).result, 'inconclusive');
  const absent = capture({ ...sb, source: path.join(sb.root, 'gone') }, 'no-source');
  assert.equal(absent.report.coverage, 'partial');
  assert.equal(region(absent.report)?.vsApplied, 'ok');
  assert.equal(region(absent.report).vsCurrent, 'unknown');
  write(path.join(sb.home, '.agent-layers', 'state.json'), '{"version":1,"outputs":null}');
  const invalid = capture(sb, 'no-records');
  assert.equal(region(invalid.report)?.vsApplied, 'unknown');
  assert.equal(region(invalid.report).vsCurrent, 'match');
});

test('capture never overwrites an existing report and offline diff rejects malformed and legacy input', (t) => {
  const sb = fixture(t);
  const file = path.join(sb.root, 'private-input-name.json');
  write(file, 'old');
  const fail = (...args) => {
    const r = cli(sb, 'compare', ...args);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.trim());
    assert.ok(!r.stderr.includes('private-input-name'));
  };
  fail('capture', '--out', file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  fail('diff', file, file, '--json');
  fail('capture');
  fail('capture', '--project', 'demo', '--out', path.join(sb.root, 'unexpected'));
  const base = capture(sb, 'valid');
  for (const invalid of [{ outputs: {}, projects: {} }, { ...base.report, schemaVersion: 2 }, { ...base.report, scope: 'project' }]) {
    write(file, JSON.stringify(invalid));
    fail('diff', base.file, file, '--json');
  }
  assert.ok(!fs.existsSync(path.join(sb.root, 'unexpected')));
});

test('two simultaneous captures publish one complete report without leaving temporary files', async (t) => {
  const sb = fixture(t);
  const dest = path.join(sb.root, 'shared.json');
  const attempt = () => new Promise((resolve, reject) => {
    execFile(process.execPath, [bin, '--home', sb.home, '--source', sb.source, 'compare', 'capture', '--out', dest], (err) => {
      if (err && typeof err.code !== 'number') {
        reject(err);
      } else {
        resolve(err?.code ?? 0);
      }
    });
  });
  assert.deepEqual((await Promise.all([attempt(), attempt()])).sort(), [0, 2]);
  assert.deepEqual(fs.readdirSync(sb.root), ['shared.json']);
  assert.equal(JSON.parse(fs.readFileSync(dest, 'utf8')).format, 'agent-layers-pc-report');
});

test('capture records extends order, OS-only keys and the current target selection', (t) => {
  const sb = fixture(t);
  const team = { ...sb, source: path.join(sb.root, 'team-repo') };
  setup(team, {}, { 'settings/claude.json': '{"fromTeam":true}' });
  const native = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
  const files = { 'settings/claude.json': '{"commonKey":1}', 'settings/codex.json': '{"model":"example"}' };
  if (native) {
    files['settings/claude@' + native + '.json'] = '{"platformKey":2}';
  }
  setup(sb, { targets: ['claude', 'codex'], extends: [{ name: 'team', path: '../team-repo/base' }] }, files);
  apply(sb);
  const baseline = capture(sb, 'both');
  assert.deepEqual(baseline.report.layers, ['team', 'base']);
  assert.deepEqual(baseline.report.sourceNow.find((s) => s.id === 'extends:team'), { id: 'extends:team', commit: git(team, 'rev-parse', 'HEAD'), dirty: false });
  const items = baseline.report.items;
  assert.equal(items.find((i) => i.id.at(-1) === 'fromTeam')?.osOnly, false);
  if (native) {
    assert.equal(items.find((i) => i.id.at(-1) === 'platformKey')?.osOnly, true);
  }
  write(path.join(sb.home, '.agent-layers', 'config.jsonc'), '{"targets":{"exclude":["codex"]}}');
  const reduced = capture(sb, 'claude');
  assert.deepEqual(reduced.report.selectedTargets, ['claude']);
  const model = reduced.report.items.find((i) => i.id.at(-1) === 'model');
  assert.equal(model?.vsApplied, 'ok');
  assert.equal(model.vsCurrent, 'not_applicable');
  assert.equal(compare(sb, baseline, reduced, 1).firstDifference, 'selection');
});

test('materialized MCP values are unverified without reading the keychain, and ordinary sibling keys remain observable', (t) => {
  const sb = fixture(t);
  const secret = 'FIXTURE_PRIVATE_REF_842';
  setup(sb, { targets: ['codex'], options: { secrets: { mode: 'materialize', backend: 'unavailable-fixture' } } }, {
    'mcp/demo.json': JSON.stringify({ command: 'fixture-only', args: ['${secret:' + secret + '}'] }),
    'settings/codex.json': '{"model":"fixture"}',
  });
  write(path.join(sb.home, '.codex', 'config.toml'), 'model = "fixture"\n[mcp_servers.demo]\ncommand = "fixture-only"\nargs = ["private-argument-6723"]\n');
  const got = capture(sb, 'share');
  const table = got.report.items.find((i) => i.id.join('/') === 'user/codex/mcp/demo');
  assert.equal(table?.vsCurrent, 'unknown');
  assert.equal(got.report.items.find((i) => i.id.at(-1) === 'model').vsCurrent, 'match');
  assert.equal(got.report.coverage, 'partial');
  for (const hidden of [secret, 'private-argument-6723', 'fixture-only']) {
    assert.ok(!fs.readFileSync(got.file, 'utf8').includes(hidden));
  }
});

test('Git provenance follows dirty submodules and leaves filtered working trees unverified', (t) => {
  const sb = fixture(t);
  const sub = { ...sb, source: path.join(sb.root, 'nested-setup') };
  setup(sub, { targets: [] }, { 'instructions/team.md': 'original\n' });
  setup(sb, { targets: ['codex'] }, { 'settings/codex.json': '{"model":"example"}' });
  git(sb, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.source, 'team');
  git(sb, 'commit', '-qm', 'Include team repository');
  assert.equal(capture(sb, 'clean-tree').report.sourceNow[0].dirty, false);
  write(path.join(sb.source, 'team', 'base', 'instructions', 'team.md'), 'updated\n');
  assert.equal(capture(sb, 'dirty-team').report.sourceNow[0].dirty, true);
  git(sb, 'config', 'filter.compare-fixture.clean', 'fixture-filter');
  write(path.join(sb.source, '.git', 'info', 'attributes'), 'base/settings/codex.json filter=compare-fixture\n');
  const filtered = capture(sb, 'filtered').report;
  assert.equal(filtered.sourceNow[0].commit, git(sb, 'rev-parse', 'HEAD'));
  assert.equal(filtered.sourceNow[0].dirty, null);
  assert.ok(filtered.issues.some((issue) => issue.code === 'git_unavailable'));
});
