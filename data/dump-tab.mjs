// Runs dumpFields.js in the first open page of the CDP Chrome and prints the fields.
import fs from "node:fs";
const tabs = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const t = tabs.find((x) => x.type === "page" && x.url.includes(process.argv[2] || "http"));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m); } }); ws.send(JSON.stringify({ id: my, method, params })); });
await send("Runtime.evaluate", { expression: fs.readFileSync("src/forms/pageHelpers.js", "utf8") });
const r = await send("Runtime.evaluate", { expression: fs.readFileSync("src/forms/dumpFields.js", "utf8"), returnByValue: true });
const d = JSON.parse(r.result.result.value);
for (const f of d.fields) console.log(f.kind, f.widget, f.required ? "*" : " ", JSON.stringify(f.label).slice(0, 60), JSON.stringify(f.value).slice(0, 40), f.selector.slice(0, 60));
ws.close();
