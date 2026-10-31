import path from 'node:path';
import { which } from '../util/proc.js';
import { runProcess } from './process.js';
import { sanitizeEventData } from './store.js';

const BASE_ENV = ['PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'];

export const EXIT_TIMED_OUT = 124;
export const EXIT_KILLED = 137;

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

export function checkCommandProblem(checks, env = childEnv()) {
  for (const check of checks) {
    const problem = isRelativeCommand(check.command) ? null : commandProblem(check.command, env);
    if (problem) {
      return `check "${check.id}": ${problem}`;
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

export async function runChecks({ checks, checkIds, worktree, signal = null, env = childEnv(), track = null, stepId = null }) {
  const results = [];
  for (const id of checkIds) {
    const check = checks.find((c) => c.id === id);
    if (!check) {
      throw new Error(`check "${id}" is not in the policy`);
    }
    const r = await runTracked(track, { stepId, checkId: id }, { file: check.command, args: check.args, cwd: path.join(worktree, check.cwd), env, signal, timeoutMs: check.timeout * 1000 });
    if (r.cancelled) {
      throw cancelError(`check "${id}"`, r);
    }
    const exitCode = r.timedOut ? EXIT_TIMED_OUT : r.exitCode === null ? EXIT_KILLED : r.exitCode;
    results.push({ id, exitCode, timedOut: r.timedOut, stdout: logLines(r.stdout), stderr: logLines(r.stderr) });
  }
  return results;
}
