import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADAPTERS } from './adapters/registry.js';
import { detectAdapters } from './render.js';
import { which, run, firstLine } from './util/proc.js';
import { readText, exists, isDir, listDirs } from './util/fsx.js';
import { parseJsonc } from './formats/jsonc.js';
import { TomlDocument } from './formats/toml.js';
import { getBlockContent } from './formats/mdblock.js';
import { hasSource } from './context.js';
import { loadState } from './state.js';
import { backendFor } from './secrets/index.js';
import { findRepoRoot } from './project.js';
import { SECRET_KEY, REFERENCE } from './util/redact.js';

const PROJECT_CONFIGS = ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.gemini/settings.json', '.codex/config.toml', '.kimi-code/mcp.json', '.grok/config.toml'];
const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function version(cmd) {
  const r = run(cmd, ['--version'], { timeout: 15000 });
  return r.code === 0 ? firstLine(r.stdout || r.stderr) : null;
}

function symlinkCapable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-probe-'));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 't.txt');
    const link = path.join(dir, 'l.txt');
    fs.writeFileSync(target, 'x');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function jsonObject(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function plaintextSecrets(obj, prefix = '') {
  const hits = [];
  if (!obj || typeof obj !== 'object') {
    return hits;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      if (SECRET_KEY.test(k) && v && !REFERENCE.test(v)) {
        hits.push(p);
      }
      const nested = /^\s*[{[]/.test(v) ? jsonObject(v) : null;
      if (nested) {
        hits.push(...plaintextSecrets(nested, p));
      }
      if (/^(ghp_|github_pat_|sk-ant-|sk-[A-Za-z0-9]{20,}|xox[bp]-|AKIA[0-9A-Z]{16})/.test(v)) {
        hits.push(`${p} (token pattern)`);
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => {
        if (typeof x === 'string' && /^(ghp_|github_pat_|sk-ant-|AKIA)/.test(x)) {
          hits.push(`${p}[${i}] (token pattern)`);
        }
        if (typeof x === 'string' && /^--?(password|token|secret)=.+/i.test(x)) {
          hits.push(`${p}[${i}]`);
        }
      });
    } else {
      hits.push(...plaintextSecrets(v, p));
    }
  }
  return hits;
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function projectSecretChecks(root) {
  const checks = [];
  for (const f of PROJECT_CONFIGS) {
    const t = readText(path.join(root, f));
    if (!t) {
      continue;
    }
    try {
      const hits = plaintextSecrets(f.endsWith('.toml') ? new TomlDocument(t.text).plain : parseJsonc(t.text));
      if (hits.length) {
        checks.push({ level: 'error', msg: `${path.join(root, f)}: possible plaintext secrets at ${hits.join(', ')}; replace them with \${secret:NAME} in the source and let agent-layers render references` });
      }
    } catch {
      continue;
    }
  }
  return checks;
}

export function compareVersions(a, b) {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  for (let i = 1; i <= 3; i += 1) {
    if (Number(x[i]) !== Number(y[i])) {
      return Number(x[i]) < Number(y[i]) ? -1 : 1;
    }
  }
  if (x[4] === y[4]) {
    return 0;
  }
  if (!x[4] || !y[4]) {
    return x[4] ? -1 : 1;
  }
  return x[4] < y[4] ? -1 : 1;
}

export function updateCommand(cliPath, latest) {
  const bin = path.resolve(cliPath);
  const parts = bin.split(path.sep);
  if (parts.includes('_npx')) {
    return `npx ${PKG.name}@latest`;
  }
  if (parts.includes('node_modules')) {
    return `npm install --global ${PKG.name}@${latest}`;
  }
  return `git -C "${path.dirname(path.dirname(bin))}" pull`;
}

function checkUpdate(ctx) {
  const update = { installed: PKG.version, latest: null, status: 'skipped', command: null };
  if (ctx.flags.fast) {
    return update;
  }
  const r = run('npm', ['view', PKG.name, 'version', '--prefer-online', '--fetch-retries=0', '--fetch-timeout=10000'], { timeout: 15000 });
  const latest = r.code === 0 ? firstLine(r.stdout).trim() : '';
  if (!SEMVER.test(latest) || !SEMVER.test(PKG.version)) {
    update.status = 'unknown';
    return update;
  }
  const order = compareVersions(PKG.version, latest);
  update.latest = latest;
  update.status = order < 0 ? 'outdated' : order > 0 ? 'newer' : 'latest';
  if (order < 0) {
    update.command = updateCommand(ctx.cliPath, latest);
  }
  return update;
}

export function runDoctor(ctx) {
  const report = { env: [], agents: [], checks: [] };
  const add = (level, msg) => report.checks.push({ level, msg });
  report.env.push(['OS', `${ctx.os} (${process.platform} ${process.arch})`]);
  report.env.push(['Node.js', process.version]);
  const update = checkUpdate(ctx);
  report.update = update;
  const label = { outdated: `latest ${update.latest}`, latest: 'latest', newer: `newer than npm ${update.latest}`, unknown: 'latest version unknown: npm view failed', skipped: 'update check skipped: --fast' }[update.status];
  report.env.push(['agent-layers', `${update.installed} (${label})`]);
  if (update.command) {
    add('warn', `agent-layers ${update.latest} is available (installed ${update.installed}). Update: ${update.command}`);
  }
  report.env.push(['Home', ctx.paths.home + (ctx.sandbox ? ' (sandbox)' : '')]);
  report.env.push(['State dir', ctx.paths.stateDir]);
  report.env.push(['Source repo', `${ctx.sourceDir}${hasSource(ctx) ? '' : ' (missing: run "agent-layers init")'}`]);
  report.env.push(['git', which('git') ? version('git') || 'found' : 'not found']);
  let backend = 'unavailable';
  try {
    backend = backendFor(ctx).id;
  } catch (err) {
    backend = err.message;
  }
  report.env.push(['Secrets backend', backend]);
  if (process.platform === 'win32') {
    report.env.push(['Symlinks', symlinkCapable() ? 'allowed' : 'not allowed (Developer Mode off); agent-layers copies files, so this is fine']);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    add('error', `Node.js ${process.version} is too old; agent-layers needs 18.17 or newer`);
  }
  if (!which('git')) {
    add('warn', 'git is not installed; "init --from", "sync" and private-mode git excludes need it');
  }

  const detected = new Map(detectAdapters(ctx).map((d) => [d.id, d]));
  for (const a of ADAPTERS) {
    const d = detected.get(a.id);
    if (!d) {
      continue;
    }
    const cmd = d.commands[0];
    const rawVer = cmd && !ctx.flags.fast ? version(cmd) : null;
    const ver = rawVer ? rawVer.replace(/\s+[-–]\s+.*$/, '').slice(0, 40) : null;
    const always = a.user?.instructions?.always;
    let insFile = null;
    let managed = '-';
    if (always?.kind === 'block') {
      insFile = always.file(ctx.paths, ctx.os);
      if (exists(insFile)) {
        managed = getBlockContent(readText(insFile).text, 'base') !== null ? 'managed block present' : 'no managed block';
      }
    } else if (always?.kind === 'files') {
      insFile = always.dir(ctx.paths, ctx.os);
      managed = isDir(insFile) ? 'managed rules present' : 'not applied yet';
    }
    const where = !insFile ? '(app settings UI)' : always.kind === 'block' ? `${insFile} (${sizeOf(insFile)} B)` : `${insFile}${path.sep}`;
    report.agents.push([a.id, a.name, cmd || '(app folder only)', ver || '-', where, managed, a.tier]);
    for (const n of a.notes || []) {
      add('info', `${a.id}${a.tier === 2 ? ' (tier 2, best effort)' : ''}: ${n}`);
    }
  }

  const codexCfg = path.join(ctx.paths.codexHome, 'config.toml');
  const ct = readText(codexCfg);
  if (ct) {
    try {
      const doc = new TomlDocument(ct.text);
      const known = ['model', 'approval_policy', 'sandbox_mode', 'mcp_servers', 'features', 'model_reasoning_effort', 'profile', 'notify', 'projects'];
      for (const [table, v] of Object.entries(doc.plain)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && table !== 'projects') {
          const misplaced = Object.keys(v).filter((k) => known.includes(k) && k !== table);
          if (misplaced.length) {
            add('warn', `codex: [${table}] contains ${misplaced.join(', ')}; these look like top-level keys written after the [${table}] header and are ignored by Codex`);
          }
        }
      }
      const hits = plaintextSecrets(doc.plain);
      if (hits.length) {
        add('warn', `codex: ${codexCfg} has possible plaintext secrets at ${hits.join(', ')}`);
      }
      if (/^profile\s*=/m.test(ct.text)) {
        add('warn', 'codex: "profile = ..." is no longer supported since 0.134.0; use ~/.codex/<name>.config.toml profile files');
      }
    } catch (err) {
      add('error', `codex: ${codexCfg} does not parse: ${err.message}`);
    }
  }
  const ag = readText(path.join(ctx.paths.codexHome, 'AGENTS.md'));
  if (ag && Buffer.byteLength(ag.text) > 32768) {
    add('warn', `codex: ~/.codex/AGENTS.md is ${Buffer.byteLength(ag.text)} bytes; project_doc_max_bytes defaults to 32 KiB for all AGENTS.md files combined`);
  }
  const gk = readText(path.join(ctx.paths.grokHome, 'AGENTS.md'));
  if (gk && [...gk.text].length > 10000) {
    add('warn', `grok: ~/.grok/AGENTS.md is ${[...gk.text].length} characters; Grok Build truncates each rules file at 10,000 characters`);
  }

  const root = findRepoRoot(ctx.cwd);
  if (root) {
    const has = (f) => exists(path.join(root, f));
    if (has('.github/copilot-instructions.md') && has('AGENTS.md')) {
      add('warn', `${root}: Zed reads only .github/copilot-instructions.md here and ignores AGENTS.md (first-match order)`);
    }
    const claudeMd = readText(path.join(root, 'CLAUDE.md'));
    if (claudeMd && has('AGENTS.md') && !/@AGENTS\.md/.test(claudeMd.text) && claudeMd.text.trim().length > 200) {
      add('warn', `${root}: CLAUDE.md has its own content and AGENTS.md exists; Copilot CLI, Cursor CLI, Devin and Factory read both files`);
    }
    report.checks.push(...projectSecretChecks(root));
    const ag2 = readText(path.join(ctx.paths.geminiHome, 'config', 'mcp_config.json'));
    if (ag2) {
      try {
        const hits = plaintextSecrets(parseJsonc(ag2.text));
        if (hits.length) {
          add('warn', `antigravity: ~/.gemini/config/mcp_config.json has possible plaintext secrets at ${hits.join(', ')}`);
        }
      } catch {
        add('warn', 'antigravity: ~/.gemini/config/mcp_config.json does not parse');
      }
    }
  }

  const memDir = path.join(ctx.paths.claudeHome, 'projects');
  if (isDir(memDir)) {
    for (const d of listDirs(memDir)) {
      const idx = path.join(memDir, d, 'memory', 'MEMORY.md');
      const n = sizeOf(idx);
      if (n > 25000) {
        add('warn', `claude: ${idx} is ${n} bytes; only the first 200 lines / 25 KB load at startup`);
      }
    }
  }

  const state = loadState(ctx);
  const outCount = Object.keys(state.outputs).length;
  report.env.push(['Managed outputs', String(outCount)]);
  return report;
}
