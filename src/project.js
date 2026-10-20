import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readText, exists, isDir, listFiles, listDirs } from './util/fsx.js';
import { listProjects, getProject } from './manifest.js';
import { gitDir, normalizeKey } from './render.js';
import { which, run } from './util/proc.js';

export function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (exists(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export function gitRemotes(root) {
  const gd = gitDir(root);
  if (!gd) {
    return [];
  }
  const cfg = readText(path.join(gd, 'config'));
  if (!cfg) {
    return [];
  }
  const urls = [];
  let inRemote = false;
  for (const line of cfg.text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('[')) {
      inRemote = /^\[remote\s+"/.test(t);
      continue;
    }
    const m = /^url\s*=\s*(.+)$/.exec(t);
    if (inRemote && m) {
      urls.push(normalizeRemote(m[1].trim()));
    }
  }
  return urls;
}

export function normalizeRemote(url) {
  let u = url.trim();
  const scp = /^[^@/:]+@([^:/]+):(?!\d+\/)(.+)$/.exec(u);
  if (scp && !u.includes('://')) {
    u = `${scp[1]}/${scp[2]}`;
  } else {
    u = u.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):\d+(?=\/)/, '$1');
  }
  return u.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
}

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

function matchAny(globs, value) {
  return globs.some((g) => globToRegExp(g.replace(/\\/g, '/')).test(value));
}

export function projectMatches(ctx, project, root) {
  const rootSlash = root.replace(/\\/g, '/');
  const bound = ctx.config.projects?.[project.name]?.paths || [];
  if (bound.some((b) => normalizeKey(b) === normalizeKey(root))) {
    return 'bound path';
  }
  if (project.match.path.length && matchAny(project.match.path, rootSlash)) {
    return 'path';
  }
  if (project.match.gitRemote.length) {
    const remotes = gitRemotes(root);
    if (remotes.some((r) => matchAny(project.match.gitRemote.map((g) => g.toLowerCase()), r))) {
      return 'git remote';
    }
  }
  if (project.match.dirName.length && matchAny(project.match.dirName, path.basename(root))) {
    return 'folder name';
  }
  return null;
}

export function resolveProject(ctx, manifest, { name = null, at = null } = {}) {
  const start = path.resolve(at || ctx.cwd);
  const root = findRepoRoot(start) || start;
  if (name) {
    return { project: getProject(manifest, name), root, how: 'named' };
  }
  const hits = [];
  for (const p of listProjects(manifest)) {
    const how = projectMatches(ctx, p, root);
    if (how) {
      hits.push({ project: p, root, how });
    }
  }
  if (hits.length > 1) {
    throw new Error(`${root} matches several projects: ${hits.map((h) => h.project.name).join(', ')}. Pass the project name.`);
  }
  return hits[0] || { project: null, root, how: null };
}

export function claudeProjectDirName(root) {
  return path.resolve(root).replace(/[^A-Za-z0-9]/g, '-');
}

function isWithin(child, parent) {
  const c = normalizeKey(child);
  const p = normalizeKey(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export function assertSafeRoot(ctx, root) {
  const r = path.resolve(root);
  const reasons = [];
  if (path.dirname(r) === r) {
    reasons.push('it is a drive or filesystem root');
  }
  for (const [label, p] of [['your home folder', ctx.paths.home], ['the agent-layers state folder', ctx.paths.stateDir], ['the setup repository', ctx.sourceDir]]) {
    if (p && isWithin(p, r)) {
      reasons.push(`it contains ${label}`);
    }
  }
  if (reasons.length) {
    throw new Error(`refusing to purge ${r}: ${reasons.join('; ')}`);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const f of listFiles(dir)) {
    try {
      total += fs.statSync(f.abs).size;
    } catch {
      continue;
    }
  }
  return total;
}

function readFirstLine(file, max = 65536) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const i = text.indexOf('\n');
    return i >= 0 ? text.slice(0, i) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function fromUri(s) {
  if (/^file:\/\//i.test(s)) {
    try {
      return decodeURIComponent(s.replace(/^file:\/\/\/?/i, '')).replace(/^\/([A-Za-z]:)/, '$1');
    } catch {
      return s;
    }
  }
  return s;
}

function looksLikePath(s) {
  return typeof s === 'string' && (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || /^file:\/\//i.test(s));
}

function collectPathValues(value, out = []) {
  if (typeof value === 'string') {
    if (looksLikePath(value)) {
      out.push(fromUri(value));
    }
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectPathValues(v, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (looksLikePath(k)) {
        out.push(fromUri(k));
      }
      collectPathValues(v, out);
    }
  }
  return out;
}

function pathFieldsFromText(text) {
  const out = [];
  for (const m of text.matchAll(/^\s*["']?(cwd|git_root|gitRoot|workspace|workspaceFolder|workspace_folder|root|path|repository_root|project_root)["']?\s*[:=]\s*["']?([^"'\n,}]+)["']?/gim)) {
    out.push(fromUri(m[2].trim()));
  }
  return out;
}

export function findAgentData(ctx, root, { otherRoots = [] } = {}) {
  const p = ctx.paths;
  const items = [];
  const belongs = (candidate) => {
    if (!candidate) {
      return false;
    }
    const c = path.resolve(candidate);
    if (!isWithin(c, root)) {
      return false;
    }
    return !otherRoots.some((o) => normalizeKey(o) !== normalizeKey(root) && isWithin(o, root) && isWithin(c, o));
  };
  const rootLower = path.resolve(root).replace(/\\/g, '/').toLowerCase();
  const mentions = (text) => text.toLowerCase().replace(/\\\\/g, '\\').replace(/\\/g, '/').includes(rootLower);

  if (which('claude') && !ctx.sandbox) {
    items.push({ agent: 'claude', kind: 'claude purge: transcripts, tasks, file history and the ~/.claude.json entry for this folder', path: root, remove: 'claude-purge' });
  } else {
    const claudeDir = path.join(p.claudeHome, 'projects', claudeProjectDirName(root));
    if (isDir(claudeDir)) {
      const transcripts = listFiles(claudeDir, { recursive: false }).filter((f) => f.rel.endsWith('.jsonl'));
      const foreign = [];
      const own = [];
      for (const t of transcripts) {
        let cwd = null;
        try {
          const lines = fs.readFileSync(t.abs, 'utf8').split('\n').slice(0, 50);
          for (const l of lines) {
            const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(l);
            if (m) {
              cwd = JSON.parse(`"${m[1]}"`);
              break;
            }
          }
        } catch {
          cwd = null;
        }
        if (cwd && !belongs(cwd)) {
          foreign.push(t);
        } else {
          own.push(t);
        }
      }
      if (!foreign.length) {
        items.push({ agent: 'claude', kind: 'transcripts and auto memory', path: claudeDir, bytes: dirSize(claudeDir), remove: 'dir' });
      } else {
        own.forEach((t) => items.push({ agent: 'claude', kind: 'transcript', path: t.abs, bytes: fs.statSync(t.abs).size, remove: 'file' }));
        items.push({ agent: 'claude', kind: `folder shared with ${foreign.length} transcript(s) of another folder that maps to the same name; memory left for manual review`, path: claudeDir, remove: null });
      }
    }
  }

  const projectsJson = readText(path.join(p.geminiHome, 'projects.json'));
  const geminiIds = new Set([crypto.createHash('sha256').update(root).digest('hex')]);
  if (projectsJson) {
    try {
      const j = JSON.parse(projectsJson.text);
      const walk = (obj) => {
        if (!obj || typeof obj !== 'object') {
          return;
        }
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'string' && looksLikePath(k) && normalizeKey(path.resolve(fromUri(k))) === normalizeKey(root)) {
            geminiIds.add(v);
          } else if (typeof v === 'string' && looksLikePath(v) && normalizeKey(path.resolve(fromUri(v))) === normalizeKey(root)) {
            geminiIds.add(k);
          } else if (v && typeof v === 'object') {
            const pv = v.path || v.root;
            if (typeof pv === 'string' && normalizeKey(path.resolve(fromUri(pv))) === normalizeKey(root)) {
              geminiIds.add(v.id || k);
            }
            walk(v);
          }
        }
      };
      walk(j);
    } catch {
      items.push({ agent: 'gemini', kind: 'projects.json could not be parsed; check it manually', path: path.join(p.geminiHome, 'projects.json'), remove: null });
    }
  }
  for (const id of geminiIds) {
    for (const sub of ['tmp', 'history']) {
      const d = path.join(p.geminiHome, sub, id);
      if (isDir(d)) {
        items.push({ agent: 'gemini', kind: `${sub} (chats, checkpoints, memory)`, path: d, bytes: dirSize(d), remove: 'dir' });
      }
    }
  }

  for (const f of listFiles(path.join(p.geminiHome, 'config', 'projects'), { recursive: false })) {
    const t = readText(f.abs);
    if (!t) {
      continue;
    }
    let paths = [];
    try {
      paths = collectPathValues(JSON.parse(t.text));
    } catch {
      paths = pathFieldsFromText(t.text);
    }
    if (paths.some((x) => normalizeKey(path.resolve(x)) === normalizeKey(root))) {
      items.push({ agent: 'antigravity', kind: 'project settings', path: f.abs, bytes: fs.statSync(f.abs).size, remove: 'file' });
    } else if (mentions(t.text)) {
      items.push({ agent: 'antigravity', kind: 'project settings that mention this folder; check manually', path: f.abs, remove: null });
    }
  }

  const brain = path.join(p.geminiHome, 'antigravity', 'brain');
  for (const id of listDirs(brain)) {
    const d = path.join(brain, id);
    const linked = [];
    for (const f of listFiles(d, { recursive: false })) {
      const t = f.rel.endsWith('.md') ? readText(f.abs) : null;
      for (const m of t ? t.text.matchAll(/file:\/\/[^\s)"'<>\]]+/gi) : []) {
        try {
          linked.push(fileURLToPath(m[0]));
        } catch {
          continue;
        }
      }
    }
    if (linked.some((x) => belongs(x))) {
      items.push({ agent: 'antigravity', kind: 'conversation artifacts (task, plan, walkthrough) that link to this folder; check manually', path: d, remove: null });
    }
  }

  for (const base of [path.join(p.codexHome, 'sessions'), path.join(p.codexHome, 'archived_sessions')]) {
    for (const f of listFiles(base)) {
      if (!/rollout-.*\.jsonl$/.test(f.rel)) {
        continue;
      }
      try {
        const meta = JSON.parse(readFirstLine(f.abs));
        const cwd = meta.payload?.cwd || meta.cwd || null;
        if (belongs(cwd)) {
          items.push({ agent: 'codex', kind: 'session rollout', path: f.abs, bytes: fs.statSync(f.abs).size, remove: 'file' });
        }
      } catch {
        continue;
      }
    }
  }
  const codexMem = readText(path.join(p.codexHome, 'memories', 'MEMORY.md'));
  if (codexMem) {
    const hits = codexMem.text.split('\n').filter((l) => mentions(l)).length;
    if (hits) {
      items.push({ agent: 'codex', kind: `global memories mention this folder on ${hits} line(s); review ~/.codex/memories manually`, path: path.join(p.codexHome, 'memories'), remove: null });
    }
  }
  const codexCfg = readText(path.join(p.codexHome, 'config.toml'));
  if (codexCfg && mentions(codexCfg.text)) {
    items.push({ agent: 'codex', kind: 'trust entry [projects.\'<path>\'] in config.toml (left in place)', path: path.join(p.codexHome, 'config.toml'), remove: null });
  }

  const copilotState = path.join(p.copilotHome, 'session-state');
  for (const id of listDirs(copilotState)) {
    const d = path.join(copilotState, id);
    const small = listFiles(d).filter((f) => {
      try {
        return fs.statSync(f.abs).size < 512 * 1024;
      } catch {
        return false;
      }
    }).slice(0, 20);
    const fields = [];
    let mentioned = false;
    for (const f of small) {
      const t = readText(f.abs);
      if (!t) {
        continue;
      }
      fields.push(...pathFieldsFromText(t.text));
      mentioned = mentioned || mentions(t.text);
    }
    if (fields.length && fields.every((x) => belongs(x)) && fields.some((x) => belongs(x))) {
      items.push({ agent: 'copilot', kind: 'local session state (copies synced to GitHub are not removed)', path: d, bytes: dirSize(d), remove: 'dir' });
    } else if (fields.some((x) => belongs(x)) || mentioned) {
      items.push({ agent: 'copilot', kind: 'session state that mentions this folder; check manually', path: d, remove: null });
    }
  }

  const localDir = path.join(root, '.agent-layers');
  if (isDir(localDir)) {
    items.push({ agent: 'agent-layers', kind: 'local project folder (Claude memory written there by the memory option)', path: localDir, bytes: dirSize(localDir), remove: 'dir' });
  }
  const backups = path.join(p.stateDir, 'backups');
  const mangled = path.resolve(root).replace(/^([A-Za-z]):/, '$1').replace(/[\\/:]+/g, '_').toLowerCase();
  for (const stamp of listDirs(backups)) {
    for (const entry of fs.readdirSync(path.join(backups, stamp))) {
      const e = entry.toLowerCase();
      if (e === mangled || e.startsWith(`${mangled}_`)) {
        items.push({ agent: 'agent-layers', kind: 'backup of a project file', path: path.join(backups, stamp, entry), remove: 'dir' });
      }
    }
  }
  return items;
}

export function purgeAgentData(ctx, items) {
  const results = [];
  for (const it of items) {
    if (!it.remove) {
      continue;
    }
    try {
      if (it.remove === 'dir' || it.remove === 'file') {
        fs.rmSync(it.path, { recursive: true, force: true });
      } else if (it.remove === 'claude-purge') {
        const r = run('claude', ['purge', it.path, '--yes'], { timeout: 120000 });
        if (r.code !== 0) {
          throw new Error((r.stderr || r.stdout).trim() || `claude purge exited with ${r.code}`);
        }
      }
      results.push({ it, status: 'done' });
    } catch (err) {
      results.push({ it, status: 'failed', error: err.message });
    }
  }
  return results;
}
