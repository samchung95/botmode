# Botmode

A team of bots behind one top-level **handler**, in pi's TUI. You talk to the handler. It answers you directly, hands the work to the bot whose description fits, or changes the team when you ask it to.

Botmode is one [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension, `botmode.mjs`. Every bot is a pi process that runs it. Your pi TUI is the handler. A handoff starts the target bot as a child pi with its own ongoing session. The bot works in the background, its latest step shows above your prompt, and its reply arrives as a message while you carry on. Copies of a bot run side by side, bots at work message each other, and `/sessions` lets you step into any bot's session. A coding bot can work in Claude Code instead of pi. pi already provides the TUI, models, sign-ins, sessions, streaming and tools, so Botmode adds only the team. The team can span your machines: connect them with `botmode setup`, and their bots hand work to each other across your tailnet.

## Install

You need Node 22.19 or newer. Botmode is an npm package that brings its own pi, and its own Claude Code for coding bots (a few hundred MB, the program for your platform):

```sh
npm install -g github:samchung95/botmode
botmode setup
```

`botmode setup` is a wizard. Run it again whenever you like. It asks four things, and a fifth on a Mac:

1. **Model sign-in.** It lists the providers you are already signed in to, says if your bots' model needs another, and you can sign in to one, either in your browser (ChatGPT, Claude, GitHub Copilot and others) or with an API key. The sign-ins go where pi keeps them (`~/.pi/agent`), so pi and Botmode share them.
2. **Your bots' model.** Pick by number from the models your sign-ins offer, a level at a time (provider, vendor, model), or type to search. Then pick a thinking level.
3. **Claude Code.** It says whether Claude Code is signed in, and signs it in, in your browser, for your coding bots. The sign-in is Claude Code's own (`~/.claude`), so a Claude Code you use yourself shares it.
4. **Your other machines.** Say yes to let your other machines connect, and it prints an invite.
5. **Admin rights** (Mac). Say yes to let your bots use `sudo` without a password.

`botmode update` installs the latest version from GitHub and restarts the host.

## Use

```sh
botmode                                   # the TUI, as the handler
botmode -c                                # continue the last handler conversation in this folder
botmode -p "make me a research bot"       # one message, no TUI
botmode status                            # sign-ins, model, bots, host and connected machines
botmode teardown                          # undo everything setup did (asks before deleting your bots)
botmode update                            # the latest version from GitHub, then a host restart
npm test                                  # in a checkout; no model needed
```

Any arguments other than the commands below go straight to pi. In the TUI:
- `/sessions`, or ← on an empty prompt, is the lobby: every bot session on this machine with its folder, and the ones at work on your other machines. Pick an idle one to talk with that bot yourself, as in any pi session; pick `handler` to come back to your own conversation. Pick one at work on this machine to watch it: the window shows its conversation as it grows, what you type goes to the bot as a message that reaches it at its next step, and once it is done the session is yours to talk in. Pick it again in the lobby to stop it, if this window started it. One at work on another machine shows its steps, and takes a message or a stop the same way. `/sessions <id>` opens a session directly. While you are in a session, handoffs to it are refused, so the bot never works in two places at once.
  - Each session you open gets a **room**: the `botmode` command runs a pi of its own for it, in a terminal of its own, and shows you one room at a time, as tmux does. Leaving a room does not stop it. A room at work, your handler's included, carries on out of sight, shows as working in the lobby, and closes once it is done. An idle room closes as you leave it, since all it did is in its session.
  - Without rooms (pi started some other way, or node-pty missing), the window switches sessions in place. pi stops a session's work as the window switches away, so Botmode picks it back up in the background, redoing the step it was in.
  - Ask your handler to **archive** a copy you are done with, or a whole bot with its copies. It leaves the lobby and the team, and handoffs to it are refused, but its sessions stay. Ask for it back and it is as it was. The handler sees the sessions on this machine, and keeps the archived ones in each bot's `archived` field. `/sessions <id>` still opens an archived session.
- Handoffs and messages show in your conversation as pi's usual tool calls and messages, each marked with a bar in the colour of the bot it goes to or comes from. Bots take colours in turn: your team in `config.json`'s order, then your other machines' bots as they first show up. Copies share their bot's colour. When another machine's handler hands yours a task while your window has your handler's conversation open, the task arrives there as a message, where you see it and its answer. Otherwise it runs in a background session of its own.
- `/bot <id> <message>` talks to one bot directly and waits for its reply, which is added to the handler's conversation.
- `/model` changes the model for the session.

Everything lives in `BOTMODE_HOME` (default `~/.botmode`):
- `config.json`, which holds the team;
- `sessions/`, with one pi session per bot and per copy, and a `<session>.lock` file while one is at work or open in a window. For a bot in Claude Code, the file holds only its folder and the id of its Claude Code conversation, which Claude Code keeps with yours (`~/.claude/projects`);
- `mail/`, the messages waiting for each session at work and for your handler;
- `bots/<id>/`, a working folder for each bot that has no `workspace`;
- `token`, the secret your machines share;
- `host.log`, one line per handoff this machine ran for another.

## Coding bots in Claude Code

A bot with `"agent": "claude"` works in Claude Code instead of pi, for example `"coder": {"name": "Coder", "description": "Writes and fixes code", "agent": "claude", "model": "opus"}`. Ask your handler for one. Your handler stays in pi.
- Handed a task, it runs Claude Code headless in its folder, with all of Claude Code's tools and no permission prompts (`bypassPermissions`). Its `model` is a Claude Code model, such as `opus`, `sonnet` or a full model id. Left empty, it gets Claude Code's default, not `defaults.model`. It has no `tools` field.
- It is on the team like any bot. Botmode gives it `handoff` and `message` as an MCP server, `botmode-claude.mjs`, so it hands work to bots in pi and messages them and your handler. A message to it reaches it after its next step, through a PostToolUse hook. One that arrives as it finishes gets a turn of its own, as in pi.
- Sessions, copies and folders work as they do in pi.
- In the lobby it is marked `Claude Code`. Pick an idle one to talk with it yourself, in Claude Code, in a room of its own. There, ← on an empty prompt does not open Claude Code's agents (`leftArrowOpensAgents` is off), and `/exit` brings you back to your handler. Pick one at work to message or stop it. Without rooms, you hand it work instead.
- It is your Claude Code: your sign-in, settings, `CLAUDE.md` files, plugins and hooks. Your other MCP servers are left out, so its only MCP tools are the team's. So is Claude Code's `SendMessage`, which would reach your other Claude Code sessions.
- The first time you open a bot's folder in Claude Code yourself, Claude Code asks whether you trust it. Handoffs never ask.

## Several machines

Each machine keeps its own bots, along with their sign-ins, workspaces and sessions. When machines are connected, each machine's bots join the team on the others as `host/bot`, so handoffs run both ways. Machines reach each other over [Tailscale](https://tailscale.com/download), so install it and sign in on each one. Windows and macOS are supported.

1. On the first machine, run `botmode setup` and say yes to letting other machines connect. It starts this machine's **host** in the background (now, and at every login), shares it on your tailnet only, and prints an invite. `botmode invite` prints it again later.
2. On the other machine, install Botmode and run `botmode setup <invite>`. It signs that machine in to a model if it has none, starts its host, and connects both ways. If the first machine already has others, the new one connects to them too.
3. The Mac's bots now appear in the PC's roster as `mac/<id>`, and the PC's appear on the Mac. The handler and every bot can hand work to them or message the ones at work, and `/bot mac/<id> <message>` talks to one directly. Their steps show the same way as a local bot's, and `/sessions` stops one your window started.

The invite holds the secret your machines share, so send it only to yourself. To disconnect a machine, run `botmode teardown` on it. Teardown tells the others to forget the machine, stops its host and removes its start at login. It also turns off its tailnet share and, if you say so, deletes its bots. Your model sign-ins stay, because pi owns them.

Behind the wizard:
- `botmode host [port]` is the host. It listens only on `127.0.0.1:18790`, and `tailscale serve --https=8445` shares it on the tailnet, never with Funnel.
- At login it starts from the `Botmode` scheduled task on Windows, or from the `~/Library/LaunchAgents/dev.botmode.host.plist` LaunchAgent on macOS. On Linux, run `botmode host` yourself.
- In chains, `BOTMODE_MACHINE` names this machine (default: its hostname).

## Admin rights

Every bot, the handler included, works with the rights of the account that runs it. Each machine can raise that:
- **Windows.** Run `botmode setup` from a terminal opened as administrator, and say yes to running the host as administrator. Whatever your other machines ask of this one then runs with admin rights. Your own handler gets them when you run `botmode` from an administrator terminal.
- **macOS.** Say yes at setup's admin step. Setup installs `/etc/sudoers.d/botmode` after checking it with `visudo`, so your bots can use `sudo` without a password. So can any other program running as you.

`botmode status` shows what each machine allows, and `botmode teardown` takes it back. Admin rights widen what a poisoned reply can do (see Known limits).

## Language

- **Bot**: a named agent with an id, `name`, `description` and optional `title`, `instructions`, `model`, `tools`, `workspace`, `agent` (`claude` for a bot in Claude Code) and `archived` (its archived sessions: its own id archives the whole bot). Other bots route by its **description**, so the description is its contract.
- **Handler**: the bot with id `handler`, which is your TUI session. Every message you type reaches it, unless you use `/bot`. Only the handler has `configure`. It also has all of pi's tools, so it reads and writes files and runs commands with your account's rights. It can configure itself too (`bots.handler`), and its new tools and model apply at once. It cannot be removed. Your handler can also talk to another machine's handler as `host/handler`, for example to create bots there.
- **Configuration**: one JSON document that holds the whole team. "Configure anything" means it holds anything configurable. A new setting is a new field in the document and its validation, not a new operation.
- **Handoff**: a bot passes a task to another bot. The handler gets the reply later as a message and keeps talking with you meanwhile. A worker waits for the reply, since its turn is its whole job.
- **Host**: another of your machines, listed under `hosts` in the configuration. Its bots are addressed as `host/bot`.
- **Chain**: the bots working on one request, each named with its machine, for example `pc/handler -> mac/research -> pc/writer`.
- **Session**: one ongoing pi conversation. A bot's own session (`research`) remembers its work across handoffs.
- **Copy**: another session of the same bot, named `research.2`, `research.3` and so on, which works in parallel with the others. Each handoff picks a session: `continue` carries on in the named bot's or copy's session, `fresh` starts a copy with no history, and `copy` starts a copy that remembers everything the named session does. A new copy works in the folder of the session it comes from, unless the handoff names a `folder`, for example to send a copy of your coding bot to another repository. A copy keeps its folder for good. The bot's own session follows its `workspace`.
- **Message**: a note to a session at work, which reaches it mid-task, or to the handler. Bots use it to share findings, correct a task in progress, or ask the handler a question it passes on to you, and you send one from `/sessions`. With `wait`, the sender gets the answer as the tool's result. A message that arrives as the bot finishes is not left for its next task: the bot gets a turn for it straight away, up to three in a row.

## Rules

1. Routing reads bot descriptions and nothing else. Past sessions do not count.
2. Any bot can hand off to any other bot, with four exceptions: a handler, an archived bot or copy, a bot already in the chain, and any handoff deeper than three bots. A handler takes work only from another machine's handler, directly, so a worker never steers a bot that has `configure`. A refusal goes back to the caller as the tool result.
3. `configure` takes a [JSON merge patch](https://www.rfc-editor.org/rfc/rfc7386). Either the whole patch applies or nothing changes, and the result lists every problem. Unknown fields are refused, so typos fail loudly.
4. When a bot's pi starts, it applies that bot's `model` and `tools`. A bot with `tools: []` gets only the team tools and its own system prompt. Other bots keep pi's coding prompt, and the team section is added to it.
5. Each bot works in its own folder unless it has a `workspace`.
6. Only the owner sets `hosts`, through `botmode setup <invite>` and `teardown` (or by editing `config.json`). `configure` refuses them because every handoff to a host carries the token. A host checks each handoff against its own team and refuses relays to a third machine.
7. A session works on one task at a time. `continue` into a busy session is refused, with the hint to use `fresh` or `copy`.
8. Messages go only to sessions at work and to the handler, since an idle bot reads nothing. A machine's handler takes messages from another machine only from that machine's handler, and from a bot at work on a task the handler handed it.
9. A handoff tells the bot who handed it the task and how to reach them. A window gets the bot's messages while it works, so the bot is given its address (`handler`, or `pc/handler` from another machine). A bot's own pi waits in `handoff` and reads nothing until the reply, so the bot it hands work to is told to put any question in the reply. A `host/bot` named with this machine's own name is the bot here.

## Design

```
pi TUI (handler) ── handoff tool ──spawn──▶ pi -p child (--session-id research.2, BOTMODE_CHAIN=pc/handler)
   │  returns at once       steps show above the prompt            │ same extension, its own session
   │  ◀── reply, via ~/.botmode/mail/handler ───────────────────────┘ │ may hand off further (chain grows)
   │  message tool ──▶ ~/.botmode/mail/research.2 ──▶ steered into its current turn
   │ configure
   ▼
~/.botmode/config.json  (merge patch + validation, written atomically; every pi reads it fresh)

handoff to mac/dev ──HTTPS on the tailnet, token──▶ Mac: botmode host ──spawn──▶ pi -p child (dev)
   ◀── {steps} lines as they happen, then {ok, text} ──┘   dev hands work back the same way
```

- **Identity comes from the session.** A session in `~/.botmode/sessions` named after a bot (`research`, or a copy such as `research.2`) is that bot; any other session is your handler. `BOTMODE_CHAIN` lists the bots waiting on it. The child process sets both, and the model cannot change them.
- **Locks and mailboxes are plain files**, so every pi on the machine sees them. A lock holds the pid and task of the pi at work in a session, and a lock whose pid has died is taken over. A message is one JSON file in the recipient's mailbox. A working pi reads its own every half second and steers each message into its current turn; your window reads the handler's and starts a turn for each.
- **The system prompt is rebuilt each turn** from the configuration, so a bot created mid-conversation is in the roster from the next message on. It also lists the sessions at work right now, on every machine.
- **A host is one loopback HTTP endpoint.** `GET /bots` lists its bots and the sessions at work. `POST /handoff {bot, session, folder?, prompt, chain}` runs one and streams NDJSON: `{steps, session}` lines, then `{ok, text, session}`. `POST /message {to, from, text, chain}` delivers a message; `chain` is the one the sender works for, which shows whether this machine's handler handed it its task. `POST /join {name, url}` connects a machine once the host has checked it can call it back, and `POST /leave {url}` disconnects one. All of them require `Authorization: Bearer <token>`. Rosters are fetched each turn, so a new bot on the Mac appears on the PC with the next message.
- **The `botmode` command** (`cli.mjs`) is the wizard, the background-host plumbing and your window. It uses pi's own sign-in flows and model list. It also brings Claude Code, pinned, which it runs with its updater off: it updates with `botmode update`. Its last dependency is Microsoft's node-pty, which gives each room a terminal. It is optional: where it does not install (it ships builds for Windows and macOS only), you get one pi without rooms.
- **A bot in Claude Code** runs as `claude -p --output-format stream-json`, which streams its steps and ends with its reply. It starts its conversation with `--session-id`, picks it up again with `--resume` and copies it with `--fork-session`. Its session file is written once Claude Code has answered, so a start that fails leaves nothing that cannot be resumed. `--settings` adds the mail hook and turns ← off, `--mcp-config` adds `botmode-claude.mjs mcp <session>`, and `--append-system-prompt` adds the team. Whoever started it holds its lock, as for a bot in pi.
- **A room is a pi in a terminal of its own.** The `botmode` command passes each room's pi `BOTMODE_ROOMS`, a loopback address with a secret in it. A room's lobby asks there for another room, with `{room, busy, open, args, cwd}`, and `claude: true` for a room that runs Claude Code, which the command holds the bot's lock for. Every room also says when it starts and stops being busy, so the command keeps a busy room out of sight and closes an idle one. A room out of sight is a row short, so showing it again is a resize, after which pi redraws it whole.
- **Pure parts are exported and tested**: `mergePatch`, `problems`, `applyPatch`, `refusal`, `teamPrompt` and the invite. The host protocol, including join, leave and messages, is tested over loopback. Background handoffs, copies, messages, `/sessions`, what rooms ask for and leaving a session at work are tested through the extension itself, with `fake-pi.mjs` standing in for the bots' pi and `fake-claude.mjs` for Claude Code, which calls the team's tools through the MCP server and runs the mail hook as Claude Code does. The TUI wiring, the rooms themselves, and two-way handoffs through `tailscale serve`, are checked live.

## Next slices

1. **Routines**: a `routines` section (`{bot, prompt, every | cron | webhook}`) and a scheduler that sends their prompts. The handler configures routines through the same `configure`.
2. **Approvals**: the owner confirms risky patches, such as removing a bot or changing a workspace, in the TUI before they apply.
3. **Connected apps**: MCP servers per bot as a configuration field.

## Known limits

- A worker's handoffs are synchronous, so it waits for the whole chain below it. Only your window works in the background.
- Copies share their bot's folder unless a handoff gives them their own, so parallel copies in one folder can trip over each other's files. Their sessions stay in `sessions/` until you delete them.
- A session you watch is reloaded each time the bot writes to it, so it moves a message at a time, not a word at a time, and pi notes "Resumed session" each time. What you type while watching reaches the bot as a message from your handler, so the bot may answer in your handler's conversation as well as its own. A session on another machine lives in that machine's files, so you reach it with a message, `/bot` or a handoff, and do not watch it.
- Quitting your handler's room closes every room, busy ones too, and stops everything they started. Each room is a pi process of its own, so many busy rooms take memory.
- On Mac and Linux, Ctrl+Z does nothing in a room: pi would suspend itself where your shell cannot reach it. pi's own `/resume` and `/new` switch a room's session in place, the way windows without rooms do, so a session left at work that way redoes the step it was in.
- Colours go round after 8 bots, so two can share one. Only windows the `botmode` command starts draw them, because it loads `botmode-tui.mjs` beside the extension to lend it pi's TUI. With two windows open on one machine, a task from another machine's handler lands in whichever window takes it first. Once either window leaves its handler's conversation, such tasks run in the background until one comes back.
- ← opens the lobby only in pi's own prompt editor, and only when it is empty; a terminal that sends ← some other way keeps `/sessions`.
- `/sessions` waits for your other machines' rosters, up to 3 seconds for one that is off.
- Changing a bot's `workspace` starts its own session afresh, because pi finds a session only from the folder it was started in. Its copies keep their folders.
- Stopping a bot, with Esc or from `/sessions`, stops only that bot. Bots further down its chain, and processes their tools started, keep running until they finish.
- A bot in Claude Code hears a message only after a step that uses a tool, or once it finishes. Claude Code offers the team's tools through its tool search, which takes the bot a step to find them.
- In a Claude Code room, `/exit` is the only way back: ← does not open the lobby there. On Windows, `botmode update` cannot replace Claude Code while a bot works in it.
- Every machine shares one token, so anyone holding it can run any bot on any of your machines.
- Switching Node versions with a version manager such as nvm moves the global `botmode`, so the host's start at login breaks. Run `botmode setup` again after switching.
- A machine's bots are reachable only while its host runs. A host that is off adds up to 3 seconds to each turn, while its roster times out.
- A worker's reply flows back into the handler, which can configure the team and run any command your account can, on its machine and, through the other handlers, on your other machines. Workers cannot hand off to a handler, but a poisoned reply or message could still steer one. Approvals (slice 2) close this.
