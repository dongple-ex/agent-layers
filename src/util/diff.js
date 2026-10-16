import { c, printable } from './log.js';

export function lineDiff(a, b, { context = 3, maxCells = 4000000 } = {}) {
  const A = (a || '').split('\n');
  const B = (b || '').split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) {
    pre += 1;
  }
  let sa = A.length - 1;
  let sb = B.length - 1;
  while (sa >= pre && sb >= pre && A[sa] === B[sb]) {
    sa -= 1;
    sb -= 1;
  }
  const midA = A.slice(pre, sa + 1);
  const midB = B.slice(pre, sb + 1);
  const ops = [];
  for (let i = 0; i < pre; i += 1) {
    ops.push([' ', A[i]]);
  }
  if (midA.length * midB.length > maxCells) {
    midA.forEach((l) => ops.push(['-', l]));
    midB.forEach((l) => ops.push(['+', l]));
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push([' ', midA[i]]);
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push(['-', midA[i]]);
        i += 1;
      } else {
        ops.push(['+', midB[j]]);
        j += 1;
      }
    }
    while (i < n) {
      ops.push(['-', midA[i]]);
      i += 1;
    }
    while (j < m) {
      ops.push(['+', midB[j]]);
      j += 1;
    }
  }
  for (let i = sa + 1; i < A.length; i += 1) {
    ops.push([' ', A[i]]);
  }
  return hunks(ops, context);
}

function hunks(ops, context) {
  const changed = ops.map((o, i) => (o[0] !== ' ' ? i : -1)).filter((i) => i >= 0);
  if (changed.length === 0) {
    return [];
  }
  const ranges = [];
  for (const idx of changed) {
    const lo = Math.max(0, idx - context);
    const hi = Math.min(ops.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) {
      last[1] = Math.max(last[1], hi);
    } else {
      ranges.push([lo, hi]);
    }
  }
  return ranges.map(([lo, hi]) => ops.slice(lo, hi + 1));
}

export function formatDiff(a, b, { header = '', context = 3 } = {}) {
  const hs = lineDiff(a, b, { context });
  if (hs.length === 0) {
    return '';
  }
  const lines = [];
  if (header) {
    lines.push(c.bold(header));
  }
  for (const h of hs) {
    lines.push(c.cyan('@@'));
    for (const [t, l] of h) {
      if (t === '+') {
        lines.push(c.green(`+${printable(l)}`));
      } else if (t === '-') {
        lines.push(c.red(`-${printable(l)}`));
      } else {
        lines.push(c.gray(` ${printable(l)}`));
      }
    }
  }
  return lines.join('\n');
}
