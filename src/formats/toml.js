export class TomlError extends Error {
  constructor(message, line) {
    super(`TOML: ${message} (line ${line + 1})`);
    this.line = line;
  }
}

export class TomlRaw {
  constructor(raw) {
    this.raw = raw;
  }

  toJSON() {
    return this.raw;
  }

  toString() {
    return this.raw;
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const KIND = Symbol('tomlKind');

function mark(obj, kind) {
  Object.defineProperty(obj, KIND, { value: kind, writable: true, enumerable: false, configurable: true });
  return obj;
}

function kindOf(obj) {
  return obj && typeof obj === 'object' ? obj[KIND] : undefined;
}

function isTable(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof TomlRaw);
}

class Parser {
  constructor(src) {
    this.s = src;
    this.i = 0;
    this.line = 0;
  }

  eof() {
    return this.i >= this.s.length;
  }

  peek(o = 0) {
    return this.s[this.i + o];
  }

  startsWith(str) {
    return this.s.startsWith(str, this.i);
  }

  advance(n = 1) {
    for (let k = 0; k < n; k += 1) {
      if (this.s[this.i] === '\n') {
        this.line += 1;
      }
      this.i += 1;
    }
  }

  fail(msg) {
    throw new TomlError(msg, this.line);
  }

  skipWs() {
    while (!this.eof() && (this.peek() === ' ' || this.peek() === '\t')) {
      this.i += 1;
    }
  }

  skipComment() {
    if (this.peek() === '#') {
      while (!this.eof() && this.peek() !== '\n') {
        this.i += 1;
      }
    }
  }

  skipWsCommentsNewlines() {
    for (;;) {
      this.skipWs();
      this.skipComment();
      if (this.peek() === '\n') {
        this.advance();
        continue;
      }
      if (this.peek() === '\r' && this.peek(1) === '\n') {
        this.advance(2);
        continue;
      }
      break;
    }
  }

  endOfLine() {
    this.skipWs();
    this.skipComment();
    if (this.eof()) {
      return;
    }
    if (this.peek() === '\r' && this.peek(1) === '\n') {
      this.advance(2);
      return;
    }
    if (this.peek() === '\n') {
      this.advance();
      return;
    }
    this.fail(`unexpected character '${this.peek()}' after value`);
  }

  simpleKey() {
    const ch = this.peek();
    if (ch === '"') {
      if (this.startsWith('"""')) {
        this.fail('multi-line string is not allowed as a key');
      }
      return this.basicString();
    }
    if (ch === "'") {
      if (this.startsWith("'''")) {
        this.fail('multi-line string is not allowed as a key');
      }
      return this.literalString();
    }
    const start = this.i;
    while (!this.eof() && /[A-Za-z0-9_-]/.test(this.peek())) {
      this.i += 1;
    }
    if (this.i === start) {
      this.fail(`invalid key character '${ch ?? 'EOF'}'`);
    }
    return this.s.slice(start, this.i);
  }

  key() {
    const parts = [this.simpleKey()];
    for (;;) {
      this.skipWs();
      if (this.peek() !== '.') {
        break;
      }
      this.i += 1;
      this.skipWs();
      parts.push(this.simpleKey());
    }
    if (parts.includes('__proto__')) {
      this.fail("key '__proto__' is not supported");
    }
    return parts;
  }

  escape() {
    const ch = this.peek();
    this.i += 1;
    switch (ch) {
      case 'b':
        return '\b';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'f':
        return '\f';
      case 'r':
        return '\r';
      case 'e':
        return '\u001b';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'x': {
        const hex = this.s.slice(this.i, this.i + 2);
        this.i += 2;
        return String.fromCodePoint(parseInt(hex, 16));
      }
      case 'u': {
        const hex = this.s.slice(this.i, this.i + 4);
        this.i += 4;
        return String.fromCodePoint(parseInt(hex, 16));
      }
      case 'U': {
        const hex = this.s.slice(this.i, this.i + 8);
        this.i += 8;
        return String.fromCodePoint(parseInt(hex, 16));
      }
      default:
        this.fail(`invalid escape '\\${ch}'`);
    }
    return '';
  }

  basicString() {
    this.i += 1;
    let out = '';
    for (;;) {
      if (this.eof() || this.peek() === '\n') {
        this.fail('unterminated string');
      }
      const ch = this.peek();
      if (ch === '"') {
        this.i += 1;
        return out;
      }
      if (ch === '\\') {
        this.i += 1;
        out += this.escape();
        continue;
      }
      out += ch;
      this.i += 1;
    }
  }

  literalString() {
    this.i += 1;
    const start = this.i;
    while (!this.eof() && this.peek() !== "'" && this.peek() !== '\n') {
      this.i += 1;
    }
    if (this.peek() !== "'") {
      this.fail('unterminated literal string');
    }
    const v = this.s.slice(start, this.i);
    this.i += 1;
    return v;
  }

  mlBasicString() {
    this.advance(3);
    if (this.peek() === '\n') {
      this.advance();
    } else if (this.peek() === '\r' && this.peek(1) === '\n') {
      this.advance(2);
    }
    let out = '';
    for (;;) {
      if (this.eof()) {
        this.fail('unterminated multi-line string');
      }
      if (this.startsWith('"""')) {
        let extra = 0;
        while (this.peek(3 + extra) === '"' && extra < 2) {
          extra += 1;
        }
        out += '"'.repeat(extra);
        this.advance(3 + extra);
        return out;
      }
      const ch = this.peek();
      if (ch === '\\') {
        const save = this.i;
        this.i += 1;
        let j = this.i;
        while (this.s[j] === ' ' || this.s[j] === '\t') {
          j += 1;
        }
        if (this.s[j] === '\n' || (this.s[j] === '\r' && this.s[j + 1] === '\n')) {
          this.i = j;
          while (!this.eof() && /[ \t\r\n]/.test(this.peek())) {
            this.advance();
          }
          continue;
        }
        this.i = save + 1;
        out += this.escape();
        continue;
      }
      out += ch;
      this.advance();
    }
  }

  mlLiteralString() {
    this.advance(3);
    if (this.peek() === '\n') {
      this.advance();
    } else if (this.peek() === '\r' && this.peek(1) === '\n') {
      this.advance(2);
    }
    let out = '';
    for (;;) {
      if (this.eof()) {
        this.fail('unterminated multi-line literal string');
      }
      if (this.startsWith("'''")) {
        let extra = 0;
        while (this.peek(3 + extra) === "'" && extra < 2) {
          extra += 1;
        }
        out += "'".repeat(extra);
        this.advance(3 + extra);
        return out;
      }
      out += this.peek();
      this.advance();
    }
  }

  array() {
    this.advance();
    const arr = [];
    for (;;) {
      this.skipWsCommentsNewlines();
      if (this.peek() === ']') {
        this.advance();
        return arr;
      }
      arr.push(this.value());
      this.skipWsCommentsNewlines();
      if (this.peek() === ',') {
        this.advance();
        continue;
      }
      if (this.peek() === ']') {
        this.advance();
        return arr;
      }
      this.fail('expected , or ] in array');
    }
  }

  inlineTable() {
    this.advance();
    const obj = mark({}, 'inline');
    this.skipWsCommentsNewlines();
    if (this.peek() === '}') {
      this.advance();
      return obj;
    }
    for (;;) {
      this.skipWsCommentsNewlines();
      const parts = this.key();
      this.skipWs();
      if (this.peek() !== '=') {
        this.fail('expected = in inline table');
      }
      this.advance();
      this.skipWs();
      const v = this.value();
      assignDotted(obj, parts, v, this, 'inline');
      this.skipWsCommentsNewlines();
      if (this.peek() === ',') {
        this.advance();
        this.skipWsCommentsNewlines();
        if (this.peek() === '}') {
          this.advance();
          return obj;
        }
        continue;
      }
      if (this.peek() === '}') {
        this.advance();
        return obj;
      }
      this.fail('expected , or } in inline table');
    }
  }

  scalarToken() {
    const start = this.i;
    while (!this.eof() && !/[\s,\]}#]/.test(this.peek())) {
      this.i += 1;
    }
    let tok = this.s.slice(start, this.i);
    if (/^\d{4}-\d{2}-\d{2}$/.test(tok) && this.peek() === ' ' && /^\d{2}:\d{2}/.test(this.s.slice(this.i + 1, this.i + 6))) {
      this.i += 1;
      while (!this.eof() && !/[\s,\]}#]/.test(this.peek())) {
        this.i += 1;
      }
      tok = this.s.slice(start, this.i);
    }
    return tok;
  }

  value() {
    const ch = this.peek();
    if (ch === undefined) {
      this.fail('expected a value');
    }
    if (ch === '"') {
      return this.startsWith('"""') ? this.mlBasicString() : this.basicString();
    }
    if (ch === "'") {
      return this.startsWith("'''") ? this.mlLiteralString() : this.literalString();
    }
    if (ch === '[') {
      return this.array();
    }
    if (ch === '{') {
      return this.inlineTable();
    }
    const tok = this.scalarToken();
    if (tok === 'true') {
      return true;
    }
    if (tok === 'false') {
      return false;
    }
    if (/^[+-]?(inf|nan)$/.test(tok)) {
      return tok.endsWith('nan') ? NaN : tok.startsWith('-') ? -Infinity : Infinity;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(tok) || /^\d{2}:\d{2}(:\d{2})?/.test(tok)) {
      return new TomlRaw(tok);
    }
    if (/^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$/.test(tok)) {
      return parseInt(tok.slice(2).replace(/_/g, ''), 16);
    }
    if (/^0o[0-7](_?[0-7])*$/.test(tok)) {
      return parseInt(tok.slice(2).replace(/_/g, ''), 8);
    }
    if (/^0b[01](_?[01])*$/.test(tok)) {
      return parseInt(tok.slice(2).replace(/_/g, ''), 2);
    }
    if (/^[+-]?(0|[1-9](_?\d)*)$/.test(tok)) {
      return Number(tok.replace(/_/g, ''));
    }
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(tok) && /[.eE]/.test(tok)) {
      return Number(tok.replace(/_/g, ''));
    }
    this.fail(`invalid value '${tok || ch}'`);
    return undefined;
  }
}

function assignDotted(target, parts, value, parser, context) {
  let cur = target;
  for (let k = 0; k < parts.length - 1; k += 1) {
    const p = parts[k];
    if (cur[p] === undefined) {
      cur[p] = mark({}, context === 'inline' ? 'inline' : 'dotted');
    } else if (!isTable(cur[p])) {
      parser.fail(`key '${parts.slice(0, k + 1).join('.')}' is already defined as a value`);
    } else if (kindOf(cur[p]) === 'inline' && context !== 'inline') {
      parser.fail(`cannot extend inline table '${parts.slice(0, k + 1).join('.')}'`);
    }
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (Object.prototype.hasOwnProperty.call(cur, last)) {
    parser.fail(`duplicate key '${parts.join('.')}'`);
  }
  cur[last] = value;
}

function navigateTable(root, parts, parser) {
  let cur = root;
  for (let k = 0; k < parts.length; k += 1) {
    const p = parts[k];
    const isLast = k === parts.length - 1;
    let next = cur[p];
    if (next === undefined) {
      next = mark({}, isLast ? 'explicit' : 'implicit');
      cur[p] = next;
    } else if (Array.isArray(next)) {
      if (isLast) {
        parser.fail(`table '${parts.join('.')}' conflicts with an array of tables`);
      }
      next = next[next.length - 1];
      if (!isTable(next)) {
        parser.fail(`'${parts.slice(0, k + 1).join('.')}' is not a table`);
      }
    } else if (!isTable(next)) {
      parser.fail(`'${parts.slice(0, k + 1).join('.')}' is already defined as a value`);
    } else if (isLast) {
      const kind = kindOf(next);
      if (kind === 'explicit') {
        parser.fail(`duplicate table [${parts.join('.')}]`);
      }
      if (kind === 'inline') {
        parser.fail(`cannot redefine inline table [${parts.join('.')}]`);
      }
      if (kind === 'dotted') {
        parser.fail(`table [${parts.join('.')}] was already defined with dotted keys`);
      }
      mark(next, 'explicit');
    }
    cur = next;
  }
  return cur;
}

export function parseToml(text) {
  const src = text.replace(/^﻿/, '').replace(/\r+\n/g, '\n');
  const p = new Parser(src);
  const root = mark({}, 'root');
  let current = root;
  let currentPath = [];
  let inArrayTable = false;
  const entries = [];
  for (;;) {
    p.skipWsCommentsNewlines();
    if (p.eof()) {
      break;
    }
    const startLine = p.line;
    if (p.peek() === '[') {
      if (p.peek(1) === '[') {
        p.advance(2);
        p.skipWs();
        const parts = p.key();
        p.skipWs();
        if (!p.startsWith(']]')) {
          p.fail('expected ]] to close array table header');
        }
        p.advance(2);
        p.endOfLine();
        let parent = root;
        if (parts.length > 1) {
          parent = navigateTableLoose(root, parts.slice(0, -1), p);
        }
        const last = parts[parts.length - 1];
        if (parent[last] === undefined) {
          parent[last] = [];
        } else if (!Array.isArray(parent[last])) {
          p.fail(`[[${parts.join('.')}]] conflicts with an existing key`);
        }
        const obj = mark({}, 'explicit');
        parent[last].push(obj);
        current = obj;
        currentPath = parts;
        inArrayTable = true;
        entries.push({ type: 'arrayTable', path: parts, startLine, endLine: startLine });
        continue;
      }
      p.advance();
      p.skipWs();
      const parts = p.key();
      p.skipWs();
      if (p.peek() !== ']') {
        p.fail('expected ] to close table header');
      }
      p.advance();
      p.endOfLine();
      current = navigateTable(root, parts, p);
      currentPath = parts;
      inArrayTable = false;
      entries.push({ type: 'table', path: parts, startLine, endLine: startLine });
      continue;
    }
    const keyStart = p.i;
    const parts = p.key();
    const keyRaw = src.slice(keyStart, p.i);
    p.skipWs();
    if (p.peek() !== '=') {
      p.fail(`expected = after key '${parts.join('.')}'`);
    }
    p.advance();
    p.skipWs();
    const value = p.value();
    const endLine = p.line;
    p.endOfLine();
    assignDotted(current, parts, value, p, 'kv');
    entries.push({ type: 'kv', tablePath: currentPath, keyPath: parts, keyRaw, startLine, endLine, inArrayTable });
  }
  return { value: root, entries };
}

function navigateTableLoose(root, parts, parser) {
  let cur = root;
  for (let k = 0; k < parts.length; k += 1) {
    const p = parts[k];
    let next = cur[p];
    if (next === undefined) {
      next = mark({}, 'implicit');
      cur[p] = next;
    } else if (Array.isArray(next)) {
      next = next[next.length - 1];
    } else if (!isTable(next)) {
      parser.fail(`'${parts.slice(0, k + 1).join('.')}' is not a table`);
    }
    cur = next;
  }
  return cur;
}

export function toPlain(v) {
  if (v instanceof TomlRaw) {
    return v.raw;
  }
  if (Array.isArray(v)) {
    return v.map(toPlain);
  }
  if (isTable(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = toPlain(x);
    }
    return out;
  }
  return v;
}

export function parseTomlValue(text) {
  return toPlain(parseToml(text).value);
}

export function tomlKey(k) {
  return BARE_KEY.test(k) ? k : tomlBasicString(k);
}

export function tomlBasicString(s) {
  let out = '"';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (ch === '\\') {
      out += '\\\\';
    } else if (ch === '"') {
      out += '\\"';
    } else if (ch === '\n') {
      out += '\\n';
    } else if (ch === '\t') {
      out += '\\t';
    } else if (ch === '\r') {
      out += '\\r';
    } else if (ch === '\b') {
      out += '\\b';
    } else if (ch === '\f') {
      out += '\\f';
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

export function tomlString(s) {
  const str = String(s);
  if (str.includes('\\') && !/['\u0000-\u001f\u007f]/.test(str)) {
    return `'${str}'`;
  }
  return tomlBasicString(str);
}

export function tomlValue(v) {
  if (v instanceof TomlRaw) {
    return v.raw;
  }
  if (typeof v === 'string') {
    return tomlString(v);
  }
  if (typeof v === 'boolean') {
    return v ? 'true' : 'false';
  }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) {
      return 'nan';
    }
    if (!Number.isFinite(v)) {
      return v > 0 ? 'inf' : '-inf';
    }
    return String(v);
  }
  if (Array.isArray(v)) {
    return `[${v.map(tomlValue).join(', ')}]`;
  }
  if (v && typeof v === 'object') {
    const parts = Object.entries(v).filter(([, x]) => x !== undefined && x !== null).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`);
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  throw new Error(`cannot represent ${v === null ? 'null' : typeof v} in TOML`);
}

const eqPath = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const startsWithPath = (a, prefix) => prefix.length <= a.length && prefix.every((x, i) => x === a[i]);

export class TomlDocument {
  constructor(text = '') {
    const normalized = text.replace(/^﻿/, '').replace(/\r+\n/g, '\n');
    this.lines = normalized.length ? normalized.replace(/\n$/, '').split('\n') : [];
    this.reparse();
  }

  reparse() {
    const r = parseToml(this.toString());
    this.value = r.value;
    this.entries = r.entries;
  }

  toString() {
    if (this.lines.length === 0) {
      return '';
    }
    return `${this.lines.join('\n').replace(/\n+$/, '')}\n`;
  }

  get plain() {
    return toPlain(this.value);
  }

  headers() {
    return this.entries.filter((e) => e.type === 'table' || e.type === 'arrayTable');
  }

  attachedCommentStart(headerLine) {
    let k = headerLine;
    while (k > 0 && this.lines[k - 1].trim().startsWith('#')) {
      k -= 1;
    }
    return k;
  }

  sectionEnd(headerIndexInLines) {
    const next = this.headers().find((h) => h.startLine > headerIndexInLines);
    return next ? Math.max(headerIndexInLines + 1, this.attachedCommentStart(next.startLine)) : this.lines.length;
  }

  rootEnd() {
    const first = this.headers()[0];
    return first ? this.attachedCommentStart(first.startLine) : this.lines.length;
  }

  lastContentLine(from, to) {
    let last = from;
    for (let k = from; k < to; k += 1) {
      if (this.lines[k].trim() !== '') {
        last = k + 1;
      }
    }
    return last;
  }

  findKv(fullPath) {
    return this.entries.find((e) => e.type === 'kv' && !e.inArrayTable && eqPath([...e.tablePath, ...e.keyPath], fullPath));
  }

  findTableHeader(path) {
    return this.entries.find((e) => e.type === 'table' && eqPath(e.path, path));
  }

  getValue(fullPath) {
    let cur = this.plain;
    for (const p of fullPath) {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !(p in cur)) {
        return undefined;
      }
      cur = cur[p];
    }
    return cur;
  }

  replaceLines(start, end, newLines) {
    this.lines.splice(start, end - start + 1, ...newLines);
  }

  insertLines(at, newLines) {
    this.lines.splice(at, 0, ...newLines);
  }

  set(fullPath, value) {
    if (fullPath.length === 0) {
      throw new Error('empty TOML key path');
    }
    const text = tomlValue(value);
    const kv = this.findKv(fullPath);
    if (kv) {
      const first = this.lines[kv.startLine];
      const indent = first.slice(0, first.length - first.trimStart().length);
      this.replaceLines(kv.startLine, kv.endLine, [`${indent}${kv.keyRaw.trim()} = ${text}`]);
      this.reparse();
      return 'updated';
    }
    const parent = fullPath.slice(0, -1);
    const leaf = fullPath[fullPath.length - 1];
    const parentKv = parent.length ? this.findKv(parent) : null;
    if (parentKv) {
      const existing = this.getValue(parent);
      if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        return this.set(parent, { ...existing, [leaf]: value });
      }
      throw new Error(`cannot set ${fullPath.join('.')}: ${parent.join('.')} is not a table`);
    }
    const dottedHost = this.findDottedHost(parent);
    if (dottedHost) {
      const rel = [...parent.slice(dottedHost.path.length), leaf].map(tomlKey).join('.');
      const end = dottedHost.path.length === 0 ? this.rootEnd() : this.sectionEnd(dottedHost.headerLine);
      const at = this.lastContentLine(dottedHost.path.length === 0 ? 0 : dottedHost.headerLine + 1, end);
      this.insertLines(Math.max(at, dottedHost.path.length === 0 ? 0 : dottedHost.headerLine + 1), [`${rel} = ${text}`]);
      this.reparse();
      return 'added';
    }
    if (parent.length === 0) {
      const end = this.rootEnd();
      const at = this.lastContentLine(0, end);
      const newLines = [`${tomlKey(leaf)} = ${text}`];
      if (at === end && end < this.lines.length && end > 0) {
        newLines.push('');
      } else if (end < this.lines.length && at === 0) {
        newLines.push('');
      }
      this.insertLines(at, newLines);
      this.reparse();
      return 'added';
    }
    const header = this.findTableHeader(parent);
    if (header) {
      const end = this.sectionEnd(header.startLine);
      const at = this.lastContentLine(header.startLine + 1, end);
      this.insertLines(Math.max(at, header.startLine + 1), [`${tomlKey(leaf)} = ${text}`]);
      this.reparse();
      return 'added';
    }
    this.appendSection([`[${parent.map(tomlKey).join('.')}]`, `${tomlKey(leaf)} = ${text}`]);
    this.reparse();
    return 'added';
  }

  findDottedHost(parentPath) {
    if (parentPath.length === 0) {
      return null;
    }
    const candidates = [{ path: [], headerLine: -1 }, ...this.entries.filter((e) => e.type === 'table').map((h) => ({ path: h.path, headerLine: h.startLine }))];
    let best = null;
    for (const cand of candidates) {
      if (!startsWithPath(parentPath, cand.path) || cand.path.length === parentPath.length) {
        continue;
      }
      const rel = parentPath.slice(cand.path.length);
      const defines = this.entries.some((e) => e.type === 'kv' && !e.inArrayTable && eqPath(e.tablePath, cand.path) && e.keyPath.length > rel.length && startsWithPath(e.keyPath, rel));
      if (defines && (!best || cand.path.length > best.path.length)) {
        best = cand;
      }
    }
    return best;
  }

  appendSection(lines) {
    while (this.lines.length && this.lines[this.lines.length - 1].trim() === '') {
      this.lines.pop();
    }
    if (this.lines.length) {
      this.lines.push('');
    }
    this.lines.push(...lines);
  }

  remove(fullPath) {
    const kv = this.findKv(fullPath);
    if (kv) {
      this.replaceLines(kv.startLine, kv.endLine, []);
      this.reparse();
      return true;
    }
    const parent = fullPath.slice(0, -1);
    const leaf = fullPath[fullPath.length - 1];
    const parentKv = parent.length ? this.findKv(parent) : null;
    if (parentKv) {
      const existing = this.getValue(parent);
      if (existing && typeof existing === 'object' && !Array.isArray(existing) && leaf in existing) {
        const next = { ...existing };
        delete next[leaf];
        this.set(parent, next);
        return true;
      }
    }
    return false;
  }

  hasTable(path) {
    const v = this.getValue(path);
    return v !== undefined;
  }

  removeTable(path) {
    let changed = false;
    for (;;) {
      const header = this.entries.find((e) => (e.type === 'table' || e.type === 'arrayTable') && startsWithPath(e.path, path));
      if (!header) {
        break;
      }
      const end = this.sectionEnd(header.startLine);
      let start = header.startLine;
      while (start > 0 && this.lines[start - 1].trim() === '') {
        start -= 1;
      }
      this.lines.splice(start, end - start);
      if (start > 0 && start < this.lines.length && this.lines[start].trim() !== '' && this.lines[start - 1].trim() !== '') {
        this.lines.splice(start, 0, '');
      }
      this.reparse();
      changed = true;
    }
    for (;;) {
      const kv = this.entries.find((e) => e.type === 'kv' && !e.inArrayTable && startsWithPath([...e.tablePath, ...e.keyPath], path));
      if (!kv) {
        break;
      }
      this.replaceLines(kv.startLine, kv.endLine, []);
      this.reparse();
      changed = true;
    }
    return changed;
  }

  setTable(path, obj) {
    const header = this.findTableHeader(path);
    const lines = [`[${path.map(tomlKey).join('.')}]`];
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) {
        continue;
      }
      lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
    }
    if (header && !this.entries.some((e) => e.type === 'table' && e.path.length > path.length && startsWithPath(e.path, path))) {
      const end = this.sectionEnd(header.startLine);
      const last = this.lastContentLine(header.startLine + 1, end);
      this.lines.splice(header.startLine, Math.max(last, header.startLine + 1) - header.startLine, ...lines);
      this.reparse();
      return 'updated';
    }
    const existed = this.removeTable(path);
    this.appendSection(lines);
    this.reparse();
    return existed ? 'updated' : 'added';
  }
}
