import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  inspectRepository, workspaceKey, worktreePath, createWorktree, sourceFingerprint, compareFingerprints,
  listChanges, checkChanges, pathInsideWorktree, resultPatch, describeWorktree,
} from '../src/workflow/workspace.js';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ws-config-'));
process.env.GIT_CONFIG_GLOBAL = path.join(CONFIG_DIR, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync.native(os.tmpdir());
after(() => fs.rmSync(CONFIG_DIR, { recursive: true, force: true }));

const REPO_FILES = { 'src/a.js': 'a\n', 'src/b.js': 'b\n', 'test/old.test.js': 'old\n', 'docs/guide.md': 'guide\n', '.gitignore': '*.log\n' };

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function put(root, file, text) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function touchLater(root, file) {
  const later = new Date(Date.now() + 3600 * 1000);
  fs.utimesSync(path.join(root, file), later, later);
}

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ws-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  for (const [file, text] of Object.entries(REPO_FILES)) {
    put(root, file, text);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return { base, root, ctx: { paths: { stateDir: path.join(base, 'state') } }, runId: crypto.randomUUID(), baseCommit: git(root, 'rev-parse', 'HEAD') };
}

function worktreeOf(t) {
  const s = setup(t);
  return { ...s, w: createWorktree(s.ctx, s.runId, { root: s.root, baseCommit: s.baseCommit }) };
}

function check(s, { writePaths = ['src'], protectedPaths = [] } = {}) {
  return checkChanges(s.w.path, { baseCommit: s.baseCommit, gitFileHash: s.w.gitFileHash, writePaths, protectedPaths });
}

function reasons(result) {
  return Object.fromEntries(result.violations.map((v) => [v.path, v.reason]));
}

function tryLink(target, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.symlinkSync(target, file, process.platform === 'win32' ? 'junction' : undefined);
    return true;
  } catch (err) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) {
      return false;
    }
    throw err;
  }
}

test('workflow workspace: the repository check finds the top folder, the base commit and the uncommitted changes', (t) => {
  const s = setup(t);
  put(s.root, 'src/a.js', 'changed\n');
  put(s.root, 'src/staged.js', 'staged\n');
  git(s.root, 'add', 'src/staged.js');
  put(s.root, 'src/new dir/untracked.js', 'new\n');
  fs.rmSync(path.join(s.root, 'docs/guide.md'));
  put(s.root, 'src/ignored.log', 'ignored\n');
  git(s.root, 'mv', 'test/old.test.js', 'test/moved.test.js');
  const info = inspectRepository(path.join(s.root, 'src'));
  assert.equal(info.root, fs.realpathSync.native(s.root));
  assert.equal(info.baseCommit, s.baseCommit);
  assert.deepEqual(Object.fromEntries(info.uncommitted.map((c) => [c.path, c.status])), {
    'src/a.js': ' M',
    'src/staged.js': 'A ',
    'src/new dir/untracked.js': '??',
    'docs/guide.md': ' D',
    'test/old.test.js': 'D ',
    'test/moved.test.js': 'A ',
  });
});

test('workflow workspace: variables that point git at another repository are ignored', (t) => {
  const s = setup(t);
  const other = setup(t);
  process.env.GIT_DIR = path.join(other.root, '.git');
  process.env.GIT_INDEX_FILE = path.join(other.root, '.git/index');
  t.after(() => {
    delete process.env.GIT_DIR;
    delete process.env.GIT_INDEX_FILE;
  });
  const info = inspectRepository(s.root);
  assert.equal(info.root, fs.realpathSync.native(s.root));
  assert.equal(info.workspaceKey, fs.realpathSync.native(path.join(s.root, '.git')));
});

test('workflow workspace: reading the source does not rewrite its index or run programs from its configuration', (t) => {
  const s = setup(t);
  const marker = path.join(s.base, 'monitor-ran').replaceAll('\\', '/');
  const monitor = path.join(s.base, 'monitor.sh').replaceAll('\\', '/');
  fs.writeFileSync(monitor, `#!/bin/sh\necho ran > "${marker}"\nexit 1\n`, { mode: 0o755 });
  git(s.root, 'config', 'core.fsmonitor', monitor);
  git(s.root, 'status');
  assert.equal(fs.existsSync(marker), true, 'the monitor must run in a normal status for this test to mean anything');
  fs.rmSync(marker);
  touchLater(s.root, 'src/a.js');
  const index = fs.readFileSync(path.join(s.root, '.git/index'));
  sourceFingerprint(s.root);
  inspectRepository(s.root);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readFileSync(path.join(s.root, '.git/index')), index);
  git(s.root, 'status');
  assert.notDeepEqual(fs.readFileSync(path.join(s.root, '.git/index')), index, 'a normal status must rewrite the index for this test to mean anything');
});

test('workflow workspace: a folder outside git or a repository without commits is refused', (t) => {
  const s = setup(t);
  const plain = path.join(s.base, 'plain');
  fs.mkdirSync(plain);
  assert.throws(() => inspectRepository(plain), (err) => err.code === 'E_WORKFLOW_WORKSPACE' && /rev-parse/.test(err.message));
  const empty = path.join(s.base, 'empty');
  fs.mkdirSync(empty);
  git(empty, 'init', '-q');
  assert.throws(() => inspectRepository(empty), (err) => err.code === 'E_WORKFLOW_WORKSPACE');
});

test('workflow workspace: the lock key is the real git common directory, so a linked worktree shares it', (t) => {
  const s = setup(t);
  const key = workspaceKey(s.root);
  assert.equal(key, fs.realpathSync.native(path.join(s.root, '.git')));
  const linked = path.join(s.base, 'linked');
  git(s.root, 'worktree', 'add', '-q', '--detach', linked);
  assert.equal(workspaceKey(linked), key);
  assert.equal(inspectRepository(linked).workspaceKey, key);
});

test('workflow workspace: a worktree starts detached at the base commit without the uncommitted changes of the source', (t) => {
  const s = setup(t);
  put(s.root, 'src/a.js', 'changed in the source\n');
  put(s.root, 'src/untracked.js', 'new\n');
  const refs = git(s.root, 'for-each-ref');
  const w = createWorktree(s.ctx, s.runId, { root: s.root, baseCommit: s.baseCommit });
  assert.equal(w.path, fs.realpathSync.native(path.join(s.ctx.paths.stateDir, 'worktrees', s.runId)));
  assert.equal(w.baseCommit, s.baseCommit);
  assert.equal(git(w.path, 'rev-parse', 'HEAD'), s.baseCommit);
  assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: w.path }).status, 1);
  assert.equal(fs.readFileSync(path.join(w.path, 'src/a.js'), 'utf8'), 'a\n');
  assert.equal(fs.existsSync(path.join(w.path, 'src/untracked.js')), false);
  assert.equal(fs.readFileSync(path.join(s.root, 'src/a.js'), 'utf8'), 'changed in the source\n');
  assert.equal(git(s.root, 'for-each-ref'), refs);
});

test('workflow workspace: a worktree is detached even when the base is given as a branch name', (t) => {
  const s = setup(t);
  const w = createWorktree(s.ctx, s.runId, { root: s.root, baseCommit: 'main' });
  assert.equal(w.baseCommit, s.baseCommit);
  assert.equal(git(w.path, 'rev-parse', 'HEAD'), s.baseCommit);
  assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: w.path }).status, 1);
});

test('workflow workspace: a link in place of the worktrees folder is refused', (t) => {
  const s = setup(t);
  const outside = path.join(s.base, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(s.ctx.paths.stateDir);
  if (!tryLink(outside, path.join(s.ctx.paths.stateDir, 'worktrees'))) {
    t.skip('this environment cannot create links');
    return;
  }
  assert.throws(() => createWorktree(s.ctx, s.runId, { root: s.root, baseCommit: s.baseCommit }), (err) => err.code === 'E_WORKFLOW_UNSAFE_PATH');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('workflow workspace: the worktree path needs a valid run id and an existing worktree is not reused', (t) => {
  const s = setup(t);
  for (const bad of ['../escape', 'not-a-uuid', '']) {
    assert.throws(() => worktreePath(s.ctx, bad), (err) => err.code === 'E_WORKFLOW_BAD_RUN_ID');
  }
  createWorktree(s.ctx, s.runId, { root: s.root, baseCommit: s.baseCommit });
  put(worktreePath(s.ctx, s.runId), 'src/work.js', 'work\n');
  assert.throws(() => createWorktree(s.ctx, s.runId, { root: s.root, baseCommit: s.baseCommit }), (err) => err.code === 'E_WORKFLOW_WORKSPACE');
  assert.equal(fs.readFileSync(path.join(worktreePath(s.ctx, s.runId), 'src/work.js'), 'utf8'), 'work\n');
});

test('workflow workspace: repository hooks do not run when the worktree is created', (t) => {
  const s = setup(t);
  const marker = path.join(s.base, 'hook-ran').replaceAll('\\', '/');
  const hook = path.join(s.root, '.git/hooks/post-checkout');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
  git(s.root, 'checkout', '-q', '-b', 'hook-check');
  assert.equal(fs.existsSync(marker), true, 'the hook must work in a normal checkout for this test to mean anything');
  fs.rmSync(marker);
  createWorktree(s.ctx, s.runId, { root: s.root, baseCommit: s.baseCommit });
  assert.equal(fs.existsSync(marker), false);
});

test('workflow workspace: the fingerprint of the source stays the same across worktree creation and work inside the worktree', (t) => {
  const s = setup(t);
  put(s.root, 'src/a.js', 'uncommitted in the source\n');
  const before = sourceFingerprint(s.root);
  const w = createWorktree(s.ctx, s.runId, { root: s.root, baseCommit: s.baseCommit });
  put(w.path, 'src/a.js', 'changed in the worktree\n');
  put(w.path, 'src/new.js', 'new in the worktree\n');
  git(w.path, 'add', '-A');
  git(w.path, 'commit', '-qm', 'work in the worktree');
  put(w.path, 'src/b.js', 'not committed\n');
  listChanges(w.path, s.baseCommit);
  resultPatch(w.path, s.baseCommit);
  assert.deepEqual(compareFingerprints(before, sourceFingerprint(s.root, { ownWorktree: w.name })), []);
  const notExcluded = compareFingerprints(before, sourceFingerprint(s.root));
  assert.ok(notExcluded.length > 0 && notExcluded.every((d) => d.startsWith(`git:worktrees/${w.name}/`)), JSON.stringify(notExcluded));
});

test('workflow workspace: every change to the source is found by the fingerprint', async (t) => {
  const cases = {
    'edit a tracked file': [(s) => put(s.root, 'src/a.js', 'edited\n'), 'uncommitted:src/a.js'],
    'edit a file again': [(s) => put(s.root, 'src/dirty.js', 'second\n'), 'uncommitted:src/dirty.js'],
    'new untracked file': [(s) => put(s.root, 'src/new.js', 'new\n'), 'uncommitted:src/new.js'],
    'delete a tracked file': [(s) => fs.rmSync(path.join(s.root, 'src/b.js')), 'uncommitted:src/b.js'],
    'stage a file': [(s) => { put(s.root, 'src/a.js', 'edited\n'); git(s.root, 'add', 'src/a.js'); }, 'staged'],
    'new commit': [(s) => { put(s.root, 'src/a.js', 'edited\n'); git(s.root, 'commit', '-qam', 'more'); }, 'head'],
    'new branch': [(s) => git(s.root, 'branch', 'other'), 'refs'],
    'new tag': [(s) => git(s.root, 'tag', 'v1'), 'refs'],
    'switch branch': [(s) => git(s.root, 'checkout', '-q', '-b', 'other'), 'git:HEAD'],
    'repository config': [(s) => git(s.root, 'config', 'core.hooksPath', 'elsewhere'), 'git:config'],
    'new hook': [(s) => put(s.root, '.git/hooks/pre-commit', '#!/bin/sh\n'), 'git:hooks/pre-commit'],
    'exclude file': [(s) => put(s.root, '.git/info/exclude', 'secret\n'), 'git:info/exclude'],
    'another worktree': [(s) => git(s.root, 'worktree', 'add', '-q', '--detach', path.join(s.base, 'other')), 'git:worktrees/other/HEAD'],
    'alternates file': [(s) => put(s.root, '.git/objects/info/alternates', 'elsewhere\n'), 'git:objects/info/alternates'],
    'mark a file as unchanged': [(s) => git(s.root, 'update-index', '--assume-unchanged', 'src/a.js'), 'staged'],
  };
  if (process.platform !== 'win32') {
    cases['file mode of a git file'] = [(s) => fs.chmodSync(path.join(s.root, '.git/HEAD'), 0o755), 'git:HEAD'];
  }
  for (const [name, [change, expected]] of Object.entries(cases)) {
    await t.test(name, (st) => {
      const s = setup(st);
      put(s.root, 'src/dirty.js', 'first\n');
      const before = sourceFingerprint(s.root);
      change(s);
      const differences = compareFingerprints(before, sourceFingerprint(s.root));
      assert.ok(differences.includes(expected), `${expected} not in ${JSON.stringify(differences)}`);
    });
  }
});

test('workflow workspace: an edit to a tracked file that git status is told to ignore is still found', async (t) => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    await t.test(flag, (st) => {
      const s = setup(st);
      git(s.root, 'update-index', flag, 'src/a.js');
      const before = sourceFingerprint(s.root);
      put(s.root, 'src/a.js', 'hidden edit\n');
      assert.equal(git(s.root, 'status', '--porcelain'), '', 'git status must hide the edit for this test to mean anything');
      assert.deepEqual(compareFingerprints(before, sourceFingerprint(s.root)), ['uncommitted:src/a.js']);
    });
  }
});

test('workflow workspace: activity that does not change the repository state leaves the fingerprint the same', (t) => {
  const s = setup(t);
  put(s.root, 'src/a.js', 'uncommitted\n');
  const before = sourceFingerprint(s.root);
  const index = fs.readFileSync(path.join(s.root, '.git/index'));
  touchLater(s.root, 'src/b.js');
  git(s.root, 'status');
  assert.notDeepEqual(fs.readFileSync(path.join(s.root, '.git/index')), index, 'status must rewrite the index for this test to mean anything');
  git(s.root, 'hash-object', '-w', 'src/a.js');
  put(s.root, '.git/refs/heads/stale.lock', '');
  put(s.root, '.git/index.lock', '');
  const after2 = sourceFingerprint(s.root);
  fs.rmSync(path.join(s.root, '.git/index.lock'));
  assert.deepEqual(compareFingerprints(before, after2), []);
});

test('workflow workspace: on systems with file links a changed link target is found by the fingerprint', { skip: process.platform === 'win32' ? 'needs real symbolic links' : false }, (t) => {
  const s = setup(t);
  fs.symlinkSync('one', path.join(s.root, 'src/link'));
  const before = sourceFingerprint(s.root);
  fs.rmSync(path.join(s.root, 'src/link'));
  fs.symlinkSync('two', path.join(s.root, 'src/link'));
  assert.deepEqual(compareFingerprints(before, sourceFingerprint(s.root)), ['uncommitted:src/link']);
});

test('workflow workspace: a file named like an object property is still compared', (t) => {
  const s = setup(t);
  const before = sourceFingerprint(s.root);
  put(s.root, '__proto__', 'x\n');
  const differences = compareFingerprints(before, sourceFingerprint(s.root));
  assert.deepEqual(differences, ['uncommitted:__proto__']);
});

test('workflow workspace: changes inside the write paths are listed without violations', (t) => {
  const s = worktreeOf(t);
  put(s.w.path, 'src/a.js', 'changed\n');
  put(s.w.path, 'src/new/file.js', 'new\n');
  fs.rmSync(path.join(s.w.path, 'src/b.js'));
  const r = check(s);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(Object.fromEntries(r.changes.map((c) => [c.path, c.status])), { 'src/a.js': 'M', 'src/new/file.js': 'A', 'src/b.js': 'D' });
});

test('workflow workspace: a worktree without changes has no changes and no violations', (t) => {
  const s = worktreeOf(t);
  assert.deepEqual(check(s), { changes: [], violations: [] });
});

test('workflow workspace: changes, new files and deletions outside the write paths are violations', (t) => {
  const s = worktreeOf(t);
  put(s.w.path, 'docs/guide.md', 'changed\n');
  put(s.w.path, 'other/new.js', 'new\n');
  fs.rmSync(path.join(s.w.path, 'test/old.test.js'));
  put(s.w.path, 'srcfile.js', 'a name that only starts like src\n');
  assert.deepEqual(reasons(check(s)), {
    'docs/guide.md': 'outside-write-paths',
    'other/new.js': 'outside-write-paths',
    'test/old.test.js': 'outside-write-paths',
    'srcfile.js': 'outside-write-paths',
  });
});

test('workflow workspace: protected paths win over write paths and the runtime protected paths always apply', (t) => {
  const s = worktreeOf(t);
  put(s.w.path, 'test/old.test.js', 'weakened\n');
  put(s.w.path, 'test/keep/x.js', 'new\n');
  put(s.w.path, 'test/new.test.js', 'allowed\n');
  put(s.w.path, '.agents/skills/x.md', 'new\n');
  put(s.w.path, '.codex/config.toml', 'new\n');
  const r = check(s, { writePaths: ['.'], protectedPaths: ['test/old.test.js', 'test/keep'] });
  assert.deepEqual(reasons(r), {
    'test/old.test.js': 'protected-path',
    'test/keep/x.js': 'protected-path',
    '.agents/skills/x.md': 'protected-path',
    '.codex/config.toml': 'protected-path',
  });
});

test('workflow workspace: a rename is checked at both its old and its new path', (t) => {
  const s = worktreeOf(t);
  git(s.root, 'config', 'diff.renames', 'false');
  git(s.w.path, 'mv', 'src/a.js', 'src/moved-a.js');
  fs.mkdirSync(path.join(s.w.path, 'other'));
  git(s.w.path, 'mv', 'src/b.js', 'other/b.js');
  fs.renameSync(path.join(s.w.path, 'docs/guide.md'), path.join(s.w.path, 'src/guide.md'));
  const r = check(s);
  const byPath = Object.fromEntries(r.changes.map((c) => [c.path, c]));
  assert.deepEqual(byPath['src/moved-a.js'], { status: 'R', oldPath: 'src/a.js', path: 'src/moved-a.js' });
  assert.deepEqual(byPath['other/b.js'], { status: 'R', oldPath: 'src/b.js', path: 'other/b.js' });
  assert.deepEqual(byPath['src/guide.md'], { status: 'R', oldPath: 'docs/guide.md', path: 'src/guide.md' });
  assert.deepEqual(reasons(r), { 'other/b.js': 'outside-write-paths', 'docs/guide.md': 'outside-write-paths' });
});

test('workflow workspace: a change that was committed inside the worktree is still found', (t) => {
  const s = worktreeOf(t);
  put(s.w.path, 'docs/guide.md', 'changed\n');
  git(s.w.path, 'add', '-A');
  git(s.w.path, 'commit', '-qm', 'hide it in a commit');
  assert.deepEqual(reasons(check(s)), { 'docs/guide.md': 'outside-write-paths' });
});

test('workflow workspace: new ignored files are listed and checked like other new files', (t) => {
  const s = worktreeOf(t);
  put(s.w.path, 'src/inside.log', 'x\n');
  put(s.w.path, 'other/outside.log', 'x\n');
  const r = check(s);
  const byPath = Object.fromEntries(r.changes.map((c) => [c.path, c]));
  assert.deepEqual(byPath['src/inside.log'], { status: 'A', path: 'src/inside.log', ignored: true });
  assert.deepEqual(byPath['other/outside.log'], { status: 'A', path: 'other/outside.log', ignored: true });
  assert.deepEqual(reasons(r), { 'other/outside.log': 'outside-write-paths' });
});

test('workflow workspace: changing .gitignore does not hide a new file', (t) => {
  const s = worktreeOf(t);
  put(s.w.path, '.gitignore', '*.log\nother/\n');
  put(s.w.path, 'other/hidden.js', 'x\n');
  assert.deepEqual(reasons(check(s)), { '.gitignore': 'outside-write-paths', 'other/hidden.js': 'outside-write-paths' });
});

test('workflow workspace: checking leaves the index and the status of the worktree alone', (t) => {
  const s = worktreeOf(t);
  put(s.w.path, 'src/a.js', 'changed\n');
  put(s.w.path, 'src/new.js', 'new\n');
  const status = git(s.w.path, 'status', '--porcelain');
  check(s);
  resultPatch(s.w.path, s.baseCommit);
  assert.equal(git(s.w.path, 'status', '--porcelain'), status);
  assert.equal(git(s.w.path, 'diff', '--cached', '--name-only'), '');
});

test('workflow workspace: the temporary index is removed after a check, also when git fails', (t) => {
  const s = worktreeOf(t);
  const temp = path.join(s.base, 'temp');
  fs.mkdirSync(temp);
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { TMPDIR: temp, TEMP: temp, TMP: temp });
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
  put(s.w.path, 'src/a.js', 'changed\n');
  assert.equal(listChanges(s.w.path, s.baseCommit).length, 1);
  assert.deepEqual(fs.readdirSync(temp), []);
  assert.throws(() => listChanges(s.w.path, '0'.repeat(40)), (err) => err.code === 'E_WORKFLOW_WORKSPACE');
  assert.deepEqual(fs.readdirSync(temp), []);
});

test('workflow workspace: a changed .git file of the worktree is a violation and git is not run there', (t) => {
  const s = worktreeOf(t);
  put(s.w.path, 'docs/guide.md', 'changed\n');
  fs.rmSync(path.join(s.w.path, '.git'));
  fs.writeFileSync(path.join(s.w.path, '.git'), `gitdir: ${path.join(s.base, 'elsewhere')}\n`);
  assert.deepEqual(check(s), { changes: [], violations: [{ path: '.git', reason: 'git-file-changed' }] });
  fs.rmSync(path.join(s.w.path, '.git'));
  fs.mkdirSync(path.join(s.w.path, '.git'));
  assert.deepEqual(check(s).violations, [{ path: '.git', reason: 'git-file-changed' }]);
});

test('workflow workspace: a new link that points outside the worktree is a violation', (t) => {
  const s = worktreeOf(t);
  const outside = path.join(s.base, 'outside');
  fs.mkdirSync(outside);
  put(outside, 'present.js', 'x\n');
  const link = path.join(s.w.path, 'src/out');
  if (!tryLink(outside, link)) {
    t.skip('this environment cannot create links');
    return;
  }
  const found = check(s).violations.filter((v) => v.reason === 'link-outside-worktree');
  assert.equal(found.length, 1);
  assert.match(found[0].path, /^src\/out(\/present\.js)?$/);
  assert.equal(found[0].status, 'A');
});

test('workflow workspace: a new link that stays inside the worktree is not a violation', (t) => {
  const s = worktreeOf(t);
  fs.mkdirSync(path.join(s.w.path, 'src/sub'));
  put(s.w.path, 'src/sub/file.js', 'x\n');
  const link = path.join(s.w.path, 'src/in');
  if (!tryLink(path.join(s.w.path, 'src/sub'), link)) {
    t.skip('this environment cannot create links');
    return;
  }
  assert.deepEqual(check(s).violations, []);
});

test('workflow workspace: on systems with file links a chain, a relative escape, a dangling link and a loop are violations', { skip: process.platform === 'win32' ? 'needs real symbolic links' : false }, (t) => {
  const s = worktreeOf(t);
  const outside = path.join(s.base, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(s.w.path, 'src/first'));
  fs.symlinkSync('first', path.join(s.w.path, 'src/second'));
  fs.symlinkSync('../../../../outside', path.join(s.w.path, 'src/relative'));
  fs.symlinkSync('/nonexistent/agent-layers', path.join(s.w.path, 'src/dangling'));
  fs.symlinkSync('missing-inside', path.join(s.w.path, 'src/dangling-inside'));
  fs.rmSync(path.join(s.w.path, 'src/b.js'));
  fs.symlinkSync(outside, path.join(s.w.path, 'src/b.js'));
  fs.symlinkSync('loop', path.join(s.w.path, 'src/loop'));
  const r = check(s);
  assert.deepEqual(reasons(r), {
    'src/first': 'link-outside-worktree',
    'src/second': 'link-outside-worktree',
    'src/relative': 'link-outside-worktree',
    'src/dangling': 'link-outside-worktree',
    'src/dangling-inside': 'link-outside-worktree',
    'src/b.js': 'link-outside-worktree',
    'src/loop': 'link-outside-worktree',
  });
  assert.equal(r.changes.find((c) => c.path === 'src/b.js').status, 'T');
  assert.equal(pathInsideWorktree(s.w.path, 'src/loop/below.js'), false);
});

test('workflow workspace: the real path check uses the nearest existing parent for new paths', (t) => {
  const s = worktreeOf(t);
  assert.equal(pathInsideWorktree(s.w.path, 'src/a.js'), true);
  assert.equal(pathInsideWorktree(s.w.path, 'src/not/yet/there.js'), true);
  assert.equal(pathInsideWorktree(s.w.path, '..foo/bar.js'), true);
  put(s.w.path, '..foo/bar.js', 'a folder name that only starts with two dots\n');
  assert.equal(pathInsideWorktree(s.w.path, '..foo/bar.js'), true);
  assert.equal(pathInsideWorktree(s.w.path, '.'), true);
  assert.equal(pathInsideWorktree(s.w.path, '..'), false);
  assert.equal(pathInsideWorktree(s.w.path, '../outside.js'), false);
  assert.equal(pathInsideWorktree(s.w.path, 'src/../../outside.js'), false);
  assert.equal(pathInsideWorktree(s.w.path, path.join(s.base, 'repo/src/a.js')), false);
  assert.equal(pathInsideWorktree(s.w.path, 'src/a.js/below-a-file.js'), true);
});

test('workflow workspace: the real path check follows a link out of the worktree for existing and new paths', (t) => {
  const s = worktreeOf(t);
  const outside = path.join(s.base, 'outside');
  fs.mkdirSync(outside);
  put(outside, 'present.js', 'x\n');
  if (!tryLink(outside, path.join(s.w.path, 'src/out'))) {
    t.skip('this environment cannot create links');
    return;
  }
  assert.equal(pathInsideWorktree(s.w.path, 'src/out'), false);
  assert.equal(pathInsideWorktree(s.w.path, 'src/out/present.js'), false);
  assert.equal(pathInsideWorktree(s.w.path, 'src/out/new/file.js'), false);
});

test('workflow workspace: the result patch rebuilds the same files on a clean copy of the base commit', (t) => {
  const s = worktreeOf(t);
  const binary = Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 13, 0]);
  put(s.w.path, 'src/a.js', 'changed\n');
  put(s.w.path, 'src/new.js', 'new\n');
  put(s.w.path, 'src/data.bin', binary);
  fs.rmSync(path.join(s.w.path, 'src/b.js'));
  fs.renameSync(path.join(s.w.path, 'docs/guide.md'), path.join(s.w.path, 'docs/renamed.md'));
  put(s.w.path, 'src/ignored.log', 'not part of the patch\n');
  git(s.root, 'config', 'color.ui', 'always');
  git(s.root, 'config', 'diff.noprefix', 'true');
  git(s.root, 'config', 'diff.external', 'agent-layers-no-such-diff-program');
  git(s.root, 'config', 'diff.shout.textconv', 'agent-layers-no-such-diff-program');
  put(s.root, '.git/info/attributes', '*.js diff=shout\n');
  const patch = resultPatch(s.w.path, s.baseCommit);
  assert.ok(Buffer.isBuffer(patch));
  assert.doesNotMatch(patch.toString('latin1'), /^rename from /m);

  const copy = path.join(s.base, 'copy');
  git(s.root, 'worktree', 'add', '-q', '--detach', copy, s.baseCommit);
  const patchFile = path.join(s.base, 'result.patch');
  fs.writeFileSync(patchFile, patch);
  git(copy, 'apply', '--binary', patchFile);
  assert.equal(fs.readFileSync(path.join(copy, 'src/a.js'), 'utf8'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(copy, 'src/new.js'), 'utf8'), 'new\n');
  assert.deepEqual(fs.readFileSync(path.join(copy, 'src/data.bin')), binary);
  assert.equal(fs.existsSync(path.join(copy, 'src/b.js')), false);
  assert.equal(fs.existsSync(path.join(copy, 'docs/guide.md')), false);
  assert.equal(fs.readFileSync(path.join(copy, 'docs/renamed.md'), 'utf8'), 'guide\n');
  assert.equal(fs.existsSync(path.join(copy, 'src/ignored.log')), false);
});

test('workflow workspace: a commit inside the worktree is part of the patch, and no change gives an empty patch', (t) => {
  const s = worktreeOf(t);
  assert.equal(resultPatch(s.w.path, s.baseCommit).length, 0);
  put(s.w.path, 'src/a.js', 'committed\n');
  git(s.w.path, 'commit', '-qam', 'work');
  assert.match(resultPatch(s.w.path, s.baseCommit).toString('utf8'), /\+committed/);
});

test('workflow workspace: the size report counts files and the worktree is kept', (t) => {
  const s = worktreeOf(t);
  const first = describeWorktree(s.w.path);
  assert.equal(first.path, s.w.path);
  assert.ok(first.bytes > 0);
  put(s.w.path, 'src/big.bin', Buffer.alloc(5000));
  assert.equal(describeWorktree(s.w.path).bytes, first.bytes + 5000);
  check(s);
  resultPatch(s.w.path, s.baseCommit);
  assert.equal(fs.existsSync(path.join(s.w.path, 'src/big.bin')), true);
});
