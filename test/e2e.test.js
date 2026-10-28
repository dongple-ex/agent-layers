import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTomlValue } from '../src/formats/toml.js';
import { parseJsonc } from '../src/formats/jsonc.js';

const BIN = fileURLToPath(new URL('../bin/agent-layers.js', import.meta.url));
const HAS_GIT = spawnSync('git', ['--version']).status === 0;

const tempRoots = [];
after(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-test-'));
  tempRoots.push(root);
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  fs.mkdirSync(home, { recursive: true });
  return { root, home, source };
}

function cli(sb, args, { env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [BIN, '--home', sb.home, '--source', sb.source, ...args], {
    encoding: 'utf8',
    cwd: cwd || sb.root,
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function baseRepo(sb, targets) {
  write(path.join(sb.source, 'agent-layers.jsonc'), JSON.stringify({ version: 1, targets, options: { secrets: { backend: 'file', mode: 'auto' }, claude: { mcp: 'json' } } }));
  write(path.join(sb.source, 'base', 'instructions', '00-core.md'), '# Core\n\n- Be precise.\n');
  write(path.join(sb.source, 'base', 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo skill for tests.\n---\n# Demo\n');
}

test('user scope: apply is idempotent, drift is detected, removed sources are cleaned up', () => {
  const sb = sandbox();
  baseRepo(sb, ['claude', 'codex', 'gemini']);
  let r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(read(path.join(sb.home, '.claude', 'rules', 'agent-layers', '00-core.md')), /Be precise/);
  assert.match(read(path.join(sb.home, '.codex', 'AGENTS.md')), /agent-layers:begin base/);
  assert.ok(fs.existsSync(path.join(sb.home, '.agents', 'skills', 'demo-skill', 'SKILL.md')));
  r = cli(sb, ['plan']);
  assert.match(r.out, /unchanged/);
  assert.doesNotMatch(r.out, /\b(create|update)\b\s+claude/);

  write(path.join(sb.home, '.claude', 'rules', 'agent-layers', '00-core.md'), 'edited by hand\n');
  r = cli(sb, ['plan']);
  assert.match(r.out, /drift/);
  r = cli(sb, ['apply', '--yes']);
  assert.equal(read(path.join(sb.home, '.claude', 'rules', 'agent-layers', '00-core.md')), 'edited by hand\n');
  r = cli(sb, ['apply', '--yes', '--force']);
  assert.match(read(path.join(sb.home, '.claude', 'rules', 'agent-layers', '00-core.md')), /Be precise/);
  assert.ok(fs.readdirSync(path.join(sb.home, '.agent-layers', 'backups')).length >= 1);

  fs.rmSync(path.join(sb.source, 'base', 'skills', 'demo-skill'), { recursive: true });
  r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(sb.home, '.agents', 'skills', 'demo-skill')));
  assert.ok(!fs.existsSync(path.join(sb.home, '.claude', 'skills', 'demo-skill')));
});

test('user scope: --only keeps outputs of other agents unless --prune is given', () => {
  const sb = sandbox();
  baseRepo(sb, ['claude', 'codex']);
  let r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  r = cli(sb, ['apply', '--yes', '--only', 'claude']);
  assert.equal(r.code, 0, r.out);
  assert.match(read(path.join(sb.home, '.codex', 'AGENTS.md')), /Be precise/);
  assert.ok(fs.existsSync(path.join(sb.home, '.agents', 'skills', 'demo-skill')));
  r = cli(sb, ['plan', '--only', 'claude', '--prune']);
  assert.match(r.out, /remove/);
  r = cli(sb, ['apply', '--yes', '--only', 'claude', '--prune']);
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(sb.home, '.codex', 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(sb.home, '.claude', 'rules', 'agent-layers', '00-core.md')));
});

test('user scope: existing files and foreign content are preserved', () => {
  const sb = sandbox();
  baseRepo(sb, ['codex', 'gemini']);
  write(path.join(sb.home, '.codex', 'AGENTS.md'), '# My own notes\n\nKeep me.\n');
  write(path.join(sb.home, '.gemini', 'settings.json'), JSON.stringify({ ui: { theme: 'dark' }, mcpServers: { mine: { command: 'x' } } }, null, 4));
  write(path.join(sb.source, 'base', 'settings', 'gemini.json'), JSON.stringify({ ui: { hideTips: true } }));
  const r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  const agents = read(path.join(sb.home, '.codex', 'AGENTS.md'));
  assert.ok(agents.startsWith('# My own notes'));
  assert.match(agents, /Be precise/);
  const settings = JSON.parse(read(path.join(sb.home, '.gemini', 'settings.json')));
  assert.equal(settings.ui.theme, 'dark');
  assert.equal(settings.ui.hideTips, true);
  assert.deepEqual(settings.mcpServers.mine, { command: 'x' });
  assert.deepEqual(settings.context.fileName, ['AGENTS.md', 'GEMINI.md']);
  assert.match(read(path.join(sb.home, '.gemini', 'settings.json')), /^ {4}"/m);
});

test('codex: settings and MCP servers merge into an existing config.toml without losing machine entries', () => {
  const sb = sandbox();
  baseRepo(sb, ['codex']);
  const existing = 'model = "old"\nnotify = [\'C:\\tools\\n.exe\']\n\n[projects.\'c:\\work\\a\']\ntrust_level = "trusted"\n\n[mcp_servers.node_repl]\ncommand = \'C:\\x\\node_repl.exe\'\nargs = []\n';
  write(path.join(sb.home, '.codex', 'config.toml'), existing);
  write(path.join(sb.source, 'base', 'settings', 'codex.toml'), 'model = "gpt-x"\nmodel_reasoning_effort = "high"\n\n[features]\nmemories = false\n');
  write(path.join(sb.source, 'base', 'mcp', 'demo.jsonc'), JSON.stringify({ command: 'npx', args: ['-y', 'demo-mcp'], env: { DEMO_TOKEN: '${secret:demo/token}', MODE: 'fast' } }));
  write(path.join(sb.source, 'base', 'mcp', 'remote.jsonc'), JSON.stringify({ transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${secret:remote/token}' } }));
  let r = cli(sb, ['plan']);
  assert.match(r.out, /conflict/, 'overwriting the unmanaged "model" value must be flagged');
  r = cli(sb, ['apply', '--yes', '--force']);
  assert.equal(r.code, 0, r.out);
  const v = parseTomlValue(read(path.join(sb.home, '.codex', 'config.toml')));
  assert.equal(v.model, 'gpt-x');
  assert.equal(v.features.memories, false);
  assert.equal(v.projects['c:\\work\\a'].trust_level, 'trusted');
  assert.equal(v.mcp_servers.node_repl.command, 'C:\\x\\node_repl.exe');
  assert.equal(v.mcp_servers.demo.command, process.execPath);
  assert.ok(v.mcp_servers.demo.args.includes('exec'));
  assert.ok(v.mcp_servers.demo.args.includes('DEMO_TOKEN=@@secret:demo/token@@'));
  assert.deepEqual(v.mcp_servers.demo.env, { MODE: 'fast' });
  assert.equal(v.mcp_servers.remote.bearer_token_env_var, 'REMOTE_TOKEN');
  assert.doesNotMatch(read(path.join(sb.home, '.codex', 'config.toml')), /secret-value/);
  r = cli(sb, ['plan']);
  assert.doesNotMatch(r.out, /\b(create|update|conflict|drift)\b/);
  fs.rmSync(path.join(sb.source, 'base', 'mcp', 'demo.jsonc'));
  r = cli(sb, ['apply', '--yes']);
  const v2 = parseTomlValue(read(path.join(sb.home, '.codex', 'config.toml')));
  assert.equal(v2.mcp_servers.demo, undefined);
  assert.equal(v2.mcp_servers.node_repl.command, 'C:\\x\\node_repl.exe');
});

test('mcp: env references for shared files, wrapper for local files, per-agent formats', () => {
  const sb = sandbox();
  baseRepo(sb, ['claude', 'gemini', 'antigravity', 'copilot', 'cursor', 'opencode']);
  write(path.join(sb.source, 'base', 'mcp', 'svc.jsonc'), JSON.stringify({ command: 'uvx', args: ['svc-mcp'], env: { SVC_PASSWORD: '${secret:svc/password}', SVC_URL: 'https://svc.example' } }));
  const r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  const claude = JSON.parse(read(path.join(sb.home, '.claude.json')));
  assert.equal(claude.mcpServers.svc.type, 'stdio');
  assert.equal(claude.mcpServers.svc.command, process.execPath);
  assert.equal(claude.mcpServers.svc.env.SVC_URL, 'https://svc.example');
  assert.equal(claude.mcpServers.svc.env.SVC_PASSWORD, undefined);
  const gem = JSON.parse(read(path.join(sb.home, '.gemini', 'settings.json')));
  assert.ok(gem.mcpServers.svc.args.includes('SVC_PASSWORD=@@secret:svc/password@@'));
  const ag = JSON.parse(read(path.join(sb.home, '.gemini', 'config', 'mcp_config.json')));
  assert.equal(ag.mcpServers.svc.command, process.execPath);
  const cp = JSON.parse(read(path.join(sb.home, '.copilot', 'mcp-config.json')));
  assert.equal(cp.mcpServers.svc.type, 'local');
  assert.deepEqual(cp.mcpServers.svc.tools, ['*']);
  const oc = JSON.parse(read(path.join(sb.home, '.config', 'opencode', 'opencode.json')));
  assert.equal(oc.mcp.svc.type, 'local');
  assert.equal(oc.mcp.svc.command[0], process.execPath);
  const cur = JSON.parse(read(path.join(sb.home, '.cursor', 'mcp.json')));
  assert.equal(cur.mcpServers.svc.env.SVC_URL, 'https://svc.example');
});

test('plan lists executable content without secret values', () => {
  const sb = sandbox();
  baseRepo(sb, ['claude', 'codex']);
  write(path.join(sb.source, 'base', 'mcp', 'svc.jsonc'), JSON.stringify({ command: 'uvx', args: ['svc-mcp', '--token', '${secret:svc/token}'] }));
  write(path.join(sb.source, 'base', 'skills', 'demo-skill', 'scripts', 'run.sh'), 'echo hi\n');
  write(path.join(sb.source, 'base', 'settings', 'claude.json'), JSON.stringify({ statusLine: { type: 'command', command: '~/.claude/statusline.sh' } }));
  const r = cli(sb, ['plan'], { env: { AGENT_LAYERS_SECRET_SVC_TOKEN: 'super-secret-value' } });
  assert.match(r.out, /Executable content/);
  assert.match(r.out, /MCP server "svc" \(claude\): uvx svc-mcp --token \$\{secret:svc\/token\}/);
  assert.match(r.out, /skill "demo-skill": scripts\/run\.sh/);
  assert.match(r.out, /claude setting "statusLine"/);
  assert.doesNotMatch(r.out, /super-secret-value/);
});

test('secrets: file backend, exec wrapper injects values, check reports missing ones', () => {
  const sb = sandbox();
  baseRepo(sb, ['claude']);
  write(path.join(sb.source, 'base', 'mcp', 'svc.jsonc'), JSON.stringify({ command: 'uvx', args: ['svc'], env: { SVC_TOKEN: '${secret:svc/token}' } }));
  let r = cli(sb, ['secrets', 'check']);
  assert.equal(r.code, 1);
  assert.match(r.out, /svc\/token.*missing/);
  r = cli(sb, ['secrets', 'set', 'svc/token', '--value', 's3cr3t-value']);
  assert.equal(r.code, 0, r.out);
  r = cli(sb, ['secrets', 'get', 'svc/token']);
  assert.doesNotMatch(r.out, /s3cr3t-value/);
  r = cli(sb, ['exec', '--env', 'SVC_TOKEN=@@secret:svc/token@@', '--', process.execPath, '-e', 'process.stdout.write(process.env.SVC_TOKEN)']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, 's3cr3t-value');
  r = cli(sb, ['exec', '--env', 'X=@@secret:nope@@', '--', process.execPath, '-e', '0']);
  assert.equal(r.code, 1);
  r = cli(sb, ['exec', '--', process.execPath, '-e', 'process.stdout.write(process.env.ENV_SECRET_PROBE || "")'], { env: { ENV_SECRET_PROBE: 'ok' } });
  assert.equal(r.out, 'ok');
  r = cli(sb, ['exec', '--env', 'Y=@@secret:from/env@@', '--', process.execPath, '-e', 'process.stdout.write(process.env.Y)'], { env: { AGENT_LAYERS_SECRET_FROM_ENV: 'env-value' } });
  assert.equal(r.out, 'env-value');
});

test('project (private mode): only untracked files, git exclude, memory folder, then purge', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  baseRepo(sb, ['claude', 'codex', 'copilot', 'cursor', 'antigravity', 'gemini']);
  const repo = path.join(sb.root, 'client-repo');
  write(path.join(repo, 'AGENTS.md'), '# Team rules\n');
  write(path.join(repo, '.mcp.json'), '{"mcpServers":{}}\n');
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/portal.git']);
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  const pdir = path.join(sb.source, 'projects', 'acme');
  write(path.join(pdir, 'project.jsonc'), JSON.stringify({ name: 'acme', mode: 'private', match: { gitRemote: ['github.com/acme/portal'] }, memory: { claude: 'project' } }));
  write(path.join(pdir, 'instructions', '00-acme.md'), '# ACME\n\n- Never write to production.\n');
  write(path.join(pdir, 'instructions', '10-ui.md'), '---\npaths:\n  - "src/ui/**"\n---\n# UI\n\n- Use the design tokens.\n');
  write(path.join(pdir, 'skills', 'acme-domain', 'SKILL.md'), '---\nname: acme-domain\ndescription: ACME domain glossary.\n---\n# Glossary\n');
  let r = cli(sb, ['project', 'detect'], { cwd: path.join(repo) });
  assert.match(r.out, /acme \(matched by git remote\)/);
  r = cli(sb, ['project', 'apply', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.equal(read(path.join(repo, 'AGENTS.md')), '# Team rules\n', 'tracked AGENTS.md must not change');
  assert.match(read(path.join(repo, '.claude', 'rules', 'agent-layers', 'project-acme.md')), /Never write to production/);
  assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'CLAUDE.local.md would stop Claude Code from reading AGENTS.md');
  assert.match(read(path.join(repo, '.claude', 'rules', 'agent-layers', '10-ui.md')), /src\/ui/);
  assert.match(read(path.join(repo, '.github', 'instructions', 'agent-layers-acme.instructions.md')), /applyTo: "\*\*"/);
  assert.match(read(path.join(repo, '.cursor', 'rules', 'agent-layers-acme.mdc')), /alwaysApply: true/);
  assert.match(read(path.join(repo, '.agents', 'rules', 'agent-layers-acme.md')), /trigger: always_on/);
  assert.match(read(path.join(repo, '.codex', 'config.toml')), /developer_instructions/);
  const local = JSON.parse(read(path.join(repo, '.claude', 'settings.local.json')));
  assert.ok(local.autoMemoryDirectory.endsWith(path.join('.agent-layers', 'memory', 'claude')));
  const exclude = read(path.join(repo, '.git', 'info', 'exclude'));
  assert.match(exclude, /# agent-layers:begin project\.acme/);
  assert.match(exclude, /\/\.claude\/rules\/agent-layers\/project-acme\.md/);
  assert.match(exclude, /\/\.agent-layers\//);
  const status = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
  assert.equal(status.trim(), '', `git status must stay clean, got:\n${status}`);
  r = cli(sb, ['project', 'plan'], { cwd: repo });
  assert.doesNotMatch(r.out, /\b(create|update|conflict|drift)\b/);

  fs.mkdirSync(path.join(sb.home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-')), { recursive: true });
  write(path.join(sb.home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'), 'memory', 'MEMORY.md'), 'client facts\n');
  r = cli(sb, ['project', 'purge', 'acme', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(repo, '.claude', 'rules', 'agent-layers', 'project-acme.md')));
  assert.ok(!fs.existsSync(path.join(repo, '.agents', 'rules', 'agent-layers-acme.md')));
  assert.ok(!fs.existsSync(path.join(sb.home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'))));
  assert.doesNotMatch(read(path.join(repo, '.git', 'info', 'exclude')), /agent-layers:begin/);
  assert.equal(read(path.join(repo, 'AGENTS.md')), '# Team rules\n');
});

test('project (shared mode): AGENTS.md block, .mcp.json with env references, CLAUDE.md shim', { skip: !HAS_GIT }, () => {
  const sb = sandbox();
  baseRepo(sb, ['claude', 'codex', 'copilot']);
  const repo = path.join(sb.root, 'team-repo');
  write(path.join(repo, 'CLAUDE.md'), '# Claude notes\n');
  spawnSync('git', ['init', '-q', repo]);
  const pdir = path.join(sb.source, 'projects', 'team');
  write(path.join(pdir, 'project.jsonc'), JSON.stringify({ name: 'team', mode: 'shared', match: { dirName: ['team-repo'] } }));
  write(path.join(pdir, 'instructions', '00-team.md'), '# Team\n\n- Run tests before pushing.\n');
  write(path.join(pdir, 'mcp', 'db.jsonc'), JSON.stringify({ command: 'npx', args: ['db-mcp'], env: { DB_PASSWORD: '${secret:team/db}' } }));
  const r = cli(sb, ['project', 'apply', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(read(path.join(repo, 'AGENTS.md')), /Run tests before pushing/);
  assert.match(read(path.join(repo, 'CLAUDE.md')), /@AGENTS\.md/);
  const mcp = JSON.parse(read(path.join(repo, '.mcp.json')));
  assert.equal(mcp.mcpServers.db.env.DB_PASSWORD, '${DB_PASSWORD}');
  assert.equal(mcp.mcpServers.db.command, 'npx');
  const codex = parseTomlValue(read(path.join(repo, '.codex', 'config.toml')));
  assert.deepEqual(codex.mcp_servers.db.env_vars, ['DB_PASSWORD']);
  assert.match(r.out, /DB_PASSWORD <- secret:team\/db/);
});

test('import captures existing configs, templatizes home paths and replaces plaintext secrets', () => {
  const sb = sandbox();
  baseRepo(sb, ['claude']);
  write(path.join(sb.home, '.claude', 'CLAUDE.md'), '# Mine\n- rule\n');
  write(path.join(sb.home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: `powershell -File ${path.join(sb.home, '.claude', 'statusline.ps1')}` } }));
  write(path.join(sb.home, '.claude', 'output-styles', 'terse.md'), '---\nname: terse\n---\nBe terse.\n');
  write(path.join(sb.home, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { db: { command: 'db', env: { DB_PASSWORD: 'hunter2' } } } }));
  const r = cli(sb, ['import', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(read(path.join(sb.source, 'base', 'instructions', '50-imported-claude.md')), /# Mine/);
  const st = parseJsonc(read(path.join(sb.source, 'base', 'settings', 'claude.json')));
  assert.match(st.statusLine.command, /\{\{home\}\}/);
  assert.ok(fs.existsSync(path.join(sb.source, 'base', 'files', 'claude', 'output-styles', 'terse.md')));
  const db = parseJsonc(read(path.join(sb.source, 'base', 'mcp', 'db.jsonc')));
  assert.equal(db.env.DB_PASSWORD, '${secret:db/db-password}');
  assert.match(r.out, /agent-layers secrets set db\/db-password/);
  const v = cli(sb, ['validate']);
  assert.doesNotMatch(v.out, /hunter2/);
});

test('init writes persona rules in Korean when existing agent instructions are Korean', () => {
  const sb = sandbox();
  write(path.join(sb.home, '.claude', 'CLAUDE.md'), '# 작업 규칙\n\n- 답변은 한국어로 하고, 파일을 고치기 전에 대상 파일을 알려 준다.\n');
  write(path.join(sb.home, '.claude', 'rules', 'review.md'), '- `npm test`를 실행하고 결과를 보고한다.\n');
  const r = cli(sb, ['init']);
  assert.equal(r.code, 0, r.out);
  assert.match(read(path.join(sb.source, 'base', 'instructions', '05-persona.md')), /^# 페르소나 규칙/);
  assert.match(r.out, /persona rules in Korean/);
  assert.equal(cli(sb, ['validate']).code, 0);
});

test('init writes persona rules in English by default and ignores managed blocks and code', () => {
  const sb = sandbox();
  write(path.join(sb.home, '.codex', 'AGENTS.md'), '# My rules\n\n- Keep diffs small.\n\n```text\n한국어 예시 문장입니다\n```\n\n<!-- agent-layers:begin base -->\n관리되는 한국어 블록입니다. 사용자가 직접 쓴 내용이 아닙니다.\n<!-- agent-layers:end base -->\n');
  const r = cli(sb, ['init']);
  assert.equal(r.code, 0, r.out);
  assert.match(read(path.join(sb.source, 'base', 'instructions', '05-persona.md')), /^# Persona/);
  assert.doesNotMatch(read(path.join(sb.source, 'base', 'instructions', '00-working-agreements.md')), /Reply in the language/);
});

test('init --lang overrides detection and rejects unsupported languages', () => {
  const sb = sandbox();
  write(path.join(sb.home, '.claude', 'CLAUDE.md'), '# 작업 규칙\n\n- 답변은 한국어로 한다.\n');
  const bad = cli(sb, ['init', '--lang', 'fr']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /--lang must be one of: en, ko/);
  assert.equal(fs.existsSync(path.join(sb.source, 'agent-layers.jsonc')), false);
  const r = cli(sb, ['init', '--lang', 'en']);
  assert.equal(r.code, 0, r.out);
  assert.match(read(path.join(sb.source, 'base', 'instructions', '05-persona.md')), /^# Persona/);
  assert.match(r.out, /set by --lang/);
});

test('purge only targets agent data of the exact project folder', async () => {
  const { findAgentData } = await import('../src/project.js');
  const { createContext } = await import('../src/context.js');
  const sb = sandbox();
  const ctx = createContext({ home: sb.home });
  const root = path.join(sb.root, 'work');
  const sibling = path.join(sb.root, 'work2');
  write(path.join(sb.home, '.copilot', 'session-state', 'a', 'workspace.yaml'), `cwd: ${root}\n`);
  write(path.join(sb.home, '.copilot', 'session-state', 'b', 'workspace.yaml'), `cwd: ${sibling}\n`);
  write(path.join(sb.home, '.gemini', 'config', 'projects', 'x.json'), JSON.stringify({ path: sibling }));
  write(path.join(sb.home, '.codex', 'sessions', '2026', '10', '04', 'rollout-1.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { cwd: sibling } })}\n`);
  write(path.join(sb.home, '.codex', 'sessions', '2026', '10', '04', 'rollout-2.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { cwd: root } })}\n`);
  const found = findAgentData(ctx, root).filter((d) => d.remove);
  const paths = found.map((d) => d.path);
  assert.ok(paths.some((p) => p.endsWith(path.join('session-state', 'a'))));
  assert.ok(!paths.some((p) => p.endsWith(path.join('session-state', 'b'))));
  assert.ok(!paths.some((p) => p.endsWith('x.json')));
  assert.ok(paths.some((p) => p.endsWith('rollout-2.jsonl')));
  assert.ok(!paths.some((p) => p.endsWith('rollout-1.jsonl')));
});

test('validate flags plaintext secrets and bad skill names', () => {
  const sb = sandbox();
  baseRepo(sb, ['claude']);
  write(path.join(sb.source, 'base', 'mcp', 'bad.jsonc'), '{ "command": "x", "env": { "API_TOKEN": "abc123456789" } }');
  write(path.join(sb.source, 'base', 'skills', 'Bad_Name', 'SKILL.md'), '---\nname: Bad_Name\ndescription: x\n---\n');
  const r = cli(sb, ['validate']);
  assert.equal(r.code, 1);
  assert.match(r.out, /plaintext secret/);
  assert.match(r.out, /skill folder names/);
});

test('uninstall removes managed outputs and keeps foreign content', () => {
  const sb = sandbox();
  baseRepo(sb, ['codex', 'claude']);
  write(path.join(sb.home, '.codex', 'AGENTS.md'), '# Keep\n');
  let r = cli(sb, ['apply', '--yes']);
  assert.equal(r.code, 0, r.out);
  r = cli(sb, ['uninstall', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(path.join(sb.home, '.codex', 'AGENTS.md')).trim(), '# Keep');
  assert.ok(!fs.existsSync(path.join(sb.home, '.claude', 'rules', 'agent-layers', '00-core.md')));
});

test('show lists layers, targets, setting keys and secret names without values', () => {
  const sb = sandbox();
  baseRepo(sb, ['claude', 'codex']);
  write(path.join(sb.source, 'base', 'settings', 'codex.toml'), 'model = "secret-model-value"\n');
  write(path.join(sb.source, 'base', 'skills', 'claude-only', 'SKILL.md'), '---\nname: claude-only\ndescription: Only for Claude.\n---\n# C\n');
  write(path.join(sb.source, 'base', 'skills', 'claude-only', 'agent-layers.jsonc'), '{"targets":["claude"]}');
  write(path.join(sb.source, 'projects', 'acme', 'project.jsonc'), JSON.stringify({ name: 'acme', mode: 'private', match: { dirName: ['acme'] }, targets: ['claude'] }));
  write(path.join(sb.source, 'projects', 'acme', 'mcp', 'tool.jsonc'), JSON.stringify({ command: 'tool', args: [], env: { TOKEN: '${secret:acme/token}' } }));
  let r = cli(sb, ['show']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Layer base/);
  assert.match(r.out, /agents\s+claude, codex/);
  assert.match(r.out, /demo-skill\s+all\s+Demo skill for tests\./);
  assert.match(r.out, /claude-only\s+claude\s+Only for Claude\./);
  assert.match(r.out, /codex\s+codex\.toml\s+model/);
  assert.match(r.out, /acme\s+private\s+match acme\s+not applied\s+mcp 1/);
  assert.doesNotMatch(r.out, /secret-model-value/);
  assert.doesNotMatch(r.out, / +$/m, 'no trailing spaces');
  r = cli(sb, ['show', 'acme']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Layer project:acme/);
  assert.match(r.out, /agents\s+claude$/m);
  assert.match(r.out, /tool\s+all\s+tool\s+secrets: acme\/token/);
  r = cli(sb, ['show', '--json']);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out);
  assert.deepEqual(j.layers.map((l) => l.name), ['base']);
  assert.deepEqual(j.projects[0].mcp[0].secrets, ['acme/token']);
  assert.deepEqual(j.layers[0].settings.find((s) => s.agent === 'codex').keys, ['model']);
  assert.doesNotMatch(r.out, /secret-model-value/);
  r = cli(sb, ['show', 'nope']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no layer named "nope"\. Layers: base, acme/);
});
