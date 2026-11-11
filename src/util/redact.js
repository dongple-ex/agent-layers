export const SECRET_KEY = /(pass(word)?|pwd|secret|token|api[_-]?key|private[_-]?key|credential)/i;
export const REFERENCE = /^\$\{[^}]+\}$|^\$[A-Za-z_][A-Za-z0-9_]*$|^\{env:[^}]+\}$|^@@secret:/;

export const AUTH_NAME = /(?:^|[_-])auth(?:orization)?$|^cookie$/i;
export const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:"'${}]*:)(?!\$\{|\{\{)([^\s/?#@"']+)(?=@)/i;
export const URL_QUERY_SECRET = /([a-z][a-z0-9+.-]*:\/\/[^\s"']*?[?&]((?:[a-z0-9_.-]*(?:api[_-]?key|token|secret|passw(?:or)?d|signature|credential)|key|sig|auth))=)(?!\$\{|\{\{)([^&#\s"']+)/i;

const ASSIGNMENT = /([A-Za-z0-9_.-]+)(?:\\?["'])?[ \t]*[:=][ \t]*/g;
const LITERAL = /^(true|false|null)$/;
const PAT_NAME = /(?:^|[_-])pat$/i;
const AUTH_SCHEME = /^[A-Za-z][A-Za-z0-9_-]* /;
const CHANGE_LINE = /^([ \t]*~ [^\r\n]*?([A-Za-z0-9_.-]+): )([^\r\n]*)/gm;
const ARROW = ' -> ';
const URL_PASSWORD_ALL = new RegExp(URL_PASSWORD.source, 'gi');
const URL_QUERY_REST = new RegExp(`${URL_QUERY_SECRET.source}[^\\s"'\\\\]*`, 'gi');

function secretName(name) {
  const leaf = name.slice(name.lastIndexOf('.') + 1);
  return SECRET_KEY.test(name) || AUTH_NAME.test(leaf) || PAT_NAME.test(leaf);
}

function readable(value) {
  return !value || value === '***' || LITERAL.test(value) || REFERENCE.test(value) || REFERENCE.test(value.replace(AUTH_SCHEME, ''));
}

function maskQuoted(side) {
  if (!side.startsWith('"')) {
    return side;
  }
  const inner = side.length > 1 && side.endsWith('"') ? side.slice(1, -1) : side.slice(1);
  return readable(inner) ? side : '"***"';
}

function maskChangedValues(text) {
  return text.replace(CHANGE_LINE, (line, head, name, rest) => {
    const at = rest.indexOf(ARROW);
    if (at < 0 || !secretName(name)) {
      return line;
    }
    return `${head}${maskQuoted(rest.slice(0, at))}${ARROW}${maskQuoted(rest.slice(at + ARROW.length))}`;
  });
}

function lineEnd(s, from) {
  const i = s.indexOf('\n', from);
  return i < 0 ? s.length : i;
}

function valueSpan(s, from) {
  const eol = lineEnd(s, from);
  if (s.startsWith('\\"', from)) {
    const end = s.indexOf('\\"', from + 2);
    return { from: from + 2, to: end < 0 || end > eol ? eol : end };
  }
  const q = s[from];
  if (q === '"' || q === "'") {
    let i = from + 1;
    while (i < eol && s[i] !== q) {
      i += q === '"' && s[i] === '\\' ? 2 : 1;
    }
    return { from: from + 1, to: Math.min(i, eol) };
  }
  let i = from;
  while (i < eol && !/[\s,;}\]"'\\]/.test(s[i])) {
    i += 1;
  }
  return { from, to: i };
}

export function maskSecretFields(text) {
  const s = maskChangedValues(String(text));
  let out = '';
  let last = 0;
  ASSIGNMENT.lastIndex = 0;
  let m;
  while ((m = ASSIGNMENT.exec(s)) !== null) {
    if (!secretName(m[1])) {
      continue;
    }
    if (/^(secret|env)$/i.test(m[1]) && /[{@]/.test(s[m.index - 1] || '')) {
      continue;
    }
    const span = valueSpan(s, m.index + m[0].length);
    const value = s.slice(span.from, span.to);
    ASSIGNMENT.lastIndex = Math.max(ASSIGNMENT.lastIndex, span.to);
    if (readable(value)) {
      continue;
    }
    out += `${s.slice(last, span.from)}***`;
    last = span.to;
  }
  return (out + s.slice(last)).replace(URL_PASSWORD_ALL, '$1***').replace(URL_QUERY_REST, '$1***');
}
