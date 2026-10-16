import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, which } from '../util/proc.js';
import { readText, writeTextAtomic, tryChmod } from '../util/fsx.js';
import { parseJsonc, stringifyJson } from '../formats/jsonc.js';
import { secretEnvName } from '../template.js';

const WINCRED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wincred.ps1');
const NAME_RE = /^[A-Za-z0-9_./-]+$/;

export function validateName(name) {
  if (!NAME_RE.test(name || '')) {
    throw new Error(`invalid secret name "${name}"; use letters, digits and _ . / -`);
  }
}

function service(ctx) {
  return ctx.manifestOptions?.secrets?.service || ctx.config.secrets?.service || 'agent-layers';
}

function target(ctx, name) {
  return `${service(ctx)}:${name}`;
}

function powershell() {
  return which('powershell.exe') || which('pwsh.exe') || 'powershell.exe';
}

const keychain = {
  id: 'keychain',
  available() {
    if (process.platform === 'win32') {
      return true;
    }
    if (process.platform === 'darwin') {
      return Boolean(which('security'));
    }
    return Boolean(which('secret-tool'));
  },
  get(ctx, name) {
    if (process.platform === 'win32') {
      const r = run(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINCRED, 'get', target(ctx, name)], { timeout: 30000 });
      return r.code === 0 ? r.stdout : null;
    }
    if (process.platform === 'darwin') {
      const r = run('security', ['find-generic-password', '-s', service(ctx), '-a', name, '-w']);
      return r.code === 0 ? r.stdout.replace(/\n$/, '') : null;
    }
    const r = run('secret-tool', ['lookup', 'service', service(ctx), 'account', name]);
    return r.code === 0 ? r.stdout : null;
  },
  getMany(ctx, names) {
    if (process.platform !== 'win32') {
      return Object.fromEntries(names.map((n) => [n, this.get(ctx, n)]).filter(([, v]) => v !== null));
    }
    const r = run(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINCRED, 'getmany', ''], { input: names.map((n) => target(ctx, n)).join('\n'), timeout: 30000 });
    if (r.code !== 0 || !r.stdout.trim()) {
      return {};
    }
    const raw = JSON.parse(r.stdout);
    const out = {};
    for (const n of names) {
      if (raw[target(ctx, n)] !== undefined) {
        out[n] = raw[target(ctx, n)];
      }
    }
    return out;
  },
  set(ctx, name, value) {
    if (process.platform === 'win32') {
      const r = run(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINCRED, 'set', target(ctx, name)], { input: value, timeout: 30000 });
      if (r.code !== 0) {
        throw new Error(`Windows Credential Manager write failed: ${r.stderr.trim()}`);
      }
      return;
    }
    if (process.platform === 'darwin') {
      const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      const r = run('security', ['-i'], { input: `add-generic-password -U -s ${q(service(ctx))} -a ${q(name)} -w ${q(value)}\n` });
      if (r.code !== 0) {
        throw new Error(`macOS Keychain write failed: ${r.stderr.trim()}`);
      }
      return;
    }
    const r = run('secret-tool', ['store', `--label=${service(ctx)} ${name}`, 'service', service(ctx), 'account', name], { input: value });
    if (r.code !== 0) {
      throw new Error(`secret-tool store failed: ${r.stderr.trim()}`);
    }
  },
  delete(ctx, name) {
    if (process.platform === 'win32') {
      return run(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINCRED, 'delete', target(ctx, name)]).code === 0;
    }
    if (process.platform === 'darwin') {
      return run('security', ['delete-generic-password', '-s', service(ctx), '-a', name]).code === 0;
    }
    return run('secret-tool', ['clear', 'service', service(ctx), 'account', name]).code === 0;
  },
  list(ctx) {
    if (process.platform === 'win32') {
      const r = run(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINCRED, 'list', `${service(ctx)}:*`]);
      return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean).map((t) => t.slice(service(ctx).length + 1)) : [];
    }
    return null;
  },
};

const fileBackend = {
  id: 'file',
  available: () => true,
  file: (ctx) => path.join(ctx.paths.stateDir, 'secrets.json'),
  read(ctx) {
    const r = readText(this.file(ctx));
    return r ? parseJsonc(r.text) : {};
  },
  get(ctx, name) {
    const v = this.read(ctx)[name];
    return v === undefined ? null : v;
  },
  getMany(ctx, names) {
    const all = this.read(ctx);
    return Object.fromEntries(names.filter((n) => all[n] !== undefined).map((n) => [n, all[n]]));
  },
  set(ctx, name, value) {
    const all = this.read(ctx);
    all[name] = value;
    this.write(ctx, all);
  },
  write(ctx, all) {
    const f = this.file(ctx);
    writeTextAtomic(f, stringifyJson(all), { mode: 0o600 });
    tryChmod(f, 0o600);
  },
  delete(ctx, name) {
    const all = this.read(ctx);
    const had = name in all;
    delete all[name];
    this.write(ctx, all);
    return had;
  },
  list(ctx) {
    return Object.keys(this.read(ctx));
  },
};

const onePassword = {
  id: '1password',
  available: () => Boolean(which('op')),
  get(ctx, name) {
    const ref = ctx.config.secrets?.map?.[name] || ctx.manifestOptions?.secrets?.map?.[name];
    if (!ref) {
      return null;
    }
    const r = run('op', ['read', '--no-newline', ref], { timeout: 60000 });
    return r.code === 0 ? r.stdout : null;
  },
  getMany(ctx, names) {
    return Object.fromEntries(names.map((n) => [n, this.get(ctx, n)]).filter(([, v]) => v !== null));
  },
  set() {
    throw new Error('1Password secrets are managed in 1Password; map names to op:// references in config "secrets.map"');
  },
  delete() {
    return false;
  },
  list(ctx) {
    return Object.keys(ctx.config.secrets?.map || {});
  },
};

const BACKENDS = { keychain, file: fileBackend, '1password': onePassword };

export function backendFor(ctx) {
  const wanted = ctx.config.secrets?.backend || ctx.manifestOptions?.secrets?.backend || 'auto';
  if (wanted !== 'auto') {
    const b = BACKENDS[wanted];
    if (!b) {
      throw new Error(`unknown secrets backend "${wanted}" (use keychain, 1password or file)`);
    }
    return b;
  }
  if (keychain.available()) {
    return keychain;
  }
  throw new Error('no OS keychain is available (on Linux install libsecret "secret-tool"). To store secrets in a plain-text file instead, set "secrets": { "backend": "file" } in ~/.agent-layers/config.jsonc');
}

function envOverride(ctx, name) {
  const key = `AGENT_LAYERS_SECRET_${secretEnvName(name)}`;
  return ctx.env[key] !== undefined ? ctx.env[key] : null;
}

export function getSecret(ctx, name) {
  validateName(name);
  const fromEnv = envOverride(ctx, name);
  if (fromEnv !== null) {
    return fromEnv;
  }
  const mapped = ctx.config.secrets?.map?.[name] || ctx.manifestOptions?.secrets?.map?.[name];
  if (mapped && String(mapped).startsWith('op://')) {
    return onePassword.get(ctx, name);
  }
  return backendFor(ctx).get(ctx, name);
}

export function getSecrets(ctx, names) {
  const out = {};
  const rest = [];
  for (const n of names) {
    validateName(n);
    const fromEnv = envOverride(ctx, n);
    const mapped = ctx.config.secrets?.map?.[n] || ctx.manifestOptions?.secrets?.map?.[n];
    if (fromEnv !== null) {
      out[n] = fromEnv;
    } else if (mapped && String(mapped).startsWith('op://')) {
      const v = onePassword.get(ctx, n);
      if (v !== null) {
        out[n] = v;
      }
    } else {
      rest.push(n);
    }
  }
  if (rest.length) {
    Object.assign(out, backendFor(ctx).getMany(ctx, rest));
  }
  return out;
}

export function setSecret(ctx, name, value) {
  validateName(name);
  backendFor(ctx).set(ctx, name, value);
}

export function deleteSecret(ctx, name) {
  validateName(name);
  return backendFor(ctx).delete(ctx, name);
}

export function listSecrets(ctx) {
  return backendFor(ctx).list(ctx);
}
