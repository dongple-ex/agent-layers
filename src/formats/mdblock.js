export const MARK = 'agent-layers';

const STYLES = {
  html: { open: (tag) => `<!-- ${MARK}:${tag} -->` },
  hash: { open: (tag) => `# ${MARK}:${tag}` },
};

function styleOf(style) {
  return STYLES[style] || STYLES.html;
}

export function beginMarker(id, style = 'html') {
  return styleOf(style).open(`begin ${id}`);
}

export function endMarker(id, style = 'html') {
  return styleOf(style).open(`end ${id}`);
}

export function renderBlock(id, content, style = 'html') {
  return `${beginMarker(id, style)}\n${content.replace(/^\n+/, '').replace(/\n+$/, '')}\n${endMarker(id, style)}`;
}

export function findBlock(text, id, style = 'html') {
  const src = text || '';
  const begin = beginMarker(id, style);
  const end = endMarker(id, style);
  const lines = src.split('\n');
  let offset = 0;
  let start = -1;
  let innerStart = -1;
  for (const line of lines) {
    const trimmed = line.trim();
    if (start < 0 && trimmed === begin) {
      start = offset + line.indexOf(begin);
      innerStart = offset + line.length;
    } else if (start >= 0 && trimmed === end) {
      const e = offset + line.indexOf(end);
      return { start, end: e + end.length, inner: src.slice(innerStart, e) };
    }
    offset += line.length + 1;
  }
  return null;
}

export function getBlockContent(text, id, style = 'html') {
  const f = findBlock(text, id, style);
  if (!f) {
    return null;
  }
  return f.inner.replace(/^\n/, '').replace(/\n$/, '');
}

export function upsertBlock(text, id, content, { position = 'end', style = 'html' } = {}) {
  const block = renderBlock(id, content, style);
  const src = text || '';
  const f = findBlock(src, id, style);
  if (f) {
    return src.slice(0, f.start) + block + src.slice(f.end);
  }
  if (!src.trim()) {
    return `${block}\n`;
  }
  if (position === 'start') {
    return `${block}\n\n${src.replace(/^\n+/, '')}`;
  }
  return `${src.replace(/\n+$/, '')}\n\n${block}\n`;
}

export function removeBlock(text, id, style = 'html') {
  const f = findBlock(text || '', id, style);
  if (!f) {
    return text;
  }
  const before = text.slice(0, f.start).replace(/\n+$/, '');
  const after = text.slice(f.end).replace(/^\n+/, '');
  if (!before) {
    return after;
  }
  if (!after) {
    return `${before}\n`;
  }
  return `${before}\n\n${after}`;
}

export function listBlockIds(text, style = 'html') {
  const ids = [];
  const prefix = style === 'hash' ? `# ${MARK}:begin ` : `<!-- ${MARK}:begin `;
  for (const line of (text || '').split('\n')) {
    const t = line.trim();
    if (t.startsWith(prefix)) {
      ids.push(t.slice(prefix.length).replace(/\s*-->$/, '').trim());
    }
  }
  return ids;
}
