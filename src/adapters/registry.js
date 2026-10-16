import path from 'node:path';

const j = path.join;
const winOr = (os, win, other) => (os === 'windows' ? win : other);

export const ADAPTERS = [
  {
    id: 'claude',
    name: 'Claude Code',
    checked: '2026-10-04',
    confidence: 'documented',
    detect: { commands: ['claude'], dirs: (p) => [p.claudeHome] },
    limits: { memoryIndexBytes: 25000 },
    user: {
      instructions: { always: { kind: 'files', dir: (p) => j(p.claudeHome, 'rules', 'agent-layers'), dialect: 'claude' }, scoped: { kind: 'files', dir: (p) => j(p.claudeHome, 'rules', 'agent-layers'), dialect: 'claude' } },
      skills: (p) => [j(p.claudeHome, 'skills')],
      commands: { dir: (p) => j(p.claudeHome, 'commands'), format: 'claude' },
      agents: { dir: (p) => j(p.claudeHome, 'agents'), format: 'claude' },
      mcp: { kind: 'claude-cli', scope: 'user', file: (p) => p.claudeJson, key: ['mcpServers'], format: 'claude', env: '${VAR}' },
      settings: { kind: 'json', file: (p) => j(p.claudeHome, 'settings.json') },
      files: (p) => p.claudeHome,
    },
    project: {
      always: { shared: { kind: 'claude-agents-shim' }, private: { kind: 'file', dir: (r) => j(r, '.claude', 'rules', 'agent-layers'), dialect: 'claude', prefix: 'project-' } },
      scoped: { kind: 'files', dir: (r) => j(r, '.claude', 'rules', 'agent-layers'), dialect: 'claude' },
      skills: (r) => [j(r, '.claude', 'skills')],
      commands: { dir: (r) => j(r, '.claude', 'commands'), format: 'claude' },
      agents: { dir: (r) => j(r, '.claude', 'agents'), format: 'claude' },
      mcp: { shared: { kind: 'json', file: (r) => j(r, '.mcp.json'), key: ['mcpServers'], format: 'claude', env: '${VAR}' }, private: { kind: 'claude-cli', scope: 'local' } },
      settings: { shared: { kind: 'json', file: (r) => j(r, '.claude', 'settings.json') }, private: { kind: 'json', file: (r) => j(r, '.claude', 'settings.local.json') } },
    },
  },
  {
    id: 'codex',
    name: 'OpenAI Codex (CLI, ChatGPT desktop app, IDE)',
    checked: '2026-10-04',
    confidence: 'documented',
    detect: { commands: ['codex'], dirs: (p) => [p.codexHome] },
    limits: { instructionsBytes: 32768 },
    user: {
      instructions: { always: { kind: 'block', file: (p) => j(p.codexHome, 'AGENTS.md') } },
      skills: (p) => [j(p.agentsHome, 'skills')],
      mcp: { kind: 'toml', file: (p) => j(p.codexHome, 'config.toml'), table: ['mcp_servers'], format: 'codex' },
      settings: { kind: 'toml', file: (p) => j(p.codexHome, 'config.toml') },
      files: (p) => p.codexHome,
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'toml-key', file: (r) => j(r, '.codex', 'config.toml'), key: ['developer_instructions'] } },
      skills: (r) => [j(r, '.agents', 'skills')],
      mcp: { shared: { kind: 'toml', file: (r) => j(r, '.codex', 'config.toml'), table: ['mcp_servers'], format: 'codex' }, private: { kind: 'toml', file: (r) => j(r, '.codex', 'config.toml'), table: ['mcp_servers'], format: 'codex' } },
      settings: { shared: { kind: 'toml', file: (r) => j(r, '.codex', 'config.toml') }, private: { kind: 'toml', file: (r) => j(r, '.codex', 'config.toml') } },
    },
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    checked: '2026-10-04',
    confidence: 'documented',
    detect: { commands: ['gemini'], dirs: (p) => [j(p.geminiHome, 'settings.json')] },
    notes: ['Gemini CLI no longer serves personal Google accounts since 2026-06-18; Antigravity CLI (agy) replaces it for them.'],
    user: {
      instructions: { always: { kind: 'block', file: (p) => j(p.geminiHome, 'GEMINI.md') } },
      skills: (p) => [j(p.agentsHome, 'skills')],
      commands: { dir: (p) => j(p.geminiHome, 'commands'), format: 'gemini' },
      mcp: { kind: 'json', file: (p) => j(p.geminiHome, 'settings.json'), key: ['mcpServers'], format: 'gemini', env: '${VAR}' },
      settings: { kind: 'json', file: (p) => j(p.geminiHome, 'settings.json') },
      impliedSettings: (opts) => (opts.gemini?.readAgentsMd ? { context: { fileName: ['AGENTS.md', 'GEMINI.md'] } } : null),
      files: (p) => p.geminiHome,
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'block-if-untracked', file: (r) => j(r, 'GEMINI.md') } },
      skills: (r) => [j(r, '.agents', 'skills')],
      commands: { dir: (r) => j(r, '.gemini', 'commands'), format: 'gemini' },
      mcp: { shared: { kind: 'json', file: (r) => j(r, '.gemini', 'settings.json'), key: ['mcpServers'], format: 'gemini', env: '${VAR}' }, private: { kind: 'json', file: (r) => j(r, '.gemini', 'settings.json'), key: ['mcpServers'], format: 'gemini', env: '${VAR}' } },
      settings: { shared: { kind: 'json', file: (r) => j(r, '.gemini', 'settings.json') }, private: { kind: 'json', file: (r) => j(r, '.gemini', 'settings.json') } },
    },
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity (2.0 app, IDE, agy CLI)',
    checked: '2026-10-04',
    confidence: 'documented',
    detect: { commands: ['agy', 'antigravity'], dirs: (p) => [j(p.geminiHome, 'config'), j(p.geminiHome, 'antigravity')] },
    limits: { ruleFileBytes: 24000 },
    user: {
      instructions: { always: { kind: 'block', file: (p) => j(p.geminiHome, 'GEMINI.md') }, scoped: { kind: 'files', dir: (p) => j(p.geminiHome, 'config', 'rules'), dialect: 'antigravity', prefix: 'agent-layers-' } },
      skills: (p) => [j(p.geminiHome, 'config', 'skills'), j(p.geminiHome, 'antigravity-cli', 'skills')],
      mcp: { kind: 'json', file: (p) => j(p.geminiHome, 'config', 'mcp_config.json'), key: ['mcpServers'], format: 'antigravity', env: null },
      files: (p) => j(p.geminiHome, 'config'),
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'file', dir: (r) => j(r, '.agents', 'rules'), dialect: 'antigravity', prefix: 'agent-layers-' } },
      scoped: { kind: 'files', dir: (r) => j(r, '.agents', 'rules'), dialect: 'antigravity', prefix: 'agent-layers-' },
      skills: (r) => [j(r, '.agents', 'skills')],
      mcp: { shared: { kind: 'json', file: (r) => j(r, '.agents', 'mcp_config.json'), key: ['mcpServers'], format: 'antigravity', env: null }, private: { kind: 'json', file: (r) => j(r, '.agents', 'mcp_config.json'), key: ['mcpServers'], format: 'antigravity', env: null } },
    },
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot (CLI and VS Code agent host)',
    checked: '2026-10-04',
    confidence: 'documented',
    detect: { commands: ['copilot'], dirs: (p) => [p.copilotHome] },
    notes: ['Copilot CLI and the cloud agent also read CLAUDE.md and GEMINI.md; keep those as thin pointers to avoid double-loading.', 'Copilot JetBrains and github.com personal instructions are not file based in the home directory used here.'],
    user: {
      instructions: { always: { kind: 'block', file: (p) => j(p.copilotHome, 'copilot-instructions.md') }, scoped: { kind: 'files', dir: (p) => j(p.copilotHome, 'instructions'), dialect: 'copilot', prefix: 'agent-layers-' } },
      skills: (p) => [j(p.agentsHome, 'skills')],
      mcp: { kind: 'json', file: (p) => j(p.copilotHome, 'mcp-config.json'), key: ['mcpServers'], format: 'copilot', env: null },
      files: (p) => p.copilotHome,
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'file', dir: (r) => j(r, '.github', 'instructions'), dialect: 'copilot', prefix: 'agent-layers-' } },
      scoped: { kind: 'files', dir: (r) => j(r, '.github', 'instructions'), dialect: 'copilot', prefix: 'agent-layers-' },
      skills: (r) => [j(r, '.agents', 'skills')],
      mcp: { shared: { kind: 'json', file: (r) => j(r, '.mcp.json'), key: ['mcpServers'], format: 'claude', env: '${VAR}' }, private: { kind: 'json', file: (r) => j(r, '.github', 'mcp.json'), key: ['mcpServers'], format: 'copilot', env: null } },
    },
  },
  {
    id: 'cursor',
    name: 'Cursor (IDE and CLI)',
    checked: '2026-10-04',
    confidence: 'windows-paths-unverified',
    detect: { commands: ['cursor', 'cursor-agent'], dirs: (p) => [j(p.home, '.cursor')] },
    notes: ['Cursor User Rules live in the Cursor account settings UI; agent-layers cannot write them.'],
    user: {
      skills: (p) => [j(p.agentsHome, 'skills')],
      mcp: { kind: 'json', file: (p) => j(p.home, '.cursor', 'mcp.json'), key: ['mcpServers'], format: 'cursor', env: '${env:VAR}' },
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'file', dir: (r) => j(r, '.cursor', 'rules'), dialect: 'cursor', prefix: 'agent-layers-' } },
      scoped: { kind: 'files', dir: (r) => j(r, '.cursor', 'rules'), dialect: 'cursor', prefix: 'agent-layers-' },
      skills: (r) => [j(r, '.agents', 'skills')],
      mcp: { shared: { kind: 'json', file: (r) => j(r, '.cursor', 'mcp.json'), key: ['mcpServers'], format: 'cursor', env: '${env:VAR}' }, private: { kind: 'json', file: (r) => j(r, '.cursor', 'mcp.json'), key: ['mcpServers'], format: 'cursor', env: '${env:VAR}' } },
    },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    checked: '2026-10-04',
    confidence: 'windows-paths-unverified',
    detect: { commands: ['opencode'], dirs: (p) => [j(p.xdgConfig, 'opencode')] },
    notes: ['OpenCode falls back to ~/.claude/CLAUDE.md when its own AGENTS.md is missing.'],
    user: {
      instructions: { always: { kind: 'block', file: (p) => j(p.xdgConfig, 'opencode', 'AGENTS.md') } },
      skills: (p) => [j(p.agentsHome, 'skills')],
      mcp: { kind: 'json', file: (p) => j(p.xdgConfig, 'opencode', 'opencode.json'), key: ['mcp'], format: 'opencode', env: '{env:VAR}' },
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'block-if-untracked', file: (r) => j(r, 'AGENTS.md') } },
      skills: (r) => [j(r, '.agents', 'skills')],
    },
  },
  {
    id: 'zed',
    name: 'Zed',
    checked: '2026-10-04',
    confidence: 'documented',
    detect: { commands: ['zed'], dirs: (p, os) => [winOr(os, j(p.appData, 'Zed'), j(p.xdgConfig, 'zed'))] },
    notes: ['Zed reads only the first match of .rules, .cursorrules, .windsurfrules, .clinerules, .github/copilot-instructions.md, AGENT.md, AGENTS.md, CLAUDE.md, GEMINI.md.'],
    user: {
      instructions: { always: { kind: 'block', file: (p, os) => winOr(os, j(p.appData, 'Zed', 'AGENTS.md'), j(p.xdgConfig, 'zed', 'AGENTS.md')) } },
      skills: (p) => [j(p.agentsHome, 'skills')],
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'block-if-untracked', file: (r) => j(r, 'AGENTS.md') } },
      skills: (r) => [j(r, '.agents', 'skills')],
    },
  },
  {
    id: 'junie',
    name: 'JetBrains Junie',
    checked: '2026-10-04',
    confidence: 'documented',
    detect: { commands: ['junie'], dirs: (p) => [j(p.home, '.junie')] },
    user: {
      instructions: { always: { kind: 'block', file: (p) => j(p.home, '.junie', 'AGENTS.md') } },
      skills: (p) => [j(p.agentsHome, 'skills')],
      mcp: { kind: 'json', file: (p) => j(p.home, '.junie', 'mcp', 'mcp.json'), key: ['mcpServers'], format: 'generic', env: null },
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'file', dir: (r) => j(r, '.junie', 'rules'), dialect: 'plain', prefix: 'agent-layers-' } },
      skills: (r) => [j(r, '.agents', 'skills')],
    },
  },
  {
    id: 'kiro',
    name: 'Kiro',
    checked: '2026-10-04',
    confidence: 'windows-paths-unverified',
    detect: { commands: ['kiro'], dirs: (p) => [j(p.home, '.kiro')] },
    user: {
      instructions: { always: { kind: 'files', dir: (p) => j(p.home, '.kiro', 'steering'), dialect: 'kiro', prefix: 'agent-layers-' }, scoped: { kind: 'files', dir: (p) => j(p.home, '.kiro', 'steering'), dialect: 'kiro', prefix: 'agent-layers-' } },
      skills: (p) => [j(p.home, '.kiro', 'skills')],
      mcp: { kind: 'json', file: (p) => j(p.home, '.kiro', 'settings', 'mcp.json'), key: ['mcpServers'], format: 'generic', env: null },
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'file', dir: (r) => j(r, '.kiro', 'steering'), dialect: 'kiro', prefix: 'agent-layers-' } },
      scoped: { kind: 'files', dir: (r) => j(r, '.kiro', 'steering'), dialect: 'kiro', prefix: 'agent-layers-' },
      skills: (r) => [j(r, '.kiro', 'skills')],
    },
  },
  {
    id: 'amp',
    name: 'Amp',
    checked: '2026-10-04',
    confidence: 'windows-paths-unverified',
    detect: { commands: ['amp'], dirs: (p) => [j(p.xdgConfig, 'amp')] },
    user: {
      instructions: { always: { kind: 'block', file: (p) => j(p.xdgConfig, 'amp', 'AGENTS.md') } },
      skills: (p) => [j(p.agentsHome, 'skills')],
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'block-if-untracked', file: (r) => j(r, 'AGENTS.md') } },
      skills: (r) => [j(r, '.agents', 'skills')],
    },
  },
  {
    id: 'factory',
    name: 'Factory Droid',
    checked: '2026-10-04',
    confidence: 'windows-paths-unverified',
    detect: { commands: ['droid'], dirs: (p) => [j(p.home, '.factory')] },
    user: {
      instructions: { always: { kind: 'block', file: (p) => j(p.home, '.factory', 'AGENTS.md') } },
      skills: (p) => [j(p.agentsHome, 'skills')],
      mcp: { kind: 'json', file: (p) => j(p.home, '.factory', 'mcp.json'), key: ['mcpServers'], format: 'generic', env: null },
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'block-if-untracked', file: (r) => j(r, 'AGENTS.md') } },
      skills: (r) => [j(r, '.agents', 'skills')],
    },
  },
  {
    id: 'devin',
    name: 'Devin Desktop / Devin CLI (formerly Windsurf)',
    checked: '2026-10-04',
    confidence: 'documented',
    detect: { commands: ['devin'], dirs: (p, os) => [winOr(os, j(p.appData, 'devin'), j(p.xdgConfig, 'devin'))] },
    notes: ['Devin also reads ~/.claude/CLAUDE.md and Cursor/Windsurf rules by default (read_config_from).'],
    user: {
      instructions: { always: { kind: 'block', file: (p, os) => winOr(os, j(p.appData, 'devin', 'AGENTS.md'), j(p.xdgConfig, 'devin', 'AGENTS.md')) } },
      skills: (p) => [j(p.agentsHome, 'skills')],
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'file', dir: (r) => j(r, '.devin', 'rules'), dialect: 'plain', prefix: 'agent-layers-' } },
      skills: (r) => [j(r, '.agents', 'skills')],
    },
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    checked: '2026-10-04',
    confidence: 'windows-paths-unverified',
    detect: { commands: ['qwen'], dirs: (p) => [j(p.home, '.qwen')] },
    user: {
      instructions: { always: { kind: 'block', file: (p) => j(p.home, '.qwen', 'QWEN.md') } },
      skills: (p) => [j(p.home, '.qwen', 'skills')],
      mcp: { kind: 'json', file: (p) => j(p.home, '.qwen', 'settings.json'), key: ['mcpServers'], format: 'gemini', env: null },
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'block', file: (r) => j(r, '.qwen', 'QWEN.local.md') } },
      skills: (r) => [j(r, '.qwen', 'skills')],
    },
  },
  {
    id: 'cline',
    name: 'Cline',
    checked: '2026-10-04',
    confidence: 'documented',
    detect: { commands: ['cline'], dirs: (p) => [j(p.home, '.cline')] },
    user: {
      instructions: { always: { kind: 'files', dir: (p) => j(p.home, '.cline', 'rules'), dialect: 'plain', prefix: 'agent-layers-' }, scoped: { kind: 'files', dir: (p) => j(p.home, '.cline', 'rules'), dialect: 'cline', prefix: 'agent-layers-' } },
      skills: (p) => [j(p.home, '.cline', 'skills')],
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'file', dir: (r) => j(r, '.clinerules'), dialect: 'plain', prefix: 'agent-layers-' } },
      scoped: { kind: 'files', dir: (r) => j(r, '.clinerules'), dialect: 'cline', prefix: 'agent-layers-' },
      skills: (r) => [j(r, '.agents', 'skills')],
    },
  },
  {
    id: 'goose',
    name: 'Goose',
    checked: '2026-10-04',
    confidence: 'windows-paths-unverified',
    detect: { commands: ['goose'], dirs: (p, os) => [winOr(os, j(p.appData, 'Block', 'goose'), j(p.xdgConfig, 'goose'))] },
    user: {
      instructions: { always: { kind: 'block', file: (p) => j(p.xdgConfig, 'goose', '.goosehints') } },
      skills: (p) => [j(p.agentsHome, 'skills')],
    },
    project: {
      always: { shared: { kind: 'agents-md' }, private: { kind: 'block-if-untracked', file: (r) => j(r, '.goosehints') } },
      skills: (r) => [j(r, '.agents', 'skills')],
    },
  },
];

export const ADAPTER_IDS = ADAPTERS.map((a) => a.id);

export function getAdapter(id) {
  const a = ADAPTERS.find((x) => x.id === id);
  if (!a) {
    throw new Error(`unknown agent "${id}". Known agents: ${ADAPTER_IDS.join(', ')}`);
  }
  return a;
}
