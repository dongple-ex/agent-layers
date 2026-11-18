import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createContext } from '../src/context.js';
import { loadLayer, mergeLayers } from '../src/layers.js';
import { loadManifest } from '../src/manifest.js';
import { normalizeKey, renderScope, resolveTargets } from '../src/render.js';
import { buildPlan, applyPlan } from '../src/engine.js';
import { valueHash } from '../src/formats/jsonmerge.js';
import { sha256 } from '../src/util/fsx.js';
import { observeItems, shareableName } from '../src/compare/items.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-items-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const ctx = createContext({ home: path.join(root, 'profile'), source: path.join(root, 'setup'), env: {} });
  ctx.user = 'fixture-account';
  ctx.hostname = 'fixture-host.example';
  return ctx;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function rendered(ctx) {
  const manifest = loadManifest(ctx.sourceDir);
  const layer = loadLayer(manifest.baseDir, 'base', ctx.os);
  return renderScope(ctx, { scope: 'user', manifest, merged: mergeLayers([layer]), adapters: resolveTargets(ctx, manifest) });
}

function statuses(item) {
  assert.ok(item);
  return [item.vsApplied, item.vsCurrent];
}

test('observes real renderer and applied records per managed file, block, leaf and MCP object', (t) => {
  const ctx = fixture(t);
  write(path.join(ctx.sourceDir, 'agent-layers.json'), JSON.stringify({ targets: ['codex', 'gemini', 'antigravity'] }));
  const base = path.join(ctx.sourceDir, 'base');
  write(path.join(base, 'instructions', 'core.md'), 'Team instructions\n');
  write(path.join(base, 'mcp', 'demo.json'), '{"command":"sample-command"}');
  write(path.join(base, 'settings', 'codex.toml'), 'keep = true\n');
  write(path.join(base, 'settings', 'gemini.json'), '{"keep":null,"extra":"one","a.b":1,"a":{"b":2}}');
  write(path.join(base, 'files', 'home', 'docs', 'notes.txt.tmpl'), 'Notes\n');
  const state = { outputs: {}, history: [] };
  const { outputs } = rendered(ctx);
  const plan = buildPlan(ctx, { outputs, state, scopeKey: 'user', backup: false });
  assert.ok(applyPlan(ctx, plan, state, { scope: 'user' }).every((r) => r.status === 'done'));

  const before = observeItems(ctx, { state, outputs });
  assert.deepEqual(before.issues, []);
  assert.ok(before.items.length >= 10);
  assert.ok(before.items.every((i) => i.vsApplied === 'ok' && i.vsCurrent === 'match' && !i.osOnly));
  const block = before.items.find((i) => i.id.includes('GEMINI.md'));
  assert.deepEqual(block.owners, ['antigravity', 'gemini']);
  const gemini = path.join(ctx.paths.geminiHome, 'settings.json');
  const json = JSON.parse(fs.readFileSync(gemini, 'utf8'));
  delete json.extra;
  json.mcpServers.demo.args.push('private-arg');
  json.personal = 'private-value';
  write(gemini, JSON.stringify(json));
  write(path.join(ctx.paths.codexHome, 'config.toml'), 'keep = true\n');
  const md = path.join(ctx.paths.geminiHome, 'GEMINI.md');
  write(md, 'Personal text\r\n' + fs.readFileSync(md, 'utf8').replace(/\n/g, '\r\n'));
  write(path.join(ctx.paths.home, 'docs', 'notes.txt'), '\uFEFFNotes\r\n');
  const after = observeItems(ctx, { state, outputs });
  assert.deepEqual(after.issues, []);
  const find = (...id) => after.items.find((i) => JSON.stringify(i.id) === JSON.stringify(id));
  assert.deepEqual(statuses(find('user', 'gemini', 'mcp', 'demo')), ['modified', 'different']);
  assert.deepEqual(statuses(find('user', 'codex', 'mcp', 'demo')), ['missing', 'different']);
  assert.deepEqual(statuses(after.items.find((i) => i.id.at(-1) === 'extra')), ['missing', 'different']);
  assert.ok(after.items.filter((i) => i.vsCurrent !== 'match').length === 3);
  assert.ok(after.items.some((i) => i.id.at(-1) === 'a.b'));
  assert.ok(after.items.some((i) => i.id.slice(-2).join('/') === 'a/b'));
  assert.ok(!JSON.stringify(after).includes('private-'));

  write(md, fs.readFileSync(md, 'utf8').replace('Team instructions', 'Edited instructions'));
  const edited = observeItems(ctx, { state, outputs });
  assert.deepEqual(statuses(edited.items.find((i) => i.id.includes('GEMINI.md'))), ['modified', 'different']);
});

test('keeps independent evidence across unavailable inputs, diagnostic markers and forgotten keys', (t) => {
  const ctx = fixture(t);
  const file = path.join(ctx.paths.claudeHome, 'settings.json');
  write(file, '{"fixed":null,"region":"local","new":1,"again":1,"removed":0,"released":4}');
  const id = 'user|json|' + normalizeKey(file);
  const current = { type: 'json', path: file, id, adapters: new Set(['claude']), fragment: { fixed: null, region: 'local', new: 'placeholder', again: 1 } };
  const member = (key, value) => ({ path: [key], hash: valueHash(value) });
  const record = { scopeKey: 'user', type: 'json', path: file, adapters: ['claude'],
    managed: [member('fixed', null), member('region', 'old'), member('removed', 0), member('released', 4),
      { path: ['renewed', 'child'], hash: valueHash(1) }],
    forgotten: [{ path: ['again'] }, { path: ['renewed'] }] };
  const opts = { state: { outputs: { [id]: record } }, outputs: [current],
    commonOutputs: [{ ...current, fragment: { fixed: null, region: 'local', again: 1 } }],
    variableOutputs: [{ ...current, fragment: { ...current.fragment, region: 'with-diagnostic-marker' } }],
    variableMarker: 'diagnostic-marker', secretMarker: 'placeholder', forget: [{ path: file, entries: [{ path: ['released'] }] }] };
  const get = (obs, name) => obs.items.find((i) => i.id.at(-1) === name);
  const seen = observeItems(ctx, opts);
  assert.deepEqual(statuses(get(seen, 'fixed')), ['ok', 'match']);
  assert.deepEqual(statuses(get(seen, 'new')), ['unrecorded', 'unknown']);
  assert.equal(get(seen, 'new').osOnly, true);
  assert.deepEqual(statuses(get(seen, 'region')), ['modified', 'match']);
  assert.equal(get(seen, 'region').localVariable, true);
  assert.deepEqual(statuses(get(seen, 'removed')), ['ok', 'not_applicable']);
  assert.deepEqual(statuses(get(seen, 'child')), ['missing', 'not_applicable']);
  assert.deepEqual(statuses(get(seen, 'again')), ['unrecorded', 'match']);
  assert.equal(get(seen, 'released'), undefined);
  assert.deepEqual(seen.issues, [{ code: 'expected_value_unavailable', count: 1 }]);
  const withoutSource = observeItems(ctx, { ...opts, outputs: [], sourceKnown: false });
  assert.deepEqual(statuses(get(withoutSource, 'fixed')), ['ok', 'unknown']);
  assert.ok(withoutSource.items.every((i) => !i.osOnly && !i.localVariable));
  write(file, '{"broken source text":+++');
  const damaged = observeItems(ctx, { ...opts, variablesKnown: false, commonKnown: false });
  assert.deepEqual(statuses(get(damaged, 'fixed')), ['unknown', 'unknown']);
  assert.deepEqual(statuses(get(damaged, 'again')), ['unrecorded', 'unknown']);
  assert.ok(damaged.items.every((i) => !i.osOnly && !i.localVariable));
  assert.ok(damaged.issues.some((i) => i.code === 'item_parse_failed' && i.count === 1));
  assert.ok(!JSON.stringify(damaged).includes('broken source text'));
});

test('rejects ambiguous state IDs and keeps file paths separate from key paths', (t) => {
  const ctx = fixture(t);
  const root = ctx.paths.geminiHome;
  const output = (rel, fragment) => ({ type: 'json', path: path.join(root, ...rel), adapters: ['gemini'], fragment });
  const one = output(['path'], { key: { child: { key: { leaf: 1 } } } });
  const other = output(['path', 'key', 'child'], { key: { leaf: 1 } });
  const separate = observeItems(ctx, { outputs: [one, other] });
  assert.equal(separate.items.length, 2);
  assert.notDeepEqual(separate.items[0].id, separate.items[1].id);
  assert.deepEqual(separate.issues, []);
  const name = path.join(root, 'same.md');
  const rec = { type: 'file', scopeKey: 'user', path: name, adapters: ['gemini'], hash: sha256('sample') };
  const state = { outputs: { ['user|file|' + normalizeKey(name)]: rec, 'user|file|stale': rec } };
  const ambiguous = observeItems(ctx, { state });
  assert.deepEqual(ambiguous.items, []);
  assert.deepEqual(ambiguous.issues, [{ code: 'id_collision', count: 1 }]);
});

test('omits private identifiers and counts unsupported outputs once across both inputs', (t) => {
  const ctx = fixture(t);
  const file = path.join(ctx.paths.claudeHome, 'settings.json');
  const outputs = [
    { type: 'json', path: file, adapters: ['claude'], fragment: {
      env: { CANARY: 'hidden' }, 'fixture-host.notes': 'hidden', 'fixture-account.ini': 'hidden',
      'long-api-key': 'hidden', [ctx.paths.home]: 'hidden', public: true,
    } },
    { type: 'dir', path: path.join(ctx.paths.claudeHome, 'skills', 'private-skill'), adapters: ['claude'] },
    { type: 'claude-mcp', path: ctx.paths.claudeJson, scope: 'user', adapters: ['claude'] },
  ];
  const excluded = outputs.slice(1).map((o) => ({ ...o, id: o.type + '-fixture', scopeKey: 'user' }));
  const state = { outputs: Object.fromEntries(excluded.map((o) => [o.id, o])) };
  const seen = observeItems(ctx, { state, outputs: [outputs[0], ...excluded] });
  assert.deepEqual(seen.excluded, { dir: 1, 'claude-mcp': 1 });
  assert.equal(seen.items.length, 1);
  assert.equal(seen.items[0].id.at(-1), 'public');
  assert.deepEqual(seen.issues, [{ code: 'unsafe_identifier', count: 5 }]);
  assert.doesNotMatch(JSON.stringify(seen), /CANARY|fixture-account|fixture-host|private-skill|api-key|hidden/);
});

test('reads regular in-root links and rejects escaping path, file, ancestor and adapter-root links', { skip: process.platform === 'win32' }, (t) => {
  const ctx = fixture(t);
  const external = path.join(path.dirname(ctx.paths.home), 'external');
  write(path.join(external, 'value'), 'private');
  write(path.join(ctx.paths.codexHome, 'value'), 'visible');
  fs.symlinkSync('value', path.join(ctx.paths.codexHome, 'alias'));
  fs.symlinkSync(path.join(external, 'value'), path.join(ctx.paths.codexHome, 'leak'));
  fs.symlinkSync(external, path.join(ctx.paths.codexHome, 'outside'));
  fs.symlinkSync(external, ctx.paths.claudeHome);
  const targets = [path.join(external, 'value'), path.join(ctx.paths.claudeHome, 'value'), path.join(ctx.paths.codexHome, 'leak'),
    path.join(ctx.paths.codexHome, 'outside', 'absent'), path.join(ctx.paths.codexHome, 'alias')];
  const seen = observeItems(ctx, { outputs: targets.map((p) => ({ type: 'file', path: p, content: 'visible', adapters: ['home'] })) });
  assert.equal(seen.items.length, 1);
  assert.equal(seen.items[0].id.at(-1), 'alias');
  assert.deepEqual(statuses(seen.items[0]), ['unrecorded', 'match']);
  assert.deepEqual(seen.issues, [{ code: 'unsafe_path', count: 4 }]);
});

test('isolates unreadable state entries while retaining independent records and source observations', (t) => {
  const ctx = fixture(t);
  const names = ['null-record', 'invalid-owners', 'invalid-leaves', 'invalid-tables', 'invalid-member', 'healthy'];
  const outputs = names.map((name) => {
    const file = path.join(ctx.paths.codexHome, name);
    write(file, 'first = 1\nsecond = 2\n');
    return { id: 'user|toml|' + normalizeKey(file), type: 'toml', path: file, adapters: ['codex'], values: { first: 1, second: 2 } };
  });
  const first = { path: ['first'], hash: valueHash(1) };
  const second = { path: ['second'], hash: valueHash(2) };
  const records = outputs.map((o) => ({ scopeKey: 'user', path: o.path, type: o.type, adapters: ['codex'], managed: [first, second], tables: [] }));
  records[0] = null;
  records[1].adapters = { codex: true };
  records[2].managed = {};
  records[3].tables = 'unreadable';
  records[4].managed = [null, second];
  const state = { outputs: Object.fromEntries(outputs.map((o, i) => [o.id, records[i]])) };
  const seen = observeItems(ctx, { state, outputs });
  const get = (name, key) => seen.items.find((i) => i.id.includes(name) && i.id.at(-1) === key);
  assert.deepEqual(seen.issues, [{ code: 'invalid_state_record', count: 5 }]);
  assert.equal(seen.items.length, 12);
  for (const name of names.slice(0, 3)) {
    assert.deepEqual(statuses(get(name, 'first')), ['unknown', 'match']);
  }
  assert.deepEqual(statuses(get('invalid-member', 'first')), ['unknown', 'match']);
  assert.deepEqual(statuses(get('invalid-member', 'second')), ['ok', 'match']);
  assert.deepEqual(statuses(get('invalid-tables', 'first')), ['ok', 'match']);
  assert.deepEqual(statuses(get('healthy', 'first')), ['ok', 'match']);
  assert.deepEqual(statuses(get('healthy', 'second')), ['ok', 'match']);
});

test('uses the shared name guard on source and recorded item components without emitting private references', (t) => {
  const ctx = fixture(t);
  const file = path.join(ctx.paths.claudeHome, 'settings.json');
  const fragment = { public: 1, scoped: { orchid: 2 }, 'stable.private-iris': 3, 'fixture-account-item': 4 };
  const o = { type: 'json', id: 'user|json|' + normalizeKey(file), path: file, adapters: ['claude'], fragment };
  const managed = [['public'], ['scoped', 'orchid'], ['stable.private-iris'], ['fixture-account-item']].map((key, i) => ({ path: key, hash: valueHash(i + 1) }));
  const state = { outputs: { [o.id]: { ...o, scopeKey: 'user', managed } } };
  const privateNames = new Set(['services/orchid', 'private-iris']);
  const safe = shareableName(ctx, privateNames);
  assert.ok(safe('base'));
  assert.ok(!safe('orchid'));
  const result = observeItems(ctx, { state, outputs: [o], privateNames });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id.at(-1), 'public');
  assert.deepEqual(result.issues, [{ code: 'unsafe_identifier', count: 3 }]);
  assert.doesNotMatch(JSON.stringify(result), /orchid|private-iris|fixture-account/);
});

test('compares raw-copy UTF-8 line endings portably and preserves binary differences', (t) => {
  const ctx = fixture(t);
  const make = (name, before, now) => {
    const file = path.join(ctx.paths.home, name);
    write(file, now);
    const id = 'user|file|' + normalizeKey(file);
    return { id, type: 'file', path: file, scope: 'user', adapters: ['home'], content: before };
  };
  const docs = make('notes.md', Buffer.from('a\r\nb\r\n'), Buffer.from('a\nb\n'));
  const binary = make('image.bin', Buffer.from([0, 13, 10]), Buffer.from([0, 10]));
  const outputs = [docs, binary];
  const state = { outputs: Object.fromEntries(outputs.map((o) => [o.id, { scopeKey: 'user', type: o.type, path: o.path, adapters: o.adapters, hash: sha256(o.content) }])) };
  const report = observeItems(ctx, { state, outputs });
  assert.deepEqual(statuses(report.items.find((i) => i.id.at(-1) === 'notes.md')), ['ok', 'match']);
  assert.deepEqual(statuses(report.items.find((i) => i.id.at(-1) === 'image.bin')), ['modified', 'different']);
});
