const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

export function printable(s) {
  return String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

let quiet = false;

export function setQuiet(v) {
  quiet = Boolean(v);
}

export function info(msg = '') {
  if (!quiet) {
    process.stdout.write(`${msg}\n`);
  }
}

export function warn(msg) {
  process.stderr.write(`${c.yellow('warning')} ${msg}\n`);
}

export function error(msg) {
  process.stderr.write(`${c.red('error')} ${msg}\n`);
}

export function table(rows, headers) {
  const all = headers ? [headers, ...rows] : rows;
  const plain = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');
  const widths = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, plain(cell).length);
    });
  }
  const fmt = (row) => row.map((cell, i) => (i === row.length - 1 ? String(cell) : String(cell) + ' '.repeat(widths[i] - plain(cell).length))).join('  ');
  const lines = [];
  if (headers) {
    lines.push(c.bold(fmt(headers)));
  }
  for (const row of rows) {
    lines.push(fmt(row));
  }
  info(lines.join('\n'));
}

export function mask(value) {
  if (!value) {
    return '';
  }
  const s = String(value);
  if (s.length <= 4) {
    return '****';
  }
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(12, s.length - 4))}${s.slice(-2)}`;
}
