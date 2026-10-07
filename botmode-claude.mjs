// How a bot in Claude Code works with the team; botmode.mjs starts Claude Code with it. `mcp <session>` serves the team's
// handoff and message tools over stdio, `mail <session>` is the PostToolUse hook that hands the bot the messages that came
// for it, and `status <session>` is its status line when you talk with it in a room of your window.
import readline from "node:readline";
import { HANDOFF, MESSAGE, botOf, handOffAndWait, loadConfig, mailFor, sendMessage } from "./botmode.mjs";

const [mode, session] = process.argv.slice(2);

// As a bot in pi has them while it works: a handoff waits for the reply, and message can wait for the answer.
const tools = {
  handoff: (params, signal) => handOffAndWait(loadConfig(), botOf(session), params, signal, () => {}),
  message: (params, signal) => sendMessage(loadConfig(), session, params, signal),
};

if (mode === "mail") {
  for await (const _ of process.stdin); // What Claude Code says about the step, which the messages do not depend on.
  const text = mailFor(session);
  if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
} else if (mode === "status") {
  console.log(`${session} · /exit goes back to your handler`);
} else if (mode === "mcp") {
  const calls = new Map(); // The id of each tool call under way -> what stops it.
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = request;
    if (method === "notifications/cancelled") return calls.get(params?.requestId)?.abort(); // Esc in Claude Code.
    if (id === undefined) return; // Other notifications ask nothing of this server.
    if (method === "initialize") {
      return send({ id, result: { protocolVersion: params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "botmode", version: "1" } } });
    }
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") {
      return send({ id, result: { tools: [HANDOFF, MESSAGE].map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters })) } });
    }
    if (method !== "tools/call" || !Object.hasOwn(tools, params?.name)) return send({ id, error: { code: -32601, message: `botmode has no ${params?.name ?? method}` } });
    const stop = new AbortController();
    calls.set(id, stop);
    try {
      send({ id, result: { content: [{ type: "text", text: await tools[params.name](params.arguments ?? {}, stop.signal) }] } });
    } catch (error) {
      send({ id, result: { content: [{ type: "text", text: error.message }], isError: true } });
    } finally {
      calls.delete(id);
    }
  }).on("close", () => process.exit()); // Claude Code is gone, and with this process go the bots it started for it.
}
