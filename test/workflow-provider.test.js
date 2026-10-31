import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../src/formats/jsonc.js';
import { buildPrompt, commandVersion, createProvider, providerProblem, readResultJson } from '../src/workflow/provider.js';
import { TREE_KILL_SUPPORTED } from '../src/workflow/process.js';
import { normalizePolicy } from '../src/workflow/schema.js';
import { policySecretIssues } from '../src/workflow/store.js';

const FAKE_AI = fileURLToPath(new URL('./fixtures/workflow/fake-ai.mjs', import.meta.url));
const REQUEST = { role: 'coder', stepId: 'impl', attempt: 1, goal: 'Add a file' };

function setup(t, scenario = {}, { provider = {}, limits = {}, args = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-wf-provider-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scenarioFile = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
  const fakeArgs = [FAKE_AI, '--scenario', scenarioFile, ...args];
  const { policy, issues } = normalizePolicy({
    schemaVersion: 1,
    provider: { command: process.execPath, args: fakeArgs, ...provider },
    limits,
    allowedWritePaths: ['src'],
    checks: [{ id: 'unit', command: process.execPath, args: [], timeout: 30 }],
    requiredChecks: ['unit'],
  });
  assert.deepEqual(issues, []);
  return { dir, policy, fakeArgs, calls: () => fs.readFileSync(`${scenarioFile}.calls.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

function output(tail, truncated = false) {
  return { tail, truncated, bytes: tail.length };
}

test('workflow provider: the example policy is a valid policy without a secret', () => {
  const file = fileURLToPath(new URL('../templates/workflow/policy.example.jsonc', import.meta.url));
  const { policy, issues } = normalizePolicy(parseJsonc(fs.readFileSync(file, 'utf8'), file));
  assert.deepEqual(issues, []);
  assert.deepEqual(policySecretIssues(policy), []);
  assert.deepEqual(Object.keys(policy.provider.roleArgs), ['planner', 'reviewer', 'auditor']);
});

test('workflow provider: the result is the whole stdout or the last json block', () => {
  assert.deepEqual(readResultJson(output('{"a":1}\n')), { a: 1 });
  assert.deepEqual(readResultJson(output('\n  {"a":1}  \n')), { a: 1 });
  assert.deepEqual(readResultJson(output('Done.\n\n```json\n{"a":2}\n```\n')), { a: 2 });
  assert.deepEqual(readResultJson(output('```json\n{"a":1}\n```\ntext\n```json\n{"a":3}\n```\nThat is all.\n')), { a: 3 });
  assert.deepEqual(readResultJson(output('```json\n{"a":"x```y"}\n```')), { a: 'x```y' });
  assert.equal(readResultJson(output('"text"')), 'text');
});

test('workflow provider: output with no readable result gives undefined', () => {
  for (const tail of ['', 'plain text', '{"a":', '```json\n{"a":\n```', '```text\n{"a":1}\n```', '```json\n{"a":1}']) {
    assert.equal(readResultJson(output(tail)), undefined, tail);
  }
  assert.equal(readResultJson(output('{"a":1}', true)), undefined);
});

test('workflow provider: the prompt holds the role text, the result format and the request last', () => {
  for (const [role, heading] of [['coder', '# Coder'], ['reviewer', '# Reviewer'], ['auditor', '# Auditor']]) {
    const prompt = buildPrompt({ ...REQUEST, role });
    assert.ok(prompt.startsWith(heading), role);
    assert.match(prompt, /## Final message/);
    assert.ok(prompt.endsWith(`## Request\n\n\`\`\`json\n${JSON.stringify({ ...REQUEST, role }, null, 2)}\n\`\`\`\n`), role);
  }
  const planner = buildPrompt({ ...REQUEST, role: 'planner' });
  assert.ok(planner.startsWith('# Planner'));
  assert.doesNotMatch(planner, /## Final message/);
});

test('workflow provider: a call sends the prompt on stdin, runs in the given folder and reads stdout', async (t) => {
  for (const args of [[], ['--fenced']]) {
    const s = setup(t, {}, { args });
    const provider = createProvider({ policy: s.policy, cwd: s.dir });
    const result = await provider.call(REQUEST);
    assert.equal(result.stepId, 'impl');
    assert.equal(result.status, 'completed');
    const [call] = s.calls();
    assert.deepEqual(call.request, REQUEST);
    assert.equal(call.cwd, fs.realpathSync.native(s.dir));
  }
});

test('workflow provider: role arguments replace the shared arguments for that role only', async (t) => {
  const s = setup(t);
  const scenario = s.fakeArgs.slice(1);
  const { policy } = normalizePolicy({ ...s.policy, provider: { ...s.policy.provider, roleArgs: { reviewer: [FAKE_AI, '--reviewing', ...scenario] } } });
  const provider = createProvider({ policy, cwd: s.dir });
  await provider.call(REQUEST);
  await provider.call({ ...REQUEST, role: 'reviewer' });
  const [coder, reviewer] = s.calls();
  assert.equal(coder.argv.includes('--reviewing'), false);
  assert.equal(reviewer.argv.includes('--reviewing'), true);
});

test('workflow provider: a non-zero exit is a transport error with the exit code, after a diagnostic and the delay', async (t) => {
  const s = setup(t, { coder: { exit: 3, stderr: 'network down' } });
  const seen = [];
  const provider = createProvider({ policy: s.policy, cwd: s.dir, retryDelayMs: 0, onDiagnostic: (kind, req, r) => seen.push([kind, req.stepId, r.stderr.tail.trim()]) });
  await assert.rejects(provider.call(REQUEST), (err) => err.transport === true && err.code === 'exit-3');
  assert.deepEqual(seen, [['failed', 'impl', 'network down']]);
});

test('workflow provider: exit 0 without a readable result returns undefined after a diagnostic', async (t) => {
  const s = setup(t, { coder: { stdout: '' } });
  const seen = [];
  const provider = createProvider({ policy: s.policy, cwd: s.dir, onDiagnostic: (kind) => seen.push(kind) });
  assert.equal(await provider.call(REQUEST), undefined);
  assert.deepEqual(seen, ['unreadable']);
});

test('workflow provider: a call past stepTimeoutSeconds is a timeout error', async (t) => {
  const s = setup(t, { coder: { sleepMs: 60000 } }, { limits: { stepTimeoutSeconds: 1 } });
  const seen = [];
  const provider = createProvider({ policy: s.policy, cwd: s.dir, onDiagnostic: (kind) => seen.push(kind) });
  await assert.rejects(provider.call(REQUEST), (err) => err.timeout === true && !err.transport);
  assert.deepEqual(seen, ['timeout']);
});

test('workflow provider: a cancelled call throws a cancel error and ends the child', async (t) => {
  const s = setup(t, { coder: { sleepMs: 60000 } });
  const controller = new AbortController();
  const provider = createProvider({ policy: s.policy, cwd: s.dir, signal: controller.signal });
  const running = provider.call(REQUEST);
  for (;;) {
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    if (fs.existsSync(path.join(s.dir, 'scenario.json.calls.jsonl'))) {
      break;
    }
  }
  controller.abort();
  await assert.rejects(running, (err) => err.cancelRequested === true && err.cancelled === TREE_KILL_SUPPORTED);
  assert.throws(() => process.kill(s.calls()[0].pid, 0));
  await assert.rejects(provider.call(REQUEST), (err) => err.cancelRequested === true && err.cancelled === true);
  assert.equal(s.calls().length, 1);
});

test('workflow provider: only the base and the named environment variables reach the command', async (t) => {
  process.env.AL_WF_SHOWN = '1';
  process.env.AL_WF_HIDDEN = '1';
  t.after(() => {
    delete process.env.AL_WF_SHOWN;
    delete process.env.AL_WF_HIDDEN;
  });
  const s = setup(t, {}, { provider: { env: ['AL_WF_SHOWN'] } });
  await createProvider({ policy: s.policy, cwd: s.dir }).call(REQUEST);
  const { envNames } = s.calls()[0];
  assert.ok(envNames.includes('AL_WF_SHOWN'));
  assert.equal(envNames.includes('AL_WF_HIDDEN'), false);
});

test('workflow provider: a program that cannot start is a start error, not a transport error', async (t) => {
  const s = setup(t, {}, { provider: { command: 'agent-layers-no-such-program' } });
  await assert.rejects(createProvider({ policy: s.policy, cwd: s.dir }).call(REQUEST), (err) => err.code === 'E_WORKFLOW_SPAWN' && !err.transport);
});

test('workflow provider: the version is the first line of --version, or unknown when it cannot be read', async (t) => {
  const s = setup(t);
  assert.match(await commandVersion(s.policy), /^v\d+\./);
  const missing = setup(t, {}, { provider: { command: 'agent-layers-no-such-program' } });
  assert.equal(await commandVersion(missing.policy), 'unknown');
});

test('workflow provider: the command must be a program name or an absolute path that exists', (t) => {
  const s = setup(t);
  assert.equal(providerProblem(s.policy), null);
  const problem = (command) => providerProblem({ provider: { ...s.policy.provider, command } });
  assert.match(problem('agent-layers-no-such-program'), /was not found/);
  assert.match(problem('bin/ai'), /must be a program name or an absolute path/);
  assert.match(problem('./ai'), /must be a program name or an absolute path/);
  assert.match(problem(path.join(s.dir, 'no-such-program')), /was not found/);
});
