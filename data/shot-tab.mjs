// Saves a screenshot of an open tab of the runner's Chrome (port 9333) whose URL contains the given text. Optional: scroll the given selector (pageHelpers q) into view first.
import fs from "node:fs";
const [want, out, sel] = process.argv.slice(2);
const tabs = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const t = tabs.find((x) => x.type === "page" && x.url.includes(want));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
if (sel) await send("Runtime.evaluate", { expression: `window.__awj && window.__awj.q(${JSON.stringify(sel)}).scrollIntoView({block:'center'})` });
const r = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(out, Buffer.from(r.data, "base64"));
process.exit(0);
