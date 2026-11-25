// A stand-in for the studio backend, driven by its arguments:
//   node fake-backend.mjs <mode> <state directory>
// It writes its pid to `<state directory>/pids`, one line per run, and counts its runs there. It
// appends the first line of its stdin, the launch document, to `<state directory>/launches`, and
// takes that line as the run's bootstrap credential. Once ready it serves `POST /api/session` on
// 127.0.0.1: the run's bootstrap, once, buys the bearer `bearer-<run>`, counted from 0. It appends
// its address to `<state directory>/urls`.
// Modes:
//   ready             print a log line, then the readiness document, and exit 130 on SIGTERM
//   stubborn          as ready, but ignore SIGTERM, so only SIGKILL stops it
//   fail-twice        exit 1 before readiness on the first two runs, then behave as ready
//   exit-after-ready  on the first run, exit 0 once it answered the bearer exchange; then as ready
//   drop-exchange     on the first run, spend the bootstrap and drop the connection unanswered,
//                     as a response lost on the way would; then behave as ready
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";

const [mode, state] = process.argv.slice(2);
const pids = path.join(state, "pids");
let runs = 0;
try {
  runs = readFileSync(pids, "utf8").split("\n").filter(Boolean).length;
} catch {}
appendFileSync(pids, `${process.pid}\n`);
let bootstrap = "";
for await (const line of createInterface({ input: process.stdin })) {
  appendFileSync(path.join(state, "launches"), `${line}\n`);
  bootstrap = line;
  break;
}

if (mode === "fail-twice" && runs < 2) {
  process.stderr.write("fake backend: failing this run\n");
  process.exit(1);
}
process.on("SIGTERM", () => {
  if (mode !== "stubborn") process.exit(130);
});

let spent = false;
// The listening server keeps the process up until a signal stops it, as the real backend does.
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const presented = /"bootstrap":"([^"]*)"/.exec(body)?.[1];
    if (request.method !== "POST" || request.url !== "/api/session" || spent || presented !== bootstrap) {
      response.writeHead(401).end();
      return;
    }
    spent = true;
    if (mode === "drop-exchange" && runs === 0) {
      request.socket.destroy();
      return;
    }
    if (mode === "exit-after-ready" && runs === 0) {
      response.on("finish", () => process.exit(0));
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ bearer: `bearer-${runs}` }));
  });
});
server.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  appendFileSync(path.join(state, "urls"), `${url}\n`);
  process.stdout.write("fake backend: a log line that is not JSON\n");
  process.stdout.write(`${JSON.stringify({ _tag: "StudioReady", url })}\n`);
});
