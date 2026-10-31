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

export function cancelError(what, result) {
  const left = result.tree.remaining.length;
  const message = left > 0 ? `${what} was cancelled, but ${left} process(es) could not be ended` : `${what} was cancelled`;
  return Object.assign(new Error(message), { cancelled: left === 0 });
}

function logLines(output) {
  return sanitizeEventData(output.tail.split('\n'));
}

export async function runChecks({ checks, checkIds, worktree, signal = null, env = childEnv() }) {
  const results = [];
  for (const id of checkIds) {
    const check = checks.find((c) => c.id === id);
    if (!check) {
      throw new Error(`check "${id}" is not in the policy`);
    }
    const r = await runProcess({ file: check.command, args: check.args, cwd: path.join(worktree, check.cwd), env, signal, timeoutMs: check.timeout * 1000 });
    if (r.cancelled) {
      throw cancelError(`check "${id}"`, r);
    }
    const exitCode = r.timedOut ? EXIT_TIMED_OUT : r.exitCode === null ? EXIT_KILLED : r.exitCode;
    results.push({ id, exitCode, timedOut: r.timedOut, stdout: logLines(r.stdout), stderr: logLines(r.stderr) });
  }
  return results;
}
