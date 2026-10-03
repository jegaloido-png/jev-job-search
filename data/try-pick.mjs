// Attaches to an open tab of the runner's Chrome (port 9333) whose URL contains the given text, opens the dropdown
// with the given selector by a real click, lists its options, clicks the one matching the given words and reports what
// the control then shows. Usage: node data/try-pick.mjs <tab text> <selector> <option regex>
import fs from "node:fs";
const [want, sel, optRe] = process.argv.slice(2);
const tabs = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const t = tabs.find((x) => x.type === "page" && x.url.includes(want));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 600) : r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (p) => { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 }); };
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
const S = JSON.stringify(sel);
await click(await ev(`window.__awj.point(${S})`));
await sleep(1000);
const opts = await ev(`window.__awj.options(${S})`);
console.log("options", JSON.stringify(opts));
const label = opts.find((o) => new RegExp(optRe, "i").test(o));
console.log("picking", label);
const p = await ev(`window.__awj.optionPoint(${S}, ${JSON.stringify(label)})`);
console.log("point", JSON.stringify(p));
await click(p);
await sleep(1000);
console.log("shown", JSON.stringify(await ev(`window.__awj.shown(${S})`)));
process.exit(0);
