// In an open tab (port 9333) whose URL contains the given text: puts a file on the n-th file input, waits, prints the values of all text boxes.
const [want, file, nth, wait] = process.argv.slice(2);
const tabs = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const t = tabs.find((x) => x.type === "page" && x.url.includes(want));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const vals = async () => (await send("Runtime.evaluate", { expression: "[...document.querySelectorAll('input[type=text],input[type=Text],input[type=email]')].map(e=>e.value).join(' | ')", returnByValue: true })).result.value;
console.log("before:", await vals());
const doc = await send("DOM.getDocument", { depth: -1 });
const q = await send("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: "input[type=file]" });
await send("DOM.setFileInputFiles", { nodeId: q.nodeIds[Number(nth || 0)], files: [file] });
for (let s = 0; s < Number(wait || 12); s += 2) { await new Promise((r) => setTimeout(r, 2000)); console.log(`${s + 2}s:`, await vals()); }
process.exit(0);
