import fs from 'node:fs';
import path from 'node:path';
import { splitFrontmatter } from './formats/frontmatter.js';
import { parseJsonc } from './formats/jsonc.js';
import { parseTomlValue } from './formats/toml.js';
import { readText, listFiles, listDirs, isDir, isProbablyText, normalizeEol, fileMode } from './util/fsx.js';

const OS_TAGS = ['windows', 'macos', 'linux'];

export function osTagOf(fileName) {
  const m = /@(windows|macos|linux)(?=\.|$)/.exec(fileName);
  return m ? m[1] : null;
}

export function stripOsTag(fileName) {
  return fileName.replace(/@(windows|macos|linux)(?=\.|$)/, '');
}

export function matchesOs(fileName, os) {
  const tag = osTagOf(fileName);
  return !tag || tag === os;
}

function baseId(fileName) {
  return stripOsTag(fileName).replace(/\.tmpl$/, '').replace(/\.(md|mdc|txt)$/, '');
}

function readFileContent(abs) {
  const buf = fs.readFileSync(abs);
  if (isProbablyText(buf)) {
    return normalizeEol(buf.toString('utf8').replace(/^﻿/, ''));
  }
  return buf;
}

function loadInstructions(dir, os) {
  const out = [];
  for (const f of listFiles(dir, { recursive: false })) {
    const name = path.basename(f.abs);
    if (!/\.md(\.tmpl)?$/.test(stripOsTag(name)) || !matchesOs(name, os)) {
      continue;
    }
    const text = readText(f.abs).text;
    const { data, body } = splitFrontmatter(text);
    out.push({
      id: baseId(name),
      file: f.abs,
      template: name.endsWith('.tmpl'),
      data,
      body: body.replace(/\s+$/, '\n'),
      paths: [].concat(data.paths || data.globs || data.applyTo || []).filter(Boolean),
      description: data.description || '',
      targets: data.targets ? [].concat(data.targets) : null,
      exclude: data.exclude ? [].concat(data.exclude) : [],
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function loadSkills(dir) {
  const out = [];
  for (const name of listDirs(dir)) {
    const skillDir = path.join(dir, name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    const r = readText(skillFile);
    if (!r) {
      continue;
    }
    const { data } = splitFrontmatter(r.text);
    const files = listFiles(skillDir).map((f) => ({ rel: f.rel, content: readFileContent(f.abs), mode: fileMode(f.abs) }));
    const sidecarText = readText(path.join(skillDir, 'agent-layers.jsonc'));
    const sidecar = sidecarText ? parseJsonc(sidecarText.text, path.join(skillDir, 'agent-layers.jsonc')) : {};
    const targets = sidecar.targets || data['agent-layers-targets'];
    out.push({
      name,
      dir: skillDir,
      data,
      description: data.description || '',
      targets: targets ? [].concat(targets) : null,
      files,
    });
  }
  return out;
}

function loadMarkdownItems(dir, os) {
  const out = [];
  for (const f of listFiles(dir, { recursive: false })) {
    const name = path.basename(f.abs);
    if (!/\.md$/.test(stripOsTag(name)) || !matchesOs(name, os)) {
      continue;
    }
    const raw = readText(f.abs).text;
    const { data, body } = splitFrontmatter(raw);
    out.push({
      name: baseId(name),
      file: f.abs,
      raw,
      data,
      body,
      description: data.description || '',
      targets: data.targets ? [].concat(data.targets) : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function loadMcp(dir, os) {
  const out = [];
  for (const f of listFiles(dir, { recursive: false })) {
    const name = path.basename(f.abs);
    if (!/\.jsonc?$/.test(stripOsTag(name)) || !matchesOs(name, os)) {
      continue;
    }
    const def = parseJsonc(readText(f.abs).text, f.abs);
    const serverName = def.name || stripOsTag(name).replace(/\.jsonc?$/, '');
    if (def.enabled === false) {
      continue;
    }
    out.push({ name: serverName, file: f.abs, def });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function loadSettings(dir, os) {
  const out = {};
  for (const f of listFiles(dir, { recursive: false })) {
    const name = path.basename(f.abs);
    if (!matchesOs(name, os)) {
      continue;
    }
    const clean = stripOsTag(name);
    const m = /^([a-z0-9-]+)\.(jsonc?|toml)$/.exec(clean);
    if (!m) {
      continue;
    }
    const text = readText(f.abs).text;
    const value = m[2] === 'toml' ? parseTomlValue(text) : parseJsonc(text, f.abs);
    (out[m[1]] ||= []).push({ file: f.abs, format: m[2] === 'toml' ? 'toml' : 'json', os: osTagOf(name), value });
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => Number(Boolean(a.os)) - Number(Boolean(b.os)) || a.file.localeCompare(b.file));
  }
  return out;
}

function loadFiles(dir, os) {
  const out = {};
  for (const adapterId of listDirs(dir)) {
    const root = path.join(dir, adapterId);
    for (const f of listFiles(root)) {
      const parts = f.rel.split('/');
      const last = parts[parts.length - 1];
      if (!matchesOs(last, os)) {
        continue;
      }
      parts[parts.length - 1] = stripOsTag(last).replace(/\.tmpl$/, '');
      (out[adapterId] ||= []).push({ rel: parts.join('/'), abs: f.abs, template: last.endsWith('.tmpl'), mode: fileMode(f.abs) });
    }
  }
  return out;
}

export function loadLayer(dir, name, os) {
  if (!isDir(dir)) {
    return { name, dir, missing: true, instructions: [], skills: [], commands: [], agents: [], mcp: [], settings: {}, files: {} };
  }
  return {
    name,
    dir,
    missing: false,
    instructions: loadInstructions(path.join(dir, 'instructions'), os),
    skills: loadSkills(path.join(dir, 'skills')),
    commands: loadMarkdownItems(path.join(dir, 'commands'), os),
    agents: loadMarkdownItems(path.join(dir, 'agents'), os),
    mcp: loadMcp(path.join(dir, 'mcp'), os),
    settings: loadSettings(path.join(dir, 'settings'), os),
    files: loadFiles(path.join(dir, 'files'), os),
  };
}

export function mergeLayers(layers) {
  const merged = { layers: layers.map((l) => l.name), instructions: [], skills: [], commands: [], agents: [], mcp: [], settings: {}, files: {}, shadowed: [] };
  const byName = (key, item, layer) => {
    const list = merged[key];
    const idx = list.findIndex((x) => x.name === item.name);
    if (idx >= 0) {
      merged.shadowed.push({ kind: key, name: item.name, by: layer.name, over: list[idx].layer });
      list[idx] = { ...item, layer: layer.name };
    } else {
      list.push({ ...item, layer: layer.name });
    }
  };
  for (const layer of layers) {
    for (const ins of layer.instructions) {
      const idx = merged.instructions.findIndex((x) => x.id === ins.id);
      if (idx >= 0) {
        merged.shadowed.push({ kind: 'instructions', name: ins.id, by: layer.name, over: merged.instructions[idx].layer });
        merged.instructions[idx] = { ...ins, layer: layer.name };
      } else {
        merged.instructions.push({ ...ins, layer: layer.name });
      }
    }
    layer.skills.forEach((s) => byName('skills', s, layer));
    layer.commands.forEach((s) => byName('commands', s, layer));
    layer.agents.forEach((s) => byName('agents', s, layer));
    layer.mcp.forEach((s) => byName('mcp', s, layer));
    for (const [adapterId, list] of Object.entries(layer.settings)) {
      (merged.settings[adapterId] ||= []).push(...list.map((x) => ({ ...x, layer: layer.name })));
    }
    for (const [adapterId, list] of Object.entries(layer.files)) {
      const target = (merged.files[adapterId] ||= []);
      for (const f of list) {
        const idx = target.findIndex((x) => x.rel === f.rel);
        if (idx >= 0) {
          target[idx] = { ...f, layer: layer.name };
        } else {
          target.push({ ...f, layer: layer.name });
        }
      }
    }
  }
  return merged;
}

export { OS_TAGS };
