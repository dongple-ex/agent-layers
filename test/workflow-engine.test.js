import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRun, acquireRun, releaseRun, commitRun } from '../src/workflow/store.js';
import { runWorkflow } from '../src/workflow/engine.js';
import { POLICY, PLAN, fakeClock, fakeProvider, fakeVerifier } from './fixtures/workflow/fakes.js';

function setup(t, { policy = POLICY, plan = PLAN } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-wf-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = { paths: { stateDir: root } };
  const run = createRun(ctx, {
    plan,
    policy,
    usedAgentCalls: 1,
    planRepairs: 0,
    baseCommit: 'a'.repeat(40),
    providerFingerprint: 'fake 0.0.0',
    workspaceKey: `ws-${crypto.randomUUID()}`,
  });
  return { ctx, run, handle: acquireRun(ctx, run.runId) };
}

function events(run) {
  return fs.readFileSync(path.join(run.dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function statuses(state) {
  return Object.fromEntries(state.order.map((id) => [id, state.steps[id].status]));
}

function callKeys(provider) {
  return provider.calls.map((c) => `${c.role}:${c.stepId}:${c.attempt}`);
}

function withLimits(limits) {
  return { ...POLICY, limits };
}

test('workflow engine: a clean run goes coder by coder, then review and audit, and succeeds', async (t) => {
  const { run, handle } = setup(t);
  const provider = fakeProvider({ 'coder:impl': [{ summary: 'impl-summary-marker' }] });
  const verifier = fakeVerifier();
  const state = await runWorkflow(handle, { provider, verifier });
  assert.equal(state.status, 'SUCCEEDED');
  assert.deepEqual(statuses(state), { impl: 'SUCCEEDED', tests: 'SUCCEEDED', review: 'SUCCEEDED', audit: 'SUCCEEDED' });
  assert.deepEqual(callKeys(provider), ['coder:impl:1', 'coder:tests:1', 'reviewer:review:1', 'auditor:audit:1']);
  assert.deepEqual(verifier.runs.map((r) => r.stepId), ['impl', 'tests', 'review']);
  assert.equal(state.budget.agentCalls, 5);
  const artifacts = fs.readdirSync(path.join(run.dir, 'artifacts')).sort();
  assert.deepEqual(artifacts, ['00-impl-1.json', '01-tests-1.json', '02-review-1.json', '03-audit-1.json']);
  assert.match(fs.readFileSync(path.join(run.dir, 'artifacts', '00-impl-1.json'), 'utf8'), /impl-summary-marker/);
  assert.doesNotMatch(fs.readFileSync(path.join(run.dir, 'events.jsonl'), 'utf8'), /impl-summary-marker/);
  assert.doesNotMatch(fs.readFileSync(path.join(run.dir, 'state.json'), 'utf8'), /impl-summary-marker/);
  releaseRun(handle);
});

test('workflow engine: a failing check is repaired within maxRepairAttempts and the run succeeds', async (t) => {
  const { handle } = setup(t);
  const provider = fakeProvider();
  const verifier = fakeVerifier({ unit: [{ exitCode: 1, failedTests: ['rejects empty'] }] });
  const state = await runWorkflow(handle, { provider, verifier });
  assert.equal(state.status, 'SUCCEEDED');
  assert.equal(state.steps.impl.attempts, 2);
  assert.deepEqual(state.budget.repairAttempts, { impl: 1 });
  const second = provider.calls.find((c) => c.stepId === 'impl' && c.attempt === 2);
  assert.deepEqual(second.feedback.failures, [{ id: 'unit', exitCode: 1, failedTests: ['rejects empty'] }]);
  releaseRun(handle);
});

test('workflow engine: a check that keeps failing stops at the repair limit without starting later steps', async (t) => {
  const { handle } = setup(t);
  const provider = fakeProvider();
  const verifier = fakeVerifier({ unit: [1, 2, 3].map((n) => ({ exitCode: 1, failedTests: [`case ${n}`] })) });
  const state = await runWorkflow(handle, { provider, verifier });
  assert.equal(state.status, 'FAILED');
  assert.equal(state.stopReason, 'repair-limit');
  assert.deepEqual(statuses(state), { impl: 'FAILED', tests: 'PENDING', review: 'PENDING', audit: 'PENDING' });
  assert.equal(state.steps.impl.attempts, 3);
  assert.deepEqual(state.budget.repairAttempts, { impl: 2 });
  assert.deepEqual(callKeys(provider), ['coder:impl:1', 'coder:impl:2', 'coder:impl:3']);
  releaseRun(handle);
});

test('workflow engine: the same failure three times in a row stops before a larger repair limit', async (t) => {
  const { handle } = setup(t, { policy: withLimits({ maxRepairAttempts: 5 }) });
  const verifier = fakeVerifier({ unit: [1, 2, 3].map(() => ({ exitCode: 1, failedTests: ['b', 'a'] })) });
  const state = await runWorkflow(handle, { provider: fakeProvider(), verifier });
  assert.equal(state.stopReason, 'same-failure');
  assert.equal(state.steps.impl.status, 'FAILED');
  assert.equal(state.steps.impl.attempts, 3);
  assert.equal(state.budget.failureStreak.count, 3);
  releaseRun(handle);
});

test('workflow engine: reviewer changes go through one review-fix, recheck affected steps, then review again', async (t) => {
  const { run, handle } = setup(t);
  const finding = { code: 'missing-case', severity: 'high', path: 'src/a.js', evidence: 'empty input is accepted' };
  const provider = fakeProvider({ 'reviewer:review': [{ status: 'needs_changes', findings: [finding] }] });
  const verifier = fakeVerifier();
  const state = await runWorkflow(handle, { provider, verifier });
  assert.equal(state.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(provider), ['coder:impl:1', 'coder:tests:1', 'reviewer:review:1', 'coder:review-fix:1', 'reviewer:review:2', 'auditor:audit:1']);
  const fix = provider.calls.find((c) => c.stepId === 'review-fix');
  assert.deepEqual(fix.writePaths, ['src/a.js']);
  assert.deepEqual(fix.feedback.findings, [finding]);
  assert.deepEqual(verifier.runs.at(-1), { stepId: 'review', checkIds: ['unit'] });
  assert.deepEqual(state.budget.repairAttempts, { 'review-fix': 1 });
  assert.equal(state.steps.impl.attempts, 1);
  const rechecked = events(run).find((e) => e.type === 'steps.rechecked');
  assert.deepEqual(rechecked.data.steps, ['impl', 'tests']);
  releaseRun(handle);
});

test('workflow engine: auditor changes also send the run back through review before a new audit', async (t) => {
  const { handle } = setup(t);
  const finding = { code: 'secret-log', severity: 'high', path: 'src/a.js', evidence: 'logs a credential' };
  const provider = fakeProvider({ 'auditor:audit': [{ status: 'needs_changes', findings: [finding] }] });
  const state = await runWorkflow(handle, { provider, verifier: fakeVerifier() });
  assert.equal(state.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(provider).slice(2), ['reviewer:review:1', 'auditor:audit:1', 'coder:review-fix:1', 'reviewer:review:2', 'auditor:audit:2']);
  releaseRun(handle);
});

test('workflow engine: a recheck that fails after review-fix spends review-fix attempts, not step repairs', async (t) => {
  const { handle } = setup(t);
  const finding = (code) => ({ code, severity: 'high', path: 'test/a.test.js', evidence: 'e' });
  const provider = fakeProvider({ 'reviewer:review': [{ status: 'needs_changes', findings: [finding('a')] }] });
  const verifier = fakeVerifier({ unit: [{}, {}, {}, { exitCode: 1, failedTests: ['t'] }] });
  const state = await runWorkflow(handle, { provider, verifier });
  assert.equal(state.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(provider).filter((k) => k.includes('review-fix')), ['coder:review-fix:1', 'coder:review-fix:2']);
  assert.deepEqual(state.budget.repairAttempts, { 'review-fix': 2 });
  assert.equal(provider.calls.find((c) => c.stepId === 'review-fix' && c.attempt === 2).feedback.failures[0].id, 'unit');
  releaseRun(handle);

  const second = setup(t);
  const changes = ['a', 'b', 'c'].map((code) => ({ status: 'needs_changes', findings: [finding(code)] }));
  const s2 = await runWorkflow(second.handle, { provider: fakeProvider({ 'reviewer:review': changes }), verifier: fakeVerifier() });
  assert.equal(s2.status, 'FAILED');
  assert.equal(s2.stopReason, 'repair-limit');
  assert.equal(s2.steps.review.status, 'FAILED');
  assert.deepEqual(s2.budget.repairAttempts, { 'review-fix': 2 });
  releaseRun(second.handle);
});

test('workflow engine: a finding outside every writePaths blocks the run without widening the scope', async (t) => {
  const { handle } = setup(t);
  const finding = { code: 'docs', severity: 'low', path: 'docs/guide.md', evidence: 'not documented' };
  const provider = fakeProvider({ 'auditor:audit': [{ status: 'needs_changes', findings: [finding] }] });
  const state = await runWorkflow(handle, { provider, verifier: fakeVerifier() });
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.steps.audit.status, 'BLOCKED');
  assert.equal(state.steps.audit.reason, 'finding-out-of-scope');
  assert.equal(provider.calls.some((c) => c.stepId === 'review-fix'), false);
  releaseRun(handle);
});

test('workflow engine: transport errors retry per call, block when used up, and resume keeps counting', async (t) => {
  const { ctx, run, handle } = setup(t);
  const errors = [1, 2, 3].map(() => ({ transport: 'ECONNRESET' }));
  const state = await runWorkflow(handle, { provider: fakeProvider({ 'coder:impl': errors }), verifier: fakeVerifier() });
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.steps.impl.reason, 'transport');
  assert.equal(state.budget.agentCalls, 4);
  releaseRun(handle);

  const mixed = setup(t);
  const mixedProvider = fakeProvider({ 'coder:impl': ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].map((code) => ({ transport: code })) });
  const sm = await runWorkflow(mixed.handle, { provider: mixedProvider, verifier: fakeVerifier() });
  assert.equal(sm.steps.impl.reason, 'transport');
  assert.equal(mixedProvider.calls.length, 3);
  releaseRun(mixed.handle);

  const h2 = acquireRun(ctx, run.runId);
  assert.equal((await runWorkflow(h2, { provider: fakeProvider(), verifier: fakeVerifier() })).status, 'BLOCKED');
  const again = fakeProvider({ 'coder:impl': [{ transport: 'ECONNRESET' }] });
  const s2 = await runWorkflow(h2, { provider: again, verifier: fakeVerifier(), resume: true });
  assert.equal(s2.status, 'BLOCKED');
  assert.equal(again.calls.length, 1);
  assert.equal(s2.budget.agentCalls, 5);
  releaseRun(h2);

  const h3 = acquireRun(ctx, run.runId);
  const ok = fakeProvider();
  const s3 = await runWorkflow(h3, { provider: ok, verifier: fakeVerifier(), resume: true });
  assert.equal(s3.status, 'SUCCEEDED');
  assert.equal(s3.budget.agentCalls, 9);
  assert.deepEqual(callKeys(ok)[0], 'coder:impl:3');
  releaseRun(h3);
});

test('workflow engine: reaching maxAgentCalls stops before the next call and resume does not reset it', async (t) => {
  const { ctx, run, handle } = setup(t, { policy: withLimits({ maxSteps: 2, maxAgentCalls: 5 }) });
  const provider = fakeProvider();
  const state = await runWorkflow(handle, { provider, verifier: fakeVerifier({ unit: [{ exitCode: 1, failedTests: ['x'] }] }) });
  assert.equal(state.status, 'FAILED');
  assert.equal(state.stopReason, 'maxAgentCalls');
  assert.equal(state.budget.agentCalls, 5);
  assert.deepEqual(statuses(state), { impl: 'SUCCEEDED', tests: 'SUCCEEDED', review: 'SUCCEEDED', audit: 'PENDING' });
  releaseRun(handle);
  const h2 = acquireRun(ctx, run.runId);
  const later = fakeProvider();
  const s2 = await runWorkflow(h2, { provider: later, verifier: fakeVerifier(), resume: true });
  assert.equal(s2.status, 'FAILED');
  assert.equal(later.calls.length, 0);
  assert.equal(s2.budget.agentCalls, 5);
  releaseRun(h2);
});

test('workflow engine: active time counts across calls and checks and stops at runTimeoutSeconds', async (t) => {
  const { handle } = setup(t, { policy: withLimits({ runTimeoutSeconds: 100 }) });
  const clock = fakeClock();
  const provider = fakeProvider({}, { clock, secondsPerCall: 30 });
  const verifier = fakeVerifier({}, { clock, secondsPerRun: 15 });
  const state = await runWorkflow(handle, { provider, verifier, clock: clock.now });
  assert.equal(state.status, 'FAILED');
  assert.equal(state.stopReason, 'runTimeoutSeconds');
  assert.equal(state.budget.activeSeconds, 105);
  assert.deepEqual(callKeys(provider), ['coder:impl:1', 'coder:tests:1']);
  assert.deepEqual(verifier.runs.map((r) => r.stepId), ['impl', 'tests', 'review']);
  assert.equal(state.steps.review.status, 'PENDING');
  releaseRun(handle);
});

test('workflow engine: a run recovered as interrupted is blocked and no role is called again', async (t) => {
  const { ctx, run, handle } = setup(t);
  commitRun(handle, 'step.started', { stepId: 'impl' }, (s) => {
    s.status = 'RUNNING';
    s.steps.impl.status = 'RUNNING';
    s.steps.impl.attempts = 1;
  });
  fs.rmSync(path.join(run.dir, 'lock'));
  fs.rmSync(handle.wsLock);
  const h2 = acquireRun(ctx, run.runId);
  assert.equal(h2.state.steps.impl.status, 'INTERRUPTED');
  const provider = fakeProvider();
  const state = await runWorkflow(h2, { provider, verifier: fakeVerifier(), resume: true });
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.stopReason, 'interrupted');
  assert.equal(state.steps.impl.status, 'BLOCKED');
  assert.equal(state.steps.impl.reason, 'interrupted');
  assert.equal(provider.calls.length, 0);
  const s2 = await runWorkflow(h2, { provider, verifier: fakeVerifier(), resume: true });
  assert.equal(s2.status, 'BLOCKED');
  assert.equal(provider.calls.length, 0);
  releaseRun(h2);
});

test('workflow engine: invalid results, role timeouts and blocked roles stop the run as BLOCKED', async (t) => {
  const cases = [
    [{ 'coder:impl': [{ summary: '' }] }, 'invalid-result'],
    [{ 'coder:impl': [{ stepId: 'tests' }] }, 'invalid-result'],
    [{ 'coder:impl': [{ attempt: 9 }] }, 'invalid-result'],
    [{ 'coder:impl': [{ status: 'needs_changes', findings: [{ code: 'x', severity: 'low', path: 'src/a.js', evidence: 'e' }] }] }, 'invalid-result'],
    [{ 'coder:impl': [{ raw: 'not json' }] }, 'invalid-result'],
    [{ 'coder:impl': [{ timeout: true }] }, 'timeout'],
    [{ 'coder:impl': [{ status: 'blocked', needsInput: ['which file?'] }] }, 'role-blocked'],
  ];
  for (const [script, reason] of cases) {
    const { run, handle } = setup(t);
    const state = await runWorkflow(handle, { provider: fakeProvider(script), verifier: fakeVerifier() });
    assert.equal(state.status, 'BLOCKED', reason);
    assert.equal(state.steps.impl.reason, reason);
    assert.equal(state.steps.tests.status, 'PENDING');
    if (reason !== 'timeout') {
      assert.ok(fs.existsSync(path.join(run.dir, 'artifacts', '00-impl-1.json')));
    }
    releaseRun(handle);
  }
});

test('workflow engine: a failing required check after the work steps blocks the run before review', async (t) => {
  const { handle } = setup(t);
  const provider = fakeProvider();
  const verifier = fakeVerifier({ unit: [{}, {}, { exitCode: 1, failedTests: ['integration'] }] });
  const state = await runWorkflow(handle, { provider, verifier });
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.stopReason, 'required-checks-failed');
  assert.equal(provider.calls.some((c) => c.role === 'reviewer'), false);
  releaseRun(handle);
});

test('workflow engine: a secret in a role summary is redacted in the artifact and never reaches events or state', async (t) => {
  const { run, handle } = setup(t);
  const provider = fakeProvider({ 'coder:impl': [{ summary: 'used token=SYN_ENGINE to log in' }] });
  const state = await runWorkflow(handle, { provider, verifier: fakeVerifier() });
  assert.equal(state.status, 'SUCCEEDED');
  for (const file of ['events.jsonl', 'state.json', path.join('artifacts', '00-impl-1.json')]) {
    assert.doesNotMatch(fs.readFileSync(path.join(run.dir, file), 'utf8'), /SYN_ENGINE/, file);
  }
  releaseRun(handle);
});

test('workflow engine: work steps run in dependency order even when the plan lists them out of order', async (t) => {
  const plan = { ...PLAN, steps: [...PLAN.steps].reverse() };
  const { handle } = setup(t, { plan });
  const provider = fakeProvider();
  const state = await runWorkflow(handle, { provider, verifier: fakeVerifier() });
  assert.equal(state.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(provider), ['coder:impl:1', 'coder:tests:1', 'reviewer:review:1', 'auditor:audit:1']);
  releaseRun(handle);
});

test('workflow engine: a review-fix stopped by transport errors resumes the same fix before review runs again', async (t) => {
  const { ctx, run, handle } = setup(t);
  const finding = { code: 'missing-case', severity: 'medium', path: 'test/a.test.js', evidence: 'no empty input case' };
  const first = fakeProvider({
    'reviewer:review': [{ status: 'needs_changes', findings: [finding] }],
    'coder:review-fix': ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].map((code) => ({ transport: code })),
  });
  const s1 = await runWorkflow(handle, { provider: first, verifier: fakeVerifier() });
  assert.equal(s1.status, 'BLOCKED');
  assert.equal(s1.steps.review.reason, 'transport');
  assert.deepEqual(s1.reviewFix, { stepId: 'review', role: 'reviewer', artifact: '02-review-1.json', attempt: 1 });
  releaseRun(handle);

  const h2 = acquireRun(ctx, run.runId);
  const second = fakeProvider();
  const s2 = await runWorkflow(h2, { provider: second, verifier: fakeVerifier(), resume: true });
  assert.equal(s2.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(second), ['coder:review-fix:1', 'reviewer:review:2', 'auditor:audit:1']);
  assert.deepEqual(second.calls[0].feedback.findings, [finding]);
  assert.deepEqual(second.calls[0].writePaths, ['test/a.test.js']);
  assert.equal(s2.budget.repairAttempts['review-fix'], 1);
  assert.equal(s2.reviewFix, undefined);
  releaseRun(h2);
});

test('workflow engine: an unexpected provider or verifier error leaves the run interrupted with the time it used', async (t) => {
  for (const [name, provider, verifier] of [
    ['provider', null, fakeVerifier()],
    ['verifier', fakeProvider(), null],
  ]) {
    const { ctx, run, handle } = setup(t);
    const clock = fakeClock();
    const p = provider || { calls: [], async call() { clock.advance(15); throw new Error('unclassified provider failure'); } };
    const v = verifier || { async run() { clock.advance(15); throw new Error('unclassified verifier failure'); } };
    await assert.rejects(runWorkflow(handle, { provider: p, verifier: v, clock: clock.now }), new RegExp(`unclassified ${name} failure`));
    assert.equal(handle.state.status, 'INTERRUPTED', name);
    assert.equal(handle.state.steps.impl.status, 'INTERRUPTED', name);
    assert.equal(handle.state.budget.activeSeconds, 15, name);
    assert.equal(events(run).at(-1).type, 'run.interrupted', name);
    releaseRun(handle);
    const h2 = acquireRun(ctx, run.runId);
    const later = fakeProvider();
    const s2 = await runWorkflow(h2, { provider: later, verifier: fakeVerifier(), resume: true });
    assert.equal(s2.status, 'BLOCKED', name);
    assert.equal(s2.steps.impl.reason, 'interrupted', name);
    assert.equal(later.calls.length, 0, name);
    releaseRun(h2);
  }
});

test('workflow engine: the same auditor findings three times stop the run even though review passes in between', async (t) => {
  const { handle } = setup(t, { policy: withLimits({ maxRepairAttempts: 5 }) });
  const finding = { code: 'secret-log', severity: 'high', path: 'src/a.js', evidence: 'logs a credential' };
  const provider = fakeProvider({ 'auditor:audit': Array.from({ length: 4 }, () => ({ status: 'needs_changes', findings: [finding] })) });
  const state = await runWorkflow(handle, { provider, verifier: fakeVerifier() });
  assert.equal(state.status, 'FAILED');
  assert.equal(state.stopReason, 'same-failure');
  assert.equal(state.steps.audit.status, 'FAILED');
  assert.equal(provider.calls.filter((c) => c.role === 'auditor').length, 3);
  releaseRun(handle);
});

test('workflow engine: a last call that runs past runTimeoutSeconds fails the run instead of succeeding', async (t) => {
  const { handle } = setup(t, { policy: withLimits({ runTimeoutSeconds: 100 }) });
  const clock = fakeClock();
  const provider = fakeProvider({}, { clock, secondsPerCall: 30 });
  const state = await runWorkflow(handle, { provider, verifier: fakeVerifier(), clock: clock.now });
  assert.equal(state.status, 'FAILED');
  assert.equal(state.stopReason, 'runTimeoutSeconds');
  assert.equal(state.budget.activeSeconds, 120);
  assert.equal(state.steps.audit.status, 'FAILED');
  releaseRun(handle);
});

test('workflow engine: step ids with dots get safe artifact names', async (t) => {
  const plan = { ...PLAN, steps: [{ ...PLAN.steps[0], id: 'impl..v2' }, { ...PLAN.steps[1], dependsOn: ['impl..v2'] }] };
  const { run, handle } = setup(t, { plan });
  const state = await runWorkflow(handle, { provider: fakeProvider(), verifier: fakeVerifier() });
  assert.equal(state.status, 'SUCCEEDED');
  assert.ok(fs.readdirSync(path.join(run.dir, 'artifacts')).includes('00-impl__v2-1.json'));
  releaseRun(handle);
});

test('workflow engine: an authorization header in a role result is redacted in the artifact', async (t) => {
  const { run, handle } = setup(t);
  const provider = fakeProvider({ 'coder:impl': [{ summary: 'request failed: Authorization: Bearer SYNTHETIC-BEARER-123456' }] });
  await runWorkflow(handle, { provider, verifier: fakeVerifier() });
  const text = fs.readFileSync(path.join(run.dir, 'artifacts', '00-impl-1.json'), 'utf8');
  assert.doesNotMatch(text, /SYNTHETIC-BEARER/);
  releaseRun(handle);
});

test('workflow engine: no role is called once the active time left is exactly zero', async (t) => {
  const { handle } = setup(t, { policy: withLimits({ runTimeoutSeconds: 100 }) });
  const clock = fakeClock();
  const provider = fakeProvider({}, { clock, secondsPerCall: 25 });
  const verifier = fakeVerifier({ unit: [{ exitCode: 1, failedTests: ['x'] }] });
  const state = await runWorkflow(handle, { provider, verifier, clock: clock.now });
  assert.equal(state.status, 'FAILED');
  assert.equal(state.stopReason, 'runTimeoutSeconds');
  assert.equal(state.budget.activeSeconds, 100);
  assert.deepEqual(callKeys(provider), ['coder:impl:1', 'coder:impl:2', 'coder:tests:1', 'reviewer:review:1']);
  releaseRun(handle);
});

test('workflow engine: checks that finish past runTimeoutSeconds do not count as a passed step', async (t) => {
  const { handle } = setup(t, { policy: withLimits({ runTimeoutSeconds: 100 }) });
  const clock = fakeClock();
  const provider = fakeProvider({}, { clock, secondsPerCall: 10 });
  const verifier = fakeVerifier({}, { clock, secondsPerRun: 95 });
  const state = await runWorkflow(handle, { provider, verifier, clock: clock.now });
  assert.equal(state.status, 'FAILED');
  assert.equal(state.stopReason, 'runTimeoutSeconds');
  assert.equal(state.steps.impl.status, 'FAILED');
  assert.equal(state.steps.impl.reason, 'runTimeoutSeconds');
  releaseRun(handle);
});

test('workflow engine: a step id that looks like a secret key still records its check failures', async (t) => {
  const plan = { ...PLAN, steps: [{ ...PLAN.steps[0], id: 'auth-token' }, { ...PLAN.steps[1], dependsOn: ['auth-token'] }] };
  const { handle } = setup(t, { plan });
  const state = await runWorkflow(handle, { provider: fakeProvider(), verifier: fakeVerifier({ unit: [{ exitCode: 1, failedTests: ['t1'] }] }) });
  assert.equal(state.status, 'SUCCEEDED');
  assert.equal(state.steps['auth-token'].attempts, 2);
  releaseRun(handle);
});

test('workflow engine: a review-fix resumed after a failed recheck skips the gate, keeps the failures and runs as RUNNING', async (t) => {
  const { ctx, run, handle } = setup(t);
  const finding = { code: 'bug', severity: 'high', path: 'src/a.js', evidence: 'wrong branch' };
  const first = fakeProvider({
    'reviewer:review': [{ status: 'needs_changes', findings: [finding] }],
    'coder:review-fix': [{}, ...['EA', 'EB', 'EC'].map((code) => ({ transport: code }))],
  });
  const s1 = await runWorkflow(handle, { provider: first, verifier: fakeVerifier({ unit: [{}, {}, {}, { exitCode: 1, failedTests: ['t1'] }] }) });
  assert.equal(s1.status, 'BLOCKED');
  assert.equal(s1.reviewFix.attempt, 2);
  const startedStates = events(run).filter((e) => e.type === 'review-fix.started').map((e) => e.state.steps.review.status);
  assert.deepEqual(startedStates, ['RUNNING', 'RUNNING']);
  assert.ok(events(run).some((e) => e.type === 'review-fix.verifying' && e.state.steps.review.status === 'VERIFYING'));
  releaseRun(handle);

  const h2 = acquireRun(ctx, run.runId);
  const second = fakeProvider();
  const verifier = fakeVerifier();
  const s2 = await runWorkflow(h2, { provider: second, verifier, resume: true });
  assert.equal(s2.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(second), ['coder:review-fix:2', 'reviewer:review:2', 'auditor:audit:1']);
  assert.deepEqual(second.calls[0].feedback.failures, [{ id: 'unit', exitCode: 1, failedTests: ['t1'] }]);
  assert.deepEqual(verifier.runs.map((r) => r.stepId), ['review']);
  assert.equal(s2.budget.repairAttempts['review-fix'], 2);
  releaseRun(h2);
});

test('workflow engine: an unexpected error during review-fix marks the review step interrupted', async (t) => {
  const { handle } = setup(t);
  const finding = { code: 'bug', severity: 'high', path: 'src/a.js', evidence: 'wrong branch' };
  const inner = fakeProvider({ 'reviewer:review': [{ status: 'needs_changes', findings: [finding] }] });
  const provider = {
    async call(req) {
      if (req.stepId === 'review-fix') {
        throw new Error('unclassified review-fix failure');
      }
      return inner.call(req);
    },
  };
  await assert.rejects(runWorkflow(handle, { provider, verifier: fakeVerifier() }), /unclassified review-fix failure/);
  assert.equal(handle.state.status, 'INTERRUPTED');
  assert.equal(handle.state.steps.review.status, 'INTERRUPTED');
  releaseRun(handle);
});

test('workflow engine: when the interruption cannot be recorded, the original error still reaches the caller', async (t) => {
  for (const original of [Object.freeze(new Error('frozen provider error')), 'plain string failure']) {
    const { run, handle } = setup(t);
    const provider = {
      async call() {
        fs.rmSync(path.join(run.dir, 'events.jsonl'));
        throw original;
      },
    };
    const err = await runWorkflow(handle, { provider, verifier: fakeVerifier() }).then(() => null, (e) => e);
    assert.ok(err instanceof Error);
    assert.equal(err.cause, original);
    assert.match(err.message, /recording the interruption also failed/);
    assert.equal(err.cleanupErrors.length, 1);
    assert.equal(err.cleanupErrors[0].code, 'ENOENT');
  }
});
