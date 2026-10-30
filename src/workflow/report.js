import { remainingBudget } from './store.js';

export function statusView(run) {
  const { state, policy } = run;
  const limits = policy.limits;
  const rem = remainingBudget(state, limits);
  return {
    runId: run.runId,
    status: state.status,
    stopReason: state.stopReason === undefined ? null : state.stopReason,
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
  return {
    ...view,
    runDir: run.dir,
    checks,
    artifacts,
    remaining: view.steps.filter((s) => s.status !== 'SUCCEEDED').map((s) => s.id),
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
  return lines.join('\n');
}

export function formatReport(view) {
  const lines = [formatStatus(view), 'checks:'];
  for (const c of view.checks) {
    lines.push(`  ${c.id}${c.required ? ' (required)' : ''}: ${c.result}${c.result === 'failed' ? ` (exit ${c.exitCode})` : ''}`);
  }
  lines.push(`artifacts: ${view.artifacts.length} in ${view.runDir}`);
  for (const a of view.artifacts) {
    lines.push(`  ${a.path} ${a.role} ${a.stepId} attempt ${a.attempt}: ${a.valid ? a.status : 'invalid result'}`);
  }
  lines.push(`remaining steps: ${view.remaining.length > 0 ? view.remaining.join(', ') : 'none'}`);
  return lines.join('\n');
}
