import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml, parseTomlValue, TomlDocument, tomlValue, TomlError } from '../src/formats/toml.js';
import { parseJsonc, stripJsonc } from '../src/formats/jsonc.js';
import { splitFrontmatter, joinFrontmatter, parseYaml } from '../src/formats/frontmatter.js';
import { upsertBlock, getBlockContent, removeBlock, listBlockIds } from '../src/formats/mdblock.js';
import { planManagedMerge } from '../src/formats/jsonmerge.js';
import { lineDiff } from '../src/util/diff.js';
import { normalizeEol, encodeText } from '../src/util/fsx.js';

const CODEX_LIKE = `model = "gpt-x"
model_reasoning_effort = "high"
notify = [ "C:\\\\tools\\\\notify.exe", "turn-ended" ]
[projects.'c:\\work\\a']
trust_level = "trusted"

[features]
memories = true

[tui]
status_line = [
  "model-with-reasoning",
  "project", # trailing comment
]

[memories]
generate_memories = true

mcp_servers.servicenow.enabled = true
features.js_repl = true

[mcp_servers.node_repl]
args = []
command = 'C:\\Users\\me\\node_repl.exe'

[mcp_servers.node_repl.env]
CODEX_HOME = 'C:\\Users\\me\\.codex'
`;

test('toml: parses a codex-like config with literal paths, multi-line arrays and dotted keys', () => {
  const v = parseTomlValue(CODEX_LIKE);
  assert.equal(v.model, 'gpt-x');
  assert.deepEqual(v.notify, ['C:\\tools\\notify.exe', 'turn-ended']);
  assert.equal(v.projects['c:\\work\\a'].trust_level, 'trusted');
  assert.deepEqual(v.tui.status_line, ['model-with-reasoning', 'project']);
  assert.equal(v.memories.mcp_servers.servicenow.enabled, true);
  assert.equal(v.memories.features.js_repl, true);
  assert.equal(v.mcp_servers.node_repl.command, 'C:\\Users\\me\\node_repl.exe');
  assert.equal(v.mcp_servers.node_repl.env.CODEX_HOME, 'C:\\Users\\me\\.codex');
});

test('toml: rejects duplicate tables and keys', () => {
  assert.throws(() => parseToml('[a]\nx = 1\n[a]\ny = 2\n'), TomlError);
  assert.throws(() => parseToml('x = 1\nx = 2\n'), TomlError);
  assert.throws(() => parseToml('a.b = 1\n[a]\nc = 2\n'), TomlError);
});

test('toml: __proto__ keys are rejected and never reach Object.prototype', () => {
  const cases = ['[__proto__]\nx = 1\n', '[[__proto__]]\nx = 1\n', 'a.__proto__.b = 1\n', 'a = { __proto__ = 1 }\n', '"__proto__" = { x = 1 }\n'];
  for (const src of cases) {
    assert.throws(() => parseTomlValue(src), TomlError, src);
    assert.throws(() => new TomlDocument(src), TomlError, src);
  }
  assert.throws(() => new TomlDocument('a = 1\n').setTable(['__proto__'], { x: 1 }), TomlError);
  assert.equal({}.x, undefined);
  assert.equal({}.b, undefined);
});

test('toml: strings, numbers, inline tables, multi-line strings', () => {
  const v = parseTomlValue('s = "a\\tb\\u00e9"\nl = \'C:\\x\'\nm = """\nline1\nline2"""\nn = 1_000\nf = 3.5e2\nh = 0xff\nt = { a = 1, b.c = "x" }\nd = 1979-05-27 07:32:00Z\n');
  assert.equal(v.s, 'a\tb\u00e9');
  assert.equal(v.l, 'C:\\x');
  assert.equal(v.m, 'line1\nline2');
  assert.equal(v.n, 1000);
  assert.equal(v.f, 350);
  assert.equal(v.h, 255);
  assert.deepEqual(v.t, { a: 1, b: { c: 'x' } });
  assert.equal(v.d, '1979-05-27 07:32:00Z');
});

test('toml editor: update root key keeps comments and other tables', () => {
  const doc = new TomlDocument(CODEX_LIKE);
  doc.set(['model'], 'gpt-y');
  doc.set(['tui', 'status_line'], ['project', 'git-branch']);
  const out = doc.toString();
  assert.match(out, /^model = "gpt-y"$/m);
  assert.match(out, /^status_line = \["project", "git-branch"\]$/m);
  assert.ok(!out.includes('trailing comment'));
  assert.match(out, /\[projects\.'c:\\work\\a'\]/);
  const v = parseTomlValue(out);
  assert.deepEqual(v.tui.status_line, ['project', 'git-branch']);
  assert.equal(v.mcp_servers.node_repl.env.CODEX_HOME, 'C:\\Users\\me\\.codex');
});

test('toml editor: add root key goes before the first table', () => {
  const doc = new TomlDocument(CODEX_LIKE);
  doc.set(['approval_policy'], 'on-request');
  const v = parseTomlValue(doc.toString());
  assert.equal(v.approval_policy, 'on-request');
  assert.equal(v.memories.approval_policy, undefined);
});

test('toml editor: add key into existing table and into a new table', () => {
  const doc = new TomlDocument(CODEX_LIKE);
  doc.set(['features', 'multi_agent'], true);
  doc.set(['shell_environment_policy', 'inherit'], 'core');
  const v = parseTomlValue(doc.toString());
  assert.equal(v.features.multi_agent, true);
  assert.equal(v.features.memories, true);
  assert.equal(v.shell_environment_policy.inherit, 'core');
});

test('toml editor: dotted-key host is reused instead of adding a conflicting header', () => {
  const doc = new TomlDocument('a.x = 1\n\n[b]\ny = 2\n');
  doc.set(['a', 'z'], 3);
  const v = parseTomlValue(doc.toString());
  assert.deepEqual(v.a, { x: 1, z: 3 });
  assert.ok(!/^\[a\]$/m.test(doc.toString()));
});

test('toml editor: inline table parent is rewritten', () => {
  const doc = new TomlDocument('[mcp_servers.x]\nenv = { A = "1" }\n');
  doc.set(['mcp_servers', 'x', 'env', 'B'], '2');
  const v = parseTomlValue(doc.toString());
  assert.deepEqual(v.mcp_servers.x.env, { A: '1', B: '2' });
});

test('toml editor: setTable replaces a table with subtables and removeTable deletes it', () => {
  const doc = new TomlDocument(CODEX_LIKE);
  doc.setTable(['mcp_servers', 'node_repl'], { command: 'node', args: ['x.js'], env: { K: 'v' } });
  let v = parseTomlValue(doc.toString());
  assert.deepEqual(v.mcp_servers.node_repl, { command: 'node', args: ['x.js'], env: { K: 'v' } });
  doc.setTable(['mcp_servers', 'demo'], { command: 'npx', args: ['-y', 'demo'] });
  v = parseTomlValue(doc.toString());
  assert.equal(v.mcp_servers.demo.command, 'npx');
  assert.equal(doc.removeTable(['mcp_servers', 'demo']), true);
  v = parseTomlValue(doc.toString());
  assert.equal(v.mcp_servers.demo, undefined);
  assert.equal(v.mcp_servers.node_repl.command, 'node');
});

test('toml editor: comments attached to the next table survive replace, remove and insert', () => {
  const src = 'model = "a"\n\n# about tables below\n[mcp_servers.svc]\ncommand = "x"\n\n# my notes for b\n[b]\nk = 1\n';
  const doc = new TomlDocument(src);
  doc.set(['approval_policy'], 'never');
  doc.setTable(['mcp_servers', 'svc'], { command: 'y', args: [] });
  assert.match(doc.toString(), /# my notes for b\n\[b\]/);
  assert.match(doc.toString(), /# about tables below\n\[mcp_servers\.svc\]/);
  assert.match(doc.toString(), /approval_policy = "never"\n\n# about tables below/);
  doc.removeTable(['mcp_servers', 'svc']);
  assert.match(doc.toString(), /# my notes for b\n\[b\]\nk = 1/);
  doc.set(['mcp_servers', 'svc', 'command'], 'z');
  assert.match(doc.toString(), /# my notes for b\n\[b\]/);
  assert.equal(parseTomlValue(doc.toString()).b.k, 1);
});

test('mdblock: markers match whole lines only', () => {
  let t = upsertBlock('', 'project.acme-v2', 'v2 entry', { style: 'hash' });
  t = upsertBlock(t, 'project.acme', 'acme entry', { style: 'hash' });
  assert.equal(getBlockContent(t, 'project.acme-v2', 'hash'), 'v2 entry');
  assert.equal(getBlockContent(t, 'project.acme', 'hash'), 'acme entry');
  t = upsertBlock(t, 'project.acme', 'acme changed', { style: 'hash' });
  assert.equal(getBlockContent(t, 'project.acme-v2', 'hash'), 'v2 entry');
  t = removeBlock(t, 'project.acme', 'hash');
  assert.equal(getBlockContent(t, 'project.acme-v2', 'hash'), 'v2 entry');
});

test('toml editor: remove key and empty document handling', () => {
  const doc = new TomlDocument('');
  doc.set(['model'], 'm');
  doc.set(['features', 'x'], true);
  assert.equal(doc.toString(), 'model = "m"\n\n[features]\nx = true\n');
  doc.remove(['model']);
  assert.equal(parseTomlValue(doc.toString()).model, undefined);
});

test('toml value serialization', () => {
  assert.equal(tomlValue('C:\\a\\b'), "'C:\\a\\b'");
  assert.equal(tomlValue('say "hi"'), '"say \\"hi\\""');
  assert.equal(tomlValue({ 'a.b': 1, c: [true, 2] }), '{ "a.b" = 1, c = [true, 2] }');
});

test('jsonc: comments and trailing commas', () => {
  const text = '{\n  // line\n  "a": "http://x", /* block */\n  "b": [1, 2,],\n}\n';
  assert.deepEqual(parseJsonc(text), { a: 'http://x', b: [1, 2] });
  assert.equal(stripJsonc('"//not a comment"'), '"//not a comment"');
});

test('jsonc: commas followed by comments are handled in linear time', () => {
  const lines = [];
  for (let i = 0; i < 200; i += 1) {
    lines.push(`  "key${i}": ${i}, // note ${i}`);
  }
  const text = `{\n${lines.join('\n')}\n  "last": true, /* end */\n}\n`;
  const t0 = Date.now();
  const v = parseJsonc(text);
  assert.ok(Date.now() - t0 < 1000, `parsing took ${Date.now() - t0} ms`);
  assert.equal(Object.keys(v).length, 201);
  assert.deepEqual(parseJsonc('{\n  "a": [1, 2, // two\n  ],\n  "b": 3, // three\n}\n'), { a: [1, 2], b: 3 });
  assert.deepEqual(parseJsonc('{\n  "a": 1, // note\n  ,\n}\n'), { a: 1 });
  assert.throws(() => parseJsonc('{\n  "a": 1,\n  ,\n}\n'), /invalid JSON/);
  const t1 = Date.now();
  assert.deepEqual(parseJsonc(`[1${', // c\n'.repeat(2000)}]`), [1]);
  assert.ok(Date.now() - t1 < 1000, `parsing took ${Date.now() - t1} ms`);
});

test('frontmatter: yaml subset', () => {
  const md = '---\nname: my-skill\ndescription: >\n  Folded text\n  continues here\ntargets: [claude, codex]\npaths:\n  - "src/**/*.ts"\n  - docs/*.md\nmetadata:\n  version: 1.2\n  author: someone\n---\n\n# Body\n';
  const { data, body } = splitFrontmatter(md);
  assert.equal(data.name, 'my-skill');
  assert.equal(data.description, 'Folded text continues here\n');
  assert.deepEqual(data.targets, ['claude', 'codex']);
  assert.deepEqual(data.paths, ['src/**/*.ts', 'docs/*.md']);
  assert.deepEqual(data.metadata, { version: 1.2, author: 'someone' });
  assert.equal(body, '# Body\n');
  const round = splitFrontmatter(joinFrontmatter({ description: 'a: b', applyTo: '**' }, 'x'));
  assert.deepEqual(round.data, { description: 'a: b', applyTo: '**' });
  assert.deepEqual(parseYaml('list:\n- a\n- b\n'), { list: ['a', 'b'] });
});

test('mdblock: upsert preserves foreign content and other blocks', () => {
  const foreign = '<!-- BEGIN:nextjs-agent-rules -->\nnext rules\n<!-- END:nextjs-agent-rules -->\n\n# My notes\n';
  let t = upsertBlock(foreign, 'base', 'rule A');
  assert.ok(t.startsWith(foreign.trimEnd()));
  assert.equal(getBlockContent(t, 'base'), 'rule A');
  t = upsertBlock(t, 'base', 'rule B');
  assert.equal(getBlockContent(t, 'base'), 'rule B');
  t = upsertBlock(t, 'project.demo', 'proj');
  assert.deepEqual(listBlockIds(t), ['base', 'project.demo']);
  t = removeBlock(t, 'base');
  assert.equal(getBlockContent(t, 'base'), null);
  assert.ok(t.includes('# My notes'));
});

test('jsonmerge: managed keys, removal and drift', () => {
  const current = { theme: 'dark', model: 'old', mcpServers: { mine: { command: 'a' } } };
  const first = planManagedMerge(current, { model: 'opus', mcpServers: { tool: { command: 'x', args: ['1'] } } }, { atomic: [['mcpServers', '*']] });
  assert.equal(first.result.theme, 'dark');
  assert.equal(first.result.model, 'opus');
  assert.deepEqual(first.result.mcpServers.tool, { command: 'x', args: ['1'] });
  assert.deepEqual(first.result.mcpServers.mine, { command: 'a' });
  const second = planManagedMerge(first.result, { model: 'opus' }, { atomic: [['mcpServers', '*']], previous: first.managed });
  assert.equal(second.result.mcpServers.tool, undefined);
  assert.deepEqual(second.result.mcpServers.mine, { command: 'a' });
  const edited = { ...second.result, model: 'user-changed' };
  const third = planManagedMerge(edited, { model: 'opus' }, { previous: second.managed });
  assert.equal(third.drift.length, 1);
});

test('diff and eol helpers', () => {
  assert.equal(lineDiff('a\nb\nc', 'a\nb\nc').length, 0);
  const hs = lineDiff('a\nb\nc', 'a\nB\nc');
  assert.equal(hs.length, 1);
  assert.equal(normalizeEol('x\r\r\ny\r\n'), 'x\ny\n');
  assert.equal(encodeText('a\nb\n', { eol: 'crlf' }), 'a\r\nb\r\n');
});
