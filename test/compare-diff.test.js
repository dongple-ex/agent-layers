import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareReports, formatComparison, resultCode, validateReport } from '../src/compare/diff.js';

const commit = 'a'.repeat(40);
const id = ['user', 'codex', 'mcp', 'demo'];

function item(fields = {}) {
  return { id: [...id], owners: ['codex'], vsApplied: 'ok', vsCurrent: 'match', osOnly: false, localVariable: false, ...fields };
}

function report(fields = {}) {
  return {
    format: 'agent-layers-pc-report', schemaVersion: 1, scope: 'user', os: 'linux', agentLayers: '0.1.9',
    sourceNow: [{ id: 'setup', commit, dirty: false }], sourceAtApply: null, layers: ['base'], selectedTargets: ['codex'],
    agents: [{ id: 'codex', detectedBy: 'command', version: null, runtimeLoad: 'unverified' }],
    items: [item()], coverage: 'complete', issues: [], excluded: {}, ...fields,
  };
}

function partial(code, fields = {}) {
  return report({ coverage: 'partial', issues: [{ code, count: 1 }], ...fields });
}

test('managed changes reproduce the v1 result, point to the affected PC and preserve TOML literal names', () => {
  const a = report({ os: 'windows' });
  const b = report({ items: [item({ vsApplied: 'modified', vsCurrent: 'different' })] });
  const result = compareReports(a, b);
  assert.equal(resultCode(result), 1);
  assert.deepEqual(result, {
    schemaVersion: 1, result: 'findings', coverage: 'complete', firstDifference: 'managed',
    findings: [{ stage: 'managed', id, a: { vsApplied: 'ok', vsCurrent: 'match' }, b: { vsApplied: 'modified', vsCurrent: 'different' } }],
    issues: [], excluded: {},
  });
  const text = formatComparison(a, b, result);
  assert.match(text, /A\s+windows\s+B\s+linux/);
  assert.match(text, /Inspect B .*Codex.*mcp_servers\.demo/);
  assert.match(text, /runtime|tool sessions/);
  a.items[0].id[3] = 'demo.one';
  b.items[0].id[3] = 'demo.one';
  assert.match(formatComparison(a, b, compareReports(a, b)), /mcp_servers\."demo\.one"/);
});

test('strict input validation rejects unknown fields, ambiguous identities and unsafe strings with one fixed error', () => {
  const privateText = '/private/test-value';
  const invalid = [
    null, [], report({ extra: privateText }), report({ schemaVersion: 2 }), report({ format: 'other' }), report({ scope: 'project' }),
    report({ os: 'linux\nother' }), report({ agentLayers: privateText }), report({ sourceAtApply: commit }),
    report({ sourceNow: [{ id: 'team', commit, dirty: false }] }), report({ sourceNow: [{ id: 'extends:', commit, dirty: false }] }),
    report({ sourceNow: [{ id: 'setup', commit: privateText, dirty: false }] }), report({ sourceNow: [{ id: 'setup', commit, dirty: 1 }] }),
    report({ sourceNow: [{ id: 'setup', commit, dirty: false, url: privateText }] }),
    report({ layers: ['base', 'base'] }), report({ selectedTargets: ['codex', 'codex'] }), report({ coverage: 'full' }),
    report({ agents: [{ ...report().agents[0], version: '1' }] }), report({ agents: [{ ...report().agents[0], runtimeLoad: 'verified' }] }),
    report({ agents: [{ ...report().agents[0], detectedBy: 'socket' }] }), report({ agents: [{ ...report().agents[0], path: privateText }] }),
    report({ items: [item({ owners: ['codex', 'codex'] })] }), report({ items: [item({ owners: [privateText] })] }),
    report({ items: [item({ vsCurrent: 'absent' })] }), report({ items: [item({ vsApplied: 'absent' })] }),
    report({ items: [item({ osOnly: 1 })] }), report({ items: [item({ localVariable: null })] }), report({ items: [item({ hash: privateText })] }),
    report({ issues: [{ code: 'unsafe name', count: 1 }] }), report({ issues: [{ code: 'issue', count: 0 }] }),
    report({ issues: [{ code: 'issue', count: 1, error: privateText }] }), report({ excluded: { dir: 1.5 } }),
    report({ excluded: { [privateText]: 2 } }), report({ excluded: JSON.parse('{"__proto__": 1}') }),
  ];
  for (const badId of [[], ['user'], ['user', 'codex'], id.slice(0, 3), [...id, 'extra'],
    ['project', ...id.slice(1)], ['user', 'codex', 'file', '..'], ['user', 'codex', 'file', privateText],
    ['user', 'codex', 'block', 'AGENTS.md'], ['user', 'codex', 'toml', '2', 'config.toml', 'model'],
    ['user', 'codex', 'json', '0', 'model'], ['user', 'codex', 'json', '01', 'config.json', 'model']]) {
    invalid.push(report({ items: [item({ id: badId })] }));
  }
  for (const field of ['sourceNow', 'agents', 'items', 'issues']) {
    const value = partial('state_unavailable');
    value[field].push(structuredClone(value[field][0]));
    invalid.push(value);
  }
  const missing = report();
  delete missing.items[0].owners;
  invalid.push(missing);
  for (const value of invalid) {
    assert.throws(() => compareReports(report(), value), {
      name: 'Error', message: 'Invalid PC comparison report. Expected a user-scope version 1 report with valid, unique entries.',
    });
  }
  const other = report({ os: 'freebsd', sourceNow: [{ id: 'extends:company', commit: 'b'.repeat(64), dirty: null }] });
  assert.equal(validateReport(other), other);
});

test('external reports reject credential-shaped logical names and managed value hashes before producing output', () => {
  for (const name of ['DEMO_API_KEY', 'a'.repeat(64), 'b'.repeat(16)]) {
    for (const value of [
      report({ items: [item({ id: ['user', 'codex', 'mcp', name] })] }),
      report({ layers: [name] }),
      report({ sourceNow: [{ id: 'extends:' + name, commit, dirty: false }] }),
    ]) {
      assert.throws(() => compareReports(report(), value), /^Error: Invalid PC comparison report\./);
    }
  }
});

test('source, selection and managed evidence are kept together in stage order', () => {
  const a = report({ layers: ['team', 'base'] });
  const b = partial('item_parse_failed', {
    sourceNow: [{ id: 'setup', commit: 'b'.repeat(40), dirty: false }],
    layers: ['base', 'team'], selectedTargets: ['codex', 'gemini'],
    items: [item({ vsApplied: 'missing', vsCurrent: 'unknown' })],
  });
  const result = compareReports(a, b);
  assert.equal(resultCode(result), 1);
  assert.equal(result.coverage, 'partial');
  assert.equal(result.firstDifference, 'source');
  assert.deepEqual(result.findings.map((entry) => entry.stage), ['source', 'source', 'selection', 'managed']);
  const text = formatComparison(a, b, result);
  assert.match(text, /Source setup/);
  assert.match(text, /Layers in application order/);
  assert.match(text, /Selected targets.*gemini/);
  assert.match(text, /Unverified B\s+item_parse_failed/);
});

test('set-like input order and environment facts do not change results; layer order is semantic', () => {
  const a = partial('item_read_failed', {
    sourceNow: [...report().sourceNow, { id: 'extends:team', commit, dirty: false }],
    layers: ['team', 'base'], selectedTargets: ['codex', 'gemini'],
    agents: [...report().agents, { ...report().agents[0], id: 'gemini' }],
    items: [item({ owners: ['codex', 'gemini'], vsApplied: 'modified' }), item({ id: ['user', 'gemini', 'file', 'one'] })],
    issues: [{ code: 'item_read_failed', count: 2 }, { code: 'item_parse_failed', count: 1 }], excluded: { dir: 1, 'claude-mcp': 2 },
  });
  const b = structuredClone(a);
  b.os = 'windows';
  b.agentLayers = '1.0.0-beta.2+build.1';
  b.agents[0].detectedBy = 'none';
  const expected = compareReports(a, b);
  const expectedText = formatComparison(a, b, expected);
  const before = JSON.stringify(a);
  for (const field of ['sourceNow', 'selectedTargets', 'agents', 'items', 'issues']) {
    b[field].reverse();
  }
  b.items.forEach((entry) => entry.owners.reverse());
  b.excluded = { 'claude-mcp': 2, dir: 1 };
  assert.equal(JSON.stringify(compareReports(a, b)), JSON.stringify(expected));
  assert.equal(formatComparison(a, b, compareReports(a, b)), expectedText);
  assert.equal(JSON.stringify(a), before);
  assert.equal(expected.firstDifference, null);
  b.layers.reverse();
  assert.equal(compareReports(a, b).firstDifference, 'source');
});

test('missing source or selection data cannot establish removals; unrelated Git failure preserves observed selection', () => {
  const a = report({ sourceNow: [...report().sourceNow, { id: 'extends:team', commit, dirty: false }], layers: ['team', 'base'] });
  const unavailable = partial('source_unavailable', { sourceNow: [], layers: [], selectedTargets: [], items: [] });
  const comparison = compareReports(a, unavailable);
  assert.equal(comparison.firstDifference, null);
  assert.equal(resultCode(comparison), 3);
  const selection = partial('selection_unavailable', { layers: [], selectedTargets: [] });
  assert.equal(compareReports(report(), selection).firstDifference, null);
  const absentGit = partial('git_unavailable', { sourceNow: [{ id: 'setup', commit: null, dirty: null }], selectedTargets: [] });
  assert.equal(compareReports(report(), absentGit).firstDifference, 'selection');
  unavailable.items = [item({ vsApplied: 'missing', vsCurrent: 'unknown' })];
  assert.equal(compareReports(a, unavailable).firstDifference, 'managed');
});

test('dirty and unknown Git evidence never masks independently confirmed revisions or local differences', () => {
  const a = report({ sourceNow: [{ id: 'setup', commit, dirty: true }] });
  const same = compareReports(a, a);
  assert.equal(resultCode(same), 3);
  assert.ok(same.issues.some((issue) => issue.code === 'source_contents_unverified'));
  const b = report({ sourceNow: [{ id: 'setup', commit: null, dirty: null }], items: [item({ vsCurrent: 'different' })] });
  assert.equal(compareReports(a, b).firstDifference, 'managed');
  b.sourceNow[0].commit = 'b'.repeat(40);
  assert.equal(compareReports(a, b).firstDifference, 'source');
  assert.equal(compareReports(a, report()).firstDifference, 'source');
});

test('a one-sided item is unknown when the missing inventory could be incomplete; a known record is still compared', () => {
  const a = report();
  for (const code of ['state_unavailable', 'expected_unavailable', 'unsafe_identifier', 'id_collision', 'optional_layer_unavailable', 'source_incomplete']) {
    const b = partial(code, { items: [] });
    const result = compareReports(a, b);
    assert.equal(resultCode(result), 3, code);
    assert.equal(result.firstDifference, null, code);
    assert.deepEqual(result.issues.find((entry) => entry.id)?.b, { vsApplied: 'unknown', vsCurrent: 'unknown' });
  }
  const local = report({ items: [item({ vsApplied: 'modified' })] });
  const b = partial('state_unavailable', { items: [] });
  assert.equal(resultCode(compareReports(local, b)), 1);
  assert.equal(compareReports(local, b).firstDifference, null);
  b.items = [item({ vsApplied: 'unknown', vsCurrent: 'different' })];
  assert.equal(compareReports(a, b).firstDifference, 'managed');
  assert.equal(compareReports(a, partial('git_unavailable', { items: [] })).firstDifference, 'managed');
  assert.equal(compareReports(a, partial('expected_value_unavailable', { items: [] })).firstDifference, 'managed');
});

test('equal local drift, missing baselines and differing records are distinct outcomes', () => {
  for (const vsApplied of ['missing', 'modified']) {
    const a = report({ items: [item({ vsApplied, vsCurrent: 'different' })] });
    const result = compareReports(a, a);
    assert.equal(resultCode(result), 1);
    assert.equal(result.firstDifference, null);
    assert.match(formatComparison(a, a, result), /Inspect A and B/);
  }
  const empty = report({ items: [item({ vsApplied: 'unrecorded' })] });
  assert.equal(resultCode(compareReports(empty, empty)), 3);
  assert.ok(compareReports(empty, empty).issues.some((issue) => issue.code === 'apply_record_unverified'));
  assert.equal(compareReports(empty, report()).firstDifference, 'managed');
});

test('intentional OS-only items explain their applicable side with both absent and retained opposite records', () => {
  const a = report({ os: 'windows', items: [item({ osOnly: true })] });
  for (const items of [[], [item({ vsApplied: 'unrecorded', vsCurrent: 'not_applicable' })], [item({ vsCurrent: 'not_applicable' })]]) {
    const b = report({ items });
    for (const [left, right, label] of [[a, b, 'A'], [b, a, 'B']]) {
      const result = compareReports(left, right);
      assert.equal(resultCode(result), 0);
      assert.equal(result.coverage, 'complete');
      assert.equal(result.firstDifference, null);
      assert.equal(result.notes[0].applicable, label);
      assert.match(formatComparison(left, right, result), /Expected OS variation.*same clean source and target selection/);
    }
  }
  const drift = report({ items: [item({ vsApplied: 'missing', vsCurrent: 'not_applicable' })] });
  assert.equal(compareReports(a, drift).firstDifference, 'managed');
});

test('OS exceptions require a clean matching source, ordered layers, selection and a verified applicable side', () => {
  const a = report({ os: 'windows', items: [item({ osOnly: true })] });
  const b = report({ items: [] });
  const unknownGit = { id: 'setup', commit: null, dirty: null };
  const dirtyGit = { id: 'setup', commit, dirty: true };
  const cases = [
    [a, { ...b, os: 'windows' }], [a, { ...b, layers: ['other'] }], [a, { ...b, selectedTargets: [] }],
    [a, { ...b, sourceNow: [{ id: 'setup', commit: 'b'.repeat(40), dirty: false }] }],
    [{ ...a, sourceNow: [unknownGit] }, { ...b, sourceNow: [unknownGit] }],
    [{ ...a, sourceNow: [dirtyGit] }, { ...b, sourceNow: [dirtyGit] }],
    [a, partial('state_unavailable', { items: [] })], [a, partial('provenance_unavailable', { items: [] })],
    [a, partial('selection_unavailable', { items: [] })],
    [report({ os: 'windows' }), b],
  ];
  for (const fields of [{ vsApplied: 'modified' }, { vsApplied: 'missing' }, { vsApplied: 'unrecorded' }, { vsCurrent: 'different' }, { vsCurrent: 'unknown' }]) {
    cases.push([{ ...a, items: [item({ osOnly: true, ...fields })] }, b]);
  }
  for (const [left, right] of cases) {
    const result = compareReports(left, right);
    assert.notEqual(resultCode(result), 0);
    assert.equal(result.notes, undefined);
  }
});

test('matching PC-specific variables and unsupported-only reports retain their distinct reasons', () => {
  const variable = report({ items: [item({ localVariable: true })] });
  const result = compareReports(variable, report());
  assert.equal(resultCode(result), 3);
  assert.equal(result.coverage, 'partial');
  assert.deepEqual(result.issues[0].a, { vsApplied: 'ok', vsCurrent: 'match' });
  const a = report({ items: [], excluded: { dir: 2 } });
  const b = report({ items: [], excluded: { 'claude-mcp': 1 } });
  const empty = compareReports(a, b);
  assert.equal(resultCode(empty), 3);
  assert.match(formatComparison(a, b, empty), /Neither report contains a supported managed item/);
  assert.match(formatComparison(a, b, empty), /Excluded B\s+claude-mcp \(1\)/);
  assert.equal(resultCode(compareReports(report({ excluded: { dir: 4 } }), report())), 0);
});

test('shared owners, retained records and dotted versus nested JSON keys remain identifiable', () => {
  const ids = [
    ['user', 'config', 'json', '2', 'tool', 'settings.json', 'a.b'],
    ['user', 'config', 'json', '2', 'tool', 'settings.json', 'a', 'b'],
    ['user', 'agents', 'block', 'AGENTS.md', 'base'],
  ];
  const items = ids.map((id) => item({ id, owners: ['codex', 'gemini'] }));
  const a = report({ items });
  const b = report({ items: items.map((entry) => ({ ...entry, vsCurrent: 'not_applicable' })), selectedTargets: [] });
  const result = compareReports(a, b);
  assert.equal(result.firstDifference, 'selection');
  assert.equal(result.findings.filter((finding) => finding.stage === 'managed').length, 3);
  const text = formatComparison(a, b, result);
  assert.match(text, /managed block base/);
  assert.match(text, /tool\/settings\.json, JSON key \["a\.b"\]/);
  assert.match(text, /tool\/settings\.json, JSON key a\.b/);
  assert.match(text, /Owners\s+A\s+codex, gemini/);
  assert.match(text, /B has an apply record/);
});

test('known inventory changes survive an unrelated disk read failure, and omitted owners require a complete inventory', () => {
  const observed = partial('item_read_failed', { items: [item({ id: ['user', 'codex', 'file', 'other'], vsApplied: 'unknown' })] });
  const healthy = report();
  const result = compareReports(healthy, observed);
  assert.ok(result.findings.some((entry) => entry.id?.at(-1) === 'demo'));
  const shared = report({ items: [item({ owners: ['codex', 'gemini'] })] });
  const partialOwners = partial('state_unavailable', { items: [item({ vsApplied: 'unknown' })] });
  const unknown = compareReports(shared, partialOwners);
  assert.equal(unknown.firstDifference, null);
  assert.equal(resultCode(unknown), 3);
  assert.equal(compareReports(shared, healthy).firstDifference, 'managed');
});

test('a positively identified extra source can still have incomplete Git evidence', () => {
  const a = report({ sourceNow: [...report().sourceNow, { id: 'extends:team', commit: null, dirty: null }] });
  const b = report();
  const result = compareReports(a, b);
  assert.equal(result.firstDifference, 'source');
  assert.equal(result.coverage, 'partial');
  assert.equal(resultCode(result), 1);
});

test('the human output locates an inconclusive item and identifies an observed apply record difference', () => {
  const a = report();
  const unknown = report({ items: [item({ vsCurrent: 'unknown' })] });
  assert.match(formatComparison(a, unknown, compareReports(a, unknown)), /Inspect B .*mcp_servers\.demo/);
  const unrecorded = report({ items: [item({ vsApplied: 'unrecorded' })] });
  assert.match(formatComparison(a, unrecorded, compareReports(a, unrecorded)), /Apply record.*A.*B/);
});
