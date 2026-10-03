// Reads the address and date boxes of the open Lifein tab.
const tabs = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const t = tabs.find((x) => x.type === "page" && x.url.includes(process.argv[2]));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const r = await new Promise((res) => { ws.onmessage = (ev) => res(JSON.parse(ev.data)); ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { returnByValue: true, expression: process.argv[3] } })); });
console.log(JSON.stringify(r.result.result.value, null, 1));
ws.close();
