import path from 'node:path';
import { findSecretRefs } from './template.js';

function markdownItem(item) {
  return { name: item.name, targets: item.targets, description: item.description };
}

export function summarizeLayer(layer) {
  return {
    name: layer.name,
    dir: layer.dir,
    missing: layer.missing,
    instructions: layer.instructions.map((i) => ({ id: i.id, targets: i.targets, exclude: i.exclude, paths: i.paths, template: i.template, description: i.description })),
    skills: layer.skills.map(markdownItem),
    commands: layer.commands.map(markdownItem),
    agents: layer.agents.map(markdownItem),
    mcp: layer.mcp.map((m) => ({
      name: m.name,
      targets: m.def.targets ? [].concat(m.def.targets) : null,
      command: m.def.command || null,
      url: m.def.url || null,
      secrets: [...findSecretRefs(m.def)].sort(),
    })),
    settings: Object.entries(layer.settings).flatMap(([agent, list]) => list.map((s) => ({ agent, file: path.basename(s.file), os: s.os || null, keys: Object.keys(s.value || {}) }))),
    forget: (layer.forget || []).map((f) => ({ agent: f.agent, key: f.key, file: path.basename(f.file), os: f.os || null })),
    files: Object.entries(layer.files).map(([agent, list]) => ({ agent, files: list.map((f) => f.rel) })),
  };
}

export function countItems(summary) {
  const counts = {
    instructions: summary.instructions.length,
    skills: summary.skills.length,
    commands: summary.commands.length,
    agents: summary.agents.length,
    mcp: summary.mcp.length,
    settings: summary.settings.length,
    forget: (summary.forget || []).length,
    files: summary.files.reduce((n, f) => n + f.files.length, 0),
  };
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}
