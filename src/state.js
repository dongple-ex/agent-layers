import path from 'node:path';
import { readText, writeTextAtomic } from './util/fsx.js';
import { parseJsonc, stringifyJson } from './formats/jsonc.js';
import { isPlainObject } from './formats/jsonmerge.js';

export function stateFile(ctx) {
  return path.join(ctx.paths.stateDir, 'state.json');
}

export function loadState(ctx, { checkOutputs = false } = {}) {
  const r = readText(stateFile(ctx));
  if (!r) {
    return { version: 1, outputs: {}, projects: {}, history: [] };
  }
  const s = parseJsonc(r.text, stateFile(ctx));
  if (checkOutputs && (!isPlainObject(s) || (s.version !== undefined && s.version !== 1) || !isPlainObject(s.outputs))) {
    throw new Error('Unreadable applied output records.');
  }
  s.outputs ||= {};
  s.projects ||= {};
  s.history ||= [];
  return s;
}

export function saveState(ctx, state) {
  state.history = (state.history || []).slice(-50);
  writeTextAtomic(stateFile(ctx), stringifyJson(state));
}

export function scopeKeyOf(scope, project, root) {
  if (scope === 'user') {
    return 'user';
  }
  return `project:${project}:${(root || '').replace(/\\/g, '/').toLowerCase()}`;
}

export function recordsForScope(state, scopeKey) {
  return Object.entries(state.outputs).filter(([, r]) => r.scopeKey === scopeKey).map(([id, r]) => ({ id, ...r }));
}
