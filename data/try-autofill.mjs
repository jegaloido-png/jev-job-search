// Opens a URL in the runner's Chrome (port 9333), gives a file to the file box the selector names (pageHelpers q), waits,
// and prints the page text so it shows what the board filled in from the file. Leaves the tab open with --keep.
import fs from "node:fs";
const [url, sel, file] = process.argv.slice(2);
const t = await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(url), { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 600) : r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(6000);
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
const g = await send("Runtime.evaluate", { expression: `window.__awj.q(${JSON.stringify(sel)})` });
await send("DOM.setFileInputFiles", { objectId: g.result.objectId, files: [file] });
for (const ms of [4000, 6000]) { await sleep(ms); }
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
console.log(await ev("window.__awj.pageText().slice(0, 2500)"));
if (!process.argv.includes("--keep")) await send("Page.close");
process.exit(0);
