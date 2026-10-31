import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstLine } from '../util/proc.js';
import { runProcess } from './process.js';
import { cancelError, childEnv, commandProblem, isRelativeCommand, runTracked } from './verify.js';

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'workflow');
const RESULT_BYTES = 8 * 1024 * 1024;
const DEFAULT_RETRY_DELAY_MS = 5000;
const VERSION_TIMEOUT_MS = 10000;
const FENCE_OPEN = '```json';
const FENCE_CLOSE = '```';

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function template(name) {
  return fs.readFileSync(path.join(TEMPLATE_DIR, name), 'utf8');
}

function providerEnv(policy) {
  return childEnv(policy.provider.env);
}

export function providerProblem(policy) {
  const { command } = policy.provider;
  if (isRelativeCommand(command)) {
    return `provider.command ${command} must be a program name or an absolute path, because each call runs in a worktree`;
  }
  return commandProblem(command, providerEnv(policy));
}

export async function commandVersion(policy) {
  try {
    const r = await runProcess({ file: policy.provider.command, args: ['--version'], env: providerEnv(policy), timeoutMs: VERSION_TIMEOUT_MS });
    return r.exitCode === 0 && r.stdout.tail.trim() !== '' ? firstLine(r.stdout.tail) : 'unknown';
  } catch (err) {
    if (err.code !== 'E_WORKFLOW_SPAWN') {
      throw err;
    }
    return 'unknown';
  }
}

export function buildPrompt(request) {
  const parts = [template(`roles/${request.role}.md`)];
  if (request.role !== 'planner') {
    parts.push(template('result-format.md'));
  }
  parts.push(`## Request\n\n${FENCE_OPEN}\n${JSON.stringify(request, null, 2)}\n${FENCE_CLOSE}\n`);
  return parts.join('\n');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return undefined;
    }
    throw err;
  }
}

export function readResultJson(output) {
  if (output.truncated) {
    return undefined;
  }
  const text = output.tail.trim();
  const whole = parseJson(text);
  if (whole !== undefined) {
    return whole;
  }
  const close = text.lastIndexOf(FENCE_CLOSE);
  const open = close > 0 ? text.lastIndexOf(FENCE_OPEN, close - 1) : -1;
  return open < 0 ? undefined : parseJson(text.slice(open + FENCE_OPEN.length, close));
}

export function createProvider({ policy, cwd, signal = null, retryDelayMs = DEFAULT_RETRY_DELAY_MS, onDiagnostic = () => {}, track = null }) {
  const { command, args, roleArgs } = policy.provider;
  const env = providerEnv(policy);
  return {
    async call(request) {
      const r = await runTracked(track, { role: request.role, stepId: request.stepId, attempt: request.attempt }, {
        file: command,
        args: roleArgs[request.role] || args,
        cwd,
        env,
        input: buildPrompt(request),
        signal,
        timeoutMs: policy.limits.stepTimeoutSeconds * 1000,
        tailBytes: RESULT_BYTES,
      });
      if (r.cancelled) {
        throw cancelError(`the ${request.role} call`, r);
      }
      if (r.timedOut) {
        onDiagnostic('timeout', request, r);
        throw Object.assign(new Error(`the ${request.role} call timed out`), { timeout: true });
      }
      if (r.exitCode !== 0) {
        const code = r.exitCode === null ? `signal-${r.signal}` : `exit-${r.exitCode}`;
        onDiagnostic('failed', request, r);
        await delay(retryDelayMs);
        throw Object.assign(new Error(`the ${request.role} call ended with ${code}`), { transport: true, code });
      }
      const result = readResultJson(r.stdout);
      if (result === undefined) {
        onDiagnostic('unreadable', request, r);
      }
      return result;
    },
  };
}
