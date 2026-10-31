import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../formats/jsonc.js';
import { sha256 } from '../util/fsx.js';
import { error, info, printable, warn } from '../util/log.js';
import { runWorkflow, wasInterrupted } from './engine.js';
import { findLeftovers, TREE_KILL_SUPPORTED } from './process.js';
import { commandVersion, createProvider, providerProblem } from './provider.js';
import { formatReport, reportView } from './report.js';
import { hashJson, normalizePolicy, validatePlan } from './schema.js';
import { acquireRun, cancelRequested, commitRun, createRun, policySecretIssues, readArtifact, readRun, readRunOwner, releaseRun, requestCancel, sanitizeEventData, writeArtifact } from './store.js';
import { checkCommandProblem, runChecks } from './verify.js';
import { checkChanges, compareFingerprints, createWorktree, describeWorktree, inspectRepository, removeWorktree, resultPatch, sourceFingerprint, worktreePath } from './workspace.js';

const READ_ONLY_ROLES = ['reviewer', 'auditor'];
const ENDED_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
const EXIT_BY_STATUS = { SUCCEEDED: 0, FAILED: 1, CANCELLED: 130 };
const EXIT_WAITING = 3;
const EXIT_CANCELLED = 130;
const MAX_DIFF_CHARS = 512 * 1024;
const MAX_LOG_CHARS = 64 * 1024;
const MAX_LISTED = 20;
const MAX_CHANGED_FILES = 200;
const STDERR_LINES_SHOWN = 5;
const CANCEL_POLL_MS = 500;
const CANCEL_WAIT_MS = 30000;
const CANCEL_WAIT_POLL_MS = 100;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function invalid(message, issues = []) {
  const lines = issues.map((i) => `\n  - ${i.where}: ${i.msg}`).join('');
  return Object.assign(new Error(`${message}${lines}`), { code: 'E_WORKFLOW_INVALID' });
}

function plannerError(message) {
  return Object.assign(new Error(message), { code: 'E_WORKFLOW_PLANNER' });
}

function readInputFile(file, flag) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw invalid(`cannot read ${flag} ${file}: ${err.code || err.message}`);
  }
}

function readPolicy(file) {
  const text = readInputFile(file, '--config');
  let raw;
  try {
    raw = parseJsonc(text, file);
  } catch (err) {
    throw invalid(`--config ${file} is not valid JSONC: ${err.message}`);
  }
  const { policy, issues } = normalizePolicy(raw);
  if (!policy) {
    throw invalid(`the workflow policy ${file} is invalid`, issues);
  }
  const secrets = policySecretIssues(policy);
  if (secrets.length > 0) {
    throw invalid(`the workflow policy ${file} holds a secret`, secrets);
  }
  return { raw, policy };
}

function repository(flags) {
  return inspectRepository(path.resolve(typeof flags.path === 'string' ? flags.path : '.'));
}

function assertClean(repo) {
  if (repo.uncommitted.length > 0) {
    const listed = repo.uncommitted.slice(0, MAX_LISTED).map((c) => `\n  ${c.status} ${c.path}`).join('');
    const more = repo.uncommitted.length > MAX_LISTED ? `\n  and ${repo.uncommitted.length - MAX_LISTED} more` : '';
    throw invalid(`${repo.root} has uncommitted changes, which a workflow would not see; commit or stash them first:${listed}${more}`);
  }
}

function assertCommandsStart(policy) {
  const problem = providerProblem(policy) || checkCommandProblem(policy.checks);
  if (problem) {
    throw invalid(problem);
  }
}

function commandLine(command, args) {
  return [command, ...args].join(' ');
}

function progress(flags, message) {
  if (!flags.quiet && !flags.q) {
    process.stderr.write(`${printable(message)}\n`);
  }
}

function abortOnSignals(outer) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  if (outer) {
    if (outer.aborted) {
      abort();
    } else {
      outer.addEventListener('abort', abort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cancel: abort,
    dispose() {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
      if (outer) {
        outer.removeEventListener('abort', abort);
      }
    },
  };
}

function watchCancelRequest(handle, cancel) {
  const timer = setInterval(() => {
    if (!cancelRequested(handle)) {
      return;
    }
    clearInterval(timer);
    try {
      commitRun(handle, 'cancel.requested');
    } catch (err) {
      warn(`the cancel request could not be recorded: ${err.message}`);
    }
    cancel();
  }, CANCEL_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function processTracker(handle) {
  return {
    starting(what) {
      commitRun(handle, 'process.starting', what);
    },
    started(what, { pid, pgid, startTime }) {
      commitRun(handle, 'process.started', { ...what, pid, pgid, startTime });
    },
    ended(what, result) {
      commitRun(handle, 'process.ended', {
        ...what,
        pid: result && result.owner ? result.owner.pid : null,
        confirmed: !result || !result.started || result.tree.confirmed,
        remaining: result ? result.tree.remaining.length : 0,
      });
    },
  };
}

function checkRealProcesses(records) {
  return TREE_KILL_SUPPORTED ? { confirmed: true, leftovers: findLeftovers(records) } : { confirmed: false, leftovers: [] };
}

function warnFailure(kind, request, result) {
  const shown = result.stderr.tail.trim().split('\n').slice(-STDERR_LINES_SHOWN).map((line) => printable(sanitizeEventData(line))).join('\n  ');
  warn(`the ${request.role} call: ${kind}${shown === '' ? '' : `\n  ${shown}`}`);
}

async function callWithRetries(provider, request, limits, count) {
  for (let retry = 0; ; retry += 1) {
    if (count.calls >= limits.maxAgentCalls) {
      throw plannerError(`maxAgentCalls (${limits.maxAgentCalls}) was reached while planning`);
    }
    count.calls += 1;
    try {
      return await provider.call(request);
    } catch (err) {
      if (!err.transport || retry >= limits.maxTransportRetries) {
        throw err;
      }
    }
  }
}

async function planSteps(provider, policy, goal, count) {
  const shared = {
    role: 'planner',
    stepId: 'plan',
    goal,
    allowedWritePaths: policy.allowedWritePaths,
    protectedPaths: policy.protectedPaths,
    checks: policy.checks.map(({ id, command, args }) => ({ id, command, args })),
    requiredChecks: policy.requiredChecks,
    maxSteps: policy.limits.maxSteps,
  };
  let issues = [];
  let previousAnswer = null;
  for (let planRepairs = 0; ; planRepairs += 1) {
    const plan = await callWithRetries(provider, { ...shared, attempt: planRepairs + 1, issues, previousAnswer }, policy.limits, count);
    issues = validatePlan(plan, policy, { usedAgentCalls: count.calls });
    if (issues.length === 0) {
      return { plan, planRepairs };
    }
    if (planRepairs >= policy.limits.maxPlanRepairs) {
      const lines = issues.map((i) => `\n  - ${i.where}: ${i.msg}`).join('');
      throw plannerError(`the planner did not return a valid plan:${lines}`);
    }
    previousAnswer = plan === undefined ? null : plan;
  }
}

async function planInTemporaryWorktree(ctx, repo, policy, goal, { signal, retryDelayMs }) {
  const worktree = createWorktree(ctx, crypto.randomUUID(), { root: repo.root, baseCommit: repo.baseCommit });
  try {
    const before = sourceFingerprint(repo.root, { ownWorktree: worktree.name });
    const provider = createProvider({ policy, cwd: worktree.path, signal, retryDelayMs, onDiagnostic: warnFailure });
    const count = { calls: 0 };
    const planned = await planSteps(provider, policy, goal, count);
    const changed = compareFingerprints(before, sourceFingerprint(repo.root, { ownWorktree: worktree.name }));
    if (changed.length > 0) {
      throw plannerError(`the source repository changed while planning, so no run was created: ${changed.slice(0, MAX_LISTED).join(', ')}`);
    }
    return { ...planned, usedAgentCalls: count.calls };
  } finally {
    try {
      removeWorktree(repo.root, worktree.path);
    } catch (err) {
      warn(`the temporary worktree ${worktree.path} could not be removed: ${err.message}`);
    }
  }
}

export async function cmdPlan(ctx, flags, { confirm, signal = null, retryDelayMs } = {}) {
  const goal = readInputFile(flags['goal-file'], '--goal-file').trim();
  if (goal === '') {
    throw invalid(`--goal-file ${flags['goal-file']} is empty`);
  }
  const { raw, policy } = readPolicy(flags.config);
  const repo = repository(flags);
  assertClean(repo);
  assertCommandsStart(policy);
  progress(flags, `planner command: ${commandLine(policy.provider.command, policy.provider.roleArgs.planner || policy.provider.args)}`);
  progress(flags, `repository: ${repo.root} at ${repo.baseCommit}`);
  if (!(await confirm(`This calls an external AI CLI, at most ${policy.limits.maxAgentCalls} times. Continue?`, flags))) {
    return EXIT_WAITING;
  }
  const providerFingerprint = await commandVersion(policy);
  const abort = abortOnSignals(signal);
  let planned;
  try {
    planned = await planInTemporaryWorktree(ctx, repo, policy, goal, { signal: abort.signal, retryDelayMs });
  } catch (err) {
    if (err.cancelRequested) {
      if (err.cancelled) {
        progress(flags, 'planning was cancelled');
      } else {
        warn(err.message);
      }
      return EXIT_CANCELLED;
    }
    if (err.transport || err.timeout) {
      error(`the planner failed: ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    abort.dispose();
  }
  const run = createRun(ctx, {
    plan: planned.plan,
    policy: raw,
    usedAgentCalls: planned.usedAgentCalls,
    planRepairs: planned.planRepairs,
    baseCommit: repo.baseCommit,
    providerFingerprint,
    workspaceKey: repo.workspaceKey,
  });
  const steps = planned.plan.steps.map((s) => s.id);
  const view = { runId: run.runId, planHash: run.planHash, baseCommit: repo.baseCommit, steps, usedAgentCalls: planned.usedAgentCalls, planRepairs: planned.planRepairs };
  info(flags.json ? JSON.stringify(view, null, 2) : `run ${run.runId} planned with ${steps.length} step(s): ${steps.join(', ')}\nnext: agent-layers workflow run ${run.runId}`);
  return 0;
}

function assertRunnable(stored, repo, resume) {
  const { status, workspaceKey } = stored.state;
  if (repo.workspaceKey !== workspaceKey) {
    throw invalid(`run ${stored.runId} belongs to another repository; run this inside that repository or pass --path`);
  }
  if (!resume && status !== 'PLANNED') {
    throw invalid(`run ${stored.runId} is ${status}; only a PLANNED run can start. Use workflow resume or make a new plan`);
  }
  if (resume && status === 'PLANNED') {
    throw invalid(`run ${stored.runId} has not started; use workflow run`);
  }
  if (resume && ENDED_STATUSES.includes(status)) {
    throw invalid(`run ${stored.runId} already ended as ${status}; make a new plan`);
  }
  if (!resume) {
    assertClean(repo);
  }
  assertCommandsStart(stored.policy);
}

function describeRun(flags, stored, repo) {
  const { provider, allowedWritePaths, protectedPaths, checks, limits } = stored.policy;
  progress(flags, [
    `run ${stored.runId}, plan ${stored.plan.planHash}`,
    `  repository: ${repo.root}, base commit ${stored.plan.baseCommit}`,
    `  command: ${commandLine(provider.command, provider.args)}`,
    ...Object.entries(provider.roleArgs).map(([role, args]) => `  command for ${role}: ${commandLine(provider.command, args)}`),
    `  steps: ${stored.plan.steps.map((s) => s.id).join(', ')}`,
    `  write paths: ${allowedWritePaths.join(', ')}; protected: ${protectedPaths.join(', ')}`,
    `  checks: ${checks.map((c) => c.id).join(', ')}`,
    `  limits: ${limits.maxAgentCalls} agent calls, ${limits.runTimeoutSeconds}s of active time`,
  ].join('\n'));
  if (repo.baseCommit !== stored.plan.baseCommit) {
    warn(`HEAD is ${repo.baseCommit}, but this plan was made at ${stored.plan.baseCommit}; the result patch may not apply to HEAD`);
  }
}

function openWorkspace(ctx, handle, run, repo) {
  const created = run.events.find((e) => e.type === 'workspace.created');
  if (created) {
    const dir = worktreePath(ctx, run.runId);
    if (!fs.existsSync(dir)) {
      throw Object.assign(new Error(`the worktree of run ${run.runId} no longer exists at ${dir}; make a new plan`), { code: 'E_WORKFLOW_WORKSPACE' });
    }
    return { ...readArtifact(handle, created.data.artifact), path: fs.realpathSync.native(dir) };
  }
  const worktree = createWorktree(ctx, run.runId, { root: repo.root, baseCommit: run.plan.baseCommit });
  const artifact = writeArtifact(handle, 'workspace', { name: worktree.name, baseCommit: worktree.baseCommit, gitFileHash: worktree.gitFileHash });
  commitRun(handle, 'workspace.created', { artifact: artifact.name, path: worktree.path, treeKillSupported: TREE_KILL_SUPPORTED });
  return worktree;
}

function scopeCheck(worktree, writePaths, protectedPaths) {
  const { changes, violations } = checkChanges(worktree.path, { baseCommit: worktree.baseCommit, gitFileHash: worktree.gitFileHash, writePaths, protectedPaths });
  const ignored = new Set(changes.filter((c) => c.ignored).map((c) => c.path));
  return {
    changed: changes.filter((c) => !c.ignored).map((c) => c.path),
    violations: violations.filter((v) => !(v.reason === 'outside-write-paths' && ignored.has(v.path))),
  };
}

function writePathsUpTo(run, stepId) {
  const stepById = new Map(run.plan.steps.map((s) => [s.id, s]));
  const work = run.state.order.filter((id) => stepById.has(id));
  const at = work.indexOf(stepId);
  return [...new Set((at < 0 ? work : work.slice(0, at + 1)).flatMap((id) => stepById.get(id).writePaths))];
}

function violationError(handle, req, violations) {
  const artifact = writeArtifact(handle, `violations-${handle.state.lastSeq}`, { role: req.role, stepId: req.stepId, attempt: req.attempt, violations });
  const listed = violations.slice(0, 5).map((v) => (v.path ? `${v.path} (${v.reason})` : v.reason)).join(', ');
  return Object.assign(new Error(`the ${req.role} call broke the policy: ${listed}; see artifacts/${artifact.name}`), { stop: { status: 'FAILED', reason: 'policy-violation' } });
}

function unsettledProcesses(events) {
  const open = new Map();
  let unrecorded = false;
  for (const { type, data } of events) {
    if (type === 'process.starting') {
      unrecorded = true;
    } else if (type === 'process.started') {
      unrecorded = false;
      open.set(data.pid, data);
    } else if (type === 'process.ended') {
      unrecorded = false;
      if (data.confirmed) {
        open.delete(data.pid);
      }
    } else if (type === 'run.resumed' && data.recovery) {
      open.clear();
    }
  }
  return { unrecorded, open: [...open.values()] };
}

function readOnlyCallChanged(events, worktree) {
  const from = events.findLastIndex((e) => e.type === 'call.started');
  if (from < 0 || !READ_ONLY_ROLES.includes(events[from].data.role)) {
    return false;
  }
  const after = events.slice(from + 1);
  const before = after.find((e) => e.type === 'call.baseline');
  if (!before || after.some((e) => e.type === 'call.finished' || e.type === 'call.failed')) {
    return false;
  }
  return sha256(resultPatch(worktree.path, worktree.baseCommit)) !== before.data.patchSha256;
}

function inspectInterruption(handle, run, worktree, checkProcesses) {
  const blocked = (reason, message) => ({ passed: false, status: 'BLOCKED', reason, message });
  const { unrecorded, open } = unsettledProcesses(run.events);
  if (unrecorded || !run.events.some((e) => e.type === 'source.baseline')) {
    return blocked('process-unconfirmed', 'the records of this run do not show which processes it started, so their end cannot be confirmed; make a new plan');
  }
  const found = open.length > 0 ? checkProcesses(open) : { confirmed: true, leftovers: [] };
  if (!found.confirmed) {
    return blocked('process-unconfirmed', 'this system cannot confirm that the processes of the interrupted run have ended; make a new plan');
  }
  if (found.leftovers.length > 0) {
    return blocked('process-left', `processes of the interrupted run are still alive (pid ${found.leftovers.map((p) => p.pid).join(', ')}); end them, then run workflow resume again`);
  }
  const lastCall = run.events.findLast((e) => e.type === 'call.started');
  const req = lastCall ? lastCall.data : { role: 'last', stepId: null, attempt: null };
  const lastStep = [...run.state.order].reverse().find((id) => run.state.steps[id].attempts > 0);
  const { changed, violations } = scopeCheck(worktree, writePathsUpTo(run, lastStep), run.policy.protectedPaths);
  const broken = readOnlyCallChanged(run.events, worktree) ? [...violations, { reason: 'read-only-role-changed-files' }] : violations;
  if (broken.length > 0) {
    const { message, stop } = violationError(handle, req, broken);
    return { passed: false, ...stop, message };
  }
  const changedFiles = changed.slice(0, MAX_CHANGED_FILES);
  const artifact = writeArtifact(handle, `recovery-${handle.state.lastSeq}`, { processes: open.map(({ pid, pgid, startTime }) => ({ pid, pgid, startTime })), changedFiles });
  return { passed: true, artifact: artifact.name, changedFiles };
}

function guardedProvider({ provider, worktree, run, handle, logs, flags }) {
  const shared = { baseCommit: worktree.baseCommit, protectedPaths: run.policy.protectedPaths };
  const checks = run.policy.checks.map(({ id, command, args }) => ({ id, command, args }));

  async function callReadOnly(req) {
    const before = resultPatch(worktree.path, worktree.baseCommit);
    const diff = before.toString('utf8');
    const changed = () => sha256(resultPatch(worktree.path, worktree.baseCommit)) !== sha256(before);
    const stopIfChanged = () => {
      if (changed()) {
        throw violationError(handle, req, [{ reason: 'read-only-role-changed-files' }]);
      }
    };
    commitRun(handle, 'call.baseline', { role: req.role, stepId: req.stepId, attempt: req.attempt, patchSha256: sha256(before) });
    let result;
    try {
      result = await provider.call({ ...req, ...shared, allowedWritePaths: writePathsUpTo(run, req.stepId), diff: diff.slice(0, MAX_DIFF_CHARS), diffTruncated: diff.length > MAX_DIFF_CHARS });
    } catch (err) {
      if (err.transport) {
        stopIfChanged();
      }
      throw err;
    }
    stopIfChanged();
    return result;
  }

  async function callCoder(req) {
    const checkLogs = req.feedback && req.feedback.failures ? [...logs.values()] : [];
    const result = await provider.call({ ...req, ...shared, checks, checkLogs });
    const { violations } = scopeCheck(worktree, writePathsUpTo(run, req.stepId), run.policy.protectedPaths);
    if (violations.length > 0) {
      throw violationError(handle, req, violations);
    }
    return result;
  }

  return {
    call({ statusId, ...req }) {
      progress(flags, `${req.role} ${req.stepId}, attempt ${req.attempt}`);
      return READ_ONLY_ROLES.includes(req.role) ? callReadOnly(req) : callCoder(req);
    },
  };
}

function createVerifier({ handle, worktree, run, logs, signal, flags, track }) {
  return {
    async run({ stepId, checkIds }) {
      progress(flags, `checks for ${stepId}: ${checkIds.join(', ')}`);
      const results = await runChecks({ checks: run.policy.checks, checkIds, worktree: worktree.path, signal, track, stepId });
      writeArtifact(handle, `checks-${handle.state.lastSeq}-${stepId.replaceAll('.', '_')}`, { stepId, results });
      logs.clear();
      for (const r of results) {
        if (r.exitCode !== 0) {
          logs.set(r.id, r);
        }
      }
      return results.map(({ id, exitCode }) => ({ id, exitCode, failedTests: [] }));
    },
  };
}

function outputLines(output) {
  return output.tail.slice(-MAX_LOG_CHARS).split('\n');
}

function recordDiagnostic(handle) {
  return (kind, request, result) => {
    warnFailure(kind, request, result);
    writeArtifact(handle, `call-${kind}-${handle.state.lastSeq}`, {
      kind,
      role: request.role,
      stepId: request.stepId,
      attempt: request.attempt,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: outputLines(result.stdout),
      stderr: outputLines(result.stderr),
    });
  };
}

function startDigestOf(handle, run, fingerprint) {
  const stored = run.events.find((e) => e.type === 'source.baseline');
  if (stored) {
    return stored.data.digest;
  }
  if (run.state.status !== 'PLANNED') {
    return null;
  }
  const digest = hashJson(fingerprint);
  commitRun(handle, 'source.baseline', { digest });
  return digest;
}

function recordOutcome(handle, worktree, baseline, startDigest, repo) {
  const patch = resultPatch(worktree.path, worktree.baseCommit);
  const artifact = writeArtifact(handle, `result-patch-${handle.state.lastSeq}`, { baseCommit: worktree.baseCommit, lines: patch.toString('utf8').split('\n') });
  const current = sourceFingerprint(repo.root, { ownWorktree: worktree.name });
  const sourceChanges = compareFingerprints(baseline, current);
  const sourceChangedSinceStart = startDigest === null ? null : hashJson(current) !== startDigest;
  commitRun(handle, 'run.outcome', { patch: artifact.name, patchBytes: patch.length, patchSha256: sha256(patch), worktreeBytes: describeWorktree(worktree.path).bytes, sourceChanges, sourceChangedSinceStart });
  if (sourceChanges.length > 0) {
    warn(`the source repository changed during this run: ${sourceChanges.slice(0, MAX_LISTED).join(', ')}`);
  } else if (sourceChangedSinceStart) {
    warn('the source repository changed since this run started');
  }
}

export async function cmdRun(ctx, flags, runId, { confirm, resume = false, signal = null, retryDelayMs, checkProcesses = checkRealProcesses } = {}) {
  const stored = readRun(ctx, runId);
  const repo = repository(flags);
  assertRunnable(stored, repo, resume);
  describeRun(flags, stored, repo);
  if (!(await confirm(`${resume ? 'Resume' : 'Start'} this run?`, flags))) {
    return EXIT_WAITING;
  }
  const handle = acquireRun(ctx, runId);
  const abort = abortOnSignals(signal);
  const stopWatching = watchCancelRequest(handle, abort.cancel);
  let failure = null;
  let started = false;
  let worktree = null;
  let baseline = null;
  let startDigest = null;
  try {
    const run = readRun(ctx, runId);
    if (run.issues.length > 0) {
      throw Object.assign(new Error(`run ${runId} has damaged records: ${run.issues.join('; ')}`), { code: 'E_WORKFLOW_CORRUPT' });
    }
    worktree = openWorkspace(ctx, handle, run, repo);
    baseline = sourceFingerprint(repo.root, { ownWorktree: worktree.name });
    startDigest = startDigestOf(handle, run, baseline);
    const recovery = resume && wasInterrupted(run.state) ? inspectInterruption(handle, run, worktree, checkProcesses) : null;
    if (recovery && !recovery.passed) {
      warn(recovery.message);
    }
    const logs = new Map();
    const track = processTracker(handle);
    const provider = createProvider({ policy: run.policy, cwd: worktree.path, signal: abort.signal, retryDelayMs, onDiagnostic: recordDiagnostic(handle), track });
    started = true;
    await runWorkflow(handle, {
      provider: guardedProvider({ provider, worktree, run, handle, logs, flags }),
      verifier: createVerifier({ handle, worktree, run, logs, signal: abort.signal, flags, track }),
      resume,
      recovery,
    });
  } catch (err) {
    failure = err;
  } finally {
    stopWatching();
    abort.dispose();
  }
  if (baseline !== null) {
    try {
      recordOutcome(handle, worktree, baseline, startDigest, repo);
    } catch (err) {
      warn(`the run outcome could not be recorded: ${err.message}`);
    }
  }
  const { status } = handle.state;
  releaseRun(handle);
  if (failure && !started) {
    throw failure;
  }
  if (failure && !failure.cancelled) {
    error(`the run stopped: ${failure.message}`);
  }
  const view = reportView(readRun(ctx, runId));
  info(flags.json ? JSON.stringify(view, null, 2) : formatReport(view));
  return Object.prototype.hasOwnProperty.call(EXIT_BY_STATUS, status) ? EXIT_BY_STATUS[status] : EXIT_WAITING;
}

function showCancel(flags, runId, status, message, extra = {}) {
  info(flags.json ? JSON.stringify({ runId, status, message, ...extra }, null, 2) : message);
}

async function waitForOwner(ctx, runId, owner, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    const now = readRunOwner(ctx, runId);
    if (now.status === 'gone' || now.owner === null || now.owner.ownerId !== owner.ownerId) {
      return now.status;
    }
    if (Date.now() >= until) {
      return 'timeout';
    }
    await delay(CANCEL_WAIT_POLL_MS);
  }
}

function cancelOutcome(ctx, flags, runId) {
  const { state, events } = readRun(ctx, runId);
  const { status } = state;
  if (status === 'CANCELLED') {
    showCancel(flags, runId, status, `run ${runId} was cancelled`);
    return EXIT_CANCELLED;
  }
  if (status === 'SUCCEEDED' || status === 'FAILED') {
    showCancel(flags, runId, status, `run ${runId} ended as ${status} before the cancel took effect`);
    return 2;
  }
  if (status === 'INTERRUPTED') {
    const stopped = events.findLast((e) => e.type === 'run.interrupted');
    showCancel(flags, runId, status, `run ${runId} stopped as INTERRUPTED${stopped ? `: ${stopped.data.error}` : ''}`);
    return EXIT_WAITING;
  }
  showCancel(flags, runId, status, `run ${runId} is ${status}`);
  return EXIT_WAITING;
}

function recoverAbandoned(ctx, flags, runId, checkProcesses) {
  const handle = acquireRun(ctx, runId);
  let status;
  let found = { confirmed: true, leftovers: [] };
  try {
    const { open } = unsettledProcesses(readRun(ctx, runId).events);
    if (open.length > 0) {
      found = checkProcesses(open);
    }
    status = handle.state.status;
  } finally {
    releaseRun(handle);
  }
  const left = found.leftovers.map((p) => p.pid);
  let next = 'use workflow resume, which checks what it left';
  if (left.length > 0) {
    next = `these processes are still alive and are not ended by this command: pid ${left.join(', ')}. End them, then use workflow resume`;
  } else if (!found.confirmed) {
    next = 'this system cannot confirm that its processes have ended';
  }
  showCancel(flags, runId, status, `the process that ran ${runId} is gone, so the run is ${status}; ${next}`, { leftovers: left, processesConfirmed: found.confirmed });
  return EXIT_WAITING;
}

export async function cmdCancel(ctx, flags, runId, { waitMs = CANCEL_WAIT_MS, checkProcesses = checkRealProcesses } = {}) {
  readRun(ctx, runId);
  const first = readRunOwner(ctx, runId);
  if (first.status === 'unreadable') {
    throw Object.assign(new Error(`the lock of run ${runId} is unreadable; make sure no workflow is running, then remove it by hand`), { code: 'E_WORKFLOW_LOCKED' });
  }
  if (first.status === 'alive' || first.status === 'elsewhere') {
    requestCancel(ctx, runId, first.owner);
    progress(flags, `asked pid ${first.owner.pid} on ${first.owner.hostname} to cancel run ${runId}`);
    const waited = await waitForOwner(ctx, runId, first.owner, waitMs);
    if (waited === 'timeout') {
      showCancel(flags, runId, readRun(ctx, runId).state.status, `pid ${first.owner.pid} has not ended run ${runId} after ${Math.round(waitMs / 1000)}s; the request stays in place, so check workflow status`);
      return EXIT_WAITING;
    }
    if (waited !== 'gone' || readRun(ctx, runId).state.status !== 'RUNNING') {
      return cancelOutcome(ctx, flags, runId);
    }
  }
  const { status } = readRun(ctx, runId).state;
  if (status === 'RUNNING') {
    return recoverAbandoned(ctx, flags, runId, checkProcesses);
  }
  if (status === 'PLANNED') {
    throw invalid(`run ${runId} has not started, so there is nothing to cancel`);
  }
  if (ENDED_STATUSES.includes(status)) {
    throw invalid(`run ${runId} already ended as ${status}`);
  }
  showCancel(flags, runId, status, `run ${runId} is ${status} and nothing is running; use workflow resume or make a new plan`);
  return EXIT_WAITING;
}
