import fs from 'node:fs';
import path from 'node:path';
import { run } from '../util/proc.js';

function canCheckFiles(git, files) {
  const configured = git(['config', '--name-only', '--get-regexp', '^filter\\..*\\.(process|clean)$']);
  if (configured.code !== 0) {
    return configured.code === 1;
  }
  const drivers = new Set(configured.stdout.trim().split('\n').map((key) => key.slice(7, key.lastIndexOf('.'))));
  const attrs = git(['check-attr', '--stdin', '-z', 'filter'], files.map((f) => f + '\0').join(''));
  return attrs.code === 0 && !attrs.stdout.split('\0').some((value, i) => i % 3 === 2 && drivers.has(value));
}

function workingTreeDirty(runGit, root, visited) {
  if (visited.has(root)) {
    return null;
  }
  visited.add(root);
  const git = (args, input) => runGit(root, args, input);
  const index = git(['ls-files', '--stage', '-z']);
  if (index.code !== 0 || index.stdout.includes('\uFFFD')) {
    return null;
  }
  const entries = index.stdout.split('\0').filter(Boolean);
  const fileOf = (entry) => entry.slice(entry.indexOf('\t') + 1);
  if (!canCheckFiles(git, entries.map(fileOf))) {
    return null;
  }
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=dirty']);
  if (status.code !== 0 || status.stdout.length) {
    return status.code === 0 ? true : null;
  }
  let dirty = false;
  for (const entry of entries.filter((line) => line.startsWith('160000 '))) {
    const sub = path.join(root, fileOf(entry));
    try {
      fs.lstatSync(path.join(sub, '.git'));
      if (fs.lstatSync(sub).isSymbolicLink()) {
        dirty = null;
        continue;
      }
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
        dirty = null;
      }
      continue;
    }
    const subDirty = workingTreeDirty(runGit, sub, visited);
    if (subDirty === true) {
      return true;
    }
    if (subDirty === null) {
      dirty = null;
    }
  }
  return dirty;
}

export function sourceRevision(ctx, id, dir) {
  const env = { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'TMP', 'TEMP', 'TMPDIR']) {
    if (ctx.env[key] !== undefined) {
      env[key] = ctx.env[key];
    }
  }
  const git = (cwd, args, input) => run('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { env, input, timeout: 10000 });
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) {
    return { id, commit: null, dirty: null };
  }
  const root = path.resolve(top.stdout.replace(/\r?\n$/, ''));
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const commit = head.stdout.trim();
  return {
    id,
    commit: head.code === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) ? commit : null,
    dirty: workingTreeDirty(git, root, new Set()),
  };
}
