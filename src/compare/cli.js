import fs from 'node:fs';
import path from 'node:path';
import { createContext } from '../context.js';
import { error, info } from '../util/log.js';
import { captureReport } from './capture.js';
import { compareReports, formatComparison, resultCode, validateReport } from './diff.js';

function publishReport(target, report) {
  const temp = fs.mkdtempSync(path.join(path.dirname(target), '.agent-layers-compare-'));
  try {
    const file = path.join(temp, 'report.json');
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.linkSync(file, target);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}

function readReport(file) {
  if (!fs.statSync(file).isFile()) {
    throw new Error('Expected a report file.');
  }
  const report = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  validateReport(report);
  return report;
}

function usage() {
  error('Use compare capture --out <new-file> or compare diff <A.json> <B.json> [--json].');
  return 2;
}

export function compareCommand(args, flags, rest, version) {
  const [command, ...inputs] = args;
  const allowed = ['home', 'source', ...(command === 'capture' ? ['out', 'quiet', 'q'] : ['json'])];
  if (rest || Object.keys(flags).some((key) => !allowed.includes(key)) ||
      ['home', 'source', 'out'].some((key) => key in flags && (typeof flags[key] !== 'string' || !flags[key].trim()))) {
    return usage();
  }
  if (command === 'capture' && !inputs.length && flags.out) {
    let report;
    try {
      const ctx = createContext({ home: flags.home && path.resolve(flags.home), source: flags.source && path.resolve(flags.source) });
      report = captureReport(ctx, version);
      validateReport(report);
    } catch {
      error('Could not capture a valid user report. Check the local configuration and read permissions.');
      return 2;
    }
    try {
      publishReport(flags.out, report);
    } catch (err) {
      error(err.code === 'EEXIST' ? 'The output file already exists. Choose a new file.' : 'Could not save the report. Check the output directory and its permissions.');
      return 2;
    }
    info('User comparison report saved.');
    return 0;
  }
  if (command === 'diff' && inputs.length === 2 && (!('json' in flags) || flags.json === true)) {
    const reports = [];
    for (const file of inputs) {
      try {
        reports.push(readReport(file));
      } catch {
        error('Could not read report ' + (reports.length ? 'B' : 'A') + '. Supply a valid user comparison report (schema version 1) with unique IDs.');
        return 2;
      }
    }
    const [a, b] = reports;
    const result = compareReports(a, b);
    info(flags.json ? JSON.stringify(result, null, 2) : formatComparison(a, b, result));
    return resultCode(result);
  }
  return usage();
}
