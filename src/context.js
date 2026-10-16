import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './formats/jsonc.js';
import { readText, isDir, isFile } from './util/fsx.js';

export const OS_NAME = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] || process.platform;

export function osName() {
  return OS_NAME;
}

export function resolvePaths({ home, env = process.env, sandbox = false } = {}) {
  const h = home || os.homedir();
  const isWin = process.platform === 'win32';
  const pick = (name, fallback) => (!sandbox && env[name] ? env[name] : fallback);
  const appData = isWin ? pick('APPDATA', path.join(h, 'AppData', 'Roaming')) : path.join(h, '.config');
  const localAppData = isWin ? pick('LOCALAPPDATA', path.join(h, 'AppData', 'Local')) : path.join(h, '.local', 'share');
  const xdgConfig = pick('XDG_CONFIG_HOME', path.join(h, '.config'));
  const documents = path.join(h, 'Documents');
  return {
    home: h,
    appData,
    localAppData,
    xdgConfig,
    documents,
    agentsHome: path.join(h, '.agents'),
    claudeHome: pick('CLAUDE_CONFIG_DIR', path.join(h, '.claude')),
    claudeJson: !sandbox && env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(h, '.claude.json'),
    codexHome: pick('CODEX_HOME', path.join(h, '.codex')),
    geminiHome: pick('GEMINI_CLI_HOME', path.join(h, '.gemini')),
    copilotHome: pick('COPILOT_HOME', path.join(h, '.copilot')),
    stateDir: pick('AGENT_LAYERS_HOME', path.join(h, '.agent-layers')),
  };
}

export function createContext(opts = {}) {
  const env = opts.env || process.env;
  const sandboxHome = opts.home || env.AGENT_LAYERS_TARGET_HOME || null;
  const paths = resolvePaths({ home: sandboxHome || undefined, env, sandbox: Boolean(sandboxHome) });
  const configFile = path.join(paths.stateDir, 'config.jsonc');
  const cfgText = readText(configFile);
  const config = cfgText ? parseJsonc(cfgText.text, configFile) : {};
  const sourceDir = path.resolve(opts.source || env.AGENT_LAYERS_SOURCE || config.source || path.join(paths.stateDir, 'source'));
  return {
    env,
    os: OS_NAME,
    sandbox: Boolean(sandboxHome),
    paths,
    configFile,
    config,
    sourceDir,
    hostname: os.hostname(),
    user: os.userInfo().username,
    nodePath: process.execPath,
    cliPath: fileURLToPath(new URL('../bin/agent-layers.js', import.meta.url)),
    cwd: path.resolve(opts.cwd || process.cwd()),
    flags: opts.flags || {},
  };
}

export function hasSource(ctx) {
  return isDir(ctx.sourceDir) && (isFile(path.join(ctx.sourceDir, 'agent-layers.jsonc')) || isFile(path.join(ctx.sourceDir, 'agent-layers.json')));
}

export function builtinVars(ctx, extra = {}) {
  return {
    home: ctx.paths.home,
    os: ctx.os,
    hostname: ctx.hostname,
    user: ctx.user,
    sep: path.sep,
    source: ctx.sourceDir,
    node: ctx.nodePath,
    agentLayers: ctx.cliPath,
    appData: ctx.paths.appData,
    localAppData: ctx.paths.localAppData,
    xdgConfig: ctx.paths.xdgConfig,
    claudeHome: ctx.paths.claudeHome,
    codexHome: ctx.paths.codexHome,
    geminiHome: ctx.paths.geminiHome,
    copilotHome: ctx.paths.copilotHome,
    ...extra,
  };
}
