#!/usr/bin/env node
// The `botmode` command. With no command it opens your handler in pi's TUI, and other arguments go to pi. `setup`,
// `invite`, `status` and `teardown` set up, connect, check and undo this machine; `host` is what runs in the background.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ASK_USER, BILLION_CONTEXT, HANDLER, HOME, MCP_ADAPTER, OPEN, PORT, applyPatch, callHost, claim, conversationIn, hasToken, inviteCode,
  leavesClaude, loadConfig, readInvite, release, remoteTeams, saveToken, serve, setHost, token, working } from "./botmode.mjs";

const CLI = fileURLToPath(import.meta.url);
const EXTENSION = fileURLToPath(new URL("botmode.mjs", import.meta.url));
const DRAWING = fileURLToPath(new URL("botmode-tui.mjs", import.meta.url)); // Lends botmode.mjs pi's TUI, for bots' colours.
// The extensions of a pi in your window, and of your handler's, which alone asks you questions there.
const LOADS = [EXTENSION, DRAWING, MCP_ADAPTER, BILLION_CONTEXT].flatMap((file) => ["-e", file]);
const HANDLER_LOADS = [...LOADS, "-e", ASK_USER];
// Your handler carries on its last conversation in the folder you start in, as pi's -c does, unless you name a session.
// Its conversations, from every folder, stay apart from those of the pi you run yourself, in ~/.botmode/handler.
const PICKS = ["-c", "--continue", "-r", "--resume", "--session", "--session-id", "--fork", "--no-session"];
const handlerArgs = (args) => ["--session-dir", path.join(HOME, "handler"),
  ...(args.some((arg) => PICKS.includes(arg)) ? [] : ["--session", conversationIn(process.cwd())]), ...args];
// pi comes with this package. Its command is dist/bundle/cli.js, beside the dist/index.js the package exports.
const PI = path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
process.env.BOTMODE_PI = PI;
// So does Claude Code, for coding bots: its install puts the program for this machine in place of bin/claude.exe.
const CLAUDE_PACKAGE = createRequire(import.meta.url).resolve("@anthropic-ai/claude-code/package.json");
const CLAUDE = path.join(path.dirname(CLAUDE_PACKAGE), "bin", "claude.exe");
process.env.BOTMODE_CLAUDE = CLAUDE;
process.env.DISABLE_AUTOUPDATER = "1"; // It updates with Botmode.
const LOCAL = `http://127.0.0.1:${PORT}`;
const TAILNET_PORT = 8445; // The HTTPS port `tailscale serve` shares this machine's host on.
const HOST_COMMAND = [process.execPath, CLI, "host"];
const SOURCE = "github:samchung95/botmode"; // What `botmode update` installs.
const LABEL = "dev.botmode.host"; // macOS starts the host through this LaunchAgent.
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const TASK = "Botmode"; // Windows starts the host from this scheduled task, which can run it as administrator.
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"; // Where earlier versions started it.
const SUDOERS = "/etc/sudoers.d/botmode"; // On macOS, lets your bots use sudo without a password.
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"]; // pi's thinking levels.
const THINKING = new RegExp(`:(${LEVELS.join("|")})$`);
const HELP = `botmode                  talk to your handler in pi's TUI; other arguments go to pi
botmode setup            sign in to a model and Claude Code, pick your bots' and helper's models, and let your other machines connect
botmode setup <invite>   connect this machine to the one that printed the invite
botmode invite           print an invite for another machine
botmode status           show this machine's sign-ins, model, bots, host and connected machines
botmode teardown         disconnect this machine, stop its host and, if you say so, delete its bots
botmode update           install the latest Botmode from GitHub and restart the host
botmode restart          restart this machine's host
botmode host             run this machine's host in the foreground (setup runs it in the background)`;

let terminal;
const io = () => (terminal ??= readline.createInterface({ input: process.stdin, output: process.stdout }));
const say = (text = "") => console.log(text);
const ask = async (question, signal) => (await io().question(`${question} `, { signal })).trim();
const reason = (error) => error.cause?.message || error.message;
const quietly = (command, args) => {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

async function yes(question, fallback) {
  const answer = await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"}`);
  return answer ? /^y/i.test(answer) : fallback;
}

/** A numbered choice; Enter gives undefined. */
async function pick(question, options) {
  options.forEach((option, index) => say(`  ${index + 1}. ${option.label}`));
  for (;;) {
    const answer = await ask(question);
    if (!answer) return undefined;
    if (options[Number(answer) - 1]) return options[Number(answer) - 1];
    say(`Type a number from 1 to ${options.length}, or press Enter to skip.`);
  }
}

async function secret(question, signal) {
  const line = io();
  process.stdout.write(`${question} `);
  const write = line._writeToOutput;
  line._writeToOutput = () => {}; // ponytail: readline's private output hook, muted so a pasted key never shows.
  try {
    return (await line.question("", { signal })).trim();
  } finally {
    line._writeToOutput = write;
    say();
  }
}

function openBrowser(url) {
  const [command, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  spawn(command, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

/** pi's model runtime over the sign-ins its TUI uses. */
async function engine() {
  const { ModelRuntime, SettingsManager, VERSION, getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const dir = getAgentDir();
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json") });
  return { runtime, dir, version: VERSION, deviceId: () => SettingsManager.create(process.cwd(), dir).getOrCreateDeviceId() };
}

const usableModels = async (runtime) => (await runtime.getAvailable()).map((model) => `${model.provider}/${model.id}`);
const providersOf = (models) => [...new Set(models.map((model) => model.slice(0, model.indexOf("/"))))];

// How pi's sign-in flows talk to you in a plain terminal.
const interaction = {
  async prompt(request) {
    if (request.type === "secret") return secret(request.message, request.signal);
    if (request.type !== "select") return ask(request.message, request.signal);
    const chosen = await pick(`${request.message} (number):`, request.options.map((option) =>
      ({ id: option.id, label: option.description ? `${option.label}: ${option.description}` : option.label })));
    if (!chosen) throw new Error("cancelled");
    return chosen.id;
  },
  notify(event) {
    if (event.type === "auth_url") {
      say(`${event.instructions ?? "Finish signing in in your browser:"}\n  ${event.url}`);
      openBrowser(event.url);
    } else if (event.type === "device_code") {
      say(`Open ${event.verificationUri} and enter the code ${event.userCode}`);
      openBrowser(event.verificationUri);
    } else say([event.message, ...(event.links ?? []).map((link) => `  ${link.url}`)].join("\n"));
  },
};

/** Signs in to one provider you pick; false when you skip. */
async function signIn({ runtime, deviceId }) {
  const providers = runtime.getProviders();
  let chosen = await pick("Sign in with (number, Enter to skip):", [
    ...providers.filter((provider) => provider.auth.oauth)
      .map((provider) => ({ label: `${provider.auth.oauth.loginLabel || provider.auth.oauth.name}, in your browser`, provider, type: "oauth" })),
    { label: "An API key", type: "api_key" },
  ]);
  if (chosen && !chosen.provider) {
    chosen = await pick("Whose key (number, Enter to skip):", providers.filter((provider) => provider.auth.apiKey?.login)
      .map((provider) => ({ label: provider.auth.apiKey.name, provider, type: "api_key" })));
  }
  if (!chosen) return false;
  try {
    await runtime.login(chosen.provider.id, chosen.type, interaction, { getDeviceId: deviceId });
    say(`Signed in to ${chosen.provider.name}.`);
  } catch (error) {
    say(`Not signed in: ${error.message}`);
  }
  return true;
}

/** Picks one of `ids` ("provider/model") one "/" level at a time: a number opens a group or picks a model, and text searches. */
async function pickModel(ids) {
  let shown = ids, prefix = "";
  for (;;) {
    const under = shown.filter((id) => id.startsWith(prefix));
    const entries = [...new Set(under.map((id) => id.slice(prefix.length).replace(/\/.*/, "/")))]; // A group ends in "/".
    if (!entries.length) {
      say("None of your signed-in models matches that.");
      [shown, prefix] = [ids, ""];
      continue;
    }
    if (entries.length === 1 && entries[0].endsWith("/")) {
      prefix += entries[0]; // Only one group here, so open it.
      continue;
    }
    if (prefix) say(prefix);
    entries.forEach((entry, index) =>
      say(`  ${index + 1}. ${entry}${entry.endsWith("/") ? ` (${under.filter((id) => id.startsWith(prefix + entry)).length})` : ""}`));
    const answer = await ask("Number, or type to search (Enter keeps your current model):");
    if (!answer) return undefined;
    const entry = /^\d+$/.test(answer) ? entries[Number(answer) - 1] : undefined;
    if (entry === undefined) [shown, prefix] = [ids.filter((id) => id.toLowerCase().includes(answer.toLowerCase())), ""];
    else if (entry.endsWith("/")) prefix += entry;
    else return prefix + entry;
  }
}

/** Shows your bots' default model, or your helper's (`field` "helperModel"), and lets you pick another from your sign-ins. */
async function chooseModel(runtime, field = "model") {
  const available = await runtime.getAvailable();
  const ids = available.map((model) => `${model.provider}/${model.id}`);
  const current = loadConfig().defaults?.[field] ?? "";
  const [they, use, are] = field === "model" ? ["Your bots", "use", "are"] : ["Your helper", "uses", "is"];
  if (!current) say(field === "model" ? "Your bots use pi's default model." : "You have no helper, so the lobby shows each conversation's first words.");
  else if (ids.includes(current.replace(THINKING, ""))) say(`${they} ${use} ${current}.`);
  else say(`${they} ${are} set to ${current}, which none of your sign-ins offers.`);
  if (!ids.length) return;
  let model = await pickModel(ids);
  if (!model) return;
  if (available[ids.indexOf(model)].reasoning) {
    const level = await pick("Thinking level (number, Enter for the model's default):", LEVELS.map((label) => ({ label })));
    if (level) model += `:${level.label}`;
  }
  applyPatch({ defaults: { [field]: model } });
  say(`${they} now ${use} ${model}.`);
}

/** This machine on your tailnet as {cli, name, url}, or {problem} saying what to fix. */
function tailnet() {
  const candidates = { win32: ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"],
    darwin: ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"] }[process.platform] ?? ["tailscale"];
  const cli = candidates.find((candidate) => quietly(candidate, ["version"]));
  const install = { win32: "`winget install tailscale.tailscale`", darwin: "the Mac App Store or `brew install --cask tailscale`" }[process.platform]
    ?? "https://tailscale.com/download";
  if (!cli) return { problem: `Connecting machines needs Tailscale. Install it with ${install}, sign in, then run \`botmode setup\` again.` };
  let status;
  try {
    status = JSON.parse(execFileSync(cli, ["status", "--json"], { encoding: "utf-8" }));
  } catch {
    status = {};
  }
  if (status.BackendState !== "Running" || !status.Self?.DNSName) {
    return { problem: "Tailscale is installed but not connected. Sign in to it, then run `botmode setup` again." };
  }
  const dns = status.Self.DNSName.replace(/\.$/, "");
  // Other machines call this one by its tailnet name, trimmed to a host id.
  const name = dns.split(".")[0].replace(/^[^a-z]+/, "").slice(0, 32).replace(/-+$/, "") || "machine";
  return { cli, name, url: `https://${dns}:${TAILNET_PORT}` };
}

/** What `tailscale serve` shares on the botmode port, if anything. */
function sharedOnTailnet({ cli, url }) {
  try {
    return JSON.parse(execFileSync(cli, ["serve", "status", "--json"], { encoding: "utf-8" }) || "{}").Web?.[new URL(url).host]?.Handlers?.["/"]?.Proxy;
  } catch {
    return undefined;
  }
}

async function hostAnswers() {
  try {
    await callHost(LOCAL, "bots", undefined, AbortSignal.timeout(2000));
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition, seconds) {
  for (let tries = seconds * 4; tries > 0; tries--) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const startsAtLogin = () => process.platform === "darwin" ? fs.existsSync(PLIST)
  : process.platform === "win32" && quietly("schtasks", ["/query", "/tn", TASK]);
const isAdmin = () => process.platform === "win32" && quietly("net", ["session"]); // Only an elevated terminal may list sessions.

function hostRunsAsAdmin() {
  try {
    return execFileSync("schtasks", ["/query", "/tn", TASK, "/xml"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .includes("<RunLevel>HighestAvailable</RunLevel>");
  } catch {
    return false;
  }
}

/** Windows: the task that starts the host at your logon; `admin` runs it elevated. No time limit, and it runs on battery. */
function registerTask(admin) {
  const user = xml(`${process.env.USERDOMAIN}\\${process.env.USERNAME}`);
  const file = path.join(os.tmpdir(), `botmode-task-${process.pid}.xml`);
  // conhost --headless keeps the host's console window hidden.
  fs.writeFileSync(file, `﻿<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><UserId>${user}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType>
    <RunLevel>${admin ? "HighestAvailable" : "LeastPrivilege"}</RunLevel></Principal></Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author"><Exec><Command>conhost.exe</Command>
    <Arguments>${xml(["--headless", ...HOST_COMMAND].map((arg) => `"${arg}"`).join(" "))}</Arguments></Exec></Actions>
</Task>
`, "utf16le");
  try {
    execFileSync("schtasks", ["/create", "/tn", TASK, "/xml", file, "/f"], { stdio: "ignore" });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Starts this machine's host now and at every login. */
async function startHost() {
  if (process.platform === "darwin") {
    const env = Object.entries(process.env).filter(([key]) => key === "PATH" || key === "PI_CODING_AGENT_DIR" || key.startsWith("BOTMODE_"));
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${HOST_COMMAND.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict>${env.map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`);
    execFileSync("launchctl", ["bootstrap", `gui/${os.userInfo().uid}`, PLIST]);
  } else if (process.platform === "win32") {
    quietly("reg", ["delete", RUN_KEY, "/v", "Botmode", "/f"]);
    if (isAdmin()) {
      registerTask(await yes("Run this machine's host as administrator? Whatever your other machines ask of it then runs with admin rights.",
        hostRunsAsAdmin()));
    } else if (hostRunsAsAdmin()) {
      say("The host runs as administrator. To change that, run `botmode setup` from a terminal opened as administrator.");
    } else {
      registerTask(false);
      say("The host runs with your normal rights. For admin rights, run `botmode setup` from a terminal opened as administrator.");
    }
    execFileSync("schtasks", ["/run", "/tn", TASK], { stdio: "ignore" });
  } else {
    throw new Error("Running the host in the background is built for Windows and macOS. Here, run `botmode host` and keep it running.");
  }
  if (!(await waitFor(hostAnswers, 15))) throw new Error(`The host did not start; see ${path.join(HOME, "host.log")}.`);
}

/** Stops this machine's host, which keeps its start at login until teardown. */
async function stopHost() {
  if (process.platform === "darwin") quietly("launchctl", ["bootout", `gui/${os.userInfo().uid}/${LABEL}`]);
  else if (hasToken()) await callHost(LOCAL, "stop", {}).catch(() => {});
  await waitFor(async () => !(await hostAnswers()), 5);
  if (process.platform === "win32") quietly("schtasks", ["/end", "/tn", TASK]); // So the next /run is not taken for a second copy.
}

/** Runs `command` in your terminal, where it can ask you things itself. */
function inTerminal(command, args) {
  terminal?.close(); // Hands the terminal over; the next question opens it again.
  terminal = undefined;
  execFileSync(command, args, { stdio: "inherit" });
}

/** Runs sudo in your terminal, where it asks for your password. */
const sudo = (...args) => inTerminal("sudo", args);

/** Claude Code's sign-in, as it reports it: {loggedIn, authMethod, …}, or {} when it cannot say. */
function claudeSignIn() {
  try {
    return JSON.parse(spawnSync(CLAUDE, ["auth", "status", "--json"], { encoding: "utf-8" }).stdout) ?? {};
  } catch {
    return {};
  }
}

/** Shows whether Claude Code is signed in, and signs it in if you say so. */
async function claudeStep() {
  const before = claudeSignIn();
  say(before.loggedIn ? `Claude Code is signed in (${before.authMethod}).` : "Claude Code is not signed in yet. Your coding bots need it.");
  if (!(await yes(before.loggedIn ? "Sign in with another account?" : "Sign in now?", !before.loggedIn))) return;
  try {
    inTerminal(CLAUDE, ["auth", "login"]);
  } catch {} // Cancelled, or it said why.
  say(claudeSignIn().loggedIn ? "Claude Code is signed in." : "Claude Code is not signed in. Run `botmode setup` to try again.");
}

/** macOS: lets your bots use sudo without a password, or takes that away. */
async function sudoStep() {
  const allowed = fs.existsSync(SUDOERS);
  say(allowed ? "Your bots can use sudo without a password." : "Your bots cannot use sudo without a password.");
  if (allowed ? await yes("Keep that?", true) : !(await yes("Let them? Any program running as you could then too.", false))) return;
  if (allowed) sudo("rm", "-f", SUDOERS);
  else {
    const file = path.join(os.tmpdir(), `botmode-sudoers-${process.pid}`);
    fs.writeFileSync(file, `${os.userInfo().username} ALL=(ALL) NOPASSWD: ALL\n`);
    try {
      sudo("visudo", "-cqf", file); // A broken sudoers file would lock you out of sudo, so it is checked first.
      sudo("install", "-m", "0440", "-o", "root", "-g", "wheel", file, SUDOERS);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  say(allowed ? "Done: sudo asks your bots for a password again." : `Done: your bots can use sudo without a password (${SUDOERS}).`);
}

/** Runs this machine's host in the background and shares it on your tailnet. `secret` comes from an invite. */
async function share(net, secret) {
  const shared = sharedOnTailnet(net);
  if (shared && shared !== LOCAL) throw new Error(`Tailscale already shares ${shared} on port ${TAILNET_PORT}. Free that port, then run \`botmode setup\` again.`);
  await stopHost(); // Before the token changes, while the running host still accepts the old one.
  if (secret) saveToken(secret);
  else if (!hasToken()) saveToken();
  await startHost();
  execFileSync(net.cli, ["serve", "--bg", `--https=${TAILNET_PORT}`, LOCAL], { stdio: "ignore" });
}

/** Tells every connected machine to forget this one, then forgets them. */
async function leaveAll(net) {
  for (const [id, { url }] of Object.entries(loadConfig().hosts ?? {})) {
    if (net.url) await callHost(url, "leave", { url: net.url }, AbortSignal.timeout(5000)).catch(() => {});
    setHost(id, null);
  }
}

async function join(invite, net) {
  const others = Object.keys(loadConfig().hosts ?? {});
  if (others.length && hasToken() && token() !== invite.token) {
    if (!(await yes(`This machine is connected to ${others.join(", ")} through another invite. Joining ${invite.name} disconnects them. Continue?`, false))) return;
    await leaveAll(net);
  }
  await share(net, invite.token);
  const { hosts } = await (await callHost(invite.url, "join", { name: net.name, url: net.url })).json();
  setHost(invite.name, invite.url);
  say(`Connected to ${invite.name}. Its bots join your team as ${invite.name}/<id>.`);
  for (const [name, { url }] of Object.entries(hosts)) { // The inviter's other machines, so every machine reaches every other.
    try {
      await callHost(url, "join", { name: net.name, url: net.url });
      setHost(name, url);
      say(`Connected to ${name}.`);
    } catch (error) {
      say(`Could not connect to ${name} (${reason(error)}).`);
    }
  }
}

function printInvite(net) {
  say(`On the other machine, install Botmode and run:\n\n  botmode setup ${inviteCode(net.name, net.url)}\n`);
  say("The code holds the secret your machines share. Send it only to yourself.");
}

async function setup(code) {
  const invite = code === undefined ? undefined : readInvite(code);
  const net = tailnet();
  if (invite && net.problem) throw new Error(net.problem);
  if (invite?.url === net.url) throw new Error("That invite is from this machine. Use it on the machine you want to connect.");
  say("Botmode setup. Enter takes the answer in capitals.\n\n1. Model sign-in");
  const pi = await engine();
  const wanted = (loadConfig().defaults?.model ?? "").split("/")[0]; // The provider of your bots' model, if they have one.
  for (;;) {
    const providers = providersOf(await usableModels(pi.runtime));
    say(providers.length ? `Signed in to ${providers.join(", ")} (pi ${pi.version}, ${pi.dir}).`
      : `Not signed in to any model provider yet (pi ${pi.version}). Your bots need one.`);
    const missing = wanted && !providers.includes(wanted) ? pi.runtime.getProviders().find((provider) => provider.id === wanted) : undefined;
    if (missing) say(`Your bots' model is from ${missing.name} (${missing.id}), which you are not signed in to.`);
    if (providers.length && !(await yes("Sign in to another provider?", Boolean(missing)))) break;
    if (!(await signIn(pi))) break;
  }
  say("\n2. Your bots' model");
  await chooseModel(pi.runtime);
  say("\n3. A helper model, small and quick, that names your conversations with your handler after their task");
  await chooseModel(pi.runtime, "helperModel");
  say('\n4. Claude Code, which coding bots ("agent": "claude") work in');
  await claudeStep();
  say("\n5. Your other machines");
  if (invite) await join(invite, net);
  else if (await hostAnswers()) {
    if (!net.problem) await share(net); // A restart, so an updated Botmode takes effect.
    say(`This machine is shared on your tailnet at ${net.url ?? LOCAL}. Run \`botmode invite\` to connect another machine.`);
  } else if (await yes("Let your other machines, Windows or Mac, connect to this one?", false)) {
    if (net.problem) say(net.problem);
    else {
      await share(net);
      printInvite(net);
    }
  }
  if (process.platform === "darwin") {
    say("\n6. Admin rights");
    await sudoStep();
  }
  say("\nDone. Run `botmode` to talk to your handler, where /botmode changes these models, or `botmode status` to check this machine.");
}

async function invite() {
  const net = tailnet();
  if (net.problem) throw new Error(net.problem);
  if (!(await hostAnswers())) throw new Error("This machine is not shared yet. Run `botmode setup` and let your other machines connect.");
  printInvite(net);
}

async function status() {
  const pi = await engine();
  const config = loadConfig();
  const net = tailnet();
  const teams = await remoteTeams(config);
  say(`Engine    pi ${pi.version}, signed in to ${providersOf(await usableModels(pi.runtime)).join(", ") || "nothing yet (run botmode setup)"}`);
  say(`Model     ${config.defaults?.model || "pi's default"}`);
  say(`Helper    ${config.defaults?.helperModel || "none (the lobby shows each conversation's first words)"}`);
  const claude = claudeSignIn();
  say(`Claude    Claude Code ${JSON.parse(fs.readFileSync(CLAUDE_PACKAGE, "utf-8")).version}, ` +
    `${claude.loggedIn ? `signed in (${claude.authMethod})` : "not signed in (run botmode setup)"}`);
  say(`Bots      ${Object.keys(config.bots).join(", ")}  (${path.join(HOME, "config.json")})`);
  say(`Host      ${(await hostAnswers()) ? `running on ${LOCAL}` : "not running"}${startsAtLogin() ? ", starts at login" : ""}`);
  say(`Tailnet   ${net.problem ?? (sharedOnTailnet(net) === LOCAL ? `shared at ${net.url}` : "not shared")}`);
  if (process.platform === "win32") say(`Admin     the host runs ${hostRunsAsAdmin() ? "as administrator" : "with your normal rights"}`);
  if (process.platform === "darwin") say(`Admin     ${fs.existsSync(SUDOERS) ? "your bots can use sudo without a password" : "sudo asks your bots for a password"}`);
  say(`Working   ${working().map((session) => session.id).join(", ") || "nothing right now"}`);
  for (const [id, { url }] of Object.entries(config.hosts ?? {})) {
    const team = teams[id];
    say(`Machine   ${id}  ${url}  ${typeof team === "string" ? `unavailable (${team})` : `bots: ${team.bots.map((bot) => bot.id).join(", ") || "none"}`}`);
  }
}

async function teardown() {
  if (!(await yes("Disconnect this machine from your others and stop its host?", true))) return;
  const net = tailnet();
  await leaveAll(net);
  await stopHost();
  if (process.platform === "darwin") fs.rmSync(PLIST, { force: true });
  if (process.platform === "win32") {
    quietly("reg", ["delete", RUN_KEY, "/v", "Botmode", "/f"]);
    if (startsAtLogin() && !quietly("schtasks", ["/delete", "/tn", TASK, "/f"])) {
      say("The host still starts at login as administrator. Run `botmode teardown` from a terminal opened as administrator to remove that.");
    }
  }
  if (net.cli && sharedOnTailnet(net) === LOCAL) execFileSync(net.cli, ["serve", `--https=${TAILNET_PORT}`, "off"], { stdio: "ignore" });
  say("Disconnected, and the host is stopped.");
  if (process.platform === "darwin" && fs.existsSync(SUDOERS) && (await yes("Also stop your bots using sudo without a password?", true))) {
    sudo("rm", "-f", SUDOERS);
  }
  if (await yes(`Also delete your bots, their sessions and this machine's token (${HOME})?`, false)) {
    fs.rmSync(HOME, { recursive: true, force: true });
    say(`Deleted ${HOME}.`);
  }
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  say(`Your model sign-ins stay in ${getAgentDir()}, where pi keeps them, and Claude Code keeps its own. To remove the command ` +
    "too: npm uninstall -g botmode");
}

async function restart() {
  if (!(await hostAnswers())) return say("The host is not running. `botmode setup` starts it.");
  await stopHost();
  await startHost();
  say("The host restarted.");
}

function update() {
  try {
    // npm is a .cmd on Windows, which only a shell runs. Both arguments are fixed strings.
    execFileSync("npm", ["install", "--global", SOURCE], { stdio: "inherit", shell: process.platform === "win32" });
  } catch {
    throw new Error("The update did not install. If npm said EBUSY, an open botmode window is using its files: close every " +
      "other botmode window, then run `botmode update` again.");
  }
  execFileSync(process.execPath, [CLI, "restart"], { stdio: "inherit" }); // The new code restarts its own host.
}

function openHandler(args) {
  process.on("SIGINT", () => {}); // pi reads Ctrl+C itself; this process only waits for pi to exit.
  spawn(process.execPath, [PI, ...HANDLER_LOADS, ...args], { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 1));
}

/**
 * Your window as rooms: a pi in a terminal of its own for each conversation you open, your handler's first, shown one at a
 * time. A room's lobby (← or /sessions) asks this process for another room; the one you leave carries on out of sight
 * while it is at work and closes once it is idle, so leaving never stops anything. Without node-pty, or a terminal to
 * draw in, one pi switches between sessions itself.
 */
async function openWindow(args) {
  const pty = process.stdin.isTTY && await import("node-pty").then((module) => module.default, () => undefined);
  if (!pty) return openHandler(args);
  if (process.platform === "darwin") { // node-pty 1.1.0 ships its Mac helper without the right to run.
    try {
      fs.chmodSync(path.join(path.dirname(createRequire(import.meta.url).resolve("node-pty")), "..", "prebuilds", `darwin-${process.arch}`, "spawn-helper"), 0o755);
    } catch {} // An install you cannot change: if node-pty then cannot start a terminal, you get one pi below.
  }
  const rooms = new Map(); // name -> {term, busy, id}, and for Claude Code what leavesClaude keeps
  const piModes = new Set(); // Bracketed paste and modified keys, as pi set them, which Claude Code turns off as it leaves.
  let shown, started = 0, seen = 0; // Rooms started, and those that ended in sight.
  const secret = crypto.randomBytes(16).toString("hex");
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.end();
    if (req.url !== `/${secret}`) return;
    try {
      const { room, busy, open, args, cwd, claude, handler, id } = JSON.parse(body);
      // The conversation a room has open, so that it is shown, not opened in a second room, when you ask for it by its id.
      if (typeof id === "string") {
        if (rooms.has(room)) rooms.get(room).id = id;
        return;
      }
      if (rooms.has(room)) rooms.get(room).busy = busy === true;
      if (typeof open === "string") {
        const name = [...rooms.keys()].find((each) => rooms.get(each).id === open) ?? open;
        if (!rooms.has(name) && Array.isArray(args)) start(name, args, cwd, claude === true, handler === true);
        show(name);
      } else if (!busy && room !== shown && room !== HANDLER) close(room); // Its work is done, out of sight.
    } catch {} // A request this process cannot carry out changes nothing.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/${secret}`;
  // A room out of sight is a row short, so going back to it is a resize, after which pi draws it whole.
  const fit = () => rooms.forEach(({ term }, name) => term.resize(process.stdout.columns, Math.max(1, process.stdout.rows - (name === shown ? 0 : 1))));
  const close = (name) => {
    rooms.get(name)?.term.kill();
    rooms.delete(name);
  };
  const quit = (code) => {
    [...rooms.keys()].forEach(close);
    // Each pi set the terminal's keyboard mode as it started, and only the rooms that ended in sight set it back.
    process.stdout.write(`${started > seen ? `\x1b[<${started - seen}u` : ""}\x1b[?2004l\x1b[>4;0m\x1b[?25h`, () => process.exit(code));
  };
  function show(name) {
    if (name === shown || !rooms.has(name)) return;
    const left = shown;
    shown = name;
    if (left !== HANDLER && rooms.get(left)?.busy === false) close(left); // What it did is in its session.
    if (left) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    fit();
  }
  /**
   * A room running pi with `args`, with your handler's extensions in a conversation with your handler, or, for a bot in
   * Claude Code, Claude Code, which is yours while its room is open.
   */
  function start(name, args, cwd, claude, handler) {
    if (claude && !claim(name, OPEN)) return; // A handoff has just taken it.
    let term;
    try {
      term = pty.spawn(claude ? CLAUDE : process.execPath, claude ? args : [PI, ...(handler ? HANDLER_LOADS : LOADS), ...args], {
        name: process.env.TERM || "xterm-256color", cols: process.stdout.columns, rows: process.stdout.rows, cwd,
        env: { ...process.env, BOTMODE_ROOMS: url, BOTMODE_ROOM: name },
      });
    } catch (error) {
      if (claude) release(name);
      throw error;
    }
    started++;
    const room = { term, busy: false, claude, blank: true, line: "" };
    rooms.set(name, room);
    term.onData((data) => {
      if (!claude) for (const mode of data.match(/\x1b\[(?:\?2004h|>4;2m)/g) ?? []) piModes.add(mode);
      if (name === shown) process.stdout.write(data);
    });
    term.onExit(({ exitCode }) => {
      if (claude) release(name);
      if (rooms.get(name)?.term !== term) return; // Closed by this process.
      rooms.delete(name);
      if (name === shown) seen++;
      if (name === HANDLER) quit(exitCode);
      else if (name === shown) {
        show(HANDLER);
        if (claude) process.stdout.write([...piModes].join(""));
        if (room.lobby) rooms.get(HANDLER)?.term.write("\x1b[D"); // Your handler's ← opens the lobby.
      }
    });
  }
  try {
    start(HANDLER, args, process.cwd(), false, true);
  } catch {
    server.close();
    return openHandler(args);
  }
  show(HANDLER);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  // pi suspends itself on Ctrl+Z, which in a room would only freeze it, out of your shell's reach.
  process.stdin.on("data", (data) => {
    const room = rooms.get(shown);
    if (room?.claude && leavesClaude(room, data)) {
      room.lobby = true;
      return room.term.write("\x04\x04"); // Claude Code leaves as on Ctrl+D, and sets your terminal back as it goes.
    }
    if (data !== "\x1a" || process.platform === "win32") room?.term.write(data);
  });
  if (process.platform === "win32") { // As pi does, so that keys such as Shift+Tab reach a room whole.
    const tui = await import(pathToFileURL(createRequire(PI).resolve("@earendil-works/pi-tui")).href).catch(() => undefined);
    tui?.getNativeClipboard()?.enableVirtualTerminalInput?.();
  }
  process.stdout.on("resize", fit);
}

const commands = { setup, invite, status, teardown, update, restart, host: (port) => serve(Number(port) || PORT), help: () => say(HELP) };
const [command, ...rest] = process.argv.slice(2);
if (!Object.hasOwn(commands, command)) await openWindow(handlerArgs(process.argv.slice(2)));
else {
  try {
    await commands[command](...rest);
  } catch (error) {
    console.error(reason(error));
    process.exitCode = 1;
  } finally {
    terminal?.close();
  }
}
