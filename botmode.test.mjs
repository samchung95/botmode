import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.BOTMODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "botmode-"));
process.env.BOTMODE_MACHINE = "pc";
process.env.BOTMODE_PI = fileURLToPath(new URL("fake-pi.mjs", import.meta.url)); // Bots run as fake-pi.mjs,
process.env.BOTMODE_CLAUDE = fileURLToPath(new URL("fake-claude.mjs", import.meta.url)); // and Claude Code bots as fake-claude.mjs.
const { default: botmode, DEFAULT, HOME, MAX_CHAIN, applyPatch, callHost, colourOf, handOver, inviteCode, loadConfig, mergePatch, problems, readInvite,
  refusal, remoteTeams, saveToken, serve, setHost, teamPrompt, working } = await import("./botmode.mjs");

/**
 * Loads the extension the way pi does: in the owner's window (no session), or in a bot's session such as "research.2",
 * which a window shows when you enter it and a bot's own pi runs without one.
 */
async function open(session, { window = !session } = {}) {
  const tools = {}, commands = {}, events = {}, sent = [], status = {}, switched = [], notes = [], dispatched = [];
  const screen = { text: "", menu: false }; // What is typed at the prompt, and whether a menu has the keyboard instead.
  let keys;
  botmode({
    on: (name, handler) => { events[name] = handler; },
    registerTool: (tool) => { tools[tool.name] = tool; },
    registerCommand: (name, command) => { commands[name] = command; },
    sendMessage: (message, options) => sent.push({ ...message, ...options }),
    registerMessageRenderer: () => {},
    sendUserMessage: (text) => dispatched.push(text),
    setActiveTools: (names) => { status.tools = names; },
    setModel: async () => true,
    setThinkingLevel: () => {},
  });
  const ctx = {
    hasUI: window,
    isIdle: () => window, // A bot's own pi is at work; a window waits for you.
    ui: { notify: (text) => notes.push(text), setStatus: (key, text) => { status[key] = text; }, select: async () => undefined,
      confirm: async () => false, input: async () => undefined, getEditorText: () => screen.text, setEditorText: (text) => { screen.text = text; },
      // pi's prompt editor is the one part of its screen with onExtensionShortcut.
      setWidget: (_key, content) => typeof content === "function" && content({ getFocusedComponent: () => screen.menu ? {} : { onExtensionShortcut: undefined } }),
      onTerminalInput: (handler) => { keys = handler; return () => {}; } },
    sessionManager: {
      getSessionId: () => session ?? "owner",
      getSessionDir: () => session ? path.join(HOME, "sessions") : path.join(HOME, "owner"),
      getSessionFile: () => session ? fileOf(session) : path.join(HOME, "owner", "owner.jsonl"),
    },
    modelRegistry: { find: () => undefined },
    switchSession: async (file) => { switched.push(file); return { cancelled: false }; },
  };
  await events.session_start({ type: "session_start" }, ctx);
  const call = async (name, params) => (await tools[name].execute("call", params, undefined, undefined, ctx)).content[0].text;
  return { ctx, call, commands, sent, status, switched, notes, dispatched, screen,
    prompt: async () => (await events.before_agent_start({ type: "before_agent_start", systemPrompt: "pi's prompt" }, ctx)).systemPrompt,
    skills: async () => (await events.resources_discover({ type: "resources_discover", cwd: HOME, reason: "startup" }, ctx))?.skillPaths ?? [],
    press: (key) => keys(key), type: (text) => events.input({ type: "input", text, source: "interactive" }, ctx),
    close: (event = { reason: "quit" }) => events.session_shutdown({ type: "session_shutdown", ...event }, ctx),
    // pi switching this window to another session: it asks first, stops what this one does, then closes it.
    leave: async (targetSessionFile) => {
      await events.session_before_switch({ type: "session_before_switch", reason: "resume", targetSessionFile }, ctx);
      events.session_shutdown({ type: "session_shutdown", reason: "resume", targetSessionFile }, ctx);
    } };
}

/** The newest file of a bot session, which is the one pi opens. */
const fileOf = (session) => fs.readdirSync(path.join(HOME, "sessions")).filter((name) => name.endsWith(`_${session}.jsonl`)).sort()
  .map((name) => path.join(HOME, "sessions", name)).at(-1);

async function until(check, ms = 8000) {
  for (const end = Date.now() + ms; !check(); await new Promise((resolve) => setTimeout(resolve, 50))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${check}`);
  }
}

test("merge patches merge objects, delete on null and replace everything else", () => {
  const merged = mergePatch({ a: { b: 1, c: 2 }, list: [1] }, { a: { b: null, d: 3 }, list: [2], e: "x" });
  assert.deepEqual({ ...merged, a: { ...merged.a } }, { a: { c: 2, d: 3 }, list: [2], e: "x" });
});

test("the handler creates a bot that then appears in the roster", () => {
  assert.deepEqual(applyPatch({ bots: { research: { name: "Researcher", description: "Finds and summarizes sources" } } }), []);
  const config = JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf-8"));
  assert.equal(config.bots.research.name, "Researcher");
  assert.match(teamPrompt(config, "handler"), /- research \(Researcher\): Finds and summarizes sources/);
  assert.doesNotMatch(teamPrompt(config, "research"), /configure-team|- research/);
});

test("a bad patch changes nothing and lists every problem", () => {
  const before = fs.readFileSync(path.join(HOME, "config.json"), "utf-8");
  for (const [patch, problem] of [
    [{ bots: { handler: null } }, /handler cannot be removed/],
    [{ bots: { "Bad Id": { name: "x", description: "y" } } }, /an id is/],
    [{ bots: { handler: { descripton: "typo" } } }, /descripton is not a bot field/],
    [{ bots: { a: { name: "A", description: "a", workspace: "relative" } } }, /existing absolute folder/],
    [{ bots: { a: { name: "A" } }, extra: 1 }, /extra is not a configuration section[\s\S]*bots.a.description is required/],
    [JSON.parse('{"bots": {"__proto__": {"name": "x", "description": "y"}}}'), /__proto__: an id is/],
    [{ bots: { a: { name: "A", description: "a", agent: "codex" } } }, /bots.a.agent must be "pi" or "claude"/],
    [{ bots: { handler: { agent: "claude" } } }, /bots.handler.agent: the handler works in pi/],
    [{ bots: { a: { name: "A", description: "a", agent: "claude", tools: ["read"] } } }, /bots.a.tools: a bot in Claude Code has Claude Code's tools/],
    [{ bots: { research: { archived: ["a", "research.x"] } } }, /bots.research.archived must list research or its copies, such as research.2/],
    [{ bots: { research: { archived: "research" } } }, /bots.research.archived must be a list/],
    [{ bots: { handler: { archived: ["handler"] } } }, /bots.handler.archived: the handler cannot be archived/],
    ["not an object", /must be a JSON object/],
  ]) assert.match(applyPatch(patch).join("\n"), problem);
  assert.equal(fs.readFileSync(path.join(HOME, "config.json"), "utf-8"), before);
});

test("the handler hands work out and carries on; the reply arrives later as a message that starts a turn", async () => {
  const handler = await open();
  try {
    assert.match(await handler.call("handoff", { bot: "research", session: "continue", task: "slow: find sources" }), /research is working on it/);
    assert.equal(handler.sent.length, 0);
    await until(() => handler.sent.length);
    // The bot learns where to reach the session that handed it the task.
    assert.match(handler.sent[0].content, /^research replied:\nresearch heard: \[Handed over by Handler on pc, who gets your reply when you finish; to ask or tell them something before then, message handler\]\nslow: find sources$/);
    assert.equal(handler.sent[0].triggerTurn, true);
  } finally {
    handler.close();
  }
});

test("a busy bot refuses 'continue'; 'fresh' and 'copy' run beside it as copies of their own", async () => {
  const handler = await open();
  try {
    assert.match(await handler.call("handoff", { bot: "research", session: "continue", task: "slow: first" }), /working on it/);
    assert.match(await handler.call("handoff", { bot: "research", session: "continue", task: "second" }), /research failed: research is busy/);
    assert.match(await handler.call("handoff", { bot: "research", session: "fresh", task: "second" }),
      /^research\.2 replied:\nresearch\.2 heard: [^|]*second$/); // A new copy remembers nothing.
    assert.match(await handler.call("handoff", { bot: "research", session: "copy", task: "third" }),
      /^research\.3 replied:\nresearch\.3 heard: .*find sources.*first.*third$/s); // A copy remembers research's session.
    assert.match(await handler.call("handoff", { bot: "research.2", session: "continue", task: "fourth" }), /research\.2 heard: [^|]*second[^|]*\|[^|]*fourth$/);
    await until(() => handler.sent.length); // research's first task.
  } finally {
    handler.close();
  }
});

test("bots message each other while they work, and a sender can wait for the answer", async () => {
  const handler = await open();
  let research;
  try {
    assert.match(await handler.call("message", { to: "research", text: "Any sources yet?" }), /research is not working right now/);
    await handler.call("handoff", { bot: "research", session: "continue", task: "slow: survey" });
    research = await open("research"); // research's pi, at work on the survey.
    assert.match(teamPrompt(loadConfig(), "handler", {}, working()), /Working right now \(reach them with message\):\n- research: slow: survey/);
    const asking = handler.call("message", { to: "research", text: "Any sources yet?", wait: true });
    await until(() => research.sent.length);
    assert.equal(research.sent[0].content, "[Message from handler; answer with message to handler]\nAny sources yet?");
    assert.equal(research.sent[0].deliverAs, "steer"); // It reads it before its next step.
    assert.equal(await research.call("message", { to: "handler", text: "Three so far." }), "Sent to handler.");
    assert.equal(await asking, "research answered:\nThree so far.");
    await until(() => handler.sent.length); // The survey's reply.
  } finally {
    handler.close();
    research?.close();
  }
});

test("← on an empty prompt opens /sessions; while you type, or in a menu, it still moves the cursor", async () => {
  const handler = await open();
  try {
    assert.deepEqual(handler.press("\x1b[D"), { consume: true });
    assert.deepEqual(handler.dispatched, ["/sessions"]);
    handler.screen.text = "fix the typo";
    assert.equal(handler.press("\x1b[D"), undefined);
    handler.screen.text = "";
    handler.screen.menu = true;
    assert.equal(handler.press("\x1b[D"), undefined);
    assert.equal(handler.press("x"), undefined);
    assert.deepEqual(handler.dispatched, ["/sessions"]);
  } finally {
    handler.close();
  }
});

test("/sessions enters a bot's session as that bot, and the overview goes back to the handler", async () => {
  const handler = await open();
  let shown;
  handler.ctx.ui.select = async (_title, options) => {
    shown = options;
    return options.find((option) => option.startsWith("research.2 "));
  };
  try {
    await handler.commands.sessions.handler("", handler.ctx);
    assert.equal(shown[0], "handler · you are here");
    assert.match(shown.join("\n"), /^research\.2 · idle · /m);
    assert.match(handler.switched[0], /_research\.2\.jsonl$/);
    // pi opens research.2's session in this window: you now talk with that copy of research directly.
    const copy = await open("research.2", { window: true });
    assert.equal(copy.status.botmode, "research.2 · ← or /sessions goes back to your handler");
    assert.ok(copy.status.tools.includes("message") && !copy.status.tools.includes("configure"));
    assert.match(await handler.call("handoff", { bot: "research.2", session: "continue", task: "x" }), /research\.2 is busy \(open in your window\)/);
    copy.ctx.ui.select = async (_title, options) => options[0];
    await copy.commands.sessions.handler("", copy.ctx);
    assert.deepEqual(copy.switched, [path.join(HOME, "owner", "owner.jsonl")]);
    copy.close(); // pi closes the copy's session as it switches back.
    assert.match(await handler.call("handoff", { bot: "research.2", session: "continue", task: "back" }), /^research\.2 replied/);
  } finally {
    handler.close();
  }
});

test("a new copy can work in a folder of its own, and keeps it", async () => {
  const handler = await open();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  const folder = (reply) => reply.slice(reply.lastIndexOf(" in ") + " in ".length);
  let shown;
  handler.ctx.ui.select = async (_title, options) => { shown = options; };
  try {
    const moved = await handler.call("handoff", { bot: "research", session: "copy", folder: repo, task: "where are you" });
    assert.match(moved, /^research\.4 replied:\nresearch\.4 heard: .*find sources/s); // It remembers research's session,
    assert.equal(folder(moved), repo); // and works in the folder it was given.
    const again = await handler.call("handoff", { bot: "research.4", session: "continue", task: "where now" });
    assert.match(again, /where are you.*\|.*where now/s);
    assert.equal(folder(again), repo);
    assert.equal(folder(await handler.call("handoff", { bot: "research.4", session: "fresh", task: "where" })), repo);
    assert.notEqual(folder(await handler.call("handoff", { bot: "research", session: "fresh", task: "where" })), repo);
    assert.match(await handler.call("handoff", { bot: "research", session: "fresh", folder: "relative", task: "x" }), /relative is not a folder on pc/);
    assert.match(await handler.call("handoff", { bot: "research.4", session: "continue", folder: repo, task: "x" }), /keeps its folder/);
    await handler.commands.sessions.handler("", handler.ctx);
    assert.ok(shown.includes(`research.4 · idle · just now · ${repo}`), shown.join("\n"));
  } finally {
    handler.close();
  }
});

test("/sessions opens a bot at work to watch, what you type goes to it, and once it is done you talk with it", async () => {
  const handler = await open();
  handler.ctx.ui.select = async (_title, options) => options.find((option) => option.startsWith("research · working"));
  let watched, talking, menu;
  try {
    assert.match(await handler.call("handoff", { bot: "research", session: "continue", task: "slow: long survey" }), /working on it/);
    await handler.commands.sessions.handler("", handler.ctx);
    assert.deepEqual(handler.switched, [fileOf("research")]);
    // pi opens research's session in this window while research's own pi still works in it.
    watched = await open("research", { window: true });
    assert.match(watched.status.botmode, /^research is at work/);
    assert.equal(watched.status.tools, undefined); // It writes nothing to the session, not even research's model.
    assert.deepEqual(await watched.type("also check the archive"), { action: "handled" });
    assert.deepEqual(watched.notes, ["Sent to research."]);
    watched.ctx.ui.select = async (title, options) => title === "Sessions" ? options.find((option) => option.startsWith("research · you are here"))
      : (menu = options, undefined);
    await watched.commands.sessions.handler("", watched.ctx);
    assert.deepEqual(menu, ["Send research a message", "Stop research"]);
    // fake-pi never reads its mail, so the message is still waiting when research finishes the survey, and is its next turn.
    await until(() => handler.sent.length);
    assert.match(handler.sent[0].content, /^research replied:\nresearch heard: .*slow: long survey\n\n/s);
    assert.match(handler.sent[0].content, /\| \[Message from handler; answer with message to handler\]\nalso check the archive$/);
    // Done, research is yours: the window opens its session again, now to talk with it.
    await until(() => watched.dispatched.includes("/sessions research"));
    await watched.commands.sessions.handler("research", watched.ctx);
    assert.deepEqual(watched.switched, [fileOf("research")]);
    watched.close({ reason: "resume", targetSessionFile: fileOf("research") });
    talking = await open("research", { window: true });
    assert.equal(talking.status.botmode, "research · ← or /sessions goes back to your handler");
    assert.ok(talking.status.tools.includes("message"));
    assert.match(await handler.call("handoff", { bot: "research", session: "continue", task: "x" }), /research is busy \(open in your window\)/);
  } finally {
    handler.close();
    talking?.close();
  }
});

test("leaving a session at work leaves it working: it carries on without you, and you can come back and watch it", async () => {
  const home = path.join(HOME, "owner", "owner.jsonl");
  fs.mkdirSync(path.dirname(home), { recursive: true });
  fs.writeFileSync(home, `${JSON.stringify({ type: "session", cwd: process.cwd() })}\n`);
  const lastReply = (file) => fs.readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line)).at(-1).message?.content[0].text;
  const handler = await open();
  let copy, back;
  try {
    handler.ctx.isIdle = () => false; // Your handler is mid-reply as you open research.2, and nothing asks first.
    handler.ctx.ui.select = async (_title, options) => options.find((option) => option.startsWith("research.2 "));
    await handler.commands.sessions.handler("", handler.ctx);
    process.env.FAKE_PI_SLOW = "1";
    await handler.leave(handler.switched[0]); // pi stops the reply as it switches; your handler carries on without you,
    delete process.env.FAKE_PI_SLOW;
    copy = await open("research.2", { window: true });
    let shown;
    copy.ctx.ui.select = async (_title, options) => (shown = options, options[0]);
    copy.ctx.isIdle = () => false; // and so does research.2 when you go back mid-reply.
    await copy.commands.sessions.handler("", copy.ctx);
    assert.equal(shown[0], "handler · back to your conversation · working");
    await copy.leave(home);
    assert.match(working().find((session) => session.id === "research.2")?.task ?? "", /^Carry on where you stopped/);
    // Your handler's conversation is still at work: you watch it, and what you type reaches it.
    back = await open();
    assert.match(back.status.botmode, /^handler is at work/);
    assert.deepEqual(await back.type("and the mac"), { action: "handled" });
    assert.deepEqual(back.notes, ["Sent to your handler."]);
    // Your message waited for its turn to end and was its next, the window opening the conversation again as it went.
    await until(() => / \| and the mac$/.test(lastReply(home)), 15000);
    assert.match(lastReply(home), /^owner heard: Carry on where you stopped/);
    assert.ok(back.dispatched.includes("/sessions handler"));
    assert.match(lastReply(fileOf("research.2")), /^research\.2 heard: .*\| Carry on where you stopped/s);
  } finally {
    handler.close();
    copy?.close();
    back?.close();
  }
});

test("in rooms, the lobby opens a session in a room of its own and never stops the one you leave", async () => {
  const asked = []; // What the rooms (the botmode command) hear from this window's pis.
  const rooms = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    asked.push(JSON.parse(body));
    res.end();
  });
  await once(rooms.listen(0, "127.0.0.1"), "listening");
  process.env.BOTMODE_ROOMS = `http://127.0.0.1:${rooms.address().port}/secret`;
  process.env.BOTMODE_ROOM = "handler";
  const opened = () => asked.filter((message) => message.open);
  const said = () => asked.filter((message) => message.room === "research.2" && !message.open).at(-1);
  const handler = await open();
  let copy;
  try {
    handler.ctx.isIdle = () => false; // Your handler is mid-reply as you open research.2.
    handler.ctx.ui.select = async (_title, options) => options.find((option) => option.startsWith("research.2 "));
    await handler.commands.sessions.handler("", handler.ctx);
    assert.deepEqual(handler.switched, []); // This pi stays on your conversation, at work.
    assert.deepEqual(opened(), [{ room: "handler", busy: true, open: "research.2",
      args: ["--session-dir", path.join(HOME, "sessions"), "--session", fileOf("research.2")], cwd: path.join(HOME, "bots", "research") }]);
    // research.2's room: you talk with research.2, and the lobby takes you back to your handler's room.
    process.env.BOTMODE_ROOM = "research.2";
    copy = await open("research.2", { window: true });
    assert.match(await handler.call("handoff", { bot: "research.2", session: "continue", task: "x" }), /research\.2 is busy \(open in your window\)/);
    copy.ctx.ui.select = async (_title, options) => options[0];
    await copy.commands.sessions.handler("", copy.ctx);
    assert.deepEqual(copy.switched, []);
    assert.deepEqual(opened().at(-1), { room: "research.2", busy: false, open: "handler" });
    // A room says when its work starts and ends, so the rooms keep it while it works and close it once it is done.
    copy.ctx.isIdle = () => false;
    await until(() => said()?.busy);
    copy.ctx.isIdle = () => true;
    await until(() => said().busy === false);
  } finally {
    delete process.env.BOTMODE_ROOMS;
    delete process.env.BOTMODE_ROOM;
    rooms.close();
    handler.close();
    copy?.close();
  }
});

test("bots take colours in turn, copies share their bot's, and the colours go round again", () => {
  assert.equal(colourOf("research.2"), colourOf("research"));
  assert.notEqual(colourOf("handler"), colourOf("research"));
  const far = Array.from({ length: 9 }, (_, n) => colourOf(`far/bot${n}`));
  assert.equal(new Set(far.slice(0, 8)).size, 8);
  assert.equal(far[8], far[0]);
  assert.equal(colourOf("far/bot0.3"), far[0]);
});

test("handoffs refuse the handler, cycles, long chains and empty tasks", () => {
  applyPatch({ bots: Object.fromEntries(["a", "b", "c"].map((id) => [id, { name: id, description: id }])) });
  const config = loadConfig();
  assert.equal(refusal(config, ["pc/handler"], "a", "go"), "");
  assert.equal(refusal(config, ["mac/handler", "mac/a"], "a", "go"), ""); // The a on another machine is a different bot.
  assert.match(refusal(config, ["pc/a"], "handler", "go"), /no bot 'handler' to hand to/);
  assert.match(refusal(config, ["pc/handler", "pc/a", "pc/b"], "a", "go"), /a is already working on this request \(pc\/handler -> pc\/a -> pc\/b\)/);
  assert.match(refusal(config, ["pc/handler", "pc/a", "pc/b"], "c", "go"), new RegExp(`stop ${MAX_CHAIN} bots deep`));
  assert.match(refusal(config, ["pc/handler"], "a", " "), /task is empty/);
  assert.equal(refusal(config, ["pc/handler"], "pc/a", "go"), ""); // pc/a, on pc, is the a here.
});

test("a bot that waits in handoff for the reply is reached only by the reply, so it asks for questions in it", async () => {
  const research = await open("research"); // research's own pi, at work.
  try {
    assert.equal(await research.call("handoff", { bot: "b", session: "continue", task: "go" }),
      "b replied:\nb heard: [Handed over by Researcher on pc, who waits for your reply; put any question in it]\ngo");
  } finally {
    research.close();
  }
});

test("only the owner sets hosts, and a host's bots join the team over HTTP", async () => {
  assert.match(applyPatch({ hosts: { evil: { url: "https://example.com" } } }).join(), /set by the owner/);
  assert.match(problems({ ...DEFAULT, hosts: { mac: { url: "ftp://mac" } } }).join(), /hosts.mac must be/);
  fs.writeFileSync(path.join(HOME, "token"), "a".repeat(64));
  const server = serve(0);
  await once(server, "listening");
  const config = { ...loadConfig(), hosts: { self: { url: `http://127.0.0.1:${server.address().port}` } } };
  try {
    const teams = await remoteTeams(config);
    assert.deepEqual(teams.self.bots.map((bot) => bot.id), ["research", "a", "b", "c"]);
    assert.match(teamPrompt(config, "handler", teams), /- self\/a \(a\): a/);
    assert.match(teamPrompt(config, "handler", { self: { bots: [], working: [{ id: "a.2", task: "go" }] } }), /- self\/a\.2: go/);
    // A worker on another machine reaches this machine's handler, by message, only while at work on a task from it.
    for (const chain of [undefined, ["pc/handler", "mac/b"]]) {
      assert.equal((await (await callHost(config.hosts.self.url, "message", { to: "handler", from: "mac/a", text: "hi", chain })).json()).text,
        "Refused: pc's handler hears only from your handler, and from bots at work on a task it handed them.");
    }
    assert.equal(refusal(config, ["pc/handler"], "self/a", "go"), "");
    assert.match(refusal(config, ["pc/handler"], "nas/a", "go"), /no host 'nas'/);
    // Handlers talk to each other's machines, directly; workers never reach a handler.
  assert.equal(refusal(config, ["pc/handler"], "self/handler", "go"), "");
  assert.match(refusal(config, ["pc/handler", "pc/a"], "self/handler", "go"), /only your handler talks to self\/handler/);
  assert.equal(refusal(config, ["mac/handler"], "handler", "go"), ""); // As the host, from the Mac's handler.
  assert.match(refusal(config, ["pc/handler"], "handler", "go"), /no bot 'handler'/); // Its own handler.
  assert.match(refusal(config, ["mac/handler", "mac/a"], "handler", "go"), /no bot 'handler'/);
  assert.match(teamPrompt(config, "handler", { self: { bots: [], working: [] } }), /- self\/handler: the handler on self/);
  assert.doesNotMatch(teamPrompt(config, "a", { self: { bots: [], working: [] } }), /self\/handler/);
    // The host checks again against its own team. Both ends are machine "pc" here, so pc/a is already in the chain.
    assert.match((await handOver(config, "self/nobody", { session: "continue" }, "go", ["pc/handler"], undefined, () => {})).text, /no bot 'nobody'/);
    assert.match((await handOver(config, "self/a", { session: "continue" }, "go", ["pc/a"], undefined, () => {})).text, /a is already working/);
    // A new copy's folder travels with the handoff and is checked on the bot's machine.
    assert.match((await handOver(config, "self/a", { session: "fresh", folder: "relative" }, "go", ["pc/handler"], undefined, () => {})).text,
      /relative is not a folder on pc/);
    // /sessions reaches a bot at work on another machine by its session there, and offers to stop the job this window started.
    assert.deepEqual(setHost("self", config.hosts.self.url), []);
    const handler = await open();
    let menu, started;
    handler.ctx.ui.select = async (title, options) => title === "Sessions" ? options.find((option) => option.startsWith("self/a.2 · working on self"))
      : (menu = options)[0];
    handler.ctx.ui.input = async () => "come back";
    try {
      const job = handOver(loadConfig(), "self/a", { session: "fresh" }, "slow: far away", ["pc/handler"], undefined, (steps) => { started = steps; });
      await until(() => started);
      await handler.commands.sessions.handler("", handler.ctx);
      assert.deepEqual(menu, ["Send self/a.2 a message", "Stop self/a.2"]);
      assert.deepEqual(handler.notes, ["Sent to self/a.2."]);
      assert.match((await job).text, /\[Message from pc\/handler; answer with message to pc\/handler\]\ncome back$/);
    } finally {
      handler.close();
    }
    // A handoff to a machine's handler while its window is open goes into that conversation, as a message from the sender.
    const window = await open();
    try {
      const outcome = await handOver(loadConfig(), "self/handler", { session: "continue" }, "set up the bots", ["mac/handler"], undefined, () => {});
      assert.match(outcome.text, /in pc's window/);
      await until(() => window.sent.length);
      assert.equal(window.sent[0].content, "[Message from mac/handler; answer with message to mac/handler]\nset up the bots");
      assert.deepEqual(window.sent[0].details, { from: "mac/handler" }); // Drawn in mac/handler's colour.
      // A bot on another machine is told to reach the window at pc/handler, which takes its messages while it works for it.
      assert.match(await window.call("handoff", { bot: "self/a", session: "fresh", task: "slow: go" }), /working on it in the background/);
      await until(() => window.sent.length > 1);
      assert.match(window.sent[1].content, /heard: \[Handed over by Handler on pc, who gets your reply when you finish; to ask or tell them something before then, message pc\/handler\]\nslow: go$/);
      assert.equal((await (await callHost(config.hosts.self.url, "message", { to: "handler", from: "mac/a", text: "hi", chain: ["pc/handler"] })).json()).text,
        "Sent to handler.");
      await until(() => window.sent.length > 2);
      assert.equal(window.sent[2].content, "[Message from mac/a; answer with message to mac/a]\nhi");
    } finally {
      window.close();
      setHost("self", null);
    }
    fs.writeFileSync(path.join(HOME, "token"), "b".repeat(64));
    assert.match(teamPrompt(config, "handler", await remoteTeams(config)), /- self\/…: unavailable right now \(answered 401/);
  } finally {
    server.close();
  }
});

test("an invite carries the token, and machines join and leave each other", async () => {
  saveToken("c".repeat(64));
  const mac = { name: "mac", url: "https://mac.example.ts.net:8445", token: "c".repeat(64) };
  assert.deepEqual(readInvite(inviteCode(mac.name, mac.url)), mac);
  for (const code of ["botmode1.garbage", "hello", inviteCode("Bad Id", mac.url), inviteCode("mac", "ftp://mac")]) {
    assert.throws(() => readInvite(code), /not a Botmode invite/);
  }
  assert.match(setHost("mac", "ftp://mac").join(), /hosts.mac must be/);
  const server = serve(0);
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    // This host plays the joining machine too, so the check that it can call back succeeds.
    assert.deepEqual(await (await callHost(url, "join", { name: "mac", url })).json(), { hosts: {} });
    assert.deepEqual(loadConfig().hosts, { mac: { url } });
    await callHost(url, "join", { name: "macbook", url }); // The same machine, renamed, replaces its entry.
    assert.deepEqual(loadConfig().hosts, { macbook: { url } });
    await assert.rejects(callHost(url, "join", { name: "nas", url: "http://127.0.0.1:1" }), /answered 502: .*cannot reach nas/);
    await callHost(url, "leave", { url });
    assert.deepEqual(loadConfig().hosts, {});
  } finally {
    server.close();
  }
});

test("a bot with agent claude works in Claude Code, with no permission prompts, in its own session and in copies", async () => {
  assert.deepEqual(applyPatch({ bots: { coder: { name: "Coder", description: "Writes code", agent: "claude", model: "opus" } } }), []);
  const handler = await open();
  try {
    assert.equal(await handler.call("handoff", { bot: "coder", session: "continue", task: "how do you run" }), "coder replied:\ncoder heard: " +
      "[Handed over by Handler on pc, who gets your reply when you finish; to ask or tell them something before then, message handler]\n" +
      'how do you run · opus, bypassPermissions, ← edits, as "You are Coder. Writes code"');
    assert.match(await handler.call("handoff", { bot: "coder", session: "continue", task: "second" }), /^coder replied:\ncoder heard: .*how do you run \| .*second$/s);
    assert.match(await handler.call("handoff", { bot: "coder", session: "fresh", task: "third" }), /^coder\.2 replied:\ncoder\.2 heard: [^|]*third$/);
    assert.match(await handler.call("handoff", { bot: "coder", session: "copy", task: "fourth" }),
      /^coder\.3 replied:\ncoder\.3 heard: .*how do you run \| .*second \| .*fourth$/s); // A copy remembers coder's conversation.
  } finally {
    handler.close();
  }
});

test("a bot in Claude Code hears messages after each step, and hands work to the team and messages it with the team's tools", async () => {
  const handler = await open();
  const a = await open("a"); // a's own pi, at work.
  try {
    assert.match(await handler.call("handoff", { bot: "coder", session: "continue", task: "slow: refactor" }), /working on it in the background/);
    await until(() => working().some((session) => session.id === "coder"));
    assert.equal(await handler.call("message", { to: "coder", text: "use tabs" }), "Sent to coder.");
    await until(() => handler.sent.length);
    assert.match(handler.sent[0].content, /^coder replied:\ncoder heard: .*slow: refactor \| \[Message from handler; answer with message to handler\]\nuse tabs$/s);
    // It waits for the replies of its handoffs, as a bot in pi does.
    assert.match(await a.call("handoff", { bot: "coder", session: "fresh", task: 'use handoff {"bot":"b","session":"fresh","task":"find docs"}' }),
      /^coder\.4 replied:\ncoder\.4 heard: .* · b\.\d+ replied:\nb\.\d+ heard: \[Handed over by Coder on pc, who waits for your reply; put any question in it\]\nfind docs$/s);
    assert.match(await a.call("handoff", { bot: "coder", session: "fresh", task: 'use message {"to":"handler","text":"done soon"}' }), / · Sent to handler\.$/);
    await until(() => handler.sent.length > 1);
    assert.equal(handler.sent[1].content, "[Message from coder.5; answer with message to coder.5]\ndone soon");
  } finally {
    handler.close();
    a.close();
  }
});

test("the lobby opens a bot in Claude Code in a room of its own, and one at work to watch", async () => {
  const asked = [];
  const rooms = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    asked.push(JSON.parse(body));
    res.end();
  });
  await once(rooms.listen(0, "127.0.0.1"), "listening");
  process.env.BOTMODE_ROOMS = `http://127.0.0.1:${rooms.address().port}/secret`;
  process.env.BOTMODE_ROOM = "handler";
  const handler = await open();
  let pick = "coder ", shown, menu;
  handler.ctx.ui.select = async (title, options) => title === "Sessions" ? (shown = options).find((option) => option.startsWith(pick)) : (menu = options, undefined);
  try {
    await handler.commands.sessions.handler("", handler.ctx);
    assert.ok(shown.includes(`coder · idle · just now · ${path.join(HOME, "bots", "coder")} · Claude Code`), shown.join("\n"));
    const [{ open: room, claude, args, cwd }] = asked.filter((message) => message.open);
    assert.deepEqual([room, claude, cwd], ["coder", true, path.join(HOME, "bots", "coder")]);
    assert.equal(args.at(-2), "--resume");
    assert.match(fs.readFileSync(path.join(HOME, "claude", `${args.at(-1)}.jsonl`), "utf-8"), /how do you run/); // coder's own conversation.
    // A bot at work you watch, in Claude Code too.
    assert.match(await handler.call("handoff", { bot: "coder", session: "fresh", task: "slow: tests" }), /working on it in the background/);
    pick = "coder.6 · working";
    await handler.commands.sessions.handler("", handler.ctx);
    assert.deepEqual(menu, ["Send coder.6 a message", "Stop coder.6"]);
    await until(() => handler.sent.length);
  } finally {
    delete process.env.BOTMODE_ROOMS;
    delete process.env.BOTMODE_ROOM;
    rooms.close();
    handler.close();
  }
  const plain = await open(); // pi started without the botmode command's rooms.
  plain.ctx.ui.select = async (_title, options) => options.find((option) => option.startsWith("coder "));
  try {
    await plain.commands.sessions.handler("", plain.ctx);
    assert.deepEqual(plain.notes, ["coder works in Claude Code, which opens in a room of the `botmode` command's window. Hand it work instead."]);
  } finally {
    plain.close();
  }
});

test("the handler archives a copy, or a whole bot, which leaves the lobby and the team until it brings it back as it was", async () => {
  const handler = await open();
  let shown;
  handler.ctx.ui.select = async (_title, options) => { shown = options; };
  const lobby = async () => {
    await handler.commands.sessions.handler("", handler.ctx);
    return shown.map((option) => option.split(" · ")[0]);
  };
  const sessionsLine = async () => (await handler.call("configure", { patch: {} })).match(/^Bot sessions on this machine: (.*)$/m)?.[1].split(", ") ?? [];
  const gone = /^(research\.2|coder(\.\d+)?)$/;
  const server = serve(0);
  await once(server, "listening");
  const roster = async () => (await remoteTeams({ hosts: { self: { url: `http://127.0.0.1:${server.address().port}` } } })).self.bots.map((bot) => bot.id);
  try {
    // The handler sees the bots' sessions here, so it can archive the ones the owner is done with.
    const before = await sessionsLine();
    assert.ok(["research", "research.2", "research.3", "coder", "coder.2"].every((session) => before.includes(session)), before.join());
    assert.match(await handler.call("configure", { patch: { bots: { research: { archived: ["research.2"] }, coder: { archived: ["coder"] } } } }), /^Applied/);
    const listed = await lobby();
    assert.ok(listed.includes("research") && listed.includes("research.3") && !listed.some((session) => gone.test(session)), listed.join());
    assert.ok(!(await sessionsLine()).some((session) => gone.test(session)));
    assert.doesNotMatch(await handler.prompt(), /^- coder \(/m); // Off the team,
    assert.ok(!(await roster()).includes("coder")); // here and on your other machines.
    assert.match(await handler.call("handoff", { bot: "coder", session: "fresh", task: "go" }), /Refused: coder is archived/);
    assert.match(await handler.call("handoff", { bot: "research.2", session: "continue", task: "go" }), /Refused: research\.2 is archived/);
    assert.match(await handler.call("handoff", { bot: "research.3", session: "continue", task: "still here" }), /^research\.3 replied/);
    // Brought back, each is as it was, history and all.
    assert.match(await handler.call("configure", { patch: { bots: { research: { archived: null }, coder: { archived: null } } } }), /^Applied/);
    const back = await lobby();
    assert.ok(["research.2", "coder", "coder.2"].every((session) => back.includes(session)), back.join());
    assert.ok((await roster()).includes("coder"));
    assert.match(await handler.call("handoff", { bot: "research.2", session: "continue", task: "back again" }), /^research\.2 replied:\nresearch\.2 heard: .*second.*back again$/s);
  } finally {
    server.close();
    handler.close();
  }
});

test("archiving a session at work stops it, and no one can message it", async () => {
  const handler = await open();
  try {
    assert.match(await handler.call("handoff", { bot: "research", session: "fresh", task: "slow: long survey" }), /working on it in the background/);
    await until(() => working().some((session) => /^research\.\d+$/.test(session.id)));
    const copy = working().find((session) => /^research\.\d+$/.test(session.id)).id;
    assert.match(await handler.call("configure", { patch: { bots: { research: { archived: [copy] } } } }), /^Applied/);
    assert.equal(await handler.call("message", { to: copy, text: "still there?" }), `Refused: ${copy} is archived.`);
    await until(() => handler.sent.length);
    assert.equal(handler.sent[0].content, `${copy} failed: Stopped: ${copy} was archived.`);
    assert.ok(!working().some((session) => session.id === copy));
  } finally {
    applyPatch({ bots: { research: { archived: null } } });
    handler.close();
  }
});

test("the handler changes the team with the configure-team skill, which it loads only when it needs it", async () => {
  // Its prompt names the skill instead of carrying the configuration and its fields every turn.
  assert.match(teamPrompt(loadConfig(), "handler"), /load the configure-team skill/);
  assert.doesNotMatch(teamPrompt(loadConfig(), "handler"), /"bots":|workspace/);
  const handler = await open();
  let research;
  try {
    research = await open("research");
    const [skill, ...more] = await handler.skills();
    assert.equal(more.length, 0);
    assert.deepEqual(await research.skills(), []); // Only the handler configures.
    const guide = fs.readFileSync(path.join(skill, "SKILL.md"), "utf-8");
    assert.match(guide, /^---\nname: configure-team\ndescription: .+\n---\n/);
    // Every field configure takes is in the guide.
    const fields = applyPatch({ bots: { handler: { nope: 1 } } }).join().match(/allowed: ([^)]*)/)[1].split(", ");
    for (const field of ["defaults", "hosts", ...fields]) assert.match(guide, new RegExp(`\`${field}`), field);
    // An empty patch changes nothing and shows the configuration and the bot sessions here.
    const shown = await handler.call("configure", { patch: {} });
    assert.match(shown, /^The configuration is:\n\{\n {2}"defaults"/);
    assert.match(shown, /^Bot sessions on this machine: (.+, )?research(, .+)?$/m);
  } finally {
    handler.close();
    research?.close();
  }
});
