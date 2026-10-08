---
name: claude-code-profiles
description: Set up Claude Code profiles, the skills, plugins and MCP servers that bots in Claude Code load, and give a bot one. Load it before you create or change a profile, or to answer what a bot in Claude Code has.
---

# Claude Code profiles

A profile is a folder of skills, plugins and MCP servers for bots that work in Claude Code (`"agent": "claude"`). Each bot names at most one profile, and several bots can share one. Profiles live on this machine, in the folder that `configure` with the empty patch `{}` names with the profiles there. For a bot on another machine, ask that machine's handler.

## What a bot in Claude Code has

- Claude Code's tools, and the team's handoff and message.
- What the owner set up in their own Claude Code on this machine: the plugins they turned on, their skills and their CLAUDE.md. Every bot in Claude Code has these, with or without a profile.
- Never the owner's own MCP servers, such as their mail or files. A bot has only the MCP servers in its profile.
- Its profile.

So put in a profile what only some bots should have, and every MCP server a bot needs.

## A profile's folder

The folder's name is the profile's name: 1-32 lowercase letters, digits or `-`, starting with a letter. Claude Code loads the folder as a plugin of that name.

```
web/
  skills/review-ui/SKILL.md      a skill, which the bot sees as web:review-ui
  .mcp.json                      MCP servers
  plugins/frontend-design/       a whole Claude Code plugin
```

Everything is optional; create only what the profile needs.

### Skills

Each skill is a folder in `skills/` with a `SKILL.md` that starts with its name and when to use it:

```markdown
---
name: review-ui
description: Reviews a web page's layout and accessibility. Use when asked to check a page.
---

What to do, step by step.
```

A plugin's other parts work too, such as `agents/` with subagents and `commands/` with slash commands.

### MCP servers

`.mcp.json` lists them as Claude Code's own `.mcp.json` does:

```json
{"mcpServers": {
  "playwright": {"command": "npx", "args": ["-y", "@playwright/mcp@latest"]},
  "docs": {"type": "http", "url": "https://example.com/mcp", "headers": {"Authorization": "Bearer ${DOCS_TOKEN}"}}
}}
```

- Use absolute paths. `${NAME}` takes a value from the environment Botmode runs in, so a key need not be in the file. Never repeat a key back to the owner.
- On Windows, start `npx` through `cmd`: `"command": "cmd", "args": ["/c", "npx", "-y", "@playwright/mcp@latest"]`.
- Do not name a server `botmode`: that name is the team's, which wins.
- A file that is not valid JSON stops the bot from starting, so check it after you write it.

### Plugins

Each folder in `plugins/` is a whole Claude Code plugin, with `.claude-plugin/plugin.json`. Copy one in, for example from the plugins the owner installed in Claude Code, in `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, or clone its repository. Its skills, agents, commands and hooks load.

Its MCP servers do not, as Botmode keeps every MCP server but the profile's own out. Copy those the bot needs from the plugin's `.mcp.json` into the profile's, with `${CLAUDE_PLUGIN_ROOT}` replaced by the plugin's folder.

## Give a bot a profile

Use `configure`:

- Give it: `{"bots": {"coder": {"profile": "web"}}}`.
- Take it away: `{"bots": {"coder": {"profile": null}}}`.

Only a bot in Claude Code takes one, and the folder must already exist.

A bot loads its profile each time it starts. A change to the profile's files, or a new profile, applies from each bot's next handoff, or the next time the owner opens it in the lobby.

Before you rename or delete a profile's folder, take it away from every bot that names it. While a bot names a missing profile, Botmode finds the whole configuration invalid, and `configure` and handoffs fail. To recover, create the folder again.

## Check it

Hand the bot a small task that uses what you added. For example, ask it to list its MCP tools and skills, then tell the owner what it has.
