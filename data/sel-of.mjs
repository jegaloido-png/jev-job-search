// Prints the full selector the dump gives the fields whose label matches: node data/sel-of.mjs <match> <label-regex>
import fs from "node:fs";
const [want, re] = process.argv.slice(2);
const t = (await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json())).find((v) => v.type === "page" && v.url.includes(want));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.value;
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
const d = JSON.parse(await ev(fs.readFileSync("src/forms/dumpFields.js", "utf8")));
for (const f of d.fields) if (new RegExp(re, "i").test(f.label)) console.log(f.selector, "| found:", await ev(`!!window.__awj.q(${JSON.stringify(f.selector)})`));
ws.close();
