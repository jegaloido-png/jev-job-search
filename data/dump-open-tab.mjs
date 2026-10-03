// Attaches to an open tab of the runner's Chrome (port 9333) whose URL contains the given text, installs the page
// helpers and prints the form reader's fields (kind, required, value, label). Changes nothing on the page.
import fs from "node:fs";
const want = process.argv[2];
const tabs = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const t = tabs.find((x) => x.type === "page" && x.url.includes(want));
if (!t) { console.log("no tab"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 600) : r.result.value; };
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
const raw = await ev(fs.readFileSync("src/forms/dumpFields.js", "utf8"));
if (String(raw).startsWith("EXC")) { console.log(raw); process.exit(1); }
const d = JSON.parse(raw);
for (const f of d.fields) console.log(`${f.kind}${f.required ? "*" : ""} value=${JSON.stringify(f.value).slice(0, 30)} "${f.label.replace(/\s+/g, " ").slice(0, 110)}" opts=${f.options.length}${process.argv.includes("--sel") ? " SEL " + f.selector : ""}`);
console.log("submit:", d.submitSelectors.map((s) => s.split("/*")[1]).join(" | "));
process.exit(0);
