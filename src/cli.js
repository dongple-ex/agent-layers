import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createContext, hasSource } from './context.js';
import { loadManifest, listProjects, getProject, projectSources, PROJECT_NAME_RE } from './manifest.js';
import { loadLayer, mergeLayers } from './layers.js';
import { ADAPTERS, getAdapter } from './adapters/registry.js';
import { renderScope, resolveTargets, detectAdapters, gitDir, normalizeKey, trackedFiles, escapeGitIgnorePath } from './render.js';
import { buildPlan, applyPlan, summarize, pending, describeItem } from './engine.js';
import { loadState, saveState, scopeKeyOf, recordsForScope } from './state.js';
import { resolveProject, findAgentData, purgeAgentData, assertSafeRoot, projectMatches } from './project.js';
import { runDoctor } from './doctor.js';
import { planImport, applyImport, detectLanguage, PERSONA_LANGUAGES } from './importer.js';
import { validateSource, unknownTargetIssues } from './validate.js';
import { getSecret, getSecrets, setSecret, deleteSecret, listSecrets, backendFor } from './secrets/index.js';
import { findSecretRefs } from './template.js';
import { summarizeLayer, countItems } from './show.js';
import { readText, writeTextAtomic, exists, isDir, listFiles, sha256, hashFiles, readDirSnapshot } from './util/fsx.js';
import { parseJsonc, stringifyJson } from './formats/jsonc.js';
import { getBlockContent, upsertBlock } from './formats/mdblock.js';
import { run, runInherit, which } from './util/proc.js';
import { info, warn, error, table, c, mask, setQuiet, printable } from './util/log.js';
import { maskSecretFields } from './util/redact.js';
import { loadReviewRules, planRuleChange, saveRuleChange, resolveReviewRules } from './review-rules.js';
import { reviewSource, compareReviews, validateReviewDecisions, redactReview } from './review.js';
import { workflowCommand } from './workflow/cli.js';

const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'init');
const PERSONA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'persona');

const BOOLEAN_FLAGS = new Set(['yes', 'y', 'force', 'diff', 'json', 'quiet', 'q', 'help', 'h', 'show', 'overwrite', 'keep-agent-data', 'remove-source', 'all', 'fast', 'no-removals', 'version', 'v', 'project-only', 'user-only', 'prune', 'write', 'packet', 'strict', 'select']);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let rest = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const raw = a.replace(/^--?/, '');
      const eq = raw.indexOf('=');
      const key = eq >= 0 ? raw.slice(0, eq) : raw;
      if (eq >= 0) {
        pushFlag(flags, key, raw.slice(eq + 1));
      } else if (BOOLEAN_FLAGS.has(key) || argv[i + 1] === undefined || argv[i + 1].startsWith('-')) {
        flags[key] = true;
      } else {
        pushFlag(flags, key, argv[i + 1]);
        i += 1;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags, rest };
}

function pushFlag(flags, key, value) {
  if (key === 'env') {
    (flags.env ||= []).push(value);
  } else {
    flags[key] = value;
  }
}

function list(v) {
  if (!v || v === true) {
    return null;
  }
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function short(ctx, p) {
  if (!p) {
    return '';
  }
  const home = ctx.paths.home;
  if (p.toLowerCase().startsWith(home.toLowerCase())) {
    return `~${p.slice(home.length)}`.replace(/\\/g, '/');
  }
  return p.replace(/\\/g, '/');
}

async function confirm(question, flags) {
  if (flags.yes || flags.y) {
    return true;
  }
  if (!process.stdin.isTTY) {
    error(`${question} Refusing to continue without a terminal; pass --yes to confirm.`);
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function promptHidden(question) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => {
        data += d;
      });
      process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
    });
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    let done = false;
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (done) {
          return;
        }
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          done = true;
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
        } else if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

function loadUserLayers(ctx, manifest) {
  const layers = [];
  for (const e of manifest.extends) {
    if (!e.dir) {
      continue;
    }
    if (!isDir(e.dir)) {
      if (e.optional) {
        warn(`extends layer "${e.name}" not found at ${e.dir}; skipped`);
        continue;
      }
      throw new Error(`extends layer "${e.name}" not found at ${e.dir}${e.git ? ` (clone ${e.git} there, or run "agent-layers sync")` : ''}`);
    }
    layers.push(loadLayer(e.dir, e.name, ctx.os));
  }
  layers.push(loadLayer(manifest.baseDir, 'base', ctx.os));
  return layers;
}

function prepare(ctx) {
  if (!hasSource(ctx)) {
    throw new Error(`no setup repository at ${ctx.sourceDir}. Run "agent-layers init" (new) or "agent-layers init --from <git-url>" (existing), or pass --source <dir>.`);
  }
  const manifest = loadManifest(ctx.sourceDir);
  ctx.manifestOptions = manifest.options;
  return manifest;
}

function redactor(ctx) {
  const values = [...(ctx.redactions || [])].filter((v) => typeof v === 'string' && v.length >= 4).sort((a, b) => b.length - a.length);
  return (s) => {
    let out = String(s);
    for (const v of values) {
      out = out.split(v).join('***');
      const escaped = JSON.stringify(v).slice(1, -1);
      if (escaped !== v) {
        out = out.split(escaped).join('***');
      }
    }
    return maskSecretFields(out);
  };
}

function secretResolver(ctx) {
  ctx.redactions ||= new Set();
  return (n) => {
    const v = getSecret(ctx, n);
    if (v !== null && v !== undefined) {
      ctx.redactions.add(v);
    }
    return v;
  };
}

function itemLabel(ctx, it) {
  return it.type === 'block' ? `${short(ctx, it.path)}  [${it.output?.blockId || it.record?.blockId}]` : short(ctx, it.path);
}

function printPlan(ctx, plan, rendered, flags, title) {
  const redact = redactor(ctx);
  if (flags.json) {
    const items = plan.items.map((it) => ({ action: it.action, type: it.type, path: it.path, adapters: it.adapters, reason: it.reason || null, details: (it.details || []).map(redact) }));
    info(JSON.stringify({ title, summary: summarize(plan), items, notes: rendered.notes, requiredEnv: rendered.requiredEnv }, null, 2));
    return;
  }
  info(c.bold(printable(title)));
  const colorFor = { create: c.green, update: c.cyan, remove: c.magenta, conflict: c.yellow, drift: c.yellow, error: c.red, noop: c.gray, forget: c.gray };
  const visible = plan.items.filter((it) => flags.all || it.action !== 'noop');
  for (const it of visible) {
    const col = colorFor[it.action] || ((s) => s);
    const label = printable(itemLabel(ctx, it));
    const who = it.adapters.length > 2 ? `${it.adapters.slice(0, 2).join(',')}+${it.adapters.length - 2}` : it.adapters.join(',');
    info(`  ${col(it.action.padEnd(8))} ${who.padEnd(20)} ${it.type.padEnd(10)} ${label}`);
    const shown = { ...it, reason: it.reason && printable(it.reason), details: (it.details || []).map(printable) };
    for (const l of describeItem(shown, { diff: flags.diff, redact })) {
      info(l);
    }
  }
  const counts = summarize(plan);
  info(`\n${Object.entries(counts).map(([k, v]) => `${v} ${k === 'noop' ? 'unchanged' : k}`).join(', ') || 'nothing to do'}`);
  const notes = rendered.notes.filter((n) => flags.all || n.level !== 'info');
  if (notes.length) {
    info(c.bold('\nNotes'));
    for (const n of notes) {
      info(`  ${n.level === 'error' ? c.red(n.level) : n.level === 'warn' ? c.yellow(n.level) : c.gray(n.level)} ${printable(n.msg)}`);
    }
    const hidden = rendered.notes.length - notes.length;
    if (hidden > 0) {
      info(c.gray(`  (${hidden} informational notes hidden; use --all)`));
    }
  }
  const changing = plan.items.some((it) => ['create', 'update', 'conflict', 'drift'].includes(it.action));
  if ((rendered.executables || []).length && (changing || flags.all)) {
    info(c.bold('\nExecutable content (runs with your user rights; review before applying)'));
    for (const e of rendered.executables) {
      info(`  ${printable(e)}`);
    }
  }
  if (rendered.requiredEnv.length) {
    info(c.bold('\nEnvironment variables the rendered configs expect'));
    for (const e of rendered.requiredEnv) {
      info(`  ${printable(e)}`);
    }
  }
  if (counts.conflict || counts.drift) {
    info(c.yellow('\nConflicts and drift are skipped unless you pass --force (the original files are backed up first).'));
  }
}

function printResults(ctx, results, plan) {
  for (const r of results) {
    const mark = r.status === 'done' ? c.green('done') : r.status === 'failed' ? c.red('failed') : c.yellow('skipped');
    info(`  ${mark.padEnd(8)} ${r.it.action.padEnd(8)} ${r.it.type.padEnd(10)} ${printable(itemLabel(ctx, r.it))}${r.error ? `  ${c.red(printable(r.error))}` : ''}`);
  }
  if (plan.backups.length) {
    info(c.gray(`\nBackups: ${short(ctx, path.join(ctx.paths.stateDir, 'backups', plan.stamp))}`));
  }
}

function userRender(ctx, manifest, flags) {
  const layers = loadUserLayers(ctx, manifest);
  assertKnownTargets(ctx, layers);
  const merged = mergeLayers(layers);
  const adapters = resolveTargets(ctx, manifest, { only: list(flags.only), skip: list(flags.skip) });
  const rendered = renderScope(ctx, { scope: 'user', manifest, merged, adapters, resolveSecret: secretResolver(ctx) });
  for (const s of merged.shadowed) {
    rendered.notes.push({ level: 'info', msg: `${s.kind} "${s.name}" from layer ${s.by} overrides layer ${s.over}` });
  }
  pushSkippedLinks(rendered, merged);
  return { rendered, adapters, layers };
}

function projectRender(ctx, manifest, flags, nameArg) {
  const { project, root, how } = resolveProject(ctx, manifest, { name: nameArg || null, at: flags.path || null });
  if (!project) {
    throw new Error(`no project in ${projectSources(manifest).map((s) => short(ctx, s.dir)).join(', ')} matches ${root}. Pass a name, or add a "match" rule to the project's project.jsonc.`);
  }
  if (flags.mode) {
    project.mode = flags.mode;
  }
  const layer = loadLayer(project.dir, `project:${project.name}`, ctx.os);
  assertKnownTargets(ctx, [layer]);
  const merged = mergeLayers([layer]);
  const adapters = resolveTargets(ctx, manifest, { project, only: list(flags.only), skip: list(flags.skip) });
  const rendered = renderScope(ctx, { scope: 'project', manifest, merged, adapters, project, root, resolveSecret: secretResolver(ctx) });
  pushSkippedLinks(rendered, merged);
  return { rendered, adapters, project, root, how };
}

function assertKnownTargets(ctx, layers) {
  const issues = layers.flatMap((l) => unknownTargetIssues(l));
  if (issues.length) {
    throw new Error(issues.map((i) => `${short(ctx, i.where)}: ${i.msg}`).join('\n'));
  }
}

function pushSkippedLinks(rendered, merged) {
  for (const f of merged.skipped) {
    rendered.notes.push({ level: 'warn', msg: `${f}: a link to a folder or to a file outside its layer folder; not copied` });
  }
}

async function cmdPlanApply(ctx, flags, positional, apply) {
  const manifest = prepare(ctx);
  const state = loadState(ctx);
  const runs = [];
  const projectFlag = flags.project;
  const doUser = !flags['project-only'] && (projectFlag === undefined || flags.all);
  const doProject = projectFlag !== undefined || flags['project-only'];
  if (doUser) {
    const { rendered, adapters } = userRender(ctx, manifest, flags);
    const plan = buildPlan(ctx, { outputs: rendered.outputs, state, scopeKey: 'user', removals: !flags['no-removals'], selected: flags.prune ? null : adapters.map((a) => a.id), forget: rendered.forget });
    runs.push({ plan, rendered, scope: 'user', title: `User scope (layers: ${[...manifest.extends.filter((e) => e.dir).map((e) => e.name), 'base'].join(', ')}; agents: ${adapters.map((a) => a.id).join(', ') || 'none'})` });
  }
  if (doProject) {
    const name = typeof projectFlag === 'string' ? projectFlag : positional[0];
    const { rendered, adapters, project, root, how } = projectRender(ctx, manifest, flags, name);
    const scopeKey = scopeKeyOf('project', project.name, root);
    const plan = buildPlan(ctx, { outputs: rendered.outputs, state, scopeKey, removals: !flags['no-removals'], selected: flags.prune ? null : adapters.map((a) => a.id), forget: rendered.forget });
    runs.push({ plan, rendered, scope: 'project', project: project.name, root, title: `Project "${project.name}" at ${short(ctx, root)} (${project.mode} mode, matched by ${how}; agents: ${adapters.map((a) => a.id).join(', ') || 'none'})` });
  }
  for (const r of runs) {
    printPlan(ctx, r.plan, r.rendered, flags, r.title);
    info('');
  }
  if (!apply) {
    return 0;
  }
  const todo = runs.reduce((n, r) => n + pending(r.plan, { force: flags.force }).length, 0);
  if (!todo) {
    for (const r of runs) {
      applyPlan(ctx, r.plan, state, { force: false, scope: r.scope, project: r.project, root: r.root });
    }
    saveState(ctx, state);
    info('Nothing to apply.');
    return 0;
  }
  if (!(await confirm(`Apply ${todo} change(s)?`, flags))) {
    info('Aborted; nothing was written.');
    return 1;
  }
  let failed = 0;
  for (const r of runs) {
    const results = applyPlan(ctx, r.plan, state, { force: Boolean(flags.force), scope: r.scope, project: r.project, root: r.root });
    if (r.scope === 'project') {
      state.projects[r.project] = { root: r.root, appliedAt: new Date().toISOString() };
    }
    printResults(ctx, results, r.plan);
    failed += results.filter((x) => x.status === 'failed').length;
  }
  saveState(ctx, state);
  return failed ? 1 : 0;
}

function cmdStatus(ctx, flags) {
  const state = loadState(ctx);
  const rows = [];
  for (const [id, r] of Object.entries(state.outputs)) {
    let status = 'ok';
    try {
      if (r.type === 'file') {
        if (!exists(r.path)) {
          status = 'missing';
        } else {
          const buf = fs.readFileSync(r.path);
          const h1 = sha256(buf);
          const h2 = sha256(buf.toString('utf8').replace(/^﻿/, '').replace(/\r+\n/g, '\n'));
          status = h1 === r.hash || h2 === r.hash ? 'ok' : 'modified';
        }
      } else if (r.type === 'dir') {
        status = !isDir(r.path) ? 'missing' : hashFiles(readDirSnapshot(r.path)) === r.hash ? 'ok' : 'modified';
      } else if (r.type === 'block') {
        const t = readText(r.path);
        const b = t ? getBlockContent(t.text, r.blockId, r.style || 'html') : null;
        status = b === null ? 'missing' : sha256(b) === r.hash ? 'ok' : 'modified';
      } else {
        status = exists(r.path) ? 'keys' : 'missing';
      }
    } catch (err) {
      status = `error: ${err.message}`;
    }
    rows.push([status === 'ok' || status === 'keys' ? c.green(status) : c.yellow(status), r.scopeKey === 'user' ? 'user' : `project:${r.project}`, r.type, (r.adapters || []).join(','), short(ctx, r.path) + (r.blockId ? ` [${r.blockId}]` : '')]);
  }
  if (flags.json) {
    info(JSON.stringify({ outputs: state.outputs, projects: state.projects }, null, 2));
    return 0;
  }
  if (!rows.length) {
    info('No managed outputs yet. Run "agent-layers apply".');
    return 0;
  }
  table(rows, ['status', 'scope', 'type', 'agents', 'path']);
  const projects = Object.entries(state.projects || {});
  if (projects.length) {
    info(c.bold('\nProjects applied on this machine'));
    for (const [n, p] of projects) {
      info(`  ${n}  ${short(ctx, p.root)}  (${p.appliedAt})`);
    }
  }
  return 0;
}

function matchText(match) {
  return match.gitRemote.join(' ') || match.dirName.join(' ') || match.path.join(' ') || '-';
}

function targetText(item) {
  const base = item.targets ? item.targets.join(',') : 'all';
  return item.exclude && item.exclude.length ? `${base} except ${item.exclude.join(',')}` : base;
}

function clip(s, width = 60) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  let used = 0;
  let out = '';
  for (const ch of t) {
    const w = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
    if (used + w > width - 3) {
      return `${out}...`;
    }
    used += w;
    out += ch;
  }
  return out;
}

function keyText(keys) {
  return keys.length > 4 ? `${keys.slice(0, 3).join(', ')}, +${keys.length - 3}` : keys.join(', ');
}

function printLayerSummary(ctx, v) {
  info(`${c.bold(`Layer ${v.name}`)}  ${short(ctx, v.dir)}${v.missing ? c.yellow('  (folder not found)') : ''}`);
  if (v.project) {
    const p = v.project;
    info(`  mode      ${p.mode}, match ${matchText(p.match)}, ${p.appliedAt ? `applied at ${short(ctx, p.appliedAt)}` : 'not applied on this machine'}`);
    if (p.description) {
      info(`  about     ${clip(p.description)}`);
    }
  }
  info(`  agents    ${v.project && v.project.targets === 'inherit' ? 'inherit -> ' : ''}${v.resolvedAgents.join(', ') || 'none'}`);
  const section = (title, rows, count = rows.length) => {
    if (!rows.length) {
      return;
    }
    info(`  ${title} (${count})`);
    table(rows.map((r) => {
      const cells = ['  ', ...r];
      while (cells[cells.length - 1] === '') {
        cells.pop();
      }
      return cells;
    }));
  };
  const flagsOf = (i) => [i.template ? 'template' : '', i.paths.length ? `paths: ${i.paths.join(', ')}` : ''].filter(Boolean).join('  ');
  section('instructions', v.instructions.map((i) => [i.id, targetText(i), flagsOf(i)]));
  section('skills', v.skills.map((s) => [s.name, targetText(s), clip(s.description)]));
  section('commands', v.commands.map((s) => [s.name, targetText(s), clip(s.description)]));
  section('subagents', v.agents.map((s) => [s.name, targetText(s), clip(s.description)]));
  section('mcp', v.mcp.map((m) => [m.name, targetText(m), m.command ? path.basename(m.command) : m.url || '', m.secrets.length ? `secrets: ${m.secrets.join(', ')}` : '']));
  section('settings', v.settings.map((s) => [s.agent, s.file, `${keyText(s.keys)}${s.os ? `  (${s.os})` : ''}`]));
  section('forget', (v.forget || []).map((f) => [f.agent, f.key, f.os ? `(${f.os})` : '']));
  section('files', v.files.map((f) => [f.agent, f.files.join(', ')]), v.files.reduce((n, f) => n + f.files.length, 0));
}

function cmdShow(ctx, flags, positional) {
  const manifest = prepare(ctx);
  const state = loadState(ctx);
  const only = list(flags.only);
  const skip = list(flags.skip);
  const userAgents = resolveTargets(ctx, manifest, { only, skip }).map((a) => a.id);
  const userViews = loadUserLayers(ctx, manifest).map((l) => ({ ...summarizeLayer(l), resolvedAgents: userAgents }));
  const projectView = (p) => ({
    ...summarizeLayer(loadLayer(p.dir, `project:${p.name}`, ctx.os)),
    resolvedAgents: resolveTargets(ctx, manifest, { project: p, only, skip }).map((a) => a.id),
    project: { name: p.name, mode: p.mode, description: p.description, match: p.match, targets: p.targets, appliedAt: state.projects[p.name]?.root || null },
  });
  const projects = listProjects(manifest);
  const name = positional[0];
  if (name) {
    const user = userViews.find((v) => v.name === name);
    const p = user ? null : projects.find((x) => x.name === String(name).replace(/^project:/, ''));
    if (!user && !p) {
      throw new Error(`no layer named "${name}". Layers: ${[...userViews.map((v) => v.name), ...projects.map((x) => x.name)].join(', ') || 'none'}`);
    }
    const view = user || projectView(p);
    if (flags.json) {
      info(JSON.stringify({ layers: [view] }, null, 2));
      return 0;
    }
    printLayerSummary(ctx, view);
    return 0;
  }
  const projectViews = projects.map(projectView);
  if (flags.json) {
    info(JSON.stringify({ layers: userViews, projects: projectViews }, null, 2));
    return 0;
  }
  userViews.forEach((v, i) => {
    if (i) {
      info('');
    }
    printLayerSummary(ctx, v);
  });
  if (!projectViews.length) {
    info(`\nNo projects. Create one with "agent-layers project init <name>".`);
    return 0;
  }
  info(`\n${c.bold(`Projects (${projectViews.length})`)}  details: agent-layers show <name>`);
  table(projectViews.map((v) => ['  ', v.project.name, v.project.mode, `match ${matchText(v.project.match)}`, v.project.appliedAt ? `applied at ${short(ctx, v.project.appliedAt)}` : 'not applied', Object.entries(countItems(v)).map(([k, n]) => `${k} ${n}`).join(', ') || 'empty']));
  return 0;
}

function cmdAgents(ctx, flags) {
  const detected = new Map(detectAdapters(ctx).map((d) => [d.id, d]));
  const rows = ADAPTERS.map((a) => {
    const u = a.user || {};
    const ins = u.instructions?.always;
    const where = ins ? (ins.kind === 'block' ? ins.file(ctx.paths, ctx.os) : ins.dir(ctx.paths, ctx.os)) : '(app settings UI)';
    const skills = u.skills ? u.skills(ctx.paths, ctx.os).map((d) => short(ctx, d)).join(', ') : '-';
    const mcp = u.mcp ? (u.mcp.kind === 'claude-cli' ? 'claude mcp (user scope)' : short(ctx, u.mcp.file(ctx.paths, ctx.os))) : '-';
    return [detected.has(a.id) ? c.green('yes') : c.gray('no'), a.id, short(ctx, where), skills, mcp, `${a.checked || '-'} ${a.confidence === 'documented' ? '' : c.yellow(a.confidence || '')}`.trim(), a.tier];
  });
  if (flags.json) {
    info(JSON.stringify(rows.map((r) => r.map((x) => String(x).replace(/\u001b\[[0-9;]*m/g, ''))), null, 2));
    return 0;
  }
  for (const [tier, title] of [[1, 'Tier 1: core agents'], [2, '\nTier 2: extended agents (best effort)']]) {
    info(c.bold(title));
    table(rows.filter((r) => r[6] === tier).map((r) => r.slice(0, 6)), ['found', 'agent', 'user instructions', 'user skills', 'user MCP config', 'checked']);
  }
  return 0;
}

function cmdDoctor(ctx, flags) {
  const report = runDoctor(ctx);
  const failed = report.checks.some((x) => x.level === 'error' || (flags.strict && x.level === 'warn'));
  if (flags.json) {
    info(JSON.stringify(report, null, 2));
    return flags.strict && failed ? 1 : 0;
  }
  info(c.bold('Environment'));
  table(report.env.map(([k, v]) => [`  ${k}`, v]));
  info(c.bold('\nAgents found on this machine'));
  if (report.agents.length) {
    table(report.agents.map((r) => r.map((x, i) => (i === 4 ? short(ctx, String(x)) : x))), ['id', 'name', 'command', 'version', 'user instructions', 'agent-layers', 'tier']);
  } else {
    info('  none');
  }
  info(c.bold('\nChecks'));
  if (!report.checks.length) {
    info(`  ${c.green('ok')} no problems found`);
  }
  for (const ch of report.checks) {
    info(`  ${ch.level === 'error' ? c.red(ch.level) : ch.level === 'warn' ? c.yellow(ch.level) : c.gray(ch.level)} ${ch.msg}`);
  }
  return failed ? 1 : 0;
}

function copyTemplate(src, dest) {
  for (const f of listFiles(src)) {
    const target = path.join(dest, f.rel.replace(/(^|\/)_dot_/g, '$1.'));
    if (exists(target)) {
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(f.abs, target);
  }
}

function saveConfig(ctx, patch) {
  const cfg = { ...ctx.config, ...patch };
  writeTextAtomic(ctx.configFile, stringifyJson(cfg));
  ctx.config = cfg;
}

function writePersona(ctx, flags, dir) {
  const target = path.join(dir, 'base', 'instructions', '05-persona.md');
  if (exists(target)) {
    return;
  }
  const lang = flags.lang || detectLanguage(ctx);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(PERSONA_DIR, `${lang}.md`), target);
  info(`Wrote persona rules in ${PERSONA_LANGUAGES[lang]} to ${short(ctx, target)} (${flags.lang ? 'set by --lang' : 'detected from your existing agent instructions'}). Edit them to set your own persona.`);
}

async function cmdInit(ctx, flags, positional) {
  const dir = path.resolve(positional[0] || flags.source || ctx.sourceDir);
  if (flags.lang !== undefined && !Object.hasOwn(PERSONA_LANGUAGES, flags.lang)) {
    throw new Error(`--lang must be one of: ${Object.keys(PERSONA_LANGUAGES).join(', ')}`);
  }
  let created = false;
  if (flags.from) {
    if (exists(dir) && fs.readdirSync(dir).length) {
      throw new Error(`${dir} is not empty; choose another folder`);
    }
    const from = String(flags.from);
    if (isDir(from)) {
      fs.cpSync(from, dir, { recursive: true });
    } else {
      if (!which('git')) {
        throw new Error('git is required to clone the setup repository');
      }
      const code = runInherit('git', ['clone', from, dir]);
      if (code !== 0) {
        throw new Error(`git clone failed (${code})`);
      }
    }
  } else if (!exists(path.join(dir, 'agent-layers.jsonc'))) {
    copyTemplate(TEMPLATE_DIR, dir);
    info(`Created a new setup repository in ${dir}`);
    writePersona(ctx, flags, dir);
    created = true;
  } else {
    info(`Using the existing setup repository in ${dir}`);
  }
  if (flags.lang && !created) {
    warn('--lang only applies when a new setup repository is created from the template; existing files keep their language.');
  }
  saveConfig(ctx, { source: dir });
  info(`Registered ${dir} as the source in ${short(ctx, ctx.configFile)}`);
  info('\nNext steps:');
  info('  agent-layers doctor        # see which agents were found');
  info('  agent-layers plan --diff   # preview what would be written');
  info('  agent-layers apply         # write the base layer');
  if (!flags.from) {
    info(`  cd "${dir}" && git init && git add . && git commit -m "agent setup"   # then push to a private repository`);
  }
  return 0;
}

async function cmdProject(ctx, flags, positional) {
  const sub = positional[0];
  const manifest = prepare(ctx);
  if (!sub || sub === 'list') {
    const state = loadState(ctx);
    const rows = listProjects(manifest).map((p) => [p.name, p.origin ? `extends:${p.origin}` : 'source', p.mode, p.match.gitRemote.join(' ') || p.match.dirName.join(' ') || p.match.path.join(' ') || '-', state.projects[p.name] ? short(ctx, state.projects[p.name].root) : '-']);
    if (!rows.length) {
      info(`No projects in ${short(ctx, manifest.projectsDir)}. Create one with "agent-layers project init <name>".`);
      return 0;
    }
    table(rows, ['project', 'from', 'mode', 'match', 'applied at']);
    return 0;
  }
  if (sub === 'init') {
    const name = positional[1];
    if (!name || !PROJECT_NAME_RE.test(name)) {
      throw new Error('usage: agent-layers project init <name> [--mode private|shared] [--remote <glob>] [--dir-name <glob>]');
    }
    const dir = path.join(manifest.projectsDir, name);
    if (exists(dir)) {
      throw new Error(`${dir} already exists`);
    }
    const taken = listProjects(manifest).find((p) => p.name === name);
    if (taken) {
      throw new Error(`project "${name}" already exists in ${taken.dir}`);
    }
    const match = {};
    if (flags.remote) {
      match.gitRemote = [String(flags.remote)];
    }
    if (flags['dir-name']) {
      match.dirName = [String(flags['dir-name'])];
    }
    const pj = { name, description: '', mode: flags.mode || 'private', match, targets: 'inherit', vars: {}, purge: { agentData: true } };
    writeTextAtomic(path.join(dir, 'project.jsonc'), stringifyJson(pj));
    writeTextAtomic(path.join(dir, 'instructions', '00-project.md'), `# ${name}\n\n- Describe the project-specific rules here. They are discarded with this folder when the project ends.\n`);
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'mcp'), { recursive: true });
    info(`Created ${dir}`);
    info(`Bind it on this machine with "agent-layers project apply ${name} --path <project folder>"`);
    return 0;
  }
  if (sub === 'plan' || sub === 'apply') {
    return cmdPlanApply(ctx, { ...flags, project: positional[1] || true, 'project-only': true }, positional.slice(1), sub === 'apply');
  }
  if (sub === 'purge') {
    const name = positional[1];
    if (!name) {
      throw new Error('usage: agent-layers project purge <name> [--path <folder>] [--yes] [--keep-agent-data] [--remove-source]');
    }
    const state = loadState(ctx);
    let project = null;
    try {
      project = getProject(manifest, name);
    } catch {
      project = null;
    }
    const recorded = state.projects[name]?.root || null;
    if (!project && !recorded) {
      throw new Error(`unknown project "${name}": it is not in ${projectSources(manifest).map((s) => short(ctx, s.dir)).join(', ')} and was never applied on this machine`);
    }
    if (flags['remove-source'] && project?.origin) {
      throw new Error(`project "${name}" comes from extends layer "${project.origin}" (${project.dir}); --remove-source only deletes projects of this setup repository. Remove it in that repository instead.`);
    }
    if (!flags.path && !recorded) {
      throw new Error(`project "${name}" was never applied on this machine; pass --path <project folder> to choose the folder to purge`);
    }
    const root = path.resolve(flags.path ? String(flags.path) : recorded);
    assertSafeRoot(ctx, root);
    if (flags.path && recorded && normalizeKey(recorded) !== normalizeKey(root) && !flags.force) {
      throw new Error(`project "${name}" was applied at ${recorded}, not ${root}; pass --force to purge ${root} anyway`);
    }
    if (flags.path && !recorded && !flags.force && !(project && projectMatches(ctx, project, root))) {
      throw new Error(`${root} does not match the match rules of project "${name}"; check the path or pass --force`);
    }
    const scopeKey = scopeKeyOf('project', name, root);
    const plan = buildPlan(ctx, { outputs: [], state, scopeKey, removals: true, backup: false });
    info(c.bold(`Purge project "${name}" at ${short(ctx, root)}`));
    printPlan(ctx, plan, { notes: [], requiredEnv: [] }, { ...flags, all: true }, 'Files written by agent-layers');
    const wantAgentData = !flags['keep-agent-data'] && (project ? project.purge.agentData !== false : true);
    const otherRoots = Object.entries(state.projects).filter(([n]) => n !== name).map(([, v]) => v.root).filter(Boolean);
    const data = wantAgentData ? findAgentData(ctx, root, { otherRoots }) : [];
    if (wantAgentData) {
      info(c.bold('\nAgent data for this project on this machine'));
      if (!data.length) {
        info('  none found');
      }
      for (const d of data) {
        info(`  ${d.remove ? c.magenta('remove ') : c.yellow('review ')} ${d.agent.padEnd(12)} ${d.kind}${d.bytes ? ` (${Math.round(d.bytes / 1024)} KB)` : ''}\n           ${short(ctx, d.path)}`);
      }
    }
    if (flags['remove-source'] && project) {
      info(c.bold(`\nSource layer to delete: ${short(ctx, project.dir)}`));
    }
    if (!(await confirm('Purge now? This cannot be undone; nothing is backed up.', flags))) {
      info('Nothing was removed.');
      return 0;
    }
    const results = applyPlan(ctx, plan, state, { scope: 'project', project: name, root });
    printResults(ctx, results, plan);
    const kept = plan.items.filter((it) => it.removal && it.action === 'drift' && it.type !== 'block' && isWithinRoot(it.path, root)).map((it) => escapeGitIgnorePath(`/${path.relative(root, it.path).split(path.sep).join('/')}${it.type === 'dir' ? '/' : ''}`));
    const gd = gitDir(root);
    if (kept.length && gd) {
      const excludeFile = path.join(gd, 'info', 'exclude');
      const t = readText(excludeFile);
      writeTextAtomic(excludeFile, upsertBlock(t ? t.text : '', `project.${name}`, kept.join('\n'), { style: 'hash' }), { bom: t ? t.bom : false, eol: t ? t.eol : 'lf' });
      warn(`kept ${kept.length} locally modified file(s) and their .git/info/exclude entries: ${kept.join(', ')}`);
    }
    if (wantAgentData) {
      for (const r of purgeAgentData(ctx, data)) {
        info(`  ${r.status === 'done' ? c.green('done') : c.red('failed')} ${r.it.agent} ${short(ctx, r.it.path)}${r.error ? ` ${r.error}` : ''}`);
      }
    }
    delete state.projects[name];
    saveState(ctx, state);
    if (flags['remove-source'] && project) {
      const git = trackedFiles(ctx.sourceDir, [path.relative(ctx.sourceDir, project.dir).replace(/\\/g, '/')]);
      fs.rmSync(project.dir, { recursive: true, force: true });
      if (!git.reliable) {
        info(`Deleted ${project.dir}. If the setup repository uses git, commit the deletion.`);
      } else if (git.tracked.size) {
        info(`Deleted ${project.dir}. Commit the deletion in the setup repository.`);
      } else {
        info(`Deleted ${project.dir}. It was never committed, so there is nothing to commit.`);
      }
    }
    return 0;
  }
  if (sub === 'detect') {
    const { project, root, how } = resolveProject(ctx, manifest, { at: flags.path || null });
    info(project ? `${root} -> ${project.name} (matched by ${how})` : `${root} -> no project matched`);
    return project ? 0 : 1;
  }
  throw new Error(`unknown project command "${sub}"`);
}

function collectSecretNames(ctx, manifest) {
  const names = new Set();
  const dirs = [...manifest.extends.filter((e) => e.dir).map((e) => e.dir), manifest.baseDir, ...listProjects(manifest).map((p) => p.dir)];
  for (const d of dirs) {
    const layer = loadLayer(d, 'x', ctx.os);
    findSecretRefs(layer.mcp.map((m) => m.def), names);
  }
  return [...names].sort();
}

async function cmdSecrets(ctx, flags, positional) {
  const sub = positional[0];
  const name = positional[1];
  if (hasSource(ctx)) {
    ctx.manifestOptions = loadManifest(ctx.sourceDir).options;
  }
  if (sub === 'set') {
    if (!name) {
      throw new Error('usage: agent-layers secrets set <name> [--value <v>]');
    }
    const value = typeof flags.value === 'string' ? flags.value : await promptHidden(`Value for ${name}: `);
    if (!value) {
      throw new Error('empty value; nothing stored');
    }
    setSecret(ctx, name, value);
    info(`Stored ${name} in ${backendFor(ctx).id}`);
    return 0;
  }
  if (sub === 'get') {
    const v = getSecret(ctx, name);
    if (v === null) {
      error(`${name} is not set`);
      return 1;
    }
    info(flags.show ? v : mask(v));
    return 0;
  }
  if (sub === 'delete') {
    info(deleteSecret(ctx, name) ? `Deleted ${name}` : `${name} was not set`);
    return 0;
  }
  if (sub === 'list' || sub === 'check' || !sub) {
    const wanted = hasSource(ctx) ? collectSecretNames(ctx, loadManifest(ctx.sourceDir)) : [];
    const have = getSecrets(ctx, wanted);
    const stored = listSecrets(ctx) || [];
    const rows = [...new Set([...wanted, ...stored])].sort().map((n) => [n, wanted.includes(n) ? 'referenced' : 'unused', have[n] !== undefined || stored.includes(n) ? c.green('set') : c.red('missing')]);
    if (!rows.length) {
      info('No secrets referenced or stored.');
      return 0;
    }
    table(rows, ['secret', 'use', 'value']);
    const missing = wanted.filter((n) => have[n] === undefined);
    if (missing.length) {
      info(`\nSet the missing ones with: ${missing.map((n) => `agent-layers secrets set ${n}`).join(' ; ')}`);
      return sub === 'check' ? 1 : 0;
    }
    return 0;
  }
  throw new Error(`unknown secrets command "${sub}"`);
}

function cmdExec(ctx, flags, rest) {
  if (!rest || !rest.length) {
    throw new Error('usage: agent-layers exec [--env KEY=VALUE]... -- <command> [args...]');
  }
  if (hasSource(ctx)) {
    ctx.manifestOptions = loadManifest(ctx.sourceDir).options;
  }
  const pairs = (flags.env || []).map((e) => {
    const i = e.indexOf('=');
    return [e.slice(0, i), e.slice(i + 1)];
  });
  const token = /@@secret:([A-Za-z0-9_./-]+)@@/g;
  const names = new Set();
  for (const [, v] of pairs) {
    for (const m of v.matchAll(token)) {
      names.add(m[1]);
    }
  }
  for (const a of rest) {
    for (const m of a.matchAll(token)) {
      names.add(m[1]);
    }
  }
  const values = getSecrets(ctx, [...names]);
  const missing = [...names].filter((n) => values[n] === undefined);
  if (missing.length) {
    process.stderr.write(`agent-layers exec: missing secret(s): ${missing.join(', ')}. Run "agent-layers secrets set <name>".\n`);
    return 1;
  }
  const sub = (s) => s.replace(token, (_, n) => values[n]);
  const env = { ...process.env };
  for (const [k, v] of pairs) {
    env[k] = sub(v);
  }
  return runInherit(rest[0], rest.slice(1).map(sub), { env });
}

function syncChoices(ctx, manifest) {
  const entries = manifest.extends.filter((e) => e.projectsDir);
  const choices = listProjects(manifest).map((p) => ({
    name: p.name,
    from: p.origin ? `extends:${p.origin}` : 'source',
    dir: p.origin ? path.dirname(p.dir) : ctx.sourceDir,
    entry: null,
  }));
  for (const e of entries) {
    choices.push({ name: `extends:${e.name}`, from: 'external repository', dir: e.dir || path.dirname(e.projectsDir), entry: e });
  }
  return choices;
}

async function selectSyncProjects(choices) {
  if (!process.stdin.isTTY) {
    throw new Error('sync --select requires a terminal; use --projects <name,...> instead.');
  }
  if (!choices.length) {
    throw new Error('no projects available; add a project or an extends.projects entry first.');
  }
  table(choices.map((p, i) => [String(i + 1), p.name, p.from]), ['number', 'selection', 'from']);
  info('Downloads whole Git repositories only; settings are not applied.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.once('close', () => resolve(''));
    rl.once('SIGINT', () => rl.close());
    rl.question('Choose numbers or names separated by commas (Enter cancels): ', resolve);
  });
  rl.close();
  const tokens = list(answer) || [];
  return tokens.map((token) => {
    if (/^[0-9]+$/.test(token)) {
      const choice = choices[Number(token) - 1];
      if (!choice) {
        throw new Error(`invalid selection number "${token}"`);
      }
      return choice.name;
    }
    return token;
  });
}

async function cmdSyncSelected(ctx, manifest, flags) {
  if (flags.select !== undefined && flags.projects !== undefined) {
    throw new Error('cannot combine --select and --projects; choose one selection method.');
  }
  const applyFlags = ['project', 'project-only', 'user-only', 'all', 'path', 'only', 'skip', 'force', 'prune', 'no-removals', 'diff'];
  const conflicting = applyFlags.filter((key) => flags[key] !== undefined);
  if (conflicting.length) {
    throw new Error(`cannot combine selected sync with ${conflicting.map((key) => `--${key}`).join(', ')}; run project plan/apply separately.`);
  }
  if (flags.select !== undefined && (flags.quiet || flags.q)) {
    throw new Error('cannot combine --select with --quiet; the selection menu must be visible.');
  }
  const choices = syncChoices(ctx, manifest);
  let names;
  if (flags.select !== undefined) {
    names = await selectSyncProjects(choices);
    if (!names.length) {
      info('Cancelled; no repositories were changed.');
      return 1;
    }
  } else {
    names = list(flags.projects);
    if (!names?.length) {
      throw new Error('--projects requires at least one project name or extends:<name>.');
    }
  }
  const selected = [...new Set(names)].map((name) => {
    const matches = choices.filter((p) => p.name === name);
    if (matches.length !== 1) {
      throw new Error(`${matches.length ? 'ambiguous' : 'unknown'} sync selection "${name}". Available: ${choices.map((p) => p.name).join(', ') || 'none'}`);
    }
    return matches[0];
  });
  const repos = new Map();
  for (const choice of selected) {
    let dir = choice.dir;
    let git = null;
    if (!exists(dir)) {
      if (!choice.entry?.git) {
        throw new Error(`"${choice.name}" is missing at ${dir}; configure its extends.git before syncing.`);
      }
      git = choice.entry.git;
    } else {
      const result = run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
      if (result.code !== 0) {
        throw new Error(`${dir} is not a git checkout; initialize or clone its setup repository first.`);
      }
      dir = result.stdout.trim();
    }
    const previous = repos.get(dir);
    if (previous && previous.git !== git) {
      throw new Error(`conflicting Git sources for ${dir}; check the selected extends entries.`);
    }
    repos.set(dir, { dir, git });
  }
  info(`Selected: ${selected.map((p) => p.name).join(', ')}`);
  info(`Syncing ${repos.size} whole Git repository/repositories; settings are not applied.`);
  for (const { dir, git } of repos.values()) {
    info(c.bold(git ? `git clone -> ${short(ctx, dir)}` : `git pull --ff-only (${short(ctx, dir)})`));
    const code = runInherit('git', git ? ['clone', git, dir] : ['-C', dir, 'pull', '--ff-only']);
    if (code !== 0) {
      error(`git ${git ? 'clone' : 'pull'} failed in ${dir}; resolve it and retry the same sync selection.`);
      return 1;
    }
  }
  info('Downloaded selected repositories. Run "agent-layers project list", then "agent-layers project plan <name> --path <folder>" to review application.');
  return 0;
}

async function cmdSync(ctx, flags) {
  const manifest = prepare(ctx);
  if (flags.projects !== undefined || flags.select !== undefined) {
    return cmdSyncSelected(ctx, manifest, flags);
  }
  const repoOf = (d) => (isDir(path.join(d, '.git')) ? d : isDir(path.join(path.dirname(d), '.git')) ? path.dirname(d) : null);
  const repos = [ctx.sourceDir, ...manifest.extends.flatMap((e) => [e.dir, e.projectsDir]).filter(Boolean).map(repoOf).filter(Boolean)];
  for (const repo of [...new Set(repos)]) {
    if (!isDir(path.join(repo, '.git'))) {
      warn(`${repo} is not a git checkout; skipped pull`);
      continue;
    }
    info(c.bold(`git pull --ff-only (${short(ctx, repo)})`));
    const code = runInherit('git', ['-C', repo, 'pull', '--ff-only']);
    if (code !== 0) {
      error(`git pull failed in ${repo}; resolve it and run "agent-layers apply"`);
      return 1;
    }
  }
  for (const e of manifest.extends) {
    const cloneDir = e.dir || path.dirname(e.projectsDir);
    if (!isDir(cloneDir) && e.git) {
      info(c.bold(`git clone ${e.git} -> ${short(ctx, cloneDir)}`));
      if (runInherit('git', ['clone', e.git, cloneDir]) !== 0) {
        return 1;
      }
    }
  }
  return cmdPlanApply(ctx, flags, [], true);
}

async function cmdImport(ctx, flags) {
  const manifest = prepare(ctx);
  const from = list(flags.from) || ['claude', 'codex', 'gemini', 'copilot'];
  const layerDir = flags.into ? path.resolve(String(flags.into)) : manifest.baseDir;
  const plan = planImport(ctx, { from, layerDir });
  info(c.bold(`Import from ${from.join(', ')} into ${short(ctx, layerDir)}`));
  for (const w of plan.writes) {
    info(`  ${exists(w.path) && !flags.overwrite ? c.gray('exists ') : c.green('write  ')} ${w.rel.padEnd(48)} ${c.gray(`<- ${w.origin}`)}`);
  }
  for (const n of plan.notes) {
    info(`  ${c.yellow('note')} ${n}`);
  }
  if (plan.secrets.length) {
    info(c.bold('\nPlain-text secrets were replaced by references. Store them on this machine with:'));
    plan.secrets.forEach((s) => info(`  agent-layers secrets set ${s}`));
  }
  if (!plan.writes.length) {
    info('Nothing to import.');
    return 0;
  }
  if (!(await confirm(`Write ${plan.writes.length} file(s) into the setup repository?`, flags))) {
    return 1;
  }
  const r = applyImport(plan, { overwrite: Boolean(flags.overwrite) });
  info(`Wrote ${r.done.length} file(s); ${r.skipped.length} already existed (use --overwrite).`);
  info('Review the imported files, remove duplicates and client-specific content, then commit.');
  return 0;
}

function cmdValidate(ctx, flags) {
  const dir = flags.source ? path.resolve(String(flags.source)) : ctx.sourceDir;
  const { issues } = validateSource(dir, { os: ctx.os });
  if (flags.json) {
    info(JSON.stringify(issues, null, 2));
  } else {
    for (const i of issues) {
      info(`  ${i.level === 'error' ? c.red(i.level) : i.level === 'warn' ? c.yellow(i.level) : c.gray(i.level)} ${short(ctx, i.where)}: ${i.msg}`);
    }
    const e = issues.filter((i) => i.level === 'error').length;
    info(e ? c.red(`\n${e} error(s)`) : c.green('\nSource repository looks valid.'));
  }
  return issues.some((i) => i.level === 'error' || (flags.strict && i.level === 'warn')) ? 1 : 0;
}

async function cmdReview(ctx, flags, positional) {
  const [sub, action = 'list', id] = positional;
  const fileFlag = (name) => {
    if (flags[name] === undefined) {
      return null;
    }
    if (typeof flags[name] !== 'string' || !flags[name].trim()) {
      throw new Error(`--${name} requires a file path`);
    }
    return path.resolve(flags[name]);
  };
  const rulesFile = fileFlag('rules');
  const readInput = () => {
    const file = fileFlag('input');
    if (!file) {
      throw new Error('--input <file.json> is required');
    }
    return parseJsonc(fs.readFileSync(file, 'utf8'), file);
  };
  const emit = (value) => info(JSON.stringify(redactReview(value), null, 2));
  if (sub === 'rules') {
    const loaded = loadReviewRules(ctx.sourceDir, rulesFile);
    if (['list', 'validate'].includes(action)) {
      if (flags.write) {
        throw new Error('--write is only allowed for rules add/update/enable/disable');
      }
      emit(action === 'list' ? { file: loaded.file, rules: loaded.rules } : { valid: true, file: loaded.file, rules: loaded.rules.length });
      return 0;
    }
    if (!['add', 'update', 'enable', 'disable'].includes(action) || !id || positional.length !== 3) {
      throw new Error('usage: review rules add|update|enable|disable <id> [--input <rule.json>] [--write]');
    }
    if (rulesFile) {
      throw new Error('룰 변경은 --source 아래 review-rules.jsonc에만 저장합니다. --rules는 조회·비교에 사용하십시오.');
    }
    prepare(ctx);
    const change = planRuleChange(loaded, action, id, ['add', 'update'].includes(action) ? readInput() : null);
    const before = reviewSource(ctx.sourceDir, { loadedRules: loaded });
    const after = reviewSource(ctx.sourceDir, { loadedRules: { ...loaded, config: change.config, rules: resolveReviewRules(change.config, loaded.file) } });
    const preview = { readOnly: !flags.write, action, file: change.file, before: change.before, after: change.after, impact: compareReviews(before, after), notice: '저장 시 JSONC 주석은 제거되며 원본은 .bak 파일로 보존됩니다. MD 파일은 수정하지 않습니다.' };
    if (!flags.write) {
      emit(preview);
      return 0;
    }
    if (!flags.json) {
      emit(preview);
    }
    if (!(await confirm('검증 룰 변경을 저장하시겠습니까?', flags))) {
      return 1;
    }
    const saved = saveRuleChange(change);
    emit({ ...preview, saved });
    return 0;
  }
  if (flags.write) {
    throw new Error('MD 검토는 읽기 전용입니다. --write는 룰 변경 명령에만 사용할 수 있습니다.');
  }
  if (sub && sub !== 'check') {
    throw new Error('usage: review [--packet] [--compare <rules.jsonc>] | review check --input <result.json> | review rules ...');
  }
  const report = reviewSource(ctx.sourceDir, { rulesFile, packet: Boolean(flags.packet) });
  if (sub === 'check') {
    const checked = validateReviewDecisions(report, readInput());
    emit(checked);
    return checked.schemaValid && checked.coverageComplete ? 0 : 1;
  }
  const compare = fileFlag('compare');
  if (compare) {
    report.comparison = compareReviews(report, reviewSource(ctx.sourceDir, { rulesFile: compare }));
  }
  if (flags.json || flags.packet || compare) {
    emit(report);
  } else {
    info('MD 검토 (읽기 전용) — AI 의미 검토는 실행하지 않았습니다.');
    for (const f of report.findings) {
      info(`  ${f.status} [${f.ruleId}] ${f.file}:${f.line} ${f.reason}`);
    }
    for (const e of report.exceptions) {
      info(`  예외 [${e.ruleId}] ${e.file}: ${e.exceptions.map((v) => v.reason).join('; ')}`);
    }
    for (const item of report.skipped) {
      info(`  검사 제외 ${item.path}: ${item.reason}`);
    }
    for (const item of report.ruleNotices) {
      info(`  룰 재검토 [${item.ruleId}]: ${item.reason}`);
    }
    info(`\n문서 ${report.summary.documents}, 정적 발견 ${report.summary.staticFindings}, AI 검토 대기 ${report.summary.pending}, 예외 ${report.summary.exceptions}, 검사 제외 ${report.summary.skipped}, 미확인 링크 ${report.summary.uncheckedLinks}`);
    info('AI 검토 자료: review --packet --json. 결과 형식 검사: review check --input <result.json>.');
  }
  return flags.strict && (report.findings.length || report.skipped.length || report.uncheckedLinks.length || report.ruleNotices.length || !report.documents.length) ? 1 : 0;
}

async function cmdUninstall(ctx, flags) {
  const state = loadState(ctx);
  const scopes = [...new Set(Object.values(state.outputs).map((r) => r.scopeKey))];
  if (!scopes.length) {
    info('agent-layers has not written anything on this machine.');
    return 0;
  }
  const plans = scopes.map((s) => buildPlan(ctx, { outputs: [], state, scopeKey: s, removals: true }));
  for (const p of plans) {
    printPlan(ctx, p, { notes: [], requiredEnv: [] }, { ...flags, all: true }, `Remove outputs of ${p.scopeKey}`);
  }
  if (!(await confirm('Remove everything listed above? Modified files are left in place.', flags))) {
    return 1;
  }
  for (const p of plans) {
    const r = state.outputs[Object.keys(state.outputs).find((k) => state.outputs[k].scopeKey === p.scopeKey)] || {};
    printResults(ctx, applyPlan(ctx, p, state, { scope: r.scope, project: r.project, root: r.root }), p);
  }
  saveState(ctx, state);
  return 0;
}

const HELP = `agent-layers ${PKG.version}
Keep AI coding agent configuration (instructions, skills, commands, MCP servers, settings)
in one repository, split into a base layer that follows you to every machine and project
layers you can drop when a project ends.

Usage: agent-layers <command> [options]

Setup
  init [dir] [--from <git-url|dir>] [--lang en|ko]  create or clone a setup repository and register it; --lang sets the persona file language
  doctor [--strict]                   check this machine, found agents and risky configs; --strict also fails on warnings
  agents                              list supported agents by tier and where they read config
  show [layer] [--json]               list what each layer holds and which agents receive it
  validate [--strict]                 lint the setup repository (skills, MCP, secrets)
  review [--packet] [--json] [--strict]  read-only MD checks and pending AI review tasks
  review --compare <rules.jsonc>       preview changed review results without writing
  review check --input <result.json>   validate AI result shape, coverage and source hash
  review rules list|validate [--rules <file>]
  review rules add|update <id> --input <rule.json> [--write] [--yes]
  review rules enable|disable <id> [--write] [--yes]
  import [--from claude,codex,...]    capture existing user-level config into the base layer

Base layer (home directory)
  plan [--diff] [--all]               preview changes (dry run)
  apply [--yes] [--force] [--prune]     write the base layer; --prune also removes outputs of unselected agents
  sync [--yes]                        git pull the setup repository, then apply
  status                              list managed outputs and local drift
  uninstall [--yes]                   remove everything agent-layers wrote

Project layers
  sync --select                      choose projects/repositories to download; no apply
  sync --projects <name,...>          download chosen projects or extends:<name> repositories
  project list | init <name> [--mode private|shared] [--remote <glob>] [--dir-name <glob>]
  project plan|apply [name] [--path <folder>] [--diff] [--yes] [--force]
  project detect [--path <folder>]
  project purge <name> [--path <folder>] [--keep-agent-data] [--remove-source] [--yes]

Secrets (OS keychain: Windows Credential Manager, macOS Keychain, libsecret)
  secrets list | check | set <name> [--value v] | get <name> [--show] | delete <name>
  exec [--env KEY=VALUE]... -- <command> [args]   run an MCP server with secrets injected

Workflow (preview: plan, run, resume and cancel are not available yet)
  workflow validate <run-id> [--json]  check a stored run's plan, policy and records
  workflow status <run-id> [--json]    show step states, attempts and budget use
  workflow report <run-id> [--json]    show check results, artifacts and remaining steps

Options
  --source <dir>   setup repository (default from ~/.agent-layers/config.jsonc)
  --home <dir>     use <dir> as the home directory (sandbox / testing)
  --only a,b       limit to these agents     --skip a,b   skip these agents
  --json           machine-readable output   --quiet      less output
`;

export async function main(argv) {
  const { positional, flags, rest } = parseArgs(argv);
  if (flags.quiet || flags.q) {
    setQuiet(true);
  }
  const cmd = positional.shift();
  if (flags.version || flags.v || cmd === 'version') {
    info(PKG.version);
    return 0;
  }
  if (!cmd || flags.help || flags.h || cmd === 'help') {
    info(HELP);
    return 0;
  }
  const ctx = createContext({ home: flags.home ? path.resolve(String(flags.home)) : undefined, source: flags.source ? path.resolve(String(flags.source)) : undefined, flags });
  switch (cmd) {
    case 'init':
      return cmdInit(ctx, flags, positional);
    case 'doctor':
      return cmdDoctor(ctx, flags);
    case 'agents':
      return cmdAgents(ctx, flags);
    case 'plan':
    case 'diff':
      return cmdPlanApply(ctx, { ...flags, diff: flags.diff || cmd === 'diff' }, positional, false);
    case 'apply':
      return cmdPlanApply(ctx, flags, positional, true);
    case 'status':
      return cmdStatus(ctx, flags);
    case 'show':
      return cmdShow(ctx, flags, positional);
    case 'project':
      return cmdProject(ctx, flags, positional);
    case 'secrets':
      return cmdSecrets(ctx, flags, positional);
    case 'exec':
      return cmdExec(ctx, flags, rest);
    case 'sync':
      return cmdSync(ctx, flags);
    case 'import':
      return cmdImport(ctx, flags);
    case 'validate':
      return cmdValidate(ctx, flags);
    case 'review':
      return cmdReview(ctx, flags, positional);
    case 'uninstall':
      return cmdUninstall(ctx, flags);
    case 'workflow':
      return workflowCommand(ctx, flags, positional);
    default:
      error(`unknown command "${cmd}". Run "agent-layers help".`);
      return 2;
  }
}

export { getAdapter, recordsForScope };

function isWithinRoot(p, root) {
  const a = normalizeKey(p);
  const b = normalizeKey(root);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
