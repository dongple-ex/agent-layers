import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashJson, PROGRAM_PLAN_FIELDS } from '../src/workflow/schema.js';
import {
  createRun, readRun, acquireRun, commitRun, releaseRun, runDir, workflowsDir, isSecretKey, sanitizeEventData,
  findSecretAssignment, REDACTED_TEXT,
  chargeAgentCall, addActiveSeconds, addRepairAttempt, recordFailure, clearFailure, remainingBudget, writeArtifact, readArtifact,
} from '../src/workflow/store.js';

const BIN = fileURLToPath(new URL('../bin/agent-layers.js', import.meta.url));
const STORE_URL = new URL('../src/workflow/store.js', import.meta.url).href;
const IS_LINUX = process.platform === 'linux';

const POLICY = {
  schemaVersion: 1,
  provider: { id: 'codex', model: 'test-model', reasoningEffort: 'high' },
  allowedWritePaths: ['src', 'test'],
  checks: [{ id: 'unit', command: 'npm', args: ['test'], timeout: 600 }],
  requiredChecks: ['unit'],
};

const PLAN = {
  schemaVersion: 1,
  goal: 'Add input validation',
  steps: [
    { id: 'impl', role: 'coder', dependsOn: [], instruction: 'Implement', writePaths: ['src/a.js'], checkIds: ['unit'], acceptance: ['Rejects bad input'] },
    { id: 'tests', role: 'coder', dependsOn: ['impl'], instruction: 'Test', writePaths: ['test/a.test.js'], checkIds: ['unit'], acceptance: ['Covers bad input'] },
  ],
};

function tempCtx(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ctx: { paths: { stateDir: path.join(root, 'state') } } };
}

function newRun(ctx, extra = {}) {
  return createRun(ctx, {
    plan: PLAN,
    policy: POLICY,
    usedAgentCalls: 1,
    planRepairs: 0,
    baseCommit: 'a'.repeat(40),
    providerFingerprint: 'codex-test 0.0.0',
    workspaceKey: 'workspace-1',
    ...extra,
  });
}

function events(dir) {
  return fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
}

function hashTree(dir) {
  const out = {};
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else {
        out[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(dir);
  return out;
}

function lockFiles(ctx, runId) {
  const locks = path.join(workflowsDir(ctx), 'locks');
  return [
    ...(fs.existsSync(path.join(runDir(ctx, runId), 'lock')) ? ['run'] : []),
    ...(fs.existsSync(locks) ? fs.readdirSync(locks) : []),
  ];
}

function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

function writeOwner(file, owner) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ runId: 'x', ownerId: crypto.randomUUID(), hostname: os.hostname(), processStart: null, acquiredAt: 'x', ...owner }));
}

test('workflow store: createRun writes plan, policy, state and the first event with checkable hashes', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  const plan = JSON.parse(fs.readFileSync(path.join(run.dir, 'plan.json'), 'utf8'));
  const modelPart = Object.fromEntries(Object.keys(plan).filter((k) => !PROGRAM_PLAN_FIELDS.includes(k)).map((k) => [k, plan[k]]));
  assert.equal(hashJson(modelPart), run.planHash);
  assert.equal(plan.planHash, run.planHash);
  assert.equal(plan.runId, run.runId);
  const state = readState(run.dir);
  assert.equal(state.status, 'PLANNED');
  assert.deepEqual(state.order, ['impl', 'tests', 'review', 'audit']);
  assert.deepEqual(state.steps.review, { status: 'PENDING', attempts: 0 });
  assert.equal(state.budget.agentCalls, 1);
  assert.equal(state.lastSeq, 1);
  assert.deepEqual(events(run.dir).map((e) => [e.seq, e.type]), [[1, 'run.created']]);
  assert.deepEqual(readRun(ctx, run.runId).issues, []);
  if (IS_LINUX) {
    assert.equal(fs.statSync(path.join(run.dir, 'state.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(run.dir).mode & 0o777, 0o700);
  }
});

test('workflow store: invalid policy, plan and run inputs are refused before anything is written', (t) => {
  const { ctx } = tempCtx(t);
  assert.throws(() => newRun(ctx, { policy: { ...POLICY, checks: [] } }), (err) => err.code === 'E_WORKFLOW_INVALID' && err.issues.length > 0);
  assert.throws(() => newRun(ctx, { plan: { ...PLAN, runId: 'x' } }), (err) => err.code === 'E_WORKFLOW_INVALID' && err.issues[0].where === 'runId');
  assert.throws(() => newRun(ctx, { baseCommit: 'HEAD' }), /baseCommit/);
  assert.throws(() => newRun(ctx, { planRepairs: 2 }), /planRepairs/);
  assert.throws(() => newRun(ctx, { workspaceKey: '' }), /workspaceKey/);
  assert.equal(fs.existsSync(workflowsDir(ctx)), false);
});

test('workflow store: run ids must be lowercase UUID v4 before they become paths', (t) => {
  const { ctx } = tempCtx(t);
  for (const bad of ['../x', 'A0000000-0000-4000-8000-000000000000', '00000000-0000-1000-8000-000000000000', '', null]) {
    assert.throws(() => runDir(ctx, bad), (err) => err.code === 'E_WORKFLOW_BAD_RUN_ID', String(bad));
  }
  assert.throws(() => readRun(ctx, crypto.randomUUID()), (err) => err.code === 'E_WORKFLOW_NOT_FOUND');
});

test('workflow store: events come first, state follows, and invalid states are never written', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  const h = acquireRun(ctx, run.runId);
  commitRun(h, 'step.started', { step: 'impl' }, (s) => {
    s.status = 'RUNNING';
    s.steps.impl.status = 'RUNNING';
  });
  const before = fs.readFileSync(path.join(run.dir, 'events.jsonl'), 'utf8');
  assert.throws(() => commitRun(h, 'step.bad', {}, (s) => {
    s.steps.impl.status = 'DONE';
  }), (err) => err.code === 'E_WORKFLOW_INVALID_STATE');
  assert.throws(() => commitRun(h, 'step.bad', {}, (s) => {
    s.steps.extra = { status: 'PENDING', attempts: 0 };
  }), (err) => err.code === 'E_WORKFLOW_INVALID_STATE');
  assert.equal(fs.readFileSync(path.join(run.dir, 'events.jsonl'), 'utf8'), before);
  releaseRun(h);
  assert.deepEqual(events(run.dir).map((e) => [e.seq, e.type]), [[1, 'run.created'], [2, 'run.acquired'], [3, 'step.started'], [4, 'run.released']]);
  const state = readState(run.dir);
  assert.equal(state.lastSeq, 4);
  assert.equal(state.owner, null);
  assert.equal(state.steps.impl.status, 'RUNNING');
  assert.deepEqual(lockFiles(ctx, run.runId), []);
  assert.throws(() => commitRun(h, 'x', {}), /not held/);
});

test('workflow store: the same run and the same workspace cannot be held twice', (t) => {
  const { ctx } = tempCtx(t);
  const a = newRun(ctx);
  const b = newRun(ctx);
  const c = newRun(ctx, { workspaceKey: 'workspace-2' });
  const ha = acquireRun(ctx, a.runId);
  assert.throws(() => acquireRun(ctx, a.runId), (err) => err.code === 'E_WORKFLOW_LOCKED' && err.owner.pid === process.pid);
  assert.throws(() => acquireRun(ctx, b.runId), (err) => err.code === 'E_WORKFLOW_LOCKED' && /workspace/.test(err.message));
  assert.equal(fs.existsSync(path.join(b.dir, 'lock')), false);
  const hc = acquireRun(ctx, c.runId);
  releaseRun(hc);
  releaseRun(ha);
  const hb = acquireRun(ctx, b.runId);
  releaseRun(hb);
  assert.equal(readState(a.dir).steps.impl.status, 'PENDING');
});

test('workflow store: budgets persist across release and acquire', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx, { usedAgentCalls: 2, planRepairs: 1 });
  let h = acquireRun(ctx, run.runId);
  commitRun(h, 'budget.charged', {}, (s) => {
    chargeAgentCall(s, 3);
    addActiveSeconds(s, 12.5);
    addRepairAttempt(s, 'impl');
    addRepairAttempt(s, 'review-fix');
    assert.equal(recordFailure(s, 'unit:a'), false);
    assert.equal(recordFailure(s, 'unit:a'), false);
  });
  releaseRun(h);
  h = acquireRun(ctx, run.runId);
  const { budget } = h.state;
  assert.equal(budget.agentCalls, 5);
  assert.equal(budget.activeSeconds, 12.5);
  assert.equal(budget.planRepairs, 1);
  assert.deepEqual(budget.repairAttempts, { impl: 1, 'review-fix': 1 });
  assert.deepEqual(budget.failureStreak, { signature: 'unit:a', count: 2 });
  commitRun(h, 'check.failed', {}, (s) => {
    assert.equal(recordFailure(s, 'unit:a'), true);
  });
  commitRun(h, 'check.failed', {}, (s) => {
    assert.equal(recordFailure(s, 'unit:b'), false);
    assert.throws(() => addRepairAttempt(s, 'nope'), /unknown target/);
    assert.throws(() => chargeAgentCall(s, 0), /positive integer/);
  });
  commitRun(h, 'check.passed', {}, (s) => {
    clearFailure(s);
  });
  const left = remainingBudget(h.state, { maxAgentCalls: 20, runTimeoutSeconds: 3600, maxPlanRepairs: 1, maxRepairAttempts: 2 });
  assert.equal(left.agentCalls, 15);
  assert.equal(left.planRepairs, 0);
  assert.equal(left.repairAttempts('impl'), 1);
  assert.equal(left.repairAttempts('tests'), 2);
  assert.deepEqual(h.state.budget.failureStreak, { signature: null, count: 0 });
  releaseRun(h);
});

test('workflow store: secret-looking string fields are masked in events, usage and test counts are kept', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  const h = acquireRun(ctx, run.runId);
  commitRun(h, 'call.finished', {
    apiKey: 'k1',
    authToken: 't1',
    nested: [{ password: 'p1', client_secret: 's1' }],
    input_tokens: 1234,
    output_tokens: 56,
    passed: 12,
    tokenizer: 'bpe',
    keyCount: 3,
    token: ['t2', 't3'],
    credentials: { user: 'u', pass: 'p' },
    summary: 'retry with token=abc123, 12 passed, passed: 12',
    note: '12 passed, passed: 12, token_count=40',
    token_count: 40,
    tokenLimit: 100,
    token_total: 'abc',
  });
  releaseRun(h);
  const data = events(run.dir).find((e) => e.type === 'call.finished').data;
  assert.deepEqual(data, {
    apiKey: '***',
    authToken: '***',
    nested: [{ password: '***', client_secret: '***' }],
    input_tokens: 1234,
    output_tokens: 56,
    passed: 12,
    tokenizer: 'bpe',
    keyCount: 3,
    token: '***',
    credentials: '***',
    summary: REDACTED_TEXT,
    note: '12 passed, passed: 12, token_count=40',
    token_count: 40,
    tokenLimit: 100,
    token_total: '***',
  });
  assert.equal(isSecretKey('compass'), false);
  assert.equal(isSecretKey('PRIVATE_KEY'), true);
});

test('workflow store: a state left one event behind is recovered as interrupted and keeps the event', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  const h = acquireRun(ctx, run.runId);
  commitRun(h, 'step.started', { step: 'impl' }, (s) => {
    s.status = 'RUNNING';
    s.steps.impl.status = 'RUNNING';
  });
  const seq = h.state.lastSeq + 1;
  const at = new Date().toISOString();
  const snapshot = structuredClone(h.state);
  snapshot.lastSeq = seq;
  snapshot.updatedAt = at;
  snapshot.steps.impl.status = 'VERIFYING';
  snapshot.budget.agentCalls += 4;
  snapshot.budget.repairAttempts.impl = 1;
  const lost = { seq, at, type: 'step.verifying', data: { step: 'impl' }, state: snapshot };
  fs.appendFileSync(path.join(run.dir, 'events.jsonl'), `${JSON.stringify(lost)}\n`);
  fs.rmSync(path.join(run.dir, 'lock'));
  fs.rmSync(h.wsLock);
  const h2 = acquireRun(ctx, run.runId);
  assert.equal(h2.recovery.interrupted, true);
  assert.equal(h2.recovery.notes.stateBehindEvent, lost.seq);
  assert.equal(h2.recovery.notes.previousOwner.ownerId, h.owner.ownerId);
  assert.equal(h2.state.status, 'INTERRUPTED');
  assert.equal(h2.state.steps.impl.status, 'INTERRUPTED');
  assert.equal(h2.state.steps.tests.status, 'PENDING');
  assert.equal(h2.state.budget.agentCalls, 5);
  assert.deepEqual(h2.state.budget.repairAttempts, { impl: 1 });
  const types = events(run.dir).map((e) => e.type);
  assert.deepEqual(types.slice(-3), ['step.verifying', 'run.recovered', 'run.acquired']);
  assert.deepEqual(events(run.dir).map((e) => e.seq), types.map((_, i) => i + 1));
  releaseRun(h2);
});

test('workflow store: an event without a usable state snapshot is not replayed', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  releaseRun(acquireRun(ctx, run.runId));
  const seq = readState(run.dir).lastSeq + 1;
  fs.appendFileSync(path.join(run.dir, 'events.jsonl'), `${JSON.stringify({ seq, at: 'x', type: 'step.started', data: {} })}\n`);
  assert.throws(() => acquireRun(ctx, run.runId), (err) => err.code === 'E_WORKFLOW_CORRUPT' && /no usable state snapshot/.test(err.message));
  assert.deepEqual(lockFiles(ctx, run.runId), []);
});

test('workflow store: secrets are refused in state, step ids are not field names, and quoted JSON keys are detected', (t) => {
  const { ctx } = tempCtx(t);
  assert.equal(sanitizeEventData('{"token":"abc","input_tokens":12,"passed":12}'), REDACTED_TEXT);
  assert.equal(sanitizeEventData('output: {"token":"abc","input_tokens":12,"passed":12} end'), REDACTED_TEXT);
  const step = (id) => ({ ...PLAN.steps[0], id });
  const run = newRun(ctx, { plan: { ...PLAN, steps: [step('token'), step('api-key')] } });
  const h = acquireRun(ctx, run.runId);
  commitRun(h, 'repair', {}, (s) => {
    addRepairAttempt(s, 'token');
    addRepairAttempt(s, 'api-key');
  });
  const before = fs.readFileSync(path.join(run.dir, 'events.jsonl'));
  const refuse = (mutate, pattern) => assert.throws(
    () => commitRun(h, 'step.result', {}, mutate),
    (err) => err.code === 'E_WORKFLOW_INVALID_STATE' && pattern.test(err.message),
  );
  refuse((s) => {
    s.steps.token.result = { authToken: 'x' };
  }, /state\.steps\.token\.result\.authToken looks like a secret/);
  refuse((s) => {
    s.steps['api-key'].note = 'retry with password=hunter2';
  }, /state\.steps\.api-key\.note contains a secret-looking assignment \(password\)/);
  refuse((s) => {
    s['budget.repairAttempts'] = { token: 1 };
  }, /state\.budget\.repairAttempts\.token looks like a secret/);
  refuse((s) => {
    s.steps.token.extra = { steps: { token: 'x' } };
  }, /state\.steps\.token\.extra\.steps\.token looks like a secret/);
  assert.deepEqual(fs.readFileSync(path.join(run.dir, 'events.jsonl')), before);
  assert.equal(h.broken, undefined);
  releaseRun(h);
});

test('workflow store: text with a secret-looking assignment is replaced whole in events and refused in state', (t) => {
  const { ctx } = tempCtx(t);
  const cases = {
    array: JSON.stringify({ token: ['SYN1', 'SYN2'], passed: 12 }),
    escaped: JSON.stringify({ token: 'SY"N3', input_tokens: 5 }),
    nested: JSON.stringify({ summary: 'retry token=SYN4', passed: 3 }),
    reencoded: JSON.stringify(JSON.stringify({ token: 'SYN5' })),
    padded: `  ${JSON.stringify([{ apiKey: 'SYN6' }])}\n`,
    duplicate: '{"summary":"token=SYN_DUP","summary":"done"}',
    duplicateNull: '{"token":"SYN_DUP2","token":null}',
    prefixArray: 'prefix token=[[SYN7], [SYN8]] end',
    notJson: '{not json token=SYN9',
    spaced: 'password : SYN10',
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.equal(sanitizeEventData(text), REDACTED_TEXT, name);
  }
  const kept = [
    '{ "passed": 12,\n  "input_tokens": 9007199254740993, "big": 1e400, "a": 1, "a": 2 }',
    'token_count=12 input_tokens=34 "tokenLimit": 5',
    'compass=north, 12 passed, passed: 12, tokenizer: bpe',
    '2026-10-30T13:14:09.000Z',
    '['.repeat(8000) + '0' + ']'.repeat(8000),
  ];
  for (const text of kept) {
    assert.equal(sanitizeEventData(text), text);
    assert.equal(findSecretAssignment(text), null);
  }
  assert.equal(findSecretAssignment('token_count=abc'), 'token_count');

  const run = newRun(ctx);
  const h = acquireRun(ctx, run.runId);
  commitRun(h, 'role.output', { raw: cases.nested, list: [cases.reencoded] });
  const last = events(run.dir).at(-1);
  assert.doesNotMatch(JSON.stringify(last), /SYN/);
  for (const [name, text] of Object.entries(cases)) {
    assert.throws(
      () => commitRun(h, 'step.result', {}, (s) => {
        s.steps.impl.output = text;
      }),
      (err) => err.code === 'E_WORKFLOW_INVALID_STATE' && /state\.steps\.impl\.output contains a secret-looking assignment/.test(err.message),
      name,
    );
  }
  commitRun(h, 'step.result', { notes: kept }, (s) => {
    s.steps.impl.notes = kept;
  });
  releaseRun(h);
  const stored = readState(run.dir).steps.impl.notes;
  assert.deepEqual(stored, kept);
  assert.deepEqual(events(run.dir).find((e) => e.type === 'step.result').data.notes, kept);
  assert.doesNotMatch(fs.readFileSync(path.join(run.dir, 'events.jsonl'), 'utf8'), /SYN/);
  assert.doesNotMatch(fs.readFileSync(path.join(run.dir, 'state.json'), 'utf8'), /SYN/);
});

test('workflow store: secret detection stays linear on long input', () => {
  const inputs = ['x='.repeat(128000) + '0', 'a'.repeat(256000), 'a '.repeat(128000), 'a:'.repeat(128000)];
  for (const text of inputs) {
    const start = performance.now();
    assert.equal(findSecretAssignment(text), null);
    assert.ok(performance.now() - start < 1500, `detection took ${Math.round(performance.now() - start)}ms on ${text.slice(0, 4)}...`);
  }
});

test('workflow store: deeply nested data is refused before anything is written', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  const h = acquireRun(ctx, run.runId);
  let deep = 'x';
  for (let i = 0; i < 100; i += 1) {
    deep = [deep];
  }
  const before = fs.readFileSync(path.join(run.dir, 'events.jsonl'));
  assert.throws(() => commitRun(h, 'deep', { deep }), (err) => err.code === 'E_WORKFLOW_INVALID' && /nested deeper than 64/.test(err.message));
  assert.throws(() => commitRun(h, 'deep', {}, (s) => {
    s.steps.impl.deep = deep;
  }), (err) => err.code === 'E_WORKFLOW_INVALID_STATE' && /nested deeper than 64/.test(err.message));
  assert.deepEqual(fs.readFileSync(path.join(run.dir, 'events.jsonl')), before);
  assert.equal(h.broken, undefined);
  releaseRun(h);
});

test('workflow store: createRun checks the initial state before it writes any file', (t) => {
  const { ctx } = tempCtx(t);
  assert.throws(() => newRun(ctx, { workspaceKey: 'token=SYN_BOOT' }), (err) => err.code === 'E_WORKFLOW_INVALID' && /workspaceKey contains a secret-looking assignment/.test(err.message));
  assert.equal(fs.existsSync(workflowsDir(ctx)), false);
});

test('workflow store: recovery stays resumable when any state write during acquire fails', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  const h = acquireRun(ctx, run.runId);
  const rename = fs.renameSync;
  const failStateRename = (n) => {
    let count = 0;
    fs.renameSync = (from, to) => {
      if (to.endsWith('state.json')) {
        count += 1;
        if (count === n) {
          throw Object.assign(new Error(`injected EIO on state write ${n}`), { code: 'EIO' });
        }
      }
      return rename(from, to);
    };
  };
  failStateRename(1);
  try {
    assert.throws(() => commitRun(h, 'budget.charged', {}, (s) => {
      chargeAgentCall(s, 3);
      addActiveSeconds(s, 7);
    }), /injected EIO/);
  } finally {
    fs.renameSync = rename;
  }
  releaseRun(h);
  for (const n of [1, 2, 3]) {
    failStateRename(n);
    try {
      assert.throws(() => acquireRun(ctx, run.runId), new RegExp(`injected EIO on state write ${n}`));
    } finally {
      fs.renameSync = rename;
    }
    assert.deepEqual(lockFiles(ctx, run.runId), []);
    const lag = events(run.dir).length - readState(run.dir).lastSeq;
    assert.ok(lag === 0 || lag === 1, `state is ${lag} events behind after failing state write ${n}`);
  }
  const h2 = acquireRun(ctx, run.runId);
  assert.equal(h2.state.budget.agentCalls, 4);
  assert.equal(h2.state.budget.activeSeconds, 7);
  releaseRun(h2);
  const seqs = events(run.dir).map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
});

test('workflow store: a lock published before a cleanup failure is removed and the first error is kept', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  const lock = path.join(run.dir, 'lock');
  const rm = fs.rmSync;
  const failRm = (match) => {
    let failed = false;
    fs.rmSync = (file, opts) => {
      if (!failed && match(file)) {
        failed = true;
        throw Object.assign(new Error(`injected EACCES on ${path.basename(file)}`), { code: 'EACCES' });
      }
      return rm(file, opts);
    };
  };

  failRm((file) => file.startsWith(`${lock}.`) && file.endsWith('.tmp'));
  try {
    assert.throws(() => acquireRun(ctx, run.runId), (err) => err.code === 'EACCES' && /\.tmp/.test(err.message));
  } finally {
    fs.rmSync = rm;
  }
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(fs.readdirSync(run.dir).filter((f) => f.startsWith('lock')), []);

  writeOwner(lock, { pid: deadPid() });
  failRm((file) => file === `${lock}.reclaim`);
  try {
    assert.throws(() => acquireRun(ctx, run.runId), (err) => err.code === 'EACCES' && /lock\.reclaim/.test(err.message));
  } finally {
    fs.rmSync = rm;
  }
  assert.equal(fs.existsSync(lock), false);
  assert.ok(fs.existsSync(`${lock}.reclaim`));
  fs.rmSync(`${lock}.reclaim`);

  writeOwner(lock, { pid: deadPid() });
  failRm((file) => file.startsWith(`${lock}.reclaim.`) && file.endsWith('.tmp'));
  try {
    assert.throws(() => acquireRun(ctx, run.runId), (err) => err.code === 'EACCES');
  } finally {
    fs.rmSync = rm;
  }
  assert.equal(fs.existsSync(`${lock}.reclaim`), false);
  assert.ok(fs.existsSync(lock));

  const live = { runId: 'x', ownerId: crypto.randomUUID(), pid: process.pid, hostname: os.hostname(), processStart: null, acquiredAt: 'x' };
  const link = fs.linkSync;
  fs.linkSync = (from, to) => {
    const r = link(from, to);
    if (to.endsWith('.reclaim')) {
      fs.writeFileSync(lock, JSON.stringify(live));
    }
    return r;
  };
  failRm((file) => file === `${lock}.reclaim`);
  try {
    assert.throws(() => acquireRun(ctx, run.runId), (err) => err.code === 'E_WORKFLOW_LOCKED'
      && /changed owner/.test(err.message)
      && err.cleanupErrors?.[0]?.code === 'EACCES');
  } finally {
    fs.linkSync = link;
    fs.rmSync = rm;
  }
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).ownerId, live.ownerId);
  fs.rmSync(`${lock}.reclaim`);
  fs.rmSync(lock);
  releaseRun(acquireRun(ctx, run.runId));
});

test('workflow store: a failed state write stops the handle, release keeps seq order, and recovery keeps the budget', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  const h = acquireRun(ctx, run.runId);
  commitRun(h, 'step.started', {}, (s) => {
    s.status = 'RUNNING';
    s.steps.impl.status = 'RUNNING';
  });
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to.endsWith('state.json')) {
      throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
    }
    return rename(from, to);
  };
  try {
    assert.throws(() => commitRun(h, 'budget.charged', {}, (s) => {
      chargeAgentCall(s, 3);
      addActiveSeconds(s, 12.5);
    }), /injected EIO/);
  } finally {
    fs.renameSync = rename;
  }
  assert.throws(() => commitRun(h, 'step.next', {}), (err) => err.code === 'E_WORKFLOW_BROKEN_HANDLE');
  releaseRun(h);
  assert.deepEqual(lockFiles(ctx, run.runId), []);
  const seqs = events(run.dir).map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  const h2 = acquireRun(ctx, run.runId);
  assert.equal(h2.recovery.interrupted, true);
  assert.equal(h2.state.budget.agentCalls, 4);
  assert.equal(h2.state.budget.activeSeconds, 12.5);
  assert.equal(h2.state.status, 'INTERRUPTED');
  releaseRun(h2);
});

test('workflow store: an unfinished last event is kept as evidence, and readRun never repairs', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  releaseRun(acquireRun(ctx, run.runId));
  const partial = '{"seq":4,"at":"2026-10-30T00:00:00.000Z","ty';
  fs.appendFileSync(path.join(run.dir, 'events.jsonl'), partial);
  const before = hashTree(run.dir);
  const view = readRun(ctx, run.runId);
  assert.deepEqual(view.issues, [`events.jsonl ends with ${partial.length} bytes of an unfinished event`]);
  assert.deepEqual(hashTree(run.dir), before);
  const h = acquireRun(ctx, run.runId);
  const kept = fs.readdirSync(run.dir).filter((f) => f.startsWith('events.unfinished-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(run.dir, kept[0]), 'utf8'), partial);
  assert.equal(h.recovery.notes.unfinishedEvent, kept[0]);
  assert.equal(h.recovery.interrupted, true);
  assert.ok(fs.readFileSync(path.join(run.dir, 'events.jsonl'), 'utf8').endsWith('\n'));
  releaseRun(h);
  assert.deepEqual(readRun(ctx, run.runId).issues, []);
});

test('workflow store: an unfinished event cut inside a multi-byte character is kept byte for byte', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  releaseRun(acquireRun(ctx, run.runId));
  const partial = Buffer.concat([Buffer.from('{"seq":4,"data":"'), Buffer.from('한글', 'utf8').subarray(0, 4)]);
  fs.appendFileSync(path.join(run.dir, 'events.jsonl'), partial);
  assert.deepEqual(readRun(ctx, run.runId).issues, [`events.jsonl ends with ${partial.length} bytes of an unfinished event`]);
  const h = acquireRun(ctx, run.runId);
  assert.deepEqual(fs.readFileSync(path.join(run.dir, h.recovery.notes.unfinishedEvent)), partial);
  releaseRun(h);
});

test('workflow store: other inconsistencies are refused and the locks are released', (t) => {
  const { ctx } = tempCtx(t);
  const ahead = newRun(ctx, { workspaceKey: 'w-ahead' });
  const state = readState(ahead.dir);
  fs.writeFileSync(path.join(ahead.dir, 'state.json'), JSON.stringify({ ...state, lastSeq: 5 }));
  assert.throws(() => acquireRun(ctx, ahead.runId), (err) => err.code === 'E_WORKFLOW_CORRUPT' && /seq 5/.test(err.message));
  assert.deepEqual(lockFiles(ctx, ahead.runId), []);

  const middle = newRun(ctx, { workspaceKey: 'w-middle' });
  releaseRun(acquireRun(ctx, middle.runId));
  const lines = fs.readFileSync(path.join(middle.dir, 'events.jsonl'), 'utf8').split('\n');
  lines[1] = '{broken';
  fs.writeFileSync(path.join(middle.dir, 'events.jsonl'), lines.join('\n'));
  assert.throws(() => acquireRun(ctx, middle.runId), (err) => err.code === 'E_WORKFLOW_CORRUPT' && /line 2/.test(err.message));

  const tampered = newRun(ctx, { workspaceKey: 'w-tampered' });
  const policy = JSON.parse(fs.readFileSync(path.join(tampered.dir, 'policy.json'), 'utf8'));
  policy.limits.maxRepairAttempts = 9;
  fs.writeFileSync(path.join(tampered.dir, 'policy.json'), JSON.stringify(policy));
  assert.throws(() => acquireRun(ctx, tampered.runId), (err) => err.code === 'E_WORKFLOW_CORRUPT' && /policyHash/.test(err.message));
  assert.match(readRun(ctx, tampered.runId).issues.join('\n'), /policyHash/);
});

test('workflow store: stale lock rules follow the owner process, host and readable content', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  const lock = path.join(run.dir, 'lock');

  writeOwner(lock, { pid: process.pid });
  assert.throws(() => acquireRun(ctx, run.runId), (err) => err.code === 'E_WORKFLOW_LOCKED');

  writeOwner(lock, { pid: deadPid(), hostname: `${os.hostname()}-other` });
  assert.throws(() => acquireRun(ctx, run.runId), (err) => err.code === 'E_WORKFLOW_LOCKED');

  for (const text of ['', '{}', '{"pid":0,"ownerId":"x","hostname":"h","processStart":null}']) {
    fs.writeFileSync(lock, text);
    assert.throws(() => acquireRun(ctx, run.runId), (err) => err.code === 'E_WORKFLOW_LOCKED' && /unreadable/.test(err.message), text);
  }

  const pid = deadPid();
  writeOwner(lock, { pid });
  const h = acquireRun(ctx, run.runId);
  assert.equal(h.recovery.notes.staleLocks[0].pid, pid);
  assert.equal(h.recovery.interrupted, false);
  assert.equal(fs.readdirSync(run.dir).some((f) => f.includes('.stale-')), false);
  releaseRun(h);
});

test('workflow store: stale lock reclaim is serialized and never removes a lock that changed owner', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  const lock = path.join(run.dir, 'lock');

  writeOwner(lock, { pid: deadPid() });
  writeOwner(`${lock}.reclaim`, { pid: process.pid });
  assert.throws(() => acquireRun(ctx, run.runId), (err) => err.code === 'E_WORKFLOW_LOCKED' && /being reclaimed/.test(err.message));
  assert.ok(fs.existsSync(lock));
  fs.rmSync(`${lock}.reclaim`);

  const live = { runId: 'x', ownerId: crypto.randomUUID(), pid: process.pid, hostname: os.hostname(), processStart: null, acquiredAt: 'x' };
  const link = fs.linkSync;
  fs.linkSync = (from, to) => {
    const r = link(from, to);
    if (to.endsWith('.reclaim')) {
      fs.writeFileSync(lock, JSON.stringify(live));
    }
    return r;
  };
  try {
    assert.throws(() => acquireRun(ctx, run.runId), (err) => err.code === 'E_WORKFLOW_LOCKED' && /changed owner/.test(err.message));
  } finally {
    fs.linkSync = link;
  }
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).ownerId, live.ownerId);
  assert.equal(fs.existsSync(`${lock}.reclaim`), false);
});

test('workflow store: record files that are links are refused', (t) => {
  const { ctx } = tempCtx(t);
  const a = newRun(ctx, { workspaceKey: 'w-a' });
  const b = newRun(ctx, { workspaceKey: 'w-b' });
  const other = path.join(a.dir, 'events.jsonl');
  const target = path.join(b.dir, 'events.jsonl');
  fs.rmSync(target);
  fs.linkSync(other, target);
  const before = fs.readFileSync(other);
  assert.throws(() => acquireRun(ctx, b.runId), (err) => err.code === 'E_WORKFLOW_UNSAFE_PATH');
  assert.throws(() => readRun(ctx, b.runId), (err) => err.code === 'E_WORKFLOW_UNSAFE_PATH');
  assert.deepEqual(fs.readFileSync(other), before);
  assert.deepEqual(lockFiles(ctx, b.runId), []);
  fs.rmSync(target);
  try {
    fs.symlinkSync(other, target);
  } catch (err) {
    if (err.code === 'EPERM') {
      t.diagnostic('symlink creation is not permitted here; symlink case not run');
      return;
    }
    throw err;
  }
  assert.throws(() => acquireRun(ctx, b.runId), (err) => err.code === 'E_WORKFLOW_UNSAFE_PATH');
  assert.deepEqual(fs.readFileSync(other), before);
});

test('workflow store: step ids that are Object property names keep integer repair counts', (t) => {
  const { ctx } = tempCtx(t);
  const step = (id) => ({ ...PLAN.steps[0], id });
  const run = newRun(ctx, { plan: { ...PLAN, steps: [step('constructor'), step('toString')] } });
  const h = acquireRun(ctx, run.runId);
  const limits = { maxAgentCalls: 20, runTimeoutSeconds: 3600, maxPlanRepairs: 1, maxRepairAttempts: 2 };
  assert.equal(remainingBudget(h.state, limits).repairAttempts('constructor'), 2);
  commitRun(h, 'repair', {}, (s) => {
    addRepairAttempt(s, 'constructor');
    addRepairAttempt(s, 'toString');
  });
  releaseRun(h);
  const h2 = acquireRun(ctx, run.runId);
  assert.deepEqual(h2.state.budget.repairAttempts, { constructor: 1, toString: 1 });
  assert.equal(remainingBudget(h2.state, limits).repairAttempts('constructor'), 1);
  releaseRun(h2);
});

test('workflow store: artifacts are written once with safe names and never overwritten', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  const h = acquireRun(ctx, run.runId);
  const first = writeArtifact(h, '00-impl-1', { summary: 'first' });
  assert.equal(first.name, '00-impl-1.json');
  const file = path.join(run.dir, 'artifacts', '00-impl-1.json');
  assert.equal(first.sha256, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  assert.throws(() => writeArtifact(h, '00-impl-1', { summary: 'second' }), { code: 'E_WORKFLOW_INVALID' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { summary: 'first' });
  for (const bad of ['../escape', 'a/b', '.hidden', '', 'x..y']) {
    assert.throws(() => writeArtifact(h, bad, {}), { code: 'E_WORKFLOW_INVALID' }, bad);
  }
  releaseRun(h);
  assert.throws(() => writeArtifact(h, '01-impl-2', {}));
});

test('workflow store: on Linux a reused pid with a different start time counts as stale',{ skip: !IS_LINUX && 'Linux only: /proc start time' }, (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  writeOwner(path.join(run.dir, 'lock'), { pid: process.pid, processStart: '1' });
  const h = acquireRun(ctx, run.runId);
  assert.equal(h.recovery.notes.staleLocks.length, 1);
  releaseRun(h);
});

test('workflow store: a killed owner process is detected and its run is marked interrupted', { timeout: 30000 }, async (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  const code = [
    `import { acquireRun, commitRun } from ${JSON.stringify(STORE_URL)};`,
    'const h = acquireRun({ paths: { stateDir: process.env.WF_STATE } }, process.env.WF_RUN);',
    "commitRun(h, 'step.started', {}, (s) => { s.status = 'RUNNING'; s.steps.impl.status = 'RUNNING'; });",
    "process.stdout.write('ready\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, WF_STATE: ctx.paths.stateDir, WF_RUN: run.runId },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      if (String(d).includes('ready')) {
        resolve();
      }
    });
    child.on('exit', (c) => reject(new Error(`child exited early (${c}): ${stderr}`)));
  });
  assert.throws(() => acquireRun(ctx, run.runId), (err) => err.code === 'E_WORKFLOW_LOCKED' && err.owner.pid === child.pid);
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  const h = acquireRun(ctx, run.runId);
  assert.equal(h.recovery.interrupted, true);
  assert.equal(h.recovery.notes.staleLocks.length, 2);
  assert.equal(h.state.status, 'INTERRUPTED');
  assert.equal(h.state.steps.impl.status, 'INTERRUPTED');
  releaseRun(h);
});

test('workflow store: uninstall after apply leaves workflow records in place', (t) => {
  const { root } = tempCtx(t);
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(path.join(source, 'agent-layers.jsonc'), JSON.stringify({ version: 1, targets: ['codex'] }));
  write(path.join(source, 'base', 'instructions', '00-core.md'), '# Core\n\n- Be precise.\n');
  const cli = (args) => spawnSync(process.execPath, [BIN, '--home', home, '--source', source, ...args], { encoding: 'utf8' });
  let r = cli(['apply', '--yes']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ctx = { paths: { stateDir: path.join(home, '.agent-layers') } };
  const run = newRun(ctx);
  const before = hashTree(run.dir);
  r = cli(['uninstall', '--yes']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /AGENTS\.md/);
  assert.deepEqual(hashTree(run.dir), before);
});

test('workflow store: authorization headers and bearer tokens count as secrets, plain mentions do not', () => {
  for (const text of ['Authorization: Bearer SYNTHETIC-123456789', 'authorization=Basic c3ludGhldGljOnZhbHVl', 'curl -H "bearer abc.def.ghi-123"']) {
    assert.notEqual(findSecretAssignment(text), null, text);
    assert.equal(sanitizeEventData({ summary: text }).summary, REDACTED_TEXT, text);
  }
  for (const text of ['Bearer authentication is required', 'the bearer of the news', 'authorizationCount: 3', 'Use Bearer authentication.', 'the bearer returned.']) {
    assert.equal(findSecretAssignment(text), null, text);
  }
});

test('workflow store: readArtifact returns a written artifact and refuses names outside the artifacts folder', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  const h = acquireRun(ctx, run.runId);
  const { name } = writeArtifact(h, '02-review-1', { result: { findings: [] } });
  assert.deepEqual(readArtifact(h, name), { result: { findings: [] } });
  for (const bad of ['../plan.json', '02-review-1', 'a/b.json', '..json']) {
    assert.throws(() => readArtifact(h, bad), { code: 'E_WORKFLOW_INVALID' }, bad);
  }
  assert.throws(() => readArtifact(h, '09-missing-1.json'), { code: 'E_WORKFLOW_CORRUPT' });
  releaseRun(h);
});

test('workflow store: readRun reports a state that is invalid or differs from the last event snapshot', (t) => {
  const { ctx } = tempCtx(t);
  const run = newRun(ctx);
  const file = path.join(run.dir, 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...state, status: 'SUCCEEDED' }));
  assert.ok(readRun(ctx, run.runId).issues.some((i) => /does not match the state saved with event/.test(i)));
  fs.writeFileSync(file, JSON.stringify({ ...state, status: 'DONE' }));
  assert.ok(readRun(ctx, run.runId).issues.some((i) => /state\.json: run status "DONE"/.test(i)));
  fs.writeFileSync(file, 'null');
  assert.throws(() => readRun(ctx, run.runId), { code: 'E_WORKFLOW_CORRUPT' });
});
