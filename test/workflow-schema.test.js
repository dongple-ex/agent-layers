import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonc } from '../src/formats/jsonc.js';
import { normalizePolicy, validatePlan, validateRoleResult, relativePathIssue, pathCovers, hashJson, DEFAULT_LIMITS } from '../src/workflow/schema.js';

function rawPolicy(extra = {}) {
  return {
    schemaVersion: 1,
    provider: { command: 'fake-ai', args: [] },
    allowedWritePaths: ['src', 'test/'],
    protectedPaths: ['test/fixtures'],
    checks: [{ id: 'unit', command: 'npm', args: ['test'], timeout: 600 }],
    requiredChecks: ['unit'],
    ...extra,
  };
}

function policyOf(extra) {
  const { policy, issues } = normalizePolicy(rawPolicy(extra));
  assert.deepEqual(issues, []);
  return policy;
}

function workStep(id, extra = {}) {
  return {
    id,
    role: 'coder',
    dependsOn: [],
    instruction: 'Implement the change',
    writePaths: ['src/a.js'],
    checkIds: ['unit'],
    acceptance: ['Invalid input is rejected'],
    ...extra,
  };
}

function plan(steps, extra = {}) {
  return { schemaVersion: 1, goal: 'Add input validation', steps, ...extra };
}

function wheres(issues) {
  return issues.map((i) => i.where);
}

test('workflow policy: defaults are filled, paths normalized and runtime protected paths added', () => {
  const policy = policyOf({ allowedWritePaths: ['./src/', 'src', 'test//unit'] });
  assert.deepEqual(policy.limits, DEFAULT_LIMITS);
  assert.deepEqual(policy.allowedWritePaths, ['src', 'test/unit']);
  assert.deepEqual(policy.protectedPaths, ['test/fixtures', '.git', '.codex', '.agents']);
  assert.deepEqual(policy.requiredRoles, ['reviewer', 'auditor']);
  assert.deepEqual(policy.checks, [{ id: 'unit', command: 'npm', args: ['test'], cwd: '.', timeout: 600, inputs: [] }]);
});

test('workflow policy: maxSteps + 3 must not exceed maxAgentCalls', () => {
  assert.deepEqual(normalizePolicy(rawPolicy({ limits: { maxSteps: 9, maxAgentCalls: 12 } })).issues, []);
  const { policy, issues } = normalizePolicy(rawPolicy({ limits: { maxSteps: 9, maxAgentCalls: 11 } }));
  assert.equal(policy, null);
  assert.deepEqual(issues, [{ where: 'limits', msg: 'maxSteps + 3 must not exceed maxAgentCalls (9 + 3 > 11)' }]);
});

test('workflow policy: limit values, unknown fields and the provider are checked', () => {
  const { issues } = normalizePolicy(rawPolicy({
    extra: true,
    provider: { command: '', args: 'x', url: 'x' },
    limits: { maxConcurrent: 2, maxSteps: 0, maxRepairAttempts: -1, maxPlanRepairs: 0, stepTimeoutSeconds: 1.5, bogus: 1 },
  }));
  assert.deepEqual(wheres(issues), [
    'extra',
    'provider.url',
    'provider.command',
    'provider.args',
    'limits.maxConcurrent',
    'limits.maxSteps',
    'limits.maxRepairAttempts',
    'limits.stepTimeoutSeconds',
    'limits.bogus',
  ]);
});

test('workflow policy: the provider is a command with args, role args and environment variable names', () => {
  const provider = { command: 'ai', args: ['run'], roleArgs: { planner: ['plan'], reviewer: [] }, env: ['AI_HOME'] };
  const policy = policyOf({ provider });
  assert.deepEqual(policy.provider, provider);
  assert.deepEqual(policyOf({ provider: { command: 'ai', args: [] } }).provider, { command: 'ai', args: [], roleArgs: {}, env: [] });
  const again = normalizePolicy(policy);
  assert.deepEqual(again.issues, []);
  assert.equal(hashJson(again.policy), hashJson(policy));
});

test('workflow policy: old provider fields and malformed command, role args and env are refused', () => {
  for (const key of ['id', 'model', 'reasoningEffort', 'executable']) {
    assert.deepEqual(wheres(normalizePolicy(rawPolicy({ provider: { command: 'ai', args: [], [key]: 'x' } })).issues), [`provider.${key}`], key);
  }
  const cases = [
    [undefined, 'provider'],
    [{ args: [] }, 'provider.command'],
    [{ command: 'a\nb', args: [] }, 'provider.command'],
    [{ command: 'ai' }, 'provider.args'],
    [{ command: 'ai', args: [1] }, 'provider.args'],
    [{ command: 'ai', args: ['a\0b'] }, 'provider.args'],
    [{ command: 'ai', args: [], roleArgs: [] }, 'provider.roleArgs'],
    [{ command: 'ai', args: [], roleArgs: { tester: [] } }, 'provider.roleArgs.tester'],
    [{ command: 'ai', args: [], roleArgs: { coder: 'x' } }, 'provider.roleArgs.coder'],
    [{ command: 'ai', args: [], env: 'X' }, 'provider.env'],
    [{ command: 'ai', args: [], env: ['A=1'] }, 'provider.env'],
  ];
  for (const [provider, where] of cases) {
    const { policy, issues } = normalizePolicy(rawPolicy({ provider }));
    assert.equal(policy, null, where);
    assert.deepEqual(wheres(issues), [where], JSON.stringify(provider));
  }
});

test('workflow policy: __proto__ in JSONC is an unknown field and does not reach the limits', () => {
  const raw = parseJsonc(JSON.stringify(rawPolicy()).replace('"schemaVersion":1', '"schemaVersion":1,"limits":{"__proto__":{"maxSteps":99}}'));
  const { policy, issues } = normalizePolicy(raw);
  assert.equal(policy, null);
  assert.deepEqual(issues, [{ where: 'limits.__proto__', msg: 'unknown field' }]);
  assert.equal({}.maxSteps, undefined);
});

test('workflow policy: checks and required checks reject duplicates, unknown ids and shell strings', () => {
  const { issues } = normalizePolicy(rawPolicy({
    checks: [
      { id: 'unit', command: 'npm', args: ['test'], timeout: 600 },
      { id: 'unit', command: 'npm', args: ['run', 'lint'], timeout: 60 },
      { id: 'bad', command: 'npm', args: 'test && rm -rf .', timeout: 0, cwd: '../x' },
    ],
    requiredChecks: ['unit', 'unit', 'missing'],
  }));
  assert.deepEqual(wheres(issues), [
    'checks[1].id',
    'checks[2].args',
    'checks[2].timeout',
    'checks[2].cwd',
    'requiredChecks[1]',
    'requiredChecks[2]',
  ]);
  assert.deepEqual(wheres(normalizePolicy(rawPolicy({ requiredChecks: [] })).issues), ['requiredChecks']);
});

test('workflow policy: required roles must keep reviewer and auditor', () => {
  assert.deepEqual(wheres(normalizePolicy(rawPolicy({ requiredRoles: ['reviewer'] })).issues), ['requiredRoles']);
  assert.deepEqual(wheres(normalizePolicy(rawPolicy({ requiredRoles: ['reviewer', 'auditor', 'tester'] })).issues), ['requiredRoles']);
  assert.deepEqual(policyOf({ requiredRoles: ['auditor', 'reviewer'] }).requiredRoles, ['reviewer', 'auditor']);
});

test('workflow policy: only replace-limit and add-check exceptions are accepted and applied', () => {
  const policy = policyOf({
    exceptions: [
      { id: 'more-repairs', kind: 'replace-limit', limit: 'maxRepairAttempts', value: 3 },
      { id: 'lint', kind: 'add-check', check: { id: 'lint', command: 'npm', args: ['run', 'lint'], timeout: 60 } },
    ],
  });
  assert.equal(policy.limits.maxRepairAttempts, 3);
  assert.deepEqual(policy.requiredChecks, ['unit', 'lint']);
  assert.deepEqual(policy.exceptions.map((e) => e.id), ['more-repairs', 'lint']);

  const { issues } = normalizePolicy(rawPolicy({
    exceptions: [
      { id: 'skip', kind: 'skip-required-check', check: 'unit' },
      { id: 'steps', kind: 'replace-limit', limit: 'maxSteps', value: 30 },
      { id: 'dup', kind: 'add-check', check: { id: 'unit', command: 'npm', args: [], timeout: 1 } },
    ],
  }));
  assert.deepEqual(issues, [
    { where: 'exceptions[0].kind', msg: 'must be "replace-limit" or "add-check"' },
    { where: 'exceptions[2].check.id', msg: 'duplicate check id "unit"' },
    { where: 'limits', msg: 'maxSteps + 3 must not exceed maxAgentCalls (30 + 3 > 20)' },
  ]);
});

test('workflow paths: absolute, parent, Windows, NUL and glob forms are rejected before normalizing', () => {
  const cases = {
    '': 'path must be a non-empty string',
    '/etc/passwd': 'path must be relative to the repository',
    'C:/x': 'path must be relative to the repository',
    'src\\a.js': 'path must use "/" separators',
    'src/../x': 'path must not contain ".."',
    'a\0b': 'path must not contain NUL',
    'src/*.js': 'glob patterns are not supported',
  };
  for (const [p, msg] of Object.entries(cases)) {
    assert.equal(relativePathIssue(p), msg, p);
  }
  assert.equal(relativePathIssue('src/a.js'), null);
  assert.equal(pathCovers('src', 'src/a.js'), true);
  assert.equal(pathCovers('src', 'src'), true);
  assert.equal(pathCovers('src', 'src2/a.js'), false);
  assert.equal(pathCovers('.', 'anything'), true);
});

test('workflow plan: a valid plan has no issues', () => {
  const policy = policyOf();
  const p = plan([workStep('impl'), workStep('tests', { dependsOn: ['impl'], writePaths: ['test/unit.test.js'] })]);
  assert.deepEqual(validatePlan(p, policy, { usedAgentCalls: 1 }), []);
});

test('workflow plan: program-owned fields, reserved ids and unknown fields are rejected', () => {
  const policy = policyOf();
  const p = plan([workStep('review'), workStep('impl', { extra: 1, role: 'reviewer' })], { planHash: 'abc', runId: 'x', note: 'n' });
  assert.deepEqual(validatePlan(p, policy, { usedAgentCalls: 1 }), [
    { where: 'planHash', msg: 'is set by the program and must not come from the model' },
    { where: 'runId', msg: 'is set by the program and must not come from the model' },
    { where: 'note', msg: 'unknown field' },
    { where: 'steps[0].id', msg: '"review" is reserved for program steps' },
    { where: 'steps[1].extra', msg: 'unknown field' },
    { where: 'steps[1].role', msg: 'must be "coder" in this version' },
  ]);
});

test('workflow plan: write paths must stay inside allowed paths and outside protected paths', () => {
  const policy = policyOf();
  const issues = validatePlan(plan([workStep('impl', { writePaths: ['src/a.js', 'src2/b.js', 'test/fixtures/x.json', '.git/config', '../out'] })]), policy, { usedAgentCalls: 1 });
  assert.deepEqual(issues.map((i) => `${i.where}: ${i.msg}`), [
    'steps[0].writePaths[4]: path must not contain ".."',
    'steps[0].writePaths: "src2/b.js" is outside allowedWritePaths',
    'steps[0].writePaths: "test/fixtures/x.json" is inside protected path "test/fixtures"',
    'steps[0].writePaths: ".git/config" is outside allowedWritePaths',
    'steps[0].writePaths: ".git/config" is inside protected path ".git"',
  ]);
});

test('workflow plan: a write path that only contains a protected subpath is accepted; protected paths win at run time', () => {
  const policy = policyOf();
  assert.deepEqual(validatePlan(plan([workStep('impl', { writePaths: ['test'] })]), policy, { usedAgentCalls: 1 }), []);
});

test('workflow plan: completion fields and check ids must be usable', () => {
  const policy = policyOf();
  const issues = validatePlan(plan([workStep('impl', { instruction: '  ', acceptance: [], checkIds: ['unit', 'lint'], writePaths: [] })]), policy, { usedAgentCalls: 1 });
  assert.deepEqual(wheres(issues), ['steps[0].instruction', 'steps[0].writePaths', 'steps[0].checkIds[1]', 'steps[0].acceptance']);
});

test('workflow plan: graph errors are reported after field checks', () => {
  const policy = policyOf();
  const issues = validatePlan(plan([workStep('a', { dependsOn: ['b'] }), workStep('b', { dependsOn: ['a'] })]), policy, { usedAgentCalls: 1 });
  assert.deepEqual(issues, [{ where: 'steps', msg: 'dependency cycle; steps in or after the cycle: a, b' }]);
});

test('workflow plan: step count and remaining agent calls are checked at their exact limits', () => {
  const policy = policyOf({ limits: { maxSteps: 3, maxAgentCalls: 7 } });
  const steps = (n) => Array.from({ length: n }, (_, i) => workStep(`s${i}`));
  assert.deepEqual(validatePlan(plan(steps(3)), policy, { usedAgentCalls: 2 }), []);
  assert.deepEqual(validatePlan(plan(steps(4)), policy, { usedAgentCalls: 0 }), [
    { where: 'steps', msg: 'has 4 steps; maxSteps is 3' },
  ]);
  assert.deepEqual(validatePlan(plan(steps(3)), policy, { usedAgentCalls: 3 }), [
    { where: 'steps', msg: 'needs 5 more agent calls; 4 remain of maxAgentCalls 7' },
  ]);
  assert.throws(() => validatePlan(plan(steps(1)), policy, {}), /usedAgentCalls/);
});

test('workflow plan: malformed model output returns issues instead of throwing', () => {
  const policy = policyOf();
  for (const bad of [null, [], 'plan', 42]) {
    assert.deepEqual(validatePlan(bad, policy, { usedAgentCalls: 1 }), [{ where: 'plan', msg: 'must be an object' }]);
  }
  assert.deepEqual(wheres(validatePlan({ schemaVersion: 2, goal: '', steps: [] }, policy, { usedAgentCalls: 1 })), ['schemaVersion', 'goal', 'steps']);
  const issues = validatePlan(plan([null, 'x', workStep(7), workStep('a', { dependsOn: [1], writePaths: 'src', checkIds: 'unit' })]), policy, { usedAgentCalls: 1 });
  assert.deepEqual(wheres(issues), [
    'steps[0]',
    'steps[1]',
    'steps[2].id',
    'steps[3].dependsOn',
    'steps[3].writePaths',
    'steps[3].checkIds',
  ]);
});

test('workflow result: valid results pass and needs_changes findings must carry a path', () => {
  const ok = {
    schemaVersion: 1,
    stepId: 'impl',
    attempt: 1,
    status: 'completed',
    summary: 'Done',
    artifacts: [{ path: 'src/a.js', purpose: 'implementation' }],
    findings: [],
    needsInput: [],
  };
  assert.deepEqual(validateRoleResult(ok, { stepIds: ['impl'] }), []);
  assert.deepEqual(validateRoleResult({ ...ok, stepId: 'review-fix', attempt: 2 }, { stepIds: ['impl'] }), []);

  const review = {
    ...ok,
    stepId: 'review',
    status: 'needs_changes',
    artifacts: [],
    findings: [
      { code: 'R1', severity: 'high', path: 'src/a.js', evidence: 'Missing check' },
      { code: 'R2', severity: 'low', evidence: 'General remark' },
    ],
  };
  assert.deepEqual(validateRoleResult(review, { stepIds: ['impl'] }), [
    { where: 'findings[1].path', msg: 'is required when status is needs_changes' },
  ]);
  assert.deepEqual(validateRoleResult({ ...review, status: 'completed' }, { stepIds: ['impl'] }), []);
  assert.deepEqual(validateRoleResult({ ...review, findings: [] }, { stepIds: ['impl'] }), [
    { where: 'findings', msg: 'must not be empty when status is needs_changes' },
  ]);
});

test('workflow result: missing, unknown and invalid fields are reported', () => {
  const issues = validateRoleResult({ schemaVersion: 1, stepId: 'other', attempt: 0, status: 'done', summary: '', artifacts: [{ path: '/abs' }], findings: {}, cost: 1 }, { stepIds: ['impl'] });
  assert.deepEqual(wheres(issues), [
    'cost',
    'needsInput',
    'stepId',
    'attempt',
    'status',
    'summary',
    'artifacts[0].path',
    'artifacts[0].purpose',
    'findings',
  ]);
  assert.deepEqual(validateRoleResult(null, { stepIds: [] }), [{ where: 'result', msg: 'must be an object' }]);
});

test('workflow hash: key order does not change the hash and non-JSON values are refused', () => {
  const a = { b: 1, a: [{ y: 'x', x: null }] };
  const b = { a: [{ x: null, y: 'x' }], b: 1 };
  assert.equal(hashJson(a), hashJson(b));
  assert.match(hashJson(a), /^[0-9a-f]{64}$/);
  assert.notEqual(hashJson(a), hashJson({ ...a, b: 2 }));
  assert.throws(() => hashJson({ a: undefined }), /value\.a: undefined cannot be hashed/);
  assert.throws(() => hashJson({ a: Number.NaN }), /non-finite/);
});
