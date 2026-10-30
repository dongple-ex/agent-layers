import { readRun } from './store.js';
import { validatePlan, normalizePolicy, hashJson, PROGRAM_PLAN_FIELDS } from './schema.js';
import { executionOrder } from './graph.js';
import { statusView, reportView, formatStatus, formatReport } from './report.js';
import { info, error } from '../util/log.js';

const LATER_COMMANDS = ['plan', 'run', 'resume', 'cancel'];
const EXIT_CODES = {
  E_WORKFLOW_BAD_RUN_ID: 2,
  E_WORKFLOW_NOT_FOUND: 2,
  E_WORKFLOW_INVALID: 2,
  E_WORKFLOW_LOCKED: 3,
  E_WORKFLOW_CORRUPT: 3,
  E_WORKFLOW_UNSAFE_PATH: 3,
};
const COMMANDS = { validate: cmdValidate, status: cmdStatus, report: cmdReport };
const FLAG_KINDS = { json: 'switch', quiet: 'switch', q: 'switch', home: 'value', source: 'value' };

export function exitCodeFor(err) {
  return err && Object.prototype.hasOwnProperty.call(EXIT_CODES, err.code) ? EXIT_CODES[err.code] : 1;
}

export function workflowCommand(ctx, flags, positional) {
  const [sub, runId, ...extra] = positional;
  if (LATER_COMMANDS.includes(sub)) {
    error(`workflow ${sub} is not available yet; it arrives with the Codex runner (workflow stage W4)`);
    return 2;
  }
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, sub)) {
    error(`${sub ? `unknown workflow command "${sub}"` : 'missing workflow command'}. Run "agent-layers help".`);
    return 2;
  }
  if (!runId || extra.length > 0) {
    error(`usage: agent-layers workflow ${sub} <run-id> [--json]`);
    return 2;
  }
  const flagIssue = flagProblem(flags);
  if (flagIssue) {
    error(`${flagIssue}. usage: agent-layers workflow ${sub} <run-id> [--json]`);
    return 2;
  }
  try {
    return COMMANDS[sub](ctx, flags, runId);
  } catch (err) {
    if (!err || typeof err.code !== 'string' || !err.code.startsWith('E_WORKFLOW_')) {
      throw err;
    }
    error(err.message);
    return exitCodeFor(err);
  }
}

function flagProblem(flags) {
  for (const [key, value] of Object.entries(flags)) {
    const kind = Object.prototype.hasOwnProperty.call(FLAG_KINDS, key) ? FLAG_KINDS[key] : null;
    if (kind === null) {
      return `unknown option --${key}`;
    }
    if (kind === 'switch' && value !== true) {
      return `--${key} takes no value`;
    }
    if (kind === 'value' && typeof value !== 'string') {
      return `--${key} needs a value`;
    }
  }
  return null;
}

function withoutAddedChecks(stored) {
  if (!Array.isArray(stored.exceptions) || !Array.isArray(stored.checks) || !Array.isArray(stored.requiredChecks)) {
    return stored;
  }
  const added = new Set(stored.exceptions.filter((e) => e && e.kind === 'add-check' && e.check).map((e) => e.check.id));
  return {
    ...stored,
    checks: stored.checks.filter((c) => !(c && added.has(c.id))),
    requiredChecks: stored.requiredChecks.filter((id) => !added.has(id)),
  };
}

function issueText(i) {
  return typeof i === 'string' ? i : `${i.where}: ${i.msg}`;
}

function cmdValidate(ctx, flags, runId) {
  const run = readRun(ctx, runId);
  const issues = [...run.issues];
  const model = Object.fromEntries(Object.entries(run.plan).filter(([k]) => !PROGRAM_PLAN_FIELDS.includes(k)));
  const created = run.events.find((e) => e.type === 'run.created');
  const { policy, issues: policyIssues } = normalizePolicy(withoutAddedChecks(run.policy));
  if (!policy) {
    issues.push(...policyIssues.map((i) => `policy ${issueText(i)}`));
  } else if (hashJson(policy) !== hashJson(run.policy)) {
    issues.push('policy.json differs from its normalized form');
  }
  if (!created || !Number.isSafeInteger(created.data.usedAgentCalls)) {
    issues.push('events.jsonl has no run.created event with usedAgentCalls');
  } else if (policy) {
    const planIssues = validatePlan(model, policy, { usedAgentCalls: created.data.usedAgentCalls });
    issues.push(...planIssues.map((i) => `plan ${issueText(i)}`));
    if (planIssues.length === 0 && executionOrder(model.steps).join('\0') !== run.state.order.join('\0')) {
      issues.push('state.json step order does not match the plan');
    }
  }
  const view = { runId, valid: issues.length === 0, issues };
  if (flags.json) {
    info(JSON.stringify(view, null, 2));
  } else {
    info(view.valid ? `run ${runId}: valid` : `run ${runId}: ${issues.length} problem(s)`);
    for (const issue of issues) {
      info(`  - ${issue}`);
    }
  }
  return view.valid ? 0 : 2;
}

function cmdStatus(ctx, flags, runId) {
  const view = statusView(readRun(ctx, runId));
  info(flags.json ? JSON.stringify(view, null, 2) : formatStatus(view));
  return 0;
}

function cmdReport(ctx, flags, runId) {
  const view = reportView(readRun(ctx, runId));
  info(flags.json ? JSON.stringify(view, null, 2) : formatReport(view));
  return 0;
}
