import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REDACTED_TEXT } from '../src/workflow/store.js';
import { checkCommandProblem, childEnv, commandProblem, EXIT_TIMED_OUT, isRelativeCommand, runChecks } from '../src/workflow/verify.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-wf-verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function nodeCheck(id, script, extra = {}) {
  return { id, command: process.execPath, args: ['-e', script], cwd: '.', timeout: 30, inputs: [], ...extra };
}

function waitFor(file) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
  });
}

test('workflow verify: checks run in the given order in the worktree and keep their exit codes', async (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'sub'));
  const checks = [
    nodeCheck('pass', 'console.log(process.cwd())'),
    nodeCheck('fail', 'process.exit(7)'),
    nodeCheck('inner', 'console.log(process.cwd())', { cwd: 'sub' }),
    nodeCheck('skipped', 'process.exit(9)'),
  ];
  const results = await runChecks({ checks, checkIds: ['inner', 'fail', 'pass'], worktree: dir });
  assert.deepEqual(results.map((r) => [r.id, r.exitCode, r.timedOut]), [['inner', 0, false], ['fail', 7, false], ['pass', 0, false]]);
  assert.equal(results[0].stdout[0], fs.realpathSync.native(path.join(dir, 'sub')));
  assert.equal(results[2].stdout[0], fs.realpathSync.native(dir));
});

test('workflow verify: a check past its timeout reports exit code 124, a check that is not in the policy throws', async (t) => {
  const dir = tempDir(t);
  const checks = [nodeCheck('slow', 'console.log("started"); setTimeout(() => {}, 60000)', { timeout: 1 })];
  const [slow] = await runChecks({ checks, checkIds: ['slow'], worktree: dir });
  assert.equal(slow.exitCode, EXIT_TIMED_OUT);
  assert.equal(slow.timedOut, true);
  assert.equal(slow.stdout[0], 'started');
  await assert.rejects(runChecks({ checks, checkIds: ['nope'], worktree: dir }), /check "nope" is not in the policy/);
});

test('workflow verify: logs are kept line by line, and only the lines that look like secrets are masked', async (t) => {
  const dir = tempDir(t);
  const script = 'console.log("plain line"); console.log("password=SYN_VERIFY_1"); console.error("Authorization: Bearer SYN_VERIFY_2"); console.error("other line");';
  const [r] = await runChecks({ checks: [nodeCheck('logs', script)], checkIds: ['logs'], worktree: dir });
  assert.deepEqual(r.stdout, ['plain line', REDACTED_TEXT, '']);
  assert.deepEqual(r.stderr, [REDACTED_TEXT, 'other line', '']);
  assert.doesNotMatch(JSON.stringify(r), /SYN_VERIFY/);
});

test('workflow verify: a cancelled check throws a cancel error and the next check does not start', async (t) => {
  const dir = tempDir(t);
  const started = path.join(dir, 'started');
  const later = path.join(dir, 'later');
  const write = (file) => `require("fs").writeFileSync(${JSON.stringify(file)}, "x")`;
  const checks = [nodeCheck('slow', `${write(started)}; setTimeout(() => {}, 60000)`), nodeCheck('next', write(later))];
  const controller = new AbortController();
  const running = runChecks({ checks, checkIds: ['slow', 'next'], worktree: dir, signal: controller.signal });
  await waitFor(started);
  controller.abort();
  await assert.rejects(running, (err) => err.cancelled === true && /check "slow" was cancelled/.test(err.message));
  assert.equal(fs.existsSync(later), false);
});

test('workflow verify: a check that cannot start is a start error, and only the named environment variables are passed on', async (t) => {
  const dir = tempDir(t);
  await assert.rejects(
    runChecks({ checks: [{ ...nodeCheck('none', ''), command: 'agent-layers-no-such-program' }], checkIds: ['none'], worktree: dir }),
    (err) => err.code === 'E_WORKFLOW_SPAWN',
  );
  assert.deepEqual(childEnv(['KEEP', 'ABSENT'], { PATH: 'p', KEEP: '1', OTHER: '2' }), { PATH: 'p', KEEP: '1' });
  const env = childEnv([], { ...process.env, AL_WF_HIDDEN: '1' });
  const [r] = await runChecks({ checks: [nodeCheck('env', 'process.exit(process.env.AL_WF_HIDDEN === undefined ? 0 : 1)')], checkIds: ['env'], worktree: dir, env });
  assert.equal(r.exitCode, 0);
});

test('workflow verify: command problems name a missing program and skip paths relative to the worktree', () => {
  const env = childEnv();
  assert.equal(commandProblem(process.execPath, env), null);
  assert.match(commandProblem('agent-layers-no-such-program', env), /agent-layers-no-such-program was not found/);
  assert.equal(isRelativeCommand('bin/check'), true);
  assert.equal(isRelativeCommand('npm'), false);
  assert.equal(isRelativeCommand(process.execPath), false);
  assert.equal(checkCommandProblem([nodeCheck('ok', ''), { id: 'local', command: './gradlew' }], env), null);
  assert.match(checkCommandProblem([nodeCheck('ok', ''), { id: 'gone', command: 'agent-layers-no-such-program' }], env), /check "gone": agent-layers-no-such-program was not found/);
});

test('workflow verify: a batch file is named as a problem on Windows', { skip: process.platform !== 'win32' }, (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'fake-cli.cmd'), '@echo off\r\n');
  assert.match(commandProblem('fake-cli', { PATH: dir, PATHEXT: '.CMD' }), /is a batch file, which needs a shell/);
});
