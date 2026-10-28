import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseTomlValue } from '../src/formats/toml.js';
import { run } from '../src/util/proc.js';
import { assertOutputsWithin } from '../src/render.js';

const BIN = fileURLToPath(new URL('../bin/agent-layers.js', import.meta.url));
const HAS_GIT = spawnSync('git', ['--version']).status === 0;
const IS_WIN = process.platform === 'win32';

const tempRoots = [];
after(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-reg-'));
  tempRoots.push(root);
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  fs.mkdirSync(home, { recursive: true });
  return { root, home, source };
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function cli(sb, args, { env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [BIN, '--home', sb.home, '--source', sb.source, ...args], {
    encoding: 'utf8',
    cwd: cwd || sb.root,
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

function manifest(sb, targets, options = {}) {
  write(path.join(sb.source, 'agent-layers.jsonc'), JSON.stringify({ version: 1, targets, options: { secrets: { backend: 'file', mode: 'auto' }, claude: { mcp: 'json' }, ...options } }));
  write(path.join(sb.source, 'base', 'instructions', '00-core.md'), '# Core\n\n- Be precise.\n');
}

function fakeCommand(dir, name, script) {
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(js, script);
  if (IS_WIN) {
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
  } else {
    const sh = path.join(dir, name);
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
    fs.chmodSync(sh, 0o755);
  }
}

const FAKE_CLAUDE = `
import fs from 'node:fs';
const store = process.env.FAKE_CLAUDE_JSON;
const log = process.env.FAKE_CLAUDE_LOG;
const args = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
const data = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {};
data.mcpServers ||= {};
if (args[0] === 'mcp' && args[1] === 'add-json') {
  const cfg = JSON.parse(args[3]);
  if (args[2] === 'failing' && cfg.command === 'new') { process.stderr.write('simulated failure'); process.exit(1); }
  data.mcpServers[args[2]] = cfg;
  fs.writeFileSync(store, JSON.stringify(data, null, 2));
} else if (args[0] === 'mcp' && args[1] === 'remove') {
  delete data.mcpServers[args[2]];
  fs.writeFileSync(store, JSON.stringify(data, null, 2));
}
`;

test('#9 windows shims: JSON with quotes, backslashes and %VARS% survives a .cmd round trip', { skip: !IS_WIN }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-shim-'));
  tempRoots.push(dir);
  fakeCommand(dir, 'echoargs', "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  const tricky = ['{"a":"C:\\\\x\\\\","b":"say \\"hi\\"","c":"%USERPROFILE%","d":"x&y|z<w>!"}', 'trail\\', 'spaced arg', '^caret', ''];
  const r = run(path.join(dir, 'echoargs.cmd'), tricky);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), tricky);
});

test('#2 claude CLI route: conflicts are reported, --force backs up, failed add restores the old server', () => {
  const sb = sandbox();
  manifest(sb, ['claude'], { claude: { mcp: 'cli' } });
  const bin = path.join(sb.root, 'fakebin');
  fakeCommand(bin, 'claude', FAKE_CLAUDE);
  const store = path.join(sb.home, '.claude.json');
  const log = path.join(sb.root, 'claude.log');
  fs.writeFileSync(log, '');
  write(store, JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://hand-made.example' }, failing: { type: 'stdio', command: 'old', args: [] } } }));
  write(path.join(sb.source, 'base', 'mcp', 'github.jsonc'), JSON.stringify({ command: 'npx', args: ['gh-mcp', '%USERPROFILE%', 'quote"in"arg', 'trail\\'] }));
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, AGENT_LAYERS_SANDBOX_CLAUDE_CLI: '1', FAKE_CLAUDE_JSON: store, FAKE_CLAUDE_LOG: log };
  let r = cli(sb, ['plan'], { env });
  assert.match(r.out, /conflict/);
  assert.match(r.out, /not managed by agent-layers: github/);
  r = cli(sb, ['apply', '--yes'], { env });
  assert.equal(JSON.parse(read(store)).mcpServers.github.url, 'https://hand-made.example', 'conflicts must not be applied without --force');
  r = cli(sb, ['apply', '--yes', '--force'], { env });
  assert.equal(r.code, 0, r.out);
  const after = JSON.parse(read(store)).mcpServers.github;
  assert.equal(after.command, 'npx');
  assert.deepEqual(after.args, ['gh-mcp', '%USERPROFILE%', 'quote"in"arg', 'trail\\']);
  const backups = fs.readdirSync(path.join(sb.home, '.agent-layers', 'backups'));
  assert.ok(backups.length >= 1, 'the previous ~/.claude.json must be backed up');

  write(path.join(sb.source, 'base', 'mcp', 'failing.jsonc'), JSON.stringify({ command: 'new', args: [] }));
  r = cli(sb, ['apply', '--yes', '--force'], { env });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /previous definition was restored/);
  assert.equal(JSON.parse(read(store)).mcpServers.failing.command, 'old');
});

test('#2 claude CLI route: removals are kept as errors when the CLI is missing', () => {
  const sb = sandbox();
  manifest(sb, ['claude'], { claude: { mcp: 'cli' } });
  const bin = path.join(sb.root, 'fakebin');
  fakeCommand(bin, 'claude', FAKE_CLAUDE);
  const store = path.join(sb.home, '.claude.json');
  const log = path.join(sb.root, 'claude.log');
  fs.writeFileSync(log, '');
  write(path.join(sb.source, 'base', 'mcp', 'svc.jsonc'), JSON.stringify({ command: 'svc', args: [] }));
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, AGENT_LAYERS_SANDBOX_CLAUDE_CLI: '1', FAKE_CLAUDE_JSON: store, FAKE_CLAUDE_LOG: log };
  let r = cli(sb, ['apply', '--yes'], { env });
  assert.equal(r.code, 0, r.out);
  fs.rmSync(path.join(sb.source, 'base', 'mcp', 'svc.jsonc'));
  const noClaude = { ...env, PATH: process.env.PATH.split(path.delimiter).filter((d) => !fs.existsSync(path.join(d, IS_WIN ? 'claude.exe' : 'claude')) && !fs.existsSync(path.join(d, 'claude.cmd'))).join(path.delimiter) };
  r = cli(sb, ['plan'], { env: noClaude });
  assert.match(r.out, /error/);
  assert.match(r.out, /record is kept/);
  const state = JSON.parse(read(path.join(sb.home, '.agent-layers', 'state.json')));
  assert.ok(Object.values(state.outputs).some((o) => o.type === 'claude-mcp'));
});

test('#3 user and project scopes keep separate records for the same file', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  manifest(sb, ['claude']);
  write(path.join(sb.source, 'base', 'mcp', 'basesrv.jsonc'), JSON.stringify({ command: 'base', args: [] }));
  const repo = path.join(sb.root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  write(path.join(sb.source, 'projects', 'p', 'project.jsonc'), JSON.stringify({ name: 'p', mode: 'private', match: { dirName: ['repo'] } }));
  write(path.join(sb.source, 'projects', 'p', 'mcp', 'projsrv.jsonc'), JSON.stringify({ command: 'proj', args: [] }));
  for (const args of [['apply', '--yes'], ['project', 'apply', '--yes'], ['apply', '--yes'], ['project', 'apply', '--yes']]) {
    const r = cli(sb, args, { cwd: repo });
    assert.equal(r.code, 0, r.out);
  }
  const j = JSON.parse(read(path.join(sb.home, '.claude.json')));
  assert.equal(j.mcpServers.basesrv.command, 'base');
  assert.equal(j.projects[repo.replace(/\\/g, '/')].mcpServers.projsrv.command, 'proj');
});

test('#4 import never writes bearer tokens, token args, settings env secrets or codex tokens', () => {
  const sb = sandbox();
  manifest(sb, ['claude']);
  const token = `ghp_${'A'.repeat(36)}`;
  write(path.join(sb.home, '.claude.json'), JSON.stringify({ mcpServers: { gh: { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer opaque-bearer-value-123' } }, cli: { command: 'tool', args: ['--api-key=plain-key-value-456', '--token', 'next-arg-token-789', token] } } }));
  write(path.join(sb.home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-secret-value-000000000000000', SAFE: '1' } }));
  write(path.join(sb.home, '.codex', 'config.toml'), 'model = "m"\nexperimental_bearer_token = "codex-bearer-secret-111"\n');
  const r = cli(sb, ['import', '--yes']);
  assert.equal(r.code, 0, r.out);
  const all = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : all.push(read(path.join(d, e.name)))));
  walk(path.join(sb.source, 'base'));
  const text = all.join('\n');
  for (const secret of ['opaque-bearer-value-123', 'plain-key-value-456', 'next-arg-token-789', token, 'sk-ant-secret-value', 'codex-bearer-secret-111']) {
    assert.ok(!text.includes(secret), `${secret} leaked into the setup repository`);
  }
  assert.match(text, /Bearer \$\{secret:gh\/header-authorization\}/);
  assert.match(text, /--api-key=\$\{secret:cli\//);
  assert.match(r.out, /left out env\.ANTHROPIC_AUTH_TOKEN|left out ANTHROPIC_AUTH_TOKEN/);
});

test('#5 when git cannot list tracked files, existing files are treated as tracked', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  manifest(sb, ['gemini', 'opencode']);
  const repo = path.join(sb.root, 'client');
  write(path.join(repo, 'AGENTS.md'), '# Team\n');
  write(path.join(repo, 'GEMINI.md'), '# Team gemini\n');
  spawnSync('git', ['init', '-q', repo]);
  write(path.join(sb.source, 'projects', 'c', 'project.jsonc'), JSON.stringify({ name: 'c', mode: 'private', match: { dirName: ['client'] } }));
  write(path.join(sb.source, 'projects', 'c', 'instructions', '00.md'), '# Secret client rule\n');
  const bin = path.join(sb.root, 'fakegit');
  fakeCommand(bin, 'git', "process.stderr.write('fatal: detected dubious ownership'); process.exit(128);");
  const r = cli(sb, ['project', 'apply', '--yes'], { cwd: repo, env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /could not ask git which files are tracked/);
  assert.equal(read(path.join(repo, 'AGENTS.md')), '# Team\n');
  assert.equal(read(path.join(repo, 'GEMINI.md')), '# Team gemini\n');
});

test('#1 purge refuses unknown names, unrecorded folders without --path, and unsafe roots', () => {
  const sb = sandbox();
  manifest(sb, ['claude']);
  write(path.join(sb.source, 'projects', 'known', 'project.jsonc'), JSON.stringify({ name: 'known', mode: 'private', match: { dirName: ['known'] } }));
  let r = cli(sb, ['project', 'purge', 'typo', '--yes']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /unknown project "typo"/);
  r = cli(sb, ['project', 'purge', 'known', '--yes']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /pass --path/);
  r = cli(sb, ['project', 'purge', 'known', '--path', sb.home, '--yes', '--force']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /refusing to purge/);
  r = cli(sb, ['project', 'purge', 'known', '--path', path.parse(sb.root).root, '--yes', '--force']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /refusing to purge/);
  r = cli(sb, ['project', 'purge', 'known', '--path', path.join(sb.root, 'other'), '--yes']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /does not match/);
});

test('#1 purge keeps a Claude folder shared with another path that maps to the same name', async () => {
  const { findAgentData } = await import('../src/project.js');
  const { createContext } = await import('../src/context.js');
  const sb = sandbox();
  const ctx = createContext({ home: sb.home });
  const root = path.join(sb.root, 'acme_portal');
  const twin = path.join(sb.root, 'acme-portal');
  const dir = path.join(sb.home, '.claude', 'projects', path.resolve(root).replace(/[^A-Za-z0-9]/g, '-'));
  write(path.join(dir, 'a.jsonl'), `${JSON.stringify({ type: 'user', cwd: root })}\n`);
  write(path.join(dir, 'b.jsonl'), `${JSON.stringify({ type: 'user', cwd: twin })}\n`);
  write(path.join(dir, 'memory', 'MEMORY.md'), 'facts\n');
  const items = findAgentData(ctx, root);
  const removable = items.filter((i) => i.remove).map((i) => i.path);
  assert.ok(removable.includes(path.join(dir, 'a.jsonl')));
  assert.ok(!removable.includes(path.join(dir, 'b.jsonl')));
  assert.ok(!removable.includes(dir));
});

test('#6 purge removes the local memory folder and keeps exclude entries for files it leaves', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  manifest(sb, ['claude', 'cursor']);
  const repo = path.join(sb.root, 'client');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  write(path.join(sb.source, 'projects', 'c', 'project.jsonc'), JSON.stringify({ name: 'c', mode: 'private', match: { dirName: ['client'] }, memory: { claude: 'project' } }));
  write(path.join(sb.source, 'projects', 'c', 'instructions', '00.md'), '# Client rule\n');
  let r = cli(sb, ['project', 'apply', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  write(path.join(repo, '.agent-layers', 'memory', 'claude', 'MEMORY.md'), 'client facts\n');
  write(path.join(repo, '.cursor', 'rules', 'agent-layers-c.mdc'), 'edited by hand\n');
  r = cli(sb, ['project', 'purge', 'c', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(repo, '.agent-layers')), 'the memory folder must be removed');
  assert.ok(fs.existsSync(path.join(repo, '.cursor', 'rules', 'agent-layers-c.mdc')), 'locally edited files are kept');
  const status = spawnSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).stdout;
  assert.equal(status.trim(), '', `kept files must stay excluded, got:\n${status}`);
});

function privateIgnoreFixture(t, { memory = false } = {}) {
  const sb = sandbox();
  t.after(() => fs.rmSync(sb.root, { recursive: true, force: true }));
  manifest(sb, ['claude']);
  const repo = path.join(sb.root, 'client');
  fs.mkdirSync(repo, { recursive: true });
  syncGit(['init', '-q', repo]);
  const project = path.join(sb.source, 'projects', 'private-ignore');
  write(path.join(project, 'project.jsonc'), JSON.stringify({ name: 'private-ignore', mode: 'private', ...(memory ? { memory: { claude: 'memory[1]/claude' } } : {}) }));
  write(path.join(project, 'commands', 'fix[1].md'), '# Private command\n');
  write(path.join(project, 'commands', 'plain.md'), '# Plain command\n');
  const files = ['note[1].md', 'docs[1]/note.md', '!private.md', '#private.md', 'space name.md'];
  if (!IS_WIN) {
    files.push('star*.md', 'question?.md', 'trailing.md ', 'back\\slash.md');
  }
  for (const name of files) {
    write(path.join(project, 'files', 'project', name), '# Private file\n');
  }
  const generated = ['.claude/commands/fix[1].md', '.claude/commands/plain.md', ...files];
  const apply = () => {
    const r = cli(sb, ['project', 'apply', 'private-ignore', '--path', repo, '--yes']);
    assert.equal(r.code, 0, r.out);
  };
  return { sb, repo, generated, apply };
}

test('private ignore patterns exclude literal filenames and memory directories without hiding similar files', { skip: !HAS_GIT }, (t) => {
  const { repo, generated, apply } = privateIgnoreFixture(t, { memory: true });
  apply();
  apply();
  write(path.join(repo, 'memory[1]', 'claude', 'MEMORY.md'), 'private memory\n');
  for (const name of [...generated, 'memory[1]/claude/MEMORY.md']) {
    assert.ok(fs.existsSync(path.join(repo, name)), name);
    assert.match(syncGit(['-C', repo, 'check-ignore', '-v', '--', name]), /info\/exclude/);
  }
  assert.equal(syncGit(['-C', repo, 'status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(syncGit(['-C', repo, 'add', '--dry-run', '.']), '');
  const publicFiles = ['.claude/commands/fix1.md', 'note1.md', 'docs1/note.md', 'memory1/claude/MEMORY.md'];
  if (!IS_WIN) {
    publicFiles.push('star-public.md', 'question1.md', 'trailing.md', 'backslash.md');
  }
  for (const name of publicFiles) {
    write(path.join(repo, name), '# Public file\n');
    const r = spawnSync('git', ['-C', repo, 'check-ignore', '--', name], { encoding: 'utf8' });
    assert.equal(r.status, 1, name + ': ' + r.stdout + r.stderr);
  }
  const staged = syncGit(['-C', repo, 'add', '--dry-run', '.']);
  for (const name of publicFiles) {
    assert.ok(staged.includes(name), staged);
  }
});

test('private ignore patterns remain literal when purge preserves edited files', { skip: !HAS_GIT }, (t) => {
  const { sb, repo, generated, apply } = privateIgnoreFixture(t);
  apply();
  for (const name of generated) {
    write(path.join(repo, name), '# Locally edited private file\n');
  }
  const r = cli(sb, ['project', 'purge', 'private-ignore', '--path', repo, '--keep-agent-data', '--yes']);
  assert.equal(r.code, 0, r.out);
  for (const name of generated) {
    assert.equal(read(path.join(repo, name)), '# Locally edited private file\n');
    assert.match(syncGit(['-C', repo, 'check-ignore', '-v', '--', name]), /info\/exclude/);
  }
  assert.equal(syncGit(['-C', repo, 'status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(syncGit(['-C', repo, 'add', '--dry-run', '.']), '');
});

test('#7 apply skips files that changed after the plan was made', async () => {
  const { buildPlan, applyPlan } = await import('../src/engine.js');
  const sb = sandbox();
  const ctx = { paths: { stateDir: path.join(sb.home, '.agent-layers') } };
  const file = path.join(sb.home, 'settings.json');
  write(file, '{"a":1}\n');
  const state = { version: 1, outputs: {}, projects: {}, history: [] };
  const o = { id: 'user|json|x', type: 'json', path: file, fragment: { b: 2 }, atomic: [], adapters: new Set(['claude']) };
  const plan = buildPlan(ctx, { outputs: [o], state, scopeKey: 'user' });
  write(file, '{"a":1,"agentWroteThis":true}\n');
  const results = applyPlan(ctx, plan, state, { scope: 'user' });
  assert.equal(results[0].status, 'skipped');
  assert.match(results[0].error, /changed after the plan/);
  assert.deepEqual(JSON.parse(read(file)), { a: 1, agentWroteThis: true });
});

test('#8 linked skill folders are never written through', () => {
  const sb = sandbox();
  manifest(sb, ['claude']);
  write(path.join(sb.source, 'base', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n# Demo\n');
  const target = path.join(sb.root, 'dev', 'demo');
  write(path.join(target, 'mine.txt'), 'keep me\n');
  fs.mkdirSync(path.join(sb.home, '.claude', 'skills'), { recursive: true });
  try {
    fs.symlinkSync(target, path.join(sb.home, '.claude', 'skills', 'demo'), IS_WIN ? 'junction' : 'dir');
  } catch {
    return;
  }
  const r = cli(sb, ['apply', '--yes', '--force']);
  assert.match(r.out, /does not write through linked folders/);
  assert.equal(read(path.join(target, 'mine.txt')), 'keep me\n');
  assert.ok(!fs.existsSync(path.join(target, 'SKILL.md')));
});

test('#10 materialized secrets are redacted in plan --diff and --json output', () => {
  const sb = sandbox();
  manifest(sb, ['copilot'], { secrets: { backend: 'file', mode: 'materialize' } });
  write(path.join(sb.source, 'base', 'mcp', 'remote.jsonc'), JSON.stringify({ transport: 'http', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer ${secret:remote/token}' } }));
  const env = { AGENT_LAYERS_SECRET_REMOTE_TOKEN: 'materialized-secret-value-42' };
  let r = cli(sb, ['plan', '--diff'], { env });
  assert.match(r.out, /mcp-config\.json/);
  assert.doesNotMatch(r.out, /materialized-secret-value-42/);
  r = cli(sb, ['plan', '--json'], { env });
  assert.doesNotMatch(r.out, /materialized-secret-value-42/);
});

test('#10 auto mode does not write HTTP secrets into agents without env references', () => {
  const sb = sandbox();
  manifest(sb, ['copilot']);
  write(path.join(sb.source, 'base', 'mcp', 'remote.jsonc'), JSON.stringify({ transport: 'http', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer ${secret:remote/token}' } }));
  const r = cli(sb, ['apply', '--yes'], { env: { AGENT_LAYERS_SECRET_REMOTE_TOKEN: 'never-written-777' } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not written for it/);
  const f = path.join(sb.home, '.copilot', 'mcp-config.json');
  assert.ok(!fs.existsSync(f) || !read(f).includes('never-written-777'));
});

test('#11 the CLAUDE.md shim is stable across repeated applies', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  manifest(sb, ['claude']);
  const repo = path.join(sb.root, 'team');
  write(path.join(repo, 'CLAUDE.md'), '# Claude notes\n');
  spawnSync('git', ['init', '-q', repo]);
  write(path.join(sb.source, 'projects', 't', 'project.jsonc'), JSON.stringify({ name: 't', mode: 'shared', match: { dirName: ['team'] } }));
  write(path.join(sb.source, 'projects', 't', 'instructions', '00.md'), '# Team\n');
  const snapshots = [];
  for (let i = 0; i < 3; i += 1) {
    const r = cli(sb, ['project', 'apply', '--yes'], { cwd: repo });
    assert.equal(r.code, 0, r.out);
    snapshots.push(read(path.join(repo, 'CLAUDE.md')));
  }
  assert.match(snapshots[0], /@AGENTS\.md/);
  assert.equal(snapshots[1], snapshots[0]);
  assert.equal(snapshots[2], snapshots[0]);
});

test('#12 file modes are kept and executable bits are copied', { skip: IS_WIN }, () => {
  const sb = sandbox();
  manifest(sb, ['claude']);
  write(path.join(sb.source, 'base', 'files', 'claude', 'statusline.sh'), '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(sb.source, 'base', 'files', 'claude', 'statusline.sh'), 0o755);
  write(path.join(sb.home, '.claude', 'settings.json'), '{}\n');
  fs.chmodSync(path.join(sb.home, '.claude', 'settings.json'), 0o600);
  write(path.join(sb.source, 'base', 'settings', 'claude.json'), JSON.stringify({ model: 'x' }));
  const r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.statSync(path.join(sb.home, '.claude', 'statusline.sh')).mode & 0o111, 0o111);
  assert.equal(fs.statSync(path.join(sb.home, '.claude', 'settings.json')).mode & 0o777, 0o600);
});

test('#13 JSON files with comments are not rewritten without --force', () => {
  const sb = sandbox();
  manifest(sb, ['gemini']);
  write(path.join(sb.home, '.gemini', 'settings.json'), '{\n  // my note\n  "ui": { "theme": "dark" }\n}\n');
  const r = cli(sb, ['apply', '--yes']);
  assert.match(r.out, /comments or trailing commas/);
  assert.match(read(path.join(sb.home, '.gemini', 'settings.json')), /\/\/ my note/);
});

test('secret fields are masked in diff text while references and other values stay readable', async () => {
  const { maskSecretFields } = await import('../src/util/redact.js');
  const masked = maskSecretFields([
    '    -SERVICENOW_BROWSER_PASSWORD = "toml-secret-1"',
    '    ~ svc: {"command":"uvx","env":{"API_KEY":"json-secret-2","MODE":"browser"}} -> {}',
    '    -INSTANCE_CONFIG = "{\\"prod\\":{\\"url\\":\\"https://x\\",\\"password\\":\\"nested-secret-3\\"}}"',
    '    +args = ["exec", "--env", "SVC_PASSWORD=@@secret:svc/password@@", "--token", "${secret:svc/token}"]',
    '    +"TOKEN": "${SVC_TOKEN}", "use_token": true',
    '    -DB_PASSWORD = "unterminated-secret-4',
    '    SERVICENOW_AUTH_TYPE = "browser"',
  ].join('\n'));
  for (const s of ['toml-secret-1', 'json-secret-2', 'nested-secret-3', 'unterminated-secret-4']) {
    assert.doesNotMatch(masked, new RegExp(s));
  }
  assert.match(masked, /"MODE":"browser"/);
  assert.match(masked, /\\"url\\":\\"https:\/\/x\\"/);
  assert.match(masked, /SVC_PASSWORD=@@secret:svc\/password@@/);
  assert.match(masked, /\$\{secret:svc\/token\}/);
  assert.match(masked, /"TOKEN": "\$\{SVC_TOKEN\}", "use_token": true/);
  assert.match(masked, /SERVICENOW_AUTH_TYPE = "browser"$/);
  assert.equal(masked.split('\n').length, 7);
});

test('plan --diff does not print plaintext secrets that already exist in a conflicting file', () => {
  const sb = sandbox();
  manifest(sb, ['codex']);
  write(path.join(sb.source, 'base', 'mcp', 'svc.jsonc'), JSON.stringify({ command: 'uvx', args: ['svc-mcp'], env: { SVC_PASSWORD: '${secret:svc/password}' } }));
  write(path.join(sb.home, '.codex', 'config.toml'), [
    'model = "gpt-x"',
    '',
    '[mcp_servers.svc]',
    'command = "old-svc"',
    '',
    '[mcp_servers.svc.env]',
    'SVC_PASSWORD = "plain-secret-123"',
    'INSTANCE_CONFIG = "{\\"prod\\":{\\"password\\":\\"nested-secret-789\\"}}"',
    '',
  ].join('\n'));
  const r = cli(sb, ['plan', '--diff'], { env: { AGENT_LAYERS_SECRET_SVC_PASSWORD: 'keychain-value-456' } });
  assert.match(r.out, /conflict/);
  assert.match(r.out, /SVC_PASSWORD/);
  assert.doesNotMatch(r.out, /plain-secret-123|nested-secret-789|keychain-value-456/);
});

test('doctor finds plaintext secrets in project .codex/config.toml and inside JSON strings', async () => {
  const { projectSecretChecks } = await import('../src/doctor.js');
  const sb = sandbox();
  const root = path.join(sb.root, 'proj');
  write(path.join(root, '.codex', 'config.toml'), [
    '[mcp_servers.svc.env]',
    'SVC_PASSWORD = "plain-secret-123"',
    'INSTANCE_CONFIG = "{\\"prod\\":{\\"password\\":\\"nested-secret-789\\"}}"',
    'SVC_MODE = "browser"',
    '',
  ].join('\n'));
  write(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { svc: { command: 'uvx', env: { SVC_PASSWORD: '${SVC_PASSWORD}' } } } }));
  const checks = projectSecretChecks(root);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].level, 'error');
  assert.match(checks[0].msg, /\.codex[\\/]config\.toml/);
  assert.match(checks[0].msg, /mcp_servers\.svc\.env\.SVC_PASSWORD/);
  assert.match(checks[0].msg, /mcp_servers\.svc\.env\.INSTANCE_CONFIG\.prod\.password/);
  assert.doesNotMatch(checks[0].msg, /SVC_MODE|plain-secret-123|nested-secret-789/);
});

const FAKE_NPM = `
import fs from 'node:fs';
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(process.env.FAKE_NPM_OUT || '');
process.exit(Number(process.env.FAKE_NPM_CODE || 0));
`;

function fakeNpm(sb) {
  const bin = path.join(sb.root, 'fakebin');
  fakeCommand(bin, 'npm', FAKE_NPM);
  const log = path.join(sb.root, 'npm.log');
  fs.writeFileSync(log, '');
  return { log, env: (out, code = 0) => ({ PATH: bin, FAKE_NPM_LOG: log, FAKE_NPM_OUT: out, FAKE_NPM_CODE: String(code) }) };
}

test('doctor compares the installed version with npm and recommends an update command', () => {
  const installed = JSON.parse(read(new URL('../package.json', import.meta.url))).version;
  const repo = path.dirname(path.dirname(BIN));
  const sb = sandbox();
  const npm = fakeNpm(sb);
  const unknown = `${installed} (latest version unknown: npm view failed)`;
  const cases = [
    { out: '99.0.0\n', status: 'outdated', latest: '99.0.0', row: `${installed} (latest 99.0.0)`, command: `git -C "${repo}" pull` },
    { out: `${installed}\n`, status: 'latest', latest: installed, row: `${installed} (latest)` },
    { out: '0.0.1\n', status: 'newer', latest: '0.0.1', row: `${installed} (newer than npm 0.0.1)` },
    { out: '99.0.0\n', code: 1, status: 'unknown', row: unknown },
    { out: '99.0.0\u001b[31m\n', status: 'unknown', row: unknown },
  ];
  for (const c of cases) {
    const r = cli(sb, ['doctor', '--json'], { env: npm.env(c.out, c.code) });
    assert.equal(r.code, 0, r.out);
    const report = JSON.parse(r.stdout);
    assert.deepEqual(report.update, { installed, latest: c.latest || null, status: c.status, command: c.command || null });
    assert.equal(report.env.find(([k]) => k === 'agent-layers')[1], c.row);
    assert.equal(report.checks.some((x) => /is available/.test(x.msg)), c.status === 'outdated');
  }
  const calls = read(npm.log).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, cases.length);
  assert.deepEqual(calls[0], ['view', 'agent-layers', 'version', '--prefer-online', '--fetch-retries=0', '--fetch-timeout=10000']);

  const r = cli(sb, ['doctor'], { env: npm.env('99.0.0\n') });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`warn agent-layers 99.0.0 is available (installed ${installed}). Update: git -C "${repo}" pull`), r.out);
});

test('doctor --fast skips the npm version lookup', () => {
  const sb = sandbox();
  const npm = fakeNpm(sb);
  const r = cli(sb, ['doctor', '--fast', '--json'], { env: npm.env('99.0.0\n') });
  assert.equal(r.code, 0, r.out);
  const report = JSON.parse(r.stdout);
  assert.equal(report.update.status, 'skipped');
  assert.equal(report.update.command, null);
  assert.equal(read(npm.log), '');
});

test('update command follows the install location, and versions compare numerically', async () => {
  const { updateCommand, compareVersions } = await import('../src/doctor.js');
  const root = path.join(os.tmpdir(), 'agent-layers-paths');
  assert.equal(updateCommand(path.join(root, 'npm-cache', '_npx', 'a1b2', 'node_modules', 'agent-layers', 'bin', 'agent-layers.js'), '0.2.0'), 'npx agent-layers@latest');
  assert.equal(updateCommand(path.join(root, 'npm', 'node_modules', 'agent-layers', 'bin', 'agent-layers.js'), '0.2.0'), 'npm install --global agent-layers@0.2.0');
  assert.equal(updateCommand(path.join(root, 'clone', 'bin', 'agent-layers.js'), '0.2.0'), `git -C "${path.join(root, 'clone')}" pull`);
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.2.0-beta.1', '0.2.0'), -1);
  assert.equal(compareVersions('0.2.0', '0.2.0-beta.1'), 1);
});

test('remote URLs with ports and trailing .git/ normalize to host/org/repo', async () => {
  const { normalizeRemote } = await import('../src/project.js');
  assert.equal(normalizeRemote('ssh://git@host.example:22/org/repo.git/'), 'host.example/org/repo');
  assert.equal(normalizeRemote('git@github.com:acme/portal.git'), 'github.com/acme/portal');
  assert.equal(normalizeRemote('https://user@dev.azure.com/org/proj/_git/repo'), 'dev.azure.com/org/proj/_git/repo');
});

test('#14 purge deletes config files it created once they are empty, and the folders it created', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  manifest(sb, ['claude', 'codex', 'gemini', 'antigravity', 'copilot']);
  const repo = path.join(sb.root, 'tidy');
  write(path.join(repo, 'README.md'), '# tidy\n');
  write(path.join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  write(path.join(repo, '.gitignore'), '/.gemini/\n');
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  write(path.join(repo, '.gemini', 'settings.json'), '{}\n');
  write(path.join(sb.source, 'projects', 't', 'project.jsonc'), JSON.stringify({ name: 't', mode: 'private', match: { dirName: ['tidy'] } }));
  write(path.join(sb.source, 'projects', 't', 'instructions', '00.md'), '# Trial\n');
  write(path.join(sb.source, 'projects', 't', 'mcp', 'srv.jsonc'), JSON.stringify({ command: 'srv', args: [] }));
  let r = cli(sb, ['project', 'apply', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(read(path.join(repo, '.codex', 'config.toml')), /developer_instructions/);
  assert.ok(fs.existsSync(path.join(repo, '.agents', 'mcp_config.json')));
  assert.match(read(path.join(repo, '.gemini', 'settings.json')), /srv/);
  r = cli(sb, ['project', 'purge', 't', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  for (const rel of ['.codex', '.claude', '.agents', path.join('.github', 'instructions'), path.join('.github', 'mcp.json')]) {
    assert.ok(!fs.existsSync(path.join(repo, rel)), `${rel} should be gone after purge`);
  }
  assert.equal(read(path.join(repo, '.github', 'workflows', 'ci.yml')), 'on: push\n');
  assert.deepEqual(JSON.parse(read(path.join(repo, '.gemini', 'settings.json'))), {}, 'a file that existed before apply is kept');
  assert.ok(fs.existsSync(path.join(repo, '.git', 'info')));
  const status = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
  assert.equal(status.trim(), '', `git status must stay clean, got:\n${status}`);
});

test('#15 purge results name the block they removed, and the source hint follows git', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  manifest(sb, ['claude']);
  const repo = path.join(sb.root, 'hint');
  write(path.join(repo, 'README.md'), '# hint\n');
  spawnSync('git', ['init', '-q', repo]);
  const layer = (name) => {
    write(path.join(sb.source, 'projects', name, 'project.jsonc'), JSON.stringify({ name, mode: 'private', match: { dirName: ['hint'] } }));
    write(path.join(sb.source, 'projects', name, 'instructions', '00.md'), '# Hint\n');
  };
  const purge = (name) => {
    let r = cli(sb, ['project', 'apply', name, '--yes'], { cwd: repo });
    assert.equal(r.code, 0, r.out);
    r = cli(sb, ['project', 'purge', name, '--remove-source', '--yes'], { cwd: repo });
    assert.equal(r.code, 0, r.out);
    return r.out;
  };
  layer('a');
  let out = purge('a');
  assert.match(out, /done\s+remove\s+block\s+.*exclude\s+\[project\.a\]/);
  assert.match(out, /done\s+remove\s+file\s+.*project-a\.md/);
  assert.match(out, /If the setup repository uses git, commit the deletion/);
  spawnSync('git', ['init', '-q', sb.source]);
  layer('b');
  out = purge('b');
  assert.match(out, /It was never committed, so there is nothing to commit/);
  layer('c');
  spawnSync('git', ['-C', sb.source, 'add', '.']);
  spawnSync('git', ['-C', sb.source, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'c']);
  out = purge('c');
  assert.match(out, /Commit the deletion in the setup repository/);
  assert.ok(!fs.existsSync(path.join(sb.source, 'projects', 'c')));
});

function extendsManifest(sb, ext) {
  manifest(sb, ['claude']);
  const m = JSON.parse(read(path.join(sb.source, 'agent-layers.jsonc')));
  write(path.join(sb.source, 'agent-layers.jsonc'), JSON.stringify({ ...m, extends: ext }));
}

function sharedProject(dir, name, match) {
  write(path.join(dir, name, 'project.jsonc'), JSON.stringify({ name, mode: 'private', match: { dirName: [match] } }));
  write(path.join(dir, name, 'instructions', '00.md'), `# ${name}\n\n- Shared rule for ${name}.\n`);
}

function gitFolder(dir) {
  write(path.join(dir, 'README.md'), '# repo\n');
  spawnSync('git', ['init', '-q', dir]);
}

test('#16 extends projects: a project from another setup repository is listed, detected and applied', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  extendsManifest(sb, [{ name: 'team', projects: '../team-setup/projects' }]);
  sharedProject(path.join(sb.root, 'team-setup', 'projects'), 'a6a', 'a6a-repo');
  const repo = path.join(sb.root, 'a6a-repo');
  gitFolder(repo);
  let r = cli(sb, ['project', 'list']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /a6a\s+extends:team/);
  r = cli(sb, ['project', 'detect'], { cwd: repo });
  assert.match(r.out, /-> a6a \(matched by/);
  r = cli(sb, ['project', 'apply', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(read(path.join(repo, '.claude', 'rules', 'agent-layers', 'project-a6a.md')), /Shared rule for a6a/);
  r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  r = cli(sb, ['validate']);
  assert.equal(r.code, 0, r.out);
});

test('#17 extends projects: a name defined twice is an error, and init refuses names taken by extends', () => {
  const sb = sandbox();
  extendsManifest(sb, [{ name: 'team', projects: '../team-setup/projects' }]);
  const shared = path.join(sb.root, 'team-setup', 'projects');
  sharedProject(shared, 'taken', 'taken-repo');
  let r = cli(sb, ['project', 'init', 'taken']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /project "taken" already exists in/);
  assert.ok(!fs.existsSync(path.join(sb.source, 'projects', 'taken')));
  sharedProject(shared, 'dup', 'dup-repo');
  sharedProject(path.join(sb.source, 'projects'), 'dup', 'dup-repo');
  r = cli(sb, ['project', 'list']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /project "dup" is defined twice/);
  r = cli(sb, ['validate']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /project "dup" is defined twice/);
});

test('#18 extends projects: purge --remove-source never deletes a project of another repository', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  extendsManifest(sb, [{ name: 'team', projects: '../team-setup/projects' }]);
  const shared = path.join(sb.root, 'team-setup', 'projects');
  sharedProject(shared, 'a6a', 'a6a-repo');
  const repo = path.join(sb.root, 'a6a-repo');
  gitFolder(repo);
  const rule = path.join(repo, '.claude', 'rules', 'agent-layers', 'project-a6a.md');
  let r = cli(sb, ['project', 'apply', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  r = cli(sb, ['project', 'purge', 'a6a', '--remove-source', '--yes'], { cwd: repo });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /comes from extends layer "team"/);
  assert.ok(fs.existsSync(path.join(shared, 'a6a', 'project.jsonc')));
  assert.ok(fs.existsSync(rule), 'a refused purge must not remove anything');
  r = cli(sb, ['project', 'purge', 'a6a', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(rule));
  assert.ok(fs.existsSync(path.join(shared, 'a6a', 'project.jsonc')));
});

test('#19 extends projects: a missing folder is reported unless optional, and sync clones then pulls it', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  extendsManifest(sb, [{ name: 'team', projects: '../team-clone/projects' }]);
  let r = cli(sb, ['validate']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /extends "team": projects folder not found/);
  r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  extendsManifest(sb, [{ name: 'team', projects: '../team-clone/projects', optional: true }]);
  r = cli(sb, ['validate']);
  assert.equal(r.code, 0, r.out);
  const origin = path.join(sb.root, 'team-origin');
  sharedProject(path.join(origin, 'projects'), 'a6a', 'a6a-repo');
  spawnSync('git', ['init', '-q', origin]);
  spawnSync('git', ['-C', origin, 'add', '.']);
  spawnSync('git', ['-C', origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  extendsManifest(sb, [{ name: 'team', projects: '../team-clone/projects', git: origin }]);
  r = cli(sb, ['sync', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(sb.root, 'team-clone', 'projects', 'a6a', 'project.jsonc')));
  r = cli(sb, ['sync', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /git pull --ff-only \(.*team-clone\)/);
  r = cli(sb, ['project', 'list']);
  assert.match(r.out, /a6a\s+extends:team/);
});

function syncGit(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function syncCommit(dir) {
  syncGit(['-C', dir, 'add', '.']);
  syncGit(['-C', dir, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-qm', 'test update']);
}

function syncSandbox(t) {
  const sb = sandbox();
  t.after(() => fs.rmSync(sb.root, { recursive: true, force: true }));
  const origins = ['team', 'other'].map((name) => {
    const origin = path.join(sb.root, name + '-origin');
    sharedProject(path.join(origin, 'projects'), name + '-project', name + '-work');
    syncGit(['init', '-q', origin]);
    syncCommit(origin);
    return { name, projects: '../' + name + '-clone/projects', git: origin };
  });
  extendsManifest(sb, origins);
  return sb;
}

test('selected sync clones only the chosen external repository without applying settings', { skip: !HAS_GIT }, (t) => {
  const sb = syncSandbox(t);
  const r = cli(sb, ['sync', '--projects', 'extends:team', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(sb.root, 'team-clone', 'projects', 'team-project', 'project.jsonc')));
  assert.ok(!fs.existsSync(path.join(sb.root, 'other-clone')));
  assert.ok(!fs.existsSync(path.join(sb.home, '.claude')));
  assert.ok(!fs.existsSync(path.join(sb.home, '.agent-layers', 'state.json')));
  assert.doesNotMatch(r.out, /skipped pull/);
});

test('selected sync pulls a known project once and leaves unselected checkouts unchanged', { skip: !HAS_GIT }, (t) => {
  const sb = syncSandbox(t);
  for (const name of ['team', 'other']) {
    syncGit(['clone', path.join(sb.root, name + '-origin'), path.join(sb.root, name + '-clone')]);
    write(path.join(sb.root, name + '-origin', 'update.txt'), name);
    syncCommit(path.join(sb.root, name + '-origin'));
  }
  const r = cli(sb, ['sync', '--projects', 'team-project,extends:team,team-project']);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(path.join(sb.root, 'team-clone', 'update.txt')), 'team');
  assert.ok(!fs.existsSync(path.join(sb.root, 'other-clone', 'update.txt')));
  assert.equal((r.out.match(/git pull --ff-only/g) || []).length, 1);
  assert.ok(!fs.existsSync(path.join(sb.home, '.agent-layers', 'state.json')));
});

test('selected sync validates every selection and option before any Git changes', { skip: !HAS_GIT }, (t) => {
  const sb = syncSandbox(t);
  for (const [args, message] of [
    [['--projects', 'extends:team,unknown'], /unknown sync selection/],
    [['--projects'], /requires.*name/],
    [['--projects='], /requires.*name/],
    [['--projects', 'extends:team', '--select'], /cannot combine/],
    [['--projects', 'extends:team', '--project', 'team-project'], /cannot combine/],
    [['--projects', 'extends:team', '--all'], /cannot combine/],
    [['--select', '--yes'], /terminal.*--projects/],
  ]) {
    const r = cli(sb, ['sync', ...args]);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, message);
    assert.ok(!fs.existsSync(path.join(sb.root, 'team-clone')));
    assert.ok(!fs.existsSync(path.join(sb.root, 'other-clone')));
    assert.ok(!fs.existsSync(path.join(sb.home, '.agent-layers', 'state.json')));
  }
});

test('selected sync supports multiple repositories and preserves default sync application', { skip: !HAS_GIT }, (t) => {
  const sb = syncSandbox(t);
  let r = cli(sb, ['sync', '--projects', 'extends:team,extends:other']);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(sb.root, 'team-clone')));
  assert.ok(fs.existsSync(path.join(sb.root, 'other-clone')));
  assert.ok(!fs.existsSync(path.join(sb.home, '.claude')));
  r = cli(sb, ['sync', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(read(path.join(sb.home, '.claude', 'rules', 'agent-layers', '00-core.md')), /Be precise/);
});

test('selected sync updates the source repository only when a source project is chosen', { skip: !HAS_GIT }, (t) => {
  const sb = syncSandbox(t);
  sharedProject(path.join(sb.source, 'projects'), 'local-project', 'local-work');
  syncGit(['init', '-q', sb.source]);
  syncCommit(sb.source);
  const origin = path.join(sb.root, 'source-origin');
  syncGit(['clone', sb.source, origin]);
  const branch = syncGit(['-C', sb.source, 'branch', '--show-current']);
  syncGit(['-C', sb.source, 'remote', 'add', 'origin', origin]);
  syncGit(['-C', sb.source, 'fetch', 'origin']);
  syncGit(['-C', sb.source, 'branch', '--set-upstream-to=origin/' + branch]);
  write(path.join(origin, 'source-update.txt'), 'updated');
  syncCommit(origin);
  let r = cli(sb, ['sync', '--projects', 'extends:team']);
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(sb.source, 'source-update.txt')));
  r = cli(sb, ['sync', '--projects', 'local-project']);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(path.join(sb.source, 'source-update.txt')), 'updated');
  assert.ok(!fs.existsSync(path.join(sb.root, 'other-clone')));
  assert.ok(!fs.existsSync(path.join(sb.home, '.claude')));
});

test('selected sync reports missing Git configuration before cloning other selections', { skip: !HAS_GIT }, (t) => {
  const sb = syncSandbox(t);
  sharedProject(path.join(sb.source, 'projects'), 'local-project', 'local-work');
  const r = cli(sb, ['sync', '--projects', 'extends:team,local-project']);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /not a git checkout/);
  assert.ok(!fs.existsSync(path.join(sb.root, 'team-clone')));
});

test('selected sync menu handles multiple choices, cancellation and invalid input', { skip: !HAS_GIT, timeout: 15000 }, async (t) => {
  for (const [answer, success, message] of [
    ['1,2\n', true, /Selected: extends:team, extends:other/],
    ['extends:team,extends:other\n', true, /Selected: extends:team, extends:other/],
    ['\n', false, /Cancelled/],
    ['', false, /Cancelled/],
    ['99\n', false, /invalid selection number/],
    ['missing\n', false, /unknown sync selection/],
  ]) {
    const sb = syncSandbox(t);
    const script = `process.stdin.isTTY = true; import(${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)}).then(async ({ main }) => { process.exitCode = await main(process.argv.slice(1)); }).catch((e) => { console.error(e.message); process.exitCode = 1; });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, '--', '--home', sb.home, '--source', sb.source, 'sync', '--select'], { env: { ...process.env, NO_COLOR: '1' }, cwd: sb.root });
    t.after(() => child.kill());
    let out = '';
    let answered = false;
    child.stdout.on('data', (data) => {
      out += data;
      if (!answered && out.includes('Enter cancels): ')) {
        answered = true;
        child.stdin.end(answer);
      }
    });
    child.stderr.on('data', (data) => { out += data; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, success ? 0 : 1, out);
    assert.match(out, message);
    assert.equal(fs.existsSync(path.join(sb.root, 'team-clone')), success);
    assert.equal(fs.existsSync(path.join(sb.root, 'other-clone')), success);
    assert.ok(!fs.existsSync(path.join(sb.home, '.agent-layers', 'state.json')));
  }
});

test('selected sync fails a missing clone source without applying or processing later selections', { skip: !HAS_GIT }, (t) => {
  const sb = syncSandbox(t);
  fs.rmSync(path.join(sb.root, 'team-origin'), { recursive: true, force: true });
  const r = cli(sb, ['sync', '--projects', 'extends:team,extends:other']);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /git clone failed/);
  assert.ok(!fs.existsSync(path.join(sb.root, 'other-clone')));
  assert.ok(!fs.existsSync(path.join(sb.home, '.claude')));
});

test('selected sync supports Git worktrees with a .git file', { skip: !HAS_GIT }, (t) => {
  const sb = syncSandbox(t);
  const repository = path.join(sb.root, 'team-repo');
  const worktree = path.join(sb.root, 'team-clone');
  const origin = path.join(sb.root, 'team-origin');
  syncGit(['clone', origin, repository]);
  syncGit(['-C', repository, 'worktree', 'add', '-b', 'work', worktree]);
  const branch = syncGit(['-C', origin, 'branch', '--show-current']);
  syncGit(['-C', worktree, 'branch', '--set-upstream-to=origin/' + branch]);
  write(path.join(origin, 'update.txt'), 'worktree update');
  syncCommit(origin);
  const r = cli(sb, ['sync', '--projects', 'team-project']);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(path.join(worktree, 'update.txt')), 'worktree update');
  assert.ok(!fs.existsSync(path.join(sb.root, 'other-clone')));
});

test('selected sync stops on a failed pull and preserves local edits', { skip: !HAS_GIT }, (t) => {
  const sb = syncSandbox(t);
  const clone = path.join(sb.root, 'team-clone');
  const origin = path.join(sb.root, 'team-origin');
  syncGit(['clone', origin, clone]);
  const rule = path.join('projects', 'team-project', 'instructions', '00.md');
  write(path.join(clone, rule), 'local work\n');
  write(path.join(origin, rule), 'upstream change\n');
  syncCommit(origin);
  const r = cli(sb, ['sync', '--projects', 'team-project,extends:other']);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /git pull failed/);
  assert.equal(read(path.join(clone, rule)), 'local work\n');
  assert.ok(!fs.existsSync(path.join(sb.root, 'other-clone')));
  assert.ok(!fs.existsSync(path.join(sb.home, '.claude')));
});

test('#20 project names from project.jsonc must be plain names, and project outputs never leave the project folder', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  manifest(sb, ['claude']);
  const repo = path.join(sb.home, 'work', 'proj');
  gitFolder(repo);
  write(path.join(sb.source, 'projects', 'p', 'project.jsonc'), JSON.stringify({ name: 'x/../../../../../../.claude/rules/escape', mode: 'private', match: { dirName: ['proj'] } }));
  write(path.join(sb.source, 'projects', 'p', 'instructions', '00.md'), '# escape\n');
  const r = cli(sb, ['project', 'apply', '--yes'], { cwd: repo });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /project\.jsonc: project name ".*" must start with a letter or digit/);
  assert.ok(!fs.existsSync(path.join(sb.home, '.claude', 'rules', 'escape.md')));
  const claudeJson = path.join(sb.home, '.claude.json');
  assert.throws(() => assertOutputsWithin([{ path: path.join(sb.home, '.claude', 'rules', 'x.md') }], [repo], [claudeJson]), /refusing to write/);
  assert.throws(() => assertOutputsWithin([{ path: `${repo}-evil` }], [repo], [claudeJson]), /refusing to write/);
  assert.doesNotThrow(() => assertOutputsWithin([{ path: path.join(repo, '.claude', 'rules', 'x.md') }, { path: claudeJson }], [repo], [claudeJson]));
});

test('#21 links in a layer are copied only when they point to a file inside that layer', () => {
  const sb = sandbox();
  manifest(sb, ['claude']);
  const skill = path.join(sb.source, 'base', 'skills', 'demo');
  write(path.join(skill, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n# Demo\n');
  write(path.join(sb.root, 'outside', 'secret.txt'), 'outside secret\n');
  write(path.join(sb.source, 'base', 'shared', 'inside.txt'), 'inside text\n');
  let fileLinks = true;
  try {
    fs.symlinkSync(path.join(sb.root, 'outside', 'secret.txt'), path.join(skill, 'leak.txt'), 'file');
    fs.symlinkSync(path.join(sb.source, 'base', 'shared', 'inside.txt'), path.join(skill, 'ok.txt'), 'file');
  } catch {
    fileLinks = false;
    try {
      fs.symlinkSync(path.join(sb.root, 'outside'), path.join(skill, 'leakdir'), 'junction');
    } catch {
      return;
    }
  }
  const r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /a link to a folder or to a file outside its layer folder; not copied/);
  const out = path.join(sb.home, '.claude', 'skills', 'demo');
  assert.ok(fs.existsSync(path.join(out, 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(out, 'leak.txt')));
  assert.ok(!fs.existsSync(path.join(out, 'leakdir')));
  if (fileLinks) {
    assert.equal(read(path.join(out, 'ok.txt')), 'inside text\n');
  }
});

test('#22 files copied straight into the home folder are listed as executable content', () => {
  const sb = sandbox();
  manifest(sb, ['claude']);
  write(path.join(sb.source, 'base', 'files', 'home', '.bashrc'), 'echo hi\n');
  write(path.join(sb.source, 'base', 'files', 'home', 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'poc.cmd'), '@echo poc\r\n');
  const r = cli(sb, ['plan']);
  assert.equal(r.code, 0, r.out);
  const section = r.out.split('Executable content')[1] || '';
  assert.match(section, /home file: \.bashrc/);
  assert.match(section, /home file: AppData\/Roaming\/Microsoft\/Windows\/Start Menu\/Programs\/Startup\/poc\.cmd/);
});

test('#23 control characters from layers are shown as text, and MCP names cannot look like options', () => {
  const sb = sandbox();
  manifest(sb, ['claude']);
  write(path.join(sb.source, 'base', 'mcp', 'esc.jsonc'), JSON.stringify({ command: 'node', args: ['-e', '1', '\u001b[1A\u001b[2Khidden'] }));
  write(path.join(sb.source, 'base', 'instructions', '10-esc.md'), '# Esc\n\n- line \u001b[2K erased\n');
  let r = cli(sb, ['plan', '--diff']);
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes('\u001b'), 'raw escape bytes must not reach the terminal');
  assert.match(r.out, /\\x1b\[1A\\x1b\[2Khidden/);
  assert.match(r.out, /line \\x1b\[2K erased/);
  write(path.join(sb.source, 'base', 'mcp', 'esc.jsonc'), JSON.stringify({ name: '--scope', command: 'node' }));
  r = cli(sb, ['plan']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /MCP server name "--scope" must not start with "-"/);
});

test('#24 the Claude memory folder must stay inside the project folder', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  manifest(sb, ['claude']);
  const repo = path.join(sb.root, 'proj');
  gitFolder(repo);
  write(path.join(sb.source, 'projects', 'p', 'project.jsonc'), JSON.stringify({ name: 'p', mode: 'private', match: { dirName: ['proj'] }, memory: { claude: '../proj-evil/mem' } }));
  write(path.join(sb.source, 'projects', 'p', 'instructions', '00.md'), '# p\n');
  const r = cli(sb, ['project', 'apply', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /memory\.claude must be a folder inside/);
  assert.ok(!fs.existsSync(path.join(sb.root, 'proj-evil')));
  const local = path.join(repo, '.claude', 'settings.local.json');
  assert.ok(!fs.existsSync(local) || !read(local).includes('proj-evil'));
});

test('registry splits agents into tier 1 core targets and tier 2 extended targets', async () => {
  const { ADAPTERS } = await import('../src/adapters/registry.js');
  assert.ok(ADAPTERS.every((a) => a.tier === 1 || a.tier === 2));
  assert.deepEqual(ADAPTERS.filter((a) => a.tier === 1).map((a) => a.id).sort(), ['antigravity', 'claude', 'codex', 'copilot', 'cursor', 'gemini', 'zed']);
  assert.deepEqual(ADAPTERS.filter((a) => a.tier === 2).map((a) => a.id).sort(), ['amp', 'cline', 'devin', 'factory', 'goose', 'grok', 'junie', 'kimi', 'kiro', 'opencode', 'qwen']);
});

test('agents lists tier 1 and tier 2 targets in separate tables and reports the tier in JSON', () => {
  const sb = sandbox();
  const r = cli(sb, ['agents']);
  assert.equal(r.code, 0, r.out);
  const [core, extended] = r.out.split('Tier 2: extended agents');
  assert.match(core, /Tier 1: core agents/);
  assert.match(core, /^(yes|no)\s+zed\s/m);
  assert.doesNotMatch(core, /^(yes|no)\s+opencode\s/m);
  assert.match(extended, /^(yes|no)\s+opencode\s/m);
  assert.doesNotMatch(extended, /^(yes|no)\s+zed\s/m);
  const rows = JSON.parse(cli(sb, ['agents', '--json']).stdout);
  assert.equal(rows.find((x) => x[1] === 'zed')[6], '1');
  assert.equal(rows.find((x) => x[1] === 'opencode')[6], '2');
});

test('doctor --strict fails on warnings that a plain doctor run only reports', () => {
  const sb = sandbox();
  write(path.join(sb.home, '.codex', 'config.toml'), '[features]\nmodel = "gpt-5"\n');
  const plain = cli(sb, ['doctor', '--fast']);
  assert.equal(plain.code, 0, plain.out);
  assert.match(plain.out, /warn codex: \[features\] contains model/);
  assert.equal(cli(sb, ['doctor', '--fast', '--strict']).code, 1);
  assert.equal(cli(sb, ['doctor', '--fast', '--json']).code, 0);
  assert.equal(cli(sb, ['doctor', '--fast', '--json', '--strict']).code, 1);
  if (HAS_GIT) {
    const clean = sandbox();
    const r = cli(clean, ['doctor', '--fast', '--strict']);
    assert.equal(r.code, 0, r.out);
  }
});

test('gemini model settings are managed per key and keep the other model settings of the user', () => {
  const sb = sandbox();
  manifest(sb, ['gemini'], { gemini: { readAgentsMd: false } });
  const settings = path.join(sb.home, '.gemini', 'settings.json');
  const fragment = path.join(sb.source, 'base', 'settings', 'gemini.jsonc');
  write(settings, JSON.stringify({ model: { compressionThreshold: 0.7 }, general: { vimMode: true } }, null, 2));
  write(fragment, '{\n  // default model\n  "model": { "name": "gemini-4-argon" },\n  "general": { "plan": { "modelRouting": false } }\n}\n');
  let r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(read(settings)), { model: { compressionThreshold: 0.7, name: 'gemini-4-argon' }, general: { vimMode: true, plan: { modelRouting: false } } });
  fs.rmSync(fragment);
  r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(read(settings)), { model: { compressionThreshold: 0.7 }, general: { vimMode: true } });
});

test('the init template gemini.jsonc writes nothing until a key is uncommented', () => {
  const sb = sandbox();
  manifest(sb, ['gemini'], { gemini: { readAgentsMd: false } });
  write(path.join(sb.source, 'base', 'settings', 'gemini.jsonc'), read(new URL('../templates/init/base/settings/gemini.jsonc', import.meta.url)));
  const r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(sb.home, '.gemini', 'settings.json')));
});

test('purge lists Antigravity conversation artifacts that link to the project for review and leaves global config alone', async () => {
  const { findAgentData } = await import('../src/project.js');
  const { createContext } = await import('../src/context.js');
  const sb = sandbox();
  const ctx = createContext({ home: sb.home });
  const root = path.join(sb.root, 'work');
  const sibling = path.join(sb.root, 'work2');
  const brain = path.join(sb.home, '.gemini', 'antigravity', 'brain');
  write(path.join(brain, 'a', 'task.md'), `- [x] Edit [main.js](${pathToFileURL(path.join(root, 'src', 'main.js')).href}#L10)\n`);
  write(path.join(brain, 'b', 'walkthrough.md'), `See [notes](${pathToFileURL(path.join(sibling, 'notes.md')).href})\n`);
  write(path.join(brain, 'c', 'task.md.metadata.json'), JSON.stringify({ summary: pathToFileURL(root).href }));
  write(path.join(sb.home, '.gemini', 'config', 'config.json'), JSON.stringify({ userSettings: { artifactReviewMode: 'always' }, path: root }));
  write(path.join(sb.home, '.gemini', 'antigravity', 'installation_id'), 'id\n');
  const found = findAgentData(ctx, root);
  const brainItems = found.filter((d) => d.path.startsWith(brain));
  assert.deepEqual(brainItems.map((d) => [d.agent, path.basename(d.path), d.remove]), [['antigravity', 'a', null]]);
  assert.ok(!found.some((d) => /config\.json$|installation_id$/.test(d.path)));
});

test('kimi and grok receive user instructions and MCP servers with secrets handled per format', () => {
  const sb = sandbox();
  manifest(sb, ['kimi', 'grok']);
  write(path.join(sb.source, 'base', 'mcp', 'db.jsonc'), JSON.stringify({ command: 'db-mcp', args: ['--stdio'], env: { DB_PASSWORD: '${secret:db/password}' } }));
  write(path.join(sb.source, 'base', 'mcp', 'gh.jsonc'), JSON.stringify({ transport: 'http', url: 'https://api.example.com/mcp/', headers: { Authorization: 'Bearer ${secret:github/token}' } }));
  write(path.join(sb.source, 'base', 'mcp', 'events.jsonc'), JSON.stringify({ transport: 'sse', url: 'https://mcp.example.com/sse' }));
  const r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(read(path.join(sb.home, '.kimi-code', 'AGENTS.md')), /Be precise\./);
  assert.match(read(path.join(sb.home, '.grok', 'AGENTS.md')), /Be precise\./);
  assert.match(r.out, /gh: the kimi config cannot reference environment variables/);

  const kimi = JSON.parse(read(path.join(sb.home, '.kimi-code', 'mcp.json'))).mcpServers;
  assert.deepEqual(Object.keys(kimi).sort(), ['db', 'events']);
  assert.equal(kimi.db.command, process.execPath);
  assert.equal(kimi.db.args[1], 'exec');
  assert.deepEqual(kimi.events, { transport: 'sse', url: 'https://mcp.example.com/sse' });

  const grok = parseTomlValue(read(path.join(sb.home, '.grok', 'config.toml'))).mcp_servers;
  assert.equal(grok.db.command, process.execPath);
  assert.equal(grok.db.args[1], 'exec');
  assert.equal(grok.gh.url, 'https://api.example.com/mcp/');
  assert.match(grok.gh.headers.Authorization, /^Bearer \$\{[A-Z0-9_]+\}$/);
  assert.deepEqual(grok.events, { url: 'https://mcp.example.com/sse' });
});

test('grok settings fragments merge into config.toml and keep the comments and keys of the user', () => {
  const sb = sandbox();
  manifest(sb, ['grok']);
  const config = path.join(sb.home, '.grok', 'config.toml');
  write(config, '# my grok notes\n[models]\ndefault = "model-a"\n');
  write(path.join(sb.source, 'base', 'settings', 'grok.toml'), '[models]\nweb_search = "model-b"\n');
  const r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  const text = read(config);
  assert.match(text, /# my grok notes/);
  assert.deepEqual(parseTomlValue(text).models, { default: 'model-a', web_search: 'model-b' });
});

test('shared projects get kimi and grok MCP files with references only', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  manifest(sb, ['kimi', 'grok']);
  const repo = path.join(sb.root, 'team');
  write(path.join(repo, 'README.md'), '# team\n');
  spawnSync('git', ['init', '-q', repo]);
  write(path.join(sb.source, 'projects', 't', 'project.jsonc'), JSON.stringify({ name: 't', mode: 'shared', match: { dirName: ['team'] } }));
  write(path.join(sb.source, 'projects', 't', 'instructions', '00.md'), '# Team rules\n');
  write(path.join(sb.source, 'projects', 't', 'mcp', 'local.jsonc'), JSON.stringify({ command: 'local-mcp', args: [], env: { MODE: 'dev' } }));
  write(path.join(sb.source, 'projects', 't', 'mcp', 'gh.jsonc'), JSON.stringify({ transport: 'http', url: 'https://api.example.com/mcp/', headers: { Authorization: 'Bearer ${secret:github/token}' } }));
  const r = cli(sb, ['project', 'apply', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  const kimi = JSON.parse(read(path.join(repo, '.kimi-code', 'mcp.json'))).mcpServers;
  assert.deepEqual(kimi, { local: { command: 'local-mcp', args: [], env: { MODE: 'dev' } } });
  assert.match(r.out, /gh: the kimi config format cannot reference environment variables/);
  const grokText = read(path.join(repo, '.grok', 'config.toml'));
  const grok = parseTomlValue(grokText).mcp_servers;
  assert.deepEqual(grok.local, { command: 'local-mcp', args: [], env: { MODE: 'dev' } });
  assert.match(grok.gh.headers.Authorization, /^Bearer \$\{[A-Z0-9_]+\}$/);
  assert.doesNotMatch(grokText, /secret:/);
  assert.match(read(path.join(repo, 'AGENTS.md')), /# Team rules/);
});

function snapshot(dir, skip = []) {
  const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (skip.includes(e.name)) {
        continue;
      }
      if (e.isDirectory()) {
        walk(p);
      } else {
        files[path.relative(dir, p)] = read(p);
      }
    }
  };
  walk(dir);
  return files;
}

test('plan and apply stop on an unknown instruction target before they change managed outputs', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  manifest(sb, ['codex']);
  const repo = path.join(sb.root, 'proj');
  gitFolder(repo);
  write(path.join(sb.source, 'projects', 'p', 'project.jsonc'), JSON.stringify({ name: 'p', mode: 'private', match: { dirName: ['proj'] } }));
  const rule = path.join(sb.source, 'projects', 'p', 'instructions', '00-role.md');
  write(rule, '---\ntargets: [codex]\n---\n- ROLE PM\n');
  const first = cli(sb, ['project', 'apply', '--yes'], { cwd: repo });
  assert.equal(first.code, 0, first.out);
  assert.match(read(path.join(repo, '.codex', 'config.toml')), /ROLE PM/);
  const outputs = () => ({ home: snapshot(sb.home), repo: snapshot(repo, ['.git']), exclude: read(path.join(repo, '.git', 'info', 'exclude')) });
  const before = outputs();
  for (const field of ['targets', 'exclude']) {
    write(rule, `---\n${field}: [pm]\n---\n- ROLE PM\n`);
    for (const args of [['project', 'plan'], ['project', 'plan', '--json'], ['project', 'apply', '--yes']]) {
      const r = cli(sb, args, { cwd: repo });
      assert.equal(r.code, 1, `${field}: ${args.join(' ')}\n${r.out}`);
      assert.match(r.out, /00-role\.md: unknown target "pm"/);
      assert.deepEqual(outputs(), before, `${field}: ${args.join(' ')} changed a managed output or the state file`);
    }
  }
});

test('validate, plan and apply reject unknown targets in skills, commands, subagents, MCP servers and instruction excludes', () => {
  const sb = sandbox();
  manifest(sb, ['claude']);
  write(path.join(sb.source, 'base', 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo skill\n---\n# Demo\n');
  write(path.join(sb.source, 'base', 'skills', 'demo-skill', 'agent-layers.jsonc'), JSON.stringify({ targets: ['claud'] }));
  write(path.join(sb.source, 'base', 'skills', 'note-skill', 'SKILL.md'), '---\nname: note-skill\ndescription: Note skill\nagent-layers-targets: [claud]\n---\n# Note\n');
  write(path.join(sb.source, 'base', 'commands', 'demo.md'), '---\ndescription: Demo command\ntargets: [claud]\n---\nRun the demo.\n');
  write(path.join(sb.source, 'base', 'agents', 'helper.md'), '---\nname: helper\ndescription: Demo subagent\ntargets: [claud]\n---\nHelp with the demo.\n');
  write(path.join(sb.source, 'base', 'mcp', 'demo.jsonc'), JSON.stringify({ command: 'demo', args: [], targets: ['claud'] }));
  write(path.join(sb.source, 'base', 'instructions', '10-style.md'), '---\nexclude: [claud]\n---\n- Keep answers short.\n');
  const expected = [/demo-skill[\\/]agent-layers\.jsonc: unknown target "claud"/, /note-skill[\\/]SKILL\.md: unknown target "claud"/, /demo\.md: unknown target "claud"/, /helper\.md: unknown target "claud"/, /demo\.jsonc: unknown target "claud"/, /10-style\.md: unknown target "claud"/];
  const before = snapshot(sb.home);
  for (const args of [['validate'], ['plan'], ['apply', '--yes']]) {
    const r = cli(sb, args);
    assert.equal(r.code, 1, `${args.join(' ')}\n${r.out}`);
    for (const re of expected) {
      assert.match(r.out, re);
    }
    assert.deepEqual(snapshot(sb.home), before, `${args.join(' ')} wrote into the home folder`);
  }
});

test('skill sidecar targets: an empty list deploys nowhere, and empty or null values fall back to SKILL.md', () => {
  for (const [sidecar, code] of [[{ targets: [] }, 0], [{ targets: '' }, 1], [{ targets: null }, 1], [null, 1]]) {
    const sb = sandbox();
    manifest(sb, ['claude']);
    const skill = path.join(sb.source, 'base', 'skills', 'demo-skill');
    write(path.join(skill, 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo skill\nagent-layers-targets: [claud]\n---\n# Demo\n');
    if (sidecar) {
      write(path.join(skill, 'agent-layers.jsonc'), JSON.stringify(sidecar));
    }
    const label = sidecar ? JSON.stringify(sidecar) : 'no sidecar';
    const before = snapshot(sb.home);
    for (const args of [['validate'], ['plan'], ['apply', '--yes']]) {
      const r = cli(sb, args);
      assert.equal(r.code, code, `${label}: ${args.join(' ')}\n${r.out}`);
      if (code === 0) {
        assert.doesNotMatch(r.out, /unknown target/);
      } else {
        assert.match(r.out, /demo-skill[\\/]SKILL\.md: unknown target "claud"/);
        assert.deepEqual(snapshot(sb.home), before, `${label}: ${args.join(' ')} wrote into the home folder`);
      }
    }
    if (code === 0) {
      assert.ok(!Object.keys(snapshot(sb.home)).some((file) => file.includes('demo-skill')), `${label}: the skill was deployed`);
    }
  }
});

test('user plan and apply keep existing managed outputs when an instruction target becomes unknown', () => {
  const sb = sandbox();
  manifest(sb, ['claude', 'codex']);
  const rule = path.join(sb.source, 'base', 'instructions', '10-role.md');
  write(rule, '---\ntargets: [codex]\n---\n- ROLE PM\n');
  const first = cli(sb, ['apply', '--yes']);
  assert.equal(first.code, 0, first.out);
  assert.match(read(path.join(sb.home, '.codex', 'AGENTS.md')), /ROLE PM/);
  const before = snapshot(sb.home);
  for (const field of ['targets', 'exclude']) {
    write(rule, `---\n${field}: [codx]\n---\n- ROLE PM\n`);
    for (const args of [['validate'], ['plan'], ['plan', '--json'], ['apply', '--yes']]) {
      const r = cli(sb, args);
      assert.equal(r.code, 1, `${field}: ${args.join(' ')}\n${r.out}`);
      assert.match(r.out, /10-role\.md: unknown target "codx"/);
      assert.deepEqual(snapshot(sb.home), before, `${field}: ${args.join(' ')} changed a managed output or the state file`);
    }
  }
});
