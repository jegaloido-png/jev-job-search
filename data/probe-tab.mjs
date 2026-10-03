// Opens a URL in the CDP Chrome, declines cookies, presses Apply, and dumps the fields at a few moments.
import fs from "node:fs";
const url = process.argv[2];
const t = await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(url), { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send("Page.setInterceptFileChooserDialog", { enabled: true });
await sleep(4000);
const helpers = fs.readFileSync("src/forms/pageHelpers.js", "utf8");
const dumpJs = fs.readFileSync("src/forms/dumpFields.js", "utf8");
const dump = async (tag) => { await ev(helpers); const d = JSON.parse(await ev(dumpJs)); console.log(tag, d.fields.map((f) => `${f.kind}:${f.label.slice(0, 25)}`).join(" | ")); };
const click = async (p) => { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 }); };
await dump("start");
await ev(helpers);
const dec = await ev(`window.__awj.clickByText(${JSON.stringify("^\s*(non accetto|rifiuta)\s*$")})`);
console.log("decline", JSON.stringify(dec));
if (dec.ok) { await click(dec); await sleep(1000); }
const ap = await ev(`window.__awj.clickByText(${JSON.stringify("^\s*candidati.{0,45}$")})`);
console.log("apply", JSON.stringify(ap));
if (ap.ok) await click(ap);
for (const ms of [300, 1000, 3000]) { await sleep(ms); await dump("after " + ms); }
console.log(await ev(`document.getElementById('vacancy__form')?.className`));
await send("Page.close");
