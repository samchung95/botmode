// Stands in for billion-context's proxy in Botmode's tests: `start --host <host> --port <port>` takes watchers as the proxy
// does, and stops once the process that started it, BILI_PARENT_PID, has.
import http from "node:http";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
http.createServer((req, res) => res.writeHead(req.method === "POST" && req.url === "/__bili/watcher" ? 200 : 404).end("{}"))
  .listen(Number(flag("--port")), flag("--host"));
setInterval(() => {
  try {
    process.kill(Number(process.env.BILI_PARENT_PID), 0);
  } catch {
    process.exit();
  }
}, 500);
