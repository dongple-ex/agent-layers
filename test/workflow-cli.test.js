import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRun, acquireRun, releaseRun } from '../src/workflow/store.js';
import { runWorkflow } from '../src/workflow/engine.js';
import { POLICY, PLAN, fakeProvider, fakeVerifier } from './fixtures/workflow/fakes.js';

const BIN = fileURLToPath(new URL('../bin/agent-layers.js', import.meta.url));

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-wf-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, ctx: { paths: { stateDir: path.join(home, '.agent-layers') } } };
}

function newRun(ctx) {
  return createRun(ctx, {
    plan: PLAN,
    policy: POLICY,
    usedAgentCalls: 1,
    planRepairs: 0,
    baseCommit: 'b'.repeat(40),
    providerFingerprint: 'fake 0.0.0',
    workspaceKey: `ws-${crypto.randomUUID()}`,
  });
}

function cli(home, ...args) {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.AGENT_LAYERS_HOME;
  delete env.AGENT_LAYERS_SOURCE;
  const r = spawnSync(process.execPath, [BIN, ...args, '--home', home], { encoding: 'utf8', env });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
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

test('workflow cli: status, report and validate read a stored run, print JSON only on stdout, and write nothing', (t) => {
  const { home, ctx } = tempHome(t);
  const run = newRun(ctx);
  const before = hashTree(home);
  const status = cli(home, 'workflow', 'status', run.runId, '--json');
  assert.equal(status.code, 0, status.stderr);
  const view = JSON.parse(status.stdout);
  assert.equal(view.runId, run.runId);
  assert.equal(view.status, 'PLANNED');
  assert.deepEqual(view.steps.map((s) => s.id), ['impl', 'tests', 'review', 'audit']);
  assert.deepEqual(view.budget.agentCalls, { used: 1, limit: 20, remaining: 19 });
  assert.equal(status.stderr, '');

  const report = cli(home, 'workflow', 'report', run.runId, '--json');
  assert.equal(report.code, 0, report.stderr);
  const rep = JSON.parse(report.stdout);
  assert.deepEqual(rep.checks.map((c) => [c.id, c.result, c.required]), [['unit', 'not-run', true], ['lint', 'not-run', false]]);
  assert.deepEqual(rep.remaining, ['impl', 'tests', 'review', 'audit']);

  const validate = cli(home, 'workflow', 'validate', run.runId, '--json');
  assert.equal(validate.code, 0, validate.stderr);
  assert.deepEqual(JSON.parse(validate.stdout), { runId: run.runId, valid: true, issues: [] });

  const text = cli(home, 'workflow', 'status', run.runId);
  assert.equal(text.code, 0);
  assert.match(text.stdout, new RegExp(`run ${run.runId}: PLANNED`));
  assert.match(text.stdout, /impl\s+PENDING/);
  assert.deepEqual(hashTree(home), before);
});

test('workflow cli: report shows finished checks and artifacts after a fake run', async (t) => {
  const { home, ctx } = tempHome(t);
  const run = newRun(ctx);
  const handle = acquireRun(ctx, run.runId);
  await runWorkflow(handle, { provider: fakeProvider(), verifier: fakeVerifier({ unit: [{ exitCode: 1, failedTests: ['x'] }] }) });
  releaseRun(handle);
  const report = cli(home, 'workflow', 'report', run.runId, '--json');
  assert.equal(report.code, 0, report.stderr);
  const rep = JSON.parse(report.stdout);
  assert.equal(rep.status, 'SUCCEEDED');
  assert.deepEqual(rep.checks.map((c) => [c.id, c.result]), [['unit', 'passed'], ['lint', 'not-run']]);
  assert.deepEqual(rep.artifacts.map((a) => a.path), ['artifacts/00-impl-1.json', 'artifacts/00-impl-2.json', 'artifacts/01-tests-1.json', 'artifacts/02-review-1.json', 'artifacts/03-audit-1.json']);
  assert.deepEqual(rep.remaining, []);
  const text = cli(home, 'workflow', 'report', run.runId);
  assert.match(text.stdout, /unit \(required\): passed/);
  assert.match(text.stdout, /remaining steps: none/);
});

test('workflow cli: exit codes follow the contract and diagnostics go to stderr', (t) => {
  const { home, ctx } = tempHome(t);
  const run = newRun(ctx);
  const cases = [
    [['workflow', 'status', 'not-a-uuid'], 2, /run id/i],
    [['workflow', 'status', crypto.randomUUID()], 2, /does not exist/],
    [['workflow', 'status'], 2, /usage: agent-layers workflow status <run-id>/],
    [['workflow', 'status', run.runId, 'extra'], 2, /usage/],
    [['workflow'], 2, /missing workflow command/],
    [['workflow', 'explode', run.runId], 2, /unknown workflow command "explode"/],
    ...['plan', 'run', 'resume', 'cancel'].map((sub) => [['workflow', sub, run.runId], 2, new RegExp(`workflow ${sub} is not available yet`)]),
  ];
  for (const [args, code, pattern] of cases) {
    const r = cli(home, ...args);
    assert.equal(r.code, code, args.join(' '));
    assert.match(r.stderr, pattern, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }

  fs.writeFileSync(path.join(run.dir, 'state.json'), '{ broken');
  const broken = cli(home, 'workflow', 'report', run.runId, '--json');
  assert.equal(broken.code, 3);
  assert.match(broken.stderr, /state\.json is not valid JSON/);
  assert.equal(broken.stdout, '');
});

test('workflow cli: validate reports a tampered policy with exit code 2', (t) => {
  const { home, ctx } = tempHome(t);
  const run = newRun(ctx);
  const file = path.join(run.dir, 'policy.json');
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  policy.requiredChecks = [];
  fs.writeFileSync(file, JSON.stringify(policy));
  const r = cli(home, 'workflow', 'validate', run.runId, '--json');
  assert.equal(r.code, 2);
  const view = JSON.parse(r.stdout);
  assert.equal(view.valid, false);
  assert.ok(view.issues.some((i) => /policy/.test(i)), view.issues.join('\n'));
});

test('workflow cli: help lists the workflow commands and existing commands keep their exit codes', (t) => {
  const { home } = tempHome(t);
  const help = cli(home, 'help');
  assert.equal(help.code, 0);
  assert.match(help.stdout, /workflow status <run-id> \[--json\]/);
  assert.match(help.stdout, /plan, run, resume and cancel are not available yet/);
  const unknown = cli(home, 'no-such-command');
  assert.equal(unknown.code, 2);
});
