// Attaches to an open tab (port 9333) whose URL contains the given text and logs every XHR/fetch response
// (status, URL, first bytes of the body) for the given number of seconds. Leaves the tab open.
const [want, secs] = process.argv.slice(2);
const tabs = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const t = tabs.find((x) => x.type === "page" && x.url.includes(want));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const my = ++id; pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); });
const reqs = new Map();
ws.onmessage = async (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); return; }
  if (m.method === "Network.responseReceived" && /XHR|Fetch|Document/.test(m.params.type)) reqs.set(m.params.requestId, `${m.params.response.status} ${m.params.type} ${m.params.response.url.slice(0, 140)}`);
  if (m.method === "Network.loadingFinished" && reqs.has(m.params.requestId)) {
    const b = await send("Network.getResponseBody", { requestId: m.params.requestId });
    console.log(reqs.get(m.params.requestId), "::", String(b?.body ?? "").replace(/\s+/g, " ").slice(0, 600));
  }
  if (m.method === "Runtime.consoleAPICalled") console.log("console", m.params.type, m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
};
await send("Network.enable");
await send("Runtime.enable");
console.log("watching");
await new Promise((r) => setTimeout(r, Number(secs || 40) * 1000));
process.exit(0);
