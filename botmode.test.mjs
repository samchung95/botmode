import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.BOTMODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "botmode-"));
process.env.BOTMODE_MACHINE = "pc";
process.env.BOTMODE_PI = "unused"; // serve() requires it; no bot runs in these tests.
const { DEFAULT, HOME, MAX_CHAIN, applyPatch, callHost, handOver, inviteCode, loadConfig, mergePatch, problems, readInvite, refusal, remoteTeams,
  saveToken, serve, setHost, teamPrompt } = await import("./botmode.mjs");

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
    assert.deepEqual(teams.self.map((bot) => bot.id), ["research", "a", "b", "c"]);
    assert.match(teamPrompt(config, "handler", teams), /- self\/a \(a\): a/);
    assert.equal(refusal(config, ["pc/handler"], "self/a", "go"), "");
    assert.match(refusal(config, ["pc/handler"], "nas/a", "go"), /no host 'nas'/);
    // Handlers talk to each other's machines, directly; workers never reach a handler.
  assert.equal(refusal(config, ["pc/handler"], "self/handler", "go"), "");
  assert.match(refusal(config, ["pc/handler", "pc/a"], "self/handler", "go"), /only your handler talks to self\/handler/);
  assert.equal(refusal(config, ["mac/handler"], "handler", "go"), ""); // As the host, from the Mac's handler.
  assert.match(refusal(config, ["pc/handler"], "handler", "go"), /no bot 'handler'/); // Its own handler.
  assert.match(refusal(config, ["mac/handler", "mac/a"], "handler", "go"), /no bot 'handler'/);
  assert.match(teamPrompt(config, "handler", { self: [] }), /- self\/handler: the handler on self/);
  assert.doesNotMatch(teamPrompt(config, "a", { self: [] }), /self\/handler/);
    // The host checks again against its own team. Both ends are machine "pc" here, so pc/a is already in the chain.
    assert.match((await handOver(config, "self/nobody", "go", ["pc/handler"], undefined, () => {})).text, /no bot 'nobody'/);
    assert.match((await handOver(config, "self/a", "go", ["pc/a"], undefined, () => {})).text, /a is already working/);
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
