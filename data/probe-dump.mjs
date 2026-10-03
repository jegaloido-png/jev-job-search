// Opens a URL in the runner's Chrome (port 9333), installs the page helpers, runs the form reader and prints each field
// (kind, required, label, selector, whether q() finds it again), the Submit candidates and the start of the page text. Closes the tab.
import fs from "node:fs";
const url = process.argv[2];
const t = await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(url), { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 600) : r.result.value; };
await new Promise((r) => setTimeout(r, Number(process.argv[3] || 6000)));
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
const raw = await ev(fs.readFileSync("src/forms/dumpFields.js", "utf8"));
if (String(raw).startsWith("EXC")) { console.log(raw); process.exit(1); }
const d = JSON.parse(raw);
for (const f of d.fields) console.log(`${f.kind}${f.required ? "*" : ""} [${f.widget}] "${f.label.slice(0, 60)}" ${f.selector.slice(0, 110)} found=${await ev(`!!window.__awj.q(${JSON.stringify(f.selector)})`)} accept=${f.accept.slice(0, 30)}`);
console.log("submit:", d.submitSelectors.join(" || ").slice(0, 300));
console.log("frames:", d.frames, "password:", d.hasPassword);
const pt = await ev("window.__awj.pageText()");
console.log("TEXT", pt.length, JSON.stringify(pt.slice(0, 700)));
await send("Page.close");
process.exit(0);
