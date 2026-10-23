import fs from 'node:fs';
import path from 'node:path';
import { readText, writeTextAtomic, writeBytesAtomic, exists, isDir, sha256, hashFiles, readDirSnapshot, removePath, timestamp } from './util/fsx.js';
import { getBlockContent, upsertBlock, removeBlock } from './formats/mdblock.js';
import { parseJsonc, stripJsonc } from './formats/jsonc.js';
import { planManagedMerge, valueHash, getAt, flattenLeaves, pathKey, clone, forgetEntryFor } from './formats/jsonmerge.js';
import { TomlDocument, toPlain } from './formats/toml.js';
import { run, which } from './util/proc.js';
import { formatDiff } from './util/diff.js';
import { recordsForScope } from './state.js';
import { normalizeKey } from './render.js';

const NEUTRAL_OWNERS = new Set(['git', 'home', 'project']);

function detectIndent(text) {
  const m = /^([ \t]+)"/m.exec(text || '');
  return m ? m[1] : '  ';
}

function jsonText(obj, like) {
  return `${JSON.stringify(obj, null, detectIndent(like))}\n`;
}

function describeValue(v) {
  const s = JSON.stringify(v);
  return s && s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function keyChanges(changes) {
  return changes.map((c) => {
    if (c.op === 'add') {
      return `+ ${pathKey(c.path)} = ${describeValue(c.after)}`;
    }
    if (c.op === 'remove') {
      return `- ${pathKey(c.path)}`;
    }
    if (c.op === 'forget') {
      return `= ${pathKey(c.path)} (no longer managed${c.before === undefined ? '' : '; value kept'})`;
    }
    return `~ ${pathKey(c.path)}: ${describeValue(c.before)} -> ${describeValue(c.after)}`;
  });
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function rawHash(p, dir = false) {
  try {
    if (dir) {
      return isDir(p) ? hashFiles(readDirSnapshot(p)) : null;
    }
    return exists(p) && !isDir(p) ? sha256(fs.readFileSync(p)) : null;
  } catch {
    return null;
  }
}

function backupFile(ctx, plan, file) {
  if (!plan.backup || !exists(file)) {
    return;
  }
  const rel = path.resolve(file).replace(/^([A-Za-z]):/, '$1').replace(/[\\/:]+/g, '_');
  const dest = path.join(ctx.paths.stateDir, 'backups', plan.stamp, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (isDir(file)) {
    fs.cpSync(file, dest, { recursive: true, dereference: true });
  } else {
    fs.copyFileSync(file, dest);
  }
  plan.backups.push(dest);
}

function textState(file) {
  const r = readText(file);
  return r || null;
}

function planFile(o, record) {
  const cur = exists(o.path) && !isDir(o.path) ? fs.readFileSync(o.path) : null;
  const desiredBuf = Buffer.isBuffer(o.content) ? o.content : null;
  const desiredText = desiredBuf ? null : String(o.content);
  const curText = cur && !desiredBuf ? cur.toString('utf8').replace(/^﻿/, '').replace(/\r+\n/g, '\n') : null;
  const desiredHash = desiredBuf ? sha256(desiredBuf) : sha256(desiredText);
  const curHash = cur ? (desiredBuf ? sha256(cur) : sha256(curText)) : null;
  const item = { before: curText, after: desiredText, hash: desiredHash, beforeHash: cur ? sha256(cur) : null };
  if (isSymlink(o.path)) {
    item.reason = `symbolic link; agent-layers writes to its target ${fs.realpathSync(o.path)}`;
  }
  if (!cur) {
    return { ...item, action: 'create' };
  }
  if (curHash === desiredHash) {
    return { ...item, action: 'noop' };
  }
  if (record && record.hash === curHash) {
    return { ...item, action: 'update' };
  }
  return { ...item, action: record ? 'drift' : 'conflict', reason: record ? 'modified outside agent-layers since the last apply' : 'file exists and is not managed by agent-layers' };
}

function applyFile(o) {
  if (Buffer.isBuffer(o.content)) {
    writeBytesAtomic(o.path, o.content, { mode: o.mode });
    return;
  }
  const ts = textState(o.path);
  writeTextAtomic(o.path, String(o.content), { bom: ts ? ts.bom : false, eol: ts ? ts.eol : 'lf', mode: o.mode });
}

function planDir(o, record) {
  const desiredHash = hashFiles(o.files);
  if (isSymlink(o.path)) {
    return { action: 'error', hash: desiredHash, reason: 'is a symbolic link; agent-layers does not write through linked folders. Remove the link or exclude this skill.' };
  }
  if (!isDir(o.path)) {
    return { action: 'create', hash: desiredHash, beforeHash: null, before: null, after: o.files.map((f) => f.rel).join('\n') };
  }
  const snap = readDirSnapshot(o.path);
  const curHash = hashFiles(snap);
  const desiredSet = new Set(o.files.map((f) => f.rel));
  const curSet = new Set(snap.map((f) => f.rel));
  const lines = [];
  for (const f of o.files) {
    const c = snap.find((x) => x.rel === f.rel);
    if (!c) {
      lines.push(`+ ${f.rel}`);
    } else if (sha256(c.content) !== sha256(f.content)) {
      lines.push(`~ ${f.rel}`);
    }
  }
  for (const r of curSet) {
    if (!desiredSet.has(r)) {
      lines.push(`- ${r}`);
    }
  }
  const base = { hash: desiredHash, details: lines, beforeHash: curHash };
  if (curHash === desiredHash) {
    return { ...base, action: 'noop' };
  }
  if (record && record.hash === curHash) {
    return { ...base, action: 'update' };
  }
  return { ...base, action: record ? 'drift' : 'conflict', reason: record ? 'skill folder modified outside agent-layers since the last apply' : 'folder exists and is not managed by agent-layers' };
}

function applyDir(o) {
  const desired = new Map(o.files.map((f) => [f.rel, f]));
  if (isDir(o.path)) {
    for (const f of readDirSnapshot(o.path)) {
      if (!desired.has(f.rel)) {
        removePath(path.join(o.path, ...f.rel.split('/')));
      }
    }
  }
  for (const f of o.files) {
    const target = path.join(o.path, ...f.rel.split('/'));
    if (Buffer.isBuffer(f.content)) {
      writeBytesAtomic(target, f.content, { mode: f.mode });
    } else {
      writeTextAtomic(target, f.content, { mode: f.mode });
    }
  }
}

function planBlock(o, record) {
  const style = o.style || 'html';
  const ts = textState(o.path);
  const text = ts ? ts.text : '';
  const curBlock = ts ? getBlockContent(text, o.blockId, style) : null;
  const desired = o.content.replace(/\n+$/, '');
  const hash = sha256(desired);
  const next = upsertBlock(text, o.blockId, desired, { style });
  const item = { before: text, after: next, hash, beforeBlock: curBlock, afterBlock: desired, beforeHash: rawHash(o.path) };
  if (curBlock === null) {
    return { ...item, action: ts ? 'update' : 'create', reason: ts ? 'adds a managed block; the rest of the file is preserved' : undefined };
  }
  if (sha256(curBlock) === hash) {
    return { ...item, action: 'noop' };
  }
  if (!record || record.hash === sha256(curBlock)) {
    return { ...item, action: 'update' };
  }
  return { ...item, action: 'drift', reason: 'managed block edited outside agent-layers since the last apply' };
}

function applyBlock(o, item) {
  const ts = textState(o.path);
  writeTextAtomic(o.path, item.after, { bom: ts ? ts.bom : false, eol: ts ? ts.eol : 'lf' });
}

function hasJsonComments(text) {
  return stripJsonc(text).replace(/\s+/g, '') !== text.replace(/\s+/g, '');
}

function planJson(o, record, { forget = [] } = {}) {
  const ts = textState(o.path);
  let current = {};
  if (ts && ts.text.trim()) {
    try {
      current = parseJsonc(ts.text, o.path);
    } catch (err) {
      return { action: 'error', reason: err.message };
    }
  }
  const previous = record?.managed || [];
  const merge = planManagedMerge(current, o.fragment, { atomic: o.atomic || [], previous, forget });
  const prevKeys = new Set(previous.map((m) => pathKey(m.path)));
  const conflicts = merge.changes.filter((c) => c.op === 'set' && !prevKeys.has(pathKey(c.path)));
  const forgetOnly = merge.changes.length > 0 && merge.changes.every((c) => c.op === 'forget');
  const after = forgetOnly ? (ts ? ts.text : null) : jsonText(merge.result, ts?.text);
  const item = { before: ts ? ts.text : null, after, managed: merge.managed, changes: merge.changes, details: keyChanges(merge.changes), result: merge.result, hash: valueHash(merge.managed), beforeHash: rawHash(o.path) };
  if (!merge.changes.length && !merge.drift.length) {
    return { ...item, action: 'noop' };
  }
  if (merge.drift.length) {
    return { ...item, action: 'drift', reason: `managed keys changed outside agent-layers: ${merge.drift.map((d) => pathKey(d.path)).join(', ')}` };
  }
  if (forgetOnly) {
    return { ...item, action: 'update', forgetOnly, reason: 'stops managing keys; the file is not rewritten' };
  }
  if (conflicts.length) {
    return { ...item, action: 'conflict', reason: `would overwrite existing unmanaged values: ${conflicts.map((c) => pathKey(c.path)).join(', ')}` };
  }
  if (ts && hasJsonComments(ts.text)) {
    return { ...item, action: 'conflict', reason: 'the file contains comments or trailing commas that rewriting it would drop' };
  }
  return { ...item, action: ts ? 'update' : 'create' };
}

function applyJson(o, item) {
  if (item.forgetOnly) {
    return;
  }
  const ts = textState(o.path);
  writeTextAtomic(o.path, item.after, { bom: ts ? ts.bom : false, eol: ts ? ts.eol : 'lf' });
}

function planToml(o, record, { forget = [] } = {}) {
  const ts = textState(o.path);
  let doc;
  try {
    doc = new TomlDocument(ts ? ts.text : '');
  } catch (err) {
    return { action: 'error', reason: `${o.path}: ${err.message}` };
  }
  const before = doc.toString();
  const changes = [];
  const drift = [];
  const conflicts = [];
  const prevLeaves = new Map((record?.managed || []).map((m) => [pathKey(m.path), m]));
  const prevTables = new Map((record?.tables || []).map((m) => [pathKey(m.path), m]));
  const managed = [];
  const tables = [];
  try {
    for (const leaf of flattenLeaves(o.values || {}, [])) {
      const cur = doc.getValue(leaf.path);
      const prev = prevLeaves.get(pathKey(leaf.path));
      managed.push({ path: leaf.path, hash: valueHash(leaf.value) });
      if (cur !== undefined && valueHash(cur) === valueHash(leaf.value)) {
        continue;
      }
      if (cur !== undefined && prev && valueHash(cur) !== prev.hash) {
        drift.push(leaf.path);
      } else if (cur !== undefined && !prev) {
        conflicts.push(leaf.path);
      }
      changes.push({ op: cur === undefined ? 'add' : 'set', path: leaf.path, before: cur, after: leaf.value });
      doc.set(leaf.path, leaf.value);
    }
    for (const [key, value] of Object.entries(o.tables || {})) {
      const tpath = JSON.parse(key);
      const cur = doc.getValue(tpath);
      const prev = prevTables.get(pathKey(tpath));
      tables.push({ path: tpath, hash: valueHash(value) });
      if (cur !== undefined && valueHash(toPlain(cur)) === valueHash(value)) {
        continue;
      }
      if (cur !== undefined && prev && valueHash(toPlain(cur)) !== prev.hash) {
        drift.push(tpath);
      } else if (cur !== undefined && !prev) {
        conflicts.push(tpath);
      }
      changes.push({ op: cur === undefined ? 'add' : 'set', path: tpath, before: cur, after: value });
      doc.setTable(tpath, value);
    }
    const desiredLeafKeys = new Set(managed.map((m) => pathKey(m.path)));
    for (const [k, prev] of prevLeaves) {
      if (desiredLeafKeys.has(k)) {
        continue;
      }
      const cur = doc.getValue(prev.path);
      const forgotten = forgetEntryFor(forget, prev.path);
      if (forgotten) {
        changes.push({ op: 'forget', path: prev.path, before: cur, after: cur, layer: forgotten.layer || null });
        continue;
      }
      if (cur !== undefined && valueHash(cur) === prev.hash) {
        doc.remove(prev.path);
        changes.push({ op: 'remove', path: prev.path, before: cur });
      }
    }
    const desiredTableKeys = new Set(tables.map((m) => pathKey(m.path)));
    for (const [k, prev] of prevTables) {
      if (desiredTableKeys.has(k)) {
        continue;
      }
      const cur = doc.getValue(prev.path);
      const forgotten = forgetEntryFor(forget, prev.path);
      if (forgotten) {
        changes.push({ op: 'forget', path: prev.path, before: cur === undefined ? undefined : toPlain(cur), after: cur === undefined ? undefined : toPlain(cur), layer: forgotten.layer || null });
        continue;
      }
      if (cur !== undefined && valueHash(toPlain(cur)) === prev.hash) {
        doc.removeTable(prev.path);
        changes.push({ op: 'remove', path: prev.path, before: cur });
      }
    }
  } catch (err) {
    return { action: 'error', reason: `${o.path}: ${err.message}` };
  }
  const after = doc.toString();
  const forgetOnly = changes.length > 0 && changes.every((c) => c.op === 'forget');
  const item = { before: ts ? before : null, after, managed, tables, changes, details: keyChanges(changes), hash: valueHash({ managed, tables }), beforeHash: rawHash(o.path) };
  if (!changes.length) {
    return { ...item, action: 'noop' };
  }
  if (forgetOnly) {
    return { ...item, action: 'update', forgetOnly, reason: 'stops managing keys; the file is not rewritten' };
  }
  if (drift.length) {
    return { ...item, action: 'drift', reason: `managed keys changed outside agent-layers: ${drift.map(pathKey).join(', ')}` };
  }
  if (conflicts.length) {
    return { ...item, action: 'conflict', reason: `would overwrite existing unmanaged values: ${conflicts.map(pathKey).join(', ')}` };
  }
  return { ...item, action: ts ? 'update' : 'create' };
}

function applyToml(o, item) {
  if (item.forgetOnly) {
    return;
  }
  const ts = textState(o.path);
  writeTextAtomic(o.path, item.after, { bom: ts ? ts.bom : false, eol: ts ? ts.eol : 'lf' });
}

function claudeServers(o) {
  const ts = textState(o.path);
  if (!ts) {
    return {};
  }
  const j = parseJsonc(ts.text, o.path);
  if (o.scope === 'user') {
    return j.mcpServers || {};
  }
  const want = normalizeKey(o.cwd);
  for (const [k, v] of Object.entries(j.projects || {})) {
    if (normalizeKey(k) === want) {
      return v.mcpServers || {};
    }
  }
  return {};
}

function serversHash(o, names) {
  try {
    const cur = claudeServers(o);
    return valueHash(Object.fromEntries(names.map((n) => [n, cur[n] === undefined ? null : cur[n]])));
  } catch {
    return null;
  }
}

function planClaudeMcp(o, record) {
  let current;
  try {
    current = claudeServers(o);
  } catch (err) {
    return { action: 'error', reason: err.message };
  }
  const prev = record?.servers || {};
  const ops = [];
  const conflicts = [];
  const drift = [];
  for (const [name, cfg] of Object.entries(o.servers)) {
    const cur = current[name];
    if (cur === undefined) {
      ops.push({ op: 'add', name, cfg });
      continue;
    }
    if (valueHash(cur) === valueHash(cfg)) {
      continue;
    }
    if (prev[name] && valueHash(cur) === prev[name]) {
      ops.push({ op: 'set', name, cfg, old: cur });
    } else if (prev[name]) {
      drift.push(name);
      ops.push({ op: 'set', name, cfg, old: cur });
    } else {
      conflicts.push(name);
      ops.push({ op: 'set', name, cfg, old: cur });
    }
  }
  for (const name of Object.keys(prev)) {
    if (name in o.servers || current[name] === undefined) {
      continue;
    }
    if (valueHash(current[name]) === prev[name]) {
      ops.push({ op: 'remove', name, old: current[name] });
    } else {
      drift.push(name);
    }
  }
  const names = [...new Set([...Object.keys(o.servers), ...Object.keys(prev)])];
  const details = ops.map((x) => `${x.op === 'add' ? '+' : x.op === 'remove' ? '-' : '~'} MCP server ${x.name} (claude mcp ${x.op === 'remove' ? 'remove' : 'add-json'} -s ${o.scope})`);
  const servers = Object.fromEntries(Object.entries(o.servers).map(([n, c]) => [n, valueHash(c)]));
  const base = { ops, details, servers, names, beforeServers: serversHash(o, names), hash: valueHash(servers) };
  if (ops.length && !which('claude')) {
    return { ...base, action: 'error', reason: 'the claude CLI is not on PATH; install Claude Code or set options.claude.mcp to "json"' };
  }
  if (drift.length) {
    return { ...base, action: 'drift', reason: `MCP servers changed outside agent-layers: ${drift.join(', ')}` };
  }
  if (conflicts.length) {
    return { ...base, action: 'conflict', reason: `MCP servers with the same name already exist and are not managed by agent-layers: ${conflicts.join(', ')}` };
  }
  return { ...base, action: ops.length ? 'update' : 'noop' };
}

function claudeMcp(o, args) {
  return run('claude', ['mcp', ...args], { cwd: o.cwd || undefined, timeout: 60000 });
}

function applyClaudeMcp(o, item) {
  for (const x of item.ops) {
    if (x.op === 'remove' || x.op === 'set') {
      const r = claudeMcp(o, ['remove', x.name, '-s', o.scope]);
      if (r.code !== 0) {
        throw new Error(`claude mcp remove ${x.name} failed: ${(r.stderr || r.stdout).trim()}`);
      }
    }
    if (x.op === 'remove') {
      continue;
    }
    const r = claudeMcp(o, ['add-json', x.name, JSON.stringify(x.cfg), '-s', o.scope]);
    if (r.code !== 0) {
      if (x.old !== undefined) {
        claudeMcp(o, ['add-json', x.name, JSON.stringify(x.old), '-s', o.scope]);
      }
      throw new Error(`claude mcp add-json ${x.name} failed${x.old !== undefined ? ' (the previous definition was restored)' : ''}: ${(r.stderr || r.stdout).trim()}`);
    }
  }
}

const PLANNERS = { file: planFile, dir: planDir, block: planBlock, json: planJson, toml: planToml, 'claude-mcp': planClaudeMcp };
const APPLIERS = { file: applyFile, dir: applyDir, block: applyBlock, json: applyJson, toml: applyToml, 'claude-mcp': applyClaudeMcp };

function planRemoval(rec, forget = []) {
  const o = rec;
  switch (rec.type) {
    case 'file': {
      if (!exists(o.path)) {
        return null;
      }
      const cur = fs.readFileSync(o.path);
      const h1 = sha256(cur);
      const h2 = sha256(cur.toString('utf8').replace(/^﻿/, '').replace(/\r+\n/g, '\n'));
      if (h1 === rec.hash || h2 === rec.hash) {
        return { action: 'remove', beforeHash: h1, apply: () => removePath(o.path) };
      }
      return { action: 'drift', reason: 'no longer in the source, but modified locally; left in place' };
    }
    case 'dir': {
      if (!isDir(o.path)) {
        return null;
      }
      if (isSymlink(o.path)) {
        return { action: 'drift', reason: 'is now a symbolic link; left in place' };
      }
      const h = hashFiles(readDirSnapshot(o.path));
      if (h === rec.hash) {
        return { action: 'remove', beforeHash: h, beforeDir: true, apply: () => removePath(o.path) };
      }
      return { action: 'drift', reason: 'no longer in the source, but modified locally; left in place' };
    }
    case 'block': {
      const ts = textState(o.path);
      if (!ts) {
        return null;
      }
      const cur = getBlockContent(ts.text, rec.blockId, rec.style || 'html');
      if (cur === null) {
        return null;
      }
      if (sha256(cur) !== rec.hash) {
        return { action: 'drift', reason: 'block no longer in the source, but edited locally; left in place' };
      }
      const next = removeBlock(ts.text, rec.blockId, rec.style || 'html');
      return {
        action: 'remove',
        before: ts.text,
        after: next,
        beforeHash: rawHash(o.path),
        apply: () => {
          if (!next.trim()) {
            removePath(o.path);
          } else {
            writeTextAtomic(o.path, next, { bom: ts.bom, eol: ts.eol });
          }
        },
      };
    }
    case 'json': {
      const ts = textState(o.path);
      if (!ts) {
        return null;
      }
      const current = parseJsonc(ts.text, o.path);
      const merge = planManagedMerge(current, {}, { previous: rec.managed || [], forget });
      if (!merge.changes.some((ch) => ch.op === 'remove')) {
        return null;
      }
      const drop = rec.created === true && Object.keys(merge.result).length === 0;
      return {
        action: 'remove',
        details: keyChanges(merge.changes),
        beforeHash: rawHash(o.path),
        apply: () => {
          if (drop) {
            removePath(o.path);
          } else {
            writeTextAtomic(o.path, jsonText(merge.result, ts.text), { bom: ts.bom, eol: ts.eol });
          }
        },
      };
    }
    case 'toml': {
      const ts = textState(o.path);
      if (!ts) {
        return null;
      }
      const item = planToml({ path: o.path, values: {}, tables: {} }, rec, { forget });
      if (item.action === 'noop' || !item.changes?.some((ch) => ch.op === 'remove')) {
        return null;
      }
      const drop = rec.created === true && !item.after.trim();
      return {
        action: 'remove',
        details: item.details,
        beforeHash: rawHash(o.path),
        apply: () => {
          if (drop) {
            removePath(o.path);
          } else {
            writeTextAtomic(o.path, item.after, { bom: ts.bom, eol: ts.eol });
          }
        },
      };
    }
    case 'claude-mcp': {
      const names = Object.keys(rec.servers || {});
      if (!names.length) {
        return null;
      }
      if (!which('claude')) {
        return { action: 'error', reason: `the claude CLI is not on PATH; cannot remove MCP servers ${names.join(', ')} (the record is kept)` };
      }
      let current = {};
      try {
        current = claudeServers({ path: rec.path, scope: rec.scope, cwd: rec.cwd });
      } catch {
        current = {};
      }
      const removable = names.filter((n) => current[n] !== undefined && valueHash(current[n]) === rec.servers[n]);
      const changed = names.filter((n) => current[n] !== undefined && valueHash(current[n]) !== rec.servers[n]);
      if (!removable.length && !changed.length) {
        return null;
      }
      return {
        action: removable.length ? 'remove' : 'drift',
        reason: changed.length ? `changed outside agent-layers and left in place: ${changed.join(', ')}` : undefined,
        details: removable.map((n) => `- MCP server ${n}`),
        apply: () => removable.forEach((n) => run('claude', ['mcp', 'remove', n, '-s', rec.scope], { cwd: rec.cwd || undefined })),
      };
    }
    default:
      return null;
  }
}

function removable(rec, selected) {
  if (!selected) {
    return true;
  }
  const owners = (rec.adapters || []).filter((a) => !NEUTRAL_OWNERS.has(a));
  return owners.every((a) => selected.includes(a));
}

export function buildPlan(ctx, { outputs, state, scopeKey, removals = true, selected = null, backup = true, forget = [] }) {
  const plan = { stamp: timestamp(), items: [], backups: [], scopeKey, backup };
  const forgetByPath = new Map();
  for (const f of forget) {
    const k = normalizeKey(f.path);
    forgetByPath.set(k, [...(forgetByPath.get(k) || []), ...f.entries]);
  }
  const forgetFor = (p) => forgetByPath.get(normalizeKey(p)) || [];
  const desiredIds = new Set();
  for (const o of outputs) {
    desiredIds.add(o.id);
    const record = state.outputs[o.id];
    const planner = PLANNERS[o.type];
    let item;
    try {
      item = planner(o, record, { forget: forgetFor(o.path) });
    } catch (err) {
      item = { action: 'error', reason: err.message };
    }
    plan.items.push({ ...item, id: o.id, type: o.type, path: o.path, adapters: [...o.adapters], output: o });
  }
  if (removals) {
    for (const rec of recordsForScope(state, scopeKey)) {
      if (desiredIds.has(rec.id)) {
        continue;
      }
      if (!removable(rec, selected)) {
        plan.items.push({ action: 'keep', id: rec.id, type: rec.type, path: rec.path, adapters: rec.adapters || [], record: rec, reason: 'belongs to agents outside this run; use --prune to remove it' });
        continue;
      }
      let r;
      try {
        r = planRemoval(rec, forgetFor(rec.path));
      } catch (err) {
        r = { action: 'error', reason: err.message };
      }
      if (r === null) {
        plan.items.push({ action: 'forget', id: rec.id, type: rec.type, path: rec.path, adapters: rec.adapters || [], record: rec });
      } else {
        plan.items.push({ ...r, id: rec.id, type: rec.type, path: rec.path, adapters: rec.adapters || [], record: rec, removal: true });
      }
    }
  }
  return plan;
}

export function summarize(plan) {
  const counts = {};
  for (const it of plan.items) {
    counts[it.action] = (counts[it.action] || 0) + 1;
  }
  return counts;
}

export function pending(plan, { force = false } = {}) {
  return plan.items.filter((it) => ['create', 'update', 'remove'].includes(it.action) || (force && ['conflict', 'drift'].includes(it.action) && !it.removal));
}

function unchangedSincePlan(it) {
  if (it.type === 'claude-mcp' && !it.removal) {
    return serversHash(it.output, it.names || []) === it.beforeServers;
  }
  if (it.beforeHash === undefined) {
    return true;
  }
  return rawHash(it.path, it.type === 'dir' || it.beforeDir) === it.beforeHash;
}

export function applyPlan(ctx, plan, state, { force = false, scope, project = null, root = null } = {}) {
  const results = [];
  const now = new Date().toISOString();
  for (const it of plan.items) {
    const runnable = ['create', 'update', 'remove'].includes(it.action) || (force && ['conflict', 'drift'].includes(it.action) && !it.removal);
    if (it.action === 'forget') {
      delete state.outputs[it.id];
      continue;
    }
    if (it.action === 'noop' && it.output) {
      state.outputs[it.id] = recordFor(it, plan, scope, project, root, now, state.outputs[it.id]);
      continue;
    }
    if (!runnable) {
      if (it.action !== 'noop' && it.action !== 'keep') {
        results.push({ it, status: 'skipped' });
      }
      continue;
    }
    if (!unchangedSincePlan(it)) {
      results.push({ it, status: 'skipped', error: 'changed after the plan was made; run the command again' });
      continue;
    }
    try {
      if (it.removal) {
        backupFile(ctx, plan, it.path);
        it.apply();
        delete state.outputs[it.id];
        if (root) {
          pruneEmptyParents(it.path, root);
        }
      } else {
        if (it.type === 'claude-mcp') {
          backupFile(ctx, plan, it.path);
        } else if ((it.action === 'update' || it.action === 'conflict' || it.action === 'drift') && !it.forgetOnly) {
          backupFile(ctx, plan, it.path);
        }
        APPLIERS[it.type](it.output, it);
        state.outputs[it.id] = recordFor(it, plan, scope, project, root, now, state.outputs[it.id]);
      }
      results.push({ it, status: 'done' });
    } catch (err) {
      results.push({ it, status: 'failed', error: err.message });
    }
  }
  state.history.push({ at: now, scope: plan.scopeKey, done: results.filter((r) => r.status === 'done').length, failed: results.filter((r) => r.status === 'failed').length, backups: plan.backups.length ? path.join(ctx.paths.stateDir, 'backups', plan.stamp) : null });
  return results;
}

function pruneEmptyParents(file, root) {
  const top = path.resolve(root);
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    const rel = path.relative(top, dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep)[0] === '.git') {
      return;
    }
    try {
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

function recordFor(it, plan, scope, project, root, now, prev = null) {
  const o = it.output;
  const rec = { type: o.type, path: o.path, scopeKey: plan.scopeKey, scope, project: project || null, root: root || null, adapters: [...o.adapters], appliedAt: now };
  if ((o.type === 'json' || o.type === 'toml') && (it.action === 'create' || prev?.created === true)) {
    rec.created = true;
  }
  if (o.type === 'block') {
    rec.blockId = o.blockId;
    rec.style = o.style || 'html';
    rec.hash = it.hash;
  } else if (o.type === 'json') {
    rec.managed = it.managed;
  } else if (o.type === 'toml') {
    rec.managed = it.managed;
    rec.tables = it.tables;
  } else if (o.type === 'claude-mcp') {
    rec.servers = it.servers;
    rec.scope = o.scope;
    rec.cwd = o.cwd || null;
  } else {
    rec.hash = it.hash;
  }
  if (o.type === 'json' || o.type === 'toml') {
    const forgotten = forgottenFor(it, prev, now);
    if (forgotten.length) {
      rec.forgotten = forgotten;
    }
  }
  return rec;
}

function forgottenFor(it, prev, now) {
  const managed = new Set([...(it.managed || []), ...(it.tables || [])].map((m) => pathKey(m.path)));
  const fresh = (it.changes || []).filter((ch) => ch.op === 'forget').map((ch) => ({ path: ch.path, layer: ch.layer || null, at: now }));
  const freshKeys = new Set(fresh.map((f) => pathKey(f.path)));
  const kept = (prev?.forgotten || []).filter((f) => !managed.has(pathKey(f.path)) && !freshKeys.has(pathKey(f.path)));
  return [...kept, ...fresh];
}

export function describeItem(it, { diff = false, redact = (s) => s } = {}) {
  const lines = [];
  if (it.reason) {
    lines.push(`    ${it.reason}`);
  }
  if (it.details && it.details.length) {
    lines.push(...it.details.map((d) => `    ${d}`));
  }
  if (diff) {
    let d = '';
    if (it.type === 'block' && it.beforeBlock !== undefined) {
      d = formatDiff(it.beforeBlock || '', it.afterBlock || '', { context: 2 });
    } else if ((it.type === 'file' || it.type === 'toml' || it.type === 'json' || it.removal) && typeof it.after === 'string') {
      d = formatDiff(it.before || '', it.after || '', { context: 2 });
    }
    if (d) {
      lines.push(d.split('\n').map((l) => `    ${l}`).join('\n'));
    }
  }
  return lines.map(redact);
}

export { clone, getAt };
