import fs from 'node:fs';
import path from 'node:path';
import { stripJsonc } from '../formats/jsonc.js';
import { sha256 } from '../util/fsx.js';

export const AGENT_ROLES = ['planner', 'coder', 'reviewer', 'auditor'];
export const V2_PLAN_FIELDS = ['assignmentHash', 'contextHash', 'planningHash', 'providerFingerprints'];
const AGENT_FIELDS = ['description', 'allowedRoles', 'command', 'args', 'model', 'env', 'input', 'output', 'resultPath', 'errorPath', 'metadataPaths'];
const POLICY_FIELDS = ['schemaVersion', 'agents', 'roleAgents', 'repairAgent', 'contextLimits', 'limits', 'allowedWritePaths', 'protectedPaths', 'setup', 'checks', 'requiredChecks', 'requiredRoles', 'exceptions'];
const META_FIELDS = ['reportedModel', 'inputTokens', 'outputTokens', 'cost'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.trim() !== '' && !v.includes('\0');
const keyPath = (v) => Array.isArray(v) && v.length > 0 && v.every(text);

export function assignmentError(message) {
  return Object.assign(new Error(message), { code: 'E_WORKFLOW_INVALID', stop: { status: 'BLOCKED', reason: 'input-invalid' } });
}

export function parsePolicyText(source, parse) {
  const raw = parse(source);
  if (raw?.schemaVersion !== 2) {
    return raw;
  }
  const tokens = stripJsonc(source.replace(/^\uFEFF/, '')).match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) || [];
  const stack = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '{' || token === '[') {
      stack.push(token === '{' ? new Set() : null);
    } else if (token === '}' || token === ']') {
      stack.pop();
    } else if (token.startsWith('"') && tokens[i + 1] === ':' && stack.at(-1) instanceof Set) {
      const key = JSON.parse(token);
      if (stack.at(-1).has(key)) {
        throw assignmentError('v2 policy contains a duplicate object key');
      }
      stack.at(-1).add(key);
    }
  }
  return raw;
}

export function normalizeAssignmentPolicy(raw, legacy) {
  const issues = [];
  const add = (where, msg) => issues.push({ where, msg });
  for (const key of Object.keys(raw)) {
    if (!POLICY_FIELDS.includes(key)) {
      add(key, 'unknown field');
    }
  }
  const common = Object.fromEntries(Object.entries(raw).filter(([key]) => !['agents', 'roleAgents', 'repairAgent', 'contextLimits', 'provider'].includes(key)));
  const base = legacy({ ...common, schemaVersion: 1, provider: { command: 'unused-ai', args: [] } });
  issues.push(...base.issues);
  const agents = Object.create(null);
  if (!object(raw.agents) || Object.keys(raw.agents).length === 0) {
    add('agents', 'must be a non-empty object');
  } else {
    for (const [id, profile] of Object.entries(raw.agents)) {
      const where = `agents.${id}`;
      if (!ID_RE.test(id) || !object(profile)) {
        add(where, 'must have a valid id and an object profile');
        continue;
      }
      for (const key of Object.keys(profile)) {
        if (!AGENT_FIELDS.includes(key)) {
          add(`${where}.${key}`, 'unknown field');
        }
      }
      for (const key of ['description', 'model', 'command']) {
        if (!text(profile[key]) || /[\r\n]/.test(profile[key])) {
          add(`${where}.${key}`, 'must be a non-empty single-line string');
        }
      }
      if (!Array.isArray(profile.allowedRoles) || profile.allowedRoles.length === 0 || profile.allowedRoles.some((r) => !AGENT_ROLES.includes(r)) || new Set(profile.allowedRoles).size !== profile.allowedRoles.length) {
        add(`${where}.allowedRoles`, 'must list unique supported roles');
      }
      if (!Array.isArray(profile.args) || profile.args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
        add(`${where}.args`, 'must be an array of strings');
      } else {
        const count = (token) => profile.args.filter((a) => a === token).length;
        if (count('{{model}}') !== 1 || count('{{prompt}}') !== (profile.input === 'argument' ? 1 : 0)) {
          add(`${where}.args`, 'requires one model token and a prompt token only for argument input');
        }
        if (profile.args.some((a) => /{{|}}/.test(a) && !['{{model}}', '{{prompt}}'].includes(a))) {
          add(`${where}.args`, 'tokens must be supported whole arguments');
        }
      }
      const env = profile.env === undefined ? [] : profile.env;
      if (!Array.isArray(env) || env.some((name) => typeof name !== 'string' || !ENV_RE.test(name))) {
        add(`${where}.env`, 'must list environment variable names');
      }
      if (!['stdin', 'argument'].includes(profile.input)) {
        add(`${where}.input`, 'must be stdin or argument');
      }
      if (!['text', 'json-field'].includes(profile.output)) {
        add(`${where}.output`, 'must be text or json-field');
      }
      if (profile.output === 'json-field') {
        if (!keyPath(profile.resultPath)) {
          add(`${where}.resultPath`, 'must be a non-empty object key path');
        }
        if (profile.errorPath !== undefined && !keyPath(profile.errorPath)) {
          add(`${where}.errorPath`, 'must be an object key path');
        }
        if (profile.metadataPaths !== undefined && (!object(profile.metadataPaths) || Object.entries(profile.metadataPaths).some(([key, value]) => !META_FIELDS.includes(key) || !keyPath(value)))) {
          add(`${where}.metadataPaths`, 'must map supported metadata to object key paths');
        }
      } else if (['resultPath', 'errorPath', 'metadataPaths'].some((key) => Object.hasOwn(profile, key))) {
        add(where, 'text output cannot have JSON field paths');
      }
      agents[id] = { ...profile, env };
    }
  }
  const roleAgents = raw.roleAgents;
  if (!object(roleAgents) || Object.keys(roleAgents).length !== AGENT_ROLES.length) {
    add('roleAgents', 'must map all four roles');
  }
  const reference = (id, role, where) => {
    if (typeof id !== 'string' || !Object.hasOwn(agents, id) || !Array.isArray(agents[id].allowedRoles) || !agents[id].allowedRoles.includes(role)) {
      add(where, 'must reference an agent allowed for this role');
    }
  };
  for (const role of AGENT_ROLES) {
    reference(roleAgents?.[role], role, `roleAgents.${role}`);
  }
  reference(raw.repairAgent, 'coder', 'repairAgent');
  const contextLimits = raw.contextLimits;
  if (!object(contextLimits) || Object.keys(contextLimits).length !== 2 || ['maxPromptBytes', 'maxDependencyBytes'].some((key) => !Number.isSafeInteger(contextLimits[key]) || contextLimits[key] <= 0)) {
    add('contextLimits', 'must specify positive maxPromptBytes and maxDependencyBytes');
  }
  if (issues.length > 0) {
    return { policy: null, issues };
  }
  const { provider, ...rest } = base.policy;
  return { policy: { ...rest, schemaVersion: 2, agents, roleAgents: { ...roleAgents }, repairAgent: raw.repairAgent, contextLimits: { ...contextLimits } }, issues };
}

export function validateAssignmentPlan(plan, policy, options, legacy) {
  if (!object(plan)) {
    return legacy(plan, policy, options);
  }
  const reduced = { ...plan, schemaVersion: 1 };
  if (Array.isArray(plan.steps)) {
    reduced.steps = plan.steps.map((step) => object(step) ? Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'agent')) : step);
  }
  const issues = legacy(reduced, policy, options);
  if (plan.schemaVersion !== 2) {
    issues.push({ where: 'schemaVersion', msg: 'must be 2' });
  }
  for (const [index, step] of (Array.isArray(plan.steps) ? plan.steps : []).entries()) {
    if (!object(step)) {
      continue;
    }
    const id = Object.hasOwn(step, 'agent') ? step.agent : policy.roleAgents.coder;
    if (typeof id !== 'string' || !Object.hasOwn(policy.agents, id) || !policy.agents[id].allowedRoles.includes('coder')) {
      issues.push({ where: `steps[${index}].agent`, msg: 'must reference an agent allowed for coder' });
    }
  }
  return issues;
}

export function canonicalAssignmentPlan(plan, policy) {
  return { ...plan, steps: plan.steps.map((step) => ({ ...step, agent: Object.hasOwn(step, 'agent') ? step.agent : policy.roleAgents.coder })) };
}

export function policyInput(policy) {
  const ids = new Set((policy.exceptions || []).filter((e) => e.kind === 'add-check').map((e) => e.check.id));
  return { ...policy, checks: policy.checks.filter((c) => !ids.has(c.id)), requiredChecks: policy.requiredChecks.filter((id) => !ids.has(id)) };
}

export function makeAssignments(plan, policy) {
  return {
    ...Object.fromEntries(AGENT_ROLES.filter((role) => role !== 'coder').map((role) => [role, { agentId: policy.roleAgents[role], selectionSource: 'role-default' }])),
    steps: Object.fromEntries(plan.steps.map((step) => [step.id, { agentId: step.agent ?? policy.roleAgents.coder, selectionSource: Object.hasOwn(step, 'agent') ? 'step' : 'role-default' }])),
    repair: { agentId: policy.repairAgent, selectionSource: 'repair-default' },
  };
}

export function commandRole(role) {
  return role === 'arbiter' ? 'planner' : role;
}

export function assignedAgent(policy, request, plan = null) {
  const role = commandRole(request.role);
  const id = role !== 'coder' ? policy.roleAgents[role] : request.stepId === 'review-fix' ? policy.repairAgent
    : (plan?.steps.find((s) => s.id === request.stepId)?.agent ?? request.agent ?? policy.roleAgents.coder);
  if (!Object.hasOwn(policy.agents, id) || !policy.agents[id].allowedRoles.includes(role)) {
    throw assignmentError('the assigned agent is missing or does not allow this role');
  }
  if (request.agent !== undefined && request.agent !== id) {
    throw assignmentError('request agent differs from the fixed assignment');
  }
  return { agentId: id, profile: policy.agents[id] };
}

export function fieldValue(value, keys) {
  for (const key of keys || []) {
    if (!object(value) || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

export function fingerprintArtifacts(items, cwd) {
  const root = fs.realpathSync(cwd);
  return items.map(({ path: file, purpose }) => {
    if (typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
      throw assignmentError('dependency artifact must be a relative file inside the worktree');
    }
    let resolved;
    try {
      resolved = fs.realpathSync(path.resolve(root, file));
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw assignmentError('dependency artifact is missing');
      }
      throw err;
    }
    const relative = path.relative(root, resolved);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || !fs.statSync(resolved).isFile()) {
      throw assignmentError('dependency artifact must be a file inside the worktree');
    }
    return { path: file, purpose, sha256: sha256(fs.readFileSync(resolved)) };
  });
}

export function buildHandoff(run, request, cwd, hashJson) {
  const wanted = new Set();
  const visit = (id) => {
    if (wanted.has(id)) {
      return;
    }
    wanted.add(id);
    for (const dep of run.plan.steps.find((s) => s.id === id)?.dependsOn || []) {
      visit(dep);
    }
  };
  const step = run.plan.steps.find((s) => s.id === request.stepId);
  for (const id of step ? step.dependsOn : run.plan.steps.map((s) => s.id)) {
    visit(id);
  }
  const dependencies = [];
  const fileEvidence = run.events.filter((e) => e.type === 'agent.files' && run.events.some((r) => r.type === 'role.result' && r.data.valid && r.data.stepId === e.data.stepId && r.data.attempt === e.data.attempt)).at(-1)?.data.files || [];
  for (const id of wanted) {
    const latest = run.events.filter((e) => e.type === 'role.result' && e.data.stepId === id && e.data.valid).at(-1);
    if (!latest || run.state.steps[id].status !== 'SUCCEEDED') {
      throw assignmentError(`dependency ${id} has no completed evidence`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(latest.data.artifact) || latest.data.artifact.includes('..')) {
      throw assignmentError('dependency evidence has an invalid artifact name');
    }
    const artifactPath = path.join(run.dir, 'artifacts', latest.data.artifact);
    if (fs.lstatSync(artifactPath).isSymbolicLink()) {
      throw assignmentError('dependency evidence cannot be a symbolic link');
    }
    const bytes = fs.readFileSync(artifactPath);
    if (sha256(bytes) !== latest.data.sha256) {
      throw assignmentError(`dependency ${id} evidence hash changed`);
    }
    const result = JSON.parse(bytes).result;
    const artifacts = fingerprintArtifacts(result.artifacts || [], cwd);
    if (artifacts.some((item) => fileEvidence.find((f) => f.path === item.path)?.sha256 !== item.sha256)) {
      throw assignmentError('dependency file changed since its last validated result');
    }
    const checks = run.events.filter((e) => e.type === 'checks.finished' && e.data.stepId === id).at(-1)?.data.results || [];
    dependencies.push({ stepId: id, summary: result.summary, artifacts, resultHash: latest.data.sha256, checks });
  }
  if (Buffer.byteLength(JSON.stringify(dependencies)) > run.policy.contextLimits.maxDependencyBytes) {
    throw assignmentError('dependency context exceeds maxDependencyBytes; make a smaller plan');
  }
  return { originalGoal: run.context.goal, dependencies, dependencyHash: hashJson(dependencies) };
}
