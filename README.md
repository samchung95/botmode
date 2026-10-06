# Botmode

A team of bots behind one top-level **handler**, in pi's TUI. You talk to the handler. It answers you directly, hands the work to the bot whose description fits, or changes the team when you ask it to.

Botmode is one [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension, `botmode.mjs`. Every bot is a pi process that runs it. Your pi TUI is the handler. A handoff starts the target bot as a child pi with its own ongoing session, and its steps stream into the handoff's tool card. pi already provides the TUI, models, sign-ins, sessions, streaming and tools, so Botmode adds only the team. The team can span your machines: connect them with `botmode setup`, and their bots hand work to each other across your tailnet.

## Install

You need Node 22.19 or newer. Botmode is an npm package that brings its own pi:

```sh
npm install -g github:samchung95/botmode
botmode setup
```

`botmode setup` is a wizard. Run it again whenever you like. It asks three things, and a fourth on a Mac:

1. **Model sign-in.** It lists the providers you are already signed in to, says if your bots' model needs another, and you can sign in to one, either in your browser (ChatGPT, Claude, GitHub Copilot and others) or with an API key. The sign-ins go where pi keeps them (`~/.pi/agent`), so pi and Botmode share them.
2. **Your bots' model.** Pick by number from the models your sign-ins offer, a level at a time (provider, vendor, model), or type to search. Then pick a thinking level.
3. **Your other machines.** Say yes to let your other machines connect, and it prints an invite.
4. **Admin rights** (Mac). Say yes to let your bots use `sudo` without a password.

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

Any arguments other than the commands below go straight to pi. In the TUI, `/bot <id> <message>` talks to one bot directly. The reply is added to the handler's conversation. `/model` changes the handler's model for the session.

Everything lives in `BOTMODE_HOME` (default `~/.botmode`):
- `config.json`, which holds the team;
- `sessions/`, with one pi session per bot;
- `bots/<id>/`, a working folder for each bot that has no `workspace`;
- `token`, the secret your machines share;
- `host.log`, one line per handoff this machine ran for another.

## Several machines

Each machine keeps its own bots, along with their sign-ins, workspaces and sessions. When machines are connected, each machine's bots join the team on the others as `host/bot`, so handoffs run both ways. Machines reach each other over [Tailscale](https://tailscale.com/download), so install it and sign in on each one. Windows and macOS are supported.

1. On the first machine, run `botmode setup` and say yes to letting other machines connect. It starts this machine's **host** in the background (now, and at every login), shares it on your tailnet only, and prints an invite. `botmode invite` prints it again later.
2. On the other machine, install Botmode and run `botmode setup <invite>`. It signs that machine in to a model if it has none, starts its host, and connects both ways. If the first machine already has others, the new one connects to them too.
3. The Mac's bots now appear in the PC's roster as `mac/<id>`, and the PC's appear on the Mac. The handler and every bot can hand work to them, and `/bot mac/<id> <message>` talks to one directly. Their steps stream into the handoff's tool card, and Esc stops the remote bot.

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

- **Bot**: a named agent with an id, `name`, `description` and optional `title`, `instructions`, `model`, `tools` and `workspace`. Other bots route by its **description**, so the description is its contract.
- **Handler**: the bot with id `handler`, which is your TUI session. Every message you type reaches it, unless you use `/bot`. Only the handler has `configure`. It also has all of pi's tools, so it reads and writes files and runs commands with your account's rights. It can configure itself too (`bots.handler`), and its new tools and model apply at once. It cannot be removed. Your handler can also talk to another machine's handler as `host/handler`, for example to create bots there.
- **Configuration**: one JSON document that holds the whole team. "Configure anything" means it holds anything configurable. A new setting is a new field in the document and its validation, not a new operation.
- **Handoff**: a bot passes a task to another bot and waits for the reply in the same turn.
- **Host**: another of your machines, listed under `hosts` in the configuration. Its bots are addressed as `host/bot`.
- **Chain**: the bots working on one request, each named with its machine, for example `pc/handler -> mac/research -> pc/writer`.
- **Session**: one ongoing pi conversation per bot. Handoffs to a bot go into its session, so the bot remembers its own work.

## Rules

1. Routing reads bot descriptions and nothing else. Past sessions do not count.
2. Any bot can hand off to any other bot, with three exceptions: a handler, a bot already in the chain, and any handoff deeper than three bots. A handler takes work only from another machine's handler, directly, so a worker never steers a bot that has `configure`. A refusal goes back to the caller as the tool result.
3. `configure` takes a [JSON merge patch](https://www.rfc-editor.org/rfc/rfc7386). Either the whole patch applies or nothing changes, and the result lists every problem. Unknown fields are refused, so typos fail loudly.
4. When a bot's pi starts, it applies that bot's `model` and `tools`. A bot with `tools: []` gets only the team tools and its own system prompt. Other bots keep pi's coding prompt, and the team section is added to it.
5. Each bot works in its own folder unless it has a `workspace`.
6. Only the owner sets `hosts`, through `botmode setup <invite>` and `teardown` (or by editing `config.json`). `configure` refuses them because every handoff to a host carries the token. A host checks each handoff against its own team and refuses relays to a third machine.

## Design

```
pi TUI (handler) ── handoff tool ──spawn──▶ pi -p child (BOTMODE_BOT=research, BOTMODE_CHAIN=handler)
   │                    ▲  steps stream back as tool updates           │ same extension, its own session
   │ configure          └──────────────── reply ─────────────────────┘ │ may hand off further (chain grows)
   ▼
~/.botmode/config.json  (merge patch + validation, written atomically; every pi reads it fresh)

handoff to mac/dev ──HTTPS on the tailnet, token──▶ Mac: botmode host ──spawn──▶ pi -p child (dev)
   ◀── {steps} lines as they happen, then {ok, text} ──┘   dev hands work back the same way
```

- **Identity comes from the environment.** `BOTMODE_BOT` names the bot, and `BOTMODE_CHAIN` lists the bots waiting on it. The child process sets them. The model cannot change them.
- **The system prompt is rebuilt each turn** from the configuration, so a bot created mid-conversation is in the roster from the next message on.
- **A host is one loopback HTTP endpoint.** `GET /bots` lists its bots. `POST /handoff {bot, prompt, chain}` runs one and streams NDJSON: `{steps}` lines, then `{ok, text}`. `POST /join {name, url}` connects a machine once the host has checked it can call it back, and `POST /leave {url}` disconnects one. All of them require `Authorization: Bearer <token>`. Rosters are fetched each turn, so a new bot on the Mac appears on the PC with the next message.
- **The `botmode` command** (`cli.mjs`) is the wizard and the background-host plumbing. It uses pi's own sign-in flows and model list, so it adds no dependencies.
- **Pure parts are exported and tested**: `mergePatch`, `problems`, `applyPatch`, `refusal`, `teamPrompt` and the invite. The host protocol, including join and leave, is tested over loopback. The process and TUI wiring, and two-way handoffs through `tailscale serve`, are checked live.

## Next slices

1. **Background handoffs**: hand work off without waiting. The reply arrives later as a message in the handler's conversation.
2. **Routines**: a `routines` section (`{bot, prompt, every | cron | webhook}`) and a scheduler that sends their prompts. The handler configures routines through the same `configure`.
3. **Approvals**: the owner confirms risky patches, such as removing a bot or changing a workspace, in the TUI before they apply.
4. **Connected apps**: MCP servers per bot as a configuration field.

## Known limits

- Handoffs are synchronous, so the whole chain waits.
- Two handoffs to the same bot at the same time would share its pi session.
- Esc kills only the bot the handler is waiting on. Bots further down the chain, and processes their tools started, keep running until they finish.
- Every machine shares one token, so anyone holding it can run any bot on any of your machines.
- Switching Node versions with a version manager such as nvm moves the global `botmode`, so the host's start at login breaks. Run `botmode setup` again after switching.
- A machine's bots are reachable only while its host runs. A host that is off adds up to 3 seconds to each turn, while its roster times out.
- A worker's reply flows back into the handler, which can configure the team and run any command your account can, on its machine and, through the other handlers, on your other machines. Workers cannot hand off to a handler, but a poisoned reply could still steer one. Approvals (slice 3) close this.
