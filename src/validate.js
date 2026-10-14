import fs from 'node:fs';
import path from 'node:path';
import { loadManifest, listProjects } from './manifest.js';
import { loadLayer, mergeLayers } from './layers.js';
import { ADAPTERS } from './adapters/registry.js';
import { listFiles, isProbablyText, isDir } from './util/fsx.js';
import { findSecretRefs } from './template.js';

export const TOKEN_PATTERNS = [
  [/ghp_[A-Za-z0-9]{36}/, 'GitHub token'],
  [/github_pat_[A-Za-z0-9_]{60,}/, 'GitHub fine-grained token'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic key'],
  [/sk-(proj-)?[A-Za-z0-9_-]{32,}/, 'OpenAI-style key'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/xox[bpars]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
];
export const SECRET_FIELD = /"(?:[A-Za-z_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY)[A-Za-z_]*)"\s*:\s*"(?!\$\{)([^"]{4,})"/i;
export const SECRET_TOML_FIELD = /^\s*[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api_?key)[A-Za-z0-9_-]*\s*=\s*["'](?!\$\{)[^"'\n]{4,}["']/im;
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateSource(sourceDir, { os = 'windows' } = {}) {
  const issues = [];
  const add = (level, where, msg) => issues.push({ level, where, msg });
  let manifest;
  try {
    manifest = loadManifest(sourceDir);
  } catch (err) {
    add('error', sourceDir, err.message);
    return { issues, manifest: null };
  }
  const known = new Set(ADAPTERS.map((a) => a.id));
  if (Array.isArray(manifest.targets)) {
    for (const t of manifest.targets) {
      if (!known.has(t)) {
        add('error', manifest.file, `unknown target "${t}"`);
      }
    }
  }
  for (const e of manifest.extends) {
    if (e.projectsDir && !e.optional && !isDir(e.projectsDir)) {
      add('error', manifest.file, `extends "${e.name}": projects folder not found at ${e.projectsDir}`);
    }
  }
  let projects = [];
  try {
    projects = listProjects(manifest);
  } catch (err) {
    add('error', manifest.file, err.message);
  }
  const layerDirs = [...manifest.extends.filter((e) => e.dir).map((e) => [e.name, e.dir]), ['base', manifest.baseDir], ...projects.map((pr) => [`project:${pr.name}`, pr.dir])];
  for (const [name, dir] of layerDirs) {
    for (const osName of ['windows', 'macos', 'linux']) {
      let layer;
      try {
        layer = loadLayer(dir, name, osName);
      } catch (err) {
        add('error', dir, err.message);
        continue;
      }
      if (osName !== os) {
        continue;
      }
      for (const s of layer.skills) {
        if (!SKILL_NAME.test(s.name) || s.name.length > 64) {
          add('error', s.dir, 'skill folder names must be lowercase letters, digits and single hyphens (max 64 chars)');
        }
        if (s.data.name && s.data.name !== s.name) {
          add('error', s.dir, `SKILL.md name "${s.data.name}" must match the folder name "${s.name}"`);
        }
        if (!s.description) {
          add('error', s.dir, 'SKILL.md needs a description');
        } else if (String(s.description).length > 1024) {
          add('warn', s.dir, 'SKILL.md description is longer than 1024 characters');
        }
      }
      for (const m of layer.mcp) {
        const d = m.def;
        if (!d.command && !d.url) {
          add('error', m.file, 'an MCP server needs "command" (stdio) or "url" (http/sse)');
        }
        for (const t of [].concat(d.targets || [])) {
          if (!known.has(t)) {
            add('error', m.file, `unknown target "${t}"`);
          }
        }
        for (const [k, v] of Object.entries(d.env || {})) {
          if (/(PASS|SECRET|TOKEN|KEY)/i.test(k) && typeof v === 'string' && v && !v.includes('${')) {
            add('error', m.file, `env ${k} looks like a plaintext secret; use "\${secret:NAME}"`);
          }
        }
      }
      for (const ins of layer.instructions) {
        if (Buffer.byteLength(ins.body) > 24000) {
          add('warn', ins.file, 'longer than 24,000 bytes; Antigravity truncates rule files above this size and Codex caps AGENTS.md at 32 KiB in total');
        }
        for (const t of [...(ins.targets || []), ...(ins.exclude || [])]) {
          if (!known.has(t)) {
            add('error', ins.file, `unknown target "${t}"`);
          }
        }
      }
      for (const key of Object.keys(layer.files)) {
        if (!known.has(key) && !['home', 'project'].includes(key)) {
          add('error', path.join(dir, 'files', key), `unknown files/ folder; use an agent id, "home" or "project"`);
        }
      }
      const merged = mergeLayers([layer]);
      const refs = findSecretRefs(merged.mcp.map((m) => m.def));
      if (refs.size) {
        add('info', dir, `secrets referenced: ${[...refs].join(', ')}`);
      }
    }
  }
  for (const f of listFiles(sourceDir)) {
    if (f.rel.startsWith('.git/') || f.rel.includes('/node_modules/')) {
      continue;
    }
    const buf = fs.readFileSync(f.abs);
    if (!isProbablyText(buf) || buf.length > 2 * 1024 * 1024) {
      continue;
    }
    const text = buf.toString('utf8');
    for (const [re, label] of TOKEN_PATTERNS) {
      if (re.test(text)) {
        add('error', f.abs, `contains something that looks like a ${label}`);
      }
    }
    if (/\.jsonc?$/.test(f.rel) && SECRET_FIELD.test(text)) {
      add('error', f.abs, 'contains a password/secret/token field with a literal value');
    }
    if (/\r\r\n/.test(text)) {
      add('warn', f.abs, 'contains CRCRLF line endings');
    }
  }
  return { issues, manifest };
}
