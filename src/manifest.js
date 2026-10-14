import path from 'node:path';
import { parseJsonc } from './formats/jsonc.js';
import { readText, isDir, listDirs, isFile } from './util/fsx.js';

export const MANIFEST_NAMES = ['agent-setup.jsonc', 'agent-setup.json'];
export const PROJECT_MANIFEST_NAMES = ['project.jsonc', 'project.json'];

export const DEFAULT_OPTIONS = {
  secrets: { backend: 'auto', mode: 'auto', service: 'agent-setup' },
  skills: { universal: true },
  instructions: { header: true },
  gemini: { readAgentsMd: true },
  claude: { agentsMdImport: 'auto', mcp: 'cli' },
};

function readJsoncFile(file) {
  const r = readText(file);
  return r ? parseJsonc(r.text, file) : null;
}

export function findManifestFile(dir) {
  for (const n of MANIFEST_NAMES) {
    const f = path.join(dir, n);
    if (isFile(f)) {
      return f;
    }
  }
  return null;
}

function deepDefaults(defaults, value) {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(value || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && defaults[k] && typeof defaults[k] === 'object') {
      out[k] = deepDefaults(defaults[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadManifest(sourceDir) {
  const file = findManifestFile(sourceDir);
  if (!file) {
    throw new Error(`no agent-setup.jsonc found in ${sourceDir}. Run "agent-setup init" first or pass --source.`);
  }
  const raw = readJsoncFile(file) || {};
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error(`${file}: unsupported manifest version ${raw.version}`);
  }
  const extendsList = (raw.extends || []).map((e, i) => {
    const entry = typeof e === 'string' ? { path: e } : e;
    if (!entry.path && !entry.projects) {
      throw new Error(`${file}: extends[${i}] needs a "path" (a checkout of the shared layer) or a "projects" folder`);
    }
    return {
      name: entry.name || `extends${i + 1}`,
      dir: entry.path ? path.resolve(sourceDir, entry.path) : null,
      projectsDir: entry.projects ? path.resolve(sourceDir, entry.projects) : null,
      optional: Boolean(entry.optional),
      git: entry.git || null,
    };
  });
  return {
    file,
    name: raw.name || path.basename(sourceDir),
    targets: raw.targets ?? 'auto',
    extends: extendsList,
    baseDir: path.resolve(sourceDir, raw.base || 'base'),
    projectsDir: path.resolve(sourceDir, raw.projects || 'projects'),
    vars: raw.vars || {},
    options: deepDefaults(DEFAULT_OPTIONS, raw.options || {}),
    raw,
  };
}

export function projectSources(manifest) {
  return [{ dir: manifest.projectsDir, origin: null }, ...(manifest.extends || []).filter((e) => e.projectsDir).map((e) => ({ dir: e.projectsDir, origin: e.name }))];
}

export function listProjects(manifest) {
  const out = [];
  const seen = new Map();
  for (const source of projectSources(manifest)) {
    if (!isDir(source.dir)) {
      continue;
    }
    for (const name of listDirs(source.dir)) {
      const dir = path.join(source.dir, name);
      const file = PROJECT_MANIFEST_NAMES.map((n) => path.join(dir, n)).find(isFile);
      if (!file) {
        continue;
      }
      const project = { ...loadProjectManifest(dir, file, name), origin: source.origin };
      const prev = seen.get(project.name);
      if (prev) {
        throw new Error(`project "${project.name}" is defined twice: ${prev.dir} and ${project.dir}. Rename one of them.`);
      }
      seen.set(project.name, project);
      out.push(project);
    }
  }
  return out;
}

export function loadProjectManifest(dir, file, folderName) {
  const raw = readJsoncFile(file) || {};
  const mode = raw.mode || 'private';
  if (!['private', 'shared'].includes(mode)) {
    throw new Error(`${file}: mode must be "private" or "shared"`);
  }
  return {
    name: raw.name || folderName,
    dir,
    file,
    description: raw.description || '',
    mode,
    match: {
      gitRemote: [].concat(raw.match?.gitRemote || []),
      dirName: [].concat(raw.match?.dirName || []),
      path: [].concat(raw.match?.path || []),
    },
    targets: raw.targets ?? 'inherit',
    vars: raw.vars || {},
    memory: raw.memory || {},
    purge: { agentData: true, ...(raw.purge || {}) },
    raw,
  };
}

export function getProject(manifest, name) {
  const p = listProjects(manifest).find((x) => x.name === name);
  if (!p) {
    throw new Error(`project "${name}" not found under ${projectSources(manifest).map((s) => s.dir).join(', ')}`);
  }
  return p;
}
