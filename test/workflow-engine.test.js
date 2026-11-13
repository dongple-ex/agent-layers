import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRun, acquireRun, releaseRun, commitRun, extendBudget, readRun } from '../src/workflow/store.js';
import { runWorkflow } from '../src/workflow/engine.js';
import { reportView } from '../src/workflow/report.js';
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

function stepChanges(run, id) {
  const all = events(run);
  const changes = [];
  for (let i = 1; i < all.length; i += 1) {
    const from = all[i - 1].state.steps[id].status;
    const to = all[i].state.steps[id].status;
    if (from !== to) {
      changes.push(`${from}->${to}`);
    }
  }
  return changes;
}

test('workflow engine: a stop request from the provider ends the run with its status and reason, without a retry', async (t) => {
  const { run, handle } = setup(t);
  const provider = {
    calls: [],
    async call(req) {
      this.calls.push(req);
      throw Object.assign(new Error('changed a file out of scope'), { stop: { status: 'FAILED', reason: 'policy-violation' } });
    },
  };
  const state = await runWorkflow(handle, { provider, verifier: fakeVerifier() });
  assert.equal(state.status, 'FAILED');
  assert.equal(state.stopReason, 'policy-violation');
  assert.equal(state.steps.impl.status, 'FAILED');
  assert.equal(state.steps.impl.reason, 'policy-violation');
  assert.match(state.steps.impl.lastError, /changed a file out of scope/);
  assert.equal(provider.calls.length, 1);
  assert.equal(state.budget.agentCalls, 2);
  assert.deepEqual(events(run).find((e) => e.type === 'call.failed').data, { role: 'coder', stepId: 'impl', attempt: 1, retry: 0, kind: 'stopped', reason: 'policy-violation' });
});

test('workflow engine: a cancelled call ends the run as CANCELLED, one with processes left is INTERRUPTED', async (t) => {
  for (const [cancelled, status] of [[true, 'CANCELLED'], [false, 'INTERRUPTED']]) {
    const { run, handle } = setup(t);
    const provider = {
      async call() {
        throw Object.assign(new Error('the coder call was cancelled'), { cancelled });
      },
    };
    await assert.rejects(runWorkflow(handle, { provider, verifier: fakeVerifier() }), /was cancelled/);
    assert.equal(handle.state.status, status);
    assert.equal(handle.state.steps.impl.status, status);
    assert.equal(events(run).at(-1).type, `run.${status.toLowerCase()}`);
  }
  const { handle } = setup(t);
  const provider = {
    async call() {
      throw Object.assign(new Error('the coder call was cancelled'), { cancelled: true });
    },
  };
  await assert.rejects(runWorkflow(handle, { provider, verifier: fakeVerifier() }), /was cancelled/);
  const later = fakeProvider();
  assert.equal((await runWorkflow(handle, { provider: later, verifier: fakeVerifier(), resume: true })).status, 'CANCELLED');
  assert.equal(later.calls.length, 0);
});

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
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.stopReason, 'maxAgentCalls');
  assert.equal(state.budget.agentCalls, 5);
  assert.deepEqual(statuses(state), { impl: 'SUCCEEDED', tests: 'SUCCEEDED', review: 'SUCCEEDED', audit: 'PENDING' });
  releaseRun(handle);
  const h2 = acquireRun(ctx, run.runId);
  const later = fakeProvider();
  const s2 = await runWorkflow(h2, { provider: later, verifier: fakeVerifier(), resume: true });
  assert.equal(s2.status, 'BLOCKED');
  assert.equal(s2.stopReason, 'maxAgentCalls');
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
  assert.equal(state.status, 'BLOCKED');
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

function interruptedAtImpl(t) {
  const { ctx, run, handle } = setup(t);
  commitRun(handle, 'step.started', { stepId: 'impl' }, (s) => {
    s.status = 'RUNNING';
    s.steps.impl.status = 'RUNNING';
    s.steps.impl.attempts = 1;
    s.budget.agentCalls += 1;
  });
  fs.rmSync(path.join(run.dir, 'lock'));
  fs.rmSync(handle.wsLock);
  return { run, handle: acquireRun(ctx, run.runId) };
}

const PASSED = { passed: true, artifact: 'recovery-9.json', changedFiles: ['src/a.js'] };

test('workflow engine: a passed recovery check runs the step again with a note and the counts so far', async (t) => {
  const { run, handle } = interruptedAtImpl(t);
  const provider = fakeProvider();
  const state = await runWorkflow(handle, { provider, verifier: fakeVerifier(), resume: true, recovery: PASSED });
  assert.equal(state.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(provider), ['coder:impl:2', 'coder:tests:1', 'reviewer:review:1', 'auditor:audit:1']);
  assert.deepEqual(provider.calls[0].feedback, { interrupted: true, changedFiles: ['src/a.js'] });
  assert.equal(provider.calls[1].feedback, null);
  assert.equal(state.budget.agentCalls, 6);
  assert.deepEqual(events(run).find((e) => e.type === 'run.resumed').data, { steps: ['impl'], recovery: 'recovery-9.json' });
  assert.deepEqual(stepChanges(run, 'impl').slice(-5), ['RUNNING->INTERRUPTED', 'INTERRUPTED->READY', 'READY->RUNNING', 'RUNNING->VERIFYING', 'VERIFYING->SUCCEEDED']);
  releaseRun(handle);
});

test('workflow engine: a failed recovery check stops the run without a call until a later check passes', async (t) => {
  const { handle } = interruptedAtImpl(t);
  const provider = fakeProvider();
  const options = { provider, verifier: fakeVerifier(), resume: true };
  const left = { passed: false, status: 'BLOCKED', reason: 'process-left', message: 'pid 123 is alive' };
  for (const recovery of [left, left, { ...left, reason: 'process-unconfirmed', message: 'cannot confirm' }]) {
    const state = await runWorkflow(handle, { ...options, recovery });
    assert.equal(state.status, 'BLOCKED');
    assert.equal(state.stopReason, recovery.reason);
    assert.equal(state.steps.impl.status, 'BLOCKED');
    assert.equal(state.steps.impl.reason, recovery.reason);
    assert.equal(state.steps.impl.lastError, recovery.message);
  }
  const unchecked = await runWorkflow(handle, options);
  assert.equal(unchecked.status, 'BLOCKED');
  assert.equal(unchecked.stopReason, 'process-unconfirmed');
  assert.equal(provider.calls.length, 0);
  assert.equal(handle.state.budget.agentCalls, 2);

  const state = await runWorkflow(handle, { ...options, recovery: PASSED });
  assert.equal(state.status, 'SUCCEEDED');
  assert.equal(state.steps.impl.attempts, 2);
  assert.equal(state.steps.impl.lastError, undefined);
  releaseRun(handle);
});

test('workflow engine: a recovery check that found a violation ends the run as FAILED for good', async (t) => {
  const { handle } = interruptedAtImpl(t);
  const provider = fakeProvider();
  const options = { provider, verifier: fakeVerifier(), resume: true };
  const state = await runWorkflow(handle, { ...options, recovery: { passed: false, status: 'FAILED', reason: 'policy-violation', message: 'docs/x.txt is outside' } });
  assert.equal(state.status, 'FAILED');
  assert.equal(state.stopReason, 'policy-violation');
  assert.equal(state.steps.impl.status, 'FAILED');
  assert.match(state.steps.impl.lastError, /docs\/x\.txt/);
  assert.equal((await runWorkflow(handle, { ...options, recovery: PASSED })).status, 'FAILED');
  assert.equal(provider.calls.length, 0);
  releaseRun(handle);
});

test('workflow engine: a review fix cut off by an interruption continues with the findings and the note', async (t) => {
  const { ctx, run, handle } = setup(t);
  const finding = { code: 'F1', severity: 'high', path: 'src/a.js', evidence: 'wrong' };
  const failing = fakeProvider({ 'reviewer:review': [{ status: 'needs_changes', findings: [finding] }] });
  const provider = {
    async call(req) {
      if (req.stepId === 'review-fix') {
        throw new Error('the manager stopped');
      }
      return failing.call(req);
    },
  };
  await assert.rejects(runWorkflow(handle, { provider, verifier: fakeVerifier() }), /the manager stopped/);
  assert.equal(handle.state.steps.review.status, 'INTERRUPTED');
  releaseRun(handle);

  const again = acquireRun(ctx, run.runId);
  const resumed = fakeProvider();
  const state = await runWorkflow(again, { provider: resumed, verifier: fakeVerifier(), resume: true, recovery: PASSED });
  assert.equal(state.status, 'SUCCEEDED');
  assert.equal(callKeys(resumed)[0], 'coder:review-fix:1');
  assert.deepEqual(resumed.calls[0].feedback, { findings: [finding], interrupted: true, changedFiles: ['src/a.js'] });
  assert.deepEqual(events(run).filter((e) => e.type === 'run.resumed').map((e) => e.data.steps), [['review']]);
  releaseRun(again);
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

test('workflow engine: a blocked coder is ruled on only when the policy sets maxBlockedRulings', async (t) => {
  const script = { 'coder:impl': [{ status: 'blocked', needsInput: ['which file?'] }], 'arbiter:impl': [{ status: 'completed' }] };
  for (const limits of [{}, { maxBlockedRulings: 0 }]) {
    const { run, handle } = setup(t, { policy: withLimits(limits) });
    const provider = fakeProvider(script);
    const verifier = fakeVerifier();
    const state = await runWorkflow(handle, { provider, verifier });
    assert.equal(state.status, 'BLOCKED');
    assert.equal(state.stopReason, 'role-blocked');
    assert.equal(state.steps.impl.lastError, 'the coder needs input (1 items)');
    assert.deepEqual(callKeys(provider), ['coder:impl:1']);
    assert.deepEqual(verifier.runs, []);
    assert.equal(events(run).some((e) => e.type === 'blocked.ruled'), false);
    releaseRun(handle);
  }
});

test('workflow engine: an arbiter that sees a blocked step as done lets the run continue when the checks pass', async (t) => {
  const { ctx, run, handle } = setup(t, { policy: withLimits({ maxBlockedRulings: 1 }) });
  const provider = fakeProvider({ 'coder:impl': [{ status: 'blocked', summary: 'the tests are missing', needsInput: ['may I add test/a.test.js?'] }], 'arbiter:impl': [{ status: 'completed' }] });
  const verifier = fakeVerifier();
  const state = await runWorkflow(handle, { provider, verifier });
  assert.equal(state.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(provider), ['coder:impl:1', 'arbiter:impl:1', 'coder:tests:1', 'reviewer:review:1', 'auditor:audit:1']);
  assert.deepEqual(verifier.runs.map((r) => r.stepId), ['impl', 'tests', 'review']);
  assert.equal(state.budget.agentCalls, 6);
  assert.equal(state.steps.impl.attempts, 1);
  assert.equal(state.budget.repairAttempts.impl, undefined);
  const { statusId, ...request } = provider.calls[1];
  assert.equal(statusId, 'impl');
  assert.deepEqual(request, {
    role: 'arbiter',
    stepId: 'impl',
    attempt: 1,
    goal: PLAN.goal,
    instruction: 'Implement validation',
    acceptance: ['Rejects bad input'],
    writePaths: ['src/a.js'],
    blocked: { summary: 'the tests are missing', findings: [], needsInput: ['may I add test/a.test.js?'] },
    checkFailures: [],
    laterSteps: [{ id: 'tests', writePaths: ['test/a.test.js'], acceptance: ['Covers bad input'] }],
    feedback: null,
  });
  const ruled = events(run).filter((e) => e.type === 'blocked.ruled');
  assert.equal(ruled.length, 1);
  assert.match(ruled[0].data.artifact, /^ruling-\d+\.json$/);
  assert.deepEqual({ ...ruled[0].data, artifact: null, sha256: null }, { role: 'arbiter', stepId: 'impl', attempt: 1, valid: true, status: 'completed', ruling: 'proceed', artifact: null, sha256: null });
  assert.equal(JSON.parse(fs.readFileSync(path.join(run.dir, 'artifacts', ruled[0].data.artifact), 'utf8')).result.status, 'completed');
  assert.deepEqual(events(run).filter((e) => e.type === 'role.result').map((e) => e.data.role), ['coder', 'coder', 'reviewer', 'auditor']);
  const listed = reportView(readRun(ctx, run.runId)).artifacts.find((a) => a.role === 'arbiter');
  assert.deepEqual(listed, { role: 'arbiter', stepId: 'impl', attempt: 1, valid: true, status: 'completed', path: `artifacts/${ruled[0].data.artifact}`, sha256: ruled[0].data.sha256 });
  releaseRun(handle);
});

test('workflow engine: a blocked step stays BLOCKED when the arbiter agrees, answers badly, or the checks fail', async (t) => {
  const failing = { exitCode: 1, failedTests: ['t1'] };
  const cases = [
    ['the arbiter agrees', { status: 'blocked', needsInput: ['a decision on the file name'] }, {}, /^the coder needs input \(1 items\); the arbiter agreed; see artifacts\/ruling-\d+\.json$/, [true, 'blocked']],
    ['an unreadable result', { raw: 'not json' }, {}, /^the coder needs input \(1 items\); the arbiter result was not valid; see artifacts\/ruling-\d+\.json$/, [false, null]],
    ['a result for another step', { stepId: 'tests' }, {}, /the arbiter result was not valid/, [false, null]],
    ['done, but a check fails', { status: 'completed' }, { unit: [failing] }, /^the coder needs input \(1 items\); the arbiter saw the step as done, but check unit exited 1 \(1 failing tests\); see artifacts\/ruling-\d+\.json$/, [true, 'completed']],
  ];
  for (const [name, answer, checks, lastError, [valid, status]] of cases) {
    const { run, handle } = setup(t, { policy: withLimits({ maxBlockedRulings: 1 }) });
    const provider = fakeProvider({ 'coder:impl': [{ status: 'blocked', needsInput: ['which file?'] }], 'arbiter:impl': [answer] });
    const state = await runWorkflow(handle, { provider, verifier: fakeVerifier(checks) });
    assert.equal(state.status, 'BLOCKED', name);
    assert.equal(state.stopReason, 'role-blocked', name);
    assert.equal(state.steps.impl.status, 'BLOCKED', name);
    assert.match(state.steps.impl.lastError, lastError, name);
    assert.deepEqual(callKeys(provider), ['coder:impl:1', 'arbiter:impl:1'], name);
    const { data } = events(run).find((e) => e.type === 'blocked.ruled');
    assert.deepEqual([data.valid, data.status, data.ruling], [valid, status, 'uphold'], name);
    assert.deepEqual(provider.calls[1].checkFailures, checks.unit ? [{ id: 'unit', ...failing }] : [], name);
    releaseRun(handle);
  }
});

test('workflow engine: an arbiter that asks for another attempt sends its findings to the coder, within both limits', async (t) => {
  const finding = { code: 'stay-local', severity: 'low', path: 'src/a.js', evidence: 'validate in src/a.js without the helper' };
  const blocked = { status: 'blocked', needsInput: ['may I edit src/helper.js?'] };
  const retry = { status: 'needs_changes', findings: [finding] };
  const failing = { exitCode: 1, failedTests: ['t1'] };

  const first = setup(t, { policy: withLimits({ maxBlockedRulings: 1 }) });
  const provider = fakeProvider({ 'coder:impl': [blocked, {}], 'arbiter:impl': [retry] });
  const s1 = await runWorkflow(first.handle, { provider, verifier: fakeVerifier({ unit: [failing] }) });
  assert.equal(s1.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(provider).slice(0, 4), ['coder:impl:1', 'arbiter:impl:1', 'coder:impl:2', 'coder:tests:1']);
  assert.deepEqual(provider.calls[2].feedback, { findings: [finding], failures: [{ id: 'unit', ...failing }] });
  assert.equal(s1.budget.repairAttempts.impl, 1);
  assert.equal(events(first.run).find((e) => e.type === 'blocked.ruled').data.ruling, 'retry');
  releaseRun(first.handle);

  const again = setup(t, { policy: withLimits({ maxBlockedRulings: 1 }) });
  const twice = fakeProvider({ 'coder:impl': [blocked, blocked], 'arbiter:impl': [retry, { status: 'completed' }] });
  const s2 = await runWorkflow(again.handle, { provider: twice, verifier: fakeVerifier() });
  assert.equal(s2.status, 'BLOCKED');
  assert.equal(s2.steps.impl.lastError, 'the coder needs input (1 items)');
  assert.deepEqual(callKeys(twice), ['coder:impl:1', 'arbiter:impl:1', 'coder:impl:2']);
  assert.deepEqual(twice.calls[2].feedback, { findings: [finding] });
  releaseRun(again.handle);

  const spent = setup(t, { policy: withLimits({ maxBlockedRulings: 1, maxRepairAttempts: 0 }) });
  const once = fakeProvider({ 'coder:impl': [blocked], 'arbiter:impl': [retry] });
  const s3 = await runWorkflow(spent.handle, { provider: once, verifier: fakeVerifier() });
  assert.equal(s3.status, 'BLOCKED');
  assert.equal(s3.stopReason, 'role-blocked');
  assert.match(s3.steps.impl.lastError, /the arbiter asked for another attempt, but maxRepairAttempts is used up/);
  assert.deepEqual(callKeys(once), ['coder:impl:1', 'arbiter:impl:1']);
  releaseRun(spent.handle);
});

test('workflow engine: with no agent call left, a blocked coder stops as before and no ruling is asked for', async (t) => {
  const { run, handle } = setup(t, { policy: withLimits({ maxSteps: 2, maxAgentCalls: 5, maxBlockedRulings: 1 }) });
  const provider = fakeProvider({ 'coder:tests': [{ status: 'blocked', needsInput: ['which case?'] }] });
  const verifier = fakeVerifier({ unit: [{ exitCode: 1, failedTests: ['a'] }, { exitCode: 1, failedTests: ['b'] }] });
  const state = await runWorkflow(handle, { provider, verifier });
  assert.deepEqual(callKeys(provider), ['coder:impl:1', 'coder:impl:2', 'coder:impl:3', 'coder:tests:1']);
  assert.equal(state.budget.agentCalls, 5);
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.stopReason, 'role-blocked');
  assert.equal(state.steps.tests.lastError, 'the coder needs input (1 items)');
  assert.equal(verifier.runs.length, 3);
  assert.equal(events(run).some((e) => e.type === 'blocked.ruled'), false);
  releaseRun(handle);
});

test('workflow engine: a blocked review-fix is ruled on with the findings it was given, and the review runs again', async (t) => {
  const finding = { code: 'bug', severity: 'high', path: 'src/a.js', evidence: 'wrong branch' };
  const extra = { code: 'narrow', severity: 'low', path: 'src/a.js', evidence: 'change only the branch' };
  const review = { status: 'needs_changes', findings: [finding] };
  const blocked = { status: 'blocked', needsInput: ['may I rewrite the tests?'] };

  const done = setup(t, { policy: withLimits({ maxBlockedRulings: 1 }) });
  const provider = fakeProvider({ 'reviewer:review': [review], 'coder:review-fix': [blocked], 'arbiter:review-fix': [{ status: 'completed' }] });
  const verifier = fakeVerifier();
  const s1 = await runWorkflow(done.handle, { provider, verifier });
  assert.equal(s1.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(provider), ['coder:impl:1', 'coder:tests:1', 'reviewer:review:1', 'coder:review-fix:1', 'arbiter:review-fix:1', 'reviewer:review:2', 'auditor:audit:1']);
  const ruling = provider.calls[4];
  assert.equal(ruling.statusId, 'review');
  assert.equal(ruling.instruction, 'Apply the reviewer findings');
  assert.deepEqual(ruling.writePaths, ['src/a.js']);
  assert.deepEqual(ruling.feedback, { findings: [finding] });
  assert.deepEqual(ruling.laterSteps, []);
  assert.deepEqual(verifier.runs.map((r) => r.stepId), ['impl', 'tests', 'review', 'review']);
  assert.equal(events(done.run).filter((e) => e.type === 'steps.rechecked').length, 1);
  assert.equal(s1.reviewFix, undefined);
  releaseRun(done.handle);

  const more = setup(t, { policy: withLimits({ maxBlockedRulings: 1 }) });
  const second = fakeProvider({ 'reviewer:review': [review], 'coder:review-fix': [blocked, {}], 'arbiter:review-fix': [{ status: 'needs_changes', findings: [extra] }] });
  const s2 = await runWorkflow(more.handle, { provider: second, verifier: fakeVerifier() });
  assert.equal(s2.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(second).slice(3), ['coder:review-fix:1', 'arbiter:review-fix:1', 'coder:review-fix:2', 'reviewer:review:2', 'auditor:audit:1']);
  assert.deepEqual(second.calls[5].feedback, { findings: [finding, extra] });
  assert.equal(s2.budget.repairAttempts['review-fix'], 2);
  assert.equal(events(more.run).filter((e) => e.type === 'review-fix.retry').length, 1);
  releaseRun(more.handle);

  const kept = setup(t, { policy: withLimits({ maxBlockedRulings: 1 }) });
  const third = fakeProvider({ 'reviewer:review': [review], 'coder:review-fix': [blocked], 'arbiter:review-fix': [{ status: 'blocked', needsInput: ['a decision on the tests'] }] });
  const s3 = await runWorkflow(kept.handle, { provider: third, verifier: fakeVerifier() });
  assert.equal(s3.status, 'BLOCKED');
  assert.equal(s3.stopReason, 'role-blocked');
  assert.match(s3.steps.review.lastError, /^review-fix needs input \(1 items\); the arbiter agreed; see artifacts\/ruling-\d+\.json$/);
  releaseRun(kept.handle);
});

test('workflow engine: a failing required check after the work steps is repaired before review', async (t) => {
  const { handle } = setup(t);
  const provider = fakeProvider();
  const verifier = fakeVerifier({ unit: [{}, {}, { exitCode: 1, failedTests: ['integration'] }] });
  const errorsDuringFix = [];
  const watching = {
    call(req) {
      if (req.stepId === 'review-fix') {
        errorsDuringFix.push(handle.state.steps.review.lastError);
      }
      return provider.call(req);
    },
  };
  const state = await runWorkflow(handle, { provider: watching, verifier });
  assert.equal(state.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(provider), ['coder:impl:1', 'coder:tests:1', 'coder:review-fix:1', 'reviewer:review:1', 'auditor:audit:1']);
  assert.deepEqual(errorsDuringFix, ['check unit exited 1 (1 failing tests)']);
  assert.deepEqual(provider.calls[2].feedback, { failures: [{ id: 'unit', exitCode: 1, failedTests: ['integration'] }] });
  assert.deepEqual(provider.calls[2].writePaths, [...new Set(PLAN.steps.flatMap((s) => s.writePaths))]);
  assert.equal(state.budget.repairAttempts['review-fix'], 1);
  assert.equal(state.reviewFix, undefined);
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
    const v = verifier || { ...fakeVerifier(), async run() { clock.advance(15); throw new Error('unclassified verifier failure'); } };
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

test('workflow engine: a last call that runs past runTimeoutSeconds stops the run instead of succeeding', async (t) => {
  const { handle } = setup(t, { policy: withLimits({ runTimeoutSeconds: 100 }) });
  const clock = fakeClock();
  const provider = fakeProvider({}, { clock, secondsPerCall: 30 });
  const state = await runWorkflow(handle, { provider, verifier: fakeVerifier(), clock: clock.now });
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.stopReason, 'runTimeoutSeconds');
  assert.equal(state.budget.activeSeconds, 120);
  assert.equal(state.steps.audit.status, 'BLOCKED');
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
  assert.equal(state.status, 'BLOCKED');
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
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.stopReason, 'runTimeoutSeconds');
  assert.equal(state.steps.impl.status, 'BLOCKED');
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

test('workflow engine: a review-fix that cannot go on stops from RUNNING or VERIFYING, never from RETRY_PENDING', async (t) => {
  const needs = (code) => ({ status: 'needs_changes', findings: [{ code, severity: 'high', path: 'src/a.js', evidence: 'e' }] });
  const fail = (name) => ({ exitCode: 1, failedTests: [name] });
  const cases = [
    { name: 'the last attempt fails its recheck', script: { 'reviewer:review': [needs('a')] }, checks: { unit: [{}, {}, {}, fail('x'), fail('y')] }, reason: 'repair-limit', last: 'VERIFYING->FAILED' },
    { name: 'new findings after the last attempt', script: { 'reviewer:review': [needs('a'), needs('b'), needs('c')] }, reason: 'repair-limit', last: 'RUNNING->FAILED' },
    { name: 'the same findings three times', limits: { maxRepairAttempts: 5 }, script: { 'reviewer:review': [needs('a'), needs('a'), needs('a')] }, reason: 'same-failure', last: 'RUNNING->FAILED' },
    { name: 'the same recheck failure three times', limits: { maxRepairAttempts: 5 }, script: { 'reviewer:review': [needs('a')] }, checks: { unit: [{}, {}, {}, fail('x'), fail('x'), fail('x')] }, reason: 'same-failure', last: 'VERIFYING->FAILED' },
    { name: 'no agent call left for the fix', limits: { maxSteps: 2, maxAgentCalls: 5 }, script: { 'coder:impl': [{ transport: 'EA' }], 'reviewer:review': [needs('a')] }, reason: 'maxAgentCalls', status: 'BLOCKED', last: 'RUNNING->BLOCKED' },
    { name: 'no agent call left after a failed recheck', limits: { maxSteps: 2, maxAgentCalls: 5 }, script: { 'reviewer:review': [needs('a')] }, checks: { unit: [{}, {}, {}, fail('x')] }, reason: 'maxAgentCalls', status: 'BLOCKED', last: 'VERIFYING->BLOCKED' },
    { name: 'no active time left for the fix', limits: { runTimeoutSeconds: 90 }, seconds: 30, script: { 'reviewer:review': [needs('a')] }, reason: 'runTimeoutSeconds', status: 'BLOCKED', last: 'RUNNING->BLOCKED' },
  ];
  for (const c of cases) {
    const { run, handle } = setup(t, { policy: c.limits ? withLimits(c.limits) : POLICY });
    const clock = fakeClock();
    const provider = fakeProvider(c.script, { clock, secondsPerCall: c.seconds || 0 });
    const state = await runWorkflow(handle, { provider, verifier: fakeVerifier(c.checks), clock: clock.now });
    assert.equal(state.status, c.status || 'FAILED', c.name);
    assert.equal(state.stopReason, c.reason, c.name);
    assert.equal(state.steps.review.status, c.status || 'FAILED', c.name);
    assert.equal(state.steps.review.reason, c.reason, c.name);
    const changes = stepChanges(run, 'review');
    assert.equal(changes.at(-1), c.last, `${c.name}: ${changes.join(', ')}`);
    assert.ok(!changes.includes('RETRY_PENDING->FAILED') && !changes.includes('RETRY_PENDING->BLOCKED'), `${c.name}: ${changes.join(', ')}`);
    releaseRun(handle);
  }
});

test('workflow engine: every review-fix attempt goes through READY before it runs', async (t) => {
  const { run, handle } = setup(t);
  const finding = { code: 'bug', severity: 'high', path: 'src/a.js', evidence: 'e' };
  const provider = fakeProvider({ 'reviewer:review': [{ status: 'needs_changes', findings: [finding] }] });
  const state = await runWorkflow(handle, { provider, verifier: fakeVerifier({ unit: [{}, {}, {}, { exitCode: 1, failedTests: ['x'] }] }) });
  assert.equal(state.status, 'SUCCEEDED');
  assert.deepEqual(stepChanges(run, 'review'), [
    'PENDING->READY', 'READY->RUNNING', 'RUNNING->RETRY_PENDING',
    'RETRY_PENDING->READY', 'READY->RUNNING', 'RUNNING->VERIFYING', 'VERIFYING->RETRY_PENDING',
    'RETRY_PENDING->READY', 'READY->RUNNING', 'RUNNING->VERIFYING', 'VERIFYING->PENDING',
    'PENDING->READY', 'READY->RUNNING', 'RUNNING->SUCCEEDED',
  ]);
  releaseRun(handle);
});

test('workflow engine: a review step that has not started keeps its status when the time ends at the required gate', async (t) => {
  const exact = setup(t, { policy: withLimits({ runTimeoutSeconds: 100 }) });
  const clock = fakeClock();
  const provider = fakeProvider({}, { clock, secondsPerCall: 40 });
  const s1 = await runWorkflow(exact.handle, { provider, verifier: fakeVerifier({}, { clock, secondsPerRun: 10 }), clock: clock.now });
  assert.equal(s1.status, 'BLOCKED');
  assert.equal(s1.stopReason, 'runTimeoutSeconds');
  assert.equal(s1.budget.activeSeconds, 100);
  assert.equal(s1.steps.review.status, 'PENDING');
  assert.equal(s1.steps.review.reason, undefined);
  assert.deepEqual(callKeys(provider), ['coder:impl:1', 'coder:tests:1']);
  releaseRun(exact.handle);

  for (const [limit, gateSeconds, used] of [[100, 0, 100], [105, 10, 110]]) {
    const blocked = setup(t, { policy: withLimits({ runTimeoutSeconds: limit }) });
    const time = fakeClock();
    const script = { 'reviewer:review': ['EA', 'EB', 'EC'].map((code) => ({ transport: code })) };
    const s2 = await runWorkflow(blocked.handle, { provider: fakeProvider(script, { clock: time, secondsPerCall: 20 }), verifier: fakeVerifier(), clock: time.now });
    assert.equal(s2.status, 'BLOCKED');
    assert.equal(s2.steps.review.reason, 'transport');
    const s3 = await runWorkflow(blocked.handle, { provider: fakeProvider(), verifier: fakeVerifier({}, { clock: time, secondsPerRun: gateSeconds }), clock: time.now, resume: true });
    assert.equal(s3.status, 'BLOCKED', `limit ${limit}`);
    assert.equal(s3.stopReason, 'runTimeoutSeconds', `limit ${limit}`);
    assert.equal(s3.budget.activeSeconds, used, `limit ${limit}`);
    assert.equal(s3.steps.review.status, 'READY', `limit ${limit}`);
    releaseRun(blocked.handle);
  }
});

function failsAtBase(policy = POLICY) {
  return { ...policy, checks: policy.checks.map((c) => (c.id === 'unit' ? { ...c, baseline: 'fail' } : c)) };
}

function ofType(run, type) {
  return events(run).filter((e) => e.type === type).map((e) => e.data);
}

test('workflow engine: a check that fails at the base commit stops the run before any call', async (t) => {
  const { run, handle } = setup(t);
  const provider = fakeProvider();
  const verifier = fakeVerifier({}, { baseline: { unit: [{ exitCode: 1, failedTests: ['a'] }] } });
  const state = await runWorkflow(handle, { provider, verifier });
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.stopReason, 'baseline-failed');
  assert.deepEqual(provider.calls, []);
  assert.deepEqual(verifier.runs, []);
  assert.deepEqual(ofType(run, 'checks.baseline')[0].results, [{ id: 'unit', exitCode: 1, failedTests: ['a'], timedOut: false, expected: 'pass', matched: false }]);
  assert.equal(state.preflightDone, undefined);
  assert.deepEqual(statuses(state), { impl: 'PENDING', tests: 'PENDING', review: 'PENDING', audit: 'PENDING' });
  releaseRun(handle);
});

test('workflow engine: a check marked to fail at the base commit goes on when it fails there, and both results stay on record', async (t) => {
  const { run, handle } = setup(t, { policy: failsAtBase() });
  const provider = fakeProvider();
  const verifier = fakeVerifier({}, { baseline: { unit: [{ exitCode: 1 }] } });
  const state = await runWorkflow(handle, { provider, verifier });
  assert.equal(state.status, 'SUCCEEDED');
  assert.equal(state.preflightDone, true);
  assert.deepEqual(ofType(run, 'checks.baseline')[0].results, [{ id: 'unit', exitCode: 1, failedTests: [], timedOut: false, expected: 'fail', matched: true }]);
  assert.equal(ofType(run, 'checks.finished').at(-1).results[0].exitCode, 0);
  releaseRun(handle);
});

test('workflow engine: a check marked to fail at the base commit must fail by itself', async (t) => {
  for (const [name, result] of [
    ['it passes', { exitCode: 0 }],
    ['it times out', { exitCode: 124, timedOut: true }],
    ['it is killed', { exitCode: 137, completed: false }],
    ['it cannot start', { exitCode: 127, completed: false }],
  ]) {
    const { handle } = setup(t, { policy: failsAtBase() });
    const provider = fakeProvider();
    const state = await runWorkflow(handle, { provider, verifier: fakeVerifier({}, { baseline: { unit: [result] } }) });
    assert.equal(state.status, 'BLOCKED', name);
    assert.equal(state.stopReason, 'baseline-unexpected', name);
    assert.deepEqual(provider.calls, [], name);
    releaseRun(handle);
  }
});

test('workflow engine: the checks of the work steps and the required checks run at the base commit, others do not', async (t) => {
  const policy = { ...POLICY, checks: [...POLICY.checks, { id: 'unused', command: 'npm', args: [], timeout: 60 }] };
  const plan = { ...PLAN, steps: [{ ...PLAN.steps[0], checkIds: ['lint', 'unit'] }, PLAN.steps[1]] };
  const { handle } = setup(t, { policy, plan });
  const verifier = fakeVerifier();
  await runWorkflow(handle, { provider: fakeProvider(), verifier });
  assert.deepEqual(verifier.baselineRuns, [['lint', 'unit']]);
  releaseRun(handle);
});

test('workflow engine: a failing setup command stops the run before the baseline checks', async (t) => {
  const policy = { ...POLICY, setup: [{ id: 'install', command: 'npm', args: ['ci'], timeout: 60 }] };
  const { run, handle } = setup(t, { policy });
  const provider = fakeProvider();
  const verifier = fakeVerifier({}, { setup: [{ id: 'install', exitCode: 1, timedOut: false }] });
  const state = await runWorkflow(handle, { provider, verifier });
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.stopReason, 'setup-failed');
  assert.deepEqual(verifier.baselineRuns, []);
  assert.deepEqual(provider.calls, []);
  assert.deepEqual(ofType(run, 'setup.finished'), [{ results: [{ id: 'install', exitCode: 1, timedOut: false }] }]);
  releaseRun(handle);
  const clean = setup(t, { policy });
  const passing = fakeVerifier({}, { setup: [{ id: 'install', exitCode: 0, timedOut: false }] });
  assert.equal((await runWorkflow(clean.handle, { provider: fakeProvider(), verifier: passing })).status, 'SUCCEEDED');
  assert.equal(passing.setupRuns.length, 1);
  releaseRun(clean.handle);
  const none = setup(t);
  const unused = fakeVerifier();
  assert.equal((await runWorkflow(none.handle, { provider: fakeProvider(), verifier: unused })).status, 'SUCCEEDED');
  assert.deepEqual(unused.setupRuns, []);
  assert.deepEqual(ofType(none.run, 'setup.finished'), []);
  releaseRun(none.handle);
});

test('workflow engine: files changed before any call stop the run, whichever way the change was found', async (t) => {
  for (const seal of [{ changed: ['coverage.txt'] }, { violations: [{ path: '.codex/x', reason: 'protected-path' }] }]) {
    const { run, handle } = setup(t);
    const provider = fakeProvider();
    const state = await runWorkflow(handle, { provider, verifier: fakeVerifier({}, { seals: [seal] }) });
    assert.equal(state.status, 'BLOCKED');
    assert.equal(state.stopReason, 'preflight-changed-files');
    assert.deepEqual(provider.calls, []);
    const [recorded] = ofType(run, 'checks.baseline');
    assert.deepEqual(recorded.changed, seal.changed || []);
    assert.deepEqual(recorded.violations, seal.violations || []);
    const resumed = fakeVerifier();
    assert.equal((await runWorkflow(handle, { provider, verifier: resumed, resume: true })).status, 'SUCCEEDED');
    assert.deepEqual(resumed.baselineRuns, [['unit']]);
    releaseRun(handle);
  }
});

test('workflow engine: only workflow resume repeats a stopped preparation, from the setup commands on', async (t) => {
  const policy = { ...POLICY, setup: [{ id: 'install', command: 'npm', args: ['ci'], timeout: 60 }] };
  const ok = { setup: [{ id: 'install', exitCode: 0, timedOut: false }] };
  const { run, handle } = setup(t, { policy });
  const first = fakeVerifier({}, { ...ok, baseline: { unit: [{ exitCode: 1 }] } });
  assert.equal((await runWorkflow(handle, { provider: fakeProvider(), verifier: first })).stopReason, 'baseline-failed');
  const notResumed = fakeVerifier({}, ok);
  assert.equal((await runWorkflow(handle, { provider: fakeProvider(), verifier: notResumed })).status, 'BLOCKED');
  assert.deepEqual(notResumed.setupRuns, []);
  const second = fakeVerifier({}, ok);
  const state = await runWorkflow(handle, { provider: fakeProvider(), verifier: second, resume: true });
  assert.equal(state.status, 'SUCCEEDED');
  assert.equal(second.setupRuns.length, 1);
  assert.deepEqual(second.baselineRuns, [['unit']]);
  assert.deepEqual(ofType(run, 'run.resumed').map((d) => d.steps), [[]]);
  releaseRun(handle);
});

test('workflow engine: a finished preparation is not repeated when the run resumes', async (t) => {
  const { handle } = setup(t);
  const script = { 'reviewer:review': ['EA', 'EB', 'EC'].map((code) => ({ transport: code })) };
  const first = fakeVerifier();
  const s1 = await runWorkflow(handle, { provider: fakeProvider(script), verifier: first });
  assert.equal(s1.steps.review.reason, 'transport');
  assert.equal(first.baselineRuns.length, 1);
  const second = fakeVerifier();
  assert.equal((await runWorkflow(handle, { provider: fakeProvider(), verifier: second, resume: true })).status, 'SUCCEEDED');
  assert.deepEqual(second.baselineRuns, []);
  releaseRun(handle);
});

test('workflow engine: an error during the baseline checks ends the run by the same rule and a resumed run prepares again', async (t) => {
  const interrupted = setup(t);
  const clock = fakeClock();
  const failing = { ...fakeVerifier(), async baseline() { clock.advance(15); throw new Error('unclassified baseline failure'); } };
  await assert.rejects(runWorkflow(interrupted.handle, { provider: fakeProvider(), verifier: failing, clock: clock.now }), /unclassified baseline failure/);
  assert.equal(interrupted.handle.state.status, 'INTERRUPTED');
  assert.equal(interrupted.handle.state.budget.activeSeconds, 15);
  releaseRun(interrupted.handle);
  const h2 = acquireRun(interrupted.ctx, interrupted.run.runId);
  const later = fakeVerifier();
  const state = await runWorkflow(h2, { provider: fakeProvider(), verifier: later, resume: true, recovery: { passed: true, artifact: 'recovery-1.json', changedFiles: [] } });
  assert.equal(state.status, 'SUCCEEDED');
  assert.equal(later.baselineRuns.length, 1);
  releaseRun(h2);

  const cancelled = setup(t);
  const cancelling = { ...fakeVerifier(), async baseline() { throw Object.assign(new Error('check "unit" was cancelled'), { cancelled: true, cancelRequested: true }); } };
  await assert.rejects(runWorkflow(cancelled.handle, { provider: fakeProvider(), verifier: cancelling }), /was cancelled/);
  assert.equal(cancelled.handle.state.status, 'CANCELLED');
  assert.deepEqual(statuses(cancelled.handle.state), { impl: 'PENDING', tests: 'PENDING', review: 'PENDING', audit: 'PENDING' });
  releaseRun(cancelled.handle);
});

test('workflow engine: the time of the preparation counts toward runTimeoutSeconds', async (t) => {
  const policy = { ...POLICY, limits: { runTimeoutSeconds: 100 }, setup: [{ id: 'install', command: 'npm', args: ['ci'], timeout: 60 }] };
  const ok = [{ id: 'install', exitCode: 0, timedOut: false }];
  const inSetup = setup(t, { policy });
  const clock1 = fakeClock();
  const plainSetup = fakeVerifier();
  const slowSetup = { ...plainSetup, async setup() { clock1.advance(101); return ok; } };
  const provider1 = fakeProvider();
  const s1 = await runWorkflow(inSetup.handle, { provider: provider1, verifier: slowSetup, clock: clock1.now });
  assert.equal(s1.status, 'BLOCKED');
  assert.equal(s1.stopReason, 'runTimeoutSeconds');
  assert.equal(s1.budget.activeSeconds, 101);
  assert.deepEqual(provider1.calls, []);
  assert.deepEqual(plainSetup.baselineRuns, []);
  releaseRun(inSetup.handle);

  const inBaseline = setup(t, { policy });
  const clock2 = fakeClock();
  const plain = fakeVerifier();
  const slowBaseline = { ...plain, async baseline(req) { clock2.advance(60); return plain.baseline(req); }, async setup() { clock2.advance(60); return ok; } };
  const provider2 = fakeProvider();
  const s2 = await runWorkflow(inBaseline.handle, { provider: provider2, verifier: slowBaseline, clock: clock2.now });
  assert.equal(s2.status, 'BLOCKED');
  assert.equal(s2.stopReason, 'runTimeoutSeconds');
  assert.equal(s2.budget.activeSeconds, 120);
  assert.deepEqual(provider2.calls, []);
  releaseRun(inBaseline.handle);

  const failingLate = setup(t, { policy });
  const clock3 = fakeClock();
  const failing = fakeVerifier({}, { baseline: { unit: [{ exitCode: 1 }] } });
  const slowFailure = { ...failing, async baseline(req) { clock3.advance(101); return failing.baseline(req); }, async setup() { return ok; } };
  const s3 = await runWorkflow(failingLate.handle, { provider: fakeProvider(), verifier: slowFailure, clock: clock3.now });
  assert.equal(s3.status, 'BLOCKED');
  assert.equal(s3.stopReason, 'runTimeoutSeconds');
  releaseRun(failingLate.handle);

  const atTheLimit = setup(t, { policy });
  const clock4 = fakeClock();
  const failingAtLimit = fakeVerifier({}, { baseline: { unit: [{ exitCode: 1 }] } });
  const exact = { ...failingAtLimit, async baseline(req) { clock4.advance(100); return failingAtLimit.baseline(req); }, async setup() { return ok; } };
  assert.equal((await runWorkflow(atTheLimit.handle, { provider: fakeProvider(), verifier: exact, clock: clock4.now })).stopReason, 'baseline-failed');
  const resumed = fakeVerifier();
  const s4 = await runWorkflow(atTheLimit.handle, { provider: fakeProvider(), verifier: resumed, clock: clock4.now, resume: true });
  assert.equal(s4.status, 'BLOCKED');
  assert.equal(s4.stopReason, 'runTimeoutSeconds');
  assert.deepEqual(resumed.setupRuns, []);
  assert.deepEqual(resumed.baselineRuns, []);
  releaseRun(atTheLimit.handle);
});

test('workflow engine: every verifier method is required before the run starts', async (t) => {
  for (const method of ['setup', 'baseline', 'seal', 'run']) {
    const { handle } = setup(t);
    const verifier = { ...fakeVerifier(), [method]: undefined };
    await assert.rejects(runWorkflow(handle, { provider: fakeProvider(), verifier }), new RegExp(`verifier\\.${method}\\(request\\) is required`));
    assert.equal(handle.state.status, 'PLANNED');
    releaseRun(handle);
  }
});

test('workflow engine: a required check repair stops at the repair limit and at the third same failure', async (t) => {
  const failing = { exitCode: 1 };
  const noRepairs = setup(t, { policy: withLimits({ maxRepairAttempts: 0 }) });
  const none = fakeProvider();
  const s1 = await runWorkflow(noRepairs.handle, { provider: none, verifier: fakeVerifier({ unit: [{}, {}, failing] }) });
  assert.equal(s1.status, 'FAILED');
  assert.equal(s1.stopReason, 'repair-limit');
  assert.equal(s1.steps.review.status, 'FAILED');
  assert.match(s1.steps.review.lastError, /maxRepairAttempts/);
  assert.deepEqual(callKeys(none), ['coder:impl:1', 'coder:tests:1']);
  releaseRun(noRepairs.handle);

  const used = setup(t, { policy: withLimits({ maxRepairAttempts: 1 }) });
  const one = fakeProvider();
  const s2 = await runWorkflow(used.handle, { provider: one, verifier: fakeVerifier({ unit: [{}, {}, { exitCode: 1, failedTests: ['a'] }, { exitCode: 1, failedTests: ['b'] }] }) });
  assert.equal(s2.stopReason, 'repair-limit');
  assert.deepEqual(callKeys(one), ['coder:impl:1', 'coder:tests:1', 'coder:review-fix:1']);
  releaseRun(used.handle);

  const same = setup(t, { policy: withLimits({ maxRepairAttempts: 5 }) });
  const repeat = fakeProvider();
  const s3 = await runWorkflow(same.handle, { provider: repeat, verifier: fakeVerifier({ unit: [{}, {}, failing, failing, failing] }) });
  assert.equal(s3.status, 'FAILED');
  assert.equal(s3.stopReason, 'same-failure');
  assert.deepEqual(callKeys(repeat), ['coder:impl:1', 'coder:tests:1', 'coder:review-fix:1', 'coder:review-fix:2']);
  assert.deepEqual(repeat.calls[3].feedback, { failures: [{ id: 'unit', exitCode: 1, failedTests: [] }] });
  releaseRun(same.handle);

  const named = setup(t, { policy: withLimits({ maxRepairAttempts: 5 }) });
  const names = (n) => ({ exitCode: 1, failedTests: [n] });
  const s4 = await runWorkflow(named.handle, { provider: fakeProvider(), verifier: fakeVerifier({ unit: [{}, {}, names('a'), names('b'), names('a'), {}] }) });
  assert.equal(s4.status, 'SUCCEEDED');
  assert.equal(s4.budget.repairAttempts['review-fix'], 3);
  releaseRun(named.handle);
});

test('workflow engine: a required check repair stopped by transport errors resumes the same fix without findings', async (t) => {
  const { handle } = setup(t);
  const first = fakeProvider({ 'coder:review-fix': ['EA', 'EB', 'EC'].map((code) => ({ transport: code })) });
  const s1 = await runWorkflow(handle, { provider: first, verifier: fakeVerifier({ unit: [{}, {}, { exitCode: 1, failedTests: ['a'] }] }) });
  assert.equal(s1.status, 'BLOCKED');
  assert.equal(s1.steps.review.reason, 'transport');
  assert.deepEqual(s1.reviewFix, { stepId: 'review', role: 'required-checks', artifact: null, attempt: 1 });
  const second = fakeProvider();
  const s2 = await runWorkflow(handle, { provider: second, verifier: fakeVerifier(), resume: true });
  assert.equal(s2.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(second), ['coder:review-fix:1', 'reviewer:review:1', 'auditor:audit:1']);
  assert.deepEqual(second.calls[0].feedback, { failures: [{ id: 'unit', exitCode: 1, failedTests: ['a'] }] });
  assert.equal(second.calls[0].instruction, 'Fix the failing required checks');
  assert.equal(s2.budget.repairAttempts['review-fix'], 1);
  assert.equal(s2.reviewFix, undefined);
  releaseRun(handle);
});

test('workflow engine: the checked result is sealed, recorded on success, and a review fix seals it again', async (t) => {
  const { run, handle } = setup(t);
  const finding = { code: 'missing-case', severity: 'medium', path: 'test/a.test.js', evidence: 'no empty input case' };
  const provider = fakeProvider({ 'reviewer:review': [{ status: 'needs_changes', findings: [finding] }] });
  const seals = [{}, { patchSha256: 'one' }, { patchSha256: 'one' }, { patchSha256: 'two' }, { patchSha256: 'two' }, { patchSha256: 'two' }, { patchSha256: 'two' }];
  const state = await runWorkflow(handle, { provider, verifier: fakeVerifier({}, { seals }) });
  assert.equal(state.status, 'SUCCEEDED');
  assert.deepEqual(ofType(run, 'checks.sealed').map((d) => d.patchSha256), ['one']);
  assert.equal(ofType(run, 'steps.rechecked')[0].patchSha256, 'two');
  assert.deepEqual(ofType(run, 'seal.broken'), []);
  assert.equal(ofType(run, 'run.succeeded')[0].patchSha256, 'two');
  assert.equal(state.sealedPatch, 'two');
  releaseRun(handle);
});

test('workflow engine: a result that differs from the seal runs every check and both reviews again', async (t) => {
  for (const [name, seals, reviewCalls] of [
    ['before the reviewer', [{}, {}, { patchSha256: 'changed' }], ['reviewer:review:1', 'auditor:audit:1']],
    ['before the auditor', [{}, {}, {}, { patchSha256: 'changed' }], ['reviewer:review:1', 'reviewer:review:2', 'auditor:audit:1']],
    ['at the end', [{}, {}, {}, {}, { patchSha256: 'changed' }], ['reviewer:review:1', 'auditor:audit:1', 'reviewer:review:2', 'auditor:audit:2']],
  ]) {
    const plan = { ...PLAN, steps: [{ ...PLAN.steps[0], checkIds: ['lint'] }, PLAN.steps[1]] };
    const { run, handle } = setup(t, { plan });
    const provider = fakeProvider();
    const verifier = fakeVerifier({}, { seals });
    const state = await runWorkflow(handle, { provider, verifier });
    assert.equal(state.status, 'SUCCEEDED', name);
    assert.deepEqual(callKeys(provider).slice(2), reviewCalls, name);
    assert.deepEqual(verifier.runs.filter((r) => r.stepId === 'review').map((r) => r.checkIds), [['unit'], ['lint', 'unit']], name);
    assert.equal(ofType(run, 'seal.broken').length, 1, name);
    assert.equal(ofType(run, 'seal.broken')[0].current, 'changed', name);
    assert.equal(state.recheckAll, undefined, name);
    assert.equal(ofType(run, 'run.succeeded')[0].patchSha256, 'fake', name);
    releaseRun(handle);
  }
});

test('workflow engine: the third difference from the seal in a row ends the run, also when a review passes between them', async (t) => {
  const hash = (patchSha256) => ({ patchSha256 });
  const beforeReviewer = setup(t);
  const p1 = fakeProvider();
  const s1 = await runWorkflow(beforeReviewer.handle, { provider: p1, verifier: fakeVerifier({}, { seals: [{}, hash('a'), hash('b'), hash('c'), hash('d'), hash('e'), hash('f')] }) });
  assert.equal(s1.status, 'FAILED');
  assert.equal(s1.stopReason, 'same-failure');
  assert.equal(s1.steps.review.status, 'FAILED');
  assert.equal(p1.calls.some((c) => c.role === 'reviewer'), false);
  releaseRun(beforeReviewer.handle);

  const beforeAuditor = setup(t);
  const p2 = fakeProvider();
  const s2 = await runWorkflow(beforeAuditor.handle, { provider: p2, verifier: fakeVerifier({}, { seals: [{}, hash('a'), hash('a'), hash('b'), hash('c'), hash('c'), hash('d'), hash('e'), hash('e'), hash('f')] }) });
  assert.equal(s2.status, 'FAILED');
  assert.equal(s2.stopReason, 'same-failure');
  assert.equal(s2.steps.audit.status, 'FAILED');
  assert.equal(p2.calls.filter((c) => c.role === 'reviewer').length, 3);
  assert.equal(p2.calls.some((c) => c.role === 'auditor'), false);
  releaseRun(beforeAuditor.handle);
});

test('workflow engine: a change outside the scope found at any seal ends the run as FAILED', async (t) => {
  const finding = { code: 'missing-case', severity: 'medium', path: 'test/a.test.js', evidence: 'no empty input case' };
  const bad = { violations: [{ path: 'outside.txt', reason: 'outside-write-paths', status: 'A' }] };
  for (const [name, seals, stepId, script] of [
    ['at the required checks', [{}, bad], 'review', {}],
    ['after a review fix', [{}, {}, {}, bad], 'review', { 'reviewer:review': [{ status: 'needs_changes', findings: [finding] }] }],
    ['before the reviewer', [{}, {}, bad], 'review', {}],
    ['before the auditor', [{}, {}, {}, bad], 'audit', {}],
    ['at the end', [{}, {}, {}, {}, bad], 'audit', {}],
  ]) {
    const { run, handle } = setup(t);
    const state = await runWorkflow(handle, { provider: fakeProvider(script), verifier: fakeVerifier({}, { seals }) });
    assert.equal(state.status, 'FAILED', name);
    assert.equal(state.stopReason, 'policy-violation', name);
    assert.equal(state.steps[stepId].status, 'FAILED', name);
    assert.match(state.steps[stepId].lastError, /outside\.txt \(outside-write-paths\)/, name);
    assert.equal(fs.readdirSync(path.join(run.dir, 'artifacts')).filter((f) => f.startsWith('violations-')).length, 1, name);
    assert.deepEqual(ofType(run, 'run.succeeded'), [], name);
    releaseRun(handle);
  }
});

test('workflow engine: a coder resumed after a failed check gets the failures with the interruption note', async (t) => {
  const failing = { exitCode: 1, failedTests: ['a'] };
  const blocked = setup(t);
  const script = { 'coder:impl': [{}, ...['EA', 'EB', 'EC'].map((code) => ({ transport: code }))] };
  const s1 = await runWorkflow(blocked.handle, { provider: fakeProvider(script), verifier: fakeVerifier({ unit: [failing] }) });
  assert.equal(s1.steps.impl.reason, 'transport');
  const second = fakeProvider();
  assert.equal((await runWorkflow(blocked.handle, { provider: second, verifier: fakeVerifier(), resume: true })).status, 'SUCCEEDED');
  assert.deepEqual(second.calls[0].feedback, { failures: [{ id: 'unit', exitCode: 1, failedTests: ['a'] }] });
  releaseRun(blocked.handle);

  const interrupted = setup(t);
  const first = {
    calls: 0,
    async call(req) {
      this.calls += 1;
      if (this.calls === 2) {
        throw new Error('unclassified provider failure');
      }
      return fakeProvider().call(req);
    },
  };
  await assert.rejects(runWorkflow(interrupted.handle, { provider: first, verifier: fakeVerifier({ unit: [failing] }) }), /unclassified provider failure/);
  releaseRun(interrupted.handle);
  const h2 = acquireRun(interrupted.ctx, interrupted.run.runId);
  const third = fakeProvider();
  const recovery = { passed: true, artifact: 'recovery-1.json', changedFiles: ['src/a.js'] };
  assert.equal((await runWorkflow(h2, { provider: third, verifier: fakeVerifier(), resume: true, recovery })).status, 'SUCCEEDED');
  assert.deepEqual(third.calls[0].feedback, { failures: [{ id: 'unit', exitCode: 1, failedTests: ['a'] }], interrupted: true, changedFiles: ['src/a.js'] });
  releaseRun(h2);
});

test('workflow engine: a review-fix whose result is stored is not called again when its recheck was interrupted', async (t) => {
  const { ctx, run, handle } = setup(t);
  const finding = { code: 'F1', severity: 'high', path: 'src/a.js', evidence: 'wrong' };
  const provider = fakeProvider({ 'reviewer:review': [{ status: 'needs_changes', findings: [finding] }] });
  const inner = fakeVerifier();
  let runs = 0;
  const verifier = {
    ...inner,
    async run(req) {
      runs += 1;
      if (runs === 4) {
        throw new Error('the manager stopped during the review-fix checks');
      }
      return inner.run(req);
    },
  };
  await assert.rejects(runWorkflow(handle, { provider, verifier }), /stopped during the review-fix checks/);
  assert.equal(handle.state.status, 'INTERRUPTED');
  assert.equal(handle.state.reviewFix.attempt, 1);
  const callsBefore = handle.state.budget.agentCalls;
  releaseRun(handle);

  const again = acquireRun(ctx, run.runId);
  const resumed = fakeProvider();
  const recheck = fakeVerifier();
  const state = await runWorkflow(again, { provider: resumed, verifier: recheck, resume: true, recovery: PASSED });
  assert.equal(state.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(resumed), ['reviewer:review:2', 'auditor:audit:1']);
  assert.deepEqual(recheck.runs.map((r) => r.stepId), ['review']);
  assert.equal(state.budget.agentCalls, callsBefore + 2);
  assert.equal(state.budget.repairAttempts['review-fix'], 1);
  assert.deepEqual(fs.readdirSync(path.join(run.dir, 'artifacts')).filter((f) => f.includes('review-fix')), ['02-review-fix-1.json']);
  assert.equal(state.reviewFix, undefined);
  releaseRun(again);
});

function approve(handle, added) {
  const full = { agentCalls: 0, activeSeconds: 0, ...added };
  commitRun(handle, 'budget.extended', full, (n) => {
    extendBudget(n, full);
  });
}

test('workflow engine: a run stopped at maxAgentCalls continues after more calls are approved, without repeating finished work', async (t) => {
  const { ctx, run, handle } = setup(t, { policy: withLimits({ maxSteps: 2, maxAgentCalls: 5 }) });
  const first = await runWorkflow(handle, { provider: fakeProvider(), verifier: fakeVerifier({ unit: [{ exitCode: 1, failedTests: ['x'] }] }) });
  assert.equal(first.status, 'BLOCKED');
  assert.equal(first.stopReason, 'maxAgentCalls');
  assert.deepEqual(statuses(first), { impl: 'SUCCEEDED', tests: 'SUCCEEDED', review: 'SUCCEEDED', audit: 'PENDING' });
  assert.equal(first.budget.extended, undefined);
  releaseRun(handle);

  const h2 = acquireRun(ctx, run.runId);
  const finding = { code: 'bug', severity: 'high', path: 'src/a.js', evidence: 'e' };
  approve(h2, { agentCalls: 1 });
  const second = fakeProvider({ 'auditor:audit': [{ status: 'needs_changes', findings: [finding] }] });
  const s2 = await runWorkflow(h2, { provider: second, verifier: fakeVerifier(), resume: true });
  assert.deepEqual(callKeys(second), ['auditor:audit:1']);
  assert.equal(s2.status, 'BLOCKED');
  assert.equal(s2.stopReason, 'maxAgentCalls');
  assert.equal(s2.steps.audit.status, 'BLOCKED');
  assert.equal(s2.steps.audit.reason, 'maxAgentCalls');
  assert.equal(s2.budget.agentCalls, 6);
  assert.deepEqual(s2.budget.extended, { agentCalls: 1, activeSeconds: 0 });
  assert.equal(s2.reviewFix.stepId, 'audit');
  assert.equal(stepChanges(run, 'audit').at(-1), 'RUNNING->BLOCKED');
  releaseRun(h2);

  const h3 = acquireRun(ctx, run.runId);
  approve(h3, { agentCalls: 3 });
  const third = fakeProvider();
  const verifier = fakeVerifier();
  const s3 = await runWorkflow(h3, { provider: third, verifier, resume: true });
  assert.equal(s3.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(third), ['coder:review-fix:1', 'reviewer:review:2', 'auditor:audit:2']);
  assert.deepEqual(third.calls[0].feedback, { findings: [finding] });
  assert.equal(s3.budget.agentCalls, 9);
  assert.deepEqual(s3.budget.extended, { agentCalls: 4, activeSeconds: 0 });
  assert.equal(events(run).filter((e) => e.type === 'review.changes-requested').length, 1);
  assert.deepEqual(events(run).filter((e) => e.type === 'budget.extended').map((e) => e.data), [{ agentCalls: 1, activeSeconds: 0 }, { agentCalls: 3, activeSeconds: 0 }]);
  assert.deepEqual(readRun(ctx, run.runId).issues, []);
  releaseRun(h3);
});

test('workflow engine: a required check that failed before the limit is not run or counted again after more calls are approved', async (t) => {
  const { ctx, run, handle } = setup(t, { policy: withLimits({ maxSteps: 2, maxAgentCalls: 5 }) });
  const gateFailure = { exitCode: 1, failedTests: ['gate'] };
  const provider = fakeProvider({ 'coder:impl': [{ transport: 'EA' }], 'coder:tests': [{ transport: 'EB' }] });
  const first = await runWorkflow(handle, { provider, verifier: fakeVerifier({ unit: [{}, {}, gateFailure] }) });
  assert.equal(first.status, 'BLOCKED');
  assert.equal(first.stopReason, 'maxAgentCalls');
  assert.equal(first.steps.review.status, 'BLOCKED');
  assert.equal(first.budget.failureStreak.count, 1);
  assert.deepEqual(first.reviewFix, { stepId: 'review', role: 'required-checks', artifact: null, attempt: null });
  assert.ok(!stepChanges(run, 'review').some((c) => c.startsWith('RETRY_PENDING->')));
  releaseRun(handle);

  const h2 = acquireRun(ctx, run.runId);
  approve(h2, { agentCalls: 3 });
  const later = fakeProvider();
  const verifier = fakeVerifier();
  const s2 = await runWorkflow(h2, { provider: later, verifier, resume: true });
  assert.equal(s2.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(later), ['coder:review-fix:1', 'reviewer:review:1', 'auditor:audit:1']);
  assert.deepEqual(later.calls[0].feedback, { failures: [{ id: 'unit', exitCode: 1, failedTests: ['gate'] }] });
  assert.deepEqual(verifier.runs.map((r) => r.stepId), ['review']);
  assert.equal(events(run).filter((e) => e.type === 'gate.check-failed').length, 1);
  assert.equal(s2.budget.agentCalls, 8);
  releaseRun(h2);
});

test('workflow engine: a run stopped at runTimeoutSeconds stays stopped until the approved time covers what was used', async (t) => {
  const { ctx, run, handle } = setup(t, { policy: withLimits({ runTimeoutSeconds: 100 }) });
  const clock = fakeClock();
  const first = await runWorkflow(handle, { provider: fakeProvider({}, { clock, secondsPerCall: 30 }), verifier: fakeVerifier(), clock: clock.now });
  assert.equal(first.status, 'BLOCKED');
  assert.equal(first.stopReason, 'runTimeoutSeconds');
  assert.equal(first.budget.activeSeconds, 120);
  releaseRun(handle);

  const h2 = acquireRun(ctx, run.runId);
  const none = fakeProvider();
  assert.equal((await runWorkflow(h2, { provider: none, verifier: fakeVerifier(), clock: clock.now, resume: true })).status, 'BLOCKED');
  approve(h2, { activeSeconds: 20 });
  const stillShort = await runWorkflow(h2, { provider: none, verifier: fakeVerifier(), clock: clock.now, resume: true });
  assert.equal(stillShort.status, 'BLOCKED');
  assert.equal(stillShort.stopReason, 'runTimeoutSeconds');
  assert.deepEqual(none.calls, []);
  approve(h2, { activeSeconds: 30 });
  const enough = fakeProvider();
  const s2 = await runWorkflow(h2, { provider: enough, verifier: fakeVerifier(), clock: clock.now, resume: true });
  assert.equal(s2.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(enough), ['auditor:audit:2']);
  assert.deepEqual(s2.budget.extended, { agentCalls: 0, activeSeconds: 50 });
  releaseRun(h2);
});

test('workflow engine: a preparation stopped at runTimeoutSeconds runs again after more time is approved, and a finished one does not', async (t) => {
  const policy = { ...POLICY, limits: { runTimeoutSeconds: 100 }, setup: [{ id: 'install', command: 'npm', args: ['ci'], timeout: 60 }] };
  const ok = [{ id: 'install', exitCode: 0, timedOut: false }];
  const inSetup = setup(t, { policy });
  const clock1 = fakeClock();
  const slowSetup = { ...fakeVerifier(), async setup() { clock1.advance(101); return ok; } };
  const s1 = await runWorkflow(inSetup.handle, { provider: fakeProvider(), verifier: slowSetup, clock: clock1.now });
  assert.equal(s1.status, 'BLOCKED');
  assert.equal(s1.stopReason, 'runTimeoutSeconds');
  assert.equal(s1.preflightDone, undefined);
  approve(inSetup.handle, { activeSeconds: 50 });
  const again = fakeVerifier({}, { setup: ok });
  const s2 = await runWorkflow(inSetup.handle, { provider: fakeProvider(), verifier: again, clock: clock1.now, resume: true });
  assert.equal(s2.status, 'SUCCEEDED');
  assert.equal(again.setupRuns.length, 1);
  assert.equal(again.baselineRuns.length, 1);
  releaseRun(inSetup.handle);

  const inBaseline = setup(t, { policy });
  const clock2 = fakeClock();
  const plain = fakeVerifier();
  const slowBaseline = { ...plain, async baseline(req) { clock2.advance(60); return plain.baseline(req); }, async setup() { clock2.advance(60); return ok; } };
  const s3 = await runWorkflow(inBaseline.handle, { provider: fakeProvider(), verifier: slowBaseline, clock: clock2.now });
  assert.equal(s3.status, 'BLOCKED');
  assert.equal(s3.stopReason, 'runTimeoutSeconds');
  assert.equal(s3.preflightDone, true);
  approve(inBaseline.handle, { activeSeconds: 100 });
  const after = fakeVerifier();
  const s4 = await runWorkflow(inBaseline.handle, { provider: fakeProvider(), verifier: after, clock: clock2.now, resume: true });
  assert.equal(s4.status, 'SUCCEEDED');
  assert.deepEqual(after.setupRuns, []);
  assert.deepEqual(after.baselineRuns, []);
  releaseRun(inBaseline.handle);
});

test('workflow engine: a run that failed for another reason does not continue even when more calls are recorded', async (t) => {
  const { ctx, run, handle } = setup(t, { policy: withLimits({ maxRepairAttempts: 0 }) });
  const first = await runWorkflow(handle, { provider: fakeProvider(), verifier: fakeVerifier({ unit: [{ exitCode: 1, failedTests: ['x'] }] }) });
  assert.equal(first.status, 'FAILED');
  assert.equal(first.stopReason, 'repair-limit');
  approve(handle, { agentCalls: 5 });
  const later = fakeProvider();
  const s2 = await runWorkflow(handle, { provider: later, verifier: fakeVerifier(), resume: true });
  assert.equal(s2.status, 'FAILED');
  assert.equal(s2.stopReason, 'repair-limit');
  assert.deepEqual(later.calls, []);
  assert.equal(readRun(ctx, run.runId).state.status, 'FAILED');
  releaseRun(handle);
});

test('workflow engine: a fix whose check failed before the limit continues with a new fix attempt after more calls are approved', async (t) => {
  const { ctx, run, handle } = setup(t, { policy: withLimits({ maxSteps: 2, maxAgentCalls: 5 }) });
  const finding = { code: 'bug', severity: 'high', path: 'src/a.js', evidence: 'e' };
  const provider = fakeProvider({ 'reviewer:review': [{ status: 'needs_changes', findings: [finding] }] });
  const first = await runWorkflow(handle, { provider, verifier: fakeVerifier({ unit: [{}, {}, {}, { exitCode: 1, failedTests: ['fix'] }] }) });
  assert.deepEqual(callKeys(provider), ['coder:impl:1', 'coder:tests:1', 'reviewer:review:1', 'coder:review-fix:1']);
  assert.equal(first.status, 'BLOCKED');
  assert.equal(first.stopReason, 'maxAgentCalls');
  assert.equal(first.steps.review.status, 'BLOCKED');
  assert.equal(first.reviewFix.stepId, 'review');
  assert.equal(first.reviewFix.attempt, null);
  assert.equal(stepChanges(run, 'review').at(-1), 'VERIFYING->BLOCKED');
  releaseRun(handle);

  const h2 = acquireRun(ctx, run.runId);
  approve(h2, { agentCalls: 3 });
  const later = fakeProvider();
  const s2 = await runWorkflow(h2, { provider: later, verifier: fakeVerifier(), resume: true });
  assert.equal(s2.status, 'SUCCEEDED');
  assert.deepEqual(callKeys(later), ['coder:review-fix:2', 'reviewer:review:2', 'auditor:audit:1']);
  assert.deepEqual(later.calls[0].feedback.findings, [finding]);
  assert.deepEqual(later.calls[0].feedback.failures.map((f) => [f.id, f.exitCode, f.failedTests]), [['unit', 1, ['fix']]]);
  assert.equal(s2.budget.repairAttempts['review-fix'], 2);
  assert.equal(events(run).filter((e) => e.type === 'review-fix.check-failed').length, 1);
  assert.deepEqual(readRun(ctx, run.runId).issues, []);
  releaseRun(h2);
});
