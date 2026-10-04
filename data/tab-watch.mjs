// Watches the runner's Chrome (port 9333) while a queue runs: every 3 s, one line with the time, the number of open
// tabs and the host of each, written only when it changes. Shows a tab left open or a site the runner wandered to.
// Usage: node data/tab-watch.mjs <out-file>   (stop it with Ctrl+C or by killing the process)
import fs from "node:fs";
const out = process.argv[2] || "data/tab-watch.log";
let last = "";
for (;;) {
  let line;
  try {
    const tabs = (await fetch("http://127.0.0.1:9333/json/list", { signal: AbortSignal.timeout(2000) }).then((r) => r.json())).filter((t) => t.type === "page");
    line = `${tabs.length} ${tabs.map((t) => { try { return new URL(t.url).host || t.url.slice(0, 20); } catch { return t.url.slice(0, 20); } }).join(" ")}`;
  } catch {
    line = "no browser";
  }
  if (line !== last) fs.appendFileSync(out, `${new Date().toISOString().slice(11, 19)} ${line}\n`);
  last = line;
  await new Promise((r) => setTimeout(r, 3000));
}
