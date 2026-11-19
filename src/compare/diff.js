import { ADAPTERS } from '../adapters/registry.js';
import { tomlKey } from '../formats/toml.js';
import { compareIds, isSafeName, isSafeSourceId, isShareableName } from './common.js';

const REPORT_FIELDS = ['format', 'schemaVersion', 'scope', 'os', 'agentLayers', 'sourceNow', 'sourceAtApply', 'layers', 'selectedTargets', 'agents', 'items', 'coverage', 'issues', 'excluded'];
const APPLIED = ['ok', 'modified', 'missing', 'unrecorded', 'unknown'];
const CURRENT = ['match', 'different', 'not_applicable', 'unknown'];
const COMPLETE_ITEM_LIST_ISSUES = new Set(['git_unavailable', 'provenance_unavailable', 'detection_unavailable',
  'item_read_failed', 'item_parse_failed', 'ambiguous_block', 'applied_hash_unavailable', 'expected_value_unavailable']);
const INVALID_REPORT = 'Invalid PC comparison report. Expected a user-scope version 1 report with valid, unique entries.';
const INVALID_RESULT = 'Invalid PC comparison result.';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasFields(value, fields) {
  return isRecord(value) && Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
}

function validList(list, valid, keyOf) {
  return Array.isArray(list) && list.every(valid) && (!keyOf || new Set(list.map(keyOf)).size === list.length);
}

function names(list, valid = isShareableName) {
  return validList(list, valid, (name) => name);
}

function validSource(source) {
  return hasFields(source, ['id', 'commit', 'dirty']) && isSafeSourceId(source.id) &&
    (source.commit === null || (typeof source.commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(source.commit))) &&
    (source.dirty === null || typeof source.dirty === 'boolean');
}

function validAgent(agent) {
  return hasFields(agent, ['id', 'detectedBy', 'version', 'runtimeLoad']) && isShareableName(agent.id) &&
    ['command', 'directory', 'both', 'none'].includes(agent.detectedBy) && agent.version === null && agent.runtimeLoad === 'unverified';
}

function validId(id) {
  if (!validList(id, isShareableName) || id.length < 4 || id[0] !== 'user') {
    return false;
  }
  switch (id[2]) {
    case 'mcp': return id.length === 4;
    case 'file': return true;
    case 'block': return id.length >= 5;
    case 'json':
    case 'toml': return /^[1-9][0-9]*$/.test(id[3]) && Number(id[3]) < id.length - 4;
    default: return false;
  }
}

function validItem(item) {
  return hasFields(item, ['id', 'owners', 'vsApplied', 'vsCurrent', 'osOnly', 'localVariable']) && validId(item.id) &&
    names(item.owners, (name) => name === 'git' || isShareableName(name)) && APPLIED.includes(item.vsApplied) && CURRENT.includes(item.vsCurrent) &&
    typeof item.osOnly === 'boolean' && typeof item.localVariable === 'boolean';
}

function positiveCount(count) {
  return Number.isSafeInteger(count) && count > 0;
}

function validIssue(issue) {
  return hasFields(issue, ['code', 'count']) && isSafeName(issue.code) &&
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(issue.code) && positiveCount(issue.count);
}

function validExclusions(excluded) {
  return isRecord(excluded) && Object.entries(excluded).every(([key, count]) => isSafeName(key) &&
    /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(key) && positiveCount(count));
}

export function validateReport(report) {
  if (!hasFields(report, REPORT_FIELDS) || report.format !== 'agent-layers-pc-report' || report.schemaVersion !== 1 ||
      report.scope !== 'user' || !isSafeName(report.os) || !/^[a-z][a-z0-9_-]*$/.test(report.os) ||
      !isSafeName(report.agentLayers) || !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(report.agentLayers) ||
      report.sourceAtApply !== null || !validList(report.sourceNow, validSource, (source) => source.id) ||
      !names(report.layers) || !names(report.selectedTargets) || !validList(report.agents, validAgent, (agent) => agent.id) ||
      !validList(report.items, validItem, (item) => JSON.stringify(item.id)) || !['complete', 'partial'].includes(report.coverage) ||
      !validList(report.issues, validIssue, (issue) => issue.code) || !validExclusions(report.excluded)) {
    throw new Error(INVALID_REPORT);
  }
  return report;
}

function knowledge(report) {
  const codes = new Set(report.issues.map((issue) => issue.code));
  const unspecified = report.coverage === 'partial' && !codes.size;
  const hasSetup = report.sourceNow.some((source) => source.id === 'setup');
  const manifest = !unspecified && !codes.has('source_unavailable');
  const sources = manifest && hasSetup && !codes.has('unsafe_identifier');
  const selection = manifest && !codes.has('selection_unavailable');
  const layers = selection && !codes.has('source_incomplete') && !codes.has('optional_layer_unavailable') && !codes.has('unsafe_identifier');
  const provenance = sources && layers && !codes.has('git_unavailable') && !codes.has('provenance_unavailable');
  const items = !unspecified && [...codes].every((code) => COMPLETE_ITEM_LIST_ISSUES.has(code));
  return { sources, layers, selection, provenance, items };
}

function pairedRows(left, right, idOf) {
  const rows = new Map();
  for (const [side, records] of [['a', left], ['b', right]]) {
    for (const record of records) {
      const id = idOf(record);
      const key = JSON.stringify(id);
      const row = rows.get(key) || { id, a: null, b: null };
      row[side] = record;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((left, right) => compareIds(left.id, right.id));
}

function equalList(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function listDifference(a, b, aKnown, bKnown, ordered) {
  const inA = new Set(a);
  const inB = new Set(b);
  if ((aKnown && b.some((entry) => !inA.has(entry))) || (bKnown && a.some((entry) => !inB.has(entry)))) {
    return true;
  }
  return ordered && !equalList(a.filter((entry) => inB.has(entry)), b.filter((entry) => inA.has(entry)));
}

function sourceState(source) {
  return source && { commit: source.commit?.toLowerCase() ?? null, dirty: source.dirty };
}

function compareContext(a, b, left, right, findings, issues) {
  let sameCleanSource = left.provenance && right.provenance;
  for (const [side, report] of [['A', a], ['B', b]]) {
    if (!report.sourceNow.some((source) => source.id === 'setup')) {
      issues.push({ code: 'source_unverified', count: 1, side, sourceId: 'setup' });
    }
  }
  for (const row of pairedRows(a.sourceNow, b.sourceNow, (source) => [source.id])) {
    const [sourceId] = row.id;
    const aa = sourceState(row.a);
    const bb = sourceState(row.b);
    if ([aa, bb].some((source) => source && (source.commit === null || source.dirty === null)) || (aa?.dirty && bb?.dirty)) {
      issues.push({ code: 'source_contents_unverified', count: 1, sourceId, a: aa, b: bb });
    }
    let different;
    if (aa && bb) {
      const revisionsKnown = aa.commit !== null && bb.commit !== null;
      const dirtyKnown = aa.dirty !== null && bb.dirty !== null;
      different = (revisionsKnown && aa.commit !== bb.commit) || (dirtyKnown && aa.dirty !== bb.dirty);
      sameCleanSource &&= revisionsKnown && aa.commit === bb.commit && aa.dirty === false && bb.dirty === false;
    } else {
      sameCleanSource = false;
      different = sourceId !== 'setup' && (aa ? right.sources : left.sources);
      if (!different && sourceId !== 'setup') {
        issues.push({ code: 'source_unverified', count: 1, side: aa ? 'B' : 'A', sourceId });
      }
    }
    if (different) {
      findings.push({ stage: 'source', field: 'sourceNow', sourceId, a: aa, b: bb });
    }
  }
  if (listDifference(a.layers, b.layers, left.layers, right.layers, true)) {
    findings.push({ stage: 'source', field: 'layers', a: [...a.layers], b: [...b.layers] });
  }
  const selectedA = [...a.selectedTargets].sort();
  const selectedB = [...b.selectedTargets].sort();
  if (listDifference(selectedA, selectedB, left.selection, right.selection, false)) {
    findings.push({ stage: 'selection', field: 'selectedTargets', a: selectedA, b: selectedB });
  }
  return sameCleanSource && equalList(a.layers, b.layers) && left.selection && right.selection && equalList(selectedA, selectedB);
}

function itemState(item, inventoryKnown, withOwners) {
  if (!item) {
    return inventoryKnown ? null : { vsApplied: 'unknown', vsCurrent: 'unknown' };
  }
  const state = { vsApplied: item.vsApplied, vsCurrent: item.vsCurrent };
  if (withOwners) {
    state.owners = [...item.owners].sort();
  }
  return state;
}

function localDrift(item) {
  return item && (item.vsApplied === 'modified' || item.vsApplied === 'missing' || item.vsCurrent === 'different');
}

function knownDifference(a, b) {
  return a !== 'unknown' && b !== 'unknown' && a !== b;
}

function expectedOs(active, inactive, inventoryKnown) {
  return active?.osOnly && active.vsApplied === 'ok' && active.vsCurrent === 'match' &&
    (inactive ? inactive.vsCurrent === 'not_applicable' : inventoryKnown);
}

function compareManaged(row, left, right, allowOsVariation, findings, issues, notes) {
  const { id, a, b } = row;
  const ownersDiffer = a && b && !equalList([...a.owners].sort(), [...b.owners].sort());
  const withOwners = ownersDiffer || a?.owners.length > 1 || b?.owners.length > 1;
  const sides = { id: [...id], a: itemState(a, left.items, withOwners), b: itemState(b, right.items, withOwners) };
  const expectedA = allowOsVariation && expectedOs(a, b, right.items);
  const expectedB = allowOsVariation && expectedOs(b, a, left.items);
  const expected = expectedA || expectedB;
  if (expected) {
    notes.push({ code: 'expected_os_variation', applicable: expectedA ? 'A' : 'B', ...sides });
  }
  let different;
  if (a && b) {
    const knownOwnersDiffer = ownersDiffer && listDifference(a.owners, b.owners, left.items, right.items, false);
    const waiveRecord = (expectedA && b.vsApplied === 'unrecorded') || (expectedB && a.vsApplied === 'unrecorded');
    different = (knownDifference(a.vsApplied, b.vsApplied) && !waiveRecord) ||
      (knownDifference(a.vsCurrent, b.vsCurrent) && !expected) || (knownOwnersDiffer && !waiveRecord);
    if (ownersDiffer && !knownOwnersDiffer) {
      issues.push({ code: 'owners_unverified', count: 1, ...sides });
    }
    if (a.vsApplied === 'unrecorded' && b.vsApplied === 'unrecorded') {
      issues.push({ code: 'apply_record_unverified', count: 1, ...sides });
    }
    if ((a.localVariable || b.localVariable) && a.vsCurrent === 'match' && b.vsCurrent === 'match') {
      issues.push({ code: 'local_variable_unverified', count: 1, ...sides });
    }
  } else {
    different = !expected && (a ? right.items : left.items);
  }
  if ([sides.a, sides.b].some((side) => side && (side.vsApplied === 'unknown' || side.vsCurrent === 'unknown'))) {
    issues.push({ code: 'item_observation_unverified', count: 1, ...sides });
  }
  if (different || localDrift(a) || localDrift(b)) {
    findings.push({ stage: 'managed', ...sides });
  }
  return Boolean(different);
}

function sortedCounts(counts) {
  return Object.fromEntries(Object.keys(counts).sort().map((key) => [key, counts[key]]));
}

export function compareReports(a, b) {
  validateReport(a);
  validateReport(b);
  const left = knowledge(a);
  const right = knowledge(b);
  const findings = [];
  const issues = [];
  const notes = [];
  const excluded = {};
  for (const [side, report] of [['A', a], ['B', b]]) {
    const byCode = [...report.issues].sort((left, right) => compareIds([left.code], [right.code]));
    for (const { code, count } of byCode) {
      issues.push({ side, code, count });
    }
    if (Object.keys(report.excluded).length) {
      excluded[side] = sortedCounts(report.excluded);
    }
  }
  const sameContext = compareContext(a, b, left, right, findings, issues);
  let firstDifference = findings[0]?.stage ?? null;
  const rows = pairedRows(a.items, b.items, (item) => item.id);
  for (const row of rows) {
    if (compareManaged(row, left, right, sameContext && a.os !== b.os, findings, issues, notes)) {
      firstDifference ??= 'managed';
    }
  }
  const coverage = a.coverage === 'partial' || b.coverage === 'partial' || issues.length > 0 ? 'partial' : 'complete';
  if (!rows.length) {
    issues.push({ code: 'no_supported_items', count: 1 });
  }
  let result = 'no_findings';
  if (findings.length) {
    result = 'findings';
  } else if (coverage === 'partial' || !rows.length) {
    result = 'inconclusive';
  }
  const comparison = { schemaVersion: 1, result, coverage, firstDifference, findings, issues, excluded };
  if (notes.length) {
    comparison.notes = notes;
  }
  return comparison;
}

export function resultCode(result) {
  switch (result?.result) {
    case 'no_findings': return 0;
    case 'findings': return 1;
    case 'inconclusive': return 3;
    default: throw new Error(INVALID_RESULT);
  }
}

const ISSUE_TEXT = {
  source_unavailable: 'The current source manifest was unavailable.',
  git_unavailable: 'The current Git revision or working tree status was unavailable.',
  unsafe_identifier: 'Some logical names could not be shared.',
  optional_layer_unavailable: 'An optional layer could not be inspected.',
  source_incomplete: 'Part of the current source could not be inspected.',
  state_unavailable: 'The apply records could not be read.',
  detection_unavailable: 'Tool detection was incomplete.',
  expected_unavailable: 'The current expectation could not be evaluated.',
  expected_value_unavailable: 'A managed value requires a local secret or an external lookup.',
  provenance_unavailable: 'The origin of an expected value could not be verified.',
  selection_unavailable: 'The current target selection was unavailable.',
  source_unverified: 'The source inventory was incomplete.',
  source_contents_unverified: 'The source contents could not be compared from the available Git evidence.',
  apply_record_unverified: 'Neither PC has an apply record for this item.',
  local_variable_unverified: 'The item matches both local expectations. The PC-specific variable values were not compared.',
  item_observation_unverified: 'One or more item observations were unavailable.',
  owners_unverified: 'The list of owners was incomplete.',
  no_supported_items: 'Neither report contains a supported managed item.',
};

function revisionText(source) {
  if (!source) {
    return 'not listed';
  }
  const tree = source.dirty === null ? 'working tree unknown' : source.dirty ? 'dirty' : 'clean';
  return (source.commit ?? 'revision unknown') + ' (' + tree + ')';
}

function keyText(keys, toml) {
  if (toml) {
    return keys.map(tomlKey).join('.');
  }
  return keys.map((key, index) => {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
      return (index ? '.' : '') + key;
    }
    return '[' + JSON.stringify(key) + ']';
  }).join('');
}

function inspectLocation(id) {
  const [, root, kind, ...parts] = id;
  if (kind === 'mcp') {
    const server = ADAPTERS.find((adapter) => adapter.id === root)?.user?.mcp;
    const name = parts[0];
    if (server?.table) {
      return (root === 'codex' ? 'Codex config.toml' : root + ' settings') + ' table ' + keyText([...server.table, name], true);
    }
    if (server?.key) {
      return root + ' settings at ' + keyText([...server.key, name], false);
    }
    return root + ' MCP server ' + name;
  }
  if (kind === 'file') {
    return root + ' file ' + parts.join('/');
  }
  if (kind === 'block') {
    return root + ' file ' + parts.slice(0, -1).join('/') + ', managed block ' + parts.at(-1);
  }
  const pathEnd = 1 + Number(parts[0]);
  return root + ' file ' + parts.slice(1, pathEnd).join('/') + ', ' + kind.toUpperCase() + ' key ' + keyText(parts.slice(pathEnd), kind === 'toml');
}

function inspectSides(row) {
  const names = [];
  for (const [label, side] of [['A', row.a], ['B', row.b]]) {
    if (!side || side.vsApplied !== 'ok' || side.vsCurrent !== 'match') {
      names.push(label);
    }
  }
  return names.length ? names.join(' and ') : 'A and B';
}

export function formatComparison(a, b, result) {
  validateReport(a);
  validateReport(b);
  const lines = [
    'A  ' + a.os + '    B  ' + b.os + '    scope  user',
    'Result  ' + result.result + '    Coverage  ' + result.coverage + '    First difference  ' + (result.firstDifference ?? 'none confirmed'),
  ];
  const rows = new Map();
  for (const finding of result.findings) {
    if (finding.stage === 'managed') {
      rows.set(JSON.stringify(finding.id), finding);
    } else if (finding.field === 'sourceNow') {
      lines.push('Source ' + finding.sourceId + '    A  ' + revisionText(finding.a) + '    B  ' + revisionText(finding.b));
    } else {
      const title = finding.stage === 'selection' ? 'Selected targets' : 'Layers in application order';
      const separator = finding.stage === 'selection' ? ', ' : ' > ';
      lines.push(title + '    A  ' + (finding.a.join(separator) || '(none listed)') + '    B  ' + (finding.b.join(separator) || '(none listed)'));
    }
  }
  for (const entry of [...result.issues, ...(result.notes || [])]) {
    if (entry.id) {
      const key = JSON.stringify(entry.id);
      if (!rows.has(key)) {
        rows.set(key, entry);
      }
    }
  }
  const managed = [...rows.values()].sort((left, right) => compareIds(left.id, right.id));
  if (rows.size) {
    lines.push('', 'Managed item | A vs applied | B vs applied | A vs current | B vs current');
    for (const row of managed) {
      lines.push([row.id.join(' / '), row.a?.vsApplied ?? 'not listed', row.b?.vsApplied ?? 'not listed',
        row.a?.vsCurrent ?? 'not listed', row.b?.vsCurrent ?? 'not listed'].join(' | '));
      if (row.a?.owners || row.b?.owners) {
        lines.push('  Owners    A  ' + (row.a?.owners?.join(', ') || '(none listed)') + '    B  ' + (row.b?.owners?.join(', ') || '(none listed)'));
      }
    }
  }
  for (const row of managed) {
    if (row.code === 'expected_os_variation') {
      continue;
    }
    const where = inspectLocation(row.id);
    lines.push('Inspect ' + inspectSides(row) + ' at ' + where + '.');
    if (localDrift(row.a) && localDrift(row.b) && row.a.vsApplied === row.b.vsApplied && row.a.vsCurrent === row.b.vsCurrent) {
      lines.push('Both PCs show the same local drift status at ' + where + '. The values across PCs are unverified.');
    }
    for (const [label, side, otherLabel, other] of [['A', row.a, 'B', row.b], ['B', row.b, 'A', row.a]]) {
      if (!side || !['ok', 'modified', 'missing'].includes(side.vsApplied)) {
        continue;
      }
      if (!other || other.vsApplied === 'unrecorded') {
        lines.push('Apply record for ' + where + ' is present on ' + label + ' and absent on ' + otherLabel + '.');
      }
      if (side.vsCurrent === 'not_applicable') {
        lines.push(label + ' has an apply record for ' + where + ' and no current expectation.');
      }
    }
  }
  for (const note of result.notes || []) {
    const other = note.applicable === 'A' ? 'B' : 'A';
    lines.push('Expected OS variation for ' + note.id.join(' / ') + '. ' + note.applicable + ' matches its OS-specific expectation and apply record. ' +
      other + ' has no current expectation with the same clean source and target selection.');
  }
  for (const issue of result.issues) {
    const subject = issue.id?.join(' / ') || issue.sourceId;
    const message = ISSUE_TEXT[issue.code];
    lines.push('Unverified ' + (issue.side || 'A/B') + '  ' + issue.code + ' (' + issue.count + ')' +
      (subject ? '  ' + subject : '') + (message ? '  ' + message : ''));
    if (issue.code === 'source_contents_unverified') {
      lines.push('  A  ' + revisionText(issue.a) + '    B  ' + revisionText(issue.b));
    }
  }
  for (const [side, counts] of Object.entries(result.excluded)) {
    lines.push('Excluded ' + side + '  ' + Object.entries(counts).map(([type, count]) => type + ' (' + count + ')').join(', '));
  }
  lines.push('Source revision at last apply and configuration loading in tool sessions are unverified.');
  return lines.join('\n');
}
