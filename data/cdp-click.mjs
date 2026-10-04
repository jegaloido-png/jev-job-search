// node data/cdp-click.mjs <match> <x> <y> [type text] : a person's click at a point, then optional typing and Enter.
const [want, x, y, typed] = process.argv.slice(2);
const tabs = (await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json())).filter((t) => t.type === "page");
const t = tabs.find((x) => x.url.includes(want));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
await send("Page.bringToFront");
for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: +x, y: +y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
if (typed) {
  await new Promise((r) => setTimeout(r, 400));
  await send("Input.insertText", { text: typed });
  await new Promise((r) => setTimeout(r, 300));
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}
await new Promise((r) => setTimeout(r, 1500));
ws.close();
