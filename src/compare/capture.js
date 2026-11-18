import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadManifest } from '../manifest.js';
import { loadUserLayers, mergeLayers, osTagOf } from '../layers.js';
import { buildVars, detectAdapters, renderScope, resolveTargets } from '../render.js';
import { loadState } from '../state.js';
import { findSecretRefs } from '../template.js';
import { unknownTargetIssues } from '../validate.js';
import { sourceRevision } from './source.js';
import { isPlainObject } from '../formats/jsonmerge.js';
import { observeItems, shareableName } from './items.js';
import { addCount, isSafeName } from './common.js';

function removeOsEntries(layer) {
  const common = (entry) => !osTagOf(path.basename(entry.file || entry.abs));
  const result = { ...layer };
  for (const key of ['instructions', 'commands', 'agents', 'mcp', 'forget']) {
    result[key] = layer[key].filter(common);
  }
  for (const key of ['settings', 'files']) {
    result[key] = Object.fromEntries(Object.entries(layer[key]).map(([id, entries]) => [id, entries.filter(common)]));
  }
  return result;
}

function markLocalVariables(value, marker) {
  if (Array.isArray(value)) {
    return value.length ? value.map((item) => markLocalVariables(item, marker)) : marker;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, markLocalVariables(v, marker)]));
  }
  return marker;
}

function sourceExpectations(ctx, manifest, layers, adapters, observed, issues) {
  const screenshotPath = ctx.os === 'macos' && !ctx.sandbox ? observed.secretMarker : undefined;
  const render = (renderCtx, merged) => renderScope(renderCtx, {
    scope: 'user', manifest, merged, adapters,
    vars: buildVars(renderCtx, manifest, null, null, { screenshotPath }),
    resolveSecret: () => observed.secretMarker,
  });
  const merged = mergeLayers(layers);
  if (layers.some((layer) => unknownTargetIssues(layer).length)) {
    addCount(issues, 'expected_unavailable');
    return;
  }
  const actual = render(ctx, merged);
  observed.outputs = actual.outputs;
  observed.forget = actual.forget;
  observed.sourceKnown = !actual.notes.some((note) => note.level === 'error');
  if (!observed.sourceKnown) {
    addCount(issues, 'source_incomplete');
  }
  try {
    observed.commonOutputs = render(ctx, mergeLayers(layers.map(removeOsEntries))).outputs;
    observed.commonKnown = true;
    const probe = {
      ...ctx,
      hostname: observed.variableMarker,
      user: observed.variableMarker,
      config: { ...ctx.config, vars: markLocalVariables(ctx.config.vars || {}, observed.variableMarker) },
    };
    observed.variableOutputs = render(probe, merged).outputs;
    observed.variablesKnown = true;
  } catch {
    addCount(issues, 'provenance_unavailable');
  }
}

function sourceObservations(ctx, report, observed, issues, privateNames) {
  const addSource = (id, dir) => {
    const revision = sourceRevision(ctx, id, dir);
    report.sourceNow.push(revision);
    if (revision.commit === null || revision.dirty === null) {
      addCount(issues, 'git_unavailable');
    }
  };
  addSource('setup', ctx.sourceDir);
  let manifest;
  try {
    manifest = loadManifest(ctx.sourceDir);
  } catch {
    addCount(issues, 'source_unavailable');
    return;
  }
  for (const e of manifest.extends.filter((entry) => entry.dir)) {
    if (!isSafeName(e.name) || e.name === 'base' || report.sourceNow.some((s) => s.id === 'extends:' + e.name)) {
      addCount(issues, 'unsafe_identifier');
      continue;
    }
    addSource('extends:' + e.name, e.dir);
  }
  let adapters;
  try {
    adapters = resolveTargets(ctx, manifest);
    report.selectedTargets = [...new Set(adapters.map((a) => a.id))].sort();
  } catch {
    addCount(issues, 'selection_unavailable');
    return;
  }
  let layers;
  try {
    layers = loadUserLayers(ctx, manifest, () => addCount(issues, 'optional_layer_unavailable'));
    report.layers = layers.map((layer) => layer.name);
    for (const layer of layers) {
      for (const item of [...layer.mcp, ...layer.instructions, ...layer.commands, ...layer.agents]) {
        findSecretRefs(item.def || item.raw || item.body, privateNames);
      }
      for (const entries of Object.values(layer.settings)) {
        for (const entry of entries) {
          findSecretRefs(entry.value, privateNames);
        }
      }
    }
    findSecretRefs(manifest.vars, privateNames);
    findSecretRefs(ctx.config.vars, privateNames);
  } catch {
    addCount(issues, 'source_incomplete');
    return;
  }
  try {
    sourceExpectations(ctx, manifest, layers, adapters, observed, issues);
  } catch {
    addCount(issues, 'expected_unavailable');
  }
}

export function captureReport(ctx, version) {
  const issues = Object.create(null);
  const privateNames = new Set();
  const observed = { state: { outputs: {} }, outputs: [], commonOutputs: [], variableOutputs: [], forget: [],
    secretMarker: randomUUID(), variableMarker: randomUUID(), stateKnown: false, sourceKnown: false, commonKnown: false, variablesKnown: false };
  const report = { format: 'agent-layers-pc-report', schemaVersion: 1, scope: 'user', os: ctx.os, agentLayers: version,
    sourceNow: [], sourceAtApply: null, layers: [], selectedTargets: [], agents: [], items: [], coverage: 'complete', issues: [], excluded: {} };
  try {
    observed.state = loadState(ctx, { checkOutputs: true });
    observed.stateKnown = true;
  } catch {
    addCount(issues, 'state_unavailable');
  }
  sourceObservations(ctx, report, observed, issues, privateNames);
  const detection = new Map(detectAdapters(ctx).map((a) => [a.id, a]));
  report.agents = [...new Set([...report.selectedTargets, ...detection.keys()])].sort().map((id) => {
    const found = detection.get(id);
    const command = Boolean(found?.commands.length);
    const directory = Boolean(found?.dirs.length);
    return { id, detectedBy: command && directory ? 'both' : command ? 'command' : directory ? 'directory' : 'none', version: null, runtimeLoad: 'unverified' };
  });
  const { items, issues: itemIssues, excluded } = observeItems(ctx, { ...observed, privateNames });
  for (const issue of itemIssues) {
    addCount(issues, issue.code, issue.count);
  }
  const shareable = shareableName(ctx, privateNames);
  const keep = (safe) => {
    if (!safe) {
      addCount(issues, 'unsafe_identifier');
    }
    return safe;
  };
  report.layers = report.layers.filter((name, index, all) => keep((name === 'base' || shareable(name)) && all.indexOf(name) === index));
  report.sourceNow = report.sourceNow.filter((s) => s.id === 'setup' || keep(shareable(s.id.slice(8))));
  report.items = items;
  report.excluded = excluded;
  report.issues = Object.keys(issues).sort().map((code) => ({ code, count: issues[code] }));
  report.coverage = report.issues.length ? 'partial' : 'complete';
  return report;
}
