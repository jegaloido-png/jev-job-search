// Saves the text of a URL opened in the runner's Chrome (port 9333) to a file, then closes the tab.
import fs from "node:fs";
const [url, out] = process.argv.slice(2);
const t = await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(url), { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
await new Promise((r) => setTimeout(r, 5000));
const r = await send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true });
fs.writeFileSync(out, r.result.value);
await send("Page.close");
process.exit(0);
