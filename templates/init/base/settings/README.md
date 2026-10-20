# Settings fragments

Each file is merged key by key into one agent's own settings file. agent-layers only touches the keys
listed here and remembers them, so values the agent or you add later are preserved.

| File | Merged into |
|---|---|
| `claude.json` | `~/.claude/settings.json` |
| `codex.toml` (or `codex.json`) | `~/.codex/config.toml` |
| `gemini.json` (or `gemini.jsonc`) | `~/.gemini/settings.json` |

- `gemini.jsonc` holds commented-out model examples (`model.name`, `model.compressionThreshold`, `general.plan.modelRouting`). Uncomment only the keys you want to manage.
- Antigravity has no settings fragment; agent-layers writes only its rules, skills and `mcp_config.json`.
- Add `@windows`, `@macos` or `@linux` before the extension for OS-specific values, for example `claude@windows.json`.
- String values may use variables such as `{{home}}` or `{{homeSlash}}` instead of absolute paths.
- Do not put tokens or passwords here; use MCP definitions with `${secret:NAME}` instead.

Example `claude.json`:

```json
{
  "outputStyle": "Explanatory",
  "statusLine": { "type": "command", "command": "~/.claude/statusline.sh" }
}
```
