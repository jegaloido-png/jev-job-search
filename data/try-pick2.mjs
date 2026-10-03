// Attaches to an open tab (port 9333) whose URL contains the given text, opens the dropdown with the given selector,
// reports what lies under the option's point (through shadow roots), then tries the keyboard: types words, ArrowDown, Enter.
import fs from "node:fs";
const [want, sel, optRe, typed] = process.argv.slice(2);
const tabs = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const t = tabs.find((x) => x.type === "page" && x.url.includes(want));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 600) : r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (p) => { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 }); };
const key = async (k, code) => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }); };
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
const S = JSON.stringify(sel);
await click(await ev(`window.__awj.point(${S})`));
await sleep(800);
const opts = await ev(`window.__awj.options(${S})`);
const label = opts.find((o) => new RegExp(optRe, "i").test(o));
const p = await ev(`window.__awj.optionPoint(${S}, ${JSON.stringify(label)})`);
console.log("under point", await ev(`(() => { let e = document.elementFromPoint(${p.x}, ${p.y}); const chain = []; while (e) { chain.push(e.tagName + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '')); if (e.shadowRoot) { const d = e.shadowRoot.elementFromPoint(${p.x}, ${p.y}); if (d && d !== e) { e = d; continue; } } break; } return chain.join(' > '); })()`));
if (typed) {
  await send("Input.insertText", { text: typed });
  await sleep(1200);
  console.log("options after typing", JSON.stringify(await ev(`window.__awj.options(${S})`)));
  await key("ArrowDown", 40); await sleep(300); await key("Enter", 13); await sleep(1000);
  console.log("tags", await ev(`(() => { const e = window.__awj.q(${S}); const tl = e.closest('spl-tags-list') || e.getRootNode().querySelector('spl-tags-list'); return tl ? (tl.shadowRoot ? tl.shadowRoot.textContent : '') .replace(/\s+/g, ' ').slice(0, 300) + ' || light: ' + tl.textContent.replace(/\s+/g, ' ').slice(0, 200) : 'no tags list'; })()`));
}
process.exit(0);
