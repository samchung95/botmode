// Botmode: a team of bots behind one top-level handler, as a pi extension.
// Every bot is a pi process running this file. Bots' sessions live in ~/.botmode/sessions, named by bot id, so the session
// says which bot this is; any other session is yours, and there this file is the handler. A handoff runs the target bot as
// a child pi in its own ongoing session. `botmode host` (cli.mjs) serves this machine's bots to your other machines, where
// they join the team as host/bot.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HANDLER = "handler";
export const MAX_CHAIN = 3; // handler -> bot -> bot. A deeper handoff is refused so bots cannot pass work around forever.
export const HOME = process.env.BOTMODE_HOME || path.join(os.homedir(), ".botmode");
export const PORT = 18790;
// This machine's name in chains, so a bot here and a bot with the same id on another machine are never confused.
export const MACHINE = (process.env.BOTMODE_MACHINE || os.hostname()).toLowerCase();
const CONFIG = path.join(HOME, "config.json");
const TOKEN = path.join(HOME, "token"); // The secret all your machines share; a host runs bots only for requests that carry it.
const SESSIONS = path.join(HOME, "sessions");
const MAIL = path.join(HOME, "mail"); // One folder per session that reads messages; each message is a JSON file.
const ABOVE = (process.env.BOTMODE_CHAIN || "").split(",").filter(Boolean); // machine/bot entries waiting on this bot, outermost first.
const SELF = fileURLToPath(import.meta.url);
// pi's entry script. Inside pi it is process.argv[1]; the `botmode` command sets BOTMODE_PI after importing this file.
const piEntry = () => process.env.BOTMODE_PI || process.argv[1];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
const SECTIONS = ["defaults", "bots", "hosts"];

// Bot ids double as pi session ids, which must start and end with a letter or digit.
const BOT_ID = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
// A copy of a bot works in a session of its own, research.2, research.3…; session ids allow the dot, bot ids never have one.
const SESSION_ID = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?(?:\.[1-9]\d{0,3})?$/;
// How a handoff starts: in the bot's (or copy's) own session, in a new copy that remembers nothing, or in a copy of the session.
export const START = ["continue", "fresh", "copy"];
// field: [type, required]. Unknown fields are refused so a model's typo never passes silently.
const BOT_FIELDS = {
  name: ["string", true],
  description: ["string", true], // What the bot does; other bots route by it.
  title: ["string", false],
  instructions: ["string", false],
  model: ["string", false], // provider/model[:thinking]; empty uses defaults.model, then pi's default.
  tools: ["list", false], // pi tool names; omitted keeps pi's defaults, [] leaves only the team tools.
  workspace: ["string", false], // An existing absolute folder; omitted gives the bot a folder of its own.
};
// All of pi's tools: files and the terminal, with the rights of the account Botmode runs as.
export const ALL_TOOLS = ["read", "bash", ...(process.platform === "win32" ? ["powershell"] : []), "edit", "write", "grep", "find", "ls"];
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"]; // What pi turns on when a bot names no tools.
export const DEFAULT = {
  defaults: { model: "" },
  bots: {
    [HANDLER]: {
      name: "Handler",
      title: "Top-level handler",
      description: "Answers questions and works on this machine's files and terminal, hands work to the bot whose description " +
        "fits, and configures the team.",
      tools: ALL_TOOLS,
    },
  },
};
const FIELDS = "Bot fields: name and description (required; the description is what routing reads), title, instructions, " +
  "model ('provider/model' or 'provider/model:thinking'; empty uses defaults.model), tools (pi tool names: " +
  `${ALL_TOOLS.join(", ")}; omitted keeps pi's defaults, [] leaves only the team tools), workspace (an existing ` +
  "absolute folder; omitted gives the bot its own folder). Ids are lowercase slugs. hosts lists the owner's other " +
  "machines, whose bots join the team as host/bot; only the owner sets hosts, in config.json.";

// pi loads this file afresh for every session it opens, so what must outlive one lives here: the bots this process runs
// ({name, steps, stop}), the bot sessions open in this window, the owner's own session, and how to redraw the window's list.
const shared = globalThis[Symbol.for("botmode")] ??= { running: new Set(), entered: new Set(), home: undefined, render: undefined };
if (!shared.exitHook) {
  shared.exitHook = true;
  process.once("exit", () => shared.running.forEach((run) => run.stop())); // Bots never outlive the pi that started them.
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isFolder = (folder) => fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isWebUrl = (url) => typeof url === "string" && URL.canParse(url) && /^https?:$/.test(new URL(url).protocol);
const result = (text) => ({ content: [{ type: "text", text }], details: {} });
const reason = (error) => error.cause?.message || error.message; // fetch says only "fetch failed"; the cause says why.

/** "host/bot" -> ["host", "bot"]; a bot on this machine has no host. */
function address(target) {
  const at = target.indexOf("/");
  return at < 0 ? [undefined, target] : [target.slice(0, at), target.slice(at + 1)];
}

const botOf = (session) => session.replace(/\.\d+$/, "");
const lockOf = (session) => path.join(SESSIONS, `${session}.lock`);

/** The {pid, task} of the live process running `session`, if one is. */
function holder(session) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(lockOf(session), "utf-8"));
  } catch (error) {
    return error.code === "ENOENT" ? undefined : { task: "starting" }; // Read between its creation and its first write.
  }
  try {
    process.kill(info.pid, 0);
    return info;
  } catch (error) {
    return error.code === "EPERM" ? info : undefined; // EPERM: alive, but another account's.
  }
}

/** Marks `session` busy, for every process on this machine; false when a live one already has it. */
function claim(session, task) {
  fs.mkdirSync(SESSIONS, { recursive: true });
  if (holder(session)) return false;
  // ponytail: two processes clearing the same dead lock at once could both claim it; lock with a rename if that bites.
  fs.rmSync(lockOf(session), { force: true });
  try {
    fs.writeFileSync(lockOf(session), JSON.stringify({ pid: process.pid, task }), { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false; // Another process claimed it a moment ago.
    throw error;
  }
}

const release = (session) => fs.rmSync(lockOf(session), { force: true });

/** Each bot session on this machine and its newest file, newest first. */
function sessionFiles() {
  const names = fs.existsSync(SESSIONS) ? fs.readdirSync(SESSIONS).filter((name) => name.endsWith(".jsonl")).sort().reverse() : [];
  const files = new Map();
  for (const name of names) {
    const session = name.slice(name.indexOf("_") + 1, -".jsonl".length); // pi names them <time>_<session id>.jsonl.
    if (!files.has(session)) files.set(session, path.join(SESSIONS, name));
  }
  return files;
}

/** The sessions at work on this machine now: [{id, task}]. */
export function working() {
  const locks = fs.existsSync(SESSIONS) ? fs.readdirSync(SESSIONS).filter((name) => name.endsWith(".lock")) : [];
  return locks.map((name) => name.slice(0, -".lock".length)).flatMap((id) => {
    const info = holder(id);
    return info ? [{ id, task: info.task }] : [];
  });
}

/** Why a message from `from` cannot reach `to` on this machine, or "". The handler's mailbox waits for its window. */
function undeliverable(to, from, text) {
  if (typeof text !== "string" || !text.trim()) return "Refused: the message is empty.";
  if (to === from) return "Refused: that is you.";
  if (to === HANDLER || (SESSION_ID.test(to) && holder(to))) return "";
  return `${to} is not working right now, so it reads no messages; hand it a task instead. Working now: ` +
    `${working().map((session) => session.id).join(", ") || "none"}.`;
}

/** Claims the first copy of `bot` that has never run. */
function claimCopy(bot, task) {
  const files = sessionFiles();
  for (let n = 2; ; n++) if (!files.has(`${bot}.${n}`) && claim(`${bot}.${n}`, task)) return `${bot}.${n}`;
}

/**
 * Where `session` works: a bot's own session in its workspace, and a copy in the folder it started in, which pi keeps in
 * the session's first line. pi finds a session only from that folder, so a copy must always run there.
 */
function folderOf(config, session, file = sessionFiles().get(session)) {
  const bot = botOf(session);
  const own = config.bots[bot]?.workspace || path.join(HOME, "bots", bot);
  if (session === bot || !file) return own;
  const head = Buffer.alloc(64 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    const { cwd } = JSON.parse(head.toString("utf-8", 0, fs.readSync(fd, head)).split("\n", 1)[0]);
    return typeof cwd === "string" && cwd ? cwd : own;
  } catch {
    return own;
  } finally {
    fs.closeSync(fd);
  }
}

/** RFC 7386: objects merge recursively, null deletes a key, any other value replaces. */
export function mergePatch(target, patch) {
  if (!isObject(patch)) return structuredClone(patch);
  // A null prototype keeps a "__proto__" key an ordinary key, which validation then refuses.
  const merged = Object.assign(Object.create(null), isObject(target) ? target : {});
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = mergePatch(merged[key], value);
  }
  return merged;
}

export function problems(config) {
  if (!isObject(config)) return ["The configuration must be a JSON object."];
  const found = Object.keys(config).filter((key) => !SECTIONS.includes(key))
    .map((key) => `${key} is not a configuration section (allowed: ${SECTIONS.join(", ")})`);
  const defaults = config.defaults ?? {};
  if (!isObject(defaults) || Object.keys(defaults).some((key) => key !== "model") || typeof (defaults.model ?? "") !== "string") {
    found.push('defaults must be {"model": "provider/model"}');
  }
  const hosts = config.hosts ?? {};
  if (!isObject(hosts)) found.push('hosts must be {"<id>": {"url": "https://..."}}');
  else {
    for (const [id, host] of Object.entries(hosts)) {
      if (!BOT_ID.test(id) || !isObject(host) || Object.keys(host).join() !== "url" || !isWebUrl(host.url)) {
        found.push(`hosts.${id} must be {"url": "https://..."} under a lowercase id`);
      }
    }
  }
  const bots = config.bots;
  if (!isObject(bots) || !isObject(bots[HANDLER])) return [...found, `bots.${HANDLER} is required: the handler cannot be removed`];
  for (const [id, bot] of Object.entries(bots)) {
    const where = `bots.${id}`;
    if (!BOT_ID.test(id)) found.push(`${where}: an id is 1-32 lowercase letters, digits or '-', starting with a letter`);
    if (!isObject(bot)) {
      found.push(`${where} must be an object`);
      continue;
    }
    for (const field of Object.keys(bot)) {
      if (!Object.hasOwn(BOT_FIELDS, field)) found.push(`${where}.${field} is not a bot field (allowed: ${Object.keys(BOT_FIELDS).join(", ")})`);
    }
    for (const [field, [kind, required]] of Object.entries(BOT_FIELDS)) {
      const value = bot[field];
      if (value === undefined) {
        if (required) found.push(`${where}.${field} is required`);
      } else if ((kind === "list" ? !Array.isArray(value) : typeof value !== kind) || (required && !value.trim())) {
        found.push(`${where}.${field} must be a ${required ? "non-empty " : ""}${kind}`);
      }
    }
    if (Array.isArray(bot.tools) && !bot.tools.every((tool) => typeof tool === "string" && tool)) found.push(`${where}.tools must list tool names`);
    if (typeof bot.workspace === "string" && !(path.isAbsolute(bot.workspace) && isFolder(bot.workspace))) {
      found.push(`${where}.workspace must be an existing absolute folder`);
    }
  }
  return found;
}

function save(config) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(`${CONFIG}.tmp`, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  fs.renameSync(`${CONFIG}.tmp`, CONFIG);
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG)) save(DEFAULT);
  const config = JSON.parse(fs.readFileSync(CONFIG, "utf-8"));
  const found = problems(config);
  if (found.length) throw new Error(`${CONFIG} is invalid:\n${found.join("\n")}`);
  return config;
}

/** Applies the whole patch, or nothing; returns every problem that stopped it. */
export function applyPatch(patch) {
  if (!isObject(patch)) return ["A patch must be a JSON object."];
  // Every handoff to a host carries the token, so a model talked into adding a host could send it anywhere.
  if (Object.hasOwn(patch, "hosts")) return [`hosts are set by the owner in ${CONFIG}, not by configure`];
  const updated = mergePatch(loadConfig(), patch);
  const found = problems(updated);
  if (!found.length) save(updated);
  return found;
}

/** Why `chain` may not hand `task` to `target`, or "" when it may. A host checks again against its own team. */
export function refusal(config, chain, target, task) {
  const [host, session] = address(target);
  const bot = SESSION_ID.test(session) ? botOf(session) : session;
  const hosts = Object.keys(config.hosts ?? {});
  const bots = Object.keys(config.bots).filter((id) => id !== HANDLER);
  if (host !== undefined && !hosts.includes(host)) return `Refused: there is no host '${host}'. Hosts: ${hosts.join(", ") || "none"}`;
  // A handler takes work only from another machine's handler, directly, so a worker never steers a bot that has configure.
  const handlerAsks = chain.length === 1 && chain[0].endsWith(`/${HANDLER}`) && (host !== undefined || chain[0] !== `${MACHINE}/${HANDLER}`);
  if (bot === HANDLER && host !== undefined && !handlerAsks) return `Refused: only your handler talks to ${target}, the handler on ${host}.`;
  if (bot === HANDLER ? !handlerAsks : host === undefined && !bots.includes(bot)) {
    return `Refused: there is no bot '${target}' to hand to. Bots: ${bots.join(", ") || "none yet"}`;
  }
  if (host === undefined && chain.includes(`${MACHINE}/${bot}`)) {
    return `Refused: ${bot} is already working on this request (${chain.join(" -> ")}). Do it yourself.`;
  }
  if (chain.length >= MAX_CHAIN) return `Refused: handoffs stop ${MAX_CHAIN} bots deep (${chain.join(" -> ")}). Do it yourself.`;
  if (typeof task !== "string" || !task.trim()) return "Refused: the task is empty.";
  return "";
}

const line = (id, bot) => `- ${id} (${bot.name}${bot.title ? `, ${bot.title}` : ""}): ${bot.description}`;

/**
 * `remote` maps each host to {bots, working}, or to why they are unavailable; `busy` lists this machine's sessions at work,
 * as working() returns them.
 */
export function teamPrompt(config, id, remote = {}, busy = []) {
  const bot = config.bots[id];
  const identity = `You are ${bot.name}${bot.title ? `, ${bot.title}` : ""}. ${bot.description}`;
  const reachable = Object.entries(remote).filter(([, team]) => typeof team !== "string");
  const roster = [
    ...Object.entries(config.bots).filter(([other]) => other !== id && other !== HANDLER).map(([other, entry]) => line(other, entry)),
    ...Object.entries(remote).flatMap(([host, team]) => typeof team === "string" ? [`- ${host}/…: unavailable right now (${team})`] : [
      ...(id === HANDLER ? [`- ${host}/${HANDLER}: the handler on ${host}. Ask it about that machine, or to create or change bots there.`] : []),
      ...team.bots.map((entry) => line(`${host}/${entry.id}`, entry)),
    ]),
  ].join("\n");
  const atWork = [...busy, ...reachable.flatMap(([host, team]) => team.working.map((session) => ({ ...session, id: `${host}/${session.id}` })))]
    .map((session) => `- ${session.id}: ${session.task}`).join("\n");
  const role = id === HANDLER
    ? "Every message from the owner reaches you first. Answer quick questions yourself. Hand work that fits another bot's " +
      "description to that bot with handoff, and relay its reply. A bot that needs a while works in the background, and " +
      "its reply reaches you later as a message, so hand independent tasks out together and they run in parallel. Bots " +
      "may message you with questions; answer with message, asking the owner first when only the owner knows. When the " +
      `owner asks to change the team, including you (bots.${HANDLER}: your tools, model and instructions), change it with ` +
      "configure and confirm what changed. When no bot fits recurring work, offer to create one."
    : "You are one bot on a team. When a task, or part of one, fits another bot's description better than yours, hand it " +
      "over with handoff and use its reply. Bots at work can be reached with message: share what they need, or ask; " +
      "when only the owner can decide, message handler and wait for the answer.";
  const team = reachable.length ? "Team (a host/bot id is a bot on another of the owner's machines)" : "Team";
  const parts = [identity, bot.instructions, role, `${team}:\n${roster || "(no other bots yet)"}`,
    atWork && `Working right now (reach them with message):\n${atWork}`];
  if (id === HANDLER) parts.push(`Current configuration:\n${JSON.stringify(config, null, 2)}\n${FIELDS}`);
  return parts.filter(Boolean).join("\n\n");
}

const oneLine = (text, size = 100) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > size ? `${flat.slice(0, size - 1)}…` : flat;
};
const textOf = (content) => typeof content === "string" ? content
  : (content ?? []).filter((block) => block?.type === "text").map((block) => block.text ?? "").join("");

/**
 * Runs one turn of `target`, a bot or a copy such as research.2, in a child pi. `how.session` (see START) picks its
 * session, and `how.folder`, for a new copy only, where that copy works from then on; it defaults to the folder of `target`.
 * Reports its steps through onProgress and resolves to {ok, text, session}.
 */
function runBot(config, target, how, prompt, chain, signal, onProgress) {
  const bot = botOf(target);
  const task = oneLine(prompt.replace(/^\[Handed over by [^\]\n]*\]\s*/, ""), 80);
  if (how.folder !== undefined && how.session === "continue") {
    return Promise.resolve({ ok: false, text: `${target} keeps its folder. Name a folder only with session "fresh" or "copy", for a new copy.` });
  }
  if (how.folder !== undefined && !(path.isAbsolute(how.folder) && fs.statSync(how.folder, { throwIfNoEntry: false })?.isDirectory())) {
    return Promise.resolve({ ok: false, text: `${how.folder} is not a folder on ${MACHINE}; name the absolute path of one that exists.` });
  }
  const cwd = how.folder === undefined ? folderOf(config, target) : path.resolve(how.folder);
  let session = target, fork;
  if (how.session === "continue") {
    if (!claim(target, task)) {
      return Promise.resolve({ ok: false, text: `${target} is busy (${holder(target)?.task ?? "just finishing"}). Hand it over with session ` +
        '"fresh" or "copy" to run a copy beside it, or wait for its reply.' });
    }
  } else {
    fork = how.session === "copy" ? sessionFiles().get(target) : undefined; // A bot that has never run has nothing to copy.
    session = claimCopy(bot, task);
  }
  fs.mkdirSync(cwd, { recursive: true });
  const stop = new AbortController();
  signal?.addEventListener("abort", () => stop.abort(), { once: true });
  const run = { name: session, steps: "", stop: () => stop.abort() };
  const steps = [];
  const step = (text) => {
    steps.push(`${session}: ${oneLine(text)}`);
    run.steps = steps.slice(-6).join("\n");
    shared.render?.();
    onProgress(run.steps, session);
  };

  /** One pi run in the session, which ends with the bot's turn; resolves to {ok, text}. */
  const turn = (text, fork) => new Promise((resolve) => {
    const args = [piEntry(), "--mode", "json", "-p", "--session-dir", SESSIONS, "--session-id", session, ...(fork ? ["--fork", fork] : []),
      "-e", SELF, text];
    const child = spawn(process.execPath, args, {
      cwd, env: { ...process.env, BOTMODE_CHAIN: chain.join(",") }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    // ponytail: kills the bot's pi, not processes its tools started; kill the tree if strays appear.
    const kill = () => child.kill();
    stop.signal.addEventListener("abort", kill, { once: true });
    const replies = [];
    let buffer = "", errors = "", last;
    const onLine = (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "tool_execution_start") step(`${event.toolName} ${oneLine(JSON.stringify(event.args ?? {}), 80)}`);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        last = event.message;
        const text = textOf(last.content);
        if (text.trim()) {
          replies.push(text);
          step(text);
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      const lines = (buffer + data).split("\n");
      buffer = lines.pop();
      lines.forEach(onLine);
    });
    child.stderr.on("data", (data) => {
      errors = (errors + data).slice(-2000);
    });
    child.on("error", (error) => resolve({ ok: false, text: error.message }));
    child.on("close", (code) => {
      stop.signal.removeEventListener("abort", kill);
      if (buffer.trim()) onLine(buffer);
      resolve(!last || last.stopReason === "error" || last.stopReason === "aborted"
        ? { ok: false, text: last?.errorMessage || errors.trim() || `pi exited with code ${code}` } : { ok: true, text: replies.at(-1) ?? "" });
    });
  });

  return (async () => {
    shared.running.add(run);
    step("starting");
    const replies = [];
    let outcome = { ok: false, text: "Stopped before it started." }, next = prompt;
    try {
      for (let turns = 0; next && !stop.signal.aborted; turns++) {
        outcome = await turn(next, turns ? undefined : fork);
        if (!outcome.ok) break;
        replies.push(outcome.text);
        // pi ends with the bot's turn, so a message that came as it finished would wait for its next task: it gets a turn now.
        // ponytail: at most 3 such turns, so two bots answering each other's answers stop; the rest waits for the next task.
        next = turns < 3 ? takeMail(session).map(mailText).join("\n\n") : "";
      }
    } finally {
      shared.running.delete(run);
      shared.render?.();
      release(session);
    }
    return { ok: outcome.ok, text: [...replies, ...(outcome.ok ? [] : [outcome.text])].join("\n\n"), session };
  })();
}

const INVITE = "botmode1.";
const LOG = path.join(HOME, "host.log");

export const hasToken = () => fs.existsSync(TOKEN);

export function token() {
  const secret = hasToken() ? fs.readFileSync(TOKEN, "utf-8").trim() : "";
  if (secret.length < 32) throw new Error(`${TOKEN} is missing; run \`botmode setup\``);
  return secret;
}

/** Stores the secret this machine shares with your others: a new one, or the one in another machine's invite. */
export function saveToken(secret = crypto.randomBytes(32).toString("hex")) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(TOKEN, `${secret}\n`, { mode: 0o600 });
}

/** What another machine needs to join this one: its name, its tailnet URL and the token. It is a password. */
export const inviteCode = (name, url) => INVITE + Buffer.from(JSON.stringify({ name, url, token: token() })).toString("base64url");

export function readInvite(code) {
  let invite;
  try {
    invite = JSON.parse(Buffer.from(code.slice(INVITE.length), "base64url").toString("utf-8"));
  } catch {
    invite = undefined;
  }
  if (!(code.startsWith(INVITE) && isObject(invite) && typeof invite.name === "string" && BOT_ID.test(invite.name) &&
    isWebUrl(invite.url) && typeof invite.token === "string" && invite.token.length >= 32)) {
    throw new Error("That is not a Botmode invite. Copy the whole code that `botmode invite` prints.");
  }
  return invite;
}

/**
 * Adds, replaces or (url null) removes a host. A machine that comes back under a new name replaces its old entry.
 * Your own commands and joining machines call this, never a model.
 */
export function setHost(id, url) {
  const config = loadConfig();
  const renamed = Object.keys(config.hosts ?? {}).filter((other) => url !== null && other !== id && config.hosts[other].url === url);
  const updated = mergePatch(config, { hosts: { ...Object.fromEntries(renamed.map((other) => [other, null])), [id]: url === null ? null : { url } } });
  const found = problems(updated);
  if (!found.length) save(updated);
  return found;
}

/** One authenticated request to a `botmode host`, on this machine or another. */
export async function callHost(base, route, body, signal) {
  const response = await fetch(new URL(route, base.endsWith("/") ? base : `${base}/`), {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: body && JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`answered ${response.status}: ${oneLine(await response.text())}`);
  return response;
}

/** Each host's bots, or why they are unavailable. */
export async function remoteTeams(config) {
  // ponytail: asked every turn, and a host that is off costs up to 3 s; cache rosters if that delay bites.
  return Object.fromEntries(await Promise.all(Object.entries(config.hosts ?? {}).map(async ([host, { url }]) => {
    try {
      const { bots, working = [] } = await (await callHost(url, "bots", undefined, AbortSignal.timeout(3000))).json();
      return [host, Array.isArray(bots) ? { bots, working } : "it sent no roster"];
    } catch (error) {
      return [host, reason(error)];
    }
  })));
}

/** Runs `bot` on another machine's `botmode host`; its steps stream back as they happen. */
async function runRemote(config, host, bot, how, prompt, chain, signal, onProgress) {
  const stop = new AbortController();
  signal?.addEventListener("abort", () => stop.abort(), { once: true });
  const run = { name: `${host}/${bot}`, steps: "", stop: () => stop.abort() }; // Its host stops the bot when the request goes.
  shared.running.add(run);
  try {
    const response = await callHost(config.hosts[host].url, "handoff", { bot, ...how, prompt, chain }, stop.signal);
    let buffer = "", outcome = { ok: false, text: `${host} hung up before ${bot} replied` };
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      const lines = (buffer + chunk).split("\n");
      buffer = lines.pop();
      for (const message of lines.filter(Boolean).map((text) => JSON.parse(text))) {
        if ("steps" in message) {
          if (message.session) run.name = `${host}/${message.session}`; // The copy that took it, such as mac/dev.2.
          run.steps = message.steps;
          shared.render?.();
          onProgress(message.steps);
        } else outcome = message;
      }
    }
    return { ...outcome, session: outcome.session && `${host}/${outcome.session}` };
  } catch (error) {
    return { ok: false, text: `${host}: ${reason(error)}` };
  } finally {
    shared.running.delete(run);
    shared.render?.();
  }
}

/** Runs `target`, a bot here or host/bot on another machine, as `how` = {session, folder} says; resolves to {ok, text, session}. */
export function handOver(config, target, how, prompt, chain, signal, onProgress) {
  const [host, bot] = address(target);
  return host === undefined ? runBot(config, bot, how, prompt, chain, signal, onProgress)
    : runRemote(config, host, bot, how, prompt, chain, signal, onProgress);
}

const send = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(`${JSON.stringify(body)}\n`);

async function readJson(req) {
  let body = "";
  for await (const chunk of req.setEncoding("utf8")) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("request too large");
  }
  return JSON.parse(body || "{}") ?? {};
}

/**
 * A request from one of your machines, which all hold the token. GET /bots lists this machine's bots and its sessions at work.
 * POST /handoff {bot, prompt, chain} runs one and streams {steps} lines, then {ok, text}.
 * POST /message {to, from, text} leaves a message for a session at work here, or for the handler's window.
 * POST /join {name, url} and /leave {url} connect and disconnect a machine. POST /stop stops this host.
 */
async function answer(req, res, secret, log) {
  const given = Buffer.from(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
  if (given.length !== secret.length || !crypto.timingSafeEqual(given, secret)) {
    return send(res, 401, { error: "wrong token: connect this machine again with `botmode setup <invite>`" });
  }
  const config = loadConfig();
  const route = `${req.method} ${req.url}`;
  if (route === "GET /bots") {
    return send(res, 200, { bots: Object.entries(config.bots).filter(([id]) => id !== HANDLER)
      .map(([id, bot]) => ({ id, name: bot.name, title: bot.title, description: bot.description })), working: working() });
  }
  if (route === "POST /join") {
    const { name, url } = await readJson(req);
    if (!(typeof name === "string" && BOT_ID.test(name) && isWebUrl(url))) return send(res, 400, { error: "expected {name, url}" });
    try {
      await callHost(url, "bots", undefined, AbortSignal.timeout(10_000)); // Joining is two-way, so check the way back.
    } catch (error) {
      return send(res, 502, { error: `this machine cannot reach ${name} at ${url} (${reason(error)})` });
    }
    const others = Object.fromEntries(Object.entries(config.hosts ?? {}).filter(([, host]) => host.url !== url));
    const found = setHost(name, url);
    if (found.length) return send(res, 400, { error: found.join("; ") });
    log(`${name} joined from ${url}`);
    return send(res, 200, { hosts: others });
  }
  if (route === "POST /leave") {
    const { url } = await readJson(req);
    for (const [id, host] of Object.entries(config.hosts ?? {})) {
      if (host.url === url && !setHost(id, null).length) log(`${id} left`);
    }
    return send(res, 200, {});
  }
  if (route === "POST /stop") {
    log("stopping");
    return res.writeHead(200).end("{}\n", () => process.exit(0));
  }
  if (route === "POST /message") {
    const { to, from, text } = await readJson(req);
    if (!(typeof to === "string" && typeof from === "string" && /^[^/\s]+\/[^/\s]+$/.test(from))) {
      return send(res, 400, { error: "expected {to, from: host/session, text}" });
    }
    // As with handoffs, only another machine's handler reaches this machine's handler.
    const refused = to === HANDLER && !from.endsWith(`/${HANDLER}`) ? `Refused: only your handler messages ${MACHINE}'s handler.`
      : undeliverable(to, from, text);
    if (!refused) post(to, { from, text });
    return send(res, 200, { ok: !refused, text: refused || `Sent to ${to}.` });
  }
  if (route !== "POST /handoff") return send(res, 404, { error: "not found" });
  const { bot, session = "continue", folder, prompt, chain } = await readJson(req);
  // Only a bot of this machine: a host never relays to a third machine.
  if (!(typeof bot === "string" && SESSION_ID.test(bot) && START.includes(session) && ["undefined", "string"].includes(typeof folder) &&
    typeof prompt === "string" && Array.isArray(chain) && chain.every((entry) => typeof entry === "string" && /^[^,\s]+$/.test(entry)))) {
    return send(res, 400, { error: "expected {bot, session, folder?, prompt, chain}" });
  }
  const refused = refusal(config, chain, bot, prompt);
  if (refused) return send(res, 200, { ok: false, text: refused });
  log([...chain, `${MACHINE}/${bot}`].join(" -> "));
  res.writeHead(200, { "content-type": "application/x-ndjson" }).flushHeaders();
  const stop = new AbortController();
  res.on("close", () => res.writableFinished || stop.abort()); // The caller pressed Esc or went away.
  // Blank lines keep proxies, and the caller's 5-minute body timeout, from closing the stream while a long tool runs.
  const beat = setInterval(() => res.write("\n"), 30_000);
  const outcome = await runBot(config, bot, { session, folder }, prompt, chain, stop.signal, (steps, session) => res.write(`${JSON.stringify({ steps, session })}\n`));
  clearInterval(beat);
  res.end(`${JSON.stringify(outcome)}\n`);
}

/** `botmode host`: lets your other machines hand work to this machine's bots. Loopback only; `tailscale serve` shares it. */
export function serve(port = PORT) {
  if (!process.env.BOTMODE_PI) throw new Error("Set BOTMODE_PI to pi's dist/bundle/cli.js so the host can start bots.");
  const secret = Buffer.from(token());
  // ponytail: host.log grows by a line per handoff; trim it if it ever gets big.
  const log = (line) => {
    console.log(line);
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  };
  const server = http.createServer((req, res) => answer(req, res, secret, log).catch((error) => {
    if (res.headersSent) res.end();
    else send(res, 500, { error: error.message });
  }));
  server.on("error", (error) => {
    log(`cannot serve: ${error.message}`);
    process.exitCode = 1;
  });
  return server.listen(port, "127.0.0.1", () => log(`host '${MACHINE}' serves ${CONFIG} on http://127.0.0.1:${server.address().port}`));
}

/** "provider/model[:thinking]" as pi's model registry and thinking level understand it. */
function parseModel(spec) {
  const colon = spec.lastIndexOf(":");
  const thinking = colon > 0 && THINKING.includes(spec.slice(colon + 1)) ? spec.slice(colon + 1) : undefined;
  const name = thinking ? spec.slice(0, colon) : spec;
  const slash = name.indexOf("/");
  return { provider: name.slice(0, slash), id: name.slice(slash + 1), thinking };
}

/** Leaves a message for whichever pi has session `box` open; "handler" is the owner's window. */
function post(box, message) {
  const dir = path.join(MAIL, box);
  fs.mkdirSync(dir, { recursive: true });
  const name = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(`${name}.tmp`, JSON.stringify(message));
  fs.renameSync(`${name}.tmp`, `${name}.json`); // Whole, or not there yet.
}

/** Takes every message waiting in `box`, oldest first. */
function takeMail(box) {
  const dir = path.join(MAIL, box);
  return (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : []).map((name) => {
    const message = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8"));
    fs.rmSync(path.join(dir, name));
    return message;
  });
}

const mailText = ({ from, text, reply }) => reply ? text : `[Message from ${from}; answer with message to ${from}]\n${text}`;

/** Sends `text` from `from`, a session on this machine, to `target`, a session here or host/session; resolves to {ok, text}. */
async function deliver(config, target, from, text, signal) {
  const [host, to] = address(target);
  if (host === undefined) {
    const refused = undeliverable(to, from, text);
    if (!refused) post(to, { from, text });
    return { ok: !refused, text: refused || `Sent to ${target}.` };
  }
  if (!Object.hasOwn(config.hosts ?? {}, host)) return { ok: false, text: `Refused: there is no host '${host}'.` };
  try {
    const sent = await (await callHost(config.hosts[host].url, "message", { to, from: `${MACHINE}/${from}`, text }, signal)).json();
    return { ok: sent.ok, text: sent.ok ? `Sent to ${target}.` : sent.text };
  } catch (error) {
    return { ok: false, text: `${host}: ${reason(error)}` };
  }
}

/**
 * Who this pi is. In a bot's session under ~/.botmode/sessions it is that bot (research.2 is a copy of research); in any
 * other session it is the owner's handler. `box` is the mailbox it reads. The handler's sessions there are other machines'
 * handlers talking with this one, and leave the owner's mailbox to the owner's window.
 */
function whoAmI(ctx) {
  const manager = ctx.sessionManager;
  const id = manager.getSessionId();
  const ours = !path.relative(SESSIONS, manager.getSessionDir()) && SESSION_ID.test(id) && Object.hasOwn(loadConfig().bots, botOf(id));
  const session = ours ? id : undefined;
  return { session, bot: session ? botOf(session) : HANDLER, box: session === HANDLER ? undefined : session ?? HANDLER };
}

function ago(file) {
  const minutes = Math.round((Date.now() - fs.statSync(file).mtimeMs) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 2880 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
}

// Names the session that answered, so the reader can continue that very copy.
const replyText = (target, outcome) => `${outcome.session ?? target} ${outcome.ok ? "replied:\n" : "failed: "}${outcome.text}`;

const WAIT = 10 * 60_000; // How long message waits for an answer before the answer comes as an ordinary message.

export default function botmode(pi) {
  let timer, watching;
  const waiting = new Map(); // address -> resolves message's wait with that address's next message.

  /** Applies this bot's tools and model from the configuration: at start, and when the handler changes itself. */
  async function applySelf(ctx) {
    const config = loadConfig();
    const me = whoAmI(ctx).bot;
    const bot = config.bots[me];
    if (!bot) throw new Error(`botmode: there is no bot '${me}' in ${CONFIG}.`);
    const teamTools = me === HANDLER ? ["handoff", "message", "configure"] : ["handoff", "message"];
    pi.setActiveTools(bot.tools ? [...bot.tools, ...teamTools] : [...DEFAULT_TOOLS, ...teamTools]);
    const spec = bot.model || config.defaults?.model;
    if (spec) {
      const { provider, id, thinking } = parseModel(spec);
      const model = ctx.modelRegistry.find(provider, id);
      if (!model || !(await pi.setModel(model))) ctx.ui.notify(`botmode: ${spec} is unavailable or signed out; using ${ctx.model?.id}.`, "warning");
      if (thinking) pi.setThinkingLevel(thinking);
    }
  }

  /** Hands this session's new messages to the model: at once while it works, and as a new turn in a window that waits. */
  function readMail(ctx, box) {
    if (!ctx.hasUI && ctx.isIdle()) return; // A worker reads messages only while it works; the rest wait for its next task.
    for (const message of takeMail(box)) {
      if (!message.reply && waiting.has(message.from)) waiting.get(message.from)(message.text);
      else pi.sendMessage({ customType: "botmode", display: true, content: mailText(message) }, { triggerTurn: true, deliverAs: "steer" });
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const { session, box } = whoAmI(ctx);
    // A bot's session that another pi works in: this window only shows it, writes nothing to it and leaves its mail alone.
    watching = ctx.hasUI && session && !shared.entered.has(session) && holder(session) ? session : undefined;
    if (!watching) await applySelf(ctx);
    if (box && !watching) {
      timer = setInterval(() => readMail(ctx, box), 500);
      timer.unref(); // A worker's pi exits when its task is done, whatever is still scheduled.
    }
    if (!ctx.hasUI) return;
    if (!session) shared.home = ctx.sessionManager.getSessionFile();
    // ← on an empty prompt opens /sessions, as in Claude Code. Every key reaches this listener first, menus' too, and only
    // pi's prompt editor has onExtensionShortcut; the empty widget is how an extension gets hold of pi's screen, which
    // pi's RPC mode does not have.
    let screen;
    const atPrompt = () => !screen || "onExtensionShortcut" in (screen.getFocusedComponent() ?? {});
    ctx.ui.setWidget("botmode-keys", (tui) => (screen = tui, { render: () => [], invalidate: () => {} }), { placement: "belowEditor" });
    ctx.ui.onTerminalInput((key) => {
      if (!["\x1b[D", "\x1bOD"].includes(key) || ctx.ui.getEditorText() || !atPrompt()) return;
      pi.sendUserMessage("/sessions", { expandPromptTemplates: true });
      return { consume: true };
    });
    if (watching) {
      // pi shows a session as it was when opened, so open it again whenever the bot writes to it, and when it is done.
      const file = ctx.sessionManager.getSessionFile();
      const size = fs.statSync(file).size;
      timer = setInterval(() => {
        if ((holder(watching) && fs.statSync(file, { throwIfNoEntry: false })?.size === size) || !atPrompt()) return;
        clearInterval(timer);
        pi.sendUserMessage(`/sessions ${watching}`, { expandPromptTemplates: true });
      }, 1000);
      timer.unref();
    }
    ctx.ui.setStatus("botmode", watching ? `${session} is at work · what you type goes to it · ← sessions`
      : session && `${session} · ← or /sessions goes back to your handler`);
    shared.render = () => ctx.ui.setWidget("botmode", shared.running.size
      ? [...shared.running].map((run) => `⏳ ${run.steps.split("\n").at(-1) || `${run.name}: starting`}`) : undefined);
    shared.render();
  });

  pi.on("session_shutdown", (event, ctx) => {
    clearInterval(timer);
    shared.render = undefined;
    const { session } = whoAmI(ctx);
    if (event.targetSessionFile === ctx.sessionManager.getSessionFile()) return; // Opened again, as when a bot you watch is done.
    if (shared.entered.delete(session)) release(session); // You left it, so bots may work in it again.
  });

  pi.on("input", async (event, ctx) => {
    if (!watching || event.source === "extension") return { action: "continue" };
    const sent = await deliver(loadConfig(), watching, HANDLER, event.text);
    ctx.ui.notify(sent.text, sent.ok ? "info" : "warning");
    if (!sent.ok) ctx.ui.setEditorText(event.text); // It has just finished; send it again once the window has it.
    return { action: "handled" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig();
    const me = whoAmI(ctx).bot;
    const team = teamPrompt(config, me, await remoteTeams(config), working());
    // With only the team tools, pi's coding-assistant prompt would contradict the bot's own.
    return { systemPrompt: config.bots[me].tools?.length === 0 ? team : `${event.systemPrompt}\n\n${team}` };
  });

  pi.registerTool({
    name: "handoff",
    label: "Handoff",
    description: "Hand a task to another bot on the team. Choose the bot whose description fits, and its session: 'continue' " +
      "carries on in that bot's (or copy's) own session, which remembers its earlier work and is refused while busy; 'fresh' " +
      "starts a new copy that remembers nothing; 'copy' starts a new copy that remembers everything the named session does. " +
      "Copies run in parallel and are named bot.2, bot.3…; the reply names the session that answered. A new copy works in " +
      "the folder of the session it comes from, or in the folder you name, such as another repository, and keeps it. When " +
      "the bot needs a while, handoff returns at once and the reply reaches you later as a message.",
    promptSnippet: "Hand a task to the team bot whose description fits",
    parameters: { type: "object", additionalProperties: false, required: ["bot", "session", "task"], properties: {
      bot: { type: "string", description: "The bot or copy to hand the task to (research, research.2); host/id for one on another machine, and host/handler for its handler" },
      session: { type: "string", enum: START, description: "continue: its own session; fresh: a new copy with no history; copy: a new copy of its session" },
      folder: { type: "string", description: "Only with fresh or copy: the absolute path of the folder the new copy works in, on the bot's machine" },
      task: { type: "string", description: "The complete task, with every requirement and the context the bot needs to work alone" },
    } },
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = loadConfig();
      const me = whoAmI(ctx);
      const chain = [...ABOVE, `${MACHINE}/${me.bot}`];
      const refused = refusal(config, chain, params.bot, params.task);
      if (refused) return result(refused);
      const prompt = `[Handed over by ${config.bots[me.bot].name} on ${MACHINE}]\n${params.task}`;
      const how = { session: params.session, folder: params.folder };
      if (!ctx.hasUI) { // A worker's pi ends with its turn, so it waits for the reply.
        const outcome = await handOver(config, params.bot, how, prompt, chain, signal, (steps) => onUpdate?.(result(steps)));
        return result(replyText(params.bot, outcome));
      }
      // In a window the bot works in the background, and its reply comes back through this session's mailbox.
      const done = handOver(config, params.bot, how, prompt, chain, undefined, () => {});
      const early = await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 1000))]); // A refusal comes back at once.
      if (early) return result(replyText(params.bot, early));
      done.then((outcome) => post(me.box, { text: replyText(params.bot, outcome), reply: true }));
      return result(`${params.bot} is working on it in the background. Its reply reaches you as a message; carry on meanwhile.`);
    },
  });

  pi.registerTool({
    name: "message",
    label: "Message",
    description: "Send a message to a bot that is at work right now, or to handler, the handler that talks with the owner. It " +
      "reaches them during their work. Use it to share findings, add to or correct a task in progress, or ask a question; " +
      "set wait to get their answer back. Messages to you arrive the same way; answer them with message.",
    promptSnippet: "Message a bot at work, or the handler",
    parameters: { type: "object", additionalProperties: false, required: ["to", "text"], properties: {
      to: { type: "string", description: "A session at work (research, research.2), handler, or host/session on another machine" },
      text: { type: "string", description: "The message" },
      wait: { type: "boolean", description: "Wait for their answer (up to 10 minutes) and get it as this tool's result" },
    } },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const sent = await deliver(loadConfig(), params.to, whoAmI(ctx).box ?? HANDLER, params.text, signal);
      if (!sent.ok || !params.wait) return result(sent.text);
      const answer = await new Promise((resolve) => {
        const done = (text) => {
          clearTimeout(timeout);
          waiting.delete(params.to);
          resolve(text);
        };
        const timeout = setTimeout(done, WAIT);
        waiting.set(params.to, done);
        signal?.addEventListener("abort", () => done(), { once: true });
      });
      return result(answer === undefined ? `No answer from ${params.to} yet; it will arrive as a message.` : `${params.to} answered:\n${answer}`);
    },
  });

  // Registered in every session, since one pi can switch between them; applySelf turns it on for the handler only.
  pi.registerTool({
    name: "configure",
    label: "Configure",
    description: "Change the team's configuration with a JSON merge patch: objects merge, null deletes a key, other values " +
      "replace. Creates, edits and removes bots and sets defaults. The whole patch applies, or nothing does and the result " +
      "lists every problem.",
    promptSnippet: "Create, edit or remove team bots with a JSON merge patch",
    parameters: { type: "object", additionalProperties: false, required: ["patch"], properties: {
      patch: { type: "object", description: 'For example {"bots": {"research": {"name": "Researcher", "description": "Finds and summarizes sources"}}}' },
    } },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (whoAmI(ctx).bot !== HANDLER) return result("Refused: only the handler changes the team.");
      const found = applyPatch(params.patch);
      if (found.length) return result(`Not applied; the configuration is unchanged:\n${found.join("\n")}`);
      await applySelf(ctx); // Your own new tools and model work from your next step on.
      return result(`Applied. The configuration is now:\n${JSON.stringify(loadConfig(), null, 2)}`);
    },
  });

  /** Leaving a session stops what it is doing, so ask first while it works. */
  const mayLeave = (ctx) => ctx.isIdle() || ctx.ui.confirm("Leave this session?", "It is still working, and leaving stops it.");

  /**
   * Opens a bot session in this window: an idle one to talk with, and no handoff runs in it while it is open there; one at
   * work to watch, which the window takes over once the bot is done.
   */
  async function focus(ctx, session) {
    const file = sessionFiles().get(session);
    if (!file) return watch(ctx, session, holder(session)?.task); // A new copy has no session to show before its first step.
    if (!(await mayLeave(ctx))) return;
    const entering = claim(session, "open in your window");
    if (entering) shared.entered.add(session);
    const switched = await ctx.switchSession(file).catch((error) => { // pi refuses a session whose folder is gone.
      ctx.ui.notify(`${session}: ${reason(error)}`, "error");
      return { cancelled: true };
    });
    if (switched.cancelled && entering) {
      shared.entered.delete(session);
      release(session);
    }
  }

  /** A session at work: shows what it is doing, and lets you message it, or stop it if this pi runs it. */
  async function watch(ctx, name, task) {
    const run = [...shared.running].find((entry) => entry.name === name);
    const actions = new Map([[`Send ${name} a message`, async () => {
      const text = await ctx.ui.input(`Message to ${name}`, "It reaches the bot at its next step, or right after it finishes");
      if (text?.trim()) ctx.ui.notify((await deliver(loadConfig(), name, HANDLER, text)).text, "info");
    }]]);
    if (run) actions.set(`Stop ${name}`, () => run.stop());
    const choice = await ctx.ui.select(`${name} · ${task ?? "working"}${run?.steps ? `\n${run.steps}` : ""}`, [...actions.keys()]);
    await actions.get(choice)?.();
  }

  pi.registerCommand("sessions", {
    description: "See every bot session and open one to talk with that bot, or watch it work; /sessions <id> opens that one",
    async handler(args, ctx) {
      const config = loadConfig();
      const here = whoAmI(ctx).session;
      const busy = new Map(working().map((session) => [session.id, session.task]));
      const files = sessionFiles();
      if (args.trim()) {
        return files.has(args.trim()) || busy.has(args.trim()) ? focus(ctx, args.trim()) : ctx.ui.notify(`There is no session ${args.trim()} here.`, "warning");
      }
      const choices = new Map([[`${HANDLER} · ${here ? "back to your conversation" : "you are here"}`,
        async () => here && await mayLeave(ctx) && ctx.switchSession(shared.home)]]);
      for (const session of new Set([...files.keys(), ...busy.keys()])) {
        // handler here is another machine's handler talking with this one, not a bot of yours; skip removed bots too.
        if (session === HANDLER || !Object.hasOwn(config.bots, botOf(session))) continue;
        const state = session === here ? "you are here" : busy.has(session) ? `working · ${busy.get(session)}` : `idle · ${ago(files.get(session))}`;
        choices.set(`${session} · ${state} · ${folderOf(config, session, files.get(session))}`, () => session !== here ? focus(ctx, session)
          : watching && watch(ctx, session, busy.get(session)));
      }
      const remote = new Set();
      for (const [host, team] of Object.entries(await remoteTeams(config))) {
        for (const { id, task } of typeof team === "string" ? [] : team.working) {
          if (id === HANDLER) continue; // Your handler's own request to that machine's handler.
          remote.add(`${host}/${id}`);
          choices.set(`${host}/${id} · working on ${host} · ${task}`, () => watch(ctx, `${host}/${id}`, task));
        }
      }
      for (const run of shared.running) { // Your jobs on a machine whose roster did not come.
        if (run.name.includes("/") && !remote.has(run.name)) choices.set(`${run.name} · working on ${address(run.name)[0]}`, () => watch(ctx, run.name));
      }
      const choice = await ctx.ui.select("Sessions", [...choices.keys()]);
      if (choice) await choices.get(choice)();
    },
  });

  pi.registerCommand("bot", {
    description: "Talk to one bot directly: /bot <id or host/id> <message>",
    async handler(args, ctx) {
      const [, target, message] = args.trim().match(/^(\S+)\s+([\s\S]+)$/) ?? [];
      if (!message) return ctx.ui.notify("Usage: /bot <id or host/id> <message>", "warning");
      const config = loadConfig();
      const chain = [`${MACHINE}/${whoAmI(ctx).bot}`]; // In your own window you speak as your handler, and can reach other machines' handlers.
      const refused = refusal(config, chain, target, message);
      if (refused) return ctx.ui.notify(refused, "warning");
      ctx.ui.setStatus("botmode", `${target} is working…`);
      const outcome = await handOver(config, target, { session: "continue" }, message, chain, undefined, (steps) => ctx.ui.setStatus("botmode", steps.split("\n").at(-1)));
      ctx.ui.setStatus("botmode", undefined);
      pi.sendMessage({ customType: "botmode", display: true,
        content: `You -> ${target}: ${message}\n\n${target}${outcome.ok ? "" : " failed"}: ${outcome.text}` });
    },
  });
}
