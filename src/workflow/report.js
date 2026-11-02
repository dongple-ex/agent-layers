import { remainingBudget } from './store.js';

const NOT_GUARANTEED = [
  'isolation: sandboxing is left to the AI CLI and the policy, and setup commands and checks run with your permissions',
  'write scope: checked after each call, not blocked; paths of earlier steps and files git ignores are not counted',
  'processes: one that left its session is not found when a run ends, is cancelled or is resumed',
  'AI CLI settings: changes a CLI makes to its own global settings are not cleaned up',
  'model and usage: not recorded; only calls and active time are counted',
  'result patch: a record with secret-looking lines masked; take the change from the worktree',
];
const NEW_PLAN_NOTE = 'The worktree stays at the base commit, so a fix committed to the repository needs a new plan';
const NEW_PLAN_ONLY_NOTE = 'workflow resume does not continue this run, so make a new plan. It starts from the repository HEAD, not from this worktree, so first see what this run left there';
const STOP_HINTS = {
  'role-blocked': `an AI role needs an answer; see result.needsInput in its file in the artifacts list, and put the answer in the goal. ${NEW_PLAN_ONLY_NOTE}`,
  timeout: `an AI CLI call ran past limits.stepTimeoutSeconds; raise that limit in the policy or make the step smaller in the goal. ${NEW_PLAN_ONLY_NOTE}`,
  'invalid-result': `the AI CLI did not give a valid role result; see the step's last error and any artifacts/call-unreadable-* in the run folder, then check the command and its output format in the policy. ${NEW_PLAN_ONLY_NOTE}`,
  'finding-out-of-scope': `a finding names a path outside every step's writePaths, and a run does not widen its own scope; the path is in the step's last error. If that path belongs to this work, add it to allowedWritePaths in the policy and to the goal. ${NEW_PLAN_ONLY_NOTE}`,
  'setup-failed': `a setup command failed; see artifacts/setup-* in the run folder, fix the environment, then run workflow resume. ${NEW_PLAN_NOTE}`,
  'preflight-changed-files': `the setup commands or the checks changed files git does not ignore; clean the worktree or ignore those files, then run workflow resume. ${NEW_PLAN_NOTE}`,
  'baseline-failed': `a check failed at the base commit; see artifacts/baseline-* in the run folder. Fix the environment and run workflow resume, or mark the check "baseline": "fail" in a new plan if it should fail there. ${NEW_PLAN_NOTE}`,
  'baseline-unexpected': `a check marked "baseline": "fail" did not fail by itself at the base commit; see artifacts/baseline-* in the run folder, fix the check or the environment, then run workflow resume. ${NEW_PLAN_NOTE}`,
};
const MAX_FAILED_TESTS_SHOWN = 10;

export function statusView(run) {
  const { state, policy } = run;
  const limits = policy.limits;
  const rem = remainingBudget(state, limits);
  return {
    runId: run.runId,
    status: state.status,
    stopReason: state.stopReason === undefined ? null : state.stopReason,
    owner: run.owner === undefined ? null : run.owner,
    steps: state.order.map((id) => {
      const s = state.steps[id];
      return { id, status: s.status, attempts: s.attempts, reason: s.reason === undefined ? null : s.reason, lastError: s.lastError === undefined ? null : s.lastError };
    }),
    budget: {
      agentCalls: { used: state.budget.agentCalls, limit: limits.maxAgentCalls, remaining: rem.agentCalls },
      activeSeconds: { used: state.budget.activeSeconds, limit: limits.runTimeoutSeconds, remaining: rem.activeSeconds },
      planRepairs: { used: state.budget.planRepairs, limit: limits.maxPlanRepairs },
      repairAttempts: { used: { ...state.budget.repairAttempts }, limitPerTarget: limits.maxRepairAttempts },
      failureStreak: { ...state.budget.failureStreak },
    },
    issues: [...run.issues],
  };
}

function verdictHashes(events, outcome) {
  const hashOf = (event) => (event ? event.data.patchSha256 : null);
  const reviewed = (role) => hashOf(events.findLast((e) => e.type === 'call.baseline' && e.data.role === role));
  const hashes = {
    sealed: hashOf(events.findLast((e) => e.type === 'checks.sealed' || e.type === 'steps.rechecked')),
    reviewer: reviewed('reviewer'),
    auditor: reviewed('auditor'),
    final: hashOf(outcome),
  };
  const values = Object.values(hashes);
  return { ...hashes, matched: values.every((h) => h !== null && h === values[0]) };
}

export function reportView(run) {
  const view = statusView(run);
  const latest = new Map();
  for (const e of run.events) {
    if (e.type === 'checks.finished') {
      for (const r of e.data.results) {
        latest.set(r.id, { exitCode: r.exitCode, failedTests: r.failedTests, stepId: e.data.stepId, seq: e.seq });
      }
    }
  }
  const checks = run.policy.checks.map(({ id }) => {
    const last = latest.get(id);
    if (!last) {
      return { id, result: 'not-run', required: run.policy.requiredChecks.includes(id) };
    }
    return { id, result: last.exitCode === 0 ? 'passed' : 'failed', required: run.policy.requiredChecks.includes(id), ...last };
  });
  const artifacts = run.events.filter((e) => e.type === 'role.result').map((e) => ({
    role: e.data.role,
    stepId: e.data.stepId,
    attempt: e.data.attempt,
    valid: e.data.valid,
    status: e.data.status,
    path: `artifacts/${e.data.artifact}`,
    sha256: e.data.sha256,
  }));
  const workspace = run.events.find((e) => e.type === 'workspace.created');
  const outcomes = run.events.filter((e) => e.type === 'run.outcome');
  const outcome = outcomes.at(-1);
  const setup = run.events.findLast((e) => e.type === 'setup.finished');
  const baseline = run.events.findLast((e) => e.type === 'checks.baseline');
  return {
    ...view,
    runDir: run.dir,
    stopHint: Object.prototype.hasOwnProperty.call(STOP_HINTS, view.stopReason) ? STOP_HINTS[view.stopReason] : null,
    setup: setup ? setup.data.results : [],
    baseline: baseline ? baseline.data.results : [],
    baselineChanges: baseline ? { changed: baseline.data.changed, violations: baseline.data.violations } : { changed: [], violations: [] },
    checks,
    unguardedChecks: run.policy.checks.filter((c) => c.inputs.length === 0).map((c) => c.id),
    verdict: verdictHashes(run.events, outcome),
    artifacts,
    remaining: view.steps.filter((s) => s.status !== 'SUCCEEDED').map((s) => s.id),
    worktree: workspace ? workspace.data.path : null,
    treeKillSupported: workspace ? workspace.data.treeKillSupported : null,
    resultPatch: outcome ? { path: `artifacts/${outcome.data.patch}`, bytes: outcome.data.patchBytes, sha256: outcome.data.patchSha256 } : null,
    sourceChanges: [...new Set(outcomes.flatMap((e) => e.data.sourceChanges))],
    sourceChangedSinceStart: outcome ? outcome.data.sourceChangedSinceStart === true : false,
    notGuaranteed: workspace ? NOT_GUARANTEED : [],
  };
}

function stepLines(view) {
  const rows = view.steps.map((s) => [s.id, s.status, String(s.attempts), s.reason || '', s.lastError || '']);
  const header = ['step', 'status', 'attempts', 'reason', 'last error'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  return [header, ...rows].map((r) => `  ${r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ')}`.trimEnd());
}

export function formatStatus(view) {
  const b = view.budget;
  const lines = [
    `run ${view.runId}: ${view.status}${view.stopReason ? ` (${view.stopReason})` : ''}`,
    ...stepLines(view),
    `agent calls ${b.agentCalls.used}/${b.agentCalls.limit}, active time ${Math.round(b.activeSeconds.used)}s/${b.activeSeconds.limit}s, plan repairs ${b.planRepairs.used}/${b.planRepairs.limit}`,
  ];
  const repairs = Object.entries(b.repairAttempts.used);
  if (repairs.length > 0) {
    lines.push(`repair attempts (limit ${b.repairAttempts.limitPerTarget} each): ${repairs.map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  for (const issue of view.issues) {
    lines.push(`issue: ${issue}`);
  }
  if (view.status === 'RUNNING' && view.owner === 'gone') {
    lines.push('warning: the process that ran this is gone; workflow resume checks what it left before continuing');
  }
  return lines.join('\n');
}

function failedTestsText(names) {
  if (names.length === 0) {
    return '';
  }
  const more = names.length > MAX_FAILED_TESTS_SHOWN ? ` and ${names.length - MAX_FAILED_TESTS_SHOWN} more` : '';
  return `; failing tests: ${names.slice(0, MAX_FAILED_TESTS_SHOWN).join(', ')}${more}`;
}

function preflightLines(view) {
  const lines = [];
  if (view.setup.length > 0) {
    lines.push('setup:', ...view.setup.map((r) => `  ${r.id}: exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`));
  }
  if (view.baseline.length > 0) {
    lines.push('baseline checks at the base commit:');
    for (const r of view.baseline) {
      lines.push(`  ${r.id}: exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}, expected to ${r.expected}, ${r.matched ? 'as expected' : 'NOT as expected'}${failedTestsText(r.failedTests)}`);
    }
  }
  const { changed, violations } = view.baselineChanges;
  if (changed.length > 0 || violations.length > 0) {
    lines.push(`changed before any AI call: ${[...new Set([...changed, ...violations.map((v) => v.path || v.reason)])].join(', ')}`);
  }
  return lines;
}

export function formatReport(view) {
  const lines = [formatStatus(view)];
  if (view.stopHint) {
    lines.push(`next: ${view.stopHint}`);
  }
  lines.push(...preflightLines(view), 'checks:');
  for (const c of view.checks) {
    lines.push(`  ${c.id}${c.required ? ' (required)' : ''}: ${c.result}${c.result === 'failed' ? ` (exit ${c.exitCode})${failedTestsText(c.failedTests)}` : ''}`);
  }
  if (view.unguardedChecks.length > 0) {
    lines.push(`checks without inputs, whose test files the AI CLI may edit: ${view.unguardedChecks.join(', ')}`);
  }
  if (view.status === 'SUCCEEDED') {
    const { sealed, reviewer, auditor, final, matched } = view.verdict;
    lines.push(`result hashes ${matched ? 'all match' : 'DIFFER'}: checks ${sealed}, reviewer ${reviewer}, auditor ${auditor}, final ${final}`);
  }
  lines.push(`artifacts: ${view.artifacts.length} in ${view.runDir}`);
  for (const a of view.artifacts) {
    lines.push(`  ${a.path} ${a.role} ${a.stepId} attempt ${a.attempt}: ${a.valid ? a.status : 'invalid result'}`);
  }
  lines.push(`remaining steps: ${view.remaining.length > 0 ? view.remaining.join(', ') : 'none'}`);
  if (view.worktree) {
    lines.push(`worktree: ${view.worktree}`);
  }
  if (view.resultPatch) {
    lines.push(`result patch: ${view.resultPatch.path} (${view.resultPatch.bytes} bytes, sha256 ${view.resultPatch.sha256})`);
  }
  if (view.sourceChanges.length > 0) {
    lines.push(`warning: the source repository changed during the run: ${view.sourceChanges.join(', ')}`);
  } else if (view.sourceChangedSinceStart) {
    lines.push('warning: the source repository changed since the run started');
  }
  if (view.treeKillSupported === false) {
    lines.push('warning: on this OS only the direct child is ended, so its descendants may keep running');
  }
  if (view.notGuaranteed.length > 0) {
    lines.push('not guaranteed:', ...view.notGuaranteed.map((n) => `  ${n}`));
  }
  return lines.join('\n');
}
