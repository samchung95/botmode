// Stands in for pi in Botmode's tests: one `--mode json -p` run that keeps its session file the way pi does.
// It replies "<session id> heard: <every prompt in the session>", adds " in <its folder>" when the prompt says "where",
// and first waits a while when the prompt says "slow".
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const [dir, id, fork, prompt] = [flag("--session-dir"), flag("--session-id"), flag("--fork"), args.at(-1)];
const lines = (file) => fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
// Like pi with --session-dir, it finds a session only from the folder the session was started in.
const existing = fs.readdirSync(dir).find((name) => name.endsWith(`_${id}.jsonl`) && lines(path.join(dir, name))[0].cwd === process.cwd());
const file = path.join(dir, existing ?? `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
const header = JSON.stringify({ type: "session", cwd: process.cwd(), ...(fork && { parentSession: fork }) });
if (!existing) fs.writeFileSync(file, [header, ...(fork ? lines(fork).slice(1).map((entry) => JSON.stringify(entry)) : [])].join("\n") + "\n");
const say = (role, text) => fs.appendFileSync(file, `${JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } })}\n`);
say("user", prompt);
if (prompt.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 2000));
const heard = lines(file).filter((entry) => entry.message?.role === "user").map((entry) => entry.message.content[0].text);
const text = `${id} heard: ${heard.join(" | ")}${prompt.includes("where") ? ` in ${process.cwd()}` : ""}`;
say("assistant", text);
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }));
