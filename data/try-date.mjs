// Clicks a shadow date box like the runner, types key by key, leaves it with the given key: node data/try-date.mjs <match> <selector> <text> <leaveKey>
import fs from "node:fs";
const [want, sel, words, leave] = process.argv.slice(2);
const t = (await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json())).find((x) => x.type === "page" && x.url.includes(want));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send("Page.bringToFront");
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
const p = await ev(`window.__awj.point(${JSON.stringify(sel)})`);
for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
await sleep(300);
console.log("focus", await ev(`window.__awj.hasFocus(${JSON.stringify(sel)})`));
await ev("window.__awj.selectAll()");
const key = async (k) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: { Backspace: 8, Tab: 9, Enter: 13, Escape: 27 }[k] }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: { Backspace: 8, Tab: 9, Enter: 13, Escape: 27 }[k] }); };
await key("Backspace");
for (const ch of words) { await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }); }
console.log("typed", await ev(`window.__awj.q(${JSON.stringify(sel)}).value`));
if (leave) await key(leave);
await sleep(800);
console.log("after", leave, await ev(`window.__awj.q(${JSON.stringify(sel)}).value`), await ev(`document.querySelector('ui5-date-picker-xweb-calendar-widget')?.getAttribute('value')`));
ws.close();
