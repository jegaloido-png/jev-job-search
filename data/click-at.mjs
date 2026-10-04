// Clicks a point on a runner tab like a person: node data/click-at.mjs <match> <x> <y>
const [want, x, y] = process.argv.slice(2);
const t = (await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json())).find((v) => v.type === "page" && v.url.includes(want));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
await send("Page.bringToFront");
for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: Number(x), y: Number(y), button: "left", clickCount: 1 });
ws.close();
