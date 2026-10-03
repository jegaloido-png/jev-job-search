// In an open tab (port 9333) whose URL contains the given text: clicks the box the selector names (pageHelpers q),
// selects all, types the text, presses Escape, clicks elsewhere, and prints what the box and its host then hold.
import fs from "node:fs";
const [want, sel, text] = process.argv.slice(2);
const tabs = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const t = tabs.find((x) => x.type === "page" && x.url.includes(want));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 600) : r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = async (k, code) => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }); };
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
const S = JSON.stringify(sel);
const p = await ev(`window.__awj.point(${S})`);
for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
await sleep(400);
await ev("window.__awj.selectAll()"); await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
for (const ch of text) { await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }); }
await sleep(400);
if (!process.argv.includes("--no-enter")) await key("Enter", 13);
await sleep(400);
await key("Escape", 27);
await sleep(600);
console.log(await ev(`(() => { const e = window.__awj.q(${S}); let h = e.getRootNode().host; while (h && !/DATE/.test(h.tagName) && h.getRootNode().host) h = h.getRootNode().host; return 'input=' + JSON.stringify(e.value) + ' host=' + (h ? h.tagName + ' value=' + JSON.stringify(h.value) + ' attr=' + h.getAttribute('value') : '-') + ' invalid=' + e.getAttribute('aria-invalid'); })()`));
process.exit(0);
