// Botmode: a team of bots behind one top-level handler, as a pi extension.
// Every bot is a pi process running this file; BOTMODE_BOT names the bot (the handler when unset), so your pi TUI is the
// handler and a handoff runs the target bot as a child pi with its own ongoing session. `botmode host` (cli.mjs) serves
// this machine's bots to your other machines, where they join the team as host/bot.
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
const ME = process.env.BOTMODE_BOT || HANDLER;
const ABOVE = (process.env.BOTMODE_CHAIN || "").split(",").filter(Boolean); // machine/bot entries waiting on this bot, outermost first.
const SELF = fileURLToPath(import.meta.url);
// pi's entry script. Inside pi it is process.argv[1]; the `botmode` command sets BOTMODE_PI after importing this file.
const piEntry = () => process.env.BOTMODE_PI || process.argv[1];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
const SECTIONS = ["defaults", "bots", "hosts"];

// Bot ids double as pi session ids, which must start and end with a letter or digit.
const BOT_ID = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
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
  const [host, bot] = address(target);
  const hosts = Object.keys(config.hosts ?? {});
  const bots = Object.keys(config.bots).filter((id) => id !== HANDLER);
  if (host !== undefined && !hosts.includes(host)) return `Refused: there is no host '${host}'. Hosts: ${hosts.join(", ") || "none"}`;
  // A handler takes work only from another machine's handler, directly, so a worker never steers a bot that has configure.
  const handlerAsks = chain.length === 1 && chain[0].endsWith(`/${HANDLER}`) && (host !== undefined || chain[0] !== `${MACHINE}/${HANDLER}`);
  if (bot === HANDLER && host !== undefined && !handlerAsks) return `Refused: only your handler talks to ${target}, the handler on ${host}.`;
  if (bot === HANDLER ? !handlerAsks : host === undefined && !bots.includes(bot)) {
    return `Refused: there is no bot '${target}' to hand to. Bots: ${bots.join(", ") || "none yet"}`;
  }
  if (chain.includes(`${MACHINE}/${target}`)) return `Refused: ${target} is already working on this request (${chain.join(" -> ")}). Do it yourself.`;
  if (chain.length >= MAX_CHAIN) return `Refused: handoffs stop ${MAX_CHAIN} bots deep (${chain.join(" -> ")}). Do it yourself.`;
  if (typeof task !== "string" || !task.trim()) return "Refused: the task is empty.";
  return "";
}

const line = (id, bot) => `- ${id} (${bot.name}${bot.title ? `, ${bot.title}` : ""}): ${bot.description}`;

/** `remote` maps each host to its bots, or to why they are unavailable. */
export function teamPrompt(config, id, remote = {}) {
  const bot = config.bots[id];
  const identity = `You are ${bot.name}${bot.title ? `, ${bot.title}` : ""}. ${bot.description}`;
  const roster = [
    ...Object.entries(config.bots).filter(([other]) => other !== id && other !== HANDLER).map(([other, entry]) => line(other, entry)),
    ...Object.entries(remote).flatMap(([host, bots]) => typeof bots === "string" ? [`- ${host}/…: unavailable right now (${bots})`] : [
      ...(id === HANDLER ? [`- ${host}/${HANDLER}: the handler on ${host}. Ask it about that machine, or to create or change bots there.`] : []),
      ...bots.map((entry) => line(`${host}/${entry.id}`, entry)),
    ]),
  ].join("\n");
  const role = id === HANDLER
    ? "Every message from the owner reaches you first. Answer quick questions yourself. Hand work that fits another bot's " +
      "description to that bot with handoff, then relay its result. When the owner asks to change the team, including you " +
      `(bots.${HANDLER}: your tools, model and instructions), change it with configure and confirm what changed. When no bot fits recurring work, offer to create one.`
    : "You are one bot on a team. When a task, or part of one, fits another bot's description better than yours, hand it " +
      "over with handoff and use its reply.";
  const team = Object.keys(remote).length ? "Team (a host/bot id is a bot on another of the owner's machines)" : "Team";
  const parts = [identity, bot.instructions, role, `${team}:\n${roster || "(no other bots yet)"}`];
  if (id === HANDLER) parts.push(`Current configuration:\n${JSON.stringify(config, null, 2)}\n${FIELDS}`);
  return parts.filter(Boolean).join("\n\n");
}

const oneLine = (text, size = 100) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > size ? `${flat.slice(0, size - 1)}…` : flat;
};
const textOf = (content) => typeof content === "string" ? content
  : (content ?? []).filter((block) => block?.type === "text").map((block) => block.text ?? "").join("");

/** Runs one turn of `target` in a child pi; reports its steps through onProgress and resolves to {ok, text}. */
function runBot(config, target, prompt, chain, signal, onProgress) {
  const cwd = config.bots[target].workspace || path.join(HOME, "bots", target);
  fs.mkdirSync(cwd, { recursive: true });
  const args = [piEntry(), "--mode", "json", "-p", "--session-dir", path.join(HOME, "sessions"), "--session-id", target, "-e", SELF, prompt];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd, env: { ...process.env, BOTMODE_BOT: target, BOTMODE_CHAIN: chain.join(",") }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const steps = [], replies = [];
    let buffer = "", errors = "", last;
    const step = (text) => {
      steps.push(`${target}: ${oneLine(text)}`);
      onProgress(steps.slice(-6).join("\n"));
    };
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
      if (buffer.trim()) onLine(buffer);
      if (!last || last.stopReason === "error" || last.stopReason === "aborted") {
        resolve({ ok: false, text: last?.errorMessage || errors.trim() || `pi exited with code ${code}` });
      } else resolve({ ok: true, text: replies.at(-1) ?? "" });
    });
    // ponytail: kills the bot's pi, not processes its tools started; kill the tree if strays appear.
    signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
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
      const { bots } = await (await callHost(url, "bots", undefined, AbortSignal.timeout(3000))).json();
      return [host, Array.isArray(bots) ? bots : "it sent no roster"];
    } catch (error) {
      return [host, reason(error)];
    }
  })));
}

/** Runs `bot` on another machine's `botmode host`; its steps stream back as they happen. */
async function runRemote(config, host, bot, prompt, chain, signal, onProgress) {
  try {
    const response = await callHost(config.hosts[host].url, "handoff", { bot, prompt, chain }, signal);
    let buffer = "", outcome = { ok: false, text: `${host} hung up before ${bot} replied` };
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      const lines = (buffer + chunk).split("\n");
      buffer = lines.pop();
      for (const message of lines.filter(Boolean).map((text) => JSON.parse(text))) {
        if ("steps" in message) onProgress(message.steps);
        else outcome = message;
      }
    }
    return outcome;
  } catch (error) {
    return { ok: false, text: `${host}: ${reason(error)}` };
  }
}

/** Runs `target`, a bot here or host/bot on another machine, and resolves to {ok, text}. */
export function handOver(config, target, prompt, chain, signal, onProgress) {
  const [host, bot] = address(target);
  return host === undefined ? runBot(config, bot, prompt, chain, signal, onProgress)
    : runRemote(config, host, bot, prompt, chain, signal, onProgress);
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
 * A request from one of your machines, which all hold the token. GET /bots lists this machine's bots.
 * POST /handoff {bot, prompt, chain} runs one and streams {steps} lines, then {ok, text}.
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
      .map(([id, bot]) => ({ id, name: bot.name, title: bot.title, description: bot.description })) });
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
  if (route !== "POST /handoff") return send(res, 404, { error: "not found" });
  const { bot, prompt, chain } = await readJson(req);
  // Only a bot of this machine: a host never relays to a third machine.
  if (!(typeof bot === "string" && BOT_ID.test(bot) && typeof prompt === "string" && Array.isArray(chain) &&
    chain.every((entry) => typeof entry === "string" && /^[^,\s]+$/.test(entry)))) {
    return send(res, 400, { error: "expected {bot, prompt, chain}" });
  }
  const refused = refusal(config, chain, bot, prompt);
  if (refused) return send(res, 200, { ok: false, text: refused });
  log([...chain, `${MACHINE}/${bot}`].join(" -> "));
  res.writeHead(200, { "content-type": "application/x-ndjson" }).flushHeaders();
  const stop = new AbortController();
  res.on("close", () => res.writableFinished || stop.abort()); // The caller pressed Esc or went away.
  // Blank lines keep proxies, and the caller's 5-minute body timeout, from closing the stream while a long tool runs.
  const beat = setInterval(() => res.write("\n"), 30_000);
  const outcome = await runBot(config, bot, prompt, chain, stop.signal, (steps) => res.write(`${JSON.stringify({ steps })}\n`));
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

export default function botmode(pi) {
  const teamTools = ME === HANDLER ? ["handoff", "configure"] : ["handoff"];

  /** Applies this bot's tools and model from the configuration: at start, and when the handler changes itself. */
  async function applySelf(ctx) {
    const config = loadConfig();
    const bot = config.bots[ME];
    if (!bot) throw new Error(`botmode: there is no bot '${ME}' in ${CONFIG}.`);
    pi.setActiveTools(bot.tools ? [...bot.tools, ...teamTools] : [...DEFAULT_TOOLS, ...teamTools]);
    const spec = bot.model || config.defaults?.model;
    if (spec) {
      const { provider, id, thinking } = parseModel(spec);
      const model = ctx.modelRegistry.find(provider, id);
      if (!model || !(await pi.setModel(model))) ctx.ui.notify(`botmode: ${spec} is unavailable or signed out; using ${ctx.model?.id}.`, "warning");
      if (thinking) pi.setThinkingLevel(thinking);
    }
  }

  pi.on("session_start", (_event, ctx) => applySelf(ctx));

  pi.on("before_agent_start", async (event) => {
    const config = loadConfig();
    const team = teamPrompt(config, ME, await remoteTeams(config));
    // With only the team tools, pi's coding-assistant prompt would contradict the bot's own.
    return { systemPrompt: config.bots[ME].tools?.length === 0 ? team : `${event.systemPrompt}\n\n${team}` };
  });

  pi.registerTool({
    name: "handoff",
    label: "Handoff",
    description: "Hand a task to another bot on the team and wait for its reply. Choose the bot whose description fits.",
    promptSnippet: "Hand a task to the team bot whose description fits",
    parameters: { type: "object", additionalProperties: false, required: ["bot", "task"], properties: {
      bot: { type: "string", description: "The id of the bot to hand the task to; host/id for a bot on another machine, and host/handler for its handler" },
      task: { type: "string", description: "The complete task, with every requirement and the context the bot needs to work alone" },
    } },
    async execute(_id, params, signal, onUpdate) {
      const config = loadConfig();
      const chain = [...ABOVE, `${MACHINE}/${ME}`];
      const refused = refusal(config, chain, params.bot, params.task);
      if (refused) return result(refused);
      const prompt = `[Handed over by ${config.bots[ME].name} on ${MACHINE}]\n${params.task}`;
      const outcome = await handOver(config, params.bot, prompt, chain, signal, (steps) => onUpdate?.(result(steps)));
      return result(outcome.ok ? `${params.bot} replied:\n${outcome.text}` : `${params.bot} failed: ${outcome.text}`);
    },
  });

  if (ME === HANDLER) {
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
        const found = applyPatch(params.patch);
        if (found.length) return result(`Not applied; the configuration is unchanged:\n${found.join("\n")}`);
        await applySelf(ctx); // Your own new tools and model work from your next step on.
        return result(`Applied. The configuration is now:\n${JSON.stringify(loadConfig(), null, 2)}`);
      },
    });
  }

  pi.registerCommand("bot", {
    description: "Talk to one bot directly: /bot <id or host/id> <message>",
    async handler(args, ctx) {
      const [, target, message] = args.trim().match(/^(\S+)\s+([\s\S]+)$/) ?? [];
      if (!message) return ctx.ui.notify("Usage: /bot <id or host/id> <message>", "warning");
      const config = loadConfig();
      const chain = [`${MACHINE}/${ME}`]; // You speak through your handler, so you can reach other machines' handlers too.
      const refused = refusal(config, chain, target, message);
      if (refused) return ctx.ui.notify(refused, "warning");
      ctx.ui.setStatus("botmode", `${target} is working…`);
      const outcome = await handOver(config, target, message, chain, undefined, (steps) => ctx.ui.setStatus("botmode", steps.split("\n").at(-1)));
      ctx.ui.setStatus("botmode", undefined);
      pi.sendMessage({ customType: "botmode", display: true,
        content: `You -> ${target}: ${message}\n\n${target}${outcome.ok ? "" : " failed"}: ${outcome.text}` });
    },
  });
}
