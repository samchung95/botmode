// Botmode: a team of bots behind one top-level handler, as a pi extension.
// Every bot is a pi process running this file. Bots' sessions live in ~/.botmode/sessions, named by bot id, so the session
// says which bot this is; any other session is yours, and there this file is the handler. A handoff runs the target bot as
// a child pi in its own ongoing session. `botmode host` (cli.mjs) serves this machine's bots to your other machines, where
// they join the team as host/bot.
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
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
// Your handler's conversations with you, from every folder. Each has an address, handler.1, handler.2…, as a bot's copies do.
const CONVERSATIONS = path.join(HOME, "handler");
const MAIL = path.join(HOME, "mail"); // One folder per session that reads messages; each message is a JSON file.
const WINDOW = path.join(HOME, "window"); // The pid of the pi whose window has your handler's conversation open.
// Profiles for bots in Claude Code, a folder each, with the skills, plugins and MCP servers they load (skills/claude-code-profiles).
const PROFILES = path.join(HOME, "profiles");
const PROXY = path.join(HOME, "bili"); // Where billion-context's proxy for bots in Claude Code listens (claudeProxy).
const ABOVE = (process.env.BOTMODE_CHAIN || "").split(",").filter(Boolean); // machine/bot entries waiting on this bot, outermost first.
const SELF = fileURLToPath(import.meta.url);
// The pi extensions Botmode brings. Every pi it runs loads pi-mcp-adapter after this file: the MCP servers in your MCP config
// files, behind one `mcp` tool. Only your handler's pi in your window loads ask_user_question, which asks you multiple-choice
// questions there; a bot asks with message. Every pi loads billion-context's too (BILLION_CONTEXT).
const extension = (name, file = "index.ts") => fileURLToPath(new URL(`node_modules/${name}/${file}`, import.meta.url));
export const MCP_ADAPTER = extension("pi-mcp-adapter");
export const ASK_USER = extension("@juicesharp/rpiv-ask-user-question");
// billion-context keeps a bot's context small: a proxy between the bot and its model compresses what the bot no longer needs
// word for word, and gives it tools to bring any of it back. In pi, this extension runs the proxy. Claude Code has no
// extensions, so a bot there goes through a proxy Botmode runs (claudeProxy), with the tools from its MCP server.
export const BILLION_CONTEXT = extension("billion-context", "dist/agent/pi-native.js");
const BILI = process.env.BOTMODE_BILI || extension("billion-context", "dist/index.js"); // BOTMODE_BILI: a stand-in, in tests.
const BILI_MCP = extension("billion-context", "dist/mcp.js");
// Botmode's copy is pinned: it never updates itself, or checks for advisories and release notes to update by.
Object.assign(process.env, { ACP_AUTO_UPDATE: "0", BILI_ADVISORY_CHECK: "0", BILI_RELEASE_NOTES_CHECK: "0" });
// Nor does it bring acp_delegate, whose sub-agents would work with tools of their own outside Botmode: a bot hands work over
// with handoff. billion-context leaves acp_delegate to an extension that claims it first in the same pi, as this file does.
globalThis[Symbol.for("acp-delegate.embedded")] = true;
// pi's entry script. Inside pi it is process.argv[1]; the `botmode` command sets BOTMODE_PI after importing this file.
const piEntry = () => process.env.BOTMODE_PI || process.argv[1];
// Claude Code, which bots with "agent": "claude" work in: the `botmode` command sets BOTMODE_CLAUDE to the one it comes with.
const claudeCommand = () => {
  const command = process.env.BOTMODE_CLAUDE || "claude";
  return /\.m?js$/.test(command) ? [process.execPath, command] : [command]; // A script stands in for it in the tests.
};
const BRIDGE = fileURLToPath(new URL("botmode-claude.mjs", import.meta.url)); // A Claude Code bot's way to the team.
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
  agent: ["string", false], // "claude" runs the bot in Claude Code; omitted, or "pi", in pi.
  model: ["string", false], // provider/model[:thinking]; empty uses defaults.model, then pi's default. In Claude Code, its model.
  tools: ["list", false], // pi tool names; omitted keeps pi's defaults, [] leaves only the team tools.
  workspace: ["string", false], // An existing absolute folder; omitted gives the bot a folder of its own.
  profile: ["string", false], // A bot in Claude Code: the folder in PROFILES it loads.
  archived: ["list", false], // Its sessions out of the lobby and away from handoffs; its own id archives the whole bot.
};
const AGENTS = ["pi", "claude"];
// All of pi's tools: files and the terminal, with the rights of the account Botmode runs as, and MCP servers (MCP_ADAPTER).
export const ALL_TOOLS = ["read", "bash", ...(process.platform === "win32" ? ["powershell"] : []), "edit", "write", "grep", "find", "ls", "mcp"];
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "mcp"]; // What pi turns on when a bot names no tools.
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
// The handler's guides, to configure and to Claude Code profiles: pi lists them by name and the handler reads one only when
// it needs it.
const SKILLS = fileURLToPath(new URL("skills", import.meta.url));

// pi loads this file afresh for every session it opens, so what must outlive one lives here: the bots this process runs
// ({name, steps, stop}), the bot sessions open in this window, the owner's own session, and how to redraw the window's list.
const shared = globalThis[Symbol.for("botmode")] ??= { running: new Set(), entered: new Set(), home: undefined, render: undefined };
if (!shared.exitHook) {
  shared.exitHook = true;
  process.once("exit", () => shared.running.forEach((run) => run.stop())); // Bots never outlive the pi that started them.
}

// The colours bots take in turn, as 256-colour codes that read on dark and light backgrounds.
const COLOURS = [75, 214, 141, 78, 205, 220, 80, 167];

/** A bot's colour, which its copies share: your team in config.json's order, then the rest as they first show up. */
export function colourOf(name) {
  if (!shared.colours) {
    const config = loadConfig();
    shared.colours = new Map([...Object.keys(config.bots), ...Object.keys(config.hosts ?? {}).map((host) => `${host}/${HANDLER}`)]
      .map((id, n) => [id, COLOURS[n % COLOURS.length]]));
  }
  const bot = name.replace(/\.\d+$/, "");
  if (!shared.colours.has(bot)) shared.colours.set(bot, COLOURS[shared.colours.size % COLOURS.length]);
  return shared.colours.get(bot);
}

// pi lends an extension its TUI through a static import only, which this file cannot make: its tests and the botmode
// command load it without pi. botmode-tui.mjs, loaded beside it in your window, hands it over.
const tui = () => globalThis[Symbol.for("botmode.tui")];

/** Draws `inner` with a bar in `name`'s colour down its left side. */
const marked = (name, inner) => ({
  render: (width) => inner.render(width - 1).map((line) => `\x1b[38;5;${colourOf(name)}m▌\x1b[39m${line}`),
  invalidate: () => inner.invalidate(),
});
const painted = (name, text) => `\x1b[1;38;5;${colourOf(name)}m${text}\x1b[22;39m`;

/** A message from a bot as pi draws an extension's message, labelled and marked in the sender's colour. */
function messageView(message, theme) {
  const from = message.details?.from;
  if (!from || !tui()) return undefined; // pi's own look.
  const { Box, Markdown, Spacer, Text, getMarkdownTheme } = tui();
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(painted(from, `[${from}]`), 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(new Markdown(textOf(message.content), 0, 0, getMarkdownTheme(), { color: (text) => theme.fg("customMessageText", text) }));
  return marked(from, box);
}

/** A handoff or message call as pi draws a tool call, with who it goes to in their colour. */
function callView(tool, to, more, text, theme, { argsComplete, expanded }) {
  // Throwing gives pi's own look: without the TUI, and while the model still writes the name, which would take a colour.
  if (!tui() || !argsComplete || typeof to !== "string") throw new Error("pi draws it");
  const body = typeof text === "string" ? expanded ? text : oneLine(text, 160) : "";
  const { Text } = tui();
  return marked(to, new Text(`${theme.fg("toolTitle", theme.bold(tool))} ${painted(to, `→ ${to}`)}${theme.fg("muted", more)}\n` +
    theme.fg("toolOutput", body), 0, 0));
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isFolder = (folder) => fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isWebUrl = (url) => typeof url === "string" && URL.canParse(url) && /^https?:$/.test(new URL(url).protocol);
const result = (text) => ({ content: [{ type: "text", text }], details: {} });
const reason = (error) => error.cause?.message || error.message; // fetch says only "fetch failed"; the cause says why.

/** "host/bot" -> ["host", "bot"]; a bot on this machine has no host, even when named with this machine's. */
function address(target) {
  const at = target.indexOf("/");
  return at < 0 || target.slice(0, at) === MACHINE ? [undefined, target.slice(at + 1)] : [target.slice(0, at), target.slice(at + 1)];
}

export const botOf = (session) => session.replace(/\.\d+$/, "");
const isHandler = (address) => botOf(address) === HANDLER; // handler, or one of its conversations, such as handler.2.
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
export function claim(session, task) {
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

export const release = (session) => fs.rmSync(lockOf(session), { force: true });
export const OPEN = "open in your window"; // The task of a bot session you have open: no handoff runs in it meanwhile.

/** Whether your handler's conversation is open in a window on this machine, where its messages reach it. */
function windowOpen() {
  try {
    process.kill(Number(fs.readFileSync(WINDOW, "utf-8")), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const idOf = (name) => name.slice(name.indexOf("_") + 1, -".jsonl".length); // pi names a session's file <time>_<session id>.jsonl.
const filesIn = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")) : [];

/** Each bot session on this machine and its newest file, newest first. */
function sessionFiles() {
  const files = new Map();
  for (const name of filesIn(SESSIONS).sort().reverse()) if (!files.has(idOf(name))) files.set(idOf(name), path.join(SESSIONS, name));
  return files;
}

/**
 * Starts a conversation of your handler's in `cwd`, at an address no session here has had, and returns its file. pi opens
 * it as it opens any other, with its first line.
 */
export function newConversation(cwd) {
  const taken = new Set([...filesIn(CONVERSATIONS).map(idOf), ...sessionFiles().keys()]);
  fs.mkdirSync(MAIL, { recursive: true });
  for (let n = 1; ; n++) {
    const id = `${HANDLER}.${n}`;
    if (taken.has(id)) continue;
    try {
      fs.mkdirSync(path.join(MAIL, id)); // Its mailbox, made here, claims the address: two windows never take the same one.
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
    return newFile(id, { version: 3, id, timestamp: new Date().toISOString(), cwd }, CONVERSATIONS);
  }
}

/** The sessions at work on this machine now: [{id, task}]. */
export function working() {
  const locks = fs.existsSync(SESSIONS) ? fs.readdirSync(SESSIONS).filter((name) => name.endsWith(".lock")) : [];
  return locks.map((name) => name.slice(0, -".lock".length)).flatMap((id) => {
    const info = holder(id);
    return info ? [{ id, task: info.task }] : [];
  });
}

/**
 * Why a message from `from` cannot reach `to` on this machine, or "". The mailboxes of your handler, and of each of its
 * conversations, wait for your window.
 */
function undeliverable(config, to, from, text) {
  if (typeof text !== "string" || !text.trim()) return "Refused: the message is empty.";
  if (to === from) return "Refused: that is you.";
  if (archived(config, to)) return `Refused: ${to} is archived.`;
  if (to === HANDLER || filesIn(CONVERSATIONS).map(idOf).includes(to) || (SESSION_ID.test(to) && holder(to))) return "";
  return `${to} is not working right now, so it reads no messages; hand it a task instead. Working now: ` +
    `${working().map((session) => session.id).join(", ") || "none"}.`;
}

/** Claims the first copy of `bot` that has never run, and never takes the address of one of your handler's conversations. */
function claimCopy(bot, task) {
  const taken = new Set([...sessionFiles().keys(), ...filesIn(CONVERSATIONS).map(idOf)]);
  for (let n = 2; ; n++) if (!taken.has(`${bot}.${n}`) && claim(`${bot}.${n}`, task)) return `${bot}.${n}`;
}

/**
 * Where `session` works: a bot's own session in its workspace, and a copy in the folder it started in, which pi keeps in
 * the session's first line. pi finds a session only from that folder, so a copy must always run there.
 */
function folderOf(config, session, file = sessionFiles().get(session)) {
  const bot = botOf(session);
  const own = config.bots[bot]?.workspace || path.join(HOME, "bots", bot);
  return session === bot || !file ? own : startedIn(file) ?? own;
}

/** The objects in JSON lines, leaving out any line cut short. */
const entriesOf = (text) => text.split("\n").flatMap((line) => {
  try {
    const entry = JSON.parse(line);
    return isObject(entry) ? [entry] : [];
  } catch {
    return [];
  }
});

/** The entries in the first 64 KB of a session's file, which pi's header starts; none for a file pi has not written yet. */
function head(file) {
  const buffer = Buffer.alloc(64 * 1024);
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return [];
  }
  try {
    return entriesOf(buffer.toString("utf-8", 0, fs.readSync(fd, buffer)));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * pi's header of a session's file, with the folder it started in. A bot in Claude Code has a file that holds only this
 * line, with its conversation's id in Claude Code as `claude`.
 */
const header = (file) => head(file).find((entry) => entry.type === "session") ?? {};

/**
 * A conversation of your handler's as {file, id, cwd, title}: its latest name, from pi's /name or the helper model, or
 * else its first message, and "" while it has neither. It reads the whole file, as pi's /resume does, for the latest name.
 */
function about(file) {
  let entries = [];
  try {
    entries = entriesOf(fs.readFileSync(file, "utf-8"));
  } catch {} // pi has not written it yet.
  const { id, cwd } = entries.find((entry) => entry.type === "session") ?? {};
  const named = entries.filter((entry) => entry.type === "session_info").at(-1)?.name?.trim();
  const first = entries.find((entry) => entry.type === "message" && entry.message?.role === "user");
  return { file, id: id ?? HANDLER, cwd, title: named || (first ? oneLine(textOf(first.message.content), 60) : "") };
}

/** Your handler's conversations, the newest `count` of them, newest first (see about). */
function conversations(count = Infinity) {
  return filesIn(CONVERSATIONS).map((name) => path.join(CONVERSATIONS, name)).map((file) => ({ file, at: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.at - a.at).slice(0, count).map(({ file }) => about(file));
}

/**
 * The file of your handler's newest conversation in the folder `cwd`, as pi's -c finds it. One not yet talked in, as /task
 * leaves with nothing typed, counts only when there is no other, and a new one is started only when there is none.
 */
export function conversationIn(cwd) {
  const here = conversations().filter((talk) => talk.cwd && !path.relative(talk.cwd, cwd));
  return (here.find((talk) => talk.title) ?? here[0])?.file ?? newConversation(cwd);
}

/** The folder a session started in. */
function startedIn(file) {
  const { cwd } = header(file);
  return typeof cwd === "string" && cwd ? cwd : undefined;
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
  if (!isObject(defaults) || Object.entries(defaults).some(([key, value]) => !["model", "helperModel"].includes(key) || typeof value !== "string")) {
    found.push('defaults must be {"model": "provider/model", "helperModel": "provider/model"}');
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
    if (typeof bot.agent === "string" && !AGENTS.includes(bot.agent)) found.push(`${where}.agent must be "pi" or "claude"`);
    if (bot.agent === "claude" && id === HANDLER) found.push(`${where}.agent: the handler works in pi`);
    if (bot.agent === "claude" && bot.tools !== undefined) found.push(`${where}.tools: a bot in Claude Code has Claude Code's tools`);
    if (typeof bot.profile === "string" && bot.agent !== "claude") found.push(`${where}.profile: only a bot in Claude Code has a profile`);
    else if (typeof bot.profile === "string" && !(BOT_ID.test(bot.profile) && isFolder(path.join(PROFILES, bot.profile)))) {
      found.push(`${where}.profile must name a folder in ${PROFILES}`);
    }
    if (bot.archived !== undefined && id === HANDLER) found.push(`${where}.archived: the handler cannot be archived`);
    else if (Array.isArray(bot.archived) && !bot.archived.every((session) => typeof session === "string" && SESSION_ID.test(session) && botOf(session) === id)) {
      found.push(`${where}.archived must list ${id} or its copies, such as ${id}.2`);
    }
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

/** Whether `session` is archived, alone or with its whole bot. */
const archived = (config, session) => (config.bots[botOf(session)]?.archived ?? []).some((entry) => entry === session || entry === botOf(session));

/** Whether the lobby lists `session` among the bots': one of your bots', and not archived. */
const inLobby = (config, session) => !isHandler(session) && Object.hasOwn(config.bots, botOf(session)) && !archived(config, session);

/** Why `chain` may not hand `task` to `target`, or "" when it may. A host checks again against its own team. */
export function refusal(config, chain, target, task) {
  const [host, session] = address(target);
  const bot = SESSION_ID.test(session) ? botOf(session) : session;
  const hosts = Object.keys(config.hosts ?? {});
  const bots = Object.keys(config.bots).filter((id) => id !== HANDLER && !archived(config, id));
  if (host === undefined && archived(config, session)) return `Refused: ${target} is archived. Bots: ${bots.join(", ") || "none"}`;
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
    ...Object.entries(config.bots).filter(([other]) => other !== id && other !== HANDLER && !archived(config, other)).map(([other, entry]) => line(other, entry)),
    ...Object.entries(remote).flatMap(([host, team]) => typeof team === "string" ? [`- ${host}/…: unavailable right now (${team})`] : [
      ...(id === HANDLER ? [`- ${host}/${HANDLER}: the handler on ${host}. Ask it about that machine, or to create or change bots there.`] : []),
      ...team.bots.map((entry) => line(`${host}/${entry.id}`, entry)),
    ]),
  ].join("\n");
  const atWork = [...busy, ...reachable.flatMap(([host, team]) => team.working.map((session) => ({ ...session, id: `${host}/${session.id}` })))]
    .map((session) => `- ${session.id}: ${session.task}`).join("\n");
  const role = id === HANDLER
    ? "Every message from the owner reaches you first. When a request could mean more than one thing, such as which " +
      "machine, bot, session or folder, load the clarify skill and ask before you act. Answer quick questions yourself. " +
      "Hand work that fits another bot's description to that bot with handoff, and relay its reply. A bot that needs a " +
      "while works in the background, and its reply reaches you later as a message, so hand independent tasks out " +
      "together and they run in parallel. Bots may message you with questions; answer with message, asking the owner " +
      `first when only the owner knows. When the owner asks to change the team, including you (bots.${HANDLER}: your ` +
      "tools, model and instructions), load the configure-team skill, change it with configure, and confirm what changed. " +
      "When no bot fits recurring work, offer to create one; a bot for coding work can work in Claude Code, which Botmode " +
      "brings to this machine. Offer to archive bots and copies whose work is done."
    : "You are one bot on a team. When a task, or part of one, fits another bot's description better than yours, hand it " +
      "over with handoff and use its reply. Bots at work can be reached with message: share what they need, or ask; " +
      "when only the owner can decide, message handler and wait for the answer.";
  const voice = "Write to anyone, the owner included, like a radio call: the point first (the answer, result, request or " +
    "blocker), then only what they need to act on it, with exact names, paths, ids and numbers. No filler, one subject per message.";
  const team = reachable.length ? "Team (a host/bot id is a bot on another of the owner's machines)" : "Team";
  return [identity, bot.instructions, role, voice, `${team}:\n${roster || "(no other bots yet)"}`,
    atWork && `Working right now (reach them with message):\n${atWork}`].filter(Boolean).join("\n\n");
}

const oneLine = (text, size = 100) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > size ? `${flat.slice(0, size - 1)}…` : flat;
};
const textOf = (content) => typeof content === "string" ? content
  : (content ?? []).filter((block) => block?.type === "text").map((block) => block.text ?? "").join("");

/** Starts a session's file in `dir` as pi names them, <time>_<session>.jsonl, with `fields` in its first line; returns it. */
function newFile(session, fields, dir = SESSIONS) {
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${session}.jsonl`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", ...fields })}\n`);
  return file;
}

let starting; // A proxy claudeProxy is starting, which the bots that ask meanwhile wait for.

/**
 * The address of billion-context's proxy that bots in Claude Code on this machine go through: the one in PROXY while it
 * answers, else a new one. It runs while the process that started it, or any that asked for it since, does. Without
 * billion-context, or if it does not start, undefined, and Claude Code goes straight to its model.
 */
async function claudeProxy() {
  if (!fs.existsSync(BILI)) return;
  // Asking it to watch this process checks it answers, and keeps it running while this process does.
  const watches = async (origin) => [200, 409].includes((await fetch(`${origin}/__bili/watcher`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ pid: process.pid }), signal: AbortSignal.timeout(2000) })
    .catch(() => undefined))?.status);
  const known = fs.existsSync(PROXY) && fs.readFileSync(PROXY, "utf-8").trim();
  if (known && await watches(known)) return known;
  starting ??= (async () => {
    const free = net.createServer().listen(0, "127.0.0.1");
    await once(free, "listening");
    const origin = `http://127.0.0.1:${free.address().port}`;
    free.close();
    spawn(process.execPath, [BILI, "start", "--host", "127.0.0.1", "--port", new URL(origin).port], { detached: true, stdio: "ignore",
      windowsHide: true, env: { ...process.env, BILI_PARENT_PID: String(process.pid), BILI_STRICT_PORT: "1", BILI_LAUNCHER_LANE: "claude" } }).unref();
    for (const end = Date.now() + 15000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) {
      if (await watches(origin)) {
        fs.writeFileSync(PROXY, origin);
        return origin;
      }
    }
  })().finally(() => { starting = undefined; });
  return starting;
}

/**
 * How Claude Code runs `session` for the team, before the flags that pick its conversation: with no permission prompts, as
 * its bot with the team's prompt, and with handoff and message from botmode-claude.mjs, which also hands it its messages
 * after each step. ← on an empty prompt edits, as everywhere else, instead of opening Claude Code's agents, which would take
 * the conversation out of Botmode: the lobby is ours. Claude Code reads leftArrowOpensAgents only from the owner's own config.
 * Claude Code's own messages to the owner's other Claude Code sessions are off. Its profile is a plugin, with more plugins in
 * its plugins folder. --strict-mcp-config leaves out every MCP server not in --mcp-config, the owner's and the plugins' alike,
 * so its MCP servers are the team's and those in its profile's .mcp.json, which comes first: a name's last config wins.
 * Its model requests go through billion-context's proxy (claudeProxy), which compresses its context instead of Claude Code.
 */
async function claudeArgs(config, session, chain) {
  const bot = config.bots[botOf(session)];
  const bridge = (mode) => `node "${BRIDGE.replaceAll("\\", "/")}" ${mode} ${session}`; // Claude Code runs these in a shell.
  const hook = (mode) => [{ hooks: [{ type: "command", command: bridge(mode) }] }];
  const proxy = await claudeProxy();
  const model = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  // Its turns in a room, which tell your window whether ← may go back to the lobby (see leavesClaude).
  const settings = { disableAgentView: true, statusLine: { type: "command", command: bridge("status") },
    hooks: { PostToolUse: [{ matcher: "*", ...hook("mail")[0] }], UserPromptSubmit: hook("busy"), Stop: hook("idle"), StopFailure: hook("idle") },
    ...(proxy && { env: { ANTHROPIC_BASE_URL: `${proxy}/bili/${model}`, DISABLE_AUTO_COMPACT: "1" } }) };
  // All the bridge needs to work for this session on this machine, whatever Claude Code passes on of its own.
  const env = { BOTMODE_HOME: HOME, BOTMODE_MACHINE: MACHINE, BOTMODE_PI: piEntry(), BOTMODE_CHAIN: chain.join(","),
    ...(process.env.BOTMODE_CLAUDE && { BOTMODE_CLAUDE: process.env.BOTMODE_CLAUDE }) };
  const servers = { mcpServers: { botmode: { type: "stdio", command: process.execPath, args: [BRIDGE, "mcp", session], env },
    ...(proxy && { bili: { type: "stdio", command: process.execPath, args: [BILI_MCP], env: { BILI_MCP_PROXY: proxy } } }) } };
  const team = `${teamPrompt(config, botOf(session), await remoteTeams(config), working())}\n\nhandoff and message are your ` +
    "mcp__botmode__handoff and mcp__botmode__message tools; they are your only way to the team.";
  const profile = bot.profile ? [path.join(PROFILES, bot.profile)] : [];
  const inProfile = (name) => profile.map((dir) => path.join(dir, name)).filter((file) => fs.existsSync(file));
  return ["--permission-mode", "bypassPermissions", "--settings", JSON.stringify(settings),
    "--mcp-config", ...inProfile(".mcp.json"), JSON.stringify(servers), "--strict-mcp-config",
    ...[...profile, ...inProfile("plugins")].flatMap((dir) => ["--plugin-dir", dir]),
    "--disallowedTools", "SendMessage,ListAgents", "--append-system-prompt", team, ...(bot.model ? ["--model", bot.model] : [])];
}

// Keys as Windows Terminal sends them to a console program, such as Claude Code: CSI Vk;Sc;Uc;Kd;Cs;Rc _, down and up.
const WIN32_KEY = /\x1b\[(\d+);\d+;(\d+);(\d+);\d+;\d+_/g;
const WIN32_VT = { 37: "\x1b[D", 38: "\x1b[A", 40: "\x1b[B" }; // ←, and ↑ and ↓, which bring back what you sent before.
// What the terminal reports rather than what you type: the mouse, focus, its answers to queries, and keys let go or held.
const REPORT = /^\x1b(?:\[(?:<[\d;]+[Mm]|[IO]|[?>][\d;:]*[A-Za-z]|\d+;\d+R|[\d;:]*:[23][A-Za-z~])|[\]P])/;

/**
 * Whether `data`, typed in a room of Claude Code, goes back to the lobby: ← on an empty prompt while Claude Code is idle,
 * as in pi. Claude Code does not say what its prompt holds, so `room` keeps what your keys tell: {blank, line}, empty once
 * you sent a message that opens no menu, and {busy}, which its hooks set.
 */
export function leavesClaude(room, data) {
  const text = data.replace(WIN32_KEY, (_, vk, char, down) => down !== "1" ? "" : Number(char) ? String.fromCharCode(char) : WIN32_VT[vk] ?? "");
  for (const key of text.match(/\x1b\[[\d;:?<>]*[ -/]*[@-~]|\x1bO.|\x1b[\]P][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[^[\]OP]?|[\s\S]/g) ?? []) {
    if (["\x1b[D", "\x1bOD"].includes(key)) {
      if (room.blank && !room.busy) return true;
    } else if (["\x1b", "\x1b[27u", "\x03", "\x1b[99;5u"].includes(key)) {
      room.busy = false; // Esc or Ctrl+C stops its turn, after which Claude Code runs no Stop hook.
    } else if (!REPORT.test(key)) {
      const sent = ["\r", "\x1b[13u"].includes(key);
      room.blank = sent && !/^\/|\\$/.test(room.line); // A command may show a menu, and \ before Enter starts a new line.
      room.line = sent ? "" : room.line + key;
    }
  }
  return false;
}

/**
 * Runs one turn of `target`, a bot or a copy such as research.2, in a child pi, or Claude Code for a bot with agent "claude".
 * `how.session` (see START) picks its session, and `how.folder`, for a new copy only, where that copy works from then on; it
 * defaults to the folder of `target`. Reports its steps through onProgress and resolves to {ok, text, session}.
 */
async function runBot(config, target, how, prompt, chain, signal, onProgress) {
  const bot = botOf(target);
  const task = oneLine(prompt.replace(/^\[Handed over by [^\]\n]*\]\s*/, ""), 80);
  if (how.folder !== undefined && how.session === "continue") {
    return { ok: false, text: `${target} keeps its folder. Name a folder only with session "fresh" or "copy", for a new copy.` };
  }
  if (how.folder !== undefined && !(path.isAbsolute(how.folder) && fs.statSync(how.folder, { throwIfNoEntry: false })?.isDirectory())) {
    return { ok: false, text: `${how.folder} is not a folder on ${MACHINE}; name the absolute path of one that exists.` };
  }
  const cwd = how.folder === undefined ? folderOf(config, target) : path.resolve(how.folder);
  let session = target, fork;
  if (how.session === "continue") {
    if (!claim(target, task)) {
      return { ok: false, text: `${target} is busy (${holder(target)?.task ?? "just finishing"}). Hand it over with session ` +
        '"fresh" or "copy" to run a copy beside it, or wait for its reply.' };
    }
  } else {
    fork = how.session === "copy" ? sessionFiles().get(target) : undefined; // A bot that has never run has nothing to copy.
    session = claimCopy(bot, task);
  }
  try {
    fs.mkdirSync(cwd, { recursive: true });
    if (config.bots[bot]?.agent !== "claude") {
      const args = ["--session-dir", SESSIONS, "--session-id", session];
      return await work({ name: session, args, first: fork && [...args, "--fork", fork], cwd, chain, signal, onProgress }, prompt);
    }
    // Claude Code goes on with the session's conversation, or starts one, as a copy of `fork`'s when there is one.
    const file = sessionFiles().get(session);
    const known = file && header(file).claude, from = fork && header(fork).claude;
    const id = known || crypto.randomUUID();
    const team = await claudeArgs(config, session, chain);
    const outcome = await work({ name: session, claude: true, args: [...team, "--resume", id], cwd, chain, signal, onProgress,
      first: !known && [...team, ...(from ? ["--resume", from, "--fork-session"] : []), "--session-id", id],
      // Only once Claude Code has the conversation, so the next turn never asks for one it does not have.
      onStart: !known && (() => newFile(session, { cwd, claude: id })) }, prompt);
    const now = new Date();
    if (sessionFiles().has(session)) fs.utimesSync(sessionFiles().get(session), now, now); // The lobby's "idle · 5m ago".
    return outcome;
  } finally {
    release(session);
  }
}

/**
 * A title of a few words for a conversation, so far titled `title`, with its newest `message`, from the helper model `spec`
 * in a bare pi of its own; "" if it gives none within a minute.
 */
const titleOf = (spec, message, title) => new Promise((resolve) => {
  const { provider, id, thinking } = parseModel(spec);
  const prompt = "Give a conversation a title of a few words, with no quotes or full stop. Reply with the title alone."
    // Its start is enough for a title, and keeps a long message within Windows' 32K command line.
    + `${title ? `\nIts title so far, to keep if it still fits: ${title}` : ""}\nIts newest message:\n${message.slice(0, 4000)}`;
  execFile(process.execPath, [piEntry(), "--mode", "json", "-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-context-files", "--model", `${provider}/${id}`, "--thinking", thinking ?? "off", prompt],
  { timeout: 60_000, windowsHide: true, maxBuffer: 4e6 }, (_error, stdout) => {
    const reply = entriesOf(String(stdout)).filter((event) => event.type === "message_end" && event.message?.role === "assistant").at(-1);
    resolve(oneLine(textOf(reply?.message.content).replace(/^["'\s]+|["'.\s]+$/g, ""), 60));
  }).stdin.end(); // pi -p reads what is piped in until it ends.
});

/**
 * Works in a session through child pis, or Claude Codes: a turn on `prompt`, then a turn on any messages that came for
 * `name` as it finished. `args` name the session to them, and `first`, when given, does instead in the first turn.
 * `onStart` runs as Claude Code first answers. Resolves to {ok, text, session}.
 */
function work({ name, args, first, claude, onStart, cwd, chain, signal, onProgress, file }, prompt) {
  const stop = new AbortController();
  signal?.addEventListener("abort", () => stop.abort(), { once: true });
  const run = { name, file, steps: "", stop: () => stop.abort() };
  const steps = [];
  const step = (text) => {
    steps.push(`${name}: ${oneLine(text)}`);
    run.steps = steps.slice(-6).join("\n");
    shared.render?.();
    onProgress(run.steps, name);
  };

  /** One run of pi, or Claude Code, in the session, which ends with the bot's turn; resolves to {ok, text}. */
  const turn = (text, args) => new Promise((resolve) => {
    const [command, ...argv] = claude ? [...claudeCommand(), "-p", "--output-format", "stream-json", "--verbose", ...args, text]
      : [process.execPath, piEntry(), "--mode", "json", "-p", ...args, "-e", SELF, "-e", MCP_ADAPTER, "-e", BILLION_CONTEXT, text];
    const child = spawn(command, argv, {
      cwd, env: { ...process.env, BOTMODE_CHAIN: chain.join(",") }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    // ponytail: kills the bot's pi, not processes its tools started; kill the tree if strays appear.
    const kill = () => child.kill();
    stop.signal.addEventListener("abort", kill, { once: true });
    const replies = [];
    let buffer = "", errors = "", last, done;
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
      // Claude Code's events: its steps, then the result of the turn.
      for (const block of event.type === "assistant" ? event.message?.content ?? [] : []) {
        if (block.type === "tool_use") step(`${block.name.replace(/^mcp__botmode__/, "")} ${oneLine(JSON.stringify(block.input ?? {}), 80)}`);
        if (block.type === "text" && block.text?.trim()) step(block.text);
      }
      if (event.type === "result") done = event;
      if (onStart && ["assistant", "result"].includes(event.type)) {
        onStart();
        onStart = undefined;
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
      if (claude) {
        resolve(done?.is_error === false ? { ok: true, text: done.result ?? "" }
          : { ok: false, text: (typeof done?.result === "string" && done.result) || errors.trim() || `Claude Code exited with code ${code}` });
      } else {
        resolve(!last || last.stopReason === "error" || last.stopReason === "aborted"
          ? { ok: false, text: last?.errorMessage || errors.trim() || `pi exited with code ${code}` } : { ok: true, text: replies.at(-1) ?? "" });
      }
    });
  });

  return (async () => {
    shared.running.add(run);
    step("starting");
    const replies = [];
    let outcome = { ok: false, text: "Stopped before it started." }, next = prompt, shelved = false;
    // Archiving the session stops it, in whichever process on this machine runs it.
    // ponytail: reads config.json every half second per session at work; signal stops some other way if many run at once.
    const look = setInterval(() => {
      try {
        shelved = archived(loadConfig(), name);
      } catch {} // An invalid config.json stops nothing.
      if (shelved) stop.abort();
    }, 500);
    try {
      for (let turns = 0; next && !stop.signal.aborted; turns++) {
        outcome = await turn(next, (!turns && first) || args);
        if (!outcome.ok) break;
        replies.push(outcome.text);
        // pi ends with the bot's turn, so a message that came as it finished would wait for its next task: it gets a turn now.
        // ponytail: at most 3 such turns, so two bots answering each other's answers stop; the rest waits for the next task.
        next = turns < 3 ? mailFor(name) : "";
      }
    } finally {
      clearInterval(look);
      shared.running.delete(run);
      shared.render?.();
    }
    if (shelved && !outcome.ok) outcome = { ok: false, text: `Stopped: ${name} was archived.` };
    return { ok: outcome.ok, text: [...replies, ...(outcome.ok ? [] : [outcome.text])].join("\n\n"), session: name };
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
 * POST /message {to, from, text, chain} leaves a message for a session at work here, or for the handler's window.
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
    return send(res, 200, { bots: Object.entries(config.bots).filter(([id]) => id !== HANDLER && !archived(config, id))
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
    const { to, from, text, chain } = await readJson(req);
    if (!(typeof to === "string" && typeof from === "string" && /^[^/\s]+\/[^/\s]+$/.test(from))) {
      return send(res, 400, { error: "expected {to, from: host/session, text}" });
    }
    // As with handoffs, only another machine's handler reaches this machine's handler; so does a bot doing a task from it.
    const asked = Array.isArray(chain) && chain.at(-1) === `${MACHINE}/${HANDLER}`;
    const refused = isHandler(to) && !isHandler(from.slice(from.indexOf("/") + 1)) && !asked
      ? `Refused: ${MACHINE}'s handler hears only from your handler, and from bots at work on a task it handed them.`
      : undeliverable(config, to, from, text);
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
  if (bot === HANDLER && session === "continue" && windowOpen()) { // Your handler takes it in its conversation, in your window.
    post(HANDLER, { from: chain.at(-1), text: prompt });
    return send(res, 200, { ok: true, text: `It is in ${MACHINE}'s window, where the handler works on it; its answer comes as a message.` });
  }
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

/** The files of the messages waiting in `box`, oldest first. */
function letters(box) {
  const dir = path.join(MAIL, box);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => path.join(dir, name)) : [];
}

/** Takes every message waiting in `box`, oldest first. */
function takeMail(box) {
  return letters(box).map((file) => {
    const message = JSON.parse(fs.readFileSync(file, "utf-8"));
    fs.rmSync(file);
    return message;
  });
}

const mailText = ({ from, text, reply }) => reply ? text : `[Message from ${from}; answer with message to ${from}]\n${text}`;

/** Takes the messages waiting in `box`, as the text a bot reads them in. */
export const mailFor = (box) => takeMail(box).map(mailText).join("\n\n");

/** Takes the next message from `from` to `box` as it comes, within WAIT; undefined when none comes. */
async function nextFrom(box, from, signal) {
  for (const end = Date.now() + WAIT; Date.now() < end && !signal?.aborted; await new Promise((resolve) => setTimeout(resolve, 500))) {
    for (const file of letters(box)) {
      const message = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (message.reply || message.from !== from) continue;
      fs.rmSync(file, { force: true });
      return message.text;
    }
  }
}

/** Sends `text` from `from`, a session on this machine, to `target`, a session here or host/session; resolves to {ok, text}. */
async function deliver(config, target, from, text, signal) {
  const [host, to] = address(target);
  if (host === undefined) {
    const refused = undeliverable(config, to, from, text);
    if (!refused) post(to, { from, text });
    return { ok: !refused, text: refused || `Sent to ${target}.` };
  }
  if (!Object.hasOwn(config.hosts ?? {}, host)) return { ok: false, text: `Refused: there is no host '${host}'.` };
  try {
    // With the chain it works for, so the handler that handed it its task takes its messages.
    const sent = await (await callHost(config.hosts[host].url, "message", { to, from: `${MACHINE}/${from}`, text, chain: ABOVE }, signal)).json();
    return { ok: sent.ok, text: sent.ok ? `Sent to ${target}.` : sent.text };
  } catch (error) {
    return { ok: false, text: `${host}: ${reason(error)}` };
  }
}

/**
 * The message tool: sends `params.text` from `from` and, when `params.wait`, waits for the answer, which `wait(to, signal)`
 * takes as it comes. Resolves to what the tool says.
 */
export async function sendMessage(config, from, params, signal, wait = (to, signal) => nextFrom(from, to, signal)) {
  const sent = await deliver(config, params.to, from, params.text, signal);
  if (!sent.ok || !params.wait) return sent.text;
  const answer = await wait(params.to, signal);
  return answer === undefined ? `No answer from ${params.to} yet; it will arrive as a message.` : `${params.to} answered:\n${answer}`;
}

/**
 * A handoff of `params.task` from `bot`: the chain it extends, why it is refused, if it is, and the prompt, which tells the
 * bot who handed it over and, in `reach`, how to reach them.
 */
function handoffFrom(config, bot, params, reach) {
  const chain = [...ABOVE, `${MACHINE}/${bot}`];
  return { chain, refused: refusal(config, chain, params.bot, params.task),
    prompt: `[Handed over by ${config.bots[bot].name} on ${MACHINE}, ${reach}]\n${params.task}` };
}

/** The handoff tool of a bot, which waits for the reply as it works; resolves to what the tool says. */
export async function handOffAndWait(config, bot, params, signal, onProgress) {
  const { chain, refused, prompt } = handoffFrom(config, bot, params, "who waits for your reply; put any question in it");
  return refused || replyText(params.bot, await handOver(config, params.bot, { session: params.session, folder: params.folder }, prompt, chain, signal, onProgress));
}

// The team's tools, which pi gives bots in pi and botmode-claude.mjs gives bots in Claude Code.
export const HANDOFF = {
  name: "handoff",
  description: "Hand a task to another bot on the team. Choose the bot whose description fits, and its session: 'continue' " +
    "carries on in that bot's (or copy's) own session, which remembers its earlier work and is refused while busy; 'fresh' " +
    "starts a new copy that remembers nothing; 'copy' starts a new copy that remembers everything the named session does. " +
    "Copies run in parallel and are named bot.2, bot.3…; the reply names the session that answered. A new copy works in " +
    "the folder of the session it comes from, or in the folder you name, such as another repository, and keeps it. When " +
    "the bot needs a while, handoff returns at once and the reply reaches you later as a message.",
  parameters: { type: "object", additionalProperties: false, required: ["bot", "session", "task"], properties: {
    bot: { type: "string", description: "The bot or copy to hand the task to (research, research.2); host/id for one on another machine, and host/handler for its handler" },
    session: { type: "string", enum: START, description: "continue: its own session; fresh: a new copy with no history; copy: a new copy of its session" },
    folder: { type: "string", description: "Only with fresh or copy: the absolute path of the folder the new copy works in, on the bot's machine" },
    task: { type: "string", description: "The complete task, with every requirement and the context the bot needs to work alone" },
  } },
};
export const MESSAGE = {
  name: "message",
  description: "Send a message to a bot that is at work right now, or to handler, the handler that talks with the owner. It " +
    "reaches them during their work. Use it to share findings, add to or correct a task in progress, or ask a question; " +
    "set wait to get their answer back. Messages to you arrive the same way; answer them with message.",
  parameters: { type: "object", additionalProperties: false, required: ["to", "text"], properties: {
    to: { type: "string", description: "A session at work (research, research.2), handler, or host/session on another machine" },
    text: { type: "string", description: "The message" },
    wait: { type: "boolean", description: "Wait for their answer (up to 10 minutes) and get it as this tool's result" },
  } },
};

/**
 * Who this pi is. In a bot's session under ~/.botmode/sessions it is that bot (research.2 is a copy of research); in any
 * other session it is the owner's handler. `box` is the mailbox it reads: a conversation of your handler's reads the one
 * of its address, such as handler.2, and one from before they had addresses reads handler's. The handler's sessions
 * under ~/.botmode/sessions are other machines' handlers talking with this one, and leave the owner's mail to the window.
 */
function whoAmI(ctx) {
  const manager = ctx.sessionManager;
  const id = manager.getSessionId();
  const ours = !path.relative(SESSIONS, manager.getSessionDir()) && SESSION_ID.test(id) && Object.hasOwn(loadConfig().bots, botOf(id));
  const session = ours ? id : undefined;
  return { session, bot: session ? botOf(session) : HANDLER,
    box: session === HANDLER ? undefined : session ?? (SESSION_ID.test(id) && isHandler(id) ? id : HANDLER) };
}

function ago(file) {
  const minutes = Math.round((Date.now() - fs.statSync(file).mtimeMs) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 2880 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
}

// Names the session that answered, so the reader can continue that very copy.
const replyText = (target, outcome) => `${outcome.session ?? target} ${outcome.ok ? "replied:\n" : "failed: "}${outcome.text}`;

const WAIT = 10 * 60_000; // How long message waits for an answer before the answer comes as an ordinary message.

// How many of your handler's conversations the lobby lists, newest first, each read whole for its title. `botmode -r` has the rest.
const LOBBY = 20;
const NEW_TASK = "New task…"; // The lobby's first row, in a pi without its TUI.
// Alt+Shift+Enter (4) and Ctrl+Enter (5) as the kitty keyboard protocol and xterm's modifyOtherKeys report them.
const TASK_KEY = /^\x1b\[(?:13;[45](?::1)?u|27;[45];13~)$/;

// What a session hears when you leave it at work: pi stops a session's work as the window switches away from it.
const CARRY_ON = "Carry on where you stopped: the owner stepped out of this session, which interrupted you, so redo a step that did not finish.";

/** Carries on, in the background, with the work of a session this window has just left. */
function carryOn({ session, box, file }) {
  if (session) return runBot(loadConfig(), session, { session: "continue" }, CARRY_ON, [], undefined, () => {});
  // A conversation of your handler's, which no lock guards: the window knows it is at work by this run.
  work({ name: box, file, args: ["--session", file], cwd: startedIn(file) ?? process.cwd(), chain: [], onProgress: () => {} }, CARRY_ON);
}

/** Sends what you type to `to`: a session at work, or a conversation of your handler's, at work without you. */
function tell(to, text) {
  if (!isHandler(to)) return deliver(loadConfig(), to, HANDLER, text);
  post(to, { text, reply: true }); // Your words as they are, at its next step.
  return { ok: true, text: "Sent to your handler." };
}

/**
 * pi-mcp-adapter turns pi's own MCP off in your pi settings, for every pi you run, unless its onboarding file says this
 * version of it already has. Botmode's pis don't need that, since pi steps its own MCP aside for an extension that has
 * /mcp, so this says so for the version package.json pins.
 */
function keepPiMcp() {
  const dir = (process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")).replace(/^~(?=$|[\\/])/, os.homedir());
  const file = path.join(dir, "mcp-onboarding.json");
  const version = JSON.parse(fs.readFileSync(new URL("package.json", import.meta.url), "utf-8")).dependencies["pi-mcp-adapter"];
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    state = { version: 1 }; // None yet, or one the adapter would not read either.
  }
  if (state.piBuiltinMcpHandledVersion === version) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...state, piBuiltinMcpHandledVersion: version }, null, 2)}\n`);
}

export default function botmode(pi) {
  keepPiMcp();
  let timer, watching, left, beat;
  const waiting = new Map(); // address -> resolves message's wait with that address's next message.
  // Set when the botmode command runs your window as rooms, a pi per conversation (cli.mjs): where it listens, and this room.
  const [rooms, room] = [process.env.BOTMODE_ROOMS, process.env.BOTMODE_ROOM];
  const toRooms = (message) => fetch(rooms, { method: "POST", body: JSON.stringify({ room, ...message }) }).then(() => {}, () => {});
  // Replying, waiting on a bot it handed work to, or about to read a message: a room that is busy is kept out of sight.
  const busy = (ctx, box) => !ctx.isIdle() || shared.running.size > 0 || Boolean(box && letters(box).length);
  // Your window's first room, or a window without rooms: it has the WINDOW file, and takes the messages for handler, such
  // as your other machines' handlers', while your other conversations with your handler take only their own.
  // ponytail: a conversation from before handler.N addresses has the box handler too, so with it open in a room of its own,
  // it and your first room race for that mail; give such conversations an address if that bites.
  const main = (ctx) => ctx.hasUI && !whoAmI(ctx).session && (!rooms || room === HANDLER);

  /** Applies this bot's tools and model from the configuration: at start, and when the handler changes itself. */
  async function applySelf(ctx) {
    const config = loadConfig();
    const me = whoAmI(ctx).bot;
    const bot = config.bots[me];
    if (!bot) throw new Error(`botmode: there is no bot '${me}' in ${CONFIG}.`);
    const teamTools = me === HANDLER ? ["handoff", "message", "configure"] : ["handoff", "message"];
    // billion-context's tools act only on the bot's own context, so they stay on whatever its tools say.
    const context = pi.getAllTools().filter((tool) => tool.sourceInfo?.path === BILLION_CONTEXT).map((tool) => tool.name);
    pi.setActiveTools([...bot.tools ?? DEFAULT_TOOLS, ...teamTools, ...context]);
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
      if (message.owner) pi.sendUserMessage(message.text, { deliverAs: "followUp" }); // Yours, as you would type it, from /task.
      else if (!message.reply && waiting.has(message.from)) waiting.get(message.from)(message.text);
      else pi.sendMessage({ customType: "botmode", display: true, content: mailText(message), details: { from: message.from } }, { triggerTurn: true, deliverAs: "steer" });
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const { session, box } = whoAmI(ctx);
    const file = ctx.sessionManager.getSessionFile();
    // A bot session you open is yours while it is open: no handoff runs in it.
    if (ctx.hasUI && session && claim(session, OPEN)) shared.entered.add(session);
    // A session that another pi works in, a bot's or your handler's own carrying on without you: this window only shows
    // it, writes nothing to it and leaves its mail alone.
    const atWork = () => session ? holder(session) : [...shared.running].some((run) => run.file === file);
    watching = ctx.hasUI && !shared.entered.has(session) && atWork() ? session ?? box : undefined;
    if (!watching) await applySelf(ctx);
    if (box && !watching) {
      const boxes = main(ctx) && box !== HANDLER ? [box, HANDLER] : [box];
      timer = setInterval(() => boxes.forEach((each) => readMail(ctx, each)), 500);
      timer.unref(); // A worker's pi exits when its task is done, whatever is still scheduled.
    }
    if (!ctx.hasUI) return;
    if (rooms) {
      let was = false;
      beat = setInterval(() => {
        const now = busy(ctx, !watching && box);
        if (now !== was) toRooms({ busy: was = now });
      }, 500);
      beat.unref();
    }
    if (!session) {
      shared.home = file;
      // The rooms show a conversation that is open in one already, rather than open it twice, by the id it has here.
      if (rooms) toRooms({ id: ctx.sessionManager.getSessionId() });
    }
    if (main(ctx)) {
      fs.mkdirSync(HOME, { recursive: true });
      fs.writeFileSync(WINDOW, String(process.pid)); // Other machines' handlers now talk with yours here, where you see it.
    }
    // ← on an empty prompt opens /sessions, as in Claude Code. Every key reaches this listener first, menus' too, and only
    // pi's prompt editor has onExtensionShortcut; the empty widget is how an extension gets hold of pi's screen, which
    // pi's RPC mode does not have.
    let screen;
    const atPrompt = () => !screen || "onExtensionShortcut" in (screen.getFocusedComponent() ?? {});
    ctx.ui.setWidget("botmode-keys", (tui) => (screen = tui, { render: () => [], invalidate: () => {} }), { placement: "belowEditor" });
    // Alt+Shift+Enter, or Ctrl+Enter, sends what you typed as /task does, in terminals that tell it from Enter (the kitty
    // or xterm way). Windows sends Alt+Shift+Enter as Alt+Enter, which pi leaves free there, and Ctrl+Enter as pi's new line.
    ctx.ui.onTerminalInput((key) => {
      const text = ctx.ui.getEditorText();
      const task = (TASK_KEY.test(key) || (process.platform === "win32" && key === "\x1b\r")) && text.trim();
      if (!(task || (["\x1b[D", "\x1bOD"].includes(key) && !text)) || !atPrompt()) return;
      if (task) ctx.ui.setEditorText("");
      pi.sendUserMessage(task ? `/task ${task}` : "/sessions", { expandPromptTemplates: true });
      return { consume: true };
    });
    if (watching) {
      // pi shows a session as it was when opened, so open it again whenever the bot writes to it, and when it is done.
      const size = fs.statSync(file).size;
      timer = setInterval(() => {
        if ((atWork() && fs.statSync(file, { throwIfNoEntry: false })?.size === size) || !atPrompt()) return;
        clearInterval(timer);
        pi.sendUserMessage(`/sessions ${watching}`, { expandPromptTemplates: true });
      }, 1000);
      timer.unref();
    }
    ctx.ui.setStatus("botmode", watching ? `${watching} is at work · what you type goes to it · ← sessions`
      : session && `${session} · ← or /sessions goes back to your handler`);
    shared.render = () => ctx.ui.setWidget("botmode", shared.running.size
      ? [...shared.running].map((run) => `⏳ ${run.steps.split("\n").at(-1) || `${run.name}: starting`}`) : undefined);
    shared.render();
  });

  pi.on("session_shutdown", (event, ctx) => {
    clearInterval(timer);
    clearInterval(beat);
    shared.render = undefined;
    const { session } = whoAmI(ctx);
    // ponytail: with two windows open, the first to leave its handler's conversation sends the rest headless; track pids if that bites.
    if (main(ctx)) fs.rmSync(WINDOW, { force: true });
    if (event.targetSessionFile === ctx.sessionManager.getSessionFile()) return; // Opened again, as when a bot you watch is done.
    if (shared.entered.delete(session)) release(session); // You left it, so bots may work in it again.
    if (left && ["resume", "new"].includes(event.reason)) carryOn(left); // You only left the room.
  });

  // pi stops a session's work before it closes it, so whether it was at work shows only as you set off.
  pi.on("session_before_switch", (event, ctx) => {
    // /new, with your handler, starts a conversation as /task does: with an address of its own, and in a room of its own.
    if (event.reason === "new" && ctx.hasUI && whoAmI(ctx).bot === HANDLER) {
      pi.sendUserMessage("/task", { expandPromptTemplates: true });
      return { cancel: true };
    }
    left = !ctx.isIdle() && { ...whoAmI(ctx), file: ctx.sessionManager.getSessionFile() };
  });

  // Your conversations with your handler are titled for the lobby by the helper model, anew with each message you send.
  let titling;
  pi.on("input", async (event, ctx) => {
    const spec = !watching && ctx.hasUI && whoAmI(ctx).bot === HANDLER && event.text.trim() && loadConfig().defaults?.helperModel;
    if (spec) {
      const file = ctx.sessionManager.getSessionFile();
      const asked = titling = titleOf(spec, event.text, pi.getSessionName());
      asked.then((title) => { // The latest message's title, whichever answer comes back first.
        if (title && title !== pi.getSessionName() && asked === titling && ctx.sessionManager.getSessionFile() === file) pi.setSessionName(title);
      }).catch(() => {}); // You have left it since.
    }
    if (!watching || event.source === "extension") return { action: "continue" };
    const sent = await tell(watching, event.text);
    ctx.ui.notify(sent.text, sent.ok ? "info" : "warning");
    if (!sent.ok) ctx.ui.setEditorText(event.text); // It has just finished; send it again once the window has it.
    return { action: "handled" };
  });

  pi.registerMessageRenderer("botmode", (message, _options, theme) => messageView(message, theme));

  pi.on("resources_discover", (_event, ctx) => whoAmI(ctx).bot === HANDLER ? { skillPaths: [SKILLS] } : undefined);
  // A bot's session opened in the window itself, without rooms, keeps the handler's ask_user_question (ASK_USER).
  pi.on("tool_call", (event, ctx) => event.toolName === "ask_user_question" && whoAmI(ctx).bot !== HANDLER
    ? { block: true, reason: "Only the handler asks the owner. Message handler with your question." } : undefined);

  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig();
    const me = whoAmI(ctx).bot;
    const team = teamPrompt(config, me, await remoteTeams(config), working());
    // With only the team tools, pi's coding-assistant prompt would contradict the bot's own.
    return { systemPrompt: config.bots[me].tools?.length === 0 ? team : `${event.systemPrompt}\n\n${team}` };
  });

  pi.registerTool({
    ...HANDOFF,
    label: "Handoff",
    promptSnippet: "Hand a task to the team bot whose description fits",
    renderCall: (args, theme, context) => callView("handoff", args.bot, ` · ${args.session}${args.folder ? ` in ${args.folder}` : ""}`, args.task, theme, context),
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = loadConfig();
      const me = whoAmI(ctx);
      // A worker's pi ends with its turn, so it waits for the reply, and reads its messages only once the reply is in.
      if (!ctx.hasUI) return result(await handOffAndWait(config, me.bot, params, signal, (steps) => onUpdate?.(result(steps))));
      const box = me.box ?? HANDLER;
      const { chain, refused, prompt } = handoffFrom(config, me.bot, params, "who gets your reply when you finish; to ask or " +
        `tell them something before then, message ${address(params.bot)[0] === undefined ? box : `${MACHINE}/${box}`}`);
      if (refused) return result(refused);
      // In a window the bot works in the background, and its reply comes back through this session's mailbox.
      const how = { session: params.session, folder: params.folder };
      const done = handOver(config, params.bot, how, prompt, chain, undefined, () => {});
      const early = await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 1000))]); // A refusal comes back at once.
      if (early) return result(replyText(params.bot, early));
      done.then((outcome) => post(me.box, { from: outcome.session ?? params.bot, text: replyText(params.bot, outcome), reply: true }));
      return result(`${params.bot} is working on it in the background. Its reply reaches you as a message; carry on meanwhile.`);
    },
  });

  pi.registerTool({
    ...MESSAGE,
    label: "Message",
    promptSnippet: "Message a bot at work, or the handler",
    renderCall: (args, theme, context) => callView("message", args.to, args.wait ? " · waits for the answer" : "", args.text, theme, context),
    async execute(_id, params, signal, _onUpdate, ctx) {
      // readMail takes this session's messages as they come, and hands the awaited answer to the wait.
      return result(await sendMessage(loadConfig(), whoAmI(ctx).box ?? HANDLER, params, signal, (to, signal) => new Promise((resolve) => {
        const done = (text) => {
          clearTimeout(timeout);
          waiting.delete(to);
          resolve(text);
        };
        const timeout = setTimeout(done, WAIT);
        waiting.set(to, done);
        signal?.addEventListener("abort", () => done(), { once: true });
      })));
    },
  });

  // Registered in every session, since one pi can switch between them; applySelf turns it on for the handler only.
  pi.registerTool({
    name: "configure",
    label: "Configure",
    description: "Change the team's configuration with a JSON merge patch: objects merge, null deletes a key, other values " +
      "replace. Creates, edits, archives and removes bots and sets defaults; the configure-team skill has the fields. The " +
      "whole patch applies, or nothing does and the result lists every problem. The empty patch {} changes nothing and " +
      "shows the configuration, and the bot sessions and Claude Code profiles on this machine.",
    promptSnippet: "Create, edit, archive or remove team bots with a JSON merge patch",
    parameters: { type: "object", additionalProperties: false, required: ["patch"], properties: {
      patch: { type: "object", description: 'For example {"bots": {"research": {"name": "Researcher", "description": "Finds and summarizes sources"}}}' },
    } },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (whoAmI(ctx).bot !== HANDLER) return result("Refused: only the handler changes the team.");
      if (isObject(params.patch) && !Object.keys(params.patch).length) {
        const config = loadConfig();
        const sessions = [...sessionFiles().keys()].filter((session) => inLobby(config, session));
        const profiles = fs.existsSync(PROFILES)
          ? fs.readdirSync(PROFILES).filter((name) => BOT_ID.test(name) && isFolder(path.join(PROFILES, name))).sort() : [];
        return result(`The configuration is:\n${JSON.stringify(config, null, 2)}\n\nBot sessions on this machine: ${sessions.join(", ") || "none yet"}\n` +
          `Claude Code profiles on this machine, in ${PROFILES}: ${profiles.join(", ") || "none yet"}`);
      }
      const found = applyPatch(params.patch);
      if (found.length) return result(`Not applied; the configuration is unchanged:\n${found.join("\n")}`);
      await applySelf(ctx); // Your own new tools and model work from your next step on.
      return result(`Applied. The configuration is now:\n${JSON.stringify(loadConfig(), null, 2)}`);
    },
  });

  /**
   * Opens session `name`, kept in `file`, in this window: a bot's, or a conversation of your handler's. In rooms a session
   * other than this one gets a room of its own, started in `cwd`, and this one stays as it is, out of sight; without rooms
   * pi opens it in place of this one.
   */
  function enter(ctx, name, file, cwd) {
    const me = whoAmI(ctx);
    if (!rooms || name === (me.session ?? me.box)) return ctx.switchSession(file);
    if (cwd && !isFolder(cwd)) throw new Error(`its folder ${cwd} is gone`);
    const dir = cwd && path.dirname(file);
    return toRooms({ busy: busy(ctx, me.box), open: name, ...(cwd && { args: ["--session-dir", dir, "--session", file], cwd }),
      ...(cwd && dir !== SESSIONS && { handler: true }) }); // The rooms give your handler's its extensions.
  }

  /**
   * Opens a bot session in this window: an idle one to talk with, and no handoff runs in it while it is open there; one at
   * work to watch, which the window takes over once the bot is done. The session you leave carries on if it is at work.
   */
  async function focus(ctx, session) {
    const config = loadConfig();
    const file = sessionFiles().get(session);
    if (config.bots[botOf(session)]?.agent === "claude") return talkInClaude(ctx, config, session, file);
    if (!file) return watch(ctx, session, holder(session)?.task); // A new copy has no session to show before its first step.
    try {
      await enter(ctx, session, file, folderOf(config, session, file));
    } catch (error) { // pi refuses a session whose folder is gone.
      ctx.ui.notify(`${session}: ${reason(error)}`, "error");
    }
  }

  /**
   * A bot in Claude Code: one at work you watch, and with any other you talk in Claude Code, in a room of its own, which the
   * rooms keep as yours while it is open. Leaving it brings you back to your handler: with ←, to its lobby, or with /exit.
   */
  async function talkInClaude(ctx, config, session, file) {
    const task = holder(session)?.task;
    if (!file || (task && task !== OPEN)) return watch(ctx, session, task);
    if (!rooms) return ctx.ui.notify(`${session} works in Claude Code, which opens in a room of the \`botmode\` command's window. Hand it work instead.`, "warning");
    const args = [...(await claudeArgs(config, session, [])), "--resume", header(file).claude];
    return toRooms({ busy: busy(ctx, whoAmI(ctx).box), open: session, claude: true, args, cwd: folderOf(config, session, file) });
  }

  /** A session at work: shows what it is doing, and lets you message it, or stop it if this pi runs it. */
  async function watch(ctx, name, task) {
    const run = [...shared.running].find((entry) => entry.name === name);
    const actions = new Map([[`Send ${name} a message`, async () => {
      const text = await ctx.ui.input(`Message to ${name}`, "It reaches the bot at its next step, or right after it finishes");
      if (text?.trim()) ctx.ui.notify((await tell(name, text)).text, "info");
    }]]);
    if (run) actions.set(`Stop ${name}`, () => run.stop());
    const choice = await ctx.ui.select(`${name} · ${task ?? "working"}${run?.steps ? `\n${run.steps}` : ""}`, [...actions.keys()]);
    await actions.get(choice)?.();
  }

  pi.registerCommand("sessions", {
    description: "See your conversations with your handler and every bot session, and open one, or watch it work; /sessions <id> opens that one, and /sessions handler your own",
    async handler(args, ctx) {
      const config = loadConfig();
      const here = whoAmI(ctx).session;
      const busy = new Map(working().map((session) => [session.id, session.task]));
      const files = sessionFiles();
      // Your handler's conversations from every folder, which this window's own leads when pi keeps it elsewhere.
      const current = ctx.sessionManager.getSessionFile();
      const talks = conversations(LOBBY);
      if (shared.home && !talks.some((talk) => talk.file === shared.home)) talks.unshift(about(shared.home));
      const id = args.trim();
      if (id === HANDLER) return enter(ctx, HANDLER, shared.home); // Your handler's conversation.
      const talk = id && talks.find((entry) => entry.id === id);
      if (talk) return enter(ctx, talk.id, talk.file, talk.cwd);
      if (id) return files.has(id) || busy.has(id) ? focus(ctx, id) : ctx.ui.notify(`There is no session ${id} here.`, "warning");
      const choices = new Map();
      for (const talk of talks) {
        const [mine, home] = [talk.file === current, talk.file === shared.home];
        if (!talk.title && !mine && !home) continue; // Never written in.
        const state = mine ? "you are here" : home ? "back to your conversation" : ago(talk.file);
        const atWork = [...shared.running].some((run) => run.file === talk.file);
        choices.set(`${painted(HANDLER, talk.title || "New conversation")} · ${state}${atWork ? " · working" : ""}${talk.cwd ? ` · ${talk.cwd}` : ""}`,
          () => mine ? watching && watch(ctx, watching) : home ? enter(ctx, HANDLER, shared.home) : enter(ctx, talk.id, talk.file, talk.cwd));
      }
      for (const session of new Set([...files.keys(), ...busy.keys()])) {
        // handler here is another machine's handler talking with this one, not a bot of yours; skip removed and archived bots too.
        if (!inLobby(config, session)) continue;
        const state = session === here ? "you are here" : busy.has(session) ? `working · ${busy.get(session)}` : `idle · ${ago(files.get(session))}`;
        const agent = config.bots[botOf(session)].agent === "claude" ? " · Claude Code" : "";
        choices.set(`${session} · ${state} · ${folderOf(config, session, files.get(session))}${agent}`, () => session !== here ? focus(ctx, session)
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
      const choice = await lobbyChoice(ctx, [...choices.keys()]);
      if (choice?.task) await startTask(ctx, choice.task);
      else if (choice) await choices.get(choice)();
    },
  });

  /**
   * Your pick in the lobby: one of `rows`, or {task} for a new conversation with your handler. In your window you type the
   * task under the sessions, as in Claude Code; in a pi without its TUI, the first row asks for it.
   */
  async function lobbyChoice(ctx, rows) {
    const { Input, SelectList, DynamicBorder, getSelectListTheme, keyHint, rawKeyHint, truncateToWidth } = tui() ?? {};
    if (!Input) {
      const row = await ctx.ui.select("Sessions", [NEW_TASK, ...rows]);
      const task = row === NEW_TASK && (await ctx.ui.input(NEW_TASK, "Your message to your handler"))?.trim();
      return task ? { task } : row !== NEW_TASK && row;
    }
    return ctx.ui.custom((screen, theme, keys, done) => {
      const input = new Input({ placeholder: "Type a message to start a new task", placeholderStyle: (text) => theme.fg("dim", text) });
      const list = new SelectList(rows.map((row) => ({ value: row, label: row })), 12, getSelectListTheme());
      const border = new DynamicBorder();
      const hints = `${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "open, or start what you typed")}  ${keyHint("tui.select.cancel", "cancel")}`;
      return {
        get focused() { return input.focused; },
        set focused(value) { input.focused = value; }, // Places the cursor in the input.
        render: (width) => [...border.render(width), ` ${theme.fg("accent", theme.bold("Sessions"))}`, "", ...list.render(width), "",
          ...input.render(width), "", ` ${hints}`, ...border.render(width)].map((line) => truncateToWidth(line, width, "")),
        invalidate: () => input.invalidate(),
        handleInput(key) {
          const task = input.getValue().trim();
          if (keys.matches(key, "tui.select.cancel")) done(undefined);
          else if (keys.matches(key, "tui.select.confirm")) done(task ? { task } : list.getSelectedItem()?.value);
          else if (keys.matches(key, "tui.select.up") || keys.matches(key, "tui.select.down")) list.handleInput(key);
          else input.handleInput(key);
          screen.requestRender();
        },
      };
    });
  }

  /** Starts a new conversation with your handler, in the folder you are in, with `text`, if any, as your first message. */
  async function startTask(ctx, text) {
    const file = newConversation(ctx.cwd);
    const id = idOf(path.basename(file));
    if (text) post(id, { text, owner: true }); // It sends your message as it opens.
    await enter(ctx, id, file, ctx.cwd);
  }

  pi.registerCommand("task", {
    description: "Start a new conversation with your handler, apart from this one, with this message: /task <message>. Alt+Shift+Enter, or Ctrl+Enter, sends what you typed the same way, as does the lobby",
    handler: (args, ctx) => startTask(ctx, args.trim()),
  });

  /** A model you are signed in to, from pi's menu one "/" level at a time, as `botmode setup` does; "" for `none`, undefined to go back. */
  async function chooseModel(ctx, title, none) {
    const available = await ctx.modelRegistry.getAvailable();
    const ids = available.map((model) => `${model.provider}/${model.id}`);
    for (let prefix = ""; ;) {
      const entries = [...new Set(ids.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length).replace(/\/.*/, "/")))];
      const picked = await ctx.ui.select(`${title}${prefix && ` · ${prefix}`}`, [...(prefix ? [] : [none]), ...entries]); // A group ends in "/".
      if (!picked) return undefined;
      if (picked === none) return "";
      prefix += picked;
      if (picked.endsWith("/")) continue;
      if (!available[ids.indexOf(prefix)].reasoning) return prefix;
      const level = await ctx.ui.select(`Thinking for ${prefix}`, THINKING);
      return level ? `${prefix}:${level}` : prefix; // None picked: the model's own.
    }
  }

  pi.registerCommand("botmode", {
    description: "Botmode's settings: your bots' model, and the helper model that titles your conversations with your handler",
    async handler(_args, ctx) {
      const settings = { model: ["Bots' model", "pi's default"], helperModel: ["Helper model", "None: the lobby shows a conversation's first words"] };
      for (;;) {
        const defaults = loadConfig().defaults ?? {};
        const rows = new Map(Object.entries(settings).map(([field, [label, none]]) => [`${label} · ${defaults[field] || none}`, field]));
        const field = rows.get(await ctx.ui.select("Botmode settings", [...rows.keys()]));
        if (!field) return;
        const [label, none] = settings[field];
        const spec = await chooseModel(ctx, label, none);
        if (spec === undefined) continue;
        const found = applyPatch({ defaults: { [field]: spec || null } });
        if (found.length) ctx.ui.notify(`botmode: ${found.join("; ")}`, "warning");
        else if (field === "model") await applySelf(ctx); // The rest read it as they start.
      }
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
      pi.sendMessage({ customType: "botmode", display: true, details: { from: target },
        content: `You -> ${target}: ${message}\n\n${target}${outcome.ok ? "" : " failed"}: ${outcome.text}` });
    },
  });
}
