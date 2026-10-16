import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BOM = '﻿';
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

export function normalizeEol(text) {
  return text.replace(/\r+\n/g, '\n');
}

export function readText(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return null;
    }
    throw err;
  }
  const bom = raw.startsWith(BOM);
  const body = bom ? raw.slice(1) : raw;
  const eol = /\r\n/.test(body) ? 'crlf' : 'lf';
  return { text: normalizeEol(body), bom, eol };
}

export function readTextOr(file, fallback = '') {
  const r = readText(file);
  return r ? r.text : fallback;
}

export function encodeText(text, { bom = false, eol = 'lf' } = {}) {
  let out = normalizeEol(text);
  if (eol === 'crlf') {
    out = out.replace(/\n/g, '\r\n');
  }
  if (bom) {
    out = BOM + out;
  }
  return out;
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retry(fn, attempts = 8) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!RETRY_CODES.has(err.code)) {
        throw err;
      }
      sleepSync(40 * (i + 1));
    }
  }
  throw lastErr;
}

export function resolveWriteTarget(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      return fs.realpathSync(file);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
  return file;
}

export function tryChmod(p, mode) {
  try {
    fs.chmodSync(p, mode);
    return true;
  } catch {
    return false;
  }
}

export function fileMode(p) {
  try {
    return fs.statSync(p).mode & 0o7777;
  } catch {
    return undefined;
  }
}

function targetMode(target, opts) {
  let mode = null;
  try {
    mode = fs.statSync(target).mode & 0o7777;
  } catch {
    mode = null;
  }
  if (mode === null) {
    return opts.mode !== undefined ? opts.mode & 0o7777 : null;
  }
  if (opts.mode !== undefined) {
    mode |= opts.mode & 0o111;
  }
  return mode;
}

function writeAtomic(file, data, opts) {
  const target = resolveWriteTarget(file);
  const mode = targetMode(target, opts);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.agent-layers.tmp`);
  fs.writeFileSync(tmp, data, mode !== null ? { mode } : undefined);
  if (mode !== null) {
    tryChmod(tmp, mode);
  }
  try {
    retry(() => fs.renameSync(tmp, target));
  } catch (err) {
    try {
      retry(() => fs.copyFileSync(tmp, target));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return target;
}

export function writeTextAtomic(file, text, opts = {}) {
  return writeAtomic(file, encodeText(text, opts), opts);
}

export function writeBytesAtomic(file, buffer, opts = {}) {
  return writeAtomic(file, buffer, opts);
}

export function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function removePath(p) {
  retry(() => fs.rmSync(p, { recursive: true, force: true }));
}

export function listFiles(dir, { recursive = true } = {}) {
  const out = [];
  if (!isDir(dir)) {
    return out;
  }
  const walk = (abs, rel) => {
    const entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (recursive) {
          walk(childAbs, childRel);
        }
      } else if (e.isFile() || e.isSymbolicLink()) {
        out.push({ abs: childAbs, rel: childRel, link: e.isSymbolicLink() });
      }
    }
  };
  walk(dir, '');
  return out;
}

export function listDirs(dir) {
  if (!isDir(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export function sha256(data) {
  return crypto.createHash('sha256').update(typeof data === 'string' ? normalizeEol(data) : data).digest('hex');
}

export function hashFiles(files) {
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    h.update(f.rel);
    h.update('\0');
    h.update(typeof f.content === 'string' ? normalizeEol(f.content) : f.content);
    h.update('\0');
  }
  return h.digest('hex');
}

export function readDirSnapshot(dir) {
  return listFiles(dir).map((f) => {
    const buf = fs.readFileSync(f.abs);
    return { rel: f.rel, content: isProbablyText(buf) ? normalizeEol(buf.toString('utf8').replace(/^﻿/, '')) : buf };
  });
}

export function isProbablyText(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) {
    if (buf[i] === 0) {
      return false;
    }
  }
  return true;
}

export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
