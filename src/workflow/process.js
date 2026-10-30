import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { firstLine, which } from '../util/proc.js';

export const TREE_KILL_SUPPORTED = process.platform === 'linux';

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_GRACE_MS = 5000;
const DEFAULT_DRAIN_MS = 2000;
const TRACK_INTERVAL_MS = 200;
const SHUTDOWN_POLL_MS = 50;
const CONFIRM_MS = 2000;
const MAX_LINE_ERRORS = 100;
const DEAD_STATES = ['Z', 'X', 'x'];
const PROCESS_GONE_CODES = ['ENOENT', 'ESRCH', 'EACCES'];
const RELAY_NAME = 'agent-layers-relay';
const RELAY_SCRIPT = 'set -o pipefail; { "$@" 2>&1 1>&4 4>&- | cat >&2 4>&-; } 4>&1 | cat';
const RELAY_PROBE = 'printf out; printf err >&2; exit 7';
const RELAY_PROBE_TIMEOUT_MS = 10000;

function spawnError(file, reason, cause) {
  const err = new Error(`cannot start ${file}: ${reason}`, cause ? { cause } : undefined);
  err.code = 'E_WORKFLOW_SPAWN';
  return err;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function settlesWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export function parseProcStat(text) {
  const open = text.indexOf(' (');
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(' ');
  return { pid: Number(text.slice(0, open)), state: fields[0], ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]), startTime: fields[19] };
}

function readProcessTable(root = '/proc') {
  const table = new Map();
  for (const name of fs.readdirSync(root)) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(`${root}/${name}/stat`, 'utf8');
    } catch (err) {
      if (PROCESS_GONE_CODES.includes(err.code)) {
        continue;
      }
      throw err;
    }
    const info = parseProcStat(text);
    table.set(info.pid, info);
  }
  return table;
}

function processKey(p) {
  return `${p.pid}:${p.startTime}`;
}

//20261031 TODO A double-forked process that left its session before a poll saw it is not found; settle this in W4b after the Linux run
export function createTracker(root, readTable = readProcessTable) {
  const tracked = new Map([[processKey(root), { pid: root.pid, startTime: root.startTime, pgid: root.pid }]]);
  const groups = new Set([root.pid]);
  const sessions = new Set([root.pid]);
  let table = new Map();

  function adopt() {
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of table.values()) {
        const parent = table.get(p.ppid);
        const owned = sessions.has(p.sid) || (parent && tracked.has(processKey(parent)));
        if (owned && !tracked.has(processKey(p))) {
          tracked.set(processKey(p), { pid: p.pid, startTime: p.startTime, pgid: p.pgid });
          groups.add(p.pgid);
          sessions.add(p.sid);
          grew = true;
        }
      }
    }
  }

  function retire() {
    const all = [...table.values()];
    const usedGroups = new Set(all.map((p) => p.pgid));
    const usedSessions = new Set(all.map((p) => p.sid));
    for (const g of groups) {
      if (!usedGroups.has(g)) {
        groups.delete(g);
      }
    }
    for (const s of sessions) {
      if (!usedSessions.has(s)) {
        sessions.delete(s);
      }
    }
    for (const [key, entry] of tracked) {
      if (!table.has(entry.pid) || processKey(table.get(entry.pid)) !== key) {
        tracked.delete(key);
      }
    }
  }

  return {
    refresh() {
      table = readTable();
      adopt();
      retire();
    },
    live() {
      return [...tracked.values()].filter((e) => table.has(e.pid) && !DEAD_STATES.includes(table.get(e.pid).state));
    },
    groupsToSignal() {
      const childGroups = [...groups].filter((g) => g !== root.pid);
      return groups.has(root.pid) ? [...childGroups, root.pid] : childGroups;
    },
  };
}

function sendSignal(target, name, errors) {
  try {
    process.kill(target, name);
  } catch (err) {
    if (err.code !== 'ESRCH') {
      errors.push({ target, signal: name, code: err.code });
    }
  }
}

async function terminateTree(tracker, graceMs, signalErrors) {
  tracker.refresh();
  for (const group of tracker.groupsToSignal()) {
    sendSignal(-group, 'SIGTERM', signalErrors);
  }
  const graceEnd = Date.now() + graceMs;
  while (tracker.live().length > 0 && Date.now() < graceEnd) {
    await delay(Math.min(SHUTDOWN_POLL_MS, Math.max(1, graceEnd - Date.now())));
    tracker.refresh();
  }
  const confirmEnd = Date.now() + CONFIRM_MS;
  for (;;) {
    const left = tracker.live();
    if (left.length === 0 || Date.now() >= confirmEnd) {
      return left;
    }
    for (const p of left) {
      sendSignal(p.pid, 'SIGKILL', signalErrors);
    }
    await delay(SHUTDOWN_POLL_MS);
    tracker.refresh();
  }
}

async function terminateChild(child, graceMs, exit) {
  child.kill('SIGTERM');
  if (!(await settlesWithin(exit, graceMs))) {
    child.kill('SIGKILL');
  }
  return [];
}

function createTail(maxBytes) {
  let kept = Buffer.alloc(0);
  let bytes = 0;
  return {
    push(chunk) {
      bytes += chunk.length;
      kept = Buffer.concat([kept, chunk]);
      if (kept.length > maxBytes) {
        kept = kept.subarray(kept.length - maxBytes);
      }
    },
    result() {
      let start = 0;
      if (bytes > kept.length) {
        while (start < kept.length && (kept[start] & 0xc0) === 0x80) {
          start += 1;
        }
      }
      return { bytes, truncated: bytes > kept.length, tail: kept.subarray(start).toString('utf8') };
    },
  };
}

export function createLineCollector({ onEvent, maxLineBytes = DEFAULT_MAX_LINE_BYTES, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES }) {
  let parts = [];
  let partBytes = 0;
  let tooLong = false;
  let line = 0;
  let events = 0;
  let received = 0;
  let truncated = false;
  let errorCount = 0;
  const errors = [];

  function addError(kind, at) {
    errorCount += 1;
    if (errors.length < MAX_LINE_ERRORS) {
      errors.push({ kind, line: at });
    }
  }

  function append(part) {
    if (tooLong || part.length === 0) {
      return;
    }
    if (partBytes + part.length > maxLineBytes) {
      tooLong = true;
      parts = [];
      partBytes = 0;
      return;
    }
    parts.push(part);
    partBytes += part.length;
  }

  function endLine() {
    line += 1;
    const wasTooLong = tooLong;
    const text = Buffer.concat(parts).toString('utf8');
    parts = [];
    partBytes = 0;
    tooLong = false;
    if (wasTooLong) {
      addError('line-too-long', line);
      return;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      addError('not-json', line);
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      addError('not-object', line);
      return;
    }
    events += 1;
    onEvent(value);
  }

  return {
    push(chunk) {
      const room = maxOutputBytes - received;
      received += chunk.length;
      if (room <= 0) {
        truncated = true;
        return;
      }
      let data = chunk;
      if (chunk.length > room) {
        truncated = true;
        data = chunk.subarray(0, room);
      }
      let start = 0;
      for (;;) {
        const nl = data.indexOf(0x0a, start);
        if (nl === -1) {
          break;
        }
        append(data.subarray(start, nl));
        start = nl + 1;
        endLine();
      }
      append(data.subarray(start));
    },
    finish() {
      if (truncated) {
        return;
      }
      if (tooLong) {
        addError('line-too-long', line + 1);
      } else if (partBytes > 0) {
        addError('unterminated', line + 1);
      }
    },
    result() {
      return { lines: line, events, bytes: received, truncated, errors, errorCount };
    },
  };
}

function ownerOf(pid) {
  if (!TREE_KILL_SUPPORTED) {
    return { pid, startTime: null, pgid: null };
  }
  try {
    return { pid, startTime: parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')).startTime, pgid: pid };
  } catch (err) {
    if (PROCESS_GONE_CODES.includes(err.code)) {
      return { pid, startTime: null, pgid: pid };
    }
    throw err;
  }
}

function withResult(err, result) {
  const out = err instanceof Error && Object.isExtensible(err) ? err : new Error(String(err), { cause: err });
  out.processResult = result;
  return out;
}

function assertStartable(file, env) {
  if (env === null || typeof env !== 'object') {
    throw new TypeError('runProcess needs an explicit env object; the parent environment is never passed on');
  }
  if (typeof file !== 'string' || file === '') {
    throw new TypeError('runProcess needs the program file as a non-empty string');
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    throw spawnError(file, 'a batch file needs a shell, and workflow processes never use one');
  }
}

export async function runProcess({
  file, args = [], cwd, env, input = null, timeoutMs = null, signal = null, onSpawn = null, onEvent = null,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, tailBytes = DEFAULT_TAIL_BYTES,
  graceMs = DEFAULT_GRACE_MS, drainMs = DEFAULT_DRAIN_MS,
}) {
  assertStartable(file, env);
  const stdout = createTail(tailBytes);
  const stderr = createTail(tailBytes);
  const lines = onEvent ? createLineCollector({ onEvent, maxLineBytes, maxOutputBytes }) : null;
  if (signal && signal.aborted) {
    return {
      owner: null, exitCode: null, signal: null, timedOut: false, cancelled: true, started: false,
      stdout: stdout.result(), stderr: stderr.result(), jsonl: lines ? lines.result() : null, stdinError: null,
      tree: { supported: TREE_KILL_SUPPORTED, confirmed: TREE_KILL_SUPPORTED, remaining: [], leftovers: 0, outputHeldOpen: false, signalErrors: [] },
    };
  }

  let child;
  try {
    child = spawn(file, args, { cwd, env, shell: false, detached: TREE_KILL_SUPPORTED, windowsHide: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  } catch (err) {
    throw spawnError(file, `${err.code || err.message} in ${cwd || process.cwd()}`, err);
  }
  if (child.pid === undefined) {
    const err = await new Promise((resolve) => {
      child.once('error', resolve);
    });
    throw spawnError(file, `${err.code || err.message} in ${cwd || process.cwd()}`, err);
  }

  let timedOut = false;
  let cancelled = false;
  let failed = false;
  let failure = null;
  let stopping = null;
  let leftovers = 0;
  let stdinError = null;
  let trackingFailed = false;
  let giveUp;
  const signalErrors = [];
  const owner = ownerOf(child.pid);
  const tracker = TREE_KILL_SUPPORTED ? createTracker(owner) : null;
  const gaveUp = new Promise((resolve) => {
    giveUp = resolve;
  });
  const exit = new Promise((resolve) => {
    child.once('exit', (code, name) => resolve({ code, name }));
  });
  const closed = new Promise((resolve) => {
    child.once('close', resolve);
  });

  function stop() {
    if (stopping) {
      return stopping;
    }
    const work = tracker ? terminateTree(tracker, graceMs, signalErrors) : terminateChild(child, graceMs, exit);
    stopping = work.catch((err) => {
      trackingFailed = true;
      if (!failed) {
        failed = true;
        failure = err;
      }
      sendSignal(tracker ? -owner.pid : child.pid, 'SIGKILL', signalErrors);
      return null;
    });
    stopping.then(() => settlesWithin(exit, drainMs)).then(() => giveUp(null));
    return stopping;
  }

  function fail(err) {
    if (!failed) {
      failed = true;
      failure = err;
    }
    stop();
  }

  child.on('error', fail);
  child.stdout.on('error', fail);
  child.stderr.on('error', fail);
  child.stdout.on('data', (chunk) => {
    stdout.push(chunk);
    if (lines && !failed) {
      try {
        lines.push(chunk);
      } catch (err) {
        fail(err);
      }
    }
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  if (input !== null) {
    child.stdin.on('error', (err) => {
      stdinError = err.code || err.message;
    });
    child.stdin.end(input);
  }

  const timer = timeoutMs === null ? null : setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  const onAbort = () => {
    cancelled = true;
    stop();
  };
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const refresh = () => {
    try {
      tracker.refresh();
    } catch (err) {
      trackingFailed = true;
      fail(err);
    }
  };
  const poll = tracker ? setInterval(refresh, TRACK_INTERVAL_MS) : null;
  if (tracker) {
    refresh();
  }
  if (onSpawn) {
    try {
      onSpawn(owner);
    } catch (err) {
      fail(err);
    }
  }

  const ended = await Promise.race([exit, gaveUp]);
  clearTimeout(timer);
  clearInterval(poll);
  if (signal) {
    signal.removeEventListener('abort', onAbort);
  }
  if (tracker && !stopping) {
    refresh();
    leftovers = stopping ? 0 : tracker.live().length;
    if (leftovers > 0) {
      stop();
    }
  }
  const remaining = stopping ? await stopping : [];
  const drained = await settlesWithin(closed, drainMs);
  if (!drained) {
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.stdin) {
      child.stdin.destroy();
    }
    child.unref();
  }
  if (lines && !failed) {
    lines.finish();
  }
  const result = {
    owner,
    exitCode: ended ? ended.code : null,
    signal: ended ? ended.name : null,
    timedOut,
    cancelled,
    started: true,
    stdout: stdout.result(),
    stderr: stderr.result(),
    jsonl: lines ? lines.result() : null,
    stdinError,
    tree: {
      supported: TREE_KILL_SUPPORTED,
      confirmed: TREE_KILL_SUPPORTED && owner.startTime !== null && !trackingFailed && drained && ended !== null && remaining !== null && remaining.length === 0,
      remaining,
      leftovers,
      outputHeldOpen: !drained,
      signalErrors,
    },
  };
  if (failed) {
    throw withResult(failure, result);
  }
  return result;
}

export function relayCommand(bash, file, args = []) {
  return { file: bash, args: ['-c', RELAY_SCRIPT, RELAY_NAME, file, ...args] };
}

export function relayCapability(env) {
  if (!TREE_KILL_SUPPORTED) {
    return { ok: false, reason: 'the OS pipe relay is only supported on Linux' };
  }
  const bash = which('bash', env);
  if (!bash) {
    return { ok: false, reason: 'bash was not found on the PATH of the given environment' };
  }
  const { file, args } = relayCommand(bash, bash, ['-c', RELAY_PROBE]);
  const probe = spawnSync(file, args, { env, encoding: 'utf8', timeout: RELAY_PROBE_TIMEOUT_MS });
  if (probe.status !== 7 || probe.stdout !== 'out' || probe.stderr !== 'err') {
    return { ok: false, reason: `the relay probe returned exit ${probe.status} instead of passing exit 7 and both streams through` };
  }
  const version = spawnSync(bash, ['--version'], { env, encoding: 'utf8', timeout: RELAY_PROBE_TIMEOUT_MS });
  return { ok: true, bash, version: firstLine(version.stdout) };
}
