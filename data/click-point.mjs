// In an open tab (port 9333) whose URL contains the given text: evaluates a pageHelpers expression that returns a point, clicks it like a person, waits, and prints the page's error texts.
import fs from "node:fs";
const [want, expr] = process.argv.slice(2);
const tabs = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const t = tabs.find((x) => x.type === "page" && x.url.includes(want));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 600) : r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
const p = await ev(expr);
console.log("point", JSON.stringify(p));
if (p && p.ok) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }); await sleep(80);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 }); await sleep(60);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
}
await sleep(1500);
console.log("errors", JSON.stringify(await ev("window.__awj.errors()")));
process.exit(0);
