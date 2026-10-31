import { posix } from 'node:path';
import { stableStringify } from '../formats/jsonc.js';
import { sha256 } from '../util/fsx.js';
import { graphIssues } from './graph.js';

export const SCHEMA_VERSION = 1;
export const RESERVED_STEP_IDS = ['review', 'audit', 'review-fix'];
export const PROGRAM_PLAN_FIELDS = ['runId', 'baseCommit', 'policyHash', 'planHash', 'providerFingerprint', 'createdAt'];
export const RUNTIME_PROTECTED_PATHS = ['.git', '.codex', '.agents'];
export const RESULT_STATUSES = ['completed', 'needs_changes', 'blocked'];
export const DEFAULT_LIMITS = {
  maxConcurrent: 1,
  maxSteps: 9,
  maxRepairAttempts: 2,
  maxTransportRetries: 2,
  maxPlanRepairs: 1,
  maxAgentCalls: 20,
  stepTimeoutSeconds: 900,
  runTimeoutSeconds: 3600,
};
export const DEFAULT_REQUIRED_ROLES = ['reviewer', 'auditor'];
export const STEP_STATUSES = ['PENDING', 'READY', 'RUNNING', 'VERIFYING', 'RETRY_PENDING', 'SUCCEEDED', 'BLOCKED', 'FAILED', 'CANCELLED', 'INTERRUPTED'];
export const RUN_STATUSES = ['PLANNED', 'RUNNING', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'];

const POSITIVE_LIMITS = ['maxSteps', 'maxAgentCalls', 'stepTimeoutSeconds', 'runTimeoutSeconds'];
const RETRY_LIMITS = ['maxRepairAttempts', 'maxTransportRetries', 'maxPlanRepairs'];
const STEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const POLICY_KEYS = ['schemaVersion', 'provider', 'limits', 'allowedWritePaths', 'protectedPaths', 'checks', 'requiredChecks', 'requiredRoles', 'exceptions'];
const PROVIDER_KEYS = ['command', 'args', 'roleArgs', 'env'];
const PROVIDER_ROLES = ['planner', 'coder', 'reviewer', 'auditor'];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
//20261030 TODO Field name "inputs" and optional cwd/inputs are provisional; CONTRACT 4 does not name them
const CHECK_KEYS = ['id', 'command', 'args', 'cwd', 'timeout', 'inputs'];
const STEP_KEYS = ['id', 'role', 'dependsOn', 'instruction', 'writePaths', 'checkIds', 'acceptance'];
const RESULT_KEYS = ['schemaVersion', 'stepId', 'attempt', 'status', 'summary', 'artifacts', 'findings', 'needsInput'];
const ARTIFACT_KEYS = ['path', 'purpose'];
//20261030 TODO Finding field names and the needsInput type are provisional; CONTRACT 5 does not name them
const FINDING_KEYS = ['code', 'severity', 'path', 'evidence'];

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function unknownKeys(obj, allowed) {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function stringList(v) {
  return Array.isArray(v) && v.every((s) => nonEmptyString(s));
}

function isArgList(v) {
  return Array.isArray(v) && v.every((a) => typeof a === 'string' && !a.includes('\0'));
}

function executableIssue(v) {
  return nonEmptyString(v) && !/[\0\r\n]/.test(v) ? null : 'must be an executable name or path';
}

export function relativePathIssue(p) {
  if (typeof p !== 'string' || p === '') {
    return 'path must be a non-empty string';
  }
  if (p.includes('\0')) {
    return 'path must not contain NUL';
  }
  if (p.includes('\\')) {
    return 'path must use "/" separators';
  }
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
    return 'path must be relative to the repository';
  }
  if (p.split('/').includes('..')) {
    return 'path must not contain ".."';
  }
  if (/[*?[\]{}]/.test(p)) {
    return 'glob patterns are not supported';
  }
  return null;
}

export function normalizeRelativePath(p) {
  return posix.normalize(p).replace(/\/+$/, '') || '.';
}

export function pathCovers(base, p) {
  return base === '.' || p === base || p.startsWith(`${base}/`);
}

function pathList(value, where, add, { allowEmpty }) {
  if (!Array.isArray(value)) {
    add(where, 'must be an array of relative paths');
    return [];
  }
  if (!allowEmpty && value.length === 0) {
    add(where, 'must not be empty');
  }
  const out = [];
  value.forEach((p, i) => {
    const issue = relativePathIssue(p);
    if (issue) {
      add(`${where}[${i}]`, issue);
      return;
    }
    const n = normalizeRelativePath(p);
    if (!out.includes(n)) {
      out.push(n);
    }
  });
  return out;
}

function limitIssue(key, value) {
  if (key === 'maxConcurrent') {
    return value === 1 ? null : 'must be 1 in this version';
  }
  if (POSITIVE_LIMITS.includes(key)) {
    return Number.isSafeInteger(value) && value > 0 ? null : 'must be a positive integer';
  }
  return Number.isSafeInteger(value) && value >= 0 ? null : 'must be an integer of 0 or more';
}

function checkDefinition(check, where, add) {
  if (!isObject(check)) {
    add(where, 'must be an object');
    return null;
  }
  for (const k of unknownKeys(check, CHECK_KEYS)) {
    add(`${where}.${k}`, 'unknown field');
  }
  if (typeof check.id !== 'string' || !STEP_ID_RE.test(check.id)) {
    add(`${where}.id`, 'must match [A-Za-z0-9][A-Za-z0-9._-]* (max 64)');
  }
  if (executableIssue(check.command)) {
    add(`${where}.command`, executableIssue(check.command));
  }
  if (!isArgList(check.args)) {
    add(`${where}.args`, 'must be an array of strings');
  }
  if (!Number.isSafeInteger(check.timeout) || check.timeout <= 0) {
    add(`${where}.timeout`, 'must be a positive integer (seconds)');
  }
  let cwd = '.';
  if (own(check, 'cwd')) {
    const issue = relativePathIssue(check.cwd);
    if (issue) {
      add(`${where}.cwd`, issue);
    } else {
      cwd = normalizeRelativePath(check.cwd);
    }
  }
  const inputs = own(check, 'inputs') ? pathList(check.inputs, `${where}.inputs`, add, { allowEmpty: true }) : [];
  return { id: check.id, command: check.command, args: Array.isArray(check.args) ? [...check.args] : [], cwd, timeout: check.timeout, inputs };
}

export function normalizePolicy(raw) {
  const issues = [];
  const add = (where, msg) => issues.push({ where, msg });
  if (!isObject(raw)) {
    return { policy: null, issues: [{ where: 'policy', msg: 'must be an object' }] };
  }
  for (const k of unknownKeys(raw, POLICY_KEYS)) {
    add(k, 'unknown field');
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    add('schemaVersion', `must be ${SCHEMA_VERSION}`);
  }

  const provider = {};
  if (!isObject(raw.provider)) {
    add('provider', 'must be an object');
  } else {
    for (const k of unknownKeys(raw.provider, PROVIDER_KEYS)) {
      add(`provider.${k}`, 'unknown field');
    }
    if (executableIssue(raw.provider.command)) {
      add('provider.command', executableIssue(raw.provider.command));
    }
    if (!isArgList(raw.provider.args)) {
      add('provider.args', 'must be an array of strings');
    }
    const roleArgs = own(raw.provider, 'roleArgs') ? raw.provider.roleArgs : {};
    if (!isObject(roleArgs)) {
      add('provider.roleArgs', 'must be an object');
    } else {
      for (const k of Object.keys(roleArgs)) {
        if (!PROVIDER_ROLES.includes(k)) {
          add(`provider.roleArgs.${k}`, `must be one of ${PROVIDER_ROLES.join(', ')}`);
        } else if (!isArgList(roleArgs[k])) {
          add(`provider.roleArgs.${k}`, 'must be an array of strings');
        }
      }
    }
    const env = own(raw.provider, 'env') ? raw.provider.env : [];
    if (!Array.isArray(env) || !env.every((name) => typeof name === 'string' && ENV_NAME_RE.test(name))) {
      add('provider.env', 'must be an array of environment variable names');
    }
    Object.assign(provider, { command: raw.provider.command, args: raw.provider.args, roleArgs, env });
  }

  const limits = { ...DEFAULT_LIMITS };
  if (own(raw, 'limits')) {
    if (!isObject(raw.limits)) {
      add('limits', 'must be an object');
    } else {
      for (const k of Object.keys(raw.limits)) {
        if (!own(DEFAULT_LIMITS, k)) {
          add(`limits.${k}`, 'unknown field');
          continue;
        }
        const issue = limitIssue(k, raw.limits[k]);
        if (issue) {
          add(`limits.${k}`, issue);
        } else {
          limits[k] = raw.limits[k];
        }
      }
    }
  }

  const allowedWritePaths = pathList(raw.allowedWritePaths, 'allowedWritePaths', add, { allowEmpty: false });
  const protectedPaths = own(raw, 'protectedPaths') ? pathList(raw.protectedPaths, 'protectedPaths', add, { allowEmpty: true }) : [];
  for (const p of RUNTIME_PROTECTED_PATHS) {
    if (!protectedPaths.includes(p)) {
      protectedPaths.push(p);
    }
  }

  const checks = [];
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    add('checks', 'must be a non-empty array');
  } else {
    raw.checks.forEach((c, i) => {
      const def = checkDefinition(c, `checks[${i}]`, add);
      if (def && checks.some((x) => x.id === def.id)) {
        add(`checks[${i}].id`, `duplicate check id "${def.id}"`);
      } else if (def) {
        checks.push(def);
      }
    });
  }

  const requiredChecks = [];
  if (!Array.isArray(raw.requiredChecks) || raw.requiredChecks.length === 0) {
    add('requiredChecks', 'must be a non-empty array of check ids');
  } else {
    raw.requiredChecks.forEach((id, i) => {
      if (typeof id !== 'string' || !checks.some((c) => c.id === id)) {
        add(`requiredChecks[${i}]`, `unknown check id ${JSON.stringify(id)}`);
      } else if (requiredChecks.includes(id)) {
        add(`requiredChecks[${i}]`, `duplicate check id "${id}"`);
      } else {
        requiredChecks.push(id);
      }
    });
  }

  let requiredRoles = [...DEFAULT_REQUIRED_ROLES];
  if (own(raw, 'requiredRoles')) {
    const roles = raw.requiredRoles;
    if (!Array.isArray(roles) || roles.some((r) => !DEFAULT_REQUIRED_ROLES.includes(r)) || new Set(roles).size !== roles.length) {
      add('requiredRoles', 'may only list "reviewer" and "auditor" once each');
    } else if (!DEFAULT_REQUIRED_ROLES.every((r) => roles.includes(r))) {
      add('requiredRoles', 'must include "reviewer" and "auditor" in this version');
    } else {
      requiredRoles = DEFAULT_REQUIRED_ROLES.filter((r) => roles.includes(r));
    }
  }

  const exceptions = [];
  if (own(raw, 'exceptions')) {
    if (!Array.isArray(raw.exceptions)) {
      add('exceptions', 'must be an array');
    } else {
      raw.exceptions.forEach((e, i) => {
        const where = `exceptions[${i}]`;
        //20261030 TODO Exception object shape and apply order are provisional; CONTRACT 4 names only the two kinds
        if (!isObject(e)) {
          add(where, 'must be an object');
          return;
        }
        if (typeof e.id !== 'string' || !STEP_ID_RE.test(e.id)) {
          add(`${where}.id`, 'must match [A-Za-z0-9][A-Za-z0-9._-]* (max 64)');
        } else if (exceptions.some((x) => x.id === e.id)) {
          add(`${where}.id`, `duplicate exception id "${e.id}"`);
        }
        if (e.kind === 'replace-limit') {
          for (const k of unknownKeys(e, ['id', 'kind', 'limit', 'value'])) {
            add(`${where}.${k}`, 'unknown field');
          }
          if (typeof e.limit !== 'string' || !own(DEFAULT_LIMITS, e.limit)) {
            add(`${where}.limit`, 'must name a known limit');
            return;
          }
          const issue = limitIssue(e.limit, e.value);
          if (issue) {
            add(`${where}.value`, issue);
            return;
          }
          limits[e.limit] = e.value;
          exceptions.push({ id: e.id, kind: e.kind, limit: e.limit, value: e.value });
        } else if (e.kind === 'add-check') {
          for (const k of unknownKeys(e, ['id', 'kind', 'check'])) {
            add(`${where}.${k}`, 'unknown field');
          }
          const def = checkDefinition(e.check, `${where}.check`, add);
          if (!def) {
            return;
          }
          if (checks.some((c) => c.id === def.id)) {
            add(`${where}.check.id`, `duplicate check id "${def.id}"`);
            return;
          }
          checks.push(def);
          requiredChecks.push(def.id);
          exceptions.push({ id: e.id, kind: e.kind, check: def });
        } else {
          add(`${where}.kind`, 'must be "replace-limit" or "add-check"');
        }
      });
    }
  }

  if (limits.maxSteps + 3 > limits.maxAgentCalls) {
    add('limits', `maxSteps + 3 must not exceed maxAgentCalls (${limits.maxSteps} + 3 > ${limits.maxAgentCalls})`);
  }
  if (issues.length > 0) {
    return { policy: null, issues };
  }
  return {
    policy: { schemaVersion: SCHEMA_VERSION, provider, limits, allowedWritePaths, protectedPaths, checks, requiredChecks, requiredRoles, exceptions },
    issues,
  };
}

export function validatePlan(plan, policy, { usedAgentCalls }) {
  const issues = [];
  const add = (where, msg) => issues.push({ where, msg });
  if (!Number.isSafeInteger(usedAgentCalls) || usedAgentCalls < 0) {
    throw new Error('validatePlan: usedAgentCalls must be an integer of 0 or more');
  }
  if (!isObject(plan)) {
    return [{ where: 'plan', msg: 'must be an object' }];
  }
  for (const k of Object.keys(plan)) {
    if (PROGRAM_PLAN_FIELDS.includes(k)) {
      add(k, 'is set by the program and must not come from the model');
    } else if (!['schemaVersion', 'goal', 'steps'].includes(k)) {
      add(k, 'unknown field');
    }
  }
  if (plan.schemaVersion !== SCHEMA_VERSION) {
    add('schemaVersion', `must be ${SCHEMA_VERSION}`);
  }
  if (!nonEmptyString(plan.goal)) {
    add('goal', 'must be a non-empty string');
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    add('steps', 'must be a non-empty array');
    return issues;
  }
  const checkIds = policy.checks.map((c) => c.id);
  const shapeOk = plan.steps.map((step, i) => {
    const where = `steps[${i}]`;
    if (!isObject(step)) {
      add(where, 'must be an object');
      return false;
    }
    let ok = true;
    for (const k of unknownKeys(step, STEP_KEYS)) {
      add(`${where}.${k}`, 'unknown field');
    }
    if (typeof step.id !== 'string' || !STEP_ID_RE.test(step.id)) {
      add(`${where}.id`, 'must match [A-Za-z0-9][A-Za-z0-9._-]* (max 64)');
      ok = false;
    } else if (RESERVED_STEP_IDS.includes(step.id)) {
      add(`${where}.id`, `"${step.id}" is reserved for program steps`);
    }
    if (step.role !== 'coder') {
      add(`${where}.role`, 'must be "coder" in this version');
    }
    if (!Array.isArray(step.dependsOn) || !step.dependsOn.every((d) => typeof d === 'string')) {
      add(`${where}.dependsOn`, 'must be an array of step ids');
      ok = false;
    }
    if (!nonEmptyString(step.instruction)) {
      add(`${where}.instruction`, 'must be a non-empty string');
    }
    const writePaths = pathList(step.writePaths, `${where}.writePaths`, add, { allowEmpty: false });
    for (const p of writePaths) {
      if (!policy.allowedWritePaths.some((a) => pathCovers(a, p))) {
        add(`${where}.writePaths`, `"${p}" is outside allowedWritePaths`);
      }
      const hit = policy.protectedPaths.find((a) => pathCovers(a, p));
      if (hit) {
        add(`${where}.writePaths`, `"${p}" is inside protected path "${hit}"`);
      }
    }
    if (!Array.isArray(step.checkIds)) {
      add(`${where}.checkIds`, 'must be an array of check ids');
    } else {
      step.checkIds.forEach((id, j) => {
        if (typeof id !== 'string' || !checkIds.includes(id)) {
          add(`${where}.checkIds[${j}]`, `unknown check id ${JSON.stringify(id)}`);
        }
      });
    }
    if (!Array.isArray(step.acceptance) || step.acceptance.length === 0 || !stringList(step.acceptance)) {
      add(`${where}.acceptance`, 'must be a non-empty array of non-empty strings');
    }
    return ok;
  });
  if (shapeOk.every(Boolean)) {
    issues.push(...graphIssues(plan.steps));
  }
  const n = plan.steps.length;
  if (n > policy.limits.maxSteps) {
    add('steps', `has ${n} steps; maxSteps is ${policy.limits.maxSteps}`);
  }
  const remaining = policy.limits.maxAgentCalls - usedAgentCalls;
  if (remaining < n + 2) {
    add('steps', `needs ${n + 2} more agent calls; ${remaining} remain of maxAgentCalls ${policy.limits.maxAgentCalls}`);
  }
  return issues;
}

export function validateRoleResult(result, { stepIds }) {
  const issues = [];
  const add = (where, msg) => issues.push({ where, msg });
  if (!isObject(result)) {
    return [{ where: 'result', msg: 'must be an object' }];
  }
  for (const k of unknownKeys(result, RESULT_KEYS)) {
    add(k, 'unknown field');
  }
  for (const k of RESULT_KEYS) {
    if (!own(result, k)) {
      add(k, 'is required');
    }
  }
  if (own(result, 'schemaVersion') && result.schemaVersion !== SCHEMA_VERSION) {
    add('schemaVersion', `must be ${SCHEMA_VERSION}`);
  }
  if (own(result, 'stepId') && (typeof result.stepId !== 'string' || !(stepIds.includes(result.stepId) || RESERVED_STEP_IDS.includes(result.stepId)))) {
    add('stepId', `unknown step id ${JSON.stringify(result.stepId)}`);
  }
  //20261030 TODO Attempt numbering is provisional (starts at 1); CONTRACT 5 does not fix the base
  if (own(result, 'attempt') && (!Number.isSafeInteger(result.attempt) || result.attempt < 1)) {
    add('attempt', 'must be a positive integer');
  }
  if (own(result, 'status') && !RESULT_STATUSES.includes(result.status)) {
    add('status', `must be one of ${RESULT_STATUSES.join(', ')}`);
  }
  if (own(result, 'summary') && !nonEmptyString(result.summary)) {
    add('summary', 'must be a non-empty string');
  }
  if (own(result, 'artifacts')) {
    if (!Array.isArray(result.artifacts)) {
      add('artifacts', 'must be an array');
    } else {
      result.artifacts.forEach((a, i) => {
        const where = `artifacts[${i}]`;
        if (!isObject(a)) {
          add(where, 'must be an object');
          return;
        }
        for (const k of unknownKeys(a, ARTIFACT_KEYS)) {
          add(`${where}.${k}`, 'unknown field');
        }
        const issue = relativePathIssue(a.path);
        if (issue) {
          add(`${where}.path`, issue);
        }
        if (!nonEmptyString(a.purpose)) {
          add(`${where}.purpose`, 'must be a non-empty string');
        }
      });
    }
  }
  if (own(result, 'findings')) {
    if (!Array.isArray(result.findings)) {
      add('findings', 'must be an array');
    } else if (result.status === 'needs_changes' && result.findings.length === 0) {
      add('findings', 'must not be empty when status is needs_changes');
    } else {
      result.findings.forEach((f, i) => {
        const where = `findings[${i}]`;
        if (!isObject(f)) {
          add(where, 'must be an object');
          return;
        }
        for (const k of unknownKeys(f, FINDING_KEYS)) {
          add(`${where}.${k}`, 'unknown field');
        }
        for (const k of ['code', 'severity', 'evidence']) {
          if (!nonEmptyString(f[k])) {
            add(`${where}.${k}`, 'must be a non-empty string');
          }
        }
        if (own(f, 'path')) {
          const issue = relativePathIssue(f.path);
          if (issue) {
            add(`${where}.path`, issue);
          }
        } else if (result.status === 'needs_changes') {
          add(`${where}.path`, 'is required when status is needs_changes');
        }
      });
    }
  }
  if (own(result, 'needsInput') && !stringList(result.needsInput)) {
    add('needsInput', 'must be an array of non-empty strings');
  }
  return issues;
}

export function assertJsonValue(value, where) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${where}: non-finite number cannot be hashed`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonValue(v, `${where}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) {
      assertJsonValue(value[k], `${where}.${k}`);
    }
    return;
  }
  throw new Error(`${where}: ${typeof value} cannot be hashed`);
}

export function hashJson(value) {
  assertJsonValue(value, 'value');
  return sha256(stableStringify(value));
}
