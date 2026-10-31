import { readRun, readRunOwner, stateIssues } from './store.js';
import { validatePlan, normalizePolicy, hashJson, PROGRAM_PLAN_FIELDS } from './schema.js';
import { executionOrder } from './graph.js';
import { statusView, reportView, formatStatus, formatReport } from './report.js';
import { cmdCancel, cmdPlan, cmdRun } from './run.js';
import { info, error } from '../util/log.js';

const EXIT_CODES = {
  E_WORKFLOW_BAD_RUN_ID: 2,
  E_WORKFLOW_NOT_FOUND: 2,
  E_WORKFLOW_INVALID: 2,
  E_WORKFLOW_WORKSPACE: 2,
  E_WORKFLOW_SPAWN: 2,
  E_WORKFLOW_LOCKED: 3,
  E_WORKFLOW_CORRUPT: 3,
  E_WORKFLOW_UNSAFE_PATH: 3,
};
const COMMANDS = { validate: cmdValidate, status: cmdStatus, report: cmdReport };
const RUN_COMMANDS = ['run', 'resume'];
const FLAG_KINDS = { json: 'switch', quiet: 'switch', q: 'switch', home: 'value', source: 'value' };
const RUN_FLAG_KINDS = { ...FLAG_KINDS, yes: 'switch', y: 'switch', path: 'value' };
const PLAN_FLAG_KINDS = { ...RUN_FLAG_KINDS, 'goal-file': 'value', config: 'value' };
const PLAN_USAGE = 'usage: agent-layers workflow plan --goal-file <file> --config <file> [--path <repo>] [--yes] [--json]';

export function exitCodeFor(err) {
  return err && Object.prototype.hasOwnProperty.call(EXIT_CODES, err.code) ? EXIT_CODES[err.code] : 1;
}

function reportWorkflowError(err) {
  if (!err || typeof err.code !== 'string' || !err.code.startsWith('E_WORKFLOW_')) {
    throw err;
  }
  error(err.message);
  return exitCodeFor(err);
}

async function startCommand(ctx, flags, sub, runId, confirm) {
  try {
    if (sub === 'cancel') {
      return await cmdCancel(ctx, flags, runId);
    }
    return await (sub === 'plan' ? cmdPlan(ctx, flags, { confirm }) : cmdRun(ctx, flags, runId, { confirm, resume: sub === 'resume' }));
  } catch (err) {
    return reportWorkflowError(err);
  }
}

export function workflowCommand(ctx, flags, positional, { confirm } = {}) {
  const [sub, runId, ...extra] = positional;
  if (sub === 'cancel') {
    const issue = !runId || extra.length > 0 ? 'one run id is needed' : flagProblem(flags, FLAG_KINDS);
    if (issue) {
      error(`${issue}. usage: agent-layers workflow cancel <run-id> [--json]`);
      return 2;
    }
    return startCommand(ctx, flags, sub, runId, confirm);
  }
  if (sub === 'plan') {
    const issue = flagProblem(flags, PLAN_FLAG_KINDS) || (positional.length > 1 ? 'workflow plan takes no run id' : null) || (typeof flags['goal-file'] !== 'string' ? 'missing --goal-file' : null) || (typeof flags.config !== 'string' ? 'missing --config' : null);
    if (issue) {
      error(`${issue}. ${PLAN_USAGE}`);
      return 2;
    }
    return startCommand(ctx, flags, sub, null, confirm);
  }
  if (RUN_COMMANDS.includes(sub)) {
    const issue = !runId || extra.length > 0 ? 'one run id is needed' : flagProblem(flags, RUN_FLAG_KINDS);
    if (issue) {
      error(`${issue}. usage: agent-layers workflow ${sub} <run-id> [--path <repo>] [--yes] [--json]`);
      return 2;
    }
    return startCommand(ctx, flags, sub, runId, confirm);
  }
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, sub)) {
    error(`${sub ? `unknown workflow command "${sub}"` : 'missing workflow command'}. Run "agent-layers help".`);
    return 2;
  }
  if (!runId || extra.length > 0) {
    error(`usage: agent-layers workflow ${sub} <run-id> [--json]`);
    return 2;
  }
  const flagIssue = flagProblem(flags, FLAG_KINDS);
  if (flagIssue) {
    error(`${flagIssue}. usage: agent-layers workflow ${sub} <run-id> [--json]`);
    return 2;
  }
  try {
    return COMMANDS[sub](ctx, flags, runId);
  } catch (err) {
    return reportWorkflowError(err);
  }
}

function flagProblem(flags, kinds) {
  for (const [key, value] of Object.entries(flags)) {
    const kind = Object.prototype.hasOwnProperty.call(kinds, key) ? kinds[key] : null;
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
    if (planIssues.length === 0 && Array.isArray(run.state.order) && executionOrder(model.steps).join('\0') !== run.state.order.join('\0')) {
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

function readViewableRun(ctx, runId) {
  const run = readRun(ctx, runId);
  const problems = stateIssues(run.state, run.state.order);
  if (problems.length > 0) {
    throw Object.assign(new Error(`state.json of run ${runId} is damaged and cannot be shown: ${problems.join('; ')}`), { code: 'E_WORKFLOW_CORRUPT' });
  }
  return { ...run, owner: readRunOwner(ctx, runId).status };
}

function cmdStatus(ctx, flags, runId) {
  const view = statusView(readViewableRun(ctx, runId));
  info(flags.json ? JSON.stringify(view, null, 2) : formatStatus(view));
  return 0;
}

function cmdReport(ctx, flags, runId) {
  const view = reportView(readViewableRun(ctx, runId));
  info(flags.json ? JSON.stringify(view, null, 2) : formatReport(view));
  return 0;
}
