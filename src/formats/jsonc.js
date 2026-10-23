function skipBlank(text, j) {
  const n = text.length;
  while (j < n) {
    if (/\s/.test(text[j])) {
      j += 1;
    } else if (text[j] === '/' && text[j + 1] === '/') {
      while (j < n && text[j] !== '\n') {
        j += 1;
      }
    } else if (text[j] === '/' && text[j + 1] === '*') {
      const end = text.indexOf('*/', j + 2);
      j = end < 0 ? n : end + 2;
    } else {
      break;
    }
  }
  return j;
}

export function stripJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let inString = false;
  while (i < n) {
    const ch = text[i];
    const nx = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += nx ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && nx === '/') {
      while (i < n && text[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (ch === '/' && nx === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : '';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === ',') {
      const j = skipBlank(text, i + 1);
      if (text[j] === '}' || text[j] === ']') {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function parseJsonc(text, source = 'input') {
  const cleaned = stripJsonc(text.replace(/^﻿/, ''));
  if (!cleaned.trim()) {
    return {};
  }
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`${source}: invalid JSON (${err.message})`);
  }
}

export function stringifyJson(value, indent = 2) {
  return `${JSON.stringify(value, null, indent)}\n`;
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
