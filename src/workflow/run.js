import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../formats/jsonc.js';
import { sha256 } from '../util/fsx.js';
import { error, info, printable, warn } from '../util/log.js';
import { runWorkflow } from './engine.js';
import { TREE_KILL_SUPPORTED } from './process.js';
import { commandVersion, createProvider, providerProblem } from './provider.js';
import { formatReport, reportView } from './report.js';
import { normalizePolicy, validatePlan } from './schema.js';
import { acquireRun, commitRun, createRun, policySecretIssues, readArtifact, readRun, releaseRun, sanitizeEventData, writeArtifact } from './store.js';
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
const STDERR_LINES_SHOWN = 5;

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
    dispose() {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
      if (outer) {
        outer.removeEventListener('abort', abort);
      }
    },
  };
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
    if (err.cancelled) {
      progress(flags, 'planning was cancelled');
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

function scopeViolations(worktree, writePaths, protectedPaths) {
  const { changes, violations } = checkChanges(worktree.path, { baseCommit: worktree.baseCommit, gitFileHash: worktree.gitFileHash, writePaths, protectedPaths });
  const ignored = new Set(changes.filter((c) => c.ignored).map((c) => c.path));
  return violations.filter((v) => !(v.reason === 'outside-write-paths' && ignored.has(v.path)));
}

function violationError(handle, req, violations) {
  const artifact = writeArtifact(handle, `violations-${handle.state.lastSeq}`, { role: req.role, stepId: req.stepId, attempt: req.attempt, violations });
  const listed = violations.slice(0, 5).map((v) => (v.path ? `${v.path} (${v.reason})` : v.reason)).join(', ');
  return Object.assign(new Error(`the ${req.role} call broke the policy: ${listed}; see artifacts/${artifact.name}`), { stop: { status: 'FAILED', reason: 'policy-violation' } });
}

function guardedProvider({ provider, worktree, run, handle, logs, flags }) {
  const stepById = new Map(run.plan.steps.map((s) => [s.id, s]));
  const work = run.state.order.filter((id) => stepById.has(id));
  const writePathsUpTo = (stepId) => {
    const at = work.indexOf(stepId);
    return [...new Set((at < 0 ? work : work.slice(0, at + 1)).flatMap((id) => stepById.get(id).writePaths))];
  };
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
    let result;
    try {
      result = await provider.call({ ...req, ...shared, allowedWritePaths: writePathsUpTo(req.stepId), diff: diff.slice(0, MAX_DIFF_CHARS), diffTruncated: diff.length > MAX_DIFF_CHARS });
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
    const violations = scopeViolations(worktree, writePathsUpTo(req.stepId), run.policy.protectedPaths);
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

function createVerifier({ handle, worktree, run, logs, signal, flags }) {
  return {
    async run({ stepId, checkIds }) {
      progress(flags, `checks for ${stepId}: ${checkIds.join(', ')}`);
      const results = await runChecks({ checks: run.policy.checks, checkIds, worktree: worktree.path, signal });
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

function recordOutcome(handle, worktree, baseline, repo) {
  const patch = resultPatch(worktree.path, worktree.baseCommit);
  const artifact = writeArtifact(handle, `result-patch-${handle.state.lastSeq}`, { baseCommit: worktree.baseCommit, lines: patch.toString('utf8').split('\n') });
  const sourceChanges = compareFingerprints(baseline, sourceFingerprint(repo.root, { ownWorktree: worktree.name }));
  commitRun(handle, 'run.outcome', { patch: artifact.name, patchBytes: patch.length, patchSha256: sha256(patch), worktreeBytes: describeWorktree(worktree.path).bytes, sourceChanges });
  if (sourceChanges.length > 0) {
    warn(`the source repository changed during this run: ${sourceChanges.slice(0, MAX_LISTED).join(', ')}`);
  }
}

export async function cmdRun(ctx, flags, runId, { confirm, resume = false, signal = null, retryDelayMs } = {}) {
  const stored = readRun(ctx, runId);
  const repo = repository(flags);
  assertRunnable(stored, repo, resume);
  describeRun(flags, stored, repo);
  if (!(await confirm(`${resume ? 'Resume' : 'Start'} this run?`, flags))) {
    return EXIT_WAITING;
  }
  const handle = acquireRun(ctx, runId);
  const abort = abortOnSignals(signal);
  let failure = null;
  let started = false;
  let worktree = null;
  let baseline = null;
  try {
    const run = readRun(ctx, runId);
    if (run.issues.length > 0) {
      throw Object.assign(new Error(`run ${runId} has damaged records: ${run.issues.join('; ')}`), { code: 'E_WORKFLOW_CORRUPT' });
    }
    worktree = openWorkspace(ctx, handle, run, repo);
    baseline = sourceFingerprint(repo.root, { ownWorktree: worktree.name });
    const logs = new Map();
    const provider = createProvider({ policy: run.policy, cwd: worktree.path, signal: abort.signal, retryDelayMs, onDiagnostic: recordDiagnostic(handle) });
    started = true;
    await runWorkflow(handle, {
      provider: guardedProvider({ provider, worktree, run, handle, logs, flags }),
      verifier: createVerifier({ handle, worktree, run, logs, signal: abort.signal, flags }),
      resume,
    });
  } catch (err) {
    failure = err;
  } finally {
    abort.dispose();
  }
  if (baseline !== null) {
    try {
      recordOutcome(handle, worktree, baseline, repo);
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
