// Types key by key into a box on a runner tab and prints a JS expression after: node data/try-keys.mjs <match> <selector> <text> <expr>
const [want, sel, words, expr] = process.argv.slice(2);
const t = (await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json())).find((x) => x.type === "page" && x.url.includes(want));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.value;
await send("Page.bringToFront");
await ev(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.focus(); i.select(); })()`);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
for (const ch of words) { await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }); }
await new Promise((r) => setTimeout(r, 2500));
console.log(await ev(expr));
ws.close();
