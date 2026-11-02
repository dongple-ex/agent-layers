import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setQuiet } from '../src/util/log.js';
import { findLeftovers, TREE_KILL_SUPPORTED } from '../src/workflow/process.js';
import { formatReport, reportView } from '../src/workflow/report.js';
import { cmdCancel, cmdPlan, cmdRun } from '../src/workflow/run.js';
import { hashJson } from '../src/workflow/schema.js';
import { acquireRun, commitRun, readRun, releaseRun, requestCancel } from '../src/workflow/store.js';

const CANCEL_STATUS = TREE_KILL_SUPPORTED ? 'CANCELLED' : 'INTERRUPTED';
const CANCEL_EXIT = TREE_KILL_SUPPORTED ? 130 : 3;
const CLEAN = () => ({ confirmed: true, leftovers: [] });
const BIN = fileURLToPath(new URL('../bin/agent-layers.js', import.meta.url));
const FAKE_AI = fileURLToPath(new URL('./fixtures/workflow/fake-ai.mjs', import.meta.url));
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-run-config-'));
process.env.GIT_CONFIG_GLOBAL = path.join(CONFIG_DIR, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync.native(os.tmpdir());
after(() => fs.rmSync(CONFIG_DIR, { recursive: true, force: true }));
setQuiet(true);

const CHECK_SCRIPT = 'if (require("fs").existsSync("src/broken")) { console.error("check found src/broken"); process.exit(1); } console.log("all good");';
const STEP = { id: 'impl', role: 'coder', dependsOn: [], instruction: 'Add the file', writePaths: ['src'], checkIds: ['unit'], acceptance: ['The file exists'] };
const PLAN = { schemaVersion: 1, goal: 'Add a file', steps: [STEP] };
const TWO_STEPS = { ...PLAN, steps: [STEP, { ...STEP, id: 'tests', dependsOn: ['impl'], writePaths: ['test'] }] };
const CONFIRM = async () => true;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function newRepo(base, name) {
  const repo = path.join(base, name);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'generated/\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  return fs.realpathSync.native(repo);
}

function setup(t, scenario = {}, { plan = PLAN, policy = {}, provider = (fakeArgs) => ({ args: fakeArgs }) } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-run-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const scenarioFile = path.join(base, 'scenario.json');
  const write = (value) => fs.writeFileSync(scenarioFile, JSON.stringify({ plan, ...value }));
  write(typeof scenario === 'function' ? {} : scenario);
  const policyFile = path.join(base, 'policy.jsonc');
  const fakeArgs = [FAKE_AI, '--scenario', scenarioFile];
  fs.writeFileSync(policyFile, JSON.stringify({
    schemaVersion: 1,
    provider: { command: process.execPath, ...provider(fakeArgs) },
    allowedWritePaths: ['src', 'test'],
    protectedPaths: ['src/protected'],
    checks: [{ id: 'unit', command: process.execPath, args: ['-e', CHECK_SCRIPT], timeout: 60 }],
    requiredChecks: ['unit'],
    ...policy,
  }));
  const goalFile = path.join(base, 'goal.md');
  fs.writeFileSync(goalFile, 'Add a file.\n');
  const home = path.join(base, 'home');
  const repo = newRepo(base, 'repo');
  if (typeof scenario === 'function') {
    write(scenario(repo));
  }
  return {
    base,
    repo,
    home,
    goalFile,
    policyFile,
    ctx: { paths: { stateDir: path.join(home, '.agent-layers') } },
    calls: () => {
      const file = `${scenarioFile}.calls.jsonl`;
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    keys() {
      return this.calls().map((c) => `${c.request.role}:${c.request.stepId}:${c.request.attempt}`);
    },
    flags: { path: repo, yes: true, json: true, quiet: true, 'goal-file': goalFile, config: policyFile },
  };
}

function cli(s, args, env = {}) {
  const childEnv = { ...process.env, NO_COLOR: '1', ...env };
  delete childEnv.AGENT_LAYERS_HOME;
  delete childEnv.AGENT_LAYERS_SOURCE;
  const r = spawnSync(process.execPath, [BIN, 'workflow', ...args, '--home', s.home], { encoding: 'utf8', env: childEnv });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function planCli(s, ...extra) {
  return cli(s, ['plan', '--path', s.repo, '--goal-file', s.goalFile, '--config', s.policyFile, '--yes', '--json', ...extra]);
}

function planned(s) {
  const r = planCli(s);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).runId;
}

function runCli(s, runId, ...extra) {
  return cli(s, ['run', runId, '--path', s.repo, '--yes', '--json', ...extra]);
}

function state(s, runId) {
  return readRun(s.ctx, runId).state;
}

function artifact(rep, prefix) {
  const dir = path.join(rep.runDir, 'artifacts');
  const name = fs.readdirSync(dir).find((n) => n.startsWith(prefix));
  assert.ok(name, `no artifact starts with ${prefix}`);
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}

function worktreeCount(repo) {
  return git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;
}

async function waitUntil(done) {
  for (let i = 0; i < 1500; i += 1) {
    if (done()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error('the expected state did not arrive in 30 seconds');
}

function startRun(s, runId) {
  const child = spawn(process.execPath, [BIN, 'workflow', 'run', runId, '--path', s.repo, '--yes', '--json', '--home', s.home], { stdio: 'ignore' });
  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
  });
  return { child, exited };
}

function lastEventLine(s, runId) {
  return fs.readFileSync(path.join(s.ctx.paths.stateDir, 'workflows', runId, 'events.jsonl'), 'utf8').trimEnd().split('\n').at(-1);
}

async function waitForProcess(s, runId, callCount, file) {
  await waitUntil(() => s.calls().length === callCount && lastEventLine(s, runId).includes('"process.started"') && (!file || fs.existsSync(path.join(s.calls().at(-1).cwd, file))));
}

async function killManager(s, runId, callCount = 2, file = null) {
  const { child, exited } = startRun(s, runId);
  await waitForProcess(s, runId, callCount, file);
  child.kill('SIGKILL');
  await exited;
  return s.calls().at(-1).pid;
}

function endProcess(pid) {
  try {
    process.kill(TREE_KILL_SUPPORTED ? -pid : pid, 'SIGKILL');
  } catch (err) {
    if (err.code !== 'ESRCH') {
      throw err;
    }
  }
}

function resume(s, runId, checkProcesses = CLEAN) {
  return cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, resume: true, retryDelayMs: 0, checkProcesses });
}

test('workflow run: plan, then run, ends SUCCEEDED with the change only in the worktree', (t) => {
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } } });
  const out = planCli(s);
  assert.equal(out.code, 0, out.stderr);
  const plan = JSON.parse(out.stdout);
  assert.deepEqual(plan.steps, ['impl']);
  assert.equal(plan.usedAgentCalls, 1);
  assert.equal(plan.baseCommit, git(s.repo, 'rev-parse', 'HEAD'));
  assert.equal(worktreeCount(s.repo), 1);
  assert.equal(state(s, plan.runId).status, 'PLANNED');
  assert.equal(cli(s, ['status', plan.runId, '--json']).code, 0);

  const r = runCli(s, plan.runId);
  assert.equal(r.code, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.status, 'SUCCEEDED');
  assert.deepEqual(rep.steps.map((x) => [x.id, x.status]), [['impl', 'SUCCEEDED'], ['review', 'SUCCEEDED'], ['audit', 'SUCCEEDED']]);
  assert.deepEqual(rep.checks.map((c) => [c.id, c.result]), [['unit', 'passed']]);
  assert.equal(rep.budget.agentCalls.used, 4);
  assert.match(r.stderr, /coder impl, attempt 1/);
  assert.match(r.stderr, /checks for impl: unit/);

  assert.equal(fs.readFileSync(path.join(rep.worktree, 'src', 'new.txt'), 'utf8'), 'new\n');
  assert.equal(fs.existsSync(path.join(s.repo, 'src', 'new.txt')), false);
  assert.equal(git(s.repo, 'status', '--porcelain'), '');
  assert.deepEqual(rep.sourceChanges, []);
  assert.equal(rep.sourceChangedSinceStart, false);
  assert.equal(worktreeCount(s.repo), 2);
  assert.ok(artifact(rep, 'result-patch-').lines.includes('+new'));
  assert.deepEqual(artifact(rep, 'checks-').results[0].stdout, ['all good', '']);

  const calls = s.calls();
  assert.deepEqual(s.keys(), ['planner:plan:1', 'coder:impl:1', 'reviewer:review:1', 'auditor:audit:1']);
  assert.notEqual(calls[0].cwd, s.repo);
  assert.equal(fs.existsSync(calls[0].cwd), false);
  assert.equal(calls[0].request.goal, 'Add a file.');
  assert.equal(fs.realpathSync.native(calls[1].cwd), rep.worktree);
  assert.deepEqual(calls[1].request.checks.map((c) => c.id), ['unit']);
  assert.match(calls[2].request.diff, /src\/new\.txt/);
  assert.deepEqual(calls[2].request.allowedWritePaths, ['src']);
  assert.equal(calls[2].request.statusId, undefined);

  assert.deepEqual(JSON.parse(cli(s, ['validate', plan.runId, '--json']).stdout).issues, []);
  const text = cli(s, ['report', plan.runId]).stdout;
  assert.ok(text.includes(`worktree: ${rep.worktree}`), text);
  assert.match(text, /result patch: artifacts\/result-patch-/);
  assert.match(text, /not guaranteed:/);
  assert.equal(/only the direct child is ended/.test(text), process.platform !== 'linux');

  assert.equal(runCli(s, plan.runId).code, 2);
  assert.match(cli(s, ['resume', plan.runId, '--path', s.repo, '--yes']).stderr, /already ended as SUCCEEDED/);
  assert.equal(s.calls().length, 4);
});

test('workflow run: a failed check goes back to the coder with its log, and the fix then passes', (t) => {
  const s = setup(t, {
    'coder:impl:1': { write: { 'src/broken': 'x\n' } },
    'coder:impl:2': { remove: ['src/broken'], write: { 'src/new.txt': 'new\n' } },
  });
  const r = runCli(s, planned(s));
  assert.equal(r.code, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.status, 'SUCCEEDED');
  assert.equal(rep.steps[0].attempts, 2);
  assert.deepEqual(rep.budget.repairAttempts.used, { impl: 1 });
  const first = s.calls()[1].request;
  const second = s.calls()[2].request;
  assert.deepEqual(first.checkLogs, []);
  assert.deepEqual(second.feedback.failures, [{ id: 'unit', exitCode: 1, failedTests: [] }]);
  assert.equal(second.checkLogs[0].id, 'unit');
  assert.ok(second.checkLogs[0].stderr.includes('check found src/broken'));
});

test('workflow run: a review finding goes to a fix call inside the work paths, then the review runs again', (t) => {
  const finding = { code: 'FIX-1', severity: 'high', path: 'src/new.txt', evidence: 'wrong text' };
  const s = setup(t, {
    'coder:impl': { write: { 'src/new.txt': 'old\n' } },
    'reviewer:review:1': { result: { status: 'needs_changes', findings: [finding] } },
    'coder:review-fix': { write: { 'src/new.txt': 'fixed\n' } },
  });
  const r = runCli(s, planned(s));
  assert.equal(r.code, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.status, 'SUCCEEDED');
  assert.deepEqual(s.keys(), ['planner:plan:1', 'coder:impl:1', 'reviewer:review:1', 'coder:review-fix:1', 'reviewer:review:2', 'auditor:audit:1']);
  assert.deepEqual(s.calls()[3].request.feedback.findings, [finding]);
  assert.match(s.calls()[4].request.diff, /\+fixed/);
  assert.equal(fs.readFileSync(path.join(rep.worktree, 'src', 'new.txt'), 'utf8'), 'fixed\n');
});

test('workflow run: changes outside the write scope and changes by read-only roles end the run as FAILED', (t) => {
  const cases = [
    ['outside the write paths', { 'coder:impl': { write: { 'docs/x.txt': 'x\n' } } }, 'docs/x.txt', 'outside-write-paths', 2],
    ['a protected path', { 'coder:impl': { write: { 'src/protected/x.txt': 'x\n' } } }, 'src/protected/x.txt', 'protected-path', 2],
    ['a runtime protected path', { 'coder:impl': { write: { '.codex/config.toml': 'x\n' } } }, '.codex/config.toml', 'protected-path', 2],
    ['the reviewer', { reviewer: { write: { 'src/r.txt': 'x\n' } } }, undefined, 'read-only-role-changed-files', 3],
    ['the auditor', { auditor: { write: { 'src/a.txt': 'changed\n' } } }, undefined, 'read-only-role-changed-files', 4],
  ];
  for (const [name, scenario, file, reason, callCount] of cases) {
    const s = setup(t, scenario);
    const r = runCli(s, planned(s));
    assert.equal(r.code, 1, `${name}: ${r.stderr}`);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.status, 'FAILED', name);
    assert.equal(rep.stopReason, 'policy-violation', name);
    assert.equal(s.calls().length, callCount, name);
    assert.deepEqual(artifact(rep, 'violations-').violations.map((v) => [v.path, v.reason]), [[file, reason]], name);
  }
});

test('workflow run: a read-only role that changes files and then fails is stopped instead of retried', async (t) => {
  const s = setup(t, { reviewer: { write: { 'src/r.txt': 'x\n' }, exit: 1 } });
  const runId = planned(s);
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, retryDelayMs: 0 }), 1);
  assert.equal(state(s, runId).stopReason, 'policy-violation');
  assert.equal(s.calls().filter((c) => c.request.role === 'reviewer').length, 1);
});

test('workflow run: the write scope is the union of the steps so far, and files git ignores are not counted', (t) => {
  const early = setup(t, { 'coder:impl': { write: { 'test/x.txt': 'x\n' } } }, { plan: TWO_STEPS });
  const failed = runCli(early, planned(early));
  assert.equal(failed.code, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).stopReason, 'policy-violation');

  const later = setup(t, { 'coder:tests': { write: { 'src/y.txt': 'y\n' } } }, { plan: TWO_STEPS });
  const allowed = runCli(later, planned(later));
  assert.equal(allowed.code, 0, allowed.stderr);

  const ignored = setup(t, { 'coder:impl': { write: { 'generated/cache.bin': 'x\n' } } });
  const passed = runCli(ignored, planned(ignored));
  assert.equal(passed.code, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).status, 'SUCCEEDED');
});

test('workflow run: a CLI that exits 0 without a readable result leaves the run BLOCKED with invalid-result', (t) => {
  for (const scenario of [{ 'coder:impl': { stdout: '' } }, { 'coder:impl': { stdout: 'I finished it.' } }, { 'coder:impl': { stdout: '{"a":1}' } }]) {
    const s = setup(t, scenario);
    const runId = planned(s);
    const r = runCli(s, runId);
    assert.equal(r.code, 3, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.status, 'BLOCKED');
    assert.equal(rep.stopReason, 'invalid-result');
    const resumed = cli(s, ['resume', runId, '--path', s.repo, '--yes', '--json']);
    assert.equal(resumed.code, 3, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).status, 'BLOCKED');
    assert.equal(s.calls().length, 2);
  }
  const s = setup(t, { 'coder:impl': { stdout: 'I finished it.', stderr: 'log line' } });
  const rep = JSON.parse(runCli(s, planned(s)).stdout);
  assert.deepEqual(artifact(rep, 'call-unreadable-').stdout, ['I finished it.']);
});

test('workflow run: a failing CLI is retried, then BLOCKED, and resume continues in the same worktree', async (t) => {
  const s = setup(t, (repo) => ({
    'coder:impl': [{ exit: 1, stderr: 'network down', write: { [path.join(repo, 'src', 'oops.txt')]: 'x\n' } }, { exit: 1 }, { exit: 1 }, { write: { 'src/new.txt': 'new\n' } }],
  }));
  const runId = planned(s);
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, retryDelayMs: 0 }), 3);
  const blocked = state(s, runId);
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.stopReason, 'transport');
  assert.equal(blocked.steps.impl.lastError, 'transport error exit-1');
  const failedCall = readRun(s.ctx, runId);
  const artifacts = fs.readdirSync(path.join(failedCall.dir, 'artifacts')).filter((n) => n.startsWith('call-failed-'));
  assert.equal(artifacts.length, 3);
  const logged = artifacts.flatMap((n) => JSON.parse(fs.readFileSync(path.join(failedCall.dir, 'artifacts', n), 'utf8')).stderr);
  assert.equal(logged.filter((line) => line === 'network down').length, 1);
  const firstWorktree = s.calls()[1].cwd;

  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, resume: true, retryDelayMs: 0 }), 0);
  const done = readRun(s.ctx, runId);
  assert.equal(done.state.status, 'SUCCEEDED');
  assert.deepEqual(done.issues, []);
  assert.equal(s.calls().find((c) => c.request.stepId === 'review').cwd, firstWorktree);
  assert.equal(s.calls().filter((c) => c.request.role === 'coder').at(-1).request.feedback, null);
  assert.equal(done.events.filter((e) => e.type === 'workspace.created').length, 1);
  assert.equal(done.events.filter((e) => e.type === 'run.outcome').length, 2);
  assert.deepEqual(JSON.parse(cli(s, ['report', runId, '--json']).stdout).sourceChanges, ['uncommitted:src/oops.txt']);
});

test('workflow run: a call past stepTimeoutSeconds is BLOCKED and resume does not repeat it', (t) => {
  const s = setup(t, { 'coder:impl': { sleepMs: 60000 } }, { policy: { limits: { stepTimeoutSeconds: 1 } } });
  const runId = planned(s);
  const r = runCli(s, runId);
  assert.equal(r.code, 3, r.stderr);
  assert.equal(JSON.parse(r.stdout).stopReason, 'timeout');
  assert.equal(cli(s, ['resume', runId, '--path', s.repo, '--yes']).code, 3);
  assert.equal(s.calls().length, 2);
});

test('workflow run: cancelling during a call ends the child and keeps the record; only a confirmed end is CANCELLED', async (t) => {
  const s = setup(t, { 'coder:impl': { write: { 'src/partial.txt': 'x\n' }, sleepMs: 60000 } });
  const runId = planned(s);
  const controller = new AbortController();
  const running = cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, signal: controller.signal });
  await waitUntil(() => s.calls().length === 2);
  controller.abort();
  assert.equal(await running, CANCEL_EXIT);
  const done = readRun(s.ctx, runId);
  assert.equal(done.state.status, CANCEL_STATUS);
  assert.equal(done.state.steps.impl.status, CANCEL_STATUS);
  assert.equal(done.state.owner, null);
  assert.deepEqual(done.issues, []);
  assert.throws(() => process.kill(s.calls()[1].pid, 0));
  const outcome = done.events.filter((e) => e.type === 'run.outcome').at(-1);
  assert.ok(JSON.parse(fs.readFileSync(path.join(done.dir, 'artifacts', outcome.data.patch), 'utf8')).lines.includes('+x'));
  await assert.rejects(cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM }), new RegExp(`is ${CANCEL_STATUS}`));
  if (TREE_KILL_SUPPORTED) {
    await assert.rejects(cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, resume: true }), /already ended as CANCELLED/);
  } else {
    assert.match(done.events.find((e) => e.type === 'run.interrupted').data.error, /only the direct child is ended/);
    assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, resume: true }), 3);
    assert.equal(state(s, runId).stopReason, 'process-unconfirmed');
    assert.equal(s.calls().length, 2);
  }
});

test('workflow run: a cancel before any process starts ends as CANCELLED on every system', async (t) => {
  const s = setup(t);
  const runId = planned(s);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, signal: controller.signal }), 130);
  const done = readRun(s.ctx, runId);
  assert.equal(done.state.status, 'CANCELLED');
  assert.deepEqual(done.events.filter((e) => e.type === 'process.ended').map((e) => [e.data.pid, e.data.confirmed]), [[null, true]]);
  assert.equal(s.calls().length, 1);
  const r = cli(s, ['cancel', runId]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /already ended as CANCELLED/);
});

test('workflow run: each process is recorded by number and result only, and the source once as a digest', (t) => {
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } } });
  const runId = planned(s);
  const r = runCli(s, runId);
  assert.equal(r.code, 0, r.stderr);
  const { events } = readRun(s.ctx, runId);
  const ofType = (type) => events.filter((e) => e.type === type).map((e) => e.data);
  assert.equal(ofType('process.starting').length, 6);
  assert.equal(ofType('process.ended').length, 6);
  const started = ofType('process.started');
  assert.equal(started.length, 6);
  assert.deepEqual(Object.keys(started[0]).sort(), ['checkId', 'pgid', 'pid', 'startTime', 'stepId']);
  assert.deepEqual(Object.keys(started[1]).sort(), ['attempt', 'pgid', 'pid', 'role', 'startTime', 'stepId']);
  assert.deepEqual(Object.keys(started[2]).sort(), ['checkId', 'pgid', 'pid', 'startTime', 'stepId']);
  assert.equal(started[1].pid, s.calls()[1].pid);
  assert.deepEqual(ofType('process.ended').map((d) => [d.confirmed, d.remaining]), Array(6).fill([TREE_KILL_SUPPORTED, 0]));
  assert.equal(ofType('source.baseline').length, 1);
  assert.equal(typeof ofType('source.baseline')[0].digest, 'string');
  assert.deepEqual(ofType('call.baseline').map((d) => d.role), ['reviewer', 'auditor']);
  assert.equal(ofType('run.outcome')[0].sourceChangedSinceStart, false);
});

test('workflow run: cancelling during a check ends the run with the same rule', async (t) => {
  const waitAfterCoder = 'if (require("fs").existsSync("src/new.txt")) { setTimeout(() => {}, 60000); }';
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } } }, { policy: { checks: [{ id: 'unit', command: process.execPath, args: ['-e', waitAfterCoder], timeout: 120 }] } });
  const runId = planned(s);
  const controller = new AbortController();
  const running = cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, signal: controller.signal });
  await waitUntil(() => s.calls().length === 2 && fs.readFileSync(path.join(s.ctx.paths.stateDir, 'workflows', runId, 'events.jsonl'), 'utf8').includes('"step.verifying"'));
  controller.abort();
  assert.equal(await running, CANCEL_EXIT);
  assert.equal(state(s, runId).status, CANCEL_STATUS);
});

test('workflow run: SIGINT and SIGTERM cancel what is running and their listeners are removed', { skip: process.listenerCount('SIGINT') + process.listenerCount('SIGTERM') > 0 }, async (t) => {
  const s = setup(t, { 'coder:impl': { sleepMs: 60000 } });
  const runId = planned(s);
  const running = cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM });
  await waitUntil(() => s.calls().length === 2);
  process.emit('SIGINT');
  assert.equal(await running, CANCEL_EXIT);
  assert.equal(state(s, runId).status, CANCEL_STATUS);

  const p = setup(t, { planner: { sleepMs: 60000 } });
  const planning = cmdPlan(p.ctx, p.flags, { confirm: CONFIRM });
  await waitUntil(() => p.calls().length === 1);
  process.emit('SIGTERM');
  assert.equal(await planning, 130);
  assert.equal(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM'), 0);
});

test('workflow run: a real SIGINT to the command ends the run as CANCELLED with exit code 130', { skip: process.platform === 'win32' }, async (t) => {
  const s = setup(t, { 'coder:impl': { sleepMs: 60000 } });
  const runId = planned(s);
  const child = spawn(process.execPath, [BIN, 'workflow', 'run', runId, '--path', s.repo, '--yes', '--json', '--home', s.home], { stdio: 'ignore' });
  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
  });
  await waitUntil(() => s.calls().length === 2);
  child.kill('SIGINT');
  assert.equal(await exited, 130);
  assert.equal(state(s, runId).status, 'CANCELLED');
  assert.throws(() => process.kill(s.calls()[1].pid, 0));
});

test('workflow cancel: a request from another process stops the run, and both commands end the same way', async (t) => {
  const s = setup(t, { 'coder:impl': { write: { 'src/partial.txt': 'x\n' }, sleepMs: 60000 } });
  const runId = planned(s);
  const { exited } = startRun(s, runId);
  await waitForProcess(s, runId, 2, 'src/partial.txt');
  const r = cli(s, ['cancel', runId, '--json']);
  assert.equal(r.code, CANCEL_EXIT, r.stderr);
  const view = JSON.parse(r.stdout);
  assert.equal(view.status, CANCEL_STATUS);
  assert.equal(await exited, CANCEL_EXIT);
  const done = readRun(s.ctx, runId);
  assert.equal(done.state.status, CANCEL_STATUS);
  assert.equal(done.state.owner, null);
  assert.deepEqual(done.issues, []);
  assert.equal(done.events.filter((e) => e.type === 'cancel.requested').length, 1);
  assert.equal(done.events.filter((e) => e.type === 'run.outcome').length, 1);
  assert.throws(() => process.kill(s.calls()[1].pid, 0));
  assert.equal(s.calls().length, 2);
  if (TREE_KILL_SUPPORTED) {
    assert.match(view.message, /was cancelled/);
    const again = cli(s, ['cancel', runId]);
    assert.equal(again.code, 2);
    assert.match(again.stderr, /already ended as CANCELLED/);
  } else {
    assert.match(view.message, /only the direct child is ended/);
    const again = cli(s, ['cancel', runId, '--json']);
    assert.equal(again.code, 3);
    assert.match(JSON.parse(again.stdout).message, /nothing is running/);
  }
});

test('workflow cancel: a request made to an earlier owner does not cancel a later run', async (t) => {
  const s = setup(t, { 'coder:impl': { sleepMs: 1200 } });
  const runId = planned(s);
  const earlier = acquireRun(s.ctx, runId);
  assert.equal(requestCancel(s.ctx, runId, earlier.owner), true);
  releaseRun(earlier);
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM }), 0);
  const done = readRun(s.ctx, runId);
  assert.equal(done.state.status, 'SUCCEEDED');
  assert.equal(done.events.some((e) => e.type === 'cancel.requested'), false);
});

test('workflow cancel: an unreadable lock is refused, an owner that does not answer times out, and a run that ended first is named', async (t) => {
  const s = setup(t);
  const runId = planned(s);
  const { dir } = readRun(s.ctx, runId);
  const lock = path.join(dir, 'lock');
  fs.writeFileSync(lock, '{}');
  const unreadable = cli(s, ['cancel', runId]);
  assert.equal(unreadable.code, 3);
  assert.match(unreadable.stderr, /unreadable/);
  assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('cancel-')), false);

  const owner = { runId, ownerId: crypto.randomUUID(), pid: process.pid, hostname: `${os.hostname()}-other`, processStart: null, acquiredAt: 'x' };
  fs.writeFileSync(lock, JSON.stringify(owner));
  assert.equal(await cmdCancel(s.ctx, s.flags, runId, { waitMs: 100 }), 3);
  assert.ok(fs.existsSync(path.join(dir, `cancel-${owner.ownerId}.json`)));
  assert.equal(state(s, runId).status, 'PLANNED');
  fs.rmSync(lock);

  assert.equal(runCli(s, runId).code, 0);
  fs.writeFileSync(lock, JSON.stringify({ ...owner, ownerId: crypto.randomUUID() }));
  const waiting = cmdCancel(s.ctx, s.flags, runId);
  fs.rmSync(lock);
  assert.equal(await waiting, 2);
  assert.equal(state(s, runId).status, 'SUCCEEDED');
});

test('workflow status and cancel: a killed manager is shown as gone, and cancel never calls the run cancelled', async (t) => {
  const s = setup(t, { 'coder:impl': { sleepMs: 60000 } });
  const runId = planned(s);
  const pid = await killManager(s, runId);
  try {
    const view = JSON.parse(cli(s, ['status', runId, '--json']).stdout);
    assert.equal(view.status, 'RUNNING');
    assert.equal(view.owner, 'gone');
    assert.match(cli(s, ['status', runId]).stdout, /the process that ran this is gone/);
    assert.equal(state(s, runId).status, 'RUNNING');

    const r = cli(s, ['cancel', runId, '--json']);
    assert.equal(r.code, 3, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.status, 'INTERRUPTED');
    assert.equal(result.processesConfirmed, TREE_KILL_SUPPORTED);
    assert.deepEqual(result.leftovers, TREE_KILL_SUPPORTED ? [pid] : []);
    const stored = readRun(s.ctx, runId);
    assert.equal(stored.state.status, 'INTERRUPTED');
    assert.equal(stored.state.owner, null);
    assert.equal(stored.events.some((e) => e.type === 'run.cancelled'), false);
    assert.equal(JSON.parse(cli(s, ['status', runId, '--json']).stdout).owner, 'none');

    const again = cli(s, ['cancel', runId, '--json']);
    assert.equal(again.code, 3);
    assert.match(JSON.parse(again.stdout).message, /nothing is running/);
  } finally {
    endProcess(pid);
  }
});

test('workflow resume: once the processes are confirmed gone, the step runs again with what it left and the counts so far', async (t) => {
  const s = setup(t, { 'coder:impl': [{ write: { 'src/partial.txt': 'x\n' }, sleepMs: 60000 }, { write: { 'src/new.txt': 'new\n' } }] });
  const runId = planned(s);
  endProcess(await killManager(s, runId, 2, 'src/partial.txt'));
  const seen = [];
  assert.equal(await resume(s, runId, (records) => {
    seen.push(...records.map((r) => r.pid));
    return CLEAN();
  }), 0);
  const done = readRun(s.ctx, runId);
  assert.equal(done.state.status, 'SUCCEEDED');
  assert.deepEqual(done.issues, []);
  const baselineStarted = done.events.find((e) => e.type === 'process.started' && e.data.checkId);
  assert.deepEqual(seen, TREE_KILL_SUPPORTED ? [s.calls()[1].pid] : [baselineStarted.data.pid, s.calls()[1].pid]);
  assert.equal(done.state.steps.impl.attempts, 2);
  assert.equal(done.state.budget.agentCalls, 5);
  assert.deepEqual(s.keys(), ['planner:plan:1', 'coder:impl:1', 'coder:impl:2', 'reviewer:review:1', 'auditor:audit:1']);
  assert.deepEqual(s.calls()[2].request.feedback, { interrupted: true, changedFiles: ['src/partial.txt'] });
  assert.equal(s.calls()[2].cwd, s.calls()[1].cwd);
  const resumed = done.events.find((e) => e.type === 'run.resumed');
  assert.deepEqual(resumed.data.steps, ['impl']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(done.dir, 'artifacts', resumed.data.recovery), 'utf8')).changedFiles, ['src/partial.txt']);
  assert.equal(JSON.parse(cli(s, ['report', runId, '--json']).stdout).sourceChangedSinceStart, false);
});

test('workflow resume: a process still alive blocks the run without a call until it has ended', async (t) => {
  const s = setup(t, { 'coder:impl': [{ sleepMs: 60000 }, {}] });
  const runId = planned(s);
  endProcess(await killManager(s, runId));
  for (let i = 0; i < 2; i += 1) {
    assert.equal(await resume(s, runId, () => ({ confirmed: true, leftovers: [{ pid: 4321 }] })), 3);
    const blocked = state(s, runId);
    assert.equal(blocked.status, 'BLOCKED');
    assert.equal(blocked.stopReason, 'process-left');
    assert.equal(blocked.steps.impl.status, 'BLOCKED');
    assert.match(blocked.steps.impl.lastError, /pid 4321/);
    assert.equal(blocked.budget.agentCalls, 2);
    assert.equal(s.calls().length, 2);
  }
  assert.equal(await resume(s, runId), 0);
  const done = state(s, runId);
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.budget.agentCalls, 5);
});

test('workflow resume: without a way to confirm the processes the run stays BLOCKED and asks for a new plan', async (t) => {
  const s = setup(t, { 'coder:impl': { sleepMs: 60000 } });
  const runId = planned(s);
  endProcess(await killManager(s, runId));
  for (let i = 0; i < 2; i += 1) {
    assert.equal(await resume(s, runId, () => ({ confirmed: false, leftovers: [] })), 3);
    const blocked = state(s, runId);
    assert.equal(blocked.status, 'BLOCKED');
    assert.equal(blocked.stopReason, 'process-unconfirmed');
    assert.match(blocked.steps.impl.lastError, /make a new plan/);
    assert.equal(s.calls().length, 2);
  }
});

test('workflow resume: a run whose records do not name its processes does not continue', async (t) => {
  const missing = [[], [['source.baseline', { digest: 'x' }], ['process.starting', { role: 'coder', stepId: 'impl', attempt: 1 }]]];
  for (const events of missing) {
    const s = setup(t);
    const runId = planned(s);
    const handle = acquireRun(s.ctx, runId);
    for (const [type, data] of events) {
      commitRun(handle, type, data);
    }
    commitRun(handle, 'run.started', {}, (n) => {
      n.status = 'RUNNING';
    });
    fs.rmSync(handle.runLock);
    fs.rmSync(handle.wsLock);
    assert.equal(await resume(s, runId), 3);
    const blocked = state(s, runId);
    assert.equal(blocked.status, 'BLOCKED');
    assert.equal(blocked.stopReason, 'process-unconfirmed');
    assert.equal(s.calls().length, 1);
  }
});

test('workflow resume: files left outside the write paths or changed by a cut-off reviewer end the run as FAILED', async (t) => {
  const cases = [
    ['coder', { 'coder:impl': { write: { 'docs/x.txt': 'x\n' }, sleepMs: 60000 } }, 2, 'docs/x.txt', [['docs/x.txt', 'outside-write-paths']]],
    ['reviewer', { reviewer: { write: { 'src/r.txt': 'x\n' }, sleepMs: 60000 } }, 3, 'src/r.txt', [[undefined, 'read-only-role-changed-files']]],
  ];
  for (const [name, scenario, callCount, file, expected] of cases) {
    const s = setup(t, scenario);
    const runId = planned(s);
    endProcess(await killManager(s, runId, callCount, file));
    assert.equal(await resume(s, runId), 1, name);
    const done = state(s, runId);
    assert.equal(done.status, 'FAILED', name);
    assert.equal(done.stopReason, 'policy-violation', name);
    assert.equal(s.calls().length, callCount, name);
    const rep = JSON.parse(cli(s, ['report', runId, '--json']).stdout);
    assert.deepEqual(artifact(rep, 'violations-').violations.map((v) => [v.path, v.reason]), expected, name);
  }
});

test('workflow resume: a reviewer cut off without changing anything runs again', async (t) => {
  const s = setup(t, { reviewer: [{ sleepMs: 60000 }, {}] });
  const runId = planned(s);
  endProcess(await killManager(s, runId, 3));
  assert.equal(await resume(s, runId), 0);
  assert.deepEqual(s.keys(), ['planner:plan:1', 'coder:impl:1', 'reviewer:review:1', 'reviewer:review:2', 'auditor:audit:1']);
});

test('workflow resume: a commit to the source while the run was stopped is only warned about', async (t) => {
  const s = setup(t, { 'coder:impl': [{ sleepMs: 60000 }, {}] });
  const runId = planned(s);
  endProcess(await killManager(s, runId));
  fs.writeFileSync(path.join(s.repo, 'src', 'later.txt'), 'later\n');
  git(s.repo, 'add', '-A');
  git(s.repo, 'commit', '-qm', 'later');
  assert.equal(await resume(s, runId), 0);
  const rep = JSON.parse(cli(s, ['report', runId, '--json']).stdout);
  assert.equal(rep.status, 'SUCCEEDED');
  assert.deepEqual(rep.sourceChanges, []);
  assert.equal(rep.sourceChangedSinceStart, true);
  assert.match(cli(s, ['report', runId]).stdout, /the source repository changed since the run started/);
  assert.equal(fs.existsSync(path.join(rep.worktree, 'src', 'later.txt')), false);
});

test('workflow resume: with the real process check a killed manager continues on Linux only after its child has ended', async (t) => {
  const s = setup(t, { 'coder:impl': [{ write: { 'src/partial.txt': 'x\n' }, sleepMs: 60000 }, {}] });
  const runId = planned(s);
  const pid = await killManager(s, runId, 2, 'src/partial.txt');
  const resumeCli = () => cli(s, ['resume', runId, '--path', s.repo, '--yes', '--json']);
  try {
    const first = resumeCli();
    assert.equal(first.code, 3, first.stderr);
    const rep = JSON.parse(first.stdout);
    assert.equal(rep.status, 'BLOCKED');
    assert.equal(s.calls().length, 2);
    if (!TREE_KILL_SUPPORTED) {
      assert.equal(rep.stopReason, 'process-unconfirmed');
      assert.match(first.stderr, /make a new plan/);
      return;
    }
    assert.equal(rep.stopReason, 'process-left');
    assert.ok(first.stderr.includes(`pid ${pid}`), first.stderr);
    endProcess(pid);
    await waitUntil(() => findLeftovers([{ pid, pgid: pid, startTime: null }]).length === 0);
    const second = resumeCli();
    assert.equal(second.code, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).status, 'SUCCEEDED');
    assert.deepEqual(s.keys().slice(1, 3), ['coder:impl:1', 'coder:impl:2']);
    assert.deepEqual(s.calls()[2].request.feedback.changedFiles, ['src/partial.txt']);
  } finally {
    endProcess(pid);
  }
});

test('workflow plan: cancelling during the planner creates no run and removes the temporary worktree', async (t) => {
  const s = setup(t, { planner: { sleepMs: 60000 } });
  const controller = new AbortController();
  const running = cmdPlan(s.ctx, s.flags, { confirm: CONFIRM, signal: controller.signal });
  await waitUntil(() => s.calls().length === 1);
  controller.abort();
  assert.equal(await running, 130);
  assert.equal(worktreeCount(s.repo), 1);
  assert.equal(fs.existsSync(path.join(s.ctx.paths.stateDir, 'workflows')), false);
});

test('workflow plan: an invalid plan is repaired with its issues, and a plan that stays invalid creates no run', (t) => {
  const bad = { ...PLAN, steps: [{ ...STEP, writePaths: ['docs'] }] };
  const s = setup(t, { 'planner:plan:1': { plan: bad } });
  const r = planCli(s);
  assert.equal(r.code, 0, r.stderr);
  const view = JSON.parse(r.stdout);
  assert.equal(view.planRepairs, 1);
  assert.equal(view.usedAgentCalls, 2);
  const second = s.calls()[1].request;
  assert.deepEqual(second.previousAnswer, bad);
  assert.deepEqual(second.issues.map((i) => i.where), ['steps[0].writePaths']);
  const budget = JSON.parse(cli(s, ['status', view.runId, '--json']).stdout).budget;
  assert.equal(budget.planRepairs.used, 1);
  assert.equal(budget.agentCalls.used, 2);

  for (const planner of [{ plan: bad }, { stdout: '' }, { stdout: 'no json here' }]) {
    const stays = setup(t, { planner });
    const failed = planCli(stays);
    assert.equal(failed.code, 1, failed.stderr);
    assert.equal(failed.stdout, '');
    assert.match(failed.stderr, /did not return a valid plan/);
    assert.equal(stays.calls().length, 2);
    assert.equal(worktreeCount(stays.repo), 1);
    assert.equal(fs.existsSync(path.join(stays.ctx.paths.stateDir, 'workflows')), false);
  }
});

test('workflow plan: a failing planner is retried within maxTransportRetries and creates no run', async (t) => {
  const s = setup(t, { planner: { exit: 1, stderr: 'network down' } });
  assert.equal(await cmdPlan(s.ctx, s.flags, { confirm: CONFIRM, retryDelayMs: 0 }), 1);
  assert.equal(s.calls().length, 3);
  assert.equal(worktreeCount(s.repo), 1);
  const later = setup(t, { planner: [{ exit: 1 }, {}] });
  assert.equal(await cmdPlan(later.ctx, later.flags, { confirm: CONFIRM, retryDelayMs: 0 }), 0);
  assert.equal(later.calls().length, 2);
});

test('workflow plan: the planner works in a temporary worktree, and a change to the source repository creates no run', (t) => {
  const s = setup(t, { planner: { write: { 'src/from-planner.txt': 'x\n' } } });
  const r = runCli(s, planned(s));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(JSON.parse(r.stdout).worktree, 'src', 'from-planner.txt')), false);
  assert.equal(git(s.repo, 'status', '--porcelain'), '');

  const changed = setup(t, (repo) => ({ planner: { write: { [path.join(repo, 'src', 'oops.txt')]: 'x\n' } } }));
  const out = planCli(changed);
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /source repository changed while planning.*src\/oops\.txt/);
  assert.equal(worktreeCount(changed.repo), 1);
  assert.equal(fs.existsSync(path.join(changed.ctx.paths.stateDir, 'workflows')), false);
});

test('workflow run: a change to the source repository during the run is recorded and warned about', (t) => {
  const s = setup(t, (repo) => ({ 'coder:impl': { write: { [path.join(repo, 'src', 'oops.txt')]: 'x\n' } } }));
  const runId = planned(s);
  const r = runCli(s, runId);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).sourceChanges, ['uncommitted:src/oops.txt']);
  assert.match(r.stderr, /source repository changed during this run/);
  assert.match(cli(s, ['report', runId]).stdout, /warning: the source repository changed during the run: uncommitted:src\/oops\.txt/);
});

test('workflow run: uncommitted changes are refused before any call', (t) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.repo, 'src', 'dirty.txt'), 'x\n');
  const r = planCli(s);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /uncommitted changes/);
  assert.match(r.stderr, /src\/dirty\.txt/);
  assert.equal(s.calls().length, 0);
  fs.rmSync(path.join(s.repo, 'src', 'dirty.txt'));
  const runId = planned(s);
  fs.writeFileSync(path.join(s.repo, 'src', 'dirty.txt'), 'x\n');
  const started = runCli(s, runId);
  assert.equal(started.code, 2);
  assert.match(started.stderr, /src\/dirty\.txt/);
  assert.equal(state(s, runId).status, 'PLANNED');
  assert.equal(s.calls().length, 1);
});

test('workflow run: without --yes and a terminal nothing is called and the exit code is 3', (t) => {
  const s = setup(t);
  const r = cli(s, ['plan', '--path', s.repo, '--goal-file', s.goalFile, '--config', s.policyFile]);
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /pass --yes to confirm/);
  assert.match(r.stderr, /planner command: /);
  assert.equal(s.calls().length, 0);
  const runId = planned(s);
  const started = cli(s, ['run', runId, '--path', s.repo]);
  assert.equal(started.code, 3, started.stderr);
  assert.match(started.stderr, /write paths: src, test/);
  assert.equal(state(s, runId).status, 'PLANNED');
  assert.equal(s.calls().length, 1);
});

test('workflow run: a run belongs to its repository, and run and resume keep to their own states', (t) => {
  const s = setup(t);
  const runId = planned(s);
  const other = newRepo(s.base, 'other');
  const r = cli(s, ['run', runId, '--path', other, '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /belongs to another repository/);
  const resumed = cli(s, ['resume', runId, '--path', s.repo, '--yes']);
  assert.equal(resumed.code, 2);
  assert.match(resumed.stderr, /has not started; use workflow run/);
  assert.equal(s.calls().length, 1);
});

test('workflow run: a commit after the plan is warned about and the run stays on the planned commit', (t) => {
  const s = setup(t);
  const runId = planned(s);
  const baseCommit = git(s.repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(s.repo, 'src', 'later.txt'), 'later\n');
  git(s.repo, 'add', '-A');
  git(s.repo, 'commit', '-qm', 'later');
  const r = runCli(s, runId);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /this plan was made at/);
  const { worktree } = JSON.parse(r.stdout);
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), baseCommit);
  assert.equal(fs.existsSync(path.join(worktree, 'src', 'later.txt')), false);
});

test('workflow run: a resume whose worktree is gone is refused and the run can still be read', async (t) => {
  const s = setup(t, { 'coder:impl': { exit: 1 } });
  const runId = planned(s);
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, retryDelayMs: 0 }), 3);
  git(s.repo, 'worktree', 'remove', '--force', s.calls()[1].cwd);
  const r = cli(s, ['resume', runId, '--path', s.repo, '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no longer exists/);
  assert.equal(state(s, runId).owner, null);
  assert.equal(cli(s, ['status', runId]).code, 0);
});

test('workflow run: two CLIs with different arguments and output run the same flow from the policy alone', (t) => {
  const plain = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } } });
  const fenced = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } } }, {
    provider: (fakeArgs) => ({
      args: [...fakeArgs, 'exec', '--fenced'],
      roleArgs: { reviewer: [...fakeArgs, 'exec', '--fenced', '--reviewing'], auditor: [...fakeArgs, 'audit', '--fenced'] },
    }),
  });
  for (const s of [plain, fenced]) {
    const r = runCli(s, planned(s));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).status, 'SUCCEEDED');
    assert.deepEqual(s.keys(), ['planner:plan:1', 'coder:impl:1', 'reviewer:review:1', 'auditor:audit:1']);
  }
  const argv = fenced.calls().map((c) => c.argv.slice(2));
  assert.deepEqual(argv, [['exec', '--fenced'], ['exec', '--fenced'], ['exec', '--fenced', '--reviewing'], ['audit', '--fenced']]);
});

test('workflow plan: bad input is refused with exit code 2 before any call', (t) => {
  const s = setup(t);
  const broken = path.join(s.base, 'broken.jsonc');
  fs.writeFileSync(broken, '{ nope');
  const invalid = path.join(s.base, 'invalid.jsonc');
  fs.writeFileSync(invalid, JSON.stringify({ schemaVersion: 1, provider: { command: 'ai', args: [], url: 'x' }, allowedWritePaths: ['src'], checks: [], requiredChecks: [] }));
  const empty = path.join(s.base, 'empty.md');
  fs.writeFileSync(empty, ' \n');
  const notRepo = path.join(s.base, 'plain');
  fs.mkdirSync(notRepo);
  const cases = [
    [['--goal-file', path.join(s.base, 'missing.md'), '--config', s.policyFile, '--path', s.repo], /cannot read --goal-file/],
    [['--goal-file', empty, '--config', s.policyFile, '--path', s.repo], /is empty/],
    [['--goal-file', s.goalFile, '--config', path.join(s.base, 'missing.jsonc'), '--path', s.repo], /cannot read --config/],
    [['--goal-file', s.goalFile, '--config', broken, '--path', s.repo], /is not valid JSONC/],
    [['--goal-file', s.goalFile, '--config', invalid, '--path', s.repo], /provider\.url: unknown field/],
    [['--goal-file', s.goalFile, '--config', s.policyFile, '--path', notRepo], /git rev-parse failed/],
  ];
  for (const [args, pattern] of cases) {
    const r = cli(s, ['plan', ...args, '--yes']);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.match(r.stderr, pattern, args.join(' '));
  }
  assert.equal(s.calls().length, 0);
});

test('workflow plan: a secret in the provider arguments is refused without echoing it', (t) => {
  for (const args of [['--token=SYN_RUN_ARG'], ['--api-key', 'SYN_RUN_ARG'], ['-c', 'password=SYN_RUN_ARG']]) {
    const s = setup(t, {}, { provider: (fakeArgs) => ({ args: fakeArgs, roleArgs: { coder: args } }) });
    const r = planCli(s);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /provider\.roleArgs\.coder\[\d\]: must not hold a secret/);
    assert.doesNotMatch(r.stderr, /SYN_RUN_ARG/);
    assert.equal(s.calls().length, 0);
  }
  const allowed = setup(t, {}, { provider: (fakeArgs) => ({ args: [...fakeArgs, '--max-tokens', '100', '--token-limit', '5'] }) });
  assert.equal(planCli(allowed).code, 0);
});

test('workflow plan: a command that cannot start is refused with exit code 2 before any call', (t) => {
  const cases = [
    [{ provider: () => ({ command: 'agent-layers-no-such-program', args: [] }) }, /agent-layers-no-such-program was not found/],
    [{ provider: () => ({ command: 'bin/ai', args: [] }) }, /must be a program name or an absolute path/],
    [{ policy: { checks: [{ id: 'unit', command: 'agent-layers-no-such-check', args: [], timeout: 60 }] } }, /check "unit": agent-layers-no-such-check was not found/],
    [{ policy: { setup: [{ id: 'install', command: 'agent-layers-no-such-tool', args: [], timeout: 60 }] } }, /setup command "install": agent-layers-no-such-tool was not found/],
  ];
  for (const [options, pattern] of cases) {
    const s = setup(t, {}, options);
    const r = planCli(s);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, pattern);
    assert.equal(s.calls().length, 0);
  }
});

test('workflow plan: an npm batch file is refused on Windows with what to write instead', { skip: process.platform !== 'win32' }, (t) => {
  const s = setup(t, {}, { provider: () => ({ command: 'wf-run-fake-cli', args: [] }) });
  const bin = path.join(s.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'wf-run-fake-cli.cmd'), '@echo off\r\n');
  const r = cli(s, ['plan', '--path', s.repo, '--goal-file', s.goalFile, '--config', s.policyFile, '--yes'], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /is a batch file, which needs a shell/);
});

test('workflow resume: a coder resumed after a failed check gets the failures and the log again', async (t) => {
  const s = setup(t, {
    'coder:impl': [{ write: { 'src/broken': 'x\n' } }, { exit: 1 }, { exit: 1 }, { exit: 1 }, { remove: ['src/broken'], write: { 'src/new.txt': 'new\n' } }],
  });
  const runId = planned(s);
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, retryDelayMs: 0 }), 3);
  assert.equal(state(s, runId).stopReason, 'transport');
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, resume: true, retryDelayMs: 0 }), 0);
  const last = s.calls().filter((c) => c.request.role === 'coder').at(-1).request;
  assert.deepEqual(last.feedback.failures, [{ id: 'unit', exitCode: 1, failedTests: [] }]);
  assert.equal(last.checkLogs[0].id, 'unit');
  assert.ok(last.checkLogs[0].stderr.includes('check found src/broken'));
  assert.equal(readRun(s.ctx, runId).events.filter((e) => e.type === 'checks.baseline').length, 1);
});

test('workflow resume: a resumed coder gets the newest failures and only the logs of the checks that failed', async (t) => {
  const failing = 'const fs = require("fs"); if (fs.existsSync("src/broken")) { console.error(`not ok - ${fs.readFileSync("src/broken", "utf8").trim()}`); process.exit(1); }';
  const s = setup(t, {
    'coder:impl': [{ write: { 'src/broken': 'first\n' } }, { write: { 'src/broken': 'second\n' } }, { exit: 1 }, { exit: 1 }, { exit: 1 }, { remove: ['src/broken'], write: { 'src/new.txt': 'new\n' } }],
  }, { plan: { ...PLAN, steps: [{ ...STEP, checkIds: ['other', 'unit'] }] }, policy: { checks: [nodeCheck('', { id: 'other' }), nodeCheck(failing, { failedTestPattern: 'not ok - (\\S+)' })] } });
  const runId = planned(s);
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, retryDelayMs: 0 }), 3);
  assert.equal(state(s, runId).stopReason, 'transport');
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, resume: true, retryDelayMs: 0 }), 0);
  const last = s.calls().filter((c) => c.request.role === 'coder').at(-1).request;
  assert.deepEqual(last.feedback.failures, [{ id: 'unit', exitCode: 1, failedTests: ['second'] }]);
  assert.deepEqual(last.checkLogs.map((l) => l.id), ['unit']);
  assert.ok(last.checkLogs[0].stderr.includes('not ok - second'));
});

test('workflow run: a check that leaves a file outside the write paths ends the run as FAILED', (t) => {
  const script = 'const fs = require("fs"); if (fs.existsSync("src/new.txt")) { fs.writeFileSync("outside.txt", "x\\n"); }';
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } } }, { policy: { checks: [{ id: 'unit', command: process.execPath, args: ['-e', script], timeout: 60 }] } });
  const r = runCli(s, planned(s));
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.status, 'FAILED');
  assert.equal(rep.stopReason, 'policy-violation');
  assert.equal(r.code, 1);
  assert.equal(s.keys().includes('reviewer:review:1'), false);
});

test('workflow resume: a change made after the review runs the checks and the review again', async (t) => {
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } }, auditor: [{ exit: 1 }, { exit: 1 }, { exit: 1 }, {}] });
  const runId = planned(s);
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, retryDelayMs: 0 }), 3);
  const worktree = s.calls().find((c) => c.request.role === 'coder').cwd;
  fs.writeFileSync(path.join(worktree, 'src', 'new.txt'), 'changed after the review\n');
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, resume: true, retryDelayMs: 0 }), 0);
  const reviews = s.calls().filter((c) => c.request.role === 'reviewer');
  assert.equal(reviews.length, 2);
  assert.match(reviews[1].request.diff, /changed after the review/);
  const { state: done, events } = readRun(s.ctx, runId);
  assert.equal(done.status, 'SUCCEEDED');
  const outcome = events.findLast((e) => e.type === 'run.outcome');
  assert.equal(events.findLast((e) => e.type === 'run.succeeded').data.patchSha256, outcome.data.patchSha256);
  assert.equal(events.filter((e) => e.type === 'checks.baseline').length, 1);
  assert.deepEqual(events.filter((e) => e.type === 'seal.broken').map((e) => e.data.stepId), ['audit']);
});

function nodeCheck(script, extra = {}) {
  return { id: 'unit', command: process.execPath, args: ['-e', script], timeout: 60, ...extra };
}

function writeScript(file) {
  return `const fs = require("fs"); fs.mkdirSync(require("path").dirname(${JSON.stringify(file)}), { recursive: true }); fs.writeFileSync(${JSON.stringify(file)}, "x\\n");`;
}

function runDirOf(s, runId) {
  return path.join(s.ctx.paths.stateDir, 'workflows', runId);
}

function withoutSetup(s, runId) {
  const dir = runDirOf(s, runId);
  const policy = JSON.parse(fs.readFileSync(path.join(dir, 'policy.json'), 'utf8'));
  delete policy.setup;
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policy));
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ ...plan, policyHash: hashJson(policy) }));
}

test('workflow run: a check that fails at the base commit stops before any coder call and the report shows it', (t) => {
  const failing = 'console.log("not ok - first"); process.exit(1);';
  const s = setup(t, {}, { policy: { checks: [nodeCheck(failing, { failedTestPattern: 'not ok - (\\S+)' })] } });
  const runId = planned(s);
  const r = runCli(s, runId);
  assert.equal(r.code, 3, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.status, 'BLOCKED');
  assert.equal(rep.stopReason, 'baseline-failed');
  assert.deepEqual(s.keys(), ['planner:plan:1']);
  assert.deepEqual(rep.baseline, [{ id: 'unit', exitCode: 1, failedTests: ['first'], timedOut: false, expected: 'pass', matched: false }]);
  assert.deepEqual(rep.checks.map((c) => [c.id, c.result]), [['unit', 'not-run']]);
  assert.deepEqual(artifact(rep, 'baseline-').results[0].stdout, ['not ok - first', '']);
  const text = cli(s, ['report', runId]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /next: a check failed at the base commit; see artifacts\/baseline-\*/);
  assert.match(text.stdout, /needs a new plan/);
  assert.match(text.stdout, /baseline checks at the base commit:\n {2}unit: exit 1, expected to pass, NOT as expected; failing tests: first/);
});

test('workflow report: a stop that resume does not continue says what to do next, and resume calls nothing', (t) => {
  const finding = { code: 'docs', severity: 'low', path: 'docs/guide.md', evidence: 'not documented' };
  const cases = [
    ['role-blocked', { 'coder:impl': { result: { status: 'blocked', needsInput: ['Which file name?'] } } }, {}, /result\.needsInput/],
    ['timeout', { 'coder:impl': { sleepMs: 60000 } }, { limits: { stepTimeoutSeconds: 1 } }, /limits\.stepTimeoutSeconds/],
    ['invalid-result', { 'coder:impl': { stdout: 'I finished it.' } }, {}, /artifacts\/call-unreadable-\*/],
    ['finding-out-of-scope', { 'auditor:audit': { result: { status: 'needs_changes', findings: [finding] } } }, {}, /allowedWritePaths/],
  ];
  for (const [reason, scenario, policy, hint] of cases) {
    const s = setup(t, scenario, { policy });
    const runId = planned(s);
    assert.equal(runCli(s, runId).code, 3, reason);
    assert.equal(JSON.parse(cli(s, ['report', runId, '--json']).stdout).stopReason, reason);
    const text = cli(s, ['report', runId]);
    assert.equal(text.code, 0, text.stderr);
    const next = text.stdout.split('\n').find((l) => l.startsWith('next: '));
    assert.ok(next, `${reason} has no next line`);
    assert.match(next, hint);
    assert.match(next, /workflow resume does not continue this run/);
    assert.match(next, /new plan/);
    const calls = s.calls().length;
    const resumed = cli(s, ['resume', runId, '--path', s.repo, '--yes', '--json']);
    assert.equal(resumed.code, 3, resumed.stderr);
    const after = JSON.parse(resumed.stdout);
    assert.equal(after.status, 'BLOCKED');
    assert.equal(after.stopReason, reason);
    assert.equal(s.calls().length, calls);
  }
});

test('workflow run: a check expected to fail at the base commit is passed by the change, with one hash from the checks to the end', (t) => {
  const accept = 'if (!require("fs").existsSync("src/new.txt")) { console.error("the new file is missing"); process.exit(1); }';
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } } }, { policy: { checks: [nodeCheck(accept, { baseline: 'fail' })] } });
  const runId = planned(s);
  const r = runCli(s, runId);
  assert.equal(r.code, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.status, 'SUCCEEDED');
  assert.deepEqual(rep.baseline, [{ id: 'unit', exitCode: 1, failedTests: [], timedOut: false, expected: 'fail', matched: true }]);
  assert.deepEqual(rep.checks.map((c) => [c.id, c.result]), [['unit', 'passed']]);
  assert.deepEqual(artifact(rep, 'baseline-').results[0].stderr, ['the new file is missing', '']);
  const { sealed, reviewer, auditor, final, matched } = rep.verdict;
  assert.equal(matched, true);
  assert.equal(sealed, rep.resultPatch.sha256);
  assert.deepEqual([reviewer, auditor, final], [sealed, sealed, sealed]);
  assert.equal(readRun(s.ctx, runId).events.findLast((e) => e.type === 'run.succeeded').data.patchSha256, sealed);
  assert.deepEqual(rep.unguardedChecks, ['unit']);
  const text = cli(s, ['report', runId]).stdout;
  assert.match(text, /unit: exit 1, expected to fail, as expected/);
  assert.match(text, /result hashes all match: checks /);
  assert.match(text, /checks without inputs, whose test files the AI CLI may edit: unit/);
});

test('workflow run: a check expected to fail at the base commit stops the run when it passes, times out or cannot start', (t) => {
  for (const [name, check, exitCode] of [
    ['passes', nodeCheck('', { baseline: 'fail' }), 0],
    ['times out', nodeCheck('setTimeout(() => {}, 60000);', { baseline: 'fail', timeout: 1 }), 124],
    ['cannot start', { id: 'unit', command: './agent-layers-no-such-check', args: [], timeout: 60, baseline: 'fail' }, 127],
  ]) {
    const s = setup(t, {}, { policy: { checks: [check] } });
    const r = runCli(s, planned(s));
    assert.equal(r.code, 3, `${name}: ${r.stderr}`);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.stopReason, 'baseline-unexpected', name);
    assert.equal(rep.baseline[0].exitCode, exitCode, name);
    assert.equal(rep.baseline[0].matched, false, name);
    assert.equal(rep.baseline[0].timedOut, name === 'times out', name);
    assert.deepEqual(s.keys(), ['planner:plan:1'], name);
    if (name === 'times out') {
      assert.match(cli(s, ['report', rep.runId]).stdout, /unit: exit 124 \(timed out\), expected to fail, NOT as expected/);
    }
  }
});

test('workflow run: setup runs once in the worktree, may leave ignored files, and stops the run when it fails or leaves other changes', (t) => {
  const passing = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } } }, { policy: { setup: [nodeCheck(writeScript('generated/out.txt'), { id: 'gen' })] } });
  const r1 = runCli(passing, planned(passing));
  assert.equal(r1.code, 0, r1.stderr);
  const rep1 = JSON.parse(r1.stdout);
  assert.deepEqual(rep1.setup, [{ id: 'gen', exitCode: 0, timedOut: false }]);
  assert.equal(fs.existsSync(path.join(rep1.worktree, 'generated', 'out.txt')), true);
  assert.equal(artifact(rep1, 'setup-').results[0].id, 'gen');
  assert.deepEqual(readRun(passing.ctx, rep1.runId).events.filter((e) => e.type === 'process.started' && e.data.setupId).length, 1);

  const changing = setup(t, {}, { policy: { setup: [nodeCheck(writeScript('made-by-setup.txt'), { id: 'gen' })] } });
  const r2 = runCli(changing, planned(changing));
  assert.equal(r2.code, 3, r2.stderr);
  const rep2 = JSON.parse(r2.stdout);
  assert.equal(rep2.stopReason, 'preflight-changed-files');
  assert.deepEqual(rep2.baselineChanges.changed, ['made-by-setup.txt']);
  assert.deepEqual(changing.keys(), ['planner:plan:1']);
  assert.match(cli(changing, ['report', rep2.runId]).stdout, /changed before any AI call: made-by-setup\.txt/);

  for (const [name, item, exitCode] of [
    ['fails', nodeCheck('process.exit(4);', { id: 'gen' }), 4],
    ['cannot start', { id: 'gen', command: './agent-layers-no-such-tool', args: [], timeout: 60 }, 127],
  ]) {
    const failing = setup(t, {}, { policy: { setup: [item, nodeCheck(writeScript('generated/later.txt'), { id: 'later' })] } });
    const r3 = runCli(failing, planned(failing));
    assert.equal(r3.code, 3, `${name}: ${r3.stderr}`);
    const rep3 = JSON.parse(r3.stdout);
    assert.equal(rep3.stopReason, 'setup-failed', name);
    assert.deepEqual(rep3.setup, [{ id: 'gen', exitCode, timedOut: false }], name);
    assert.deepEqual(rep3.baseline, [], name);
    assert.deepEqual(failing.keys(), ['planner:plan:1'], name);
    assert.equal(fs.existsSync(path.join(rep3.worktree, 'generated', 'later.txt')), false, name);
  }
});

test('workflow run: a check that changes files at the base commit stops the run before any coder call', (t) => {
  const s = setup(t, {}, { policy: { checks: [nodeCheck(writeScript('src/coverage.txt'))] } });
  const r = runCli(s, planned(s));
  assert.equal(r.code, 3, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.stopReason, 'preflight-changed-files');
  assert.deepEqual(rep.baselineChanges.changed, ['src/coverage.txt']);
  assert.deepEqual(s.keys(), ['planner:plan:1']);
});

test('workflow resume: a stopped preparation runs again once the environment is fixed', async (t) => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-run-marker-'));
  t.after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
  const marker = path.join(markerDir, 'fixed');
  const script = `if (!require("fs").existsSync(${JSON.stringify(marker)})) { process.exit(1); }`;
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } } }, { policy: { checks: [nodeCheck(script)] } });
  const runId = planned(s);
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM }), 3);
  assert.equal(state(s, runId).stopReason, 'baseline-failed');
  assert.equal(await resume(s, runId), 3);
  assert.equal(state(s, runId).stopReason, 'baseline-failed');
  fs.writeFileSync(marker, 'x\n');
  assert.equal(await resume(s, runId), 0);
  const { state: done, events } = readRun(s.ctx, runId);
  assert.equal(done.status, 'SUCCEEDED');
  assert.deepEqual(events.filter((e) => e.type === 'checks.baseline').map((e) => e.data.results[0].matched), [false, false, true]);
});

test('workflow report: after a resume the report shows the latest setup and baseline results', async (t) => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-run-marker-'));
  t.after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
  const needs = (name) => `if (!require("fs").existsSync(${JSON.stringify(path.join(markerDir, name))})) { process.exit(1); }`;
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } } }, { policy: { setup: [nodeCheck(needs('setup'), { id: 'install' })], checks: [nodeCheck(needs('check'))] } });
  const runId = planned(s);
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM }), 3);
  assert.equal(state(s, runId).stopReason, 'setup-failed');
  assert.deepEqual(reportView(readRun(s.ctx, runId)).setup, [{ id: 'install', exitCode: 1, timedOut: false }]);
  fs.writeFileSync(path.join(markerDir, 'setup'), 'x\n');
  assert.equal(await resume(s, runId), 3);
  assert.equal(state(s, runId).stopReason, 'baseline-failed');
  assert.deepEqual(reportView(readRun(s.ctx, runId)).setup, [{ id: 'install', exitCode: 0, timedOut: false }]);
  assert.deepEqual(reportView(readRun(s.ctx, runId)).baseline.map((b) => b.matched), [false]);
  fs.writeFileSync(path.join(markerDir, 'check'), 'x\n');
  assert.equal(await resume(s, runId), 0);
  assert.deepEqual(reportView(readRun(s.ctx, runId)).baseline.map((b) => b.matched), [true]);
});

test('workflow run: cancelling during a baseline check ends the run with the same rule, before any coder call', async (t) => {
  const s = setup(t, {}, { policy: { checks: [nodeCheck('setTimeout(() => {}, 60000);', { timeout: 120 })] } });
  const runId = planned(s);
  const controller = new AbortController();
  const running = cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, signal: controller.signal });
  await waitUntil(() => lastEventLine(s, runId).includes('"process.started"'));
  controller.abort();
  assert.equal(await running, CANCEL_EXIT);
  assert.equal(state(s, runId).status, CANCEL_STATUS);
  assert.deepEqual(s.keys(), ['planner:plan:1']);
});

test('workflow resume: a run killed during a baseline check prepares again from the start and keeps the check result', async (t) => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-run-marker-'));
  t.after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
  const marker = path.join(markerDir, 'first');
  const script = `const fs = require("fs"); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, "x"); fs.writeFileSync("left-by-baseline.txt", "x"); setTimeout(() => {}, 60000); }`;
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } } }, { policy: { checks: [nodeCheck(script, { timeout: 120 })] } });
  const runId = planned(s);
  const { child, exited } = startRun(s, runId);
  await waitUntil(() => fs.existsSync(marker) && lastEventLine(s, runId).includes('"process.started"'));
  child.kill('SIGKILL');
  await exited;
  const stopped = readRun(s.ctx, runId);
  const worktree = stopped.events.find((e) => e.type === 'workspace.created').data.path;
  endProcess(stopped.events.findLast((e) => e.type === 'process.started').data.pid);
  await waitUntil(() => {
    try {
      fs.rmSync(path.join(worktree, 'left-by-baseline.txt'), { force: true });
      return true;
    } catch (err) {
      return false;
    }
  });
  assert.equal(await resume(s, runId), 0);
  const { state: done, events } = readRun(s.ctx, runId);
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(events.filter((e) => e.type === 'checks.baseline').length, 1);
  assert.deepEqual(s.keys(), ['planner:plan:1', 'coder:impl:1', 'reviewer:review:1', 'auditor:audit:1']);
});

test('workflow resume: what a killed baseline check left stops the run as a preparation problem, not as a policy violation', async (t) => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-run-marker-'));
  t.after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
  const marker = path.join(markerDir, 'first');
  const script = `const fs = require("fs"); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync("left-by-baseline.txt", "x"); fs.writeFileSync(${JSON.stringify(marker)}, "x"); setTimeout(() => {}, 60000); }`;
  const s = setup(t, {}, { policy: { checks: [nodeCheck(script, { timeout: 120 })] } });
  const runId = planned(s);
  const { child, exited } = startRun(s, runId);
  await waitUntil(() => fs.existsSync(marker) && lastEventLine(s, runId).includes('"process.started"'));
  child.kill('SIGKILL');
  await exited;
  endProcess(readRun(s.ctx, runId).events.findLast((e) => e.type === 'process.started').data.pid);
  assert.equal(await resume(s, runId), 3);
  const blocked = state(s, runId);
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.stopReason, 'preflight-changed-files');
  assert.deepEqual(s.keys(), ['planner:plan:1']);
});

test('workflow run: a coder that changes or deletes an existing check input fails the run, and a new file next to it does not', (t) => {
  for (const action of [{ write: { 'src/a.txt': 'changed\n' } }, { remove: ['src/a.txt'] }]) {
    const s = setup(t, { 'coder:impl': action }, { policy: { checks: [nodeCheck(CHECK_SCRIPT, { inputs: ['src/a.txt'] })] } });
    const r = runCli(s, planned(s));
    assert.equal(r.code, 1, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.stopReason, 'policy-violation');
    assert.match(rep.steps[0].lastError, /src\/a\.txt \(check-input-changed\)/);
    assert.deepEqual(rep.unguardedChecks, []);
    assert.equal(s.keys().includes('reviewer:review:1'), false);
  }
  const s = setup(t, { 'coder:impl': { write: { 'src/b.txt': 'new\n' } } }, { policy: { checks: [nodeCheck(CHECK_SCRIPT, { inputs: ['src'] })] } });
  const r = runCli(s, planned(s));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'SUCCEEDED');
});

test('workflow run: a check that changes a check input is found at the seal', (t) => {
  const script = 'const fs = require("fs"); if (fs.existsSync("src/new.txt")) { fs.writeFileSync("src/a.txt", "changed by the check\\n"); }';
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } } }, { policy: { checks: [nodeCheck(script, { inputs: ['src/a.txt'] })] } });
  const r = runCli(s, planned(s));
  assert.equal(r.code, 1, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.stopReason, 'policy-violation');
  assert.match(rep.steps.find((x) => x.id === 'review').lastError, /src\/a\.txt \(check-input-changed\)/);
  assert.equal(s.keys().includes('reviewer:review:1'), false);
});

test('workflow resume: a protected file changed after the seal fails the run', async (t) => {
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } }, auditor: [{ exit: 1 }, { exit: 1 }, { exit: 1 }, {}] });
  const runId = planned(s);
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, retryDelayMs: 0 }), 3);
  const worktree = s.calls().find((c) => c.request.role === 'coder').cwd;
  fs.writeFileSync(path.join(worktree, 'src', 'protected'), 'changed after the seal\n');
  assert.equal(await cmdRun(s.ctx, s.flags, runId, { confirm: CONFIRM, resume: true, retryDelayMs: 0 }), 1);
  const done = state(s, runId);
  assert.equal(done.status, 'FAILED');
  assert.equal(done.stopReason, 'policy-violation');
  assert.match(done.steps.audit.lastError, /src\/protected \(protected-path\)/);
  assert.equal(s.keys().filter((k) => k.startsWith('auditor')).length, 3);
});

test('workflow run: a review fix that passes its checks seals the new result, so the reviews are not repeated for it', (t) => {
  const finding = { code: 'FIX-1', severity: 'high', path: 'src/new.txt', evidence: 'wrong text' };
  const s = setup(t, {
    'coder:impl': { write: { 'src/new.txt': 'old\n' } },
    'reviewer:review:1': { result: { status: 'needs_changes', findings: [finding] } },
    'coder:review-fix': { write: { 'src/new.txt': 'fixed\n' } },
  });
  const runId = planned(s);
  const r = runCli(s, runId);
  assert.equal(r.code, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.verdict.matched, true);
  const { events } = readRun(s.ctx, runId);
  assert.deepEqual(events.filter((e) => e.type === 'seal.broken'), []);
  assert.deepEqual(s.keys(), ['planner:plan:1', 'coder:impl:1', 'reviewer:review:1', 'coder:review-fix:1', 'reviewer:review:2', 'auditor:audit:1']);
});

test('workflow run: a record planned before baseline checks existed needs a new plan to run and can still be read', async (t) => {
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } }, auditor: { exit: 1 } });
  const notStarted = planned(s);
  const blocked = planned(s);
  assert.equal(await cmdRun(s.ctx, s.flags, blocked, { confirm: CONFIRM, retryDelayMs: 0 }), 3);
  const called = s.calls().length;
  for (const runId of [notStarted, blocked]) {
    withoutSetup(s, runId);
  }
  const started = runCli(s, notStarted);
  assert.equal(started.code, 2);
  assert.match(started.stderr, /planned by an older version/);
  const resumed = cli(s, ['resume', blocked, '--path', s.repo, '--yes']);
  assert.equal(resumed.code, 2);
  assert.match(resumed.stderr, /needs a new plan/);
  assert.equal(s.calls().length, called);
  for (const runId of [notStarted, blocked]) {
    assert.equal(cli(s, ['status', runId]).code, 0);
    const report = cli(s, ['report', runId, '--json']);
    assert.equal(report.code, 0, report.stderr);
    assert.deepEqual(JSON.parse(report.stdout).issues, []);
  }
});

test('workflow run: a stored policy edited after the plan is refused by run and resume before anything runs', async (t) => {
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } }, auditor: { exit: 1 } });
  const notStarted = planned(s);
  const blocked = planned(s);
  assert.equal(await cmdRun(s.ctx, s.flags, blocked, { confirm: CONFIRM, retryDelayMs: 0 }), 3);
  const called = s.calls().length;
  const lastLines = {};
  for (const runId of [notStarted, blocked]) {
    const file = path.join(runDirOf(s, runId), 'policy.json');
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    policy.checks[0].args = ['-e', 'process.exit(0)'];
    fs.writeFileSync(file, JSON.stringify(policy));
    lastLines[runId] = lastEventLine(s, runId);
  }
  const started = runCli(s, notStarted);
  assert.equal(started.code, 3, started.stderr);
  assert.match(started.stderr, /cannot be recovered automatically: policy\.json does not match the policyHash/);
  const resumed = cli(s, ['resume', blocked, '--path', s.repo, '--yes']);
  assert.equal(resumed.code, 3, resumed.stderr);
  assert.match(resumed.stderr, /cannot be recovered automatically: policy\.json does not match the policyHash/);
  assert.equal(s.calls().length, called);
  for (const runId of [notStarted, blocked]) {
    assert.equal(lastEventLine(s, runId), lastLines[runId]);
  }
});

test('workflow run: a required check that fails after the work steps is repaired with every write path before the reviews', (t) => {
  const s = setup(t, {
    'coder:impl': { write: { 'src/broken': 'x\n', 'src/new.txt': 'new\n' } },
    'coder:review-fix': { remove: ['src/broken'] },
  }, { plan: { ...PLAN, steps: [{ ...STEP, checkIds: [] }, { ...STEP, id: 'tests', dependsOn: ['impl'], writePaths: ['test'], checkIds: [] }] } });
  const runId = planned(s);
  const r = runCli(s, runId);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(s.keys(), ['planner:plan:1', 'coder:impl:1', 'coder:tests:1', 'coder:review-fix:1', 'reviewer:review:1', 'auditor:audit:1']);
  const fix = s.calls()[3].request;
  assert.equal(fix.instruction, 'Fix the failing required checks');
  assert.deepEqual(fix.writePaths, ['src', 'test']);
  assert.deepEqual(fix.feedback, { failures: [{ id: 'unit', exitCode: 1, failedTests: [] }] });
  assert.ok(fix.checkLogs[0].stderr.includes('check found src/broken'));
  assert.equal(readRun(s.ctx, runId).state.budget.repairAttempts['review-fix'], 1);
});

test('workflow run: failing test names appear in the report', (t) => {
  const named = 'if (require("fs").existsSync("src/broken")) { console.log("not ok - alpha"); process.exit(1); }';
  const s = setup(t, { 'coder:impl': { write: { 'src/broken': 'x\n' } } }, { policy: { limits: { maxRepairAttempts: 0 }, checks: [nodeCheck(named, { failedTestPattern: 'not ok - (\\S+)' })] } });
  const runId = planned(s);
  const r = runCli(s, runId);
  assert.equal(r.code, 1, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.stopReason, 'repair-limit');
  assert.deepEqual(rep.checks[0].failedTests, ['alpha']);
  assert.match(cli(s, ['report', runId]).stdout, /unit \(required\): failed \(exit 1\); failing tests: alpha/);

  const twelve = 'for (let i = 0; i < 12; i += 1) { console.log(`not ok - t${String(i).padStart(2, "0")}`); } process.exit(1);';
  const many = setup(t, {}, { policy: { checks: [nodeCheck(twelve, { failedTestPattern: 'not ok - (\\S+)' })] } });
  const manyRun = runCli(many, planned(many));
  assert.equal(manyRun.code, 3, manyRun.stderr);
  const manyReport = JSON.parse(manyRun.stdout);
  assert.equal(manyReport.baseline[0].failedTests.length, 12);
  const text = cli(many, ['report', manyReport.runId]).stdout;
  assert.match(text, /failing tests: t00, t01, t02, t03, t04, t05, t06, t07, t08, t09 and 2 more\n/);
});

test('workflow run: a diff too long for a request is cut and marked, for a repair coder and for the reviews', (t) => {
  const size = 512 * 1024;
  const s = setup(t, { 'coder:impl': [{ write: { 'src/big.txt': `${'x'.repeat(size)}\n`, 'src/broken': 'x\n' } }, { remove: ['src/broken'] }] });
  const r = runCli(s, planned(s));
  assert.equal(r.code, 0, r.stderr);
  const [, , repair, reviewer, auditor] = s.calls().map((c) => c.request);
  for (const req of [repair, reviewer, auditor]) {
    assert.equal(req.diff.length, size);
    assert.equal(req.diffTruncated, true);
  }
});

test('workflow run: a coder that only says it finished does not finish the run, and the check comes from the stored policy', (t) => {
  const s = setup(t, { 'coder:impl': { write: { 'src/broken': 'x\n' }, result: { summary: 'all checks pass, trust me' } } }, { policy: { limits: { maxRepairAttempts: 0 } } });
  const runId = planned(s);
  const policy = JSON.parse(fs.readFileSync(s.policyFile, 'utf8'));
  fs.writeFileSync(s.policyFile, JSON.stringify({ ...policy, checks: [nodeCheck('')] }));
  const r = runCli(s, runId);
  assert.equal(r.code, 1, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.status, 'FAILED');
  assert.equal(rep.stopReason, 'repair-limit');
  assert.deepEqual(rep.checks.map((c) => [c.id, c.result, c.exitCode]), [['unit', 'failed', 1]]);
});

test('workflow run: the reviews get the checks and their latest results, and a repair coder gets the diff so far', (t) => {
  const s = setup(t, { 'coder:impl': [{ write: { 'src/broken': 'x\n' } }, { remove: ['src/broken'], write: { 'src/new.txt': 'new\n' } }] });
  const runId = planned(s);
  const r = runCli(s, runId);
  assert.equal(r.code, 0, r.stderr);
  const [, first, repair, reviewer, auditor] = s.calls().map((c) => c.request);
  assert.equal(first.diff, undefined);
  assert.equal(first.diffTruncated, undefined);
  assert.match(repair.diff, /src\/broken/);
  assert.equal(repair.diffTruncated, false);
  const checksFinished = readRun(s.ctx, runId).events.filter((e) => e.type === 'checks.finished');
  const last = checksFinished.at(-1).data;
  for (const req of [reviewer, auditor]) {
    assert.deepEqual(req.checks, [{ id: 'unit', command: process.execPath, args: ['-e', CHECK_SCRIPT] }]);
    assert.deepEqual(req.checkResults, [{ id: 'unit', exitCode: last.results[0].exitCode, stepId: last.stepId }]);
    assert.equal(req.checkResults[0].stepId, 'review');
    assert.equal(Object.hasOwn(req, 'checkLogs'), false);
  }
});

test('workflow run: a check that only a work step runs keeps its own step in the results the reviews get', (t) => {
  const lint = { id: 'lint', command: process.execPath, args: ['-e', ''], timeout: 60 };
  const unused = { id: 'unused', command: process.execPath, args: ['-e', ''], timeout: 60 };
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } } }, {
    plan: { ...PLAN, steps: [{ ...STEP, checkIds: ['lint'] }] },
    policy: { checks: [nodeCheck(CHECK_SCRIPT), lint, unused] },
  });
  const r = runCli(s, planned(s));
  assert.equal(r.code, 0, r.stderr);
  const reviewer = s.calls().find((c) => c.request.role === 'reviewer').request;
  assert.deepEqual(reviewer.checks.map((c) => c.id), ['unit', 'lint', 'unused']);
  assert.deepEqual(reviewer.checkResults, [{ id: 'lint', exitCode: 0, stepId: 'impl' }, { id: 'unit', exitCode: 0, stepId: 'review' }]);
});

test('workflow role guides: the reviews are told the checks already ran, and a repair coder is told about the diff', () => {
  const guide = (role) => fs.readFileSync(new URL(`../templates/workflow/roles/${role}.md`, import.meta.url), 'utf8');
  for (const role of ['reviewer', 'auditor']) {
    assert.match(guide(role), /already run the commands in `checks`/);
    assert.match(guide(role), /`checkResults`/);
  }
  assert.match(guide('auditor'), /Say what you could not confirm/);
  assert.match(guide('coder'), /`diff` holds the changes so far/);
});

test('workflow run: the full commands are shown before the approval question, and without approval nothing runs', (t) => {
  const s = setup(t, {}, { policy: { setup: [nodeCheck(writeScript('generated/setup-ran.txt'), { id: 'install', cwd: 'src' })], checks: [nodeCheck(CHECK_SCRIPT, { baseline: 'pass' })] } });
  const runId = planned(s);
  const r = cli(s, ['run', runId, '--path', s.repo]);
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /setup install: .+ -e .+setup-ran\.txt.+ \(in src\)/s);
  assert.match(r.stderr, /check unit, expected to pass at the base commit: .+ -e .+check found src\/broken/s);
  assert.match(r.stderr, /before any AI call, the setup commands run once in the worktree and the checks run once at the base commit/);
  assert.equal(state(s, runId).status, 'PLANNED');
  assert.equal(worktreeCount(s.repo), 1);
  assert.deepEqual(readRun(s.ctx, runId).events.map((e) => e.type), ['run.created']);
  assert.deepEqual(s.keys(), ['planner:plan:1']);
});

test('workflow resume: the notice about the preparation is shown only until the preparation has finished', async (t) => {
  const notice = /before any AI call, the setup commands run once/;
  const done = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } }, auditor: { exit: 1 } });
  const doneId = planned(done);
  assert.equal(await cmdRun(done.ctx, done.flags, doneId, { confirm: CONFIRM, retryDelayMs: 0 }), 3);
  const afterPreparation = cli(done, ['resume', doneId, '--path', done.repo]);
  assert.equal(afterPreparation.code, 3, afterPreparation.stderr);
  assert.match(afterPreparation.stderr, /check unit, expected to pass at the base commit: /);
  assert.doesNotMatch(afterPreparation.stderr, notice);
  const stopped = setup(t, {}, { policy: { checks: [nodeCheck('process.exit(1);')] } });
  const stoppedId = planned(stopped);
  assert.equal(await cmdRun(stopped.ctx, stopped.flags, stoppedId, { confirm: CONFIRM }), 3);
  const beforeFinish = cli(stopped, ['resume', stoppedId, '--path', stopped.repo]);
  assert.equal(beforeFinish.code, 3, beforeFinish.stderr);
  assert.match(beforeFinish.stderr, notice);
});

test('workflow report: result hashes that differ or are missing are not shown as matching', (t) => {
  const s = setup(t, { 'coder:impl': { write: { 'src/new.txt': 'new\n' } } });
  const runId = planned(s);
  assert.equal(runCli(s, runId).code, 0);
  const run = readRun(s.ctx, runId);
  assert.equal(reportView(run).verdict.matched, true);
  for (const type of ['checks.sealed', 'call.baseline', 'run.outcome']) {
    const events = run.events.map((e) => (e.type === type ? { ...e, data: { ...e.data, patchSha256: 'other' } } : e));
    const view = reportView({ ...run, events });
    assert.equal(view.verdict.matched, false, type);
    assert.match(formatReport(view), /result hashes DIFFER: /, type);
  }
  const noSeal = reportView({ ...run, events: run.events.filter((e) => e.type !== 'checks.sealed') });
  assert.equal(noSeal.verdict.sealed, null);
  assert.equal(noSeal.verdict.matched, false);
  const noHash = reportView({ ...run, events: run.events.filter((e) => !['checks.sealed', 'call.baseline', 'run.outcome'].includes(e.type)) });
  assert.equal(noHash.verdict.matched, false);
});
