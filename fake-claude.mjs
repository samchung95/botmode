// Stands in for Claude Code in Botmode's tests: one `-p --output-format stream-json` run that keeps its conversations the
// way Claude Code does, finding one only from the folder it started in. It replies "<session> heard: <every prompt in the
// conversation>", adding how it runs when the prompt says "how". "use <tool> <json>" calls that tool through the MCP server
// it was given; "slow" first works a while. After each step its PostToolUse hook runs, and what that adds it heard too.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const prompt = args.at(-1);
const settings = JSON.parse(flag("--settings"));
const server = JSON.parse(flag("--mcp-config")).mcpServers.botmode;
const session = server.args.at(-1); // The botmode session it works for.
const dir = path.join(process.env.BOTMODE_HOME, "claude");
const fileOf = (id) => path.join(dir, `${id}.jsonl`);
const lines = (id) => fs.readFileSync(fileOf(id), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const fail = (text) => {
  console.error(text);
  process.exit(1);
};
const [resumed, id] = [flag("--resume"), flag("--session-id") ?? flag("--resume")];
if (resumed && !(fs.existsSync(fileOf(resumed)) && lines(resumed)[0].cwd === process.cwd())) fail(`No conversation found with session ID: ${resumed}`);
if (flag("--session-id") && fs.existsSync(fileOf(id))) fail(`Error: Session ID ${id} is already in use.`);
fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(fileOf(id))) {
  fs.writeFileSync(fileOf(id), [{ cwd: process.cwd() }, ...(resumed ? lines(resumed).slice(1) : [])].map((line) => `${JSON.stringify(line)}\n`).join(""));
}
const hear = (text) => fs.appendFileSync(fileOf(id), `${JSON.stringify({ text })}\n`);
const emit = (event) => console.log(JSON.stringify({ ...event, session_id: id }));
hear(prompt);
emit({ type: "system", subtype: "init" });

/** Calls `tool` on the MCP server, as Claude Code does. */
async function use(tool, input) {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
  const answers = readline.createInterface({ input: child.stdout });
  const ask = (id, method, params) => new Promise((resolve) => {
    answers.on("line", (line) => JSON.parse(line).id === id && resolve(JSON.parse(line)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } });
  const { result } = await ask(2, "tools/call", { name: tool, arguments: input });
  child.stdin.end();
  return result.content[0].text;
}

/** One step: a tool call, after which the hook hands over the messages that came. */
async function step(tool, input, run) {
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: tool, input }] } });
  const output = await run();
  const hook = spawnSync(settings.hooks.PostToolUse[0].hooks[0].command, { shell: true, encoding: "utf-8",
    input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: input }) });
  const added = hook.stdout.trim() && JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
  if (added) hear(added);
  return output;
}

const used = prompt.match(/^use (\w+) (\{.*\})$/m);
const output = used ? await step(`mcp__botmode__${used[1]}`, JSON.parse(used[2]), () => use(used[1], JSON.parse(used[2]))) : "";
if (prompt.includes("slow")) await step("Bash", { command: "sleep 2" }, () => new Promise((resolve) => setTimeout(resolve, 2000)));
// As in Claude Code, which reads leftArrowOpensAgents only from the owner's own config, where it is on unless they turned it off.
const how = prompt.includes("how") ? ` · ${flag("--model") ?? "default model"}, ${flag("--permission-mode")}, ← ${settings.disableAgentView ? "edits" : "opens agents"}, ` +
  `as "${flag("--append-system-prompt").split("\n")[0]}"` : "";
const text = `${session} heard: ${lines(id).slice(1).map((line) => line.text).join(" | ")}${how}${output && ` · ${output}`}`;
emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
emit({ type: "result", subtype: "success", is_error: false, result: text });
