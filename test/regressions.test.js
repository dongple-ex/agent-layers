import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTomlValue } from '../src/formats/toml.js';
import { run } from '../src/util/proc.js';

const BIN = fileURLToPath(new URL('../bin/agent-layers.js', import.meta.url));
const HAS_GIT = spawnSync('git', ['--version']).status === 0;
const IS_WIN = process.platform === 'win32';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-reg-'));
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
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
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
