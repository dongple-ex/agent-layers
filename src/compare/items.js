import fs from 'node:fs';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { ADAPTERS, ADAPTER_IDS } from '../adapters/registry.js';
import { resolvePaths } from '../context.js';
import { parseJsonc } from '../formats/jsonc.js';
import { flattenLeaves, forgetEntryFor, getAt, isPlainObject, valueHash } from '../formats/jsonmerge.js';
import { beginMarker, endMarker, getBlockContent } from '../formats/mdblock.js';
import { parseTomlValue } from '../formats/toml.js';
import { isWithinPath, normalizeKey } from '../render.js';
import { normalizeEol, sha256 } from '../util/fsx.js';
import { addCount, compareIds, isShareableName } from './common.js';

const SUPPORTED = new Set(['file', 'block', 'json', 'toml']);
const EXCLUDED = new Set(['dir', 'claude-mcp']);
const OWNERS = new Set([...ADAPTER_IDS, 'home', 'git']);
const OUTSIDE = Symbol('outside');
const COLLISION = Symbol('collision');

export function shareableName(ctx, markers = []) {
  const privateNames = [ctx.user, ctx.hostname, ctx.hostname?.split('.')[0], path.basename(ctx.paths.home), ...markers]
    .filter((name) => typeof name === 'string').flatMap((name) => name.toLowerCase().split(/[\\/]/)).filter(Boolean);
  return (name) => {
    if (!isShareableName(name)) {
      return false;
    }
    const lower = name.toLowerCase();
    return !privateNames.some((part) => part.length < 3 ? lower === part : lower.includes(part));
  };
}

function locations(ctx) {
  const p = { ...resolvePaths({ home: ctx.paths.home, sandbox: true }), ...ctx.paths };
  const roots = [];
  const mcp = new Map();
  function addRoot(alias, dir) {
    if (dir && path.isAbsolute(dir) && path.resolve(dir) !== path.parse(path.resolve(dir)).root) {
      roots.push({ alias, dir: path.resolve(dir) });
    }
  }
  for (const adapter of ADAPTERS) {
    const spec = adapter.user;
    const always = spec.instructions?.always;
    const server = spec.mcp;
    let root = spec.files?.(p, ctx.os);
    if (!root && always?.file) {
      root = path.dirname(always.file(p, ctx.os));
    } else if (!root && always?.dir) {
      root = path.dirname(always.dir(p, ctx.os));
    } else if (!root && server?.file) {
      root = path.dirname(server.file(p, ctx.os));
    }
    addRoot(adapter.id, root);
    if (server?.file) {
      const file = normalizeKey(server.file(p, ctx.os));
      const list = mcp.get(file) || [];
      list.push({ adapter: adapter.id, type: server.kind === 'claude-cli' ? 'json' : server.kind, prefix: server.key || server.table });
      mcp.set(file, list);
    }
  }
  addRoot('agents', p.agentsHome);
  addRoot('config', p.xdgConfig);
  addRoot('appData', p.appData);
  addRoot('localAppData', p.localAppData);
  addRoot('documents', p.documents);
  addRoot('home', p.home);
  roots.sort((a, b) => b.dir.length - a.dir.length);
  return { roots, mcp };
}

function locate(file, roots) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /^[\\/]{2}/.test(file) || file.split(/[\\/]/).includes('..')) {
    return null;
  }
  const matches = roots.filter((r) => isWithinPath(file, r.dir));
  if (!matches.length) {
    return null;
  }
  const root = matches[0];
  const rel = path.relative(root.dir, file);
  if (!rel) {
    return null;
  }
  return { file: path.resolve(file), root: root.dir, base: matches.at(-1).dir, alias: root.alias, parts: rel.split(path.sep) };
}

function resolveInside(boundary, alias, file) {
  const parts = path.relative(alias, file).split(path.sep);
  let current = boundary;
  let links = 0;
  while (parts.length) {
    const part = parts.shift();
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      if (normalizeKey(current) === normalizeKey(boundary)) {
        throw OUTSIDE;
      }
      current = path.dirname(current);
      continue;
    }
    const child = path.join(current, part);
    if (!fs.lstatSync(child).isSymbolicLink()) {
      current = child;
      continue;
    }
    links += 1;
    if (links > 40) {
      throw OUTSIDE;
    }
    let target = fs.readlinkSync(child);
    if (process.platform === 'win32') {
      target = target.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, '').replace(/\//g, path.sep);
    }
    if (path.isAbsolute(target)) {
      if (/^[\\/]{2}/.test(target) || target.split(path.sep).includes('..')) {
        throw OUTSIDE;
      }
      const root = [boundary, alias].find((dir) => isWithinPath(target, dir));
      if (!root) {
        throw OUTSIDE;
      }
      target = path.relative(root, target);
      current = boundary;
    }
    parts.unshift(...target.split(path.sep));
  }
  return current;
}

function readBytes({ file, root, base }) {
  const realBase = path.join(fs.realpathSync.native(path.dirname(base)), path.basename(base));
  if (fs.lstatSync(realBase).isSymbolicLink()) {
    throw OUTSIDE;
  }
  const boundary = resolveInside(realBase, base, root);
  const current = resolveInside(boundary, root, file);
  const stat = fs.lstatSync(current);
  if (!stat.isFile()) {
    throw new Error('item_not_file');
  }
  const fd = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || normalizeKey(fs.realpathSync.native(current)) !== normalizeKey(current)) {
      throw OUTSIDE;
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function textOf(bytes) {
  if (bytes.includes(0) || !isUtf8(bytes)) {
    return undefined;
  }
  return normalizeEol(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

function diskReader(issues) {
  const files = new Map();
  return (location, type) => {
    const key = normalizeKey(location.file);
    let disk = files.get(key);
    if (!disk) {
      disk = {};
      files.set(key, disk);
      try {
        disk.bytes = readBytes(location);
        disk.text = textOf(disk.bytes);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          disk.missing = true;
        } else {
          disk.issue = error === OUTSIDE ? 'unsafe_path' : 'item_read_failed';
          addCount(issues, disk.issue);
        }
      }
    }
    if (!disk.bytes || type === 'file') {
      return disk;
    }
    if (!Object.hasOwn(disk, type)) {
      try {
        if (disk.text === undefined) {
          throw new Error('invalid_text');
        }
        const value = type === 'json' ? parseJsonc(disk.text) : type === 'toml' ? parseTomlValue(disk.text) : disk.text;
        disk[type] = { value };
      } catch {
        disk[type] = { issue: 'item_parse_failed' };
        addCount(issues, 'item_parse_failed');
      }
    }
    return disk[type];
  };
}

function outputId(output) {
  if (output.id) {
    return output.id;
  }
  const id = ['user', output.type, normalizeKey(output.path)];
  if (output.type === 'block') {
    id.push(output.blockId);
  } else if (output.type === 'claude-mcp') {
    return ['user', output.type, output.scope, normalizeKey(output.path), output.cwd ? normalizeKey(output.cwd) : ''].join('|');
  }
  return id.join('|');
}

function desiredUnits(output) {
  switch (output.type) {
    case 'file':
    case 'block':
      return [{ path: [], value: output.content }];
    case 'json':
      return flattenLeaves(output.fragment, output.atomic);
    case 'toml':
      return [...flattenLeaves(output.values), ...Object.entries(output.tables || {}).map(([key, value]) => ({ path: JSON.parse(key), value }))];
    default:
      return [];
  }
}

function validKeyPath(unit) {
  return Array.isArray(unit?.path) && unit.path.length > 0 && unit.path.every((p) => typeof p === 'string');
}

function recordedUnits(record, invalid) {
  if (record.type === 'file' || record.type === 'block') {
    return [{ path: [], hash: record.hash }];
  }
  const units = [];
  for (const field of record.type === 'toml' ? ['managed', 'tables'] : ['managed']) {
    const group = record[field];
    if (group === undefined && record.type === 'toml' && (field === 'tables' || Array.isArray(record.tables))) {
      continue;
    }
    if (!Array.isArray(group)) {
      invalid();
      continue;
    }
    for (const unit of group) {
      if (validKeyPath(unit)) {
        units.push(unit);
      } else {
        invalid();
      }
    }
  }
  return units;
}

function containsMarker(value, marker) {
  if (typeof marker !== 'string' || !marker) {
    return false;
  }
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    return value.includes(marker);
  }
  return value !== null && typeof value === 'object' && Object.entries(value).some(([k, v]) => k.includes(marker) || containsMarker(v, marker));
}

function diagnosticUnits(outputs, marker) {
  const units = new Set();
  for (const output of outputs || []) {
    for (const unit of desiredUnits(output)) {
      if (marker === undefined || containsMarker(unit.value, marker)) {
        units.add(JSON.stringify([outputId(output), unit.path]));
      }
    }
  }
  return units;
}

function logicalId(location, output, keys, servers) {
  const matches = (servers || []).filter((s) =>
    s.type === output.type && keys.length === s.prefix.length + 1 && s.prefix.every((part, i) => keys[i] === part));
  if (matches.length > 1) {
    return null;
  }
  if (matches.length === 1) {
    return ['user', matches[0].adapter, 'mcp', keys.at(-1)];
  }
  const id = ['user', location.alias, output.type];
  if (output.type === 'json' || output.type === 'toml') {
    id.push(String(location.parts.length));
  }
  id.push(...location.parts, ...keys);
  if (output.type === 'block') {
    id.push(output.blockId);
  }
  return id;
}

function blockValue(text, output) {
  const style = output.style || 'html';
  const begin = beginMarker(output.blockId, style);
  const end = endMarker(output.blockId, style);
  const markers = text.split('\n').map((line) => line.trim()).filter((line) => line === begin || line === end);
  if (!markers.length) {
    return {};
  }
  if (markers.length !== 2 || markers[0] !== begin || markers[1] !== end) {
    return { issue: 'ambiguous_block' };
  }
  return { value: getBlockContent(text, output.blockId, style) };
}

function diskValue(disk, output, keys) {
  if (disk.issue || disk.missing) {
    return disk;
  }
  if (output.type === 'file') {
    return { value: disk.bytes, text: disk.text };
  }
  if (output.type === 'block') {
    return blockValue(disk.value, output);
  }
  return { value: getAt(disk.value, keys) };
}

function appliedMatches(type, disk, hash) {
  if (type === 'file') {
    if (sha256(disk.value) === hash) {
      return true;
    }
    if (disk.text === undefined) {
      return false;
    }
    return [disk.text, disk.text.replace(/\n/g, '\r\n')].some((text) =>
      sha256(Buffer.from(text)) === hash || sha256(Buffer.from('\uFEFF' + text)) === hash);
  }
  return (type === 'block' ? sha256(disk.value) : valueHash(disk.value)) === hash;
}

function currentMatches(type, disk, desired) {
  if (type === 'file') {
    if (Buffer.isBuffer(desired)) {
      return disk.value.equals(desired) || (disk.text !== undefined && disk.text === textOf(desired));
    }
    return disk.text === normalizeEol(desired);
  }
  if (type === 'block') {
    return disk.value === normalizeEol(desired).replace(/^\n+|\n+$/g, '');
  }
  return isDeepStrictEqual(disk.value, desired);
}

export function observeItems(ctx, {
  state, outputs = [], commonOutputs, variableOutputs, secretMarker, variableMarker,
  sourceKnown = true, stateKnown = true, commonKnown = true, variablesKnown = true, forget = [], privateNames = [],
}) {
  const issues = {};
  const excluded = {};
  const items = [];
  const entries = new Map();
  const excludedIds = new Set();
  const uncertainRecords = new Set();
  const counted = new Set();
  const { roots, mcp } = locations(ctx);
  const safe = shareableName(ctx, [secretMarker, variableMarker, ...privateNames]);
  const common = diagnosticUnits(commonKnown ? commonOutputs : []);
  const variables = diagnosticUnits(variablesKnown && variableMarker ? variableOutputs : [], variableMarker);
  const releases = new Map();
  for (const f of forget) {
    const key = normalizeKey(f.path);
    releases.set(key, [...(releases.get(key) || []), ...f.entries]);
  }

  function note(code, nativeId, keys) {
    const key = JSON.stringify([code, nativeId, keys]);
    if (!counted.has(key)) {
      counted.add(key);
      addCount(issues, code);
    }
  }

  function collect(output, nativeId, side) {
    function invalid() {
      uncertainRecords.add(nativeId);
      note('invalid_state_record', nativeId);
    }
    if (side === 'recorded' && (!isPlainObject(output) || typeof output.type !== 'string' || typeof output.path !== 'string')) {
      invalid();
      return;
    }
    if (EXCLUDED.has(output.type)) {
      if (!excludedIds.has(nativeId)) {
        addCount(excluded, output.type);
        excludedIds.add(nativeId);
      }
      return;
    }
    if (!SUPPORTED.has(output.type)) {
      note('unsupported_item_type', nativeId);
      return;
    }
    if (side === 'recorded' && ((output.adapters !== undefined && (!Array.isArray(output.adapters) || !output.adapters.every((s) => typeof s === 'string'))) ||
      (output.forgotten !== undefined && (!Array.isArray(output.forgotten) || !output.forgotten.every(validKeyPath))) ||
      (output.type === 'block' && output.style !== undefined && !['hash', 'html'].includes(output.style)))) {
      invalid();
      return;
    }
    const location = locate(output.path, roots);
    if (!location) {
      if (side === 'recorded') {
        uncertainRecords.add(nativeId);
      }
      note('unsafe_path', nativeId);
      return;
    }
    const owners = [...(output.adapters || [])];
    if (!location.parts.every(safe) || (output.type === 'block' && !safe(output.blockId)) || !owners.every((o) => OWNERS.has(o))) {
      if (side === 'recorded') {
        uncertainRecords.add(nativeId);
      }
      note('unsafe_identifier', nativeId);
      return;
    }
    const file = normalizeKey(location.file);
    const units = side === 'recorded' ? recordedUnits(output, invalid) : desiredUnits(output);
    for (const unit of units) {
      const keys = unit.path;
      if (!Array.isArray(keys) || !keys.every(safe) || (!keys.length && (output.type === 'json' || output.type === 'toml'))) {
        note('unsafe_identifier', nativeId, keys);
        continue;
      }
      if (keys.length && (forgetEntryFor(releases.get(file), keys) || (side === 'recorded' && output.forgotten?.some((f) => isDeepStrictEqual(f.path, keys))))) {
        continue;
      }
      const id = logicalId(location, output, keys, mcp.get(file));
      if (!id) {
        note('id_collision', nativeId, keys);
        continue;
      }
      const key = JSON.stringify(id);
      const identity = JSON.stringify([nativeId, file, output.type, output.blockId, keys]);
      let entry = entries.get(key);
      if (entry === COLLISION) {
        continue;
      }
      if (entry && (entry.identity !== identity || entry[side])) {
        entries.set(key, COLLISION);
        addCount(issues, 'id_collision');
        continue;
      }
      if (!entry) {
        entry = { id, identity, nativeId, location, type: output.type, keys, owners: new Set() };
        entries.set(key, entry);
      }
      for (const owner of owners) {
        entry.owners.add(owner);
      }
      entry[side] = { output, unit };
    }
  }

  for (const [nativeId, record] of Object.entries(state?.outputs || {})) {
    if (record?.scopeKey === 'user' || (!record?.scopeKey && nativeId.startsWith('user|') && !record?.project)) {
      collect(record, nativeId, 'recorded');
    }
  }
  for (const output of outputs) {
    if (!output.scope || output.scope === 'user') {
      collect(output, outputId(output), 'desired');
    }
  }

  const read = diskReader(issues);
  for (const entry of entries.values()) {
    if (entry === COLLISION) {
      continue;
    }
    const { id, nativeId, location, type, keys, recorded, desired } = entry;
    const disk = read(location, type);
    if (disk.issue === 'unsafe_path') {
      continue;
    }
    let vsApplied = stateKnown && !uncertainRecords.has(nativeId) ? 'unrecorded' : 'unknown';
    let vsCurrent = sourceKnown ? 'not_applicable' : 'unknown';
    const reasons = new Set();
    if (recorded) {
      const actual = diskValue(disk, recorded.output, keys);
      if (actual.issue) {
        vsApplied = 'unknown';
        reasons.add(actual.issue);
      } else if (actual.value === undefined) {
        vsApplied = 'missing';
      } else if (typeof recorded.unit.hash !== 'string' || !(type === 'file' || type === 'block' ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{16}$/).test(recorded.unit.hash)) {
        vsApplied = 'unknown';
        reasons.add('applied_hash_unavailable');
      } else {
        vsApplied = appliedMatches(type, actual, recorded.unit.hash) ? 'ok' : 'modified';
      }
    }
    if (desired) {
      const actual = diskValue(disk, desired.output, keys);
      if (containsMarker(desired.unit.value, secretMarker)) {
        vsCurrent = 'unknown';
        reasons.add('expected_value_unavailable');
      } else if (actual.issue) {
        vsCurrent = 'unknown';
        reasons.add(actual.issue);
      } else {
        vsCurrent = actual.value !== undefined && currentMatches(type, actual, desired.unit.value) ? 'match' : 'different';
      }
    }
    for (const reason of reasons) {
      if (reason !== disk.issue) {
        addCount(issues, reason);
      }
    }
    const probe = JSON.stringify([nativeId, keys]);
    items.push({ id, owners: [...entry.owners].sort(), vsApplied, vsCurrent,
      osOnly: Boolean(desired && commonKnown && commonOutputs && !common.has(probe)),
      localVariable: Boolean(desired && variables.has(probe)) });
  }
  items.sort((a, b) => compareIds(a.id, b.id));
  return { items, issues: Object.keys(issues).sort().map((code) => ({ code, count: issues[code] })), excluded };
}
