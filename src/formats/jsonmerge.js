import crypto from 'node:crypto';
import { stableStringify } from './jsonc.js';

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

export function valueHash(v) {
  return crypto.createHash('sha256').update(stableStringify(v === undefined ? null : v)).digest('hex').slice(0, 16);
}

export function getAt(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (!isPlainObject(cur) || !(p in cur)) {
      return undefined;
    }
    cur = cur[p];
  }
  return cur;
}

export function setAt(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const p = path[i];
    if (!isPlainObject(cur[p])) {
      cur[p] = {};
    }
    cur = cur[p];
  }
  cur[path[path.length - 1]] = value;
}

export function deleteAt(obj, path, { prune = true } = {}) {
  const parents = [];
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    if (!isPlainObject(cur[path[i]])) {
      return false;
    }
    parents.push([cur, path[i]]);
    cur = cur[path[i]];
  }
  const last = path[path.length - 1];
  if (!(last in cur)) {
    return false;
  }
  delete cur[last];
  if (prune) {
    for (let i = parents.length - 1; i >= 0; i -= 1) {
      const [parent, key] = parents[i];
      if (isPlainObject(parent[key]) && Object.keys(parent[key]).length === 0) {
        delete parent[key];
      } else {
        break;
      }
    }
  }
  return true;
}

function matchesAtomic(path, patterns) {
  return patterns.some((pat) => pat.length === path.length && pat.every((seg, i) => seg === '*' || seg === path[i]));
}

export function flattenLeaves(fragment, atomic = [], prefix = []) {
  const out = [];
  for (const [k, v] of Object.entries(fragment || {})) {
    const p = [...prefix, k];
    if (isPlainObject(v) && Object.keys(v).length > 0 && !matchesAtomic(p, atomic)) {
      out.push(...flattenLeaves(v, atomic, p));
    } else {
      out.push({ path: p, value: v });
    }
  }
  return out;
}

export const pathKey = (p) => p.map((s) => String(s).replace(/\./g, '\\.')).join('.');

export const splitPathKey = (key) => String(key).split(/(?<!\\)\./).map((s) => s.replace(/\\\./g, '.'));

export function isPathPrefix(prefix, p) {
  return prefix.length <= p.length && prefix.every((seg, i) => String(seg) === String(p[i]));
}

export function forgetEntryFor(forget, p) {
  return (forget || []).find((f) => isPathPrefix(f.path, p));
}

export function planManagedMerge(current, fragment, { atomic = [], previous = [], forget = [] } = {}) {
  const result = clone(current) || {};
  const leaves = flattenLeaves(fragment, atomic);
  const managed = [];
  const changes = [];
  const drift = [];
  const prevByKey = new Map(previous.map((m) => [pathKey(m.path), m]));
  for (const leaf of leaves) {
    const key = pathKey(leaf.path);
    const before = getAt(result, leaf.path);
    const prev = prevByKey.get(key);
    if (prev && before !== undefined && valueHash(before) !== prev.hash && valueHash(before) !== valueHash(leaf.value)) {
      drift.push({ path: leaf.path, current: before, desired: leaf.value });
    }
    if (valueHash(before) !== valueHash(leaf.value) || before === undefined) {
      changes.push({ op: before === undefined ? 'add' : 'set', path: leaf.path, before, after: leaf.value });
    }
    setAt(result, leaf.path, clone(leaf.value));
    managed.push({ path: leaf.path, hash: valueHash(leaf.value) });
  }
  const desiredKeys = new Set(leaves.map((l) => pathKey(l.path)));
  for (const prev of previous) {
    if (desiredKeys.has(pathKey(prev.path))) {
      continue;
    }
    const cur = getAt(result, prev.path);
    const forgotten = forgetEntryFor(forget, prev.path);
    if (forgotten) {
      changes.push({ op: 'forget', path: prev.path, before: cur, after: cur, layer: forgotten.layer || null });
      continue;
    }
    if (cur === undefined) {
      continue;
    }
    if (valueHash(cur) === prev.hash) {
      deleteAt(result, prev.path);
      changes.push({ op: 'remove', path: prev.path, before: cur, after: undefined });
    } else {
      drift.push({ path: prev.path, current: cur, desired: undefined, note: 'no longer managed but modified locally; left in place' });
    }
  }
  return { result, managed, changes, drift };
}

export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) {
    return clone(over === undefined ? base : over);
  }
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = clone(v);
    }
  }
  return out;
}
