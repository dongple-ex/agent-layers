import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../util/fsx.js';
import { pathCovers, RUNTIME_PROTECTED_PATHS } from './schema.js';
import { runDir } from './store.js';

const MAX_GIT_OUTPUT = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const REPOSITORY_LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX'];
const OBJECT_STORAGE_RE = /^objects\/([0-9a-f]{2}|pack)$/;
const PATCH_OPTIONS = ['--binary', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];

function workspaceError(message, extra = {}) {
  return Object.assign(new Error(message), { code: 'E_WORKFLOW_WORKSPACE', ...extra });
}

function gitEnv(extra) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of REPOSITORY_LOCATION_VARS) {
    delete env[name];
  }
  return { ...env, ...extra };
}

function git(cwd, args, { env = {} } = {}) {
  const r = spawnSync('git', ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false', ...args], { cwd, env: gitEnv(env), maxBuffer: MAX_GIT_OUTPUT, windowsHide: true });
  if (r.error) {
    throw workspaceError(`git ${args[0]} could not run in ${cwd}: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw workspaceError(`git ${args[0]} failed in ${cwd}: ${r.stderr.toString('utf8').trim()}`, { exitCode: r.status });
  }
  return r.stdout;
}

function gitText(cwd, args) {
  return git(cwd, args).toString('utf8').replace(/\r?\n$/, '');
}

function splitNul(output) {
  return output.toString('utf8').split('\0').filter((f) => f !== '');
}

function hashRegularFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) {
        return hash.digest('hex');
      }
      hash.update(chunk.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
}

function contentHash(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return 'missing';
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    return `link:${sha256(fs.readlinkSync(file))}`;
  }
  if (st.isFile()) {
    return `${(st.mode & 0o777).toString(8)}:${hashRegularFile(file)}`;
  }
  return st.isDirectory() ? 'directory' : 'special';
}

export function workspaceKey(root) {
  return fs.realpathSync.native(path.resolve(root, gitText(root, ['rev-parse', '--git-common-dir'])));
}

function listUncommitted(root) {
  return splitNul(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])).map((f) => ({ status: f.slice(0, 2), path: f.slice(3) }));
}

export function inspectRepository(cwd) {
  const root = gitText(cwd, ['rev-parse', '--show-toplevel']);
  return {
    root: fs.realpathSync.native(root),
    baseCommit: gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}']),
    workspaceKey: workspaceKey(root),
    uncommitted: listUncommitted(root),
  };
}

export function worktreePath(ctx, runId) {
  runDir(ctx, runId);
  return path.join(ctx.paths.stateDir, 'worktrees', runId);
}

export function createWorktree(ctx, runId, { root, baseCommit }) {
  const dir = worktreePath(ctx, runId);
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  if (fs.lstatSync(path.dirname(dir)).isSymbolicLink()) {
    throw workspaceError(`${path.dirname(dir)} must be a real directory, not a link`, { code: 'E_WORKFLOW_UNSAFE_PATH' });
  }
  git(root, ['worktree', 'add', '--detach', '--quiet', dir, baseCommit]);
  return {
    path: fs.realpathSync.native(dir),
    name: path.basename(gitText(dir, ['rev-parse', '--absolute-git-dir'])),
    baseCommit: gitText(dir, ['rev-parse', 'HEAD']),
    gitFileHash: contentHash(path.join(dir, '.git')),
  };
}

function skipGitEntry(name, ownWorktree) {
  return name === 'index' || OBJECT_STORAGE_RE.test(name) || name.endsWith('.lock') || name === `worktrees/${ownWorktree}`;
}

function hashGitDir(commonDir, ownWorktree) {
  const entries = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (skipGitEntry(name, ownWorktree)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${name}/`);
      } else {
        entries.push([name, contentHash(path.join(dir, entry.name))]);
      }
    }
  };
  walk(commonDir, '');
  return Object.fromEntries(entries);
}

function listHiddenFromStatus(root) {
  return splitNul(git(root, ['ls-files', '-v', '-z'])).filter((line) => /^[a-zS]/.test(line)).map((line) => line.slice(2));
}

export function sourceFingerprint(root, { ownWorktree = null } = {}) {
  return {
    head: gitText(root, ['rev-parse', 'HEAD']),
    refs: gitText(root, ['for-each-ref', '--format=%(objectname) %(refname)']),
    staged: sha256(git(root, ['ls-files', '--stage', '-v', '-z'])),
    uncommitted: Object.fromEntries([
      ...listUncommitted(root).map((c) => [c.path, `${c.status}:${contentHash(path.join(root, c.path))}`]),
      ...listHiddenFromStatus(root).map((p) => [p, `hidden:${contentHash(path.join(root, p))}`]),
    ]),
    gitFiles: hashGitDir(workspaceKey(root), ownWorktree),
  };
}

export function compareFingerprints(before, after) {
  const differences = ['head', 'refs', 'staged'].filter((key) => before[key] !== after[key]);
  for (const [prefix, a, b] of [['uncommitted', before.uncommitted, after.uncommitted], ['git', before.gitFiles, after.gitFiles]]) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[key] !== b[key]) {
        differences.push(`${prefix}:${key}`);
      }
    }
  }
  return differences;
}

function withTemporaryIndex(worktree, baseCommit, use) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-index-'));
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    git(worktree, ['read-tree', baseCommit], { env });
    git(worktree, ['add', '--all'], { env });
    return use(env);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function listChanges(worktree, baseCommit) {
  return withTemporaryIndex(worktree, baseCommit, (env) => {
    const fields = splitNul(git(worktree, ['diff', '--cached', '--name-status', '-z', '-M', baseCommit], { env }));
    const changes = [];
    for (let i = 0; i < fields.length;) {
      const status = fields[i][0];
      if (status === 'R' || status === 'C') {
        changes.push({ status, oldPath: fields[i + 1], path: fields[i + 2] });
        i += 3;
      } else {
        changes.push({ status, path: fields[i + 1] });
        i += 2;
      }
    }
    for (const p of splitNul(git(worktree, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { env }))) {
      changes.push({ status: 'A', path: p, ignored: true });
    }
    return changes;
  });
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function pathInsideWorktree(worktree, relativePath) {
  const root = fs.realpathSync.native(worktree);
  let current = path.resolve(root, relativePath);
  for (;;) {
    try {
      fs.lstatSync(current);
      break;
    } catch (err) {
      if (err.code === 'ELOOP') {
        return false;
      }
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
        throw err;
      }
      current = path.dirname(current);
    }
  }
  try {
    return isInside(root, fs.realpathSync.native(current));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ELOOP') {
      return false;
    }
    throw err;
  }
}

function pathViolation(p, writePaths, protectedPaths) {
  if ([...RUNTIME_PROTECTED_PATHS, ...protectedPaths].some((base) => pathCovers(base, p))) {
    return 'protected-path';
  }
  return writePaths.some((base) => pathCovers(base, p)) ? null : 'outside-write-paths';
}

export function checkChanges(worktree, { baseCommit, gitFileHash, writePaths, protectedPaths }) {
  if (contentHash(path.join(worktree, '.git')) !== gitFileHash) {
    return { changes: [], violations: [{ path: '.git', reason: 'git-file-changed' }] };
  }
  const changes = listChanges(worktree, baseCommit);
  const violations = [];
  for (const change of changes) {
    for (const p of change.oldPath ? [change.oldPath, change.path] : [change.path]) {
      const reason = pathViolation(p, writePaths, protectedPaths);
      if (reason) {
        violations.push({ path: p, reason, status: change.status });
      }
    }
    if (!pathInsideWorktree(worktree, change.path)) {
      violations.push({ path: change.path, reason: 'link-outside-worktree', status: change.status });
    }
  }
  return { changes, violations };
}

export function resultPatch(worktree, baseCommit) {
  return withTemporaryIndex(worktree, baseCommit, (env) => git(worktree, ['diff', '--cached', ...PATCH_OPTIONS, baseCommit], { env }));
}

export function describeWorktree(worktree) {
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else {
        bytes += fs.lstatSync(file).size;
      }
    }
  };
  walk(worktree);
  return { path: worktree, bytes };
}
