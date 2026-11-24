// A stand-in for `fuse-deck dev --json`, driven by its arguments:
//   node fake-backend.mjs <mode> <state directory>
// It writes its pid to `<state directory>/pids`, one line per run, and counts its runs there.
// Modes:
//   ready           print a log line, then the readiness document, and exit 130 on SIGTERM
//   stubborn        as ready, but ignore SIGTERM, so only SIGKILL stops it
//   fail-twice      exit 1 before readiness on the first two runs, then behave as ready
//   exit-after-ready  print the readiness document and exit 0 on the first run, then as ready
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

const [mode, state] = process.argv.slice(2);
const pids = path.join(state, "pids");
let runs = 0;
try {
  runs = readFileSync(pids, "utf8").split("\n").filter(Boolean).length;
} catch {}
appendFileSync(pids, `${process.pid}\n`);

if (mode === "fail-twice" && runs < 2) {
  process.stderr.write("fake backend: failing this run\n");
  process.exit(1);
}
process.on("SIGTERM", () => {
  if (mode !== "stubborn") process.exit(130);
});
process.stdout.write("fake backend: a log line that is not JSON\n");
process.stdout.write(
  `${JSON.stringify({ _tag: "DevServerReady", url: `http://127.0.0.1:${4000 + runs}/` })}\n`
);
if (mode === "exit-after-ready" && runs === 0) {
  process.exit(0);
}
// A listening socket keeps the process up until a signal stops it, as the real dev server does.
createServer().listen(0, "127.0.0.1");
