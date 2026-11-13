import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../src/formats/jsonc.js';
import { normalizePolicy, validatePlan, hashJson } from '../src/workflow/schema.js';
import { assignedAgent, parsePolicyText, fieldValue, fingerprintArtifacts } from '../src/workflow/assignment.js';
import { createProvider, readResultJson } from '../src/workflow/provider.js';
import { createRun, readRun, policySecretIssues } from '../src/workflow/store.js';
import { cmdPlan, cmdRun } from '../src/workflow/run.js';
import { reportView } from '../src/workflow/report.js';

const FAKE = fileURLToPath(new URL('./fixtures/workflow/assigned-ai.mjs', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/agent-layers.js', import.meta.url));
const REQUEST = { role: 'coder', stepId: 'one', attempt: 1, goal: 'Preserve the public contract' };
const YES = { confirm: async () => true, retryDelayMs: 0 };
const step = (id, agent, deps = []) => ({ id, role: 'coder', ...(agent ? { agent } : {}), dependsOn: deps, instruction: `Implement ${id}`, writePaths: ['src'], checkIds: ['unit'], acceptance: ['Preserve the original contract'] });

function setup(t, scenario = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-assignment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scenarioFile = path.join(root, 'scenario.json');
  const plan = { schemaVersion: 2, goal: 'Implement the feature', steps: [step('one', 'codex'), step('two', 'gemini', ['one']), step('three', 'kimi', ['two'])] };
  fs.writeFileSync(scenarioFile, JSON.stringify({ plan, ...scenario }));
  const agents = Object.fromEntries(['claude', 'codex', 'gemini', 'kimi'].map((id) => [id, {
    description: `${id} fixture`, allowedRoles: id === 'claude' ? ['planner', 'reviewer', 'auditor'] : ['coder'], command: process.execPath,
    args: [FAKE, '--fixture', scenarioFile, '--actor', id, '--model', '{{model}}', ...(id === 'kimi' ? ['--prompt', '{{prompt}}', '--transcript'] : [])],
    model: `${id}-fixture-model`, env: [], input: id === 'kimi' ? 'argument' : 'stdin', output: 'text',
  }]));
  const raw = {
    schemaVersion: 2, agents, roleAgents: { planner: 'claude', coder: 'codex', reviewer: 'claude', auditor: 'claude' }, repairAgent: 'codex',
    contextLimits: { maxPromptBytes: 200000, maxDependencyBytes: 100000 }, limits: { maxSteps: 3, maxAgentCalls: 10, maxTransportRetries: 0 }, allowedWritePaths: ['src'],
    checks: [{ id: 'unit', command: process.execPath, args: ['-e', 'process.exit(0)'], timeout: 30 }], requiredChecks: ['unit'],
  };
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'existing'), 'preserve\n');
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
  const ctx = { paths: { stateDir: path.join(root, '.agent-layers') } };
  const policyFile = path.join(root, 'policy.jsonc');
  const goalFile = path.join(root, 'goal.md');
  fs.writeFileSync(goalFile, 'Keep all original restrictions.\n');
  const save = () => fs.writeFileSync(policyFile, JSON.stringify(raw));
  save();
  const flags = { path: repo, config: policyFile, 'goal-file': goalFile, quiet: true };
  return {
    root, repo, raw, plan, ctx, flags, save, git, goalFile, policyFile,
    policy: () => { const r = normalizePolicy(raw); assert.deepEqual(r.issues, []); return r.policy; },
    calls: () => fs.existsSync(`${scenarioFile}.calls`) ? fs.readFileSync(`${scenarioFile}.calls`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [],
    runId: () => fs.readdirSync(path.join(ctx.paths.stateDir, 'workflows')).find((name) => /^[0-9a-f-]{36}$/.test(name)),
    create: () => createRun(ctx, { plan, policy: raw, usedAgentCalls: 0, planRepairs: 0, baseCommit: git('rev-parse', 'HEAD'), providerFingerprint: {}, workspaceKey: path.join(repo, '.git'), goalContext: 'Keep all original restrictions.' }),
  };
}

test('v2: four agents execute fixed tasks and receive original goal and transitive evidence', async (t) => {
  const s = setup(t, { 'coder:one': { write: { 'src/first': 'first\n' }, result: { artifacts: [{ path: 'src/first', purpose: 'contract' }] } } });
  assert.equal(await cmdPlan(s.ctx, s.flags, YES), 0);
  const id = s.runId();
  assert.equal(await cmdRun(s.ctx, s.flags, id, YES), 0);
  assert.deepEqual(s.calls().map((c) => c.actor), ['claude', 'codex', 'gemini', 'kimi', 'claude', 'claude']);
  const third = s.calls()[3];
  assert.equal(third.model, 'kimi-fixture-model');
  assert.match(third.request.originalGoal, /original restrictions/);
  assert.equal(third.request.originalGoal, fs.readFileSync(s.goalFile, 'utf8'));
  assert.deepEqual(third.request.dependencies.map((d) => d.stepId).sort(), ['one', 'two']);
  assert.equal(third.request.dependencies.find((d) => d.stepId === 'one').artifacts[0].sha256.length, 64);
  const run = readRun(s.ctx, id);
  assert.deepEqual(run.issues, []);
  assert.equal(run.state.budget.agentCalls, 6);
  assert.equal(run.plan.schemaVersion, 2);
  assert.equal(run.state.schemaVersion, 2);
  assert.equal(run.plan.providerFingerprint, undefined);
  assert.equal(run.assignments.steps.three.agentId, 'kimi');
  const report = reportView(run);
  assert.equal(report.agentCalls.length, 6);
  assert.equal(report.agentCalls[0].reportedModel, null);
  assert.equal(s.git('status', '--porcelain'), '');
});

test('v2: missing worker agent uses the role default and an explicit invalid agent never falls back', (t) => {
  const s = setup(t); const p = s.policy();
  delete s.plan.steps[0].agent;
  assert.deepEqual(validatePlan(s.plan, p, { usedAgentCalls: 1 }), []);
  const created = s.create(); const run = readRun(s.ctx, created.runId);
  assert.equal(run.plan.steps[0].agent, 'codex');
  assert.equal(run.assignments.steps.one.selectionSource, 'role-default');
  s.plan.steps[0].agent = 'typo';
  assert.ok(validatePlan(s.plan, p, { usedAgentCalls: 1 }).some((e) => e.where === 'steps[0].agent'));
  s.plan.steps[0].agent = 'claude';
  assert.ok(validatePlan(s.plan, p, { usedAgentCalls: 1 }).length);
});

test('v2: invalid profiles and policy combinations are rejected without a process', (t) => {
  const s = setup(t);
  for (const change of [
    (p) => { p.provider = { command: 'unused', args: [] }; },
    (p) => { p.agents.codex.args.push('--model={{model}}'); },
    (p) => { p.agents.kimi.args = p.agents.kimi.args.filter((v) => v !== '{{prompt}}'); },
    (p) => { p.agents.codex.env = ['invalid-name']; },
    (p) => { p.roleAgents.reviewer = 'codex'; },
    (p) => { p.contextLimits.maxPromptBytes = 0; },
    (p) => { p.agents.codex.resultPath = ['response']; },
    (p) => { p.repairAgent = 'absent'; },
    (p) => { p.agents.codex.allowedRoles = {}; },
  ]) {
    const raw = structuredClone(s.raw); change(raw);
    assert.ok(normalizePolicy(raw).issues.length);
  }
  assert.deepEqual(s.calls(), []);
});

test('v2: duplicate escaped JSONC keys are rejected while v1 parsing is preserved', () => {
  assert.throws(() => parsePolicyText('{"schemaVersion":2,"agents":{"a":{},"\\u0061":{}}}', parseJsonc), /duplicate/);
  assert.equal(parsePolicyText('{"schemaVersion":1,"x":1,"x":2}', parseJsonc).x, 2);
});

test('v2: argument input preserves shell characters and only the selected environment', async (t) => {
  const s = setup(t); s.raw.agents.kimi.env = ['AL_ASSIGN_SHOWN'];
  process.env.AL_ASSIGN_SHOWN = 'fixture'; process.env.AL_ASSIGN_HIDDEN = 'hidden';
  t.after(() => { delete process.env.AL_ASSIGN_SHOWN; delete process.env.AL_ASSIGN_HIDDEN; });
  const p = s.policy();
  const provider = createProvider({ policy: p, cwd: s.repo });
  const result = await provider.call({ ...REQUEST, agent: 'kimi', goal: '한글 $(touch unexpected) `echo no`' });
  assert.equal(result.status, 'completed');
  assert.ok(s.calls()[0].env.includes('AL_ASSIGN_SHOWN'));
  assert.ok(!s.calls()[0].env.includes('AL_ASSIGN_HIDDEN'));
  assert.match(s.calls()[0].request.goal, /\$\(touch/);
  assert.ok(!fs.existsSync(path.join(s.repo, 'unexpected')));
});

test('v2: JSON envelope metadata is evidence, not a copy of the requested model', async (t) => {
  const s = setup(t); const a = s.raw.agents.codex;
  a.args.push('--envelope'); a.output = 'json-field'; a.resultPath = ['response']; a.errorPath = ['error'];
  a.metadataPaths = { reportedModel: ['meta', 'model'], inputTokens: ['meta', 'tokens'], cost: ['meta', 'cost'] };
  const outputs = [];
  const provider = createProvider({ policy: s.policy(), cwd: s.repo, onResult: (data) => outputs.push(data) });
  assert.equal((await provider.call(REQUEST)).status, 'completed');
  assert.equal(outputs[0].reportedModel, 'reported-fixture-model');
  assert.equal(outputs[0].requestedModel, 'codex-fixture-model');
  assert.equal(outputs[0].inputTokens, 7);
  assert.equal(outputs[0].usageScope, 'unknown');
  assert.equal(fieldValue({ x: [] }, ['x', '0']), undefined);
});

test('v2: an error envelope cannot masquerade as a successful role result', async (t) => {
  const s = setup(t, { coder: { error: { message: 'quota' } } });
  const a = s.raw.agents.codex; a.args.push('--envelope'); a.output = 'json-field'; a.resultPath = ['response']; a.errorPath = ['error'];
  await assert.rejects(createProvider({ policy: s.policy(), cwd: s.repo }).call(REQUEST), (e) => e.transport && e.code === 'error-envelope');
});

test('v2: prompt size and secret checks prevent any CLI process', async (t) => {
  const s = setup(t); const p = s.policy(); p.contextLimits.maxPromptBytes = 10;
  await assert.rejects(createProvider({ policy: p, cwd: s.repo }).call(REQUEST), /maxPromptBytes/);
  p.contextLimits.maxPromptBytes = 200000;
  await assert.rejects(createProvider({ policy: p, cwd: s.repo }).call({ ...REQUEST, goal: 'password=fixture-secret-value' }), /secret-looking/);
  s.raw.agents.codex.args.push('--api-key=fixture-secret-value');
  assert.ok(policySecretIssues(s.policy()).length);
  assert.deepEqual(s.calls(), []);
});

test('v2: original goal and fixed assignments cannot be tampered with and then executed', async (t) => {
  const s = setup(t); const { runId } = s.create(); const run = readRun(s.ctx, runId);
  fs.writeFileSync(path.join(run.dir, 'context.json'), JSON.stringify({ goal: 'changed' }));
  assert.ok(readRun(s.ctx, runId).issues.some((e) => /hash changed/.test(e)));
  const before = fs.readFileSync(path.join(run.dir, 'events.jsonl'));
  await assert.rejects(cmdRun(s.ctx, s.flags, runId, YES), /damaged records/);
  assert.deepEqual(fs.readFileSync(path.join(run.dir, 'events.jsonl')), before);
  assert.deepEqual(s.calls(), []);
});

test('v2: transport resume preserves the same agent and total budget', async (t) => {
  const s = setup(t, { 'coder:two': [{ exit: 73 }, {}] });
  await cmdPlan(s.ctx, s.flags, YES); const id = s.runId();
  assert.equal(await cmdRun(s.ctx, s.flags, id, YES), 3);
  assert.equal(readRun(s.ctx, id).state.stopReason, 'transport');
  assert.equal(await cmdRun(s.ctx, s.flags, id, { ...YES, resume: true }), 0);
  assert.deepEqual(s.calls().filter((c) => c.request.stepId === 'two').map((c) => c.actor), ['gemini', 'gemini']);
  assert.equal(readRun(s.ctx, id).state.budget.agentCalls, 7);
});

test('v2: final review findings use the configured integration repair agent', async (t) => {
  const s = setup(t, { reviewer: [
    { result: { status: 'needs_changes', findings: [{ code: 'ADJUST', severity: 'low', path: 'src/existing', evidence: 'adjust fixture' }] } },
    {},
  ] });
  s.raw.repairAgent = 'kimi'; s.save();
  await cmdPlan(s.ctx, s.flags, YES); const id = s.runId();
  assert.equal(await cmdRun(s.ctx, s.flags, id, YES), 0);
  assert.equal(s.calls().find((c) => c.request.stepId === 'review-fix').actor, 'kimi');
});

test('v2: a ruling on a blocked coder runs on the planner agent, also for a review-fix', async (t) => {
  const s = setup(t, { 'coder:two': { result: { status: 'blocked', needsInput: ['May I change a file of step three?'] } }, 'arbiter:two': { result: { status: 'completed' } } });
  s.raw.limits.maxBlockedRulings = 1; s.raw.repairAgent = 'kimi'; s.save();
  await cmdPlan(s.ctx, s.flags, YES); const id = s.runId();
  assert.equal(await cmdRun(s.ctx, s.flags, id, YES), 0);
  assert.deepEqual(s.calls().map((c) => `${c.actor}:${c.request.role}:${c.request.stepId}`), ['claude:planner:plan', 'codex:coder:one', 'gemini:coder:two', 'claude:arbiter:two', 'kimi:coder:three', 'claude:reviewer:review', 'claude:auditor:audit']);
  const ruling = s.calls()[3];
  assert.equal(ruling.model, 'claude-fixture-model');
  assert.match(ruling.prompt, /^Keep the role result body at schemaVersion 1\..*\n\n# Arbiter\n/);
  assert.equal(ruling.request.originalGoal, fs.readFileSync(s.goalFile, 'utf8'));
  assert.deepEqual(ruling.request.blocked.needsInput, ['May I change a file of step three?']);
  assert.deepEqual(ruling.request.laterSteps.map((l) => l.id), ['three']);
  const run = readRun(s.ctx, id);
  assert.deepEqual(run.issues, []);
  assert.equal(run.state.budget.agentCalls, 7);
  assert.equal(run.events.find((e) => e.type === 'call.started' && e.data.role === 'arbiter').data.agentId, 'claude');
  assert.equal(assignedAgent(s.policy(), { role: 'arbiter', stepId: 'review-fix', attempt: 1 }).agentId, 'claude');
  assert.equal(assignedAgent(s.policy(), { role: 'coder', stepId: 'review-fix', attempt: 1 }).agentId, 'kimi');
});

test('v2: dependency context limit stops downstream calls without truncating the goal', async (t) => {
  const s = setup(t); s.raw.contextLimits.maxDependencyBytes = 1; s.save();
  await cmdPlan(s.ctx, s.flags, YES); const id = s.runId();
  assert.equal(await cmdRun(s.ctx, s.flags, id, YES), 3);
  assert.equal(s.calls().length, 1);
});

test('v2: a transcript keeps JSON indentation but never repairs a broken body', () => {
  assert.deepEqual(readResultJson({ tail: '• Done\n  ```json\n  {"ok":true}\n  ```\n' }), { ok: true });
  assert.equal(readResultJson({ tail: '• Done\n  ```json\n  {"ok":}\n  ```\n' }), undefined);
});

test('v2: unknown record versions are rejected before any write', (t) => {
  const s = setup(t); const { runId } = s.create(); const run = readRun(s.ctx, runId);
  const policyFile = path.join(run.dir, 'policy.json');
  const policy = JSON.parse(fs.readFileSync(policyFile)); policy.schemaVersion = 9;
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  assert.throws(() => readRun(s.ctx, runId), /unsupported or mixed/);
});

test('v2: command-line validate, status and report are read-only', (t) => {
  const s = setup(t); const { runId } = s.create(); const run = readRun(s.ctx, runId);
  const hash = () => Object.fromEntries(['plan.json', 'policy.json', 'state.json', 'events.jsonl', 'context.json', 'assignments.json'].map((name) => [name, hashJson(fs.readFileSync(path.join(run.dir, name)).toString())]));
  const before = hash();
  for (const command of ['validate', 'status', 'report']) {
    const r = spawnSync(process.execPath, [BIN, 'workflow', command, runId, '--home', s.root, '--json'], { cwd: s.repo, env: { ...process.env, AGENT_LAYERS_HOME: s.ctx.paths.stateDir }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    JSON.parse(r.stdout);
  }
  assert.deepEqual(hash(), before);
});

test('v2: an ordinary failed check retries the original task agent', async (t) => {
  const s = setup(t, { 'coder:one': [{ write: { 'src/retry': 'wrong' } }, { write: { 'src/retry': 'ready' } }] });
  s.raw.checks[0].baseline = 'fail';
  s.raw.checks[0].args = ['-e', "const fs=require('node:fs');process.exit(fs.existsSync('src/retry')&&fs.readFileSync('src/retry','utf8')==='ready'?0:1)"];
  s.save(); await cmdPlan(s.ctx, s.flags, YES); const id = s.runId();
  assert.equal(await cmdRun(s.ctx, s.flags, id, YES), 0);
  assert.deepEqual(s.calls().filter((c) => c.request.stepId === 'one').map((c) => c.actor), ['codex', 'codex']);
  assert.equal(readRun(s.ctx, id).state.budget.agentCalls, 7);
});

test('v2: the shared call limit is not multiplied by agent count', async (t) => {
  const s = setup(t, { reviewer: { result: { status: 'needs_changes', findings: [{ code: 'FIX', severity: 'low', path: 'src/existing', evidence: 'fixture' }] } } });
  s.raw.limits.maxAgentCalls = 6; s.save();
  await cmdPlan(s.ctx, s.flags, YES); const id = s.runId();
  assert.equal(await cmdRun(s.ctx, s.flags, id, YES), 3);
  assert.equal(readRun(s.ctx, id).state.status, 'BLOCKED');
  assert.equal(readRun(s.ctx, id).state.stopReason, 'maxAgentCalls');
  assert.equal(readRun(s.ctx, id).state.budget.agentCalls, 6);
  assert.equal(s.calls().length, 6);
});

test('v2: changed dependency files stop resume before a downstream process', async (t) => {
  const s = setup(t, {
    'coder:one': { write: { 'src/result': 'original' }, result: { artifacts: [{ path: 'src/result', purpose: 'contract' }] } },
    'coder:two': [{ exit: 73 }, {}],
  });
  await cmdPlan(s.ctx, s.flags, YES); const id = s.runId();
  assert.equal(await cmdRun(s.ctx, s.flags, id, YES), 3);
  const run = readRun(s.ctx, id);
  const worktree = run.events.find((e) => e.type === 'workspace.created').data.path;
  fs.writeFileSync(path.join(worktree, 'src/result'), 'tampered');
  assert.equal(await cmdRun(s.ctx, s.flags, id, { ...YES, resume: true }), 3);
  assert.equal(readRun(s.ctx, id).state.stopReason, 'input-invalid');
  assert.equal(s.calls().length, 3);
});

test('v2: artifacts cannot escape through parent paths or symbolic links', (t) => {
  const s = setup(t);
  assert.throws(() => fingerprintArtifacts([{ path: '../outside', purpose: 'invalid' }], s.repo), /inside the worktree/);
  const target = path.join(s.root, 'outside'); fs.writeFileSync(target, 'outside');
  if (process.platform !== 'win32') {
    fs.symlinkSync(target, path.join(s.repo, 'src', 'escape'));
    assert.throws(() => fingerprintArtifacts([{ path: 'src/escape', purpose: 'invalid' }], s.repo), /inside the worktree/);
  }
});

test('v2: plan failures preserve preparation evidence without creating a run', async (t) => {
  const s = setup(t, { planner: { plan: { schemaVersion: 2, goal: 'bad plan', steps: [] } } });
  s.raw.limits.maxPlanRepairs = 0; s.save();
  await assert.rejects(cmdPlan(s.ctx, s.flags, YES), /did not return a valid plan/);
  const files = fs.readdirSync(path.join(s.ctx.paths.stateDir, 'workflow-preparation'));
  const trace = JSON.parse(fs.readFileSync(path.join(s.ctx.paths.stateDir, 'workflow-preparation', files[0])));
  assert.equal(trace.planningTrace.filter((e) => e.type === 'call.started').length, 1);
  assert.equal(trace.planningTrace.filter((e) => e.type === 'planner.answer').length, 1);
  assert.equal(s.calls().length, 1);
});

test('v2: policy exceptions survive storage normalization without applying checks twice', (t) => {
  const s = setup(t);
  s.raw.exceptions = [{ id: 'extra', kind: 'add-check', check: { id: 'extra-check', command: process.execPath, args: ['-e', 'process.exit(0)'], timeout: 30 } }];
  const { runId } = s.create(); const run = readRun(s.ctx, runId);
  assert.deepEqual(run.issues, []);
  assert.equal(run.policy.checks.length, 2);
});

test('v2: forged assignment ids and altered preparation evidence are rejected', (t) => {
  const s = setup(t); const { runId } = s.create(); const run = readRun(s.ctx, runId);
  const records = { ...run.assignments, repair: { agentId: 'kimi', selectionSource: 'repair-default' } };
  fs.writeFileSync(path.join(run.dir, 'assignments.json'), JSON.stringify(records));
  const stored = JSON.parse(fs.readFileSync(path.join(run.dir, 'plan.json')));
  stored.assignmentHash = hashJson(records);
  fs.writeFileSync(path.join(run.dir, 'plan.json'), JSON.stringify(stored));
  fs.writeFileSync(path.join(run.dir, 'artifacts/planning.json'), '[{}]');
  const issues = readRun(s.ctx, runId).issues;
  assert.ok(issues.some((i) => /repair assignment changed/.test(i)));
  assert.ok(issues.some((i) => /planning evidence hash changed/.test(i)));
});

test('v2: same CLI can select different models without changing role semantics', async (t) => {
  const s = setup(t); s.raw.agents.other = { ...s.raw.agents.codex, model: 'another-model' };
  await createProvider({ policy: s.policy(), cwd: s.repo }).call({ ...REQUEST, agent: 'other' });
  assert.equal(s.calls()[0].model, 'another-model');
  assert.equal(s.calls()[0].request.role, 'coder');
  assert.throws(() => assignedAgent(s.policy(), { ...REQUEST, agent: 'kimi' }, s.plan), /fixed assignment/);
});

test('v2: input-invalid is not resumed into another model', async (t) => {
  const s = setup(t); s.raw.contextLimits.maxDependencyBytes = 1; s.save();
  await cmdPlan(s.ctx, s.flags, YES); const id = s.runId();
  assert.equal(await cmdRun(s.ctx, s.flags, id, YES), 3);
  assert.equal(readRun(s.ctx, id).state.stopReason, 'input-invalid');
  assert.equal(await cmdRun(s.ctx, s.flags, id, { ...YES, resume: true }), 3);
  assert.equal(s.calls().length, 1);
});

test('v2: large prompt arguments report E2BIG without retry or truncation', { skip: process.platform !== 'linux' }, async (t) => {
  const s = setup(t); s.raw.contextLimits.maxPromptBytes = 500000;
  await assert.rejects(createProvider({ policy: s.policy(), cwd: s.repo }).call({ ...REQUEST, agent: 'kimi', goal: 'x'.repeat(200000) }), /E2BIG/);
  assert.equal(s.calls().length, 0);
});

test('v2: cancellation and timeout terminate the assigned CLI process', async (t) => {
  const s = setup(t, { coder: { sleep: 10000 } });
  const abort = new AbortController();
  const promise = createProvider({ policy: s.policy(), cwd: s.repo, signal: abort.signal }).call(REQUEST);
  while (s.calls().length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  abort.abort();
  await assert.rejects(promise, (e) => e.cancelRequested);
  const p = s.policy(); p.limits.stepTimeoutSeconds = 1;
  await assert.rejects(createProvider({ policy: p, cwd: s.repo }).call(REQUEST), (e) => e.timeout);
  if (process.platform === 'linux') {
    for (const call of s.calls()) {
      assert.throws(() => process.kill(call.pid, 0), (e) => e.code === 'ESRCH');
    }
  }
});

test('v2: mandatory final check failures use repairAgent before review', async (t) => {
  const s = setup(t, { 'coder:review-fix': { write: { 'src/integration': 'ready' } } });
  s.raw.repairAgent = 'kimi';
  s.raw.checks.push({ id: 'gate', command: process.execPath, args: ['-e', "process.exit(require('node:fs').existsSync('src/integration')?0:1)"], timeout: 30, baseline: 'fail' });
  s.raw.requiredChecks.push('gate'); s.save();
  await cmdPlan(s.ctx, s.flags, YES); const id = s.runId();
  assert.equal(await cmdRun(s.ctx, s.flags, id, YES), 0);
  assert.equal(s.calls().find((c) => c.request.stepId === 'review-fix').actor, 'kimi');
  assert.equal(readRun(s.ctx, id).state.budget.agentCalls, 7);
});

test('v2: a torn final event is recovered without changing immutable inputs', async (t) => {
  const s = setup(t); const { runId } = s.create(); const before = readRun(s.ctx, runId);
  fs.appendFileSync(path.join(before.dir, 'events.jsonl'), '{unfinished');
  assert.equal(await cmdRun(s.ctx, s.flags, runId, YES), 0);
  const after = readRun(s.ctx, runId);
  assert.deepEqual(after.issues, []);
  assert.equal(after.plan.assignmentHash, before.plan.assignmentHash);
  assert.equal(after.plan.contextHash, before.plan.contextHash);
  assert.ok(after.events.some((e) => e.type === 'run.recovered'));
});

test('v2: planner and reviewer edits are rejected rather than accepted as read-only work', async (t) => {
  const s = setup(t, { planner: { write: { 'src/unexpected': 'bad' } } });
  await assert.rejects(cmdPlan(s.ctx, s.flags, YES), /planner changed files/);
  assert.equal(s.git('status', '--porcelain'), '');
  const r = setup(t, { reviewer: { write: { 'src/unexpected': 'bad' } } });
  await cmdPlan(r.ctx, r.flags, YES); const id = r.runId();
  assert.equal(await cmdRun(r.ctx, r.flags, id, YES), 1);
  assert.equal(readRun(r.ctx, id).state.stopReason, 'policy-violation');
  assert.equal(r.calls().some((c) => c.request.role === 'auditor'), false);
});

test('v2: the four-CLI example validates without invoking a real CLI', () => {
  const file = fileURLToPath(new URL('../templates/workflow/policy.multi-agent.example.jsonc', import.meta.url));
  const { policy, issues } = normalizePolicy(parsePolicyText(fs.readFileSync(file, 'utf8'), parseJsonc));
  assert.deepEqual(issues, []);
  assert.deepEqual(policySecretIssues(policy), []);
  assert.equal(Object.keys(policy.agents).length, 4);
});
