import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getEventListeners } from 'node:events';
import { spawnSync } from 'node:child_process';
import {
  runProcess, createLineCollector, createTracker, parseProcStat, relayCommand, relayCapability, TREE_KILL_SUPPORTED,
} from '../src/workflow/process.js';
import { which } from '../src/util/proc.js';

const IS_LINUX = process.platform === 'linux';
const LINUX_ONLY = IS_LINUX ? false : 'Linux only: tree termination needs /proc and process groups';
const BASE_ENV = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
const SLEEP = 'setInterval(() => {}, 1000)';
const HANG_LIMIT = { timeout: 30000 };
const BASH = usableBash();
const NEEDS_BASH = BASH ? false : 'needs a working bash on PATH';

function usableBash() {
  const bash = which('bash', process.env);
  if (!bash) {
    return null;
  }
  const probe = spawnSync(bash, ['-c', 'set -o pipefail; printf ok | cat'], { encoding: 'utf8', timeout: 10000 });
  return probe.status === 0 && probe.stdout === 'ok' ? bash : null;
}

function node(code, options = {}) {
  return runProcess({ file: process.execPath, args: ['-e', code], env: BASE_ENV, ...options });
}

function isGone(pid) {
  try {
    return parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')).state === 'Z';
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ESRCH') {
      return true;
    }
    throw err;
  }
}

function killAll(t, pids) {
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        if (err.code !== 'ESRCH') {
          throw err;
        }
      }
    }
  });
}

function endsWithTest(t) {
  const pids = [];
  killAll(t, pids);
  return (owner) => pids.push(owner.pid);
}

function table(rows) {
  return new Map(rows.map(([pid, ppid, pgid, sid, startTime, state = 'S']) => [pid, { pid, ppid, pgid, sid, startTime, state }]));
}

function scripted(tracker, snapshots) {
  let i = 0;
  const instance = createTracker(tracker, () => snapshots[i++]);
  return instance;
}

function livePids(tracker) {
  return tracker.live().map((p) => p.pid).sort((a, b) => a - b);
}

test('workflow process: stdout lines arrive as JSON events in order', async () => {
  const events = [];
  const r = await node('console.log(JSON.stringify({ n: 1 })); console.log(JSON.stringify({ n: 2 }));', { onEvent: (e) => events.push(e) });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(events, [{ n: 1 }, { n: 2 }]);
  assert.equal(r.jsonl.lines, 2);
  assert.equal(r.jsonl.events, 2);
  assert.deepEqual(r.jsonl.errors, []);
  assert.equal(r.jsonl.truncated, false);
});

test('workflow process: an unterminated last line is an error and is not delivered', async () => {
  const events = [];
  const r = await node(`process.stdout.write('{"a":1}\\n{"b":2}')`, { onEvent: (e) => events.push(e) });
  assert.deepEqual(events, [{ a: 1 }]);
  assert.deepEqual(r.jsonl.errors, [{ kind: 'unterminated', line: 2 }]);
  assert.equal(r.jsonl.errorCount, 1);
});

test('workflow process: lines that are not JSON objects are errors and later lines still arrive', async () => {
  const events = [];
  const r = await node(`process.stdout.write('hello\\n\\n7\\nnull\\n[1]\\n{"ok":true}\\n')`, { onEvent: (e) => events.push(e) });
  assert.deepEqual(events, [{ ok: true }]);
  assert.deepEqual(r.jsonl.errors, [
    { kind: 'not-json', line: 1 },
    { kind: 'not-json', line: 2 },
    { kind: 'not-object', line: 3 },
    { kind: 'not-object', line: 4 },
    { kind: 'not-object', line: 5 },
  ]);
});

test('workflow process: a line over the limit is marked, not parsed, and the next line still arrives', async () => {
  const events = [];
  const r = await node(`process.stdout.write('{"long":"' + 'x'.repeat(200) + '"}\\n{"n":1}\\n')`, { onEvent: (e) => events.push(e), maxLineBytes: 50 });
  assert.deepEqual(events, [{ n: 1 }]);
  assert.deepEqual(r.jsonl.errors, [{ kind: 'line-too-long', line: 1 }]);
});

test('workflow process: output over the total limit is marked as truncated, keeps only the tail, and the child still finishes', async () => {
  const events = [];
  const code = `for (let i = 0; i < 2000; i += 1) { console.log(JSON.stringify({ i })); }`;
  const r = await node(code, { onEvent: (e) => events.push(e), maxOutputBytes: 500, tailBytes: 64 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.jsonl.truncated, true);
  assert.ok(events.length > 0 && events.length < 2000, `${events.length} events`);
  assert.deepEqual(events[0], { i: 0 });
  assert.ok(r.jsonl.bytes > 500);
  assert.equal(r.stdout.truncated, true);
  assert.ok(Buffer.byteLength(r.stdout.tail) <= 64);
  assert.match(r.stdout.tail, /\{"i":1999\}\s*$/);
  assert.deepEqual(r.jsonl.errors, []);
});

test('workflow process: a tail cut in the middle of a multibyte letter still reads as clean text', async () => {
  const r = await node(`process.stdout.write('한'.repeat(100))`, { tailBytes: 10 });
  assert.equal(r.stdout.truncated, true);
  assert.equal(r.stdout.bytes, 300);
  assert.equal(r.stdout.tail, '한'.repeat(3));
});

test('workflow process: the collector joins lines and multibyte text split across chunks', () => {
  const events = [];
  const collector = createLineCollector({ onEvent: (e) => events.push(e) });
  const line = Buffer.from('{"text":"한글"}\n{"n":2}\n');
  for (let i = 0; i < line.length; i += 1) {
    collector.push(line.subarray(i, i + 1));
  }
  collector.finish();
  assert.deepEqual(events, [{ text: '한글' }, { n: 2 }]);
  assert.deepEqual(collector.result().errors, []);
});

test('workflow process: the collector cuts a chunk at the total limit and does not report the cut line as an error', () => {
  const events = [];
  const collector = createLineCollector({ onEvent: (e) => events.push(e), maxOutputBytes: 10 });
  collector.push(Buffer.from('{"a":1}\n{"b":2}\n'));
  collector.push(Buffer.from('{"c":3}\n'.repeat(4)));
  collector.finish();
  assert.deepEqual(events, [{ a: 1 }]);
  assert.deepEqual(collector.result(), { lines: 1, events: 1, bytes: 48, truncated: true, errors: [], errorCount: 0 });
});

test('workflow process: a last line over the limit without a line end is still reported as too long', () => {
  const collector = createLineCollector({ onEvent: () => {}, maxLineBytes: 4 });
  collector.push(Buffer.from('{"a":1}'));
  collector.finish();
  assert.deepEqual(collector.result().errors, [{ kind: 'line-too-long', line: 1 }]);
});

test('workflow process: the collector keeps a bounded list of line errors and still counts them all', () => {
  const collector = createLineCollector({ onEvent: () => {} });
  collector.push(Buffer.from('x\n'.repeat(1000)));
  collector.finish();
  const r = collector.result();
  assert.equal(r.errors.length, 100);
  assert.equal(r.errorCount, 1000);
});

test('workflow process: stdin reaches the child and the exit code and stderr tail come back', async () => {
  const code = `let s = ''; process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => { process.stderr.write('got:' + s); process.exitCode = 3; });`;
  const r = await node(code, { input: 'prompt text' });
  assert.equal(r.exitCode, 3);
  assert.equal(r.signal, null);
  assert.equal(r.stderr.tail, 'got:prompt text');
  assert.equal(r.stderr.truncated, false);
  assert.equal(r.stdinError, null);
  assert.equal(r.jsonl, null);
});

test('workflow process: a child that stops reading stdin does not crash the parent', async () => {
  const r = await node('process.exitCode = 0;', { input: 'x'.repeat(4 * 1024 * 1024) });
  assert.equal(r.exitCode, 0);
});

test('workflow process: a timeout ends the child and is reported', HANG_LIMIT, async (t) => {
  const started = Date.now();
  const r = await node(SLEEP, { timeoutMs: 300, graceMs: 2000, onSpawn: endsWithTest(t) });
  assert.equal(r.timedOut, true);
  assert.equal(r.cancelled, false);
  assert.notEqual(r.exitCode, 0);
  assert.ok(Date.now() - started < 10000);
});

test('workflow process: a finished child is not reported as timed out and leaves no timer or abort listener behind', async () => {
  const abort = new AbortController();
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const before = timers();
  const r = await node('process.exitCode = 0;', { timeoutMs: 60000, signal: abort.signal });
  assert.equal(r.timedOut, false);
  assert.equal(r.cancelled, false);
  assert.equal(r.exitCode, 0);
  assert.equal(timers(), before);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('workflow process: a cancel ends the child and is reported', HANG_LIMIT, async (t) => {
  const abort = new AbortController();
  const r = await node(`console.log('{"ready":true}'); ${SLEEP}`, { signal: abort.signal, graceMs: 2000, onSpawn: endsWithTest(t), onEvent: () => abort.abort() });
  assert.equal(r.cancelled, true);
  assert.equal(r.timedOut, false);
  assert.equal(r.started, true);
});

test('workflow process: a cancel that came before the start runs nothing', HANG_LIMIT, async (t) => {
  const abort = new AbortController();
  abort.abort();
  let spawned = false;
  const track = endsWithTest(t);
  const r = await node(SLEEP, {
    signal: abort.signal,
    onSpawn: (owner) => {
      spawned = true;
      track(owner);
    },
  });
  assert.equal(r.started, false);
  assert.equal(r.cancelled, true);
  assert.equal(r.owner, null);
  assert.equal(spawned, false);
});

test('workflow process: the child sees only the given environment', async (t) => {
  process.env.AGENT_LAYERS_PARENT_ONLY = 'parent';
  t.after(() => {
    delete process.env.AGENT_LAYERS_PARENT_ONLY;
  });
  const code = `console.log(JSON.stringify({ parent: process.env.AGENT_LAYERS_PARENT_ONLY || null, given: process.env.AGENT_LAYERS_GIVEN || null }))`;
  const events = [];
  await runProcess({ file: process.execPath, args: ['-e', code], env: { ...BASE_ENV, AGENT_LAYERS_GIVEN: 'given' }, onEvent: (e) => events.push(e) });
  assert.deepEqual(events, [{ parent: null, given: 'given' }]);
});

test('workflow process: an environment is required, so the parent environment can never be inherited by accident', async () => {
  await assert.rejects(runProcess({ file: process.execPath, args: ['-e', ''] }), /explicit env/);
  await assert.rejects(runProcess({ file: process.execPath, args: ['-e', ''], env: null }), /explicit env/);
});

test('workflow process: a program that cannot start is a clear error', async () => {
  await assert.rejects(
    runProcess({ file: 'agent-layers-no-such-program', env: BASE_ENV }),
    (err) => err.code === 'E_WORKFLOW_SPAWN' && /agent-layers-no-such-program/.test(err.message) && /ENOENT/.test(err.message),
  );
  await assert.rejects(
    runProcess({ file: process.execPath, cwd: 'agent-layers-no-such-folder', env: BASE_ENV }),
    (err) => err.code === 'E_WORKFLOW_SPAWN' && /agent-layers-no-such-folder/.test(err.message),
  );
});

test('workflow process: on Windows a batch file is refused instead of going through a shell', { skip: process.platform === 'win32' ? false : 'Windows only' }, async () => {
  await assert.rejects(
    runProcess({ file: 'C:\\tools\\codex.cmd', env: BASE_ENV }),
    (err) => err.code === 'E_WORKFLOW_SPAWN' && /batch file/.test(err.message),
  );
});

test('workflow process: arguments reach the child unchanged because no shell is used', async () => {
  const special = ['$(echo hacked)', '`echo hacked`', 'a b', '"q"', "'s'", '*', ';', '&&', '|', '%PATH%', '$HOME'];
  const events = [];
  await runProcess({
    file: process.execPath,
    args: ['-e', 'console.log(JSON.stringify({ argv: process.argv.slice(1) }))', '--', ...special],
    env: BASE_ENV,
    onEvent: (e) => events.push(e),
  });
  assert.deepEqual(events, [{ argv: special }]);
});

test('workflow process: an error from the event callback ends the child and rejects with the result attached', HANG_LIMIT, async (t) => {
  const boom = new Error('event handler failed');
  await assert.rejects(
    node(`console.log('{"n":1}'); console.log('{"n":2}'); ${SLEEP}`, { graceMs: 2000, onSpawn: endsWithTest(t), onEvent: () => { throw boom; } }),
    (err) => {
      assert.equal(err, boom);
      assert.equal(err.processResult.jsonl.events, 1);
      assert.notEqual(err.processResult.exitCode, 0);
      return true;
    },
  );
});

test('workflow process: an error from onSpawn ends the child and rejects', HANG_LIMIT, async (t) => {
  const boom = new Error('could not record the owner');
  const track = endsWithTest(t);
  const onSpawn = (owner) => {
    track(owner);
    throw boom;
  };
  await assert.rejects(node(SLEEP, { graceMs: 2000, onSpawn }), (err) => err === boom && err.processResult.started === true);
});

test('workflow process: the owner is reported at the start and in the result', async () => {
  let seen = null;
  const r = await node('process.exitCode = 0;', { onSpawn: (o) => { seen = o; } });
  assert.deepEqual(seen, r.owner);
  assert.ok(Number.isInteger(r.owner.pid) && r.owner.pid > 0);
  if (IS_LINUX) {
    assert.match(r.owner.startTime, /^\d+$/);
    assert.equal(r.owner.pgid, r.owner.pid);
  } else {
    assert.equal(r.owner.startTime, null);
    assert.equal(r.owner.pgid, null);
  }
});

test('workflow process: outside Linux the result says tree termination is not guaranteed', { skip: IS_LINUX ? 'not Linux only' : false }, async () => {
  const r = await node('process.exitCode = 0;');
  assert.equal(TREE_KILL_SUPPORTED, false);
  assert.equal(r.tree.supported, false);
  assert.equal(r.tree.confirmed, false);
});

test('workflow process: outside Linux a process that keeps the output pipe open does not hold up the result', { skip: IS_LINUX ? 'not Linux only' : false }, async (t) => {
  const pids = [];
  killAll(t, pids);
  const code = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(SLEEP)}], { stdio: ['ignore', 'inherit', 'ignore'], detached: true }); c.unref(); console.log(JSON.stringify({ pid: c.pid }));`;
  const pipes = () => process.getActiveResourcesInfo().filter((name) => name === 'PipeWrap').length;
  const before = pipes();
  const r = await node(code, { drainMs: 500, onEvent: (e) => pids.push(e.pid) });
  assert.equal(pids.length, 1);
  assert.equal(r.exitCode, 0);
  assert.equal(r.tree.outputHeldOpen, true);
  assert.equal(r.tree.confirmed, false);
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
  assert.equal(pipes(), before);
});

test('workflow process: /proc stat parsing handles spaces and parentheses in the program name', () => {
  const rest = Array.from({ length: 49 }, (_, i) => String(i + 100));
  rest[0] = '4242';
  rest[1] = '4243';
  rest[2] = '4244';
  rest[18] = '987654';
  const text = `4241 (a b) (c)) S ${rest.join(' ')}\n`;
  assert.deepEqual(parseProcStat(text), { pid: 4241, state: 'S', ppid: 4242, pgid: 4243, sid: 4244, startTime: '987654' });
});

test('workflow process: the tracker finds children and a grandchild in its own session, and signals the child groups first', () => {
  const tracker = scripted({ pid: 100, startTime: 'r' }, [table([
    [100, 1, 100, 100, 'r'],
    [101, 100, 100, 100, 'a'],
    [102, 101, 102, 102, 'b'],
    [200, 1, 200, 200, 'x'],
    [201, 200, 201, 201, 'y'],
  ])]);
  tracker.refresh();
  assert.deepEqual(livePids(tracker), [100, 101, 102]);
  assert.deepEqual(tracker.groupsToSignal(), [102, 100]);
});

test('workflow process: the tracker keeps a grandchild after its parent has died', () => {
  const tracker = scripted({ pid: 100, startTime: 'r' }, [
    table([[100, 1, 100, 100, 'r'], [101, 100, 100, 100, 'a'], [102, 101, 102, 102, 'b']]),
    table([[100, 1, 100, 100, 'r'], [102, 1, 102, 102, 'b']]),
  ]);
  tracker.refresh();
  tracker.refresh();
  assert.deepEqual(livePids(tracker), [100, 102]);
  assert.deepEqual(tracker.groupsToSignal(), [102, 100]);
});

test('workflow process: the tracker adopts an orphan that is still in the session of the child', () => {
  const tracker = scripted({ pid: 100, startTime: 'r' }, [
    table([[100, 1, 100, 100, 'r']]),
    table([[103, 1, 100, 100, 'c'], [104, 1, 104, 100, 'd'], [105, 104, 105, 105, 'e']]),
  ]);
  tracker.refresh();
  tracker.refresh();
  assert.deepEqual(livePids(tracker), [103, 104, 105]);
});

test('workflow process: the tracker adopts an orphan in a session that a descendant opened earlier', () => {
  const tracker = scripted({ pid: 100, startTime: 'r' }, [
    table([[100, 1, 100, 100, 'r'], [102, 100, 102, 102, 'b']]),
    table([[100, 1, 100, 100, 'r'], [102, 1, 102, 102, 'b'], [106, 1, 106, 102, 'f']]),
  ]);
  tracker.refresh();
  tracker.refresh();
  assert.deepEqual(livePids(tracker), [100, 102, 106]);
  assert.deepEqual(tracker.groupsToSignal(), [102, 106, 100]);
});

test('workflow process: the tracker does not count a reused pid as the old process', () => {
  const tracker = scripted({ pid: 100, startTime: 'r' }, [
    table([[100, 1, 100, 100, 'r'], [102, 100, 102, 102, 'old']]),
    table([[100, 1, 100, 100, 'r'], [102, 1, 900, 900, 'new']]),
  ]);
  tracker.refresh();
  assert.deepEqual(livePids(tracker), [100, 102]);
  tracker.refresh();
  assert.deepEqual(livePids(tracker), [100]);
  assert.deepEqual(tracker.groupsToSignal(), [100]);
});

test('workflow process: the tracker lets go of a group once it is empty, so a reused group id is not adopted', () => {
  const tracker = scripted({ pid: 100, startTime: 'r' }, [
    table([[100, 1, 100, 100, 'r']]),
    table([[300, 1, 300, 300, 'z']]),
    table([[100, 1, 100, 100, 'reused'], [101, 100, 100, 100, 'reused-child']]),
  ]);
  tracker.refresh();
  tracker.refresh();
  assert.deepEqual(livePids(tracker), []);
  assert.deepEqual(tracker.groupsToSignal(), []);
  tracker.refresh();
  assert.deepEqual(livePids(tracker), []);
  assert.deepEqual(tracker.groupsToSignal(), []);
});

test('workflow process: the tracker does not count a zombie as alive', () => {
  const tracker = scripted({ pid: 100, startTime: 'r' }, [table([[100, 1, 100, 100, 'r', 'Z'], [101, 100, 100, 100, 'a']])]);
  tracker.refresh();
  assert.deepEqual(livePids(tracker), [101]);
  assert.deepEqual(tracker.groupsToSignal(), [100]);
});

const MID = `const leaf = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(SLEEP)}], { stdio: 'ignore', detached: true }); console.log(JSON.stringify({ pid: leaf.pid })); ${SLEEP};`;
const TREE = `const mid = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(MID)}], { stdio: ['ignore', 'inherit', 'ignore'] }); console.log(JSON.stringify({ pid: mid.pid })); ${SLEEP};`;

test('workflow process: on Linux a cancel ends the child, the grandchild and a descendant in its own session', { skip: LINUX_ONLY }, async (t) => {
  const pids = [];
  killAll(t, pids);
  const abort = new AbortController();
  const r = await node(TREE, {
    signal: abort.signal,
    graceMs: 2000,
    onEvent: (e) => {
      pids.push(e.pid);
      if (pids.length === 2) {
        abort.abort();
      }
    },
  });
  assert.equal(pids.length, 2);
  assert.equal(r.cancelled, true);
  assert.equal(r.tree.supported, true);
  assert.deepEqual(r.tree.remaining, []);
  assert.deepEqual(r.tree.signalErrors, []);
  assert.equal(r.tree.outputHeldOpen, false);
  assert.equal(r.tree.confirmed, true);
  for (const pid of [r.owner.pid, ...pids]) {
    assert.equal(isGone(pid), true, `pid ${pid} is still running`);
  }
});

test('workflow process: on Linux a timeout ends the whole tree too', { skip: LINUX_ONLY }, async (t) => {
  const pids = [];
  killAll(t, pids);
  const r = await node(TREE, { timeoutMs: 1500, graceMs: 2000, onEvent: (e) => pids.push(e.pid) });
  assert.equal(pids.length, 2);
  assert.equal(r.timedOut, true);
  assert.equal(r.tree.confirmed, true);
  for (const pid of [r.owner.pid, ...pids]) {
    assert.equal(isGone(pid), true, `pid ${pid} is still running`);
  }
});

test('workflow process: on Linux a process that ignores TERM is killed after the grace time', { skip: LINUX_ONLY }, async () => {
  const abort = new AbortController();
  const started = Date.now();
  const r = await node(`process.on('SIGTERM', () => {}); console.log('{"ready":true}'); ${SLEEP}`, { signal: abort.signal, graceMs: 300, onEvent: () => abort.abort() });
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(r.tree.confirmed, true);
  assert.ok(Date.now() - started >= 300);
  assert.equal(isGone(r.owner.pid), true);
});

test('workflow process: on Linux a process that handles TERM is not killed early', { skip: LINUX_ONLY }, async () => {
  const abort = new AbortController();
  const code = `process.on('SIGTERM', () => { console.log('{"term":true}'); process.exit(5); }); console.log('{"ready":true}'); ${SLEEP}`;
  const events = [];
  const r = await node(code, { signal: abort.signal, graceMs: 5000, onEvent: (e) => { events.push(e); abort.abort(); } });
  assert.equal(r.exitCode, 5);
  assert.deepEqual(events, [{ ready: true }, { term: true }]);
  assert.equal(r.tree.confirmed, true);
});

test('workflow process: on Linux a process left behind after a normal exit is found and ended', { skip: LINUX_ONLY }, async (t) => {
  const pids = [];
  killAll(t, pids);
  const code = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(SLEEP)}], { stdio: 'ignore' }); c.unref(); console.log(JSON.stringify({ pid: c.pid }));`;
  const r = await node(code, { graceMs: 2000, onEvent: (e) => pids.push(e.pid) });
  assert.equal(r.exitCode, 0);
  assert.equal(r.tree.leftovers, 1);
  assert.equal(r.tree.confirmed, true);
  assert.equal(isGone(pids[0]), true);
});

test('workflow process: on Linux a process that escaped with the output pipe open is never reported as confirmed gone', { skip: LINUX_ONLY }, async (t) => {
  const pids = [];
  killAll(t, pids);
  const code = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(SLEEP)}], { stdio: ['ignore', 'inherit', 'ignore'], detached: true }); c.unref(); console.log(JSON.stringify({ pid: c.pid }));`;
  const r = await node(code, { graceMs: 500, drainMs: 500, onEvent: (e) => pids.push(e.pid) });
  assert.equal(pids.length, 1);
  assert.ok(isGone(pids[0]) || r.tree.confirmed === false, 'a live process was reported as confirmed gone');
});

test('workflow process: the relay passes exit code 7 and both streams through', { skip: NEEDS_BASH }, async () => {
  const code = "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7;";
  const r = await runProcess({ ...relayCommand(BASH, process.execPath, ['-e', code]), env: { ...BASE_ENV, PATH: process.env.PATH } });
  assert.equal(r.exitCode, 7);
  assert.equal(r.stdout.tail, 'out');
  assert.equal(r.stderr.tail, 'err');
});

test('workflow process: on Linux the relay does not interpret shell characters in arguments', { skip: IS_LINUX ? NEEDS_BASH : 'Linux only: an MSYS bash started from Windows re-parses its own arguments before the relay sees them' }, async () => {
  const special = ['$(echo hacked)', '`echo hacked`', 'a b', '"q"', "'s'", '*', ';', '&&', '|', '$HOME'];
  const events = [];
  const code = 'console.log(JSON.stringify({ argv: process.argv.slice(1) }))';
  const r = await runProcess({ ...relayCommand(BASH, process.execPath, ['-e', code, '--', ...special]), env: { ...BASE_ENV, PATH: process.env.PATH }, onEvent: (e) => events.push(e) });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(events, [{ argv: special }]);
});

test('workflow process: the relay carries large output on both streams without blocking', { skip: NEEDS_BASH }, async () => {
  const code = "const b = 'x'.repeat(1024); for (let i = 0; i < 512; i += 1) { process.stdout.write(b); process.stderr.write(b); }";
  const r = await runProcess({ ...relayCommand(BASH, process.execPath, ['-e', code]), env: { ...BASE_ENV, PATH: process.env.PATH }, tailBytes: 16, timeoutMs: 60000 });
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.bytes, 512 * 1024);
  assert.equal(r.stderr.bytes, 512 * 1024);
  assert.equal(r.stdout.truncated, true);
  assert.equal(r.stdout.tail.length, 16);
});

test('workflow process: the relay reports a missing command as exit 127', { skip: NEEDS_BASH }, async () => {
  const r = await runProcess({ ...relayCommand(BASH, 'agent-layers-no-such-program'), env: { ...BASE_ENV, PATH: process.env.PATH } });
  assert.equal(r.exitCode, 127);
  assert.match(r.stderr.tail, /agent-layers-no-such-program/);
});

test('workflow process: on Linux a cancel also ends the relay and its pipes', { skip: LINUX_ONLY || NEEDS_BASH }, async (t) => {
  const pids = [];
  killAll(t, pids);
  const abort = new AbortController();
  const code = `console.log(JSON.stringify({ pid: process.pid })); ${SLEEP}`;
  const r = await runProcess({
    ...relayCommand(BASH, process.execPath, ['-e', code]),
    env: { PATH: process.env.PATH },
    signal: abort.signal,
    graceMs: 2000,
    onEvent: (e) => {
      pids.push(e.pid);
      abort.abort();
    },
  });
  assert.equal(r.cancelled, true);
  assert.equal(r.tree.confirmed, true);
  assert.equal(isGone(pids[0]), true);
});

test('workflow process: the relay check passes on Linux with bash and fails clearly otherwise', () => {
  const none = relayCapability({ ...BASE_ENV, PATH: '' });
  assert.equal(none.ok, false);
  assert.match(none.reason, IS_LINUX ? /bash was not found/ : /only supported on Linux/);
  const found = relayCapability({ ...BASE_ENV, PATH: process.env.PATH });
  if (IS_LINUX && BASH) {
    assert.equal(found.ok, true, found.reason);
    assert.match(found.version, /bash/i);
    assert.equal(found.bash, BASH);
  } else {
    assert.equal(found.ok, false);
  }
});
