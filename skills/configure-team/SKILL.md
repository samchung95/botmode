---
name: configure-team
description: Change the Botmode team with the configure tool. Create, edit, archive or remove bots, including coding bots that work in Claude Code, and set their models, tools and folders and the default model. Load it before you change the team, or to answer what its settings are.
---

# Configure the team

`configure` takes a JSON merge patch (RFC 7386) of the team's configuration: objects merge, `null` deletes a key, and any other value, a list included, replaces. The whole patch applies, or nothing does and the result lists every problem. Tell the owner what changed.

Look before you change: `configure` with the empty patch `{}` changes nothing and shows the configuration and the bot sessions on this machine. A list replaces the old one whole, so read `tools` or `archived` before you change it.

## The configuration

```json
{
  "defaults": {"model": "provider/model:thinking", "helperModel": "provider/model"},
  "bots": {"<id>": {"name": "...", "description": "..."}},
  "hosts": {"<id>": {"url": "https://..."}}
}
```

- `defaults.model` is the model of every bot that names none: `provider/model`, or `provider/model:thinking` with a thinking level of off, minimal, low, medium, high or xhigh. Empty uses pi's default.
- `defaults.helperModel` is a small, quick model, in the same form, that titles your conversations with the owner for the lobby, again at each message they send. Its thinking is off unless it names a level. Empty names none, and the lobby shows each conversation's first words. The owner can also set both in the window with `/botmode`.
- `bots` is the team. An id is 1-32 lowercase letters, digits or `-`, starting with a letter. It is also the bot's session, and its copies are `<id>.2`, `<id>.3`… `bots.handler` is you: your tools, model and instructions, which apply at once. You cannot be removed or archived.
- `hosts` are the owner's other machines, whose bots join the team as `host/bot`. Only the owner sets them, with `botmode setup <invite>`; configure refuses them. To create or change bots on another machine, ask its handler, `host/handler`.

## Bot fields

- `name`: required.
- `description`: required. What the bot does. Bots are chosen by it, so make it specific.
- `title`: optional, a role such as "Researcher".
- `instructions`: optional, added to the bot's system prompt.
- `model`: `provider/model` or `provider/model:thinking`; empty uses `defaults.model`. For a bot in Claude Code, a Claude Code model such as `opus` or `sonnet`, or a full model id; empty uses Claude Code's default.
- `tools`: pi tool names, from `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `powershell` on Windows, and `mcp`, the owner's MCP servers (the botmode-help skill). Omitted keeps pi's defaults (`read`, `bash`, `edit`, `write`, `mcp`); `[]` leaves only the team's tools and billion-context's, for the bot's own context, which every bot has.
- `workspace`: an existing absolute folder the bot works in. Omitted, it gets a folder of its own.
- `agent`: `"claude"` for a bot that works in Claude Code; omitted, or `"pi"`, for one in pi.
- `profile`: for a bot in Claude Code, the profile it loads, with skills, plugins and MCP servers. The claude-code-profiles skill sets them up.
- `archived`: the bot's archived sessions, below.

Unknown fields are refused, so a typo fails loudly.

## Coding bots in Claude Code

A bot for coding work can work in Claude Code instead of pi: give it `"agent": "claude"`. Botmode brings its own Claude Code, which `botmode setup` signs in, so the bot runs on this machine like any other; there is no `claude` to look for. It has all of Claude Code's tools and no permission prompts, so it has no `tools` field. For skills, plugins or MCP servers, give it a `profile`: load the claude-code-profiles skill. You hand it work and message it as you would any bot. Leave its `workspace` out, or give it a project folder, never the owner's home folder: when the owner talks with the bot, Claude Code asks them to trust its folder, once for most folders but every time for the home folder.

```json
{"bots": {"coder": {"name": "Coder", "description": "Writes, fixes and reviews code in the owner's repositories", "agent": "claude", "model": "opus"}}}
```

## Archiving

When the owner is done with a copy, or with a whole bot, archive it rather than remove it: list it in the bot's `archived`.

- The bot's own id archives the whole bot, with its copies. It leaves the team, here and on the owner's other machines.
- A copy's id, such as `research.2`, archives only that copy.

An archived session stops any work at once, leaves the lobby, and takes no handoffs or messages. Its history stays: drop it from the list, or set `archived` to `null`, and it is back as it was.

```json
{"bots": {"research": {"archived": ["research.2", "research.3"]}}}
```

Removing a bot, `{"bots": {"research": null}}`, deletes its settings. Its sessions stay, and a bot created again with the same id has them back.

## More examples

- Create a bot: `{"bots": {"research": {"name": "Researcher", "description": "Finds and summarizes sources"}}}`
- Give it a model with more thinking: `{"bots": {"research": {"model": "provider/model:high"}}}`, with a model the owner is signed in to.
- Let it only read: `{"bots": {"research": {"tools": ["read", "grep", "find", "ls"]}}}`
- Bring an archived bot back: `{"bots": {"writer": {"archived": null}}}`
