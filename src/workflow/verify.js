import path from 'node:path';
import { which } from '../util/proc.js';
import { runProcess } from './process.js';
import { sanitizeEventData } from './store.js';

const BASE_ENV = ['PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'];

export const EXIT_TIMED_OUT = 124;
export const EXIT_KILLED = 137;
export const EXIT_NOT_STARTED = 127;

const MAX_FAILED_TESTS = 200;

export function childEnv(extra = [], source = process.env) {
  const env = {};
  for (const name of [...BASE_ENV, ...extra]) {
    if (source[name] !== undefined) {
      env[name] = source[name];
    }
  }
  return env;
}

export function isRelativeCommand(command) {
  return !path.isAbsolute(command) && /[\\/]/.test(command);
}

export function commandProblem(command, env) {
  const found = which(command, env);
  if (!found) {
    return `${command} was not found`;
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(found)) {
    return `${found} is a batch file, which needs a shell; name the program it starts instead, with its script as the first argument`;
  }
  return null;
}

export function checkCommandProblem(checks, env = childEnv(), label = 'check') {
  for (const check of checks) {
    const problem = isRelativeCommand(check.command) ? null : commandProblem(check.command, env);
    if (problem) {
      return `${label} "${check.id}": ${problem}`;
    }
  }
  return null;
}

function unconfirmedEnd({ remaining, supported }) {
  if (remaining.length > 0) {
    return `${remaining.length} process(es) could not be ended`;
  }
  return supported ? 'the end of the processes it started could not be confirmed' : 'on this system only the direct child is ended, so its descendants may keep running';
}

export function cancelError(what, result) {
  const confirmed = !result.started || result.tree.confirmed;
  const message = confirmed ? `${what} was cancelled` : `${what} was cancelled, but ${unconfirmedEnd(result.tree)}`;
  return Object.assign(new Error(message), { cancelled: confirmed, cancelRequested: true });
}

export async function runTracked(track, what, options) {
  if (!track) {
    return runProcess(options);
  }
  track.starting(what);
  let result;
  try {
    result = await runProcess({ ...options, onSpawn: (owner) => track.started(what, owner) });
  } catch (err) {
    if (err.code === 'E_WORKFLOW_SPAWN') {
      track.ended(what, null);
    }
    throw err;
  }
  track.ended(what, result);
  return result;
}

function logLines(output) {
  return sanitizeEventData(output.tail.split('\n'));
}

function failedTestNames(pattern, lines) {
  const names = new Set();
  const re = new RegExp(pattern, 'g');
  for (const line of lines) {
    for (const m of line.matchAll(re)) {
      if (m[1]) {
        names.add(m[1]);
      }
    }
  }
  return [...names].sort().slice(0, MAX_FAILED_TESTS);
}

async function runCommand(item, label, what, { worktree, signal, env, track, startFailureIsResult }) {
  let r;
  try {
    r = await runTracked(track, what, { file: item.command, args: item.args, cwd: path.join(worktree, item.cwd), env, signal, timeoutMs: item.timeout * 1000 });
  } catch (err) {
    if (!startFailureIsResult || err.code !== 'E_WORKFLOW_SPAWN') {
      throw err;
    }
    return { id: item.id, exitCode: EXIT_NOT_STARTED, timedOut: false, completed: false, stdout: [], stderr: sanitizeEventData([err.message]), failedTests: [] };
  }
  if (r.cancelled) {
    throw cancelError(label, r);
  }
  const exitCode = r.timedOut ? EXIT_TIMED_OUT : r.exitCode === null ? EXIT_KILLED : r.exitCode;
  const stdout = logLines(r.stdout);
  const stderr = logLines(r.stderr);
  const failedTests = item.failedTestPattern && exitCode !== 0 ? failedTestNames(item.failedTestPattern, [...stdout, ...stderr]) : [];
  return { id: item.id, exitCode, timedOut: r.timedOut, completed: !r.timedOut && r.exitCode !== null, stdout, stderr, failedTests };
}

export async function runChecks({ checks, checkIds, worktree, signal = null, env = childEnv(), track = null, stepId = null, startFailureIsResult = false }) {
  const results = [];
  for (const id of checkIds) {
    const check = checks.find((c) => c.id === id);
    if (!check) {
      throw new Error(`check "${id}" is not in the policy`);
    }
    results.push(await runCommand(check, `check "${id}"`, { stepId, checkId: id }, { worktree, signal, env, track, startFailureIsResult }));
  }
  return results;
}

export async function runSetup({ setup, worktree, signal = null, env = childEnv(), track = null }) {
  const results = [];
  for (const item of setup) {
    const r = await runCommand(item, `setup command "${item.id}"`, { stepId: null, setupId: item.id }, { worktree, signal, env, track, startFailureIsResult: true });
    results.push(r);
    if (r.exitCode !== 0) {
      break;
    }
  }
  return results;
}
