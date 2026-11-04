import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createContext } from '../src/context.js';
import { loadManifest, getProject } from '../src/manifest.js';
import { loadLayer, mergeLayers } from '../src/layers.js';
import { getAdapter } from '../src/adapters/registry.js';
import { renderScope } from '../src/render.js';
import { splitFrontmatter } from '../src/formats/frontmatter.js';

const BIN = fileURLToPath(new URL('../bin/agent-layers.js', import.meta.url));
const PROJECT = 'Actual.Project_7';
const TARGETS = ['kimi', 'grok', 'claude', 'codex', 'gemini', 'qwen', 'cursor'];
const LOCAL_NOTE = '# Existing local note\n\nKeep this note.\n';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function fixture(t, mode, header = true, initRepo = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-project-header-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  const repo = path.join(root, 'repo');
  const projectDir = path.join(source, 'projects', 'different-folder');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  if (initRepo) {
    const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
    assert.ifError(init.error);
    assert.equal(init.status, 0, init.stderr);
  }
  write(path.join(source, 'agent-layers.jsonc'), JSON.stringify({
    version: 1,
    targets: TARGETS,
    extends: [{ name: 'project:decoy', path: '../team' }],
    options: { instructions: { header }, claude: { mcp: 'json' } },
  }));
  write(path.join(root, 'team', 'instructions', '05-team.md'), '# Team\n\nShared team rule.\n');
  write(path.join(source, 'base', 'instructions', '00-base.md'), '# Base\n\nBase must stay the same.\n');
  write(path.join(source, 'base', 'instructions', '10-scoped.md'), '---\npaths: ["src/**"]\n---\n# User scoped rule\n');
  write(path.join(projectDir, 'project.jsonc'), JSON.stringify({ name: PROJECT, mode, targets: TARGETS, purge: { agentData: false } }));
  write(path.join(projectDir, 'instructions', '00-rule.md'), '# Project\n\nRule version 1.\n');
  write(path.join(projectDir, 'instructions', '10-scoped.md'), '---\npaths: ["src/**"]\n---\n# Scoped project rule\n');
  for (const relative of ['AGENTS.md', 'GEMINI.md', '.qwen/QWEN.local.md', 'CLAUDE.md']) {
    write(path.join(repo, relative), LOCAL_NOTE);
  }
  write(path.join(home, '.kimi-code', 'AGENTS.md'), LOCAL_NOTE);
  return { root, home, source, repo, projectDir };
}

function cli(sb, args) {
  const result = spawnSync(process.execPath, [BIN, ...args, '--source', sb.source, '--home', sb.home], {
    cwd: sb.repo,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout;
}

function headerCommand(text, layers, command) {
  const headers = text.split('\n').filter((line) => line.startsWith('<!-- Managed by agent-layers'));
  assert.deepEqual(headers, [`<!-- Managed by agent-layers (layers: ${layers}). Edit the source repository, then run "${command}". -->`]);
  const extracted = /then run "([^"]+)"/.exec(headers[0])[1].split(' ');
  assert.equal(extracted.shift(), 'agent-layers');
  return extracted;
}

function assertBlock(text, blockId) {
  assert.ok(text.startsWith(LOCAL_NOTE));
  assert.equal(text.split(`<!-- agent-layers:begin ${blockId} -->`).length, 2);
  assert.equal(text.split(`<!-- agent-layers:end ${blockId} -->`).length, 2);
  assert.ok(text.indexOf(`<!-- agent-layers:begin ${blockId} -->`) < text.indexOf(`<!-- agent-layers:end ${blockId} -->`));
}

function userOutputs(sb) {
  return ['.kimi-code/AGENTS.md', '.claude/rules/agent-layers/00-base.md', '.claude/rules/agent-layers/05-team.md', '.claude/rules/agent-layers/10-scoped.md', '.grok/rules/agent-layers-00-base.md'].map((relative) => path.join(sb.home, relative));
}

function projectOutputs(sb, mode) {
  const files = ['AGENTS.md', '.claude/rules/agent-layers/10-scoped.md', '.cursor/rules/agent-layers-10-scoped.mdc'];
  if (mode === 'private') {
    files.push('GEMINI.md', '.qwen/QWEN.local.md', `.claude/rules/agent-layers/project-${PROJECT}.md`, `.grok/rules/agent-layers-${PROJECT}.md`, `.cursor/rules/agent-layers-${PROJECT}.mdc`);
  }
  return files.map((relative) => path.join(sb.repo, relative));
}

function assertProject(sb, mode, version, header = true) {
  for (const file of projectOutputs(sb, mode)) {
    const text = read(file);
    if (header) {
      headerCommand(text, `project:${PROJECT}`, `agent-layers project apply ${PROJECT}`);
    } else {
      assert.doesNotMatch(text, /Managed by agent-layers|then run/);
    }
    assert.ok(text.endsWith('\n'));
    assert.doesNotMatch(text, /\r/);
    assert.ok(text.includes(file.includes('10-scoped') ? '# Scoped project rule' : `Rule version ${version}.`));
  }
  assertBlock(read(path.join(sb.repo, 'AGENTS.md')), `project.${PROJECT}`);
  const scoped = splitFrontmatter(read(path.join(sb.repo, '.claude/rules/agent-layers/10-scoped.md')));
  assert.deepEqual(scoped.data, { paths: ['src/**'] });
  const cursor = splitFrontmatter(read(path.join(sb.repo, '.cursor/rules/agent-layers-10-scoped.mdc')));
  assert.deepEqual(cursor.data, { globs: 'src/**', alwaysApply: false });
  if (mode === 'private') {
    assertBlock(read(path.join(sb.repo, 'GEMINI.md')), `project.${PROJECT}`);
    assertBlock(read(path.join(sb.repo, '.qwen/QWEN.local.md')), `project.${PROJECT}`);
    const toml = read(path.join(sb.repo, '.codex/config.toml'));
    assert.ok(toml.includes(`Rule version ${version}.`));
    assert.doesNotMatch(toml, /Managed by agent-layers|then run/);
    assert.equal(read(path.join(sb.repo, 'CLAUDE.md')), LOCAL_NOTE);
  } else {
    const shim = read(path.join(sb.repo, 'CLAUDE.md'));
    assertBlock(shim, 'agents-md');
    assert.match(shim, /@AGENTS\.md/);
    assert.doesNotMatch(shim, /Managed by agent-layers/);
  }
}

for (const mode of ['private', 'shared']) {
  test(`${mode}: the generated command updates project rules and preserves user outputs`, (t) => {
    const sb = fixture(t, mode);
    cli(sb, ['apply', '--yes']);
    const before = userOutputs(sb).map((file) => [file, read(file)]);
    for (const [, text] of before) {
      headerCommand(text, 'project:decoy, base', 'agent-layers apply');
    }
    assertBlock(before[0][1], 'base');
    cli(sb, ['project', 'apply', PROJECT, '--yes']);
    assertProject(sb, mode, 1);
    const args = headerCommand(read(path.join(sb.repo, 'AGENTS.md')), `project:${PROJECT}`, `agent-layers project apply ${PROJECT}`);
    write(path.join(sb.projectDir, 'instructions', '00-rule.md'), '# Project\n\nRule version 2.\n');
    cli(sb, [...args, '--yes']);
    assertProject(sb, mode, 2);
    const plan = JSON.parse(cli(sb, ['project', 'plan', PROJECT, '--json']));
    assert.ok(plan.items.length > 0);
    assert.ok(plan.items.every((item) => item.action === 'noop'), JSON.stringify(plan.items));
    for (const [file, text] of before) {
      assert.equal(read(file), text, file);
    }
    const userArgs = headerCommand(before[0][1], 'project:decoy, base', 'agent-layers apply');
    write(path.join(sb.source, 'base', 'instructions', '00-base.md'), '# Base\n\nBase version 2.\n');
    cli(sb, [...userArgs, '--yes']);
    assert.match(read(before[0][0]), /Base version 2\./);
    assertBlock(read(before[0][0]), 'base');
    assertProject(sb, mode, 2);
  });

  test(`${mode}: header false preserves rules, frontmatter and managed boundaries`, (t) => {
    const sb = fixture(t, mode, false);
    cli(sb, ['apply', '--yes']);
    cli(sb, ['project', 'apply', PROJECT, '--yes']);
    for (const file of userOutputs(sb)) {
      assert.doesNotMatch(read(file), /Managed by agent-layers|then run/);
    }
    assertBlock(read(userOutputs(sb)[0]), 'base');
    assertProject(sb, mode, 1, false);
  });
}

test('renderScope uses the project identity even when layer names contain only base and extends', (t) => {
  const sb = fixture(t, 'shared', true, false);
  const ctx = createContext({ home: sb.home, source: sb.source });
  const manifest = loadManifest(sb.source);
  const project = getProject(manifest, PROJECT);
  const merged = mergeLayers([loadLayer(sb.projectDir, 'base', ctx.os)]);
  merged.layers.push('extends:other-project');
  const rendered = renderScope(ctx, { scope: 'project', manifest, merged, adapters: [getAdapter('kimi'), getAdapter('claude')], project, root: sb.repo });
  const instructions = rendered.outputs.filter((output) => output.blockId !== 'agents-md');
  assert.equal(instructions.length, 2);
  for (const output of instructions) {
    headerCommand(output.content, 'base, extends:other-project', `agent-layers project apply ${PROJECT}`);
  }
});
