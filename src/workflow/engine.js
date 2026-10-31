import crypto from 'node:crypto';
import { validateRoleResult, pathCovers, RESULT_STATUSES } from './schema.js';
import { downstreamOf, REVIEW_STEP_ID, AUDIT_STEP_ID } from './graph.js';
import {
  readRun, commitRun, writeArtifact, readArtifact, chargeAgentCall, addActiveSeconds, addRepairAttempt,
  recordFailure, clearFailure, remainingBudget, sanitizeEventData, REVIEW_FIX_TARGET,
} from './store.js';

const TERMINAL_RUN_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
const ROLE_RESULT_STATUSES = {
  coder: ['completed', 'blocked'],
  reviewer: ['completed', 'needs_changes', 'blocked'],
  auditor: ['completed', 'needs_changes', 'blocked'],
};
const REVIEW_ROLES = [[REVIEW_STEP_ID, 'reviewer'], [AUDIT_STEP_ID, 'auditor']];
const ACTIVE_STEP_STATUSES = ['RUNNING', 'VERIFYING'];
const STREAK_KINDS = ['check', 'review'];

export async function runWorkflow(handle, { provider, verifier, clock = Date.now, resume = false } = {}) {
  if (!provider || typeof provider.call !== 'function') {
    throw new Error('runWorkflow: provider.call(request) is required');
  }
  if (!verifier || typeof verifier.run !== 'function') {
    throw new Error('runWorkflow: verifier.run(request) is required');
  }
  const { plan, policy } = readRun(handle.ctx, handle.runId);
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const rt = {
    handle,
    provider,
    verifier,
    clock,
    plan,
    policy,
    limits: policy.limits,
    work: handle.state.order.filter((id) => byId.has(id)).map((id) => byId.get(id)),
    byId,
    nodes: plan.steps.map((s) => ({ id: s.id, dependsOn: s.dependsOn })),
    stepIds: plan.steps.map((s) => s.id),
    index: new Map(handle.state.order.map((id, i) => [id, i])),
    inflight: null,
  };
  try {
    if (TERMINAL_RUN_STATUSES.includes(handle.state.status) || !prepare(rt, resume)) {
      return handle.state;
    }
    for (const step of rt.work) {
      if (!(await runWorkStep(rt, step))) {
        return handle.state;
      }
    }
    if (!rt.handle.state.reviewFix && rt.handle.state.steps[REVIEW_STEP_ID].status !== 'SUCCEEDED' && !(await requiredGate(rt))) {
      return handle.state;
    }
    await reviewCycle(rt);
    return handle.state;
  } catch (err) {
    throw interruptOnError(rt, err);
  }
}

function withCleanupError(err, commitErr) {
  if (err instanceof Error && Object.isExtensible(err)) {
    try {
      err.cleanupErrors = [...(err.cleanupErrors || []), commitErr];
      return err;
    } catch (assignErr) {
      commitErr = new AggregateError([commitErr, assignErr], 'recording the interruption failed');
    }
  }
  const wrapped = new Error(`workflow run stopped by ${err instanceof Error ? err.message : String(err)}; recording the interruption also failed`, { cause: err });
  wrapped.cleanupErrors = [commitErr];
  return wrapped;
}

function interruptOnError(rt, err) {
  if (rt.handle.broken) {
    return err;
  }
  const seconds = rt.inflight === null ? 0 : elapsedSeconds(rt, rt.inflight);
  const status = err && err.cancelled ? 'CANCELLED' : 'INTERRUPTED';
  try {
    commit(rt, `run.${status.toLowerCase()}`, { error: clean(err && err.message ? err.message : err) }, (n) => {
      addActiveSeconds(n, seconds);
      if (n.status === 'RUNNING') {
        n.status = status;
      }
      for (const id of n.order) {
        if (ACTIVE_STEP_STATUSES.includes(n.steps[id].status)) {
          n.steps[id].status = status;
        }
      }
    });
  } catch (commitErr) {
    return withCleanupError(err, commitErr);
  }
  return err;
}

function commit(rt, type, data, mutate = null) {
  return commitRun(rt.handle, type, data, mutate);
}

function clean(text) {
  return sanitizeEventData(String(text));
}

function elapsedSeconds(rt, started) {
  return Math.max(0, (rt.clock() - started) / 1000);
}

function signatureOf(kind, target, parts) {
  return `${kind}|${target}|${crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)}`;
}

function checkSignature(target, failures) {
  return signatureOf('check', target, failures.map((f) => JSON.stringify([f.id, [...f.failedTests].sort()])).sort());
}

function clearFailureOf(n, target) {
  const [kind, owner] = String(n.budget.failureStreak.signature).split('|');
  if (STREAK_KINDS.includes(kind) && owner === target) {
    clearFailure(n);
  }
}

function stopOnTime(rt, id, message) {
  if (ACTIVE_STEP_STATUSES.includes(rt.handle.state.steps[id].status)) {
    return stopStep(rt, id, 'FAILED', 'runTimeoutSeconds', message);
  }
  return stopRun(rt, 'FAILED', 'runTimeoutSeconds', null, { stepId: id });
}

function overrun(rt, id, what) {
  if (remainingBudget(rt.handle.state, rt.limits).activeSeconds >= 0) {
    return false;
  }
  stopOnTime(rt, id, `runTimeoutSeconds passed during ${what}`);
  return true;
}

function limitReached(rt) {
  const rem = remainingBudget(rt.handle.state, rt.limits);
  if (rem.agentCalls < 1) {
    return 'maxAgentCalls';
  }
  if (rem.activeSeconds <= 0) {
    return 'runTimeoutSeconds';
  }
  return null;
}

function stopRun(rt, status, reason, mutate = null, data = {}) {
  commit(rt, `run.${status.toLowerCase()}`, { reason, ...data }, (n) => {
    if (mutate) {
      mutate(n);
    }
    n.status = status;
    n.stopReason = reason;
  });
  return false;
}

function stopStep(rt, id, status, reason, message) {
  return stopRun(rt, status, reason, (n) => {
    n.steps[id].status = status;
    n.steps[id].reason = reason;
    n.steps[id].lastError = clean(message);
  }, { stepId: id });
}

function prepare(rt, resume) {
  const s = rt.handle.state;
  const interrupted = s.order.filter((id) => s.steps[id].status === 'INTERRUPTED');
  if (interrupted.length > 0 || s.status === 'INTERRUPTED') {
    //20261030 TODO W4 checks leftover processes and artifacts before an interrupted step may return to READY
    return stopRun(rt, 'BLOCKED', 'interrupted', (n) => {
      for (const id of interrupted) {
        n.steps[id].status = 'BLOCKED';
        n.steps[id].reason = 'interrupted';
      }
    }, { steps: interrupted });
  }
  if (s.status === 'BLOCKED') {
    const blocked = s.order.filter((id) => s.steps[id].status === 'BLOCKED');
    const retry = blocked.filter((id) => s.steps[id].reason === 'transport');
    if (!resume || retry.length === 0 || retry.length !== blocked.length) {
      return false;
    }
    commit(rt, 'run.resumed', { steps: retry }, (n) => {
      for (const id of retry) {
        n.steps[id].status = 'READY';
        delete n.steps[id].reason;
        delete n.steps[id].lastError;
      }
      n.status = 'RUNNING';
      delete n.stopReason;
    });
    return true;
  }
  if (s.status !== 'RUNNING') {
    commit(rt, 'run.started', {}, (n) => {
      n.status = 'RUNNING';
    });
  }
  return true;
}

function markReady(rt, id) {
  if (rt.handle.state.steps[id].status !== 'READY') {
    commit(rt, 'step.ready', { stepId: id }, (n) => {
      n.steps[id].status = 'READY';
    });
  }
}

function startStep(rt, id) {
  const attempt = rt.handle.state.steps[id].attempts + 1;
  commit(rt, 'step.started', { stepId: id, attempt }, (n) => {
    n.steps[id].status = 'RUNNING';
    n.steps[id].attempts = attempt;
  });
  return attempt;
}

function succeedStep(rt, id) {
  commit(rt, 'step.succeeded', { stepId: id }, (n) => {
    n.steps[id].status = 'SUCCEEDED';
    delete n.steps[id].reason;
    delete n.steps[id].lastError;
    clearFailureOf(n, id);
  });
}

async function callRole(rt, req) {
  for (let retry = 0; ; retry += 1) {
    const limit = limitReached(rt);
    if (limit) {
      return stopStep(rt, req.statusId, 'FAILED', limit, `${limit} reached before the ${req.role} call`);
    }
    const tag = { role: req.role, stepId: req.stepId, attempt: req.attempt, retry };
    commit(rt, 'call.started', tag, (n) => {
      chargeAgentCall(n);
    });
    const started = rt.clock();
    rt.inflight = started;
    let result;
    try {
      result = await rt.provider.call(structuredClone(req));
    } catch (err) {
      if (!err || (!err.transport && !err.timeout && !err.stop)) {
        throw err;
      }
      const seconds = elapsedSeconds(rt, started);
      if (err.stop) {
        commit(rt, 'call.failed', { ...tag, kind: 'stopped', reason: err.stop.reason }, (n) => {
          addActiveSeconds(n, seconds);
        });
        rt.inflight = null;
        return stopStep(rt, req.statusId, err.stop.status, err.stop.reason, err.message);
      }
      if (err.transport) {
        const code = String(err.code || 'unknown');
        let same = false;
        commit(rt, 'call.failed', { ...tag, kind: 'transport', code }, (n) => {
          addActiveSeconds(n, seconds);
          same = recordFailure(n, `transport:${code}`);
        });
        rt.inflight = null;
        if (same || retry >= rt.limits.maxTransportRetries) {
          return stopStep(rt, req.statusId, 'BLOCKED', 'transport', `transport error ${code}`);
        }
        continue;
      }
      commit(rt, 'call.failed', { ...tag, kind: 'timeout' }, (n) => {
        addActiveSeconds(n, seconds);
      });
      rt.inflight = null;
      return stopStep(rt, req.statusId, 'BLOCKED', 'timeout', `the ${req.role} call timed out`);
    }
    const seconds = elapsedSeconds(rt, started);
    commit(rt, 'call.finished', tag, (n) => {
      addActiveSeconds(n, seconds);
      if (String(n.budget.failureStreak.signature).startsWith('transport:')) {
        clearFailure(n);
      }
    });
    rt.inflight = null;
    if (overrun(rt, req.statusId, `the ${req.role} call`)) {
      return false;
    }
    return { result };
  }
}

function resultIssues(rt, req, result) {
  const issues = validateRoleResult(result, { stepIds: rt.stepIds }).map((i) => `${i.where}: ${i.msg}`);
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    if (result.stepId !== req.stepId) {
      issues.push(`stepId: must be ${req.stepId}`);
    }
    if (result.attempt !== req.attempt) {
      issues.push(`attempt: must be ${req.attempt}`);
    }
    if (RESULT_STATUSES.includes(result.status) && !ROLE_RESULT_STATUSES[req.role].includes(result.status)) {
      issues.push(`status: ${req.role} results must be one of ${ROLE_RESULT_STATUSES[req.role].join(', ')}`);
    }
  }
  return issues;
}

function recordResult(rt, req, result) {
  const issues = resultIssues(rt, req, result);
  const name = `${String(rt.index.get(req.statusId)).padStart(2, '0')}-${req.stepId.replaceAll('.', '_')}-${req.attempt}`;
  const artifact = writeArtifact(rt.handle, name, { role: req.role, stepId: req.stepId, attempt: req.attempt, result: result === undefined ? null : result });
  const valid = issues.length === 0;
  commit(rt, 'role.result', {
    role: req.role,
    stepId: req.stepId,
    attempt: req.attempt,
    valid,
    status: valid ? result.status : null,
    artifact: artifact.name,
    sha256: artifact.sha256,
    findings: valid ? result.findings.map((f) => ({ code: f.code, path: f.path === undefined ? null : f.path })) : [],
    issues,
  });
  return { issues, artifact };
}

async function runChecks(rt, statusId, checkIds) {
  const ids = [...new Set(checkIds)];
  if (ids.length === 0) {
    return { failures: [] };
  }
  if (remainingBudget(rt.handle.state, rt.limits).activeSeconds <= 0) {
    return stopOnTime(rt, statusId, 'runTimeoutSeconds reached before the checks');
  }
  const started = rt.clock();
  rt.inflight = started;
  const reported = await rt.verifier.run({ stepId: statusId, checkIds: [...ids] });
  const results = ids.map((id) => {
    const r = Array.isArray(reported) ? reported.find((x) => x && x.id === id) : undefined;
    if (!r || !Number.isSafeInteger(r.exitCode)) {
      throw new Error(`verifier did not report an integer exitCode for check "${id}"`);
    }
    const failedTests = r.failedTests === undefined ? [] : r.failedTests;
    if (!Array.isArray(failedTests) || failedTests.some((n) => typeof n !== 'string')) {
      throw new Error(`verifier reported failedTests for check "${id}" that is not an array of strings`);
    }
    return { id, exitCode: r.exitCode, failedTests };
  });
  const seconds = elapsedSeconds(rt, started);
  commit(rt, 'checks.finished', { stepId: statusId, results }, (n) => {
    addActiveSeconds(n, seconds);
  });
  rt.inflight = null;
  if (overrun(rt, statusId, 'the checks')) {
    return false;
  }
  return { failures: results.filter((r) => r.exitCode !== 0) };
}

function failureText(failures) {
  return failures.map((f) => `check ${f.id} exited ${f.exitCode}${f.failedTests.length > 0 ? ` (${f.failedTests.length} failing tests)` : ''}`).join('; ');
}

async function runWorkStep(rt, step) {
  const id = step.id;
  let feedback = null;
  for (;;) {
    if (rt.handle.state.steps[id].status === 'SUCCEEDED') {
      return true;
    }
    const waiting = step.dependsOn.filter((d) => rt.handle.state.steps[d].status !== 'SUCCEEDED');
    if (waiting.length > 0) {
      throw new Error(`step ${id} was about to start before ${waiting.join(', ')} succeeded`);
    }
    const limit = limitReached(rt);
    if (limit) {
      return stopRun(rt, 'FAILED', limit, null, { stepId: id });
    }
    markReady(rt, id);
    const attempt = startStep(rt, id);
    const req = { role: 'coder', stepId: id, statusId: id, attempt, goal: rt.plan.goal, instruction: step.instruction, acceptance: step.acceptance, writePaths: step.writePaths, feedback };
    const call = await callRole(rt, req);
    if (!call) {
      return false;
    }
    const { issues } = recordResult(rt, req, call.result);
    if (issues.length > 0) {
      return stopStep(rt, id, 'BLOCKED', 'invalid-result', `invalid coder result: ${issues.join('; ')}`);
    }
    if (call.result.status === 'blocked') {
      return stopStep(rt, id, 'BLOCKED', 'role-blocked', `the coder needs input (${call.result.needsInput.length} items)`);
    }
    commit(rt, 'step.verifying', { stepId: id, attempt }, (n) => {
      n.steps[id].status = 'VERIFYING';
    });
    const checks = await runChecks(rt, id, step.checkIds);
    if (!checks) {
      return false;
    }
    if (checks.failures.length === 0) {
      succeedStep(rt, id);
      return true;
    }
    let same = false;
    commit(rt, 'step.check-failed', { stepId: id, attempt, failed: checks.failures.map((f) => f.id) }, (n) => {
      same = recordFailure(n, checkSignature(id, checks.failures));
      n.steps[id].lastError = clean(failureText(checks.failures));
    });
    if (same) {
      return stopStep(rt, id, 'FAILED', 'same-failure', `the same check failure happened 3 times in a row: ${failureText(checks.failures)}`);
    }
    if (remainingBudget(rt.handle.state, rt.limits).repairAttempts(id) <= 0) {
      return stopStep(rt, id, 'FAILED', 'repair-limit', `maxRepairAttempts used up: ${failureText(checks.failures)}`);
    }
    commit(rt, 'step.retry', { stepId: id, attempt }, (n) => {
      addRepairAttempt(n, id);
      n.steps[id].status = 'RETRY_PENDING';
    });
    feedback = { failures: checks.failures };
  }
}

async function requiredGate(rt) {
  const checks = await runChecks(rt, REVIEW_STEP_ID, rt.policy.requiredChecks);
  if (!checks) {
    return false;
  }
  if (checks.failures.length > 0) {
    //20261030 TODO W5 decides how a failing required check is repaired instead of blocking the run
    return stopRun(rt, 'BLOCKED', 'required-checks-failed', null, { failed: checks.failures.map((f) => f.id) });
  }
  return true;
}

async function reviewCycle(rt) {
  for (;;) {
    let restart = false;
    for (const [id, role] of REVIEW_ROLES) {
      if (rt.handle.state.steps[id].status === 'SUCCEEDED') {
        continue;
      }
      const pending = rt.handle.state.reviewFix;
      if (pending && pending.stepId === id) {
        if (!(await resumeReviewFix(rt, pending))) {
          return false;
        }
        restart = true;
        break;
      }
      const limit = limitReached(rt);
      if (limit) {
        return stopRun(rt, 'FAILED', limit, null, { stepId: id });
      }
      markReady(rt, id);
      const attempt = startStep(rt, id);
      const req = { role, stepId: id, statusId: id, attempt, goal: rt.plan.goal, acceptance: rt.work.flatMap((s) => s.acceptance), writePaths: [], feedback: null };
      const call = await callRole(rt, req);
      if (!call) {
        return false;
      }
      const { issues, artifact } = recordResult(rt, req, call.result);
      if (issues.length > 0) {
        return stopStep(rt, id, 'BLOCKED', 'invalid-result', `invalid ${role} result: ${issues.join('; ')}`);
      }
      if (call.result.status === 'blocked') {
        return stopStep(rt, id, 'BLOCKED', 'role-blocked', `the ${role} needs input (${call.result.needsInput.length} items)`);
      }
      if (call.result.status === 'completed') {
        succeedStep(rt, id);
        continue;
      }
      if (!(await reviewFix(rt, id, role, call.result.findings, artifact.name))) {
        return false;
      }
      restart = true;
      break;
    }
    if (!restart) {
      commit(rt, 'run.succeeded', {}, (n) => {
        n.status = 'SUCCEEDED';
        delete n.stopReason;
      });
      return true;
    }
  }
}

function fixStop(rt) {
  if (remainingBudget(rt.handle.state, rt.limits).repairAttempts(REVIEW_FIX_TARGET) <= 0) {
    return { reason: 'repair-limit', message: `maxRepairAttempts for ${REVIEW_FIX_TARGET} used up` };
  }
  const limit = limitReached(rt);
  return limit ? { reason: limit, message: `${limit} reached before ${REVIEW_FIX_TARGET}` } : null;
}

function fixOwners(findings, work) {
  const owners = [];
  for (const f of findings) {
    const own = work.filter((s) => s.writePaths.some((w) => pathCovers(w, f.path)));
    if (own.length === 0) {
      return { outside: f };
    }
    for (const s of own) {
      if (!owners.includes(s.id)) {
        owners.push(s.id);
      }
    }
  }
  return { owners };
}

async function reviewFix(rt, id, role, findings, artifact) {
  const scope = fixOwners(findings, rt.work);
  if (scope.outside) {
    return stopStep(rt, id, 'BLOCKED', 'finding-out-of-scope', `finding ${scope.outside.code} at ${scope.outside.path} is outside every step's writePaths`);
  }
  let stop = null;
  commit(rt, 'review.changes-requested', { stepId: id, role, findings: findings.map((f) => ({ code: f.code, path: f.path })) }, (n) => {
    const same = recordFailure(n, signatureOf('review', id, [role, findings.map((f) => JSON.stringify([f.code, f.path])).sort()]));
    stop = same ? { reason: 'same-failure', message: `the ${role} asked for the same changes 3 times in a row` } : fixStop(rt);
    if (!stop) {
      n.steps[id].status = 'RETRY_PENDING';
      n.reviewFix = { stepId: id, role, artifact, attempt: null };
    }
  });
  return stop ? stopStep(rt, id, 'FAILED', stop.reason, stop.message) : fixLoop(rt, id, role, findings, scope.owners);
}

async function resumeReviewFix(rt, pending) {
  const saved = readArtifact(rt.handle, pending.artifact);
  const findings = saved && saved.result && saved.result.findings;
  if (saved.stepId !== pending.stepId || !Array.isArray(findings)) {
    throw new Error(`artifact ${pending.artifact} does not hold the ${pending.role} findings for ${REVIEW_FIX_TARGET}`);
  }
  const scope = fixOwners(findings, rt.work);
  if (scope.outside) {
    throw new Error(`artifact ${pending.artifact} has a finding outside every step's writePaths`);
  }
  const { events } = readRun(rt.handle.ctx, rt.handle.runId);
  const from = events.findLastIndex((e) => e.type === 'review.changes-requested' && e.data.stepId === pending.stepId);
  if (from < 0) {
    throw new Error(`events.jsonl has no review.changes-requested event for the pending ${REVIEW_FIX_TARGET} of ${pending.stepId}`);
  }
  const lastChecks = events.slice(from + 1).filter((e) => e.type === 'checks.finished' && e.data.stepId === pending.stepId).at(-1);
  const failures = lastChecks ? lastChecks.data.results.filter((r) => r.exitCode !== 0) : [];
  return fixLoop(rt, pending.stepId, pending.role, findings, scope.owners, failures.length > 0 ? { findings, failures } : { findings });
}

async function fixLoop(rt, id, role, findings, owners, firstFeedback = { findings }) {
  const writePaths = [...new Set(owners.flatMap((o) => rt.byId.get(o).writePaths))];
  const affected = downstreamOf(rt.nodes, owners);
  const checkIds = [...new Set([...affected.flatMap((a) => rt.byId.get(a).checkIds), ...rt.policy.requiredChecks])];
  let feedback = firstFeedback;
  for (;;) {
    let attempt = rt.handle.state.reviewFix.attempt;
    if (attempt !== null) {
      commit(rt, 'review-fix.resumed', { stepId: id, attempt }, (n) => {
        n.steps[id].status = 'RUNNING';
      });
    } else {
      markReady(rt, id);
      commit(rt, 'review-fix.started', { stepId: id, steps: owners }, (n) => {
        addRepairAttempt(n, REVIEW_FIX_TARGET);
        attempt = n.budget.repairAttempts[REVIEW_FIX_TARGET];
        n.reviewFix.attempt = attempt;
        n.steps[id].status = 'RUNNING';
      });
    }
    const req = { role: 'coder', stepId: REVIEW_FIX_TARGET, statusId: id, attempt, goal: rt.plan.goal, instruction: `Apply the ${role} findings`, acceptance: rt.work.filter((s) => owners.includes(s.id)).flatMap((s) => s.acceptance), writePaths, feedback };
    const call = await callRole(rt, req);
    if (!call) {
      return false;
    }
    const { issues } = recordResult(rt, req, call.result);
    if (issues.length > 0) {
      return stopStep(rt, id, 'BLOCKED', 'invalid-result', `invalid ${REVIEW_FIX_TARGET} result: ${issues.join('; ')}`);
    }
    if (call.result.status === 'blocked') {
      return stopStep(rt, id, 'BLOCKED', 'role-blocked', `${REVIEW_FIX_TARGET} needs input (${call.result.needsInput.length} items)`);
    }
    commit(rt, 'review-fix.verifying', { stepId: id, attempt }, (n) => {
      n.steps[id].status = 'VERIFYING';
    });
    const checks = await runChecks(rt, id, checkIds);
    if (!checks) {
      return false;
    }
    if (checks.failures.length === 0) {
      commit(rt, 'steps.rechecked', { stepId: id, steps: affected, checkIds }, (n) => {
        for (const [rid] of REVIEW_ROLES) {
          n.steps[rid].status = 'PENDING';
        }
        clearFailureOf(n, REVIEW_FIX_TARGET);
        delete n.reviewFix;
      });
      return true;
    }
    let stop = null;
    commit(rt, 'review-fix.check-failed', { stepId: id, attempt, failed: checks.failures.map((f) => f.id) }, (n) => {
      const same = recordFailure(n, checkSignature(REVIEW_FIX_TARGET, checks.failures));
      stop = same ? { reason: 'same-failure', message: `the same check failure happened 3 times in a row: ${failureText(checks.failures)}` } : fixStop(rt);
      n.steps[id].lastError = clean(failureText(checks.failures));
      n.reviewFix.attempt = null;
      if (!stop) {
        n.steps[id].status = 'RETRY_PENDING';
      }
    });
    if (stop) {
      return stopStep(rt, id, 'FAILED', stop.reason, stop.message);
    }
    feedback = { findings, failures: checks.failures };
  }
}
