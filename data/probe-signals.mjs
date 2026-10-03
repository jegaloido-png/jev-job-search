// Opens a URL in the runner's Chrome (port 9333), installs the page helpers and prints successSignals() and shownControls(). Closes the tab.
import fs from "node:fs";
const url = process.argv[2];
const t = await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(url), { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 400) : r.result.value; };
await new Promise((r) => setTimeout(r, 5000));
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
console.log("signals", JSON.stringify(await ev("window.__awj.successSignals()")));
console.log("controls", await ev("window.__awj.shownControls()"));
await send("Page.close");
process.exit(0);
