import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS, getAdapter } from './adapters/registry.js';
import { joinFrontmatter } from './formats/frontmatter.js';
import { tomlBasicString } from './formats/toml.js';
import { deepMerge } from './formats/jsonmerge.js';
import { renderString, renderDeep, findSecretRefs, hasSecretRef, secretEnvName, isPureSecretRef, isPureEnvRef } from './template.js';
import { which, run } from './util/proc.js';
import { exists, readText } from './util/fsx.js';
import { removeBlock } from './formats/mdblock.js';
import { scopeKeyOf } from './state.js';

export const BLOCK_USER = 'base';
const EXEC_EXT = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|exe|py|js|mjs|cjs|ts|rb|pl)$/i;
const EXEC_SETTINGS = ['statusLine', 'hooks', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'notify', 'subagentStatusLine'];

function describeExec(v) {
  let s;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.command !== undefined) {
      s = [].concat(v.command, v.args || []).join(' ');
    } else if (v.url || v.httpUrl || v.serverUrl) {
      s = v.url || v.httpUrl || v.serverUrl;
    } else {
      s = JSON.stringify(v);
    }
  } else {
    s = Array.isArray(v) ? v.join(' ') : String(v);
  }
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}
export const WRAP_OPEN = '@@secret:';
export const WRAP_CLOSE = '@@';

const SECRET_INLINE = /\$\{secret:([A-Za-z0-9_./-]+)\}/g;
const ENV_INLINE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function detectAdapters(ctx) {
  const found = [];
  for (const a of ADAPTERS) {
    const cmds = (a.detect.commands || []).filter((c) => which(c, ctx.env));
    const dirs = (a.detect.dirs ? a.detect.dirs(ctx.paths, ctx.os) : []).filter((d) => exists(d));
    if (cmds.length || dirs.length) {
      found.push({ id: a.id, commands: cmds, dirs });
    }
  }
  return found;
}

export function resolveTargets(ctx, manifest, { project = null, only = null, skip = null } = {}) {
  let ids;
  let spec = manifest.targets;
  if (project && project.targets !== 'inherit' && project.targets) {
    spec = project.targets;
  }
  if (spec === 'all') {
    ids = ADAPTERS.map((a) => a.id);
  } else if (spec === 'auto' || !spec) {
    ids = detectAdapters(ctx).map((d) => d.id);
  } else {
    ids = [].concat(spec);
  }
  const local = ctx.config.targets || {};
  for (const extra of [].concat(local.include || [])) {
    if (!ids.includes(extra)) {
      ids.push(extra);
    }
  }
  ids = ids.filter((id) => !(local.exclude || []).includes(id));
  if (only && only.length) {
    ids = ids.filter((id) => only.includes(id));
    for (const id of only) {
      if (!ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  if (skip && skip.length) {
    ids = ids.filter((id) => !skip.includes(id));
  }
  return ids.map((id) => getAdapter(id));
}

export function buildVars(ctx, manifest, project = null, root = null) {
  const builtin = {
    home: ctx.paths.home,
    os: ctx.os,
    hostname: ctx.hostname,
    user: ctx.user,
    sep: path.sep,
    source: ctx.sourceDir,
    node: ctx.nodePath,
    agentLayers: ctx.cliPath,
    appData: ctx.paths.appData,
    localAppData: ctx.paths.localAppData,
    xdgConfig: ctx.paths.xdgConfig,
    claudeHome: ctx.paths.claudeHome,
    codexHome: ctx.paths.codexHome,
    geminiHome: ctx.paths.geminiHome,
    copilotHome: ctx.paths.copilotHome,
    homeSlash: ctx.paths.home.replace(/\\/g, '/'),
  };
  const raw = deepMerge(deepMerge(manifest.vars || {}, ctx.config.vars || {}), project ? project.vars || {} : {});
  const scope = { ...builtin };
  if (project) {
    scope.project = { name: project.name, root: root || '', rootSlash: (root || '').replace(/\\/g, '/') };
  }
  const first = renderDeep(raw, { ...scope, vars: raw }, { missing: [] });
  const vars = renderDeep(first, { ...scope, vars: first });
  return { ...scope, vars };
}

function forAdapter(list, id) {
  return list.filter((i) => (!i.targets || i.targets.includes(id)) && !(i.exclude || []).includes(id));
}

function instructionText(ins, vars) {
  const body = ins.template ? renderString(ins.body, vars, { source: ins.file }) : ins.body;
  return body.replace(/\s+$/, '');
}

function header(layers, opts) {
  if (!opts.instructions?.header) {
    return '';
  }
  return `<!-- Managed by agent-layers (layers: ${layers.join(', ')}). Edit the source repository, then run "agent-layers apply". -->`;
}

function blockContent(rules, vars, layers, opts) {
  const parts = [];
  const h = header(layers, opts);
  if (h) {
    parts.push(h);
  }
  for (const r of rules) {
    parts.push(instructionText(r, vars));
  }
  return parts.join('\n\n');
}

function dialectFile(dialect, { id, prefix = '', paths = [], description = '', always = false }) {
  const globs = paths.join(',');
  switch (dialect) {
    case 'claude':
      return { name: `${prefix}${id}.md`, fm: always ? {} : { paths } };
    case 'antigravity':
      return { name: `${prefix}${id}.md`, fm: always ? { trigger: 'always_on' } : { trigger: 'glob', globs } };
    case 'copilot':
      return { name: `${prefix}${id}.instructions.md`, fm: { ...(description ? { description } : {}), applyTo: always ? '**' : globs } };
    case 'cursor':
      return { name: `${prefix}${id}.mdc`, fm: always ? { ...(description ? { description } : {}), alwaysApply: true } : { ...(description ? { description } : {}), globs, alwaysApply: false } };
    case 'kiro':
      return { name: `${prefix}${id}.md`, fm: always ? { inclusion: 'always' } : { inclusion: 'fileMatch', fileMatchPattern: paths.length === 1 ? paths[0] : paths } };
    case 'cline':
      return { name: `${prefix}${id}.md`, fm: always ? {} : { paths } };
    default:
      return { name: `${prefix}${id}.md`, fm: {} };
  }
}

function ruleFileContent(dialect, rule, vars, layers, opts, always) {
  const { name, fm } = dialectFile(dialect, { id: rule.id, prefix: opts.prefix || '', paths: rule.paths, description: rule.description, always });
  const h = header(layers, opts.manifestOptions);
  const body = `${h ? `${h}\n\n` : ''}${instructionText(rule, vars)}\n`;
  return { name, content: joinFrontmatter(fm, body) };
}

class Outputs {
  constructor(scopeKey) {
    this.scopeKey = scopeKey;
    this.map = new Map();
    this.notes = [];
  }

  key(o) {
    const p = normalizeKey(o.path);
    if (o.type === 'block') {
      return `${this.scopeKey}|block|${p}|${o.blockId}`;
    }
    if (o.type === 'claude-mcp') {
      return `${this.scopeKey}|claude-mcp|${o.scope}|${p}|${o.cwd ? normalizeKey(o.cwd) : ''}`;
    }
    return `${this.scopeKey}|${o.type}|${p}`;
  }

  add(o) {
    o.adapters = new Set([].concat(o.adapter || []));
    delete o.adapter;
    o.id = this.key(o);
    const prev = this.map.get(o.id);
    if (!prev) {
      this.map.set(o.id, o);
      return;
    }
    o.adapters.forEach((a) => prev.adapters.add(a));
    prev.exclude = prev.exclude || o.exclude;
    if (o.type === 'json') {
      prev.fragment = deepMerge(prev.fragment, o.fragment);
      prev.atomic = [...(prev.atomic || []), ...(o.atomic || [])];
    } else if (o.type === 'toml') {
      prev.values = deepMerge(prev.values || {}, o.values || {});
      prev.tables = { ...(prev.tables || {}), ...(o.tables || {}) };
    } else if (o.type === 'claude-mcp') {
      prev.servers = { ...prev.servers, ...o.servers };
    } else {
      const same = o.type === 'dir' ? JSON.stringify(o.files.map((f) => [f.rel, String(f.content)])) === JSON.stringify(prev.files.map((f) => [f.rel, String(f.content)])) : String(o.content) === String(prev.content);
      if (!same) {
        this.notes.push({ level: 'warn', msg: `${o.path}: ${[...o.adapters].join(', ')} and ${[...prev.adapters].join(', ')} want different content; keeping the first one` });
      }
    }
  }

  list() {
    return [...this.map.values()];
  }
}

export function normalizeKey(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export function isWithinPath(child, parent) {
  const c = normalizeKey(child);
  const p = normalizeKey(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export function assertOutputsWithin(outputs, roots, files = []) {
  const allowed = new Set(files.map(normalizeKey));
  for (const o of outputs) {
    if (!allowed.has(normalizeKey(o.path)) && !roots.some((r) => isWithinPath(o.path, r))) {
      throw new Error(`refusing to write ${o.path}: project outputs must stay inside ${roots[0]}`);
    }
  }
}

function convertCommand(cmd, format) {
  if (format === 'claude') {
    return { ext: '.md', content: cmd.raw.endsWith('\n') ? cmd.raw : `${cmd.raw}\n` };
  }
  if (format === 'gemini') {
    const prompt = cmd.body.replace(/\$ARGUMENTS/g, '{{args}}').replace(/\s+$/, '');
    const lines = [];
    if (cmd.description) {
      lines.push(`description = ${tomlBasicString(cmd.description)}`);
    }
    const literalOk = !prompt.includes("'''");
    lines.push(literalOk ? `prompt = '''\n${prompt}\n'''` : `prompt = ${tomlBasicString(prompt)}`);
    return { ext: '.toml', content: `${lines.join('\n')}\n` };
  }
  return null;
}

function envRef(syntax, name) {
  return syntax.replace('VAR', name);
}

function wrapToken(s) {
  return s.replace(SECRET_INLINE, (_, n) => `${WRAP_OPEN}${n}${WRAP_CLOSE}`);
}

export function convertMcpServer(name, rawDef, { format, env: envSyntax, policy, ctx, resolveSecret, notes, requiredEnv }) {
  const def = { ...rawDef };
  const transport = def.transport || def.type || (def.command ? 'stdio' : def.url ? 'http' : 'stdio');
  let command = def.command;
  let args = [...(def.args || [])];
  let env = { ...(def.env || {}) };
  let headers = { ...(def.headers || {}) };
  let url = def.url;
  const envVars = [];
  let bearerEnv = null;
  const envHttpHeaders = {};
  const secrets = findSecretRefs({ args, env, headers, url });
  const targetRefOk = Boolean(envSyntax) || format === 'codex';
  const toReference = (value, fallbackKey) => {
    if (format === 'codex') {
      return value;
    }
    return value
      .replace(SECRET_INLINE, (_, n) => {
        const v = isPureSecretRef(value) && fallbackKey ? fallbackKey : secretEnvName(n);
        requiredEnv.add(`${v} <- secret:${n}`);
        return envRef(envSyntax, v);
      })
      .replace(ENV_INLINE, (_, n) => {
        requiredEnv.add(n);
        return envRef(envSyntax, n);
      });
  };
  let effective = policy;
  if (effective === 'auto') {
    effective = transport === 'stdio' ? 'wrapper' : targetRefOk ? 'reference' : 'skip';
  }
  if (secrets.size && effective === 'wrapper' && transport !== 'stdio') {
    effective = targetRefOk ? 'reference' : 'skip';
  }
  if (secrets.size && effective === 'skip') {
    notes.push({ level: 'warn', msg: `${name}: the ${format} config cannot reference environment variables, so this HTTP server is not written for it. Set options.secrets.mode to "materialize" to write the secret into that machine-local file.` });
    return null;
  }
  if (secrets.size && effective === 'wrapper') {
    const execArgs = [ctx.cliPath, 'exec'];
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string' && hasSecretRef(v)) {
        execArgs.push('--env', `${k}=${wrapToken(v)}`);
        delete env[k];
      }
    }
    args = args.map((a) => (typeof a === 'string' && hasSecretRef(a) ? wrapToken(a) : a));
    args = [...execArgs, '--', command, ...args];
    command = ctx.nodePath;
  } else if (secrets.size && effective === 'materialize') {
    const sub = (v) => (typeof v === 'string' ? v.replace(SECRET_INLINE, (_, n) => {
      const val = resolveSecret ? resolveSecret(n) : null;
      if (val === null || val === undefined) {
        notes.push({ level: 'error', msg: `${name}: secret "${n}" is not available; run "agent-layers secrets set ${n}"` });
        return '';
      }
      return val;
    }) : v);
    args = args.map(sub);
    env = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, sub(v)]));
    headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, sub(v)]));
    url = sub(url);
    notes.push({ level: 'warn', msg: `${name}: secret values are written in plain text into a machine-local file (${format})` });
  } else if (secrets.size || findEnvRefs({ args, env, headers, url })) {
    if (!targetRefOk) {
      notes.push({ level: 'error', msg: `${name}: the ${format} config format cannot reference environment variables; use secrets mode "wrapper" or "materialize" for this target` });
      return null;
    }
    if (format === 'codex') {
      for (const [k, v] of Object.entries(env)) {
        if (typeof v !== 'string') {
          continue;
        }
        if (isPureSecretRef(v) || isPureEnvRef(v)) {
          const n = /\$\{(?:secret|env):([^}]+)\}/.exec(v)[1];
          const varName = isPureEnvRef(v) ? n : k;
          envVars.push(varName === k ? k : { name: k, source: varName });
          requiredEnv.add(isPureSecretRef(v) ? `${k} <- secret:${n}` : varName);
          delete env[k];
        } else if (hasSecretRef(v) || /\$\{env:[A-Za-z_][A-Za-z0-9_]*\}/.test(v)) {
          notes.push({ level: 'error', msg: `${name}: Codex cannot interpolate part of an env value (${k}); use a whole-value reference` });
          return null;
        }
      }
      for (const [k, v] of Object.entries(headers)) {
        const m = /^Bearer \$\{(?:secret|env):([^}]+)\}$/.exec(v || '');
        if (k.toLowerCase() === 'authorization' && m) {
          bearerEnv = v.includes('${secret:') ? secretEnvName(m[1]) : m[1];
          requiredEnv.add(v.includes('${secret:') ? `${bearerEnv} <- secret:${m[1]}` : bearerEnv);
          delete headers[k];
        } else if (isPureSecretRef(v) || isPureEnvRef(v)) {
          const n = /\$\{(?:secret|env):([^}]+)\}/.exec(v)[1];
          const varName = v.includes('${secret:') ? secretEnvName(n) : n;
          envHttpHeaders[k] = varName;
          requiredEnv.add(v.includes('${secret:') ? `${varName} <- secret:${n}` : varName);
          delete headers[k];
        }
      }
      if (args.some((a) => typeof a === 'string' && (hasSecretRef(a) || /\$\{env:/.test(a)))) {
        notes.push({ level: 'error', msg: `${name}: Codex does not expand variables inside args; move the value into env` });
        return null;
      }
    } else {
      args = args.map((a) => (typeof a === 'string' ? toReference(a) : a));
      env = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === 'string' ? toReference(v, k) : v]));
      headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, typeof v === 'string' ? toReference(v) : v]));
      url = typeof url === 'string' ? toReference(url) : url;
    }
  }
  const hasEnv = Object.keys(env).length > 0;
  const hasHeaders = Object.keys(headers).length > 0;
  const stdio = transport === 'stdio';
  switch (format) {
    case 'claude':
      return stdio ? { type: 'stdio', command, args, ...(hasEnv ? { env } : {}) } : { type: transport === 'sse' ? 'sse' : 'http', url, ...(hasHeaders ? { headers } : {}) };
    case 'gemini':
      return stdio ? { command, args, ...(hasEnv ? { env } : {}), ...(def.cwd ? { cwd: def.cwd } : {}) } : transport === 'sse' ? { url, ...(hasHeaders ? { headers } : {}) } : { httpUrl: url, ...(hasHeaders ? { headers } : {}) };
    case 'antigravity':
      return stdio ? { command, args, ...(hasEnv ? { env } : {}), ...(def.cwd ? { cwd: def.cwd } : {}) } : { serverUrl: url, ...(hasHeaders ? { headers } : {}) };
    case 'copilot':
      return stdio ? { type: 'local', command, args, ...(hasEnv ? { env } : {}), tools: ['*'] } : { type: 'http', url, ...(hasHeaders ? { headers } : {}), tools: ['*'] };
    case 'cursor':
    case 'generic':
      return stdio ? { command, args, ...(hasEnv ? { env } : {}) } : { url, ...(hasHeaders ? { headers } : {}) };
    case 'kimi':
      return stdio ? { command, args, ...(hasEnv ? { env } : {}), ...(def.cwd ? { cwd: def.cwd } : {}) } : { ...(transport === 'sse' ? { transport: 'sse' } : {}), url, ...(hasHeaders ? { headers } : {}) };
    case 'grok':
      return stdio ? { command, args, ...(hasEnv ? { env } : {}), ...(def.cwd ? { cwd: def.cwd } : {}) } : { url, ...(hasHeaders ? { headers } : {}) };
    case 'opencode':
      return stdio ? { type: 'local', command: [command, ...args], ...(hasEnv ? { environment: env } : {}), enabled: true } : { type: 'remote', url, ...(hasHeaders ? { headers } : {}), enabled: true };
    case 'codex': {
      if (stdio) {
        const t = { command, args };
        if (hasEnv) {
          t.env = env;
        }
        if (def.cwd) {
          t.cwd = def.cwd;
        }
        const simple = envVars.filter((v) => typeof v === 'string');
        if (simple.length) {
          t.env_vars = simple;
        }
        const mapped = envVars.filter((v) => typeof v !== 'string');
        if (mapped.length) {
          notes.push({ level: 'warn', msg: `${name}: Codex forwards env vars by name only; set ${mapped.map((m) => m.name).join(', ')} in the environment` });
          t.env_vars = [...(t.env_vars || []), ...mapped.map((m) => m.name)];
        }
        return t;
      }
      const t = { url };
      if (bearerEnv) {
        t.bearer_token_env_var = bearerEnv;
      }
      if (hasHeaders) {
        t.http_headers = headers;
      }
      if (Object.keys(envHttpHeaders).length) {
        t.env_http_headers = envHttpHeaders;
      }
      return t;
    }
    default:
      return null;
  }
}

function findEnvRefs(value) {
  return JSON.stringify(value).includes('${env:');
}

export function trackedFiles(root, relPaths) {
  const tracked = new Set();
  if (!relPaths.length) {
    return { tracked, reliable: true };
  }
  const assumeExisting = () => {
    relPaths.filter((r) => exists(path.join(root, r))).forEach((r) => tracked.add(r));
    return tracked;
  };
  if (!which('git')) {
    return { tracked: assumeExisting(), reliable: false, reason: 'git is not installed' };
  }
  const r = run('git', ['-C', root, 'ls-files', '-z', '--', ...relPaths], { timeout: 20000 });
  if (r.code !== 0) {
    return { tracked: assumeExisting(), reliable: false, reason: (r.stderr || r.stdout).trim().split('\n')[0] || `git exited with ${r.code}` };
  }
  r.stdout.split('\0').filter(Boolean).forEach((f) => tracked.add(f.replace(/\\/g, '/')));
  return { tracked, reliable: true };
}

export function gitDir(root) {
  const dotgit = path.join(root, '.git');
  try {
    const st = fs.statSync(dotgit);
    if (st.isDirectory()) {
      return dotgit;
    }
    const r = readText(dotgit);
    const m = r && /gitdir:\s*(.+)/.exec(r.text);
    if (m) {
      const gd = path.resolve(root, m[1].trim());
      const common = readText(path.join(gd, 'commondir'));
      return common ? path.resolve(gd, common.text.trim()) : gd;
    }
  } catch {
    return null;
  }
  return null;
}

export function renderScope(ctx, { scope, manifest, merged, adapters, project = null, root = null, resolveSecret = null }) {
  const out = new Outputs(scopeKeyOf(scope, project ? project.name : null, root));
  const opts = manifest.options;
  const vars = buildVars(ctx, manifest, project, root);
  const p = ctx.paths;
  const os = ctx.os;
  const mode = project ? project.mode : null;
  const privateMode = mode === 'private';
  const blockId = scope === 'user' ? BLOCK_USER : `project.${project.name}`;
  const requiredEnv = new Set();
  const executables = new Set();
  const layerNames = merged.layers;
  const adapterIds = adapters.map((a) => a.id);
  const notes = out.notes;
  const always = merged.instructions.filter((i) => !i.paths.length);
  const scoped = merged.instructions.filter((i) => i.paths.length);
  const fileOpts = (prefix) => ({ prefix, manifestOptions: opts });
  const agentsMdReaders = [];

  for (const a of adapters) {
    const spec = scope === 'user' ? a.user : a.project;
    if (!spec) {
      continue;
    }
    const alwaysA = forAdapter(always, a.id);
    const scopedA = forAdapter(scoped, a.id);
    const fallbackScoped = scopedA.filter((r) => r.data.fallback === 'always');
    if (scope === 'user') {
      const ins = spec.instructions;
      if (!ins) {
        if (alwaysA.length || scopedA.length) {
          notes.push({ level: 'info', msg: `${a.id}: no file-based user instructions; set them in the app UI (${a.name})` });
        }
      } else {
        const hasScoped = Boolean(ins.scoped);
        const alwaysRules = hasScoped ? alwaysA : [...alwaysA, ...fallbackScoped];
        if (ins.always.kind === 'block') {
          if (alwaysRules.length) {
            out.add({ type: 'block', path: ins.always.file(p, os), blockId, content: blockContent(alwaysRules, vars, layerNames, opts), adapter: a.id, scope });
          }
        } else if (ins.always.kind === 'files') {
          for (const r of alwaysRules) {
            const f = ruleFileContent(ins.always.dialect, r, vars, layerNames, fileOpts(ins.always.prefix), true);
            out.add({ type: 'file', path: path.join(ins.always.dir(p, os), f.name), content: f.content, adapter: a.id, scope });
          }
        }
        if (hasScoped) {
          for (const r of scopedA) {
            const f = ruleFileContent(ins.scoped.dialect, r, vars, layerNames, fileOpts(ins.scoped.prefix), false);
            out.add({ type: 'file', path: path.join(ins.scoped.dir(p, os), f.name), content: f.content, adapter: a.id, scope });
          }
        } else {
          const skipped = scopedA.filter((r) => r.data.fallback !== 'always');
          if (skipped.length) {
            notes.push({ level: 'info', msg: `${a.id}: path-scoped rules are not supported at user level; skipped ${skipped.map((r) => r.id).join(', ')} (set "fallback: always" to include them)` });
          }
        }
      }
    } else {
      const projAlways = spec.always ? spec.always[mode] : null;
      const rules = spec.scoped ? alwaysA : [...alwaysA, ...fallbackScoped];
      if (projAlways && rules.length) {
        if (projAlways.kind === 'agents-md' || projAlways.kind === 'claude-agents-shim') {
          agentsMdReaders.push({ id: a.id, rules });
          if (projAlways.kind === 'claude-agents-shim') {
            const claudeMd = path.join(root, 'CLAUDE.md');
            const text = readText(claudeMd)?.text;
            const own = text === undefined || text === null ? text : removeBlock(text, 'agents-md');
            const importMode = opts.claude?.agentsMdImport;
            if ((own !== undefined && own !== null && !/@AGENTS\.md/.test(own)) || (importMode === true && (text === undefined || text === null))) {
              out.add({ type: 'block', path: claudeMd, blockId: 'agents-md', content: '@AGENTS.md', adapter: a.id, scope, shared: true });
            }
          }
        } else if (projAlways.kind === 'block') {
          out.add({ type: 'block', path: projAlways.file(root), blockId, content: blockContent(rules, vars, layerNames, opts), adapter: a.id, scope, exclude: true, privateOnly: true });
        } else if (projAlways.kind === 'block-if-untracked') {
          out.add({ type: 'block', path: projAlways.file(root), blockId, content: blockContent(rules, vars, layerNames, opts), adapter: a.id, scope, exclude: true, privateOnly: true, skipIfTracked: true });
        } else if (projAlways.kind === 'file') {
          const merged1 = { id: project.name, paths: [], description: project.description || `Project rules for ${project.name}`, body: blockContent(rules, vars, layerNames, { ...opts, instructions: { header: false } }), template: false, data: {} };
          const f = ruleFileContent(projAlways.dialect, merged1, vars, layerNames, fileOpts(projAlways.prefix), true);
          out.add({ type: 'file', path: path.join(projAlways.dir(root), f.name), content: f.content, adapter: a.id, scope, exclude: true, skipIfTracked: true });
        } else if (projAlways.kind === 'toml-key') {
          out.add({ type: 'toml', path: projAlways.file(root), values: { [projAlways.key[0]]: blockContent(rules, vars, layerNames, { ...opts, instructions: { header: false } }) }, tables: {}, adapter: a.id, scope, exclude: true, skipIfTracked: true });
        }
      }
      if (spec.scoped) {
        for (const r of scopedA) {
          const f = ruleFileContent(spec.scoped.dialect, r, vars, layerNames, fileOpts(spec.scoped.prefix), false);
          out.add({ type: 'file', path: path.join(spec.scoped.dir(root), f.name), content: f.content, adapter: a.id, scope, exclude: privateMode, skipIfTracked: privateMode });
        }
      } else {
        const skipped = scopedA.filter((r) => r.data.fallback !== 'always');
        if (skipped.length) {
          notes.push({ level: 'info', msg: `${a.id}: no path-scoped project rules; skipped ${skipped.map((r) => r.id).join(', ')}` });
        }
      }
    }

    const skillDirs = scope === 'user' ? (spec.skills ? spec.skills(p, os) : []) : (spec.skills ? spec.skills(root) : []);
    for (const dir of skillDirs) {
      if (!opts.skills?.universal && normalizeKey(dir).startsWith(normalizeKey(p.agentsHome)) && scope === 'user') {
        continue;
      }
      for (const s of merged.skills) {
        if (s.targets && !s.targets.includes(a.id)) {
          continue;
        }
        const files = s.files.filter((f) => f.rel !== 'agent-layers.jsonc');
        files.filter((f) => EXEC_EXT.test(f.rel)).forEach((f) => executables.add(`skill "${s.name}": ${f.rel}`));
        out.add({ type: 'dir', path: path.join(dir, s.name), files, adapter: a.id, scope, exclude: privateMode, skipIfTracked: privateMode });
      }
    }

    const cmdSpec = spec.commands;
    if (cmdSpec) {
      const dir = scope === 'user' ? cmdSpec.dir(p, os) : cmdSpec.dir(root);
      for (const c of merged.commands) {
        if (c.targets && !c.targets.includes(a.id)) {
          continue;
        }
        const conv = convertCommand(c, cmdSpec.format);
        if (conv) {
          out.add({ type: 'file', path: path.join(dir, `${c.name}${conv.ext}`), content: conv.content, adapter: a.id, scope, exclude: privateMode, skipIfTracked: privateMode });
        }
      }
    } else if (merged.commands.some((c) => !c.targets || c.targets.includes(a.id))) {
      notes.push({ level: 'info', msg: `${a.id}: slash commands are not rendered for this agent; publish them as skills instead` });
    }

    const agentSpec = spec.agents;
    if (agentSpec) {
      const dir = scope === 'user' ? agentSpec.dir(p, os) : agentSpec.dir(root);
      for (const ag of merged.agents) {
        if (ag.targets && !ag.targets.includes(a.id)) {
          continue;
        }
        out.add({ type: 'file', path: path.join(dir, `${ag.name}.md`), content: ag.raw.endsWith('\n') ? ag.raw : `${ag.raw}\n`, adapter: a.id, scope, exclude: privateMode, skipIfTracked: privateMode });
      }
    }

    const mcpSpec = scope === 'user' ? spec.mcp : spec.mcp ? spec.mcp[mode] : null;
    const servers = merged.mcp.filter((m) => !m.def.targets || m.def.targets.includes(a.id));
    if (servers.length && !mcpSpec) {
      notes.push({ level: 'info', msg: `${a.id}: MCP servers are not rendered for this agent at ${scope} level` });
    }
    if (mcpSpec && servers.length) {
      const shared = scope === 'project' && mode === 'shared';
      const policy = shared ? 'reference' : (opts.secrets?.mode || 'auto');
      const converted = {};
      for (const s of servers) {
        const def = renderDeep(s.def, vars);
        delete def.targets;
        delete def.name;
        delete def.description;
        delete def.enabled;
        const conv = convertMcpServer(s.name, def, { format: mcpSpec.format || 'claude', env: mcpSpec.env, policy, ctx, resolveSecret, notes, requiredEnv });
        if (conv) {
          converted[s.name] = conv;
          const wrapped = conv.command === ctx.nodePath && Array.isArray(conv.args) && conv.args[1] === 'exec';
          executables.add(`MCP server "${s.name}" (${a.id}): ${describeExec(def)}${wrapped ? ' (secrets injected by agent-layers exec)' : ''}`);
        }
      }
      if (Object.keys(converted).length) {
        if (mcpSpec.kind === 'json') {
          const file = scope === 'user' ? mcpSpec.file(p, os) : mcpSpec.file(root);
          const fragment = {};
          let cur = fragment;
          mcpSpec.key.forEach((k, i) => {
            cur[k] = i === mcpSpec.key.length - 1 ? converted : {};
            cur = cur[k];
          });
          out.add({ type: 'json', path: file, fragment, atomic: [[...mcpSpec.key, '*']], adapter: a.id, scope, exclude: privateMode, skipIfTracked: privateMode, shared });
        } else if (mcpSpec.kind === 'toml') {
          const file = scope === 'user' ? mcpSpec.file(p, os) : mcpSpec.file(root);
          const tables = {};
          for (const [n, t] of Object.entries(converted)) {
            tables[JSON.stringify([...mcpSpec.table, n])] = t;
          }
          out.add({ type: 'toml', path: file, values: {}, tables, adapter: a.id, scope, exclude: privateMode, skipIfTracked: privateMode, shared });
        } else if (mcpSpec.kind === 'claude-cli') {
          const viaJson = (opts.claude?.mcp || 'cli') === 'json' || (ctx.sandbox && !ctx.env.AGENT_LAYERS_SANDBOX_CLAUDE_CLI);
          if (viaJson) {
            const file = p.claudeJson;
            const fragment = mcpSpec.scope === 'user' ? { mcpServers: converted } : { projects: { [root.replace(/\\/g, '/')]: { mcpServers: converted } } };
            const atomic = mcpSpec.scope === 'user' ? [['mcpServers', '*']] : [['projects', root.replace(/\\/g, '/'), 'mcpServers', '*']];
            out.add({ type: 'json', path: file, fragment, atomic, adapter: a.id, scope });
          } else {
            out.add({ type: 'claude-mcp', path: p.claudeJson, scope: mcpSpec.scope, cwd: root, servers: converted, adapter: a.id });
          }
        }
      }
    }

    const setSpec = scope === 'user' ? spec.settings : spec.settings ? spec.settings[mode] : null;
    let fragments = (merged.settings[a.id] || []).map((s) => s.value);
    if (scope === 'user' && spec.impliedSettings) {
      const implied = spec.impliedSettings(opts);
      if (implied) {
        fragments = [implied, ...fragments];
      }
    }
    if (fragments.length && !setSpec) {
      notes.push({ level: 'info', msg: `${a.id}: settings fragments are not supported at ${scope} level` });
    }
    if (setSpec && fragments.length) {
      const value = renderDeep(fragments.reduce((acc, f) => deepMerge(acc, f), {}), vars);
      for (const key of EXEC_SETTINGS) {
        if (value[key] !== undefined) {
          executables.add(`${a.id} setting "${key}": ${describeExec(value[key])}`);
        }
      }
      const file = scope === 'user' ? setSpec.file(p, os) : setSpec.file(root);
      if (setSpec.kind === 'json') {
        out.add({ type: 'json', path: file, fragment: value, atomic: [], adapter: a.id, scope, exclude: privateMode, skipIfTracked: privateMode });
      } else {
        out.add({ type: 'toml', path: file, values: value, tables: {}, adapter: a.id, scope, exclude: privateMode, skipIfTracked: privateMode });
      }
    }

    const filesRootFn = scope === 'user' ? spec.files : null;
    const fileList = scope === 'user' ? merged.files[a.id] || [] : [];
    if (fileList.length) {
      if (!filesRootFn) {
        notes.push({ level: 'info', msg: `${a.id}: no home folder mapping for files/` });
      } else {
        const rootDir = filesRootFn(p, os);
        for (const f of fileList) {
          if (EXEC_EXT.test(f.rel)) {
            executables.add(`file for ${a.id}: ${f.rel}`);
          }
          const buf = fs.readFileSync(f.abs);
          const content = f.template ? renderString(buf.toString('utf8').replace(/^﻿/, ''), vars, { source: f.abs }) : buf;
          out.add({ type: 'file', path: path.join(rootDir, f.rel), content, mode: f.mode, binary: !f.template, adapter: a.id, scope });
        }
      }
    }
  }

  if (agentsMdReaders.length) {
    const ids = new Set();
    const rules = [];
    for (const reader of agentsMdReaders) {
      for (const r of reader.rules) {
        if (!ids.has(r.id)) {
          ids.add(r.id);
          rules.push(r);
        }
      }
    }
    rules.sort((x, y) => x.id.localeCompare(y.id));
    const targeted = rules.filter((r) => r.targets);
    if (targeted.length) {
      notes.push({ level: 'info', msg: `AGENTS.md is shared by ${agentsMdReaders.map((r) => r.id).join(', ')}; agent-targeted rules (${targeted.map((r) => r.id).join(', ')}) are visible to all of them` });
    }
    out.add({ type: 'block', path: path.join(root, 'AGENTS.md'), blockId, content: blockContent(rules, vars, layerNames, opts), adapter: agentsMdReaders.map((r) => r.id), scope, shared: true });
  }

  const homeFiles = scope === 'user' ? merged.files.home || [] : merged.files.project || [];
  for (const f of homeFiles) {
    executables.add(`${scope === 'user' ? 'home' : 'project'} file: ${f.rel}`);
    const buf = fs.readFileSync(f.abs);
    const content = f.template ? renderString(buf.toString('utf8').replace(/^﻿/, ''), vars, { source: f.abs }) : buf;
    const base = scope === 'user' ? p.home : root;
    out.add({ type: 'file', path: path.join(base, f.rel), content, mode: f.mode, binary: !f.template, adapter: scope === 'user' ? 'home' : 'project', scope, exclude: privateMode, skipIfTracked: privateMode });
  }

  for (const known of Object.keys(merged.files)) {
    if (known !== 'home' && known !== 'project' && !adapterIds.includes(known) && !ADAPTERS.some((a) => a.id === known)) {
      notes.push({ level: 'warn', msg: `files/${known}: unknown agent id; expected one of ${ADAPTERS.map((a) => a.id).join(', ')}, home, project` });
    }
  }

  if (scope === 'project' && project.memory?.claude && adapterIds.includes('claude')) {
    const memDir = project.memory.claude === 'project' ? path.join(root, '.agent-layers', 'memory', 'claude') : path.resolve(root, String(project.memory.claude));
    if (!isWithinPath(memDir, root) || normalizeKey(memDir) === normalizeKey(root)) {
      notes.push({ level: 'error', msg: `memory.claude must be a folder inside ${root}; ${memDir} was not used` });
    } else {
      out.add({ type: 'json', path: path.join(root, '.claude', 'settings.local.json'), fragment: { autoMemoryDirectory: memDir }, atomic: [], adapter: 'claude', scope, exclude: true, skipIfTracked: true });
      const rel = path.relative(root, memDir).replace(/\\/g, '/').split('/')[0];
      out.add({ type: 'file', path: path.join(memDir, 'README.md'), content: `# Claude auto memory for ${project.name}\n\nThis folder is local to this machine and is removed by "agent-layers project purge ${project.name}".\n`, adapter: 'claude', scope, exclude: true, excludePath: `/${rel}/`, skipIfTracked: true });
    }
  }

  let outputs = out.list();
  if (scope === 'project') {
    if (privateMode || outputs.some((o) => o.skipIfTracked && o.exclude)) {
      const candidates = outputs.filter((o) => o.skipIfTracked || o.privateOnly).map((o) => path.relative(root, o.path).replace(/\\/g, '/'));
      const check = trackedFiles(root, candidates);
      const tracked = check.tracked;
      if (!check.reliable) {
        notes.push({ level: 'warn', msg: `could not ask git which files are tracked (${check.reason}); every existing file is treated as tracked and left untouched` });
      }
      outputs = outputs.filter((o) => {
        if (!(o.skipIfTracked || o.privateOnly)) {
          return true;
        }
        const rel = path.relative(root, o.path).replace(/\\/g, '/');
        const isTracked = tracked.has(rel) || (o.type === 'dir' && [...tracked].some((t) => t.startsWith(`${rel}/`)));
        if (isTracked) {
          notes.push({ level: 'warn', msg: `${rel}: tracked by git; local-only outputs never edit tracked files (skipped for ${[...o.adapters].join(', ')})` });
          return false;
        }
        return true;
      });
    }
    const gd = gitDir(root);
    const excl = outputs.filter((o) => o.exclude && o.type !== 'claude-mcp').map((o) => o.excludePath || `/${path.relative(root, o.path).replace(/\\/g, '/')}${o.type === 'dir' ? '/' : ''}`);
    if (gd && excl.length) {
      const uniq = [...new Set(excl)].sort();
      out.map.clear();
      outputs.forEach((o) => out.map.set(o.id, o));
      out.add({ type: 'block', path: path.join(gd, 'info', 'exclude'), blockId, content: uniq.join('\n'), style: 'hash', adapter: 'git', scope });
      outputs = out.list();
    } else if (!gd && excl.length) {
      notes.push({ level: 'warn', msg: `${root} is not a git repository; generated private files cannot be excluded from version control` });
    }
    assertOutputsWithin(outputs, [root, gd].filter(Boolean), [p.claudeJson]);
  }

  return { outputs, notes, requiredEnv: [...requiredEnv].sort(), executables: [...executables].sort(), vars };
}
