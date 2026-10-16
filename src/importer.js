import fs from 'node:fs';
import path from 'node:path';
import { readText, exists, listFiles, listDirs, writeTextAtomic, isProbablyText } from './util/fsx.js';
import { listBlockIds, removeBlock } from './formats/mdblock.js';
import { parseJsonc, stringifyJson } from './formats/jsonc.js';
import { parseTomlValue, TomlDocument } from './formats/toml.js';
import { joinFrontmatter } from './formats/frontmatter.js';
import { TOKEN_PATTERNS, SECRET_FIELD, SECRET_TOML_FIELD } from './validate.js';

const SECRET_KEY = /(pass(word|wd)?|pwd|secret|token|api[_-]?key|credential|private[_-]?key)(?!.*helper$)/i;
const SECRET_FLAG = /^--?(?:[a-z0-9-]*-)?(password|passwd|pwd|secret|token|api-?key|key|auth|bearer|credential)s?$/i;

function looksLikeToken(v) {
  return typeof v === 'string' && TOKEN_PATTERNS.some(([re]) => re.test(v));
}

function isReference(v) {
  return typeof v === 'string' && /\$\{(secret|env):[^}]+\}|^\$\{[A-Za-z_][A-Za-z0-9_]*\}$|^\$[A-Za-z_][A-Za-z0-9_]*$|\{\{[^}]+\}\}/.test(v);
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'value';
}

function stripManaged(text) {
  let t = text;
  for (const id of listBlockIds(t)) {
    t = removeBlock(t, id);
  }
  return t.trim();
}

function homeTemplating(ctx, value) {
  const home = ctx.paths.home;
  const variants = [
    [home.replace(/\\/g, '\\\\'), '{{home}}'],
    [home, '{{home}}'],
    [home.replace(/\\/g, '/'), '{{homeSlash}}'],
  ];
  if (typeof value === 'string') {
    let s = value;
    for (const [from, to] of variants) {
      s = s.split(from).join(to);
    }
    return s;
  }
  if (Array.isArray(value)) {
    return value.map((v) => homeTemplating(ctx, v));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, homeTemplating(ctx, v)]));
  }
  return value;
}

function secretizeMap(serverName, map, found, kind) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (typeof v !== 'string' || !v || isReference(v)) {
      out[k] = v;
      continue;
    }
    const name = `${serverName}/${slug(kind === 'headers' ? `header-${k}` : k)}`;
    if (kind === 'headers' && k.toLowerCase() === 'authorization') {
      const m = /^(\S+)\s+(.+)$/.exec(v);
      out[k] = m ? `${m[1]} \${secret:${name}}` : `\${secret:${name}}`;
      found.push(name);
    } else if (SECRET_KEY.test(k) || looksLikeToken(v)) {
      out[k] = `\${secret:${name}}`;
      found.push(name);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function secretizeArgs(serverName, args, found) {
  const out = [];
  let takeNext = null;
  args.forEach((a, i) => {
    if (typeof a !== 'string' || isReference(a)) {
      out.push(a);
      takeNext = null;
      return;
    }
    if (takeNext) {
      const name = `${serverName}/${slug(takeNext)}`;
      out.push(`\${secret:${name}}`);
      found.push(name);
      takeNext = null;
      return;
    }
    const eq = /^(--?[A-Za-z0-9-]+)=(.+)$/.exec(a);
    if (eq && (SECRET_FLAG.test(eq[1]) || looksLikeToken(eq[2]))) {
      const name = `${serverName}/${slug(eq[1])}`;
      out.push(`${eq[1]}=\${secret:${name}}`);
      found.push(name);
      return;
    }
    if (SECRET_FLAG.test(a) && i + 1 < args.length) {
      out.push(a);
      takeNext = a;
      return;
    }
    if (looksLikeToken(a)) {
      const name = `${serverName}/arg-${i + 1}`;
      out.push(`\${secret:${name}}`);
      found.push(name);
      return;
    }
    out.push(a);
  });
  return out;
}

function neutralFromMcp(name, cfg, found) {
  const def = {};
  if (cfg.command) {
    def.command = Array.isArray(cfg.command) ? cfg.command[0] : cfg.command;
    const args = Array.isArray(cfg.command) ? cfg.command.slice(1) : cfg.args || [];
    def.args = secretizeArgs(name, args, found);
    const env = cfg.env || cfg.environment;
    if (env) {
      def.env = secretizeMap(name, env, found, 'env');
    }
  } else {
    def.transport = cfg.type === 'sse' ? 'sse' : 'http';
    def.url = cfg.url || cfg.httpUrl || cfg.serverUrl;
    if (cfg.headers || cfg.http_headers) {
      def.headers = secretizeMap(name, cfg.headers || cfg.http_headers, found, 'headers');
    }
  }
  return def;
}

function dropSecretSettings(obj, label, notes, prefix = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const p = [...prefix, k];
    if (typeof v === 'string' && v && !isReference(v) && (SECRET_KEY.test(k) || looksLikeToken(v))) {
      notes.push(`${label}: left out ${p.join('.')} because it looks like a secret; provide it through the environment or a secret manager`);
      continue;
    }
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? dropSecretSettings(v, label, notes, p) : v;
  }
  return out;
}

export function planImport(ctx, { from = ['claude', 'codex', 'gemini', 'copilot'], layerDir }) {
  const p = ctx.paths;
  const writes = [];
  const notes = [];
  const secrets = [];
  const add = (rel, content, origin) => writes.push({ path: path.join(layerDir, rel), rel, content, origin });

  if (from.includes('claude')) {
    const md = readText(path.join(p.claudeHome, 'CLAUDE.md'));
    if (md && stripManaged(md.text)) {
      add('instructions/50-imported-claude.md', `${stripManaged(md.text)}\n`, '~/.claude/CLAUDE.md');
    }
    for (const f of listFiles(path.join(p.claudeHome, 'rules'))) {
      if (f.rel.startsWith('agent-layers/') || !f.rel.endsWith('.md')) {
        continue;
      }
      add(`instructions/60-claude-${f.rel.replace(/\//g, '-')}`, readText(f.abs).text, `~/.claude/rules/${f.rel}`);
    }
    for (const kind of ['commands', 'agents']) {
      for (const f of listFiles(path.join(p.claudeHome, kind), { recursive: false })) {
        if (f.rel.endsWith('.md')) {
          add(`${kind}/${f.rel}`, readText(f.abs).text, `~/.claude/${kind}/${f.rel}`);
        }
      }
    }
    for (const name of listDirs(path.join(p.claudeHome, 'skills'))) {
      if (['synced', '.trash'].includes(name)) {
        continue;
      }
      for (const f of listFiles(path.join(p.claudeHome, 'skills', name))) {
        const buf = fs.readFileSync(f.abs);
        add(`skills/${name}/${f.rel}`, isProbablyText(buf) ? buf.toString('utf8') : buf, `~/.claude/skills/${name}`);
      }
    }
    for (const f of listFiles(path.join(p.claudeHome, 'output-styles'))) {
      add(`files/claude/output-styles/${f.rel}`, readText(f.abs).text, `~/.claude/output-styles/${f.rel}`);
    }
    for (const n of ['statusline.ps1', 'statusline.sh', 'keybindings.json']) {
      const t = readText(path.join(p.claudeHome, n));
      if (t) {
        add(`files/claude/${n}`, t.text, `~/.claude/${n}`);
      }
    }
    const st = readText(path.join(p.claudeHome, 'settings.json'));
    if (st) {
      const s = parseJsonc(st.text);
      delete s.mcpServers;
      if (s.env) {
        s.env = dropSecretSettings(s.env, 'claude settings env', notes);
      }
      const clean = dropSecretSettings(s, 'claude settings', notes);
      add('settings/claude.json', stringifyJson(homeTemplating(ctx, clean)), '~/.claude/settings.json');
    }
    const cj = readText(p.claudeJson);
    if (cj) {
      const j = parseJsonc(cj.text);
      for (const [name, cfg] of Object.entries(j.mcpServers || {})) {
        add(`mcp/${name}.jsonc`, stringifyJson(neutralFromMcp(name, cfg, secrets)), '~/.claude.json mcpServers');
      }
    }
  }

  if (from.includes('codex')) {
    const md = readText(path.join(p.codexHome, 'AGENTS.md'));
    if (md && stripManaged(md.text)) {
      add('instructions/51-imported-codex.md', `${stripManaged(md.text)}\n`, '~/.codex/AGENTS.md');
    }
    for (const base of [path.join(p.agentsHome, 'skills'), path.join(p.codexHome, 'skills')]) {
      for (const name of listDirs(base)) {
        if (name.startsWith('.')) {
          continue;
        }
        for (const f of listFiles(path.join(base, name))) {
          const buf = fs.readFileSync(f.abs);
          add(`skills/${name}/${f.rel}`, isProbablyText(buf) ? buf.toString('utf8') : buf, `${base}/${name}`);
        }
      }
    }
    const cfg = readText(path.join(p.codexHome, 'config.toml'));
    if (cfg) {
      try {
        const v = parseTomlValue(cfg.text);
        const drop = ['projects', 'notify', 'marketplaces', 'windows', 'desktop', 'hooks', 'shell_environment_policy'];
        const portable = {};
        for (const [k, val] of Object.entries(v)) {
          if (drop.includes(k)) {
            continue;
          }
          if (k === 'mcp_servers') {
            for (const [name, s] of Object.entries(val)) {
              if (name === 'node_repl') {
                continue;
              }
              add(`mcp/${name}.jsonc`, stringifyJson(neutralFromMcp(name, s, secrets)), '~/.codex/config.toml [mcp_servers]');
            }
            continue;
          }
          portable[k] = val;
        }
        const clean = dropSecretSettings(portable, 'codex config', notes);
        const doc = new TomlDocument('');
        const emit = (obj, prefix) => {
          for (const [k, val] of Object.entries(obj)) {
            if (val && typeof val === 'object' && !Array.isArray(val)) {
              emit(val, [...prefix, k]);
            } else {
              doc.set([...prefix, k], homeTemplating(ctx, val));
            }
          }
        };
        emit(clean, []);
        add('settings/codex.toml', doc.toString(), '~/.codex/config.toml (portable keys only)');
        notes.push('codex config: dropped machine-specific tables (projects, notify, marketplaces, windows, desktop, hooks, shell_environment_policy, mcp_servers.node_repl); review settings/codex.toml');
      } catch (err) {
        notes.push(`codex config: ${err.message}`);
      }
    }
  }

  if (from.includes('gemini')) {
    const md = readText(path.join(p.geminiHome, 'GEMINI.md'));
    if (md && stripManaged(md.text)) {
      add('instructions/52-imported-gemini.md', `${stripManaged(md.text)}\n`, '~/.gemini/GEMINI.md');
    }
    for (const f of listFiles(path.join(p.geminiHome, 'commands'), { recursive: false })) {
      if (!f.rel.endsWith('.toml')) {
        continue;
      }
      try {
        const v = parseTomlValue(readText(f.abs).text);
        const body = String(v.prompt || '').replace(/\{\{args\}\}/g, '$ARGUMENTS');
        add(`commands/${f.rel.replace(/\.toml$/, '.md')}`, joinFrontmatter(v.description ? { description: v.description } : {}, `${body}\n`), `~/.gemini/commands/${f.rel}`);
      } catch (err) {
        notes.push(`gemini command ${f.rel}: ${err.message}`);
      }
    }
    const st = readText(path.join(p.geminiHome, 'settings.json'));
    if (st) {
      const s = parseJsonc(st.text);
      for (const [name, cfg] of Object.entries(s.mcpServers || {})) {
        add(`mcp/${name}.jsonc`, stringifyJson(neutralFromMcp(name, cfg, secrets)), '~/.gemini/settings.json mcpServers');
      }
      delete s.mcpServers;
      const clean = dropSecretSettings(s, 'gemini settings', notes);
      if (Object.keys(clean).length) {
        add('settings/gemini.json', stringifyJson(homeTemplating(ctx, clean)), '~/.gemini/settings.json');
      }
    }
  }

  if (from.includes('copilot')) {
    const md = readText(path.join(p.copilotHome, 'copilot-instructions.md'));
    if (md && stripManaged(md.text)) {
      add('instructions/53-imported-copilot.md', `${stripManaged(md.text)}\n`, '~/.copilot/copilot-instructions.md');
    }
  }

  const seen = new Map();
  const unique = [];
  for (const w of writes) {
    if (seen.has(w.rel)) {
      notes.push(`${w.rel}: also found in ${w.origin}; kept the copy from ${seen.get(w.rel)}`);
      continue;
    }
    seen.set(w.rel, w.origin);
    if (typeof w.content === 'string') {
      const hit = TOKEN_PATTERNS.find(([re]) => re.test(w.content));
      const field = /\.jsonc?$/.test(w.rel) ? SECRET_FIELD.test(w.content) : /\.toml$/.test(w.rel) ? SECRET_TOML_FIELD.test(w.content) : false;
      if (hit || field) {
        notes.push(`${w.rel}: not imported because it still contains ${hit ? `something that looks like a ${hit[1]}` : 'a secret-looking field with a literal value'}; copy it by hand after removing the secret`);
        continue;
      }
    }
    unique.push(w);
  }
  return { writes: unique, notes, secrets: [...new Set(secrets)] };
}

export function applyImport(plan, { overwrite = false } = {}) {
  const done = [];
  const skipped = [];
  for (const w of plan.writes) {
    if (exists(w.path) && !overwrite) {
      skipped.push(w);
      continue;
    }
    if (Buffer.isBuffer(w.content)) {
      fs.mkdirSync(path.dirname(w.path), { recursive: true });
      fs.writeFileSync(w.path, w.content);
    } else {
      writeTextAtomic(w.path, w.content);
    }
    done.push(w);
  }
  return { done, skipped };
}
