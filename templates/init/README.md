# My agent setup

This repository holds my AI coding agent configuration for [agent-layers](https://github.com/).

| Folder | Applied to | Lifetime |
|---|---|---|
| `base/` | the home folder of every machine (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.copilot`, `~/.agents`, ...) | permanent |
| `projects/<name>/` | one project folder, recognized by git remote or folder name | until `agent-layers project purge <name>` |
| `~/.agent-layers/config.jsonc` (not in this repo) | machine-specific variables, secrets backend, project paths | per machine |

Inside each layer:

| Folder | Content | Rendered as |
|---|---|---|
| `instructions/*.md` | always-on rules; add `paths:` front matter for path-scoped rules | `CLAUDE` rules, `AGENTS.md`, `GEMINI.md`, Copilot instructions, ... |
| `skills/<name>/SKILL.md` | Agent Skills (agentskills.io) loaded on demand | `~/.agents/skills`, `~/.claude/skills`, ... |
| `commands/*.md` | slash commands (`$ARGUMENTS`) | Claude commands, Gemini `.toml` commands |
| `agents/*.md` | subagents | Claude subagents |
| `mcp/*.jsonc` | MCP servers in a neutral format with `${secret:NAME}` | each agent's MCP config |
| `settings/<agent>.json` | key-level settings | merged into each agent's settings file |
| `files/<agent>/...` | raw files (`.tmpl` = templated) | the agent's home folder |

## New machine

```sh
npm install --global agent-layers
agent-layers init --from <this repository's git URL>
agent-layers doctor
agent-layers secrets check
agent-layers apply
```

## Daily use

```sh
agent-layers sync                 # pull and apply
agent-layers project apply        # inside a project folder
agent-layers project purge <name> # at the end of a project
```
