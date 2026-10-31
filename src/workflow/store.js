import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { stringifyJson } from '../formats/jsonc.js';
import { sha256, sleepSync } from '../util/fsx.js';
import { normalizePolicy, validatePlan, hashJson, assertJsonValue, PROGRAM_PLAN_FIELDS, STEP_STATUSES, RUN_STATUSES, SCHEMA_VERSION } from './schema.js';
import { withProgramSteps, topologicalOrder } from './graph.js';

export const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SAME_FAILURE_LIMIT = 3;
export const REVIEW_FIX_TARGET = 'review-fix';

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const EVENT_TYPE_RE = /^[a-z][a-z0-9.-]*$/;
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SECRET_WORDS = new Set(['password', 'passwd', 'pwd', 'secret', 'token', 'credential', 'credentials', 'apikey', 'authorization']);
const BEARER_TEXT_RE = /(?<![A-Za-z0-9_-])bearer\s+([A-Za-z0-9._~+/=-]{8,})/gi;
const BEARER_VALUE_RE = /[0-9~+=]|[^.]\.[^.]|^[A-Za-z]{20,}$/;
const BEARER_QUOTES = ['"', "'", '`'];
const SECRET_PAIRS = [['api', 'key'], ['private', 'key'], ['access', 'key']];
const INTERRUPTIBLE_STEPS = ['RUNNING', 'VERIFYING'];
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const SECRET_KEY_TEXT_RE = /(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_.-]*)\\*["']?\s*[:=]/g;
const NUMBER_VALUE_RE = /\s*\\*["']?\s*-?\d/y;
const QUANTITY_WORDS = new Set(['count', 'counts', 'total', 'usage', 'used', 'remaining', 'limit', 'limits', 'length', 'size', 'max', 'min', 'budget', 'number', 'num']);
const MAX_DATA_DEPTH = 64;
const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const REDACTED_TEXT = '[redacted: text contained a secret-looking assignment]';

function storeError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

export function workflowsDir(ctx) {
  return path.join(ctx.paths.stateDir, 'workflows');
}

export function runDir(ctx, runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw storeError('E_WORKFLOW_BAD_RUN_ID', `invalid run id ${JSON.stringify(runId)}`);
  }
  return path.join(workflowsDir(ctx), runId);
}

function assertRealDir(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw storeError('E_WORKFLOW_NOT_FOUND', `${dir} does not exist`);
    }
    throw err;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw storeError('E_WORKFLOW_UNSAFE_PATH', `${dir} must be a real directory, not a link or file`);
  }
}

function ensureRealDir(dir) {
  try {
    assertRealDir(dir);
  } catch (err) {
    if (err.code !== 'E_WORKFLOW_NOT_FOUND') {
      throw err;
    }
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    assertRealDir(dir);
  }
}

function fsyncDir(dir) {
  if (IS_WIN) {
    return;
  }
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeFileSynced(file, text, flag) {
  const fd = fs.openSync(file, flag, FILE_MODE);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function renameNoCopy(from, to) {
  for (let i = 0; ; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!IS_WIN || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || i >= 7) {
        fs.rmSync(from, { force: true });
        throw err;
      }
      sleepSync(40 * (i + 1));
    }
  }
}

function writeDurable(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  writeFileSynced(tmp, text, 'wx');
  renameNoCopy(tmp, file);
  fsyncDir(path.dirname(file));
}

function assertPlainFile(st, file) {
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
    throw storeError('E_WORKFLOW_UNSAFE_PATH', `${file} must be a regular file with a single link`);
  }
}

function openRecord(file, flags) {
  assertPlainFile(fs.lstatSync(file), file);
  const fd = fs.openSync(file, flags | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    const now = fs.lstatSync(file);
    assertPlainFile(now, file);
    if (opened.ino !== now.ino || opened.dev !== now.dev || opened.nlink !== 1) {
      throw storeError('E_WORKFLOW_UNSAFE_PATH', `${file} changed while it was opened`);
    }
    return fd;
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

function readRecord(file) {
  const fd = openRecord(file, fs.constants.O_RDONLY);
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function appendRecord(file, text) {
  const fd = openRecord(file, fs.constants.O_WRONLY | fs.constants.O_APPEND);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readJson(file, label) {
  let text;
  try {
    text = readRecord(file).toString('utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw storeError('E_WORKFLOW_CORRUPT', `${label} is missing (${file})`);
    }
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw storeError('E_WORKFLOW_CORRUPT', `${label} is not valid JSON (${err.message})`);
  }
}

function keyWords(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function isSecretKey(key) {
  const words = keyWords(key);
  if (words.some((w) => SECRET_WORDS.has(w))) {
    return true;
  }
  return SECRET_PAIRS.some(([a, b]) => words.some((w, i) => w === a && words[i + 1] === b));
}

function isSecretField(key, numeric) {
  if (!isSecretKey(key)) {
    return false;
  }
  const words = keyWords(key);
  return !(numeric && QUANTITY_WORDS.has(words[words.length - 1]));
}

function hasBearerToken(text) {
  for (const m of text.matchAll(BEARER_TEXT_RE)) {
    const quote = text[m.index - 1];
    if (BEARER_VALUE_RE.test(m[1]) || (BEARER_QUOTES.includes(quote) && text[m.index + m[0].length] === quote)) {
      return true;
    }
  }
  return false;
}

export function findSecretAssignment(text) {
  if (hasBearerToken(text)) {
    return 'Bearer';
  }
  const re = new RegExp(SECRET_KEY_TEXT_RE.source, 'g');
  const num = new RegExp(NUMBER_VALUE_RE.source, 'y');
  let m;
  while ((m = re.exec(text)) !== null) {
    num.lastIndex = re.lastIndex;
    if (isSecretField(m[1], num.test(text))) {
      return m[1];
    }
  }
  return null;
}

export function sanitizeEventData(value, depth = 0) {
  if (depth > MAX_DATA_DEPTH) {
    throw storeError('E_WORKFLOW_INVALID', `event data is nested deeper than ${MAX_DATA_DEPTH} levels`);
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeEventData(v, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).map((k) => [k, value[k] !== null && isSecretField(k, typeof value[k] === 'number') ? '***' : sanitizeEventData(value[k], depth + 1)]));
  }
  if (typeof value === 'string' && findSecretAssignment(value) !== null) {
    return REDACTED_TEXT;
  }
  return value;
}

export function policySecretIssues(policy) {
  const { args, roleArgs } = policy.provider;
  const issues = [];
  for (const [where, list] of [['provider.args', args], ...Object.entries(roleArgs).map(([role, v]) => [`provider.roleArgs.${role}`, v])]) {
    list.forEach((arg, i) => {
      const flag = /^--?([A-Za-z][A-Za-z0-9_-]*)/.exec(arg);
      if ((flag && isSecretField(flag[1], true)) || findSecretAssignment(arg) !== null) {
        issues.push({ where: `${where}[${i}]`, msg: 'must not hold a secret; name the variable in provider.env instead' });
      }
    });
  }
  return issues;
}

function childScope(scope, key) {
  if (scope === 'root') {
    return key === 'steps' ? 'ids' : key === 'budget' ? 'budget' : 'plain';
  }
  if (scope === 'budget') {
    return key === 'repairAttempts' ? 'ids' : 'plain';
  }
  return 'plain';
}

function secretFieldIssues(value, where, scope = 'root', depth = 0) {
  if (depth > MAX_DATA_DEPTH) {
    return [`${where} is nested deeper than ${MAX_DATA_DEPTH} levels`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => secretFieldIssues(v, `${where}[${i}]`, 'plain', depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).flatMap((k) => {
      const at = `${where}.${k}`;
      if (scope !== 'ids' && value[k] !== null && isSecretField(k, typeof value[k] === 'number')) {
        return [`${at} looks like a secret; workflow state must not store secrets`];
      }
      return secretFieldIssues(value[k], at, childScope(scope, k), depth + 1);
    });
  }
  if (typeof value === 'string') {
    const key = findSecretAssignment(value);
    if (key !== null) {
      return [`${where} contains a secret-looking assignment (${key}); workflow state must not store secrets`];
    }
  }
  return [];
}

function processStartTime(pid) {
  if (!IS_LINUX) {
    return null;
  }
  let text;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  return text.slice(text.lastIndexOf(')') + 2).split(' ')[19] || null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') {
      return false;
    }
    if (err.code === 'EPERM') {
      return true;
    }
    throw err;
  }
}

function newOwner(runId) {
  return {
    runId,
    ownerId: crypto.randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    processStart: processStartTime(process.pid),
    acquiredAt: new Date().toISOString(),
  };
}

function validOwner(o) {
  return o !== null && typeof o === 'object' && typeof o.ownerId === 'string' && Number.isSafeInteger(o.pid) && o.pid > 0
    && typeof o.hostname === 'string' && (o.processStart === null || typeof o.processStart === 'string');
}

function readLock(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  try {
    const owner = JSON.parse(text);
    return validOwner(owner) ? { owner } : { unreadable: true };
  } catch {
    return { unreadable: true };
  }
}

export function lockIsStale(owner) {
  if (owner.hostname !== os.hostname()) {
    return false;
  }
  if (!pidAlive(owner.pid)) {
    return true;
  }
  if (IS_LINUX && owner.processStart !== null) {
    const current = processStartTime(owner.pid);
    return current !== null && current !== owner.processStart;
  }
  return false;
}

function createLock(file, owner) {
  const tmp = `${file}.${owner.ownerId}.tmp`;
  writeFileSynced(tmp, stringifyJson(owner), 'wx');
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      attachCleanup(err, () => fs.rmSync(tmp, { force: true }));
      throw err;
    }
    fs.rmSync(tmp, { force: true });
    return false;
  }
  try {
    fs.rmSync(tmp);
    fsyncDir(path.dirname(file));
    return true;
  } catch (err) {
    attachCleanup(err, () => fs.rmSync(tmp, { force: true }));
    attachCleanup(err, () => removeOwnLock(file, owner));
    throw err;
  }
}

function attachCleanup(err, fn) {
  try {
    fn();
  } catch (cleanupErr) {
    err.cleanupErrors = [...(err.cleanupErrors || []), cleanupErr];
  }
}

function removeOwnLock(file, owner) {
  if (readLock(file)?.owner?.ownerId === owner.ownerId) {
    fs.rmSync(file);
  }
}

function lockedError(label, file, owner) {
  return storeError('E_WORKFLOW_LOCKED', `${label} is locked by pid ${owner.pid} on ${owner.hostname} (run ${owner.runId})`, { lockFile: file, owner });
}

function acquireLock(file, owner, label) {
  if (createLock(file, owner)) {
    return null;
  }
  const current = readLock(file);
  if (current === null) {
    if (createLock(file, owner)) {
      return null;
    }
    throw storeError('E_WORKFLOW_LOCKED', `${label} lock ${file} is being taken by another process`, { lockFile: file });
  }
  if (current.unreadable) {
    throw storeError('E_WORKFLOW_LOCKED', `${label} lock ${file} is unreadable; make sure no workflow is running, then remove it by hand`, { lockFile: file });
  }
  if (!lockIsStale(current.owner)) {
    throw lockedError(label, file, current.owner);
  }
  return reclaimStaleLock(file, owner, label, current.owner);
}

function reclaimStaleLock(file, owner, label, stale) {
  const guard = `${file}.reclaim`;
  if (!createLock(guard, owner)) {
    const g = readLock(guard);
    const who = g && g.owner ? ` (pid ${g.owner.pid} on ${g.owner.hostname})` : '';
    throw storeError('E_WORKFLOW_LOCKED', `${label} lock ${file} is being reclaimed by another process${who}; if no workflow is running, remove ${guard} by hand`, { lockFile: file, guard });
  }
  let again;
  try {
    again = readLock(file);
    if (again !== null && (again.unreadable || again.owner.ownerId !== stale.ownerId)) {
      throw storeError('E_WORKFLOW_LOCKED', `${label} lock ${file} changed owner while it was being reclaimed; retry`, { lockFile: file });
    }
    if (again !== null) {
      fs.rmSync(file);
    }
    if (!createLock(file, owner)) {
      throw storeError('E_WORKFLOW_LOCKED', `${label} lock ${file} was taken by another process after a stale lock was removed`, { lockFile: file });
    }
  } catch (err) {
    attachCleanup(err, () => releaseLock(guard, owner));
    throw err;
  }
  releaseLock(guard, owner);
  return again === null ? null : stale;
}

function releaseLock(file, owner) {
  const current = readLock(file);
  if (!current || current.unreadable || current.owner.ownerId !== owner.ownerId) {
    throw storeError('E_WORKFLOW_LOCK_CHANGED', `lock ${file} is no longer held by this process`, { lockFile: file });
  }
  fs.rmSync(file);
}

function workspaceLockFile(ctx, workspaceKey) {
  return path.join(workflowsDir(ctx), 'locks', `${sha256(workspaceKey)}.lock`);
}

function emptyBudget(usedAgentCalls, planRepairs) {
  return { agentCalls: usedAgentCalls, activeSeconds: 0, planRepairs, repairAttempts: {}, failureStreak: { signature: null, count: 0 } };
}

export function stateIssues(state, order) {
  const issues = [];
  if (!Array.isArray(order) || !Array.isArray(state.order) || state.order.join('\0') !== order.join('\0')) {
    return ['state order must match the planned step order'];
  }
  if (!RUN_STATUSES.includes(state.status)) {
    issues.push(`run status ${JSON.stringify(state.status)} is not one of ${RUN_STATUSES.join(', ')}`);
  }
  const ids = Object.keys(state.steps || {});
  if (ids.length !== order.length || !order.every((id) => ids.includes(id))) {
    issues.push('steps must match the planned step ids');
  }
  for (const id of ids) {
    const s = state.steps[id];
    if (s === null || typeof s !== 'object') {
      issues.push(`step ${id} must be an object`);
      continue;
    }
    if (!STEP_STATUSES.includes(s.status)) {
      issues.push(`step ${id} status ${JSON.stringify(s.status)} is not one of ${STEP_STATUSES.join(', ')}`);
    }
    if (!Number.isSafeInteger(s.attempts) || s.attempts < 0) {
      issues.push(`step ${id} attempts must be an integer of 0 or more`);
    }
  }
  const b = state.budget || {};
  for (const k of ['agentCalls', 'planRepairs']) {
    if (!Number.isSafeInteger(b[k]) || b[k] < 0) {
      issues.push(`budget.${k} must be an integer of 0 or more`);
    }
  }
  if (typeof b.activeSeconds !== 'number' || !Number.isFinite(b.activeSeconds) || b.activeSeconds < 0) {
    issues.push('budget.activeSeconds must be a number of 0 or more');
  }
  for (const [target, n] of Object.entries(b.repairAttempts || {})) {
    if (target !== REVIEW_FIX_TARGET && !ids.includes(target)) {
      issues.push(`budget.repairAttempts has unknown target "${target}"`);
    }
    if (!Number.isSafeInteger(n) || n < 0) {
      issues.push(`budget.repairAttempts.${target} must be an integer of 0 or more`);
    }
  }
  const f = b.failureStreak || {};
  if (!(f.signature === null || typeof f.signature === 'string') || !Number.isSafeInteger(f.count) || f.count < 0) {
    issues.push('budget.failureStreak must have a signature (string or null) and a count');
  }
  issues.push(...secretFieldIssues(state, 'state'));
  return issues;
}

export function createRun(ctx, { plan, policy: rawPolicy, usedAgentCalls, planRepairs, baseCommit, providerFingerprint, workspaceKey }) {
  const { policy, issues: policyIssues } = normalizePolicy(rawPolicy);
  if (!policy) {
    throw storeError('E_WORKFLOW_INVALID', 'workflow policy is invalid', { issues: policyIssues });
  }
  const secretIssues = policySecretIssues(policy);
  if (secretIssues.length > 0) {
    throw storeError('E_WORKFLOW_INVALID', 'workflow policy holds a secret', { issues: secretIssues });
  }
  const planIssues = validatePlan(plan, policy, { usedAgentCalls });
  if (planIssues.length > 0) {
    throw storeError('E_WORKFLOW_INVALID', 'workflow plan is invalid', { issues: planIssues });
  }
  if (!Number.isSafeInteger(planRepairs) || planRepairs < 0 || planRepairs > policy.limits.maxPlanRepairs) {
    throw storeError('E_WORKFLOW_INVALID', `planRepairs must be an integer from 0 to maxPlanRepairs (${policy.limits.maxPlanRepairs})`);
  }
  if (typeof baseCommit !== 'string' || !COMMIT_RE.test(baseCommit)) {
    throw storeError('E_WORKFLOW_INVALID', 'baseCommit must be a full lowercase commit hash');
  }
  for (const [name, v] of [['providerFingerprint', providerFingerprint], ['workspaceKey', workspaceKey]]) {
    if (typeof v !== 'string' || v.trim() === '') {
      throw storeError('E_WORKFLOW_INVALID', `${name} must be a non-empty string`);
    }
  }
  const runId = crypto.randomUUID();
  const dir = runDir(ctx, runId);
  const createdAt = new Date().toISOString();
  const planHash = hashJson(plan);
  const policyHash = hashJson(policy);
  const stored = { ...structuredClone(plan), runId, baseCommit, policyHash, planHash, providerFingerprint, createdAt };
  const order = topologicalOrder(withProgramSteps(plan.steps));
  const state = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    workspaceKey,
    status: 'PLANNED',
    lastSeq: 0,
    owner: null,
    createdAt,
    updatedAt: createdAt,
    order,
    steps: Object.fromEntries(order.map((id) => [id, { status: 'PENDING', attempts: 0 }])),
    budget: emptyBudget(usedAgentCalls, planRepairs),
  };
  const stateProblems = stateIssues(state, order);
  if (stateProblems.length > 0) {
    throw storeError('E_WORKFLOW_INVALID', `the initial workflow state is invalid: ${stateProblems.join('; ')}`, { issues: stateProblems });
  }
  ensureRealDir(workflowsDir(ctx));
  fs.mkdirSync(dir, { mode: DIR_MODE });
  fs.mkdirSync(path.join(dir, 'artifacts'), { mode: DIR_MODE });
  writeDurable(path.join(dir, 'policy.json'), stringifyJson(policy));
  writeDurable(path.join(dir, 'plan.json'), stringifyJson(stored));
  writeDurable(path.join(dir, 'state.json'), stringifyJson(state));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '', { flag: 'wx', mode: FILE_MODE });
  commitEvent(dir, state, 'run.created', { planHash, policyHash, baseCommit, providerFingerprint, usedAgentCalls, planRepairs });
  return { runId, dir, planHash, policyHash };
}

function scanEvents(dir) {
  const file = path.join(dir, 'events.jsonl');
  let buf;
  try {
    buf = readRecord(file);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { events: [], tail: Buffer.alloc(0), completeBytes: 0, issues: ['events.jsonl is missing'] };
    }
    throw err;
  }
  const cut = buf.lastIndexOf(0x0a) + 1;
  const tail = buf.subarray(cut);
  const events = [];
  const issues = [];
  buf.subarray(0, cut).toString('utf8').split('\n').slice(0, -1).forEach((line, i) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      issues.push(`events.jsonl line ${i + 1} is not valid JSON`);
    }
  });
  events.forEach((e, i) => {
    if (e.seq !== i + 1) {
      issues.push(`events.jsonl line ${i + 1} has seq ${JSON.stringify(e.seq)}; expected ${i + 1}`);
    }
  });
  return { events, tail, completeBytes: cut, issues };
}

function hashIssues(plan, policy) {
  const issues = [];
  const modelPart = Object.fromEntries(Object.keys(plan).filter((k) => !PROGRAM_PLAN_FIELDS.includes(k)).map((k) => [k, plan[k]]));
  if (hashJson(modelPart) !== plan.planHash) {
    issues.push('plan.json does not match its planHash');
  }
  if (hashJson(policy) !== plan.policyHash) {
    issues.push('policy.json does not match the policyHash in plan.json');
  }
  return issues;
}

function isSameJson(a, b) {
  return a !== null && typeof a === 'object' && hashJson(a) === hashJson(b);
}

export function readRun(ctx, runId) {
  const dir = runDir(ctx, runId);
  assertRealDir(dir);
  const plan = readJson(path.join(dir, 'plan.json'), 'plan.json');
  const policy = readJson(path.join(dir, 'policy.json'), 'policy.json');
  const state = readJson(path.join(dir, 'state.json'), 'state.json');
  for (const [label, value] of [['plan.json', plan], ['policy.json', policy], ['state.json', state]]) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw storeError('E_WORKFLOW_CORRUPT', `${label} is not a JSON object`);
    }
  }
  const scan = scanEvents(dir);
  const issues = [...hashIssues(plan, policy), ...scan.issues];
  if (scan.tail.length > 0) {
    issues.push(`events.jsonl ends with ${scan.tail.length} bytes of an unfinished event`);
  }
  issues.push(...stateIssues(state, state.order).map((i) => `state.json: ${i}`));
  if (state.lastSeq > scan.events.length) {
    issues.push(`state.json is at seq ${state.lastSeq} but events.jsonl ends at ${scan.events.length}`);
  } else if (state.lastSeq < scan.events.length) {
    issues.push(`state.json is behind events.jsonl (${state.lastSeq} < ${scan.events.length})`);
  } else if (scan.events.length > 0 && !isSameJson(scan.events[scan.events.length - 1].state, state)) {
    issues.push(`state.json does not match the state saved with event ${scan.events.length}`);
  }
  return { runId, dir, plan, policy, state, events: scan.events, issues };
}

function commitEvent(dir, state, type, data, mutate = null) {
  if (typeof type !== 'string' || !EVENT_TYPE_RE.test(type)) {
    throw new Error(`invalid event type ${JSON.stringify(type)}`);
  }
  const next = structuredClone(state);
  if (mutate) {
    mutate(next);
  }
  const issues = stateIssues(next, state.order);
  if (issues.length > 0) {
    throw storeError('E_WORKFLOW_INVALID_STATE', `refusing to write an invalid workflow state: ${issues.join('; ')}`, { issues });
  }
  const seq = state.lastSeq + 1;
  const at = new Date().toISOString();
  next.lastSeq = seq;
  next.updatedAt = at;
  const event = { seq, at, type, data: sanitizeEventData(data), state: next };
  assertJsonValue(event, 'event');
  try {
    appendRecord(path.join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
    writeDurable(path.join(dir, 'state.json'), stringifyJson(next));
  } catch (err) {
    err.partialCommit = true;
    throw err;
  }
  return next;
}

function snapshotFrom(event, order, seq) {
  const snap = event && event.state;
  if (!snap || typeof snap !== 'object' || snap.lastSeq !== seq || stateIssues(snap, order).length > 0) {
    return null;
  }
  return snap;
}

function recover(handle, staleOwners) {
  const { dir } = handle;
  const plan = readJson(path.join(dir, 'plan.json'), 'plan.json');
  const policy = readJson(path.join(dir, 'policy.json'), 'policy.json');
  let state = readJson(path.join(dir, 'state.json'), 'state.json');
  const integrity = hashIssues(plan, policy);
  const scan = scanEvents(dir);
  if (integrity.length > 0 || scan.issues.length > 0) {
    throw storeError('E_WORKFLOW_CORRUPT', `run ${handle.runId} cannot be recovered automatically: ${[...integrity, ...scan.issues].join('; ')}`);
  }
  const eventsSeq = scan.events.length;
  if (state.lastSeq > eventsSeq || state.lastSeq < eventsSeq - 1) {
    throw storeError('E_WORKFLOW_CORRUPT', `run ${handle.runId} cannot be recovered automatically: state.json is at seq ${state.lastSeq} and events.jsonl ends at ${eventsSeq}`);
  }
  const notes = {};
  let behindSnapshot = null;
  if (state.lastSeq === eventsSeq - 1) {
    behindSnapshot = snapshotFrom(scan.events[eventsSeq - 1], state.order, eventsSeq);
    if (!behindSnapshot) {
      throw storeError('E_WORKFLOW_CORRUPT', `run ${handle.runId} cannot be recovered automatically: event ${eventsSeq} has no usable state snapshot`);
    }
  }
  if (scan.tail.length > 0) {
    const kept = path.join(dir, `events.unfinished-${eventsSeq + 1}-${crypto.randomBytes(4).toString('hex')}.txt`);
    writeDurable(kept, scan.tail);
    const fd = openRecord(path.join(dir, 'events.jsonl'), fs.constants.O_RDWR);
    try {
      fs.ftruncateSync(fd, scan.completeBytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    notes.unfinishedEvent = path.basename(kept);
  }
  if (behindSnapshot) {
    writeDurable(path.join(dir, 'state.json'), stringifyJson(behindSnapshot));
    notes.stateBehindEvent = eventsSeq;
    state = behindSnapshot;
  }
  if (state.owner !== null) {
    notes.previousOwner = state.owner;
  }
  const stale = staleOwners.filter(Boolean);
  if (stale.length > 0) {
    notes.staleLocks = stale;
  }
  const interrupted = Boolean(notes.unfinishedEvent || notes.stateBehindEvent || notes.previousOwner);
  if (interrupted) {
    notes.previousStatus = state.status;
  }
  if (Object.keys(notes).length > 0) {
    state = commitEvent(dir, state, 'run.recovered', notes, (s) => {
      if (!interrupted) {
        return;
      }
      if (s.status === 'RUNNING') {
        s.status = 'INTERRUPTED';
      }
      for (const id of s.order) {
        if (INTERRUPTIBLE_STEPS.includes(s.steps[id].status)) {
          s.steps[id].status = 'INTERRUPTED';
        }
      }
    });
  }
  return { state, interrupted, notes };
}

export function acquireRun(ctx, runId) {
  const dir = runDir(ctx, runId);
  assertRealDir(workflowsDir(ctx));
  assertRealDir(dir);
  const owner = newOwner(runId);
  const runLock = path.join(dir, 'lock');
  let wsLock = null;
  try {
    const staleRun = acquireLock(runLock, owner, 'run');
    const { workspaceKey } = readJson(path.join(dir, 'state.json'), 'state.json');
    if (typeof workspaceKey !== 'string' || workspaceKey === '') {
      throw storeError('E_WORKFLOW_CORRUPT', 'state.json has no workspaceKey');
    }
    wsLock = workspaceLockFile(ctx, workspaceKey);
    ensureRealDir(path.dirname(wsLock));
    const staleWs = acquireLock(wsLock, owner, 'workspace');
    const handle = { ctx, runId, dir, owner, runLock, wsLock, held: true };
    const recovery = recover(handle, [staleRun, staleWs]);
    const ownerInfo = { ownerId: owner.ownerId, pid: owner.pid, hostname: owner.hostname, acquiredAt: owner.acquiredAt };
    handle.state = commitEvent(dir, recovery.state, 'run.acquired', ownerInfo, (s) => {
      s.owner = ownerInfo;
    });
    handle.recovery = recovery;
    return handle;
  } catch (err) {
    if (wsLock) {
      attachCleanup(err, () => removeOwnLock(wsLock, owner));
    }
    attachCleanup(err, () => removeOwnLock(runLock, owner));
    throw err;
  }
}

function assertHeld(handle) {
  if (!handle || !handle.held) {
    throw new Error('workflow run handle is not held');
  }
}

export function commitRun(handle, type, data = {}, mutate = null) {
  assertHeld(handle);
  if (handle.broken) {
    throw storeError('E_WORKFLOW_BROKEN_HANDLE', `an earlier write for run ${handle.runId} failed part way; release this handle and acquire the run again to recover`);
  }
  const state = readJson(path.join(handle.dir, 'state.json'), 'state.json');
  if (state.lastSeq !== handle.state.lastSeq) {
    throw storeError('E_WORKFLOW_CORRUPT', `state.json changed outside this handle (seq ${state.lastSeq}, expected ${handle.state.lastSeq})`);
  }
  try {
    handle.state = commitEvent(handle.dir, state, type, data, mutate);
  } catch (err) {
    if (err.partialCommit) {
      handle.broken = true;
    }
    throw err;
  }
  return handle.state;
}

export function releaseRun(handle) {
  assertHeld(handle);
  try {
    if (!handle.broken) {
      commitRun(handle, 'run.released', { ownerId: handle.owner.ownerId }, (s) => {
        s.owner = null;
      });
    }
  } finally {
    handle.held = false;
    try {
      releaseLock(handle.wsLock, handle.owner);
    } finally {
      releaseLock(handle.runLock, handle.owner);
    }
  }
}

export function writeArtifact(handle, name, value) {
  assertHeld(handle);
  if (handle.broken) {
    throw storeError('E_WORKFLOW_BROKEN_HANDLE', `an earlier write for run ${handle.runId} failed part way; release this handle and acquire the run again to recover`);
  }
  if (typeof name !== 'string' || !ARTIFACT_NAME_RE.test(name) || name.includes('..')) {
    throw storeError('E_WORKFLOW_INVALID', `artifact name ${JSON.stringify(name)} must match ${ARTIFACT_NAME_RE} without ".."`);
  }
  const dir = path.join(handle.dir, 'artifacts');
  assertRealDir(dir);
  const file = path.join(dir, `${name}.json`);
  if (fs.existsSync(file)) {
    throw storeError('E_WORKFLOW_INVALID', `artifact ${name}.json already exists; artifacts are never overwritten`);
  }
  const clean = sanitizeEventData(value);
  assertJsonValue(clean, 'artifact');
  const text = stringifyJson(clean);
  writeDurable(file, text);
  return { name: `${name}.json`, sha256: sha256(text) };
}

export function readArtifact(handle, file) {
  assertHeld(handle);
  const name = typeof file === 'string' && file.endsWith('.json') ? file.slice(0, -'.json'.length) : null;
  if (name === null || !ARTIFACT_NAME_RE.test(name) || name.includes('..')) {
    throw storeError('E_WORKFLOW_INVALID', `artifact file ${JSON.stringify(file)} must be <name>.json with a name matching ${ARTIFACT_NAME_RE} without ".."`);
  }
  const dir = path.join(handle.dir, 'artifacts');
  assertRealDir(dir);
  return readJson(path.join(dir, file), `artifact ${file}`);
}

function repairCount(state, target) {
  return Object.prototype.hasOwnProperty.call(state.budget.repairAttempts, target) ? state.budget.repairAttempts[target] : 0;
}

export function chargeAgentCall(state, n = 1) {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error('chargeAgentCall: n must be a positive integer');
  }
  state.budget.agentCalls += n;
}

export function addActiveSeconds(state, seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error('addActiveSeconds: seconds must be a number of 0 or more');
  }
  state.budget.activeSeconds += seconds;
}

export function addRepairAttempt(state, target) {
  if (target !== REVIEW_FIX_TARGET && !state.order.includes(target)) {
    throw new Error(`addRepairAttempt: unknown target "${target}"`);
  }
  state.budget.repairAttempts[target] = repairCount(state, target) + 1;
}

export function recordFailure(state, signature) {
  if (typeof signature !== 'string' || signature === '') {
    throw new Error('recordFailure: signature must be a non-empty string');
  }
  const f = state.budget.failureStreak;
  state.budget.failureStreak = { signature, count: f.signature === signature ? f.count + 1 : 1 };
  return state.budget.failureStreak.count >= SAME_FAILURE_LIMIT;
}

export function clearFailure(state) {
  state.budget.failureStreak = { signature: null, count: 0 };
}

export function remainingBudget(state, limits) {
  return {
    agentCalls: limits.maxAgentCalls - state.budget.agentCalls,
    activeSeconds: limits.runTimeoutSeconds - state.budget.activeSeconds,
    planRepairs: limits.maxPlanRepairs - state.budget.planRepairs,
    repairAttempts: (target) => limits.maxRepairAttempts - repairCount(state, target),
  };
}
