import { readRun } from './store.js';
import { validatePlan, PROGRAM_PLAN_FIELDS } from './schema.js';
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

function issueText(i) {
  return typeof i === 'string' ? i : `${i.where}: ${i.msg}`;
}

function cmdValidate(ctx, flags, runId) {
  const run = readRun(ctx, runId);
  const issues = [...run.issues];
  const model = Object.fromEntries(Object.entries(run.plan).filter(([k]) => !PROGRAM_PLAN_FIELDS.includes(k)));
  const created = run.events.find((e) => e.type === 'run.created');
  if (!created || !Number.isSafeInteger(created.data.usedAgentCalls)) {
    issues.push('events.jsonl has no run.created event with usedAgentCalls');
  } else {
    const planIssues = validatePlan(model, run.policy, { usedAgentCalls: created.data.usedAgentCalls });
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
