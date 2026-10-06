import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.BOTMODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "botmode-"));
process.env.BOTMODE_MACHINE = "pc";
process.env.BOTMODE_PI = fileURLToPath(new URL("fake-pi.mjs", import.meta.url)); // Bots run as fake-pi.mjs.
const { default: botmode, DEFAULT, HOME, MAX_CHAIN, applyPatch, callHost, handOver, inviteCode, loadConfig, mergePatch, problems, readInvite,
  refusal, remoteTeams, saveToken, serve, setHost, teamPrompt, working } = await import("./botmode.mjs");

/**
 * Loads the extension the way pi does: in the owner's window (no session), or in a bot's session such as "research.2",
 * which a window shows when you enter it and a bot's own pi runs without one.
 */
async function open(session, { window = !session } = {}) {
  const tools = {}, commands = {}, events = {}, sent = [], status = {}, switched = [], notes = [];
  botmode({
    on: (name, handler) => { events[name] = handler; },
    registerTool: (tool) => { tools[tool.name] = tool; },
    registerCommand: (name, command) => { commands[name] = command; },
    sendMessage: (message, options) => sent.push({ ...message, ...options }),
    setActiveTools: (names) => { status.tools = names; },
    setModel: async () => true,
    setThinkingLevel: () => {},
  });
  const ctx = {
    hasUI: window,
    isIdle: () => false,
    ui: { notify: (text) => notes.push(text), setStatus: (key, text) => { status[key] = text; }, setWidget: () => {}, select: async () => undefined,
      confirm: async () => false, input: async () => undefined },
    sessionManager: {
      getSessionId: () => session ?? "owner",
      getSessionDir: () => session ? path.join(HOME, "sessions") : path.join(HOME, "owner"),
      getSessionFile: () => session ? undefined : path.join(HOME, "owner", "owner.jsonl"),
    },
    modelRegistry: { find: () => undefined },
    switchSession: async (file) => { switched.push(file); return { cancelled: false }; },
  };
  await events.session_start({ type: "session_start" }, ctx);
  const call = async (name, params) => (await tools[name].execute("call", params, undefined, undefined, ctx)).content[0].text;
  return { ctx, call, commands, sent, status, switched, notes, close: () => events.session_shutdown({ type: "session_shutdown", reason: "quit" }, ctx) };
}

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
  assert.match(teamPrompt(config, "handler"), /Current configuration:/);
  assert.doesNotMatch(teamPrompt(config, "research"), /Current configuration:|- research/);
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
    assert.match(handler.sent[0].content, /^research replied:\nresearch heard: \[Handed over by Handler on pc\]\nslow: find sources$/);
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
    assert.equal(copy.status.botmode, "research.2 · /sessions goes back to your handler");
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

test("you message a bot at work from /sessions, and a message it gets as it finishes is its next turn", async () => {
  const handler = await open();
  handler.ctx.ui.select = async (title, options) => options.find((option) => option.startsWith(title === "Sessions" ? "research · working" : "Send"));
  handler.ctx.ui.input = async () => "also check the archive";
  try {
    assert.match(await handler.call("handoff", { bot: "research", session: "continue", task: "slow: long survey" }), /working on it/);
    await handler.commands.sessions.handler("", handler.ctx);
    assert.deepEqual(handler.notes, ["Sent to research."]);
    // fake-pi never reads its mail, so the message is still waiting when research finishes the survey.
    await until(() => handler.sent.length);
    assert.match(handler.sent[0].content, /^research replied:\nresearch heard: .*slow: long survey\n\n/s);
    assert.match(handler.sent[0].content, /\| \[Message from handler; answer with message to handler\]\nalso check the archive$/);
  } finally {
    handler.close();
  }
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
    // A worker on another machine never reaches this machine's handler, by message either.
    assert.equal((await (await callHost(config.hosts.self.url, "message", { to: "handler", from: "mac/a", text: "hi" })).json()).text,
      "Refused: only your handler messages pc's handler.");
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
