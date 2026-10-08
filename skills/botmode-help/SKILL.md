---
name: botmode-help
description: How to use Botmode and fix it. Its commands, where its files are, MCP servers for bots in pi, and what to check when a bot, handoff, message, room or another machine does not work. Load it when the owner asks how Botmode works, or something in it goes wrong.
---

# Botmode help

## Commands

The owner runs these in a terminal:
- `botmode`: the window, with you. `botmode -c` continues your last conversation in that folder, and `botmode -p "..."` sends you one message without the window.
- `botmode setup`: model sign-in, the bots' model, Claude Code's sign-in, and letting other machines connect. `botmode setup <invite>` connects this machine to the one that printed the invite.
- `botmode invite`: prints the invite again. It holds the secret the machines share, so the owner sends it only to themselves.
- `botmode status`: sign-ins, model, bots, host, tailnet, what is at work, and the other machines.
- `botmode restart` restarts this machine's host. `botmode update` installs the latest Botmode, then restarts it.
- `botmode teardown`: disconnects this machine and stops its host. It asks before deleting the bots.

You may run `botmode status` yourself. The others ask questions or print the secret, so tell the owner which to run.

In the window: `/sessions`, or ← on an empty prompt, is the lobby; `/sessions <id>` opens a session; `/bot <id> <message>` talks to one bot directly; `/model` changes the model.

## Files

Botmode keeps its files in `~/.botmode` (`$BOTMODE_HOME`):
- `config.json`: the team. Change it with `configure`, not by hand.
- `sessions/`: every bot session, as `<time>_<session>.jsonl`.
- `bots/<id>/`: the folder of a bot with no `workspace`.
- `mail/<session>/`: messages not read yet.
- `profiles/<name>/`: profiles for bots in Claude Code.
- `host.log`: the host's log.
- `bili`: the address of billion-context's proxy for bots in Claude Code.
- `token`: the secret. Never show it or send it anywhere.

pi keeps its sign-ins and settings in `~/.pi/agent`, and Claude Code in `~/.claude`. billion-context keeps its config in `~/.config/billion-context/billion-context.json`, compressed conversations in `~/.local/share/billion-context`, and its log in `~/.local/state/billion-context/bili.log`.

## Small contexts

Every bot, you included, works through billion-context: a proxy between it and its model compresses what the bot no longer needs word for word. `compress`, `decompress`, `search_context`, `acp_status` and `acp_cache` act on the bot's own context, whatever its `tools` say; in Claude Code they are `mcp__bili__compress` and so on. In pi they join from a bot's second model request on.

## MCP servers for bots in pi

- Bots in pi, you included, reach MCP servers with the `mcp` tool. `mcp({ search: "..." })` finds a server's tools, and a server connects when its tool is first used. `/mcp` in a window shows the servers and their state.
- A bot has `mcp` when it names no `tools`, or lists `mcp` in them.
- The servers come from the owner's MCP files: `~/.config/mcp/mcp.json` for every pi, and `~/.pi/agent/mcp.json`, where `pi mcp add` puts them. They have the format of Claude Code's `.mcp.json`.
- Put servers for bots in those files. A `.mcp.json` in a bot's folder waits for the owner to allow it in a window, and a bot at work skips it.
- Bots in Claude Code have only the team's server, billion-context's and their profile's: see the claude-code-profiles skill.

## When something goes wrong

- **A handoff is refused.** The refusal says why: the session is busy (hand off `fresh` or `copy`), the bot is archived, it is already in the chain, or the chain is too deep.
- **A message is refused.** Messages reach only sessions at work, and you.
- **A bot's model is unavailable.** Botmode warns and uses pi's default. `botmode status` shows the sign-ins; `botmode setup` adds one.
- **Another machine's bots are missing, or it shows as unavailable.** Its host is off or out of reach. On that machine, `botmode status`, then `botmode restart`, with Tailscale signed in on both. Its `host.log` says why the host stopped.
- **The host does not start at login after a Node version change.** Run `botmode setup` again.
- **`configure` refuses a patch that looks right.** It checks the whole configuration: a bot's `workspace` or profile folder that is gone makes it invalid until the folder is back.
- **A bot in Claude Code does not start.** An invalid `.mcp.json` in its profile stops it. It reads a message only after a step that uses a tool, or once it finishes.
- **A bot's model requests fail with a connection error.** They go through billion-context's proxy. Its log, `~/.local/state/billion-context/bili.log`, says why. A bot in Claude Code gets a new proxy when it next starts; a bot in pi, on its next run.
- **`botmode update` says EBUSY.** Another botmode window is using its files: close every other window, then run it again.
- **Every room closed at once.** Quitting your own room closes them all and stops their work.
