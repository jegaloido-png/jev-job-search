// Opens a job page in the runner's Chrome (9333), clicks the first link/button whose words match a pattern, waits, prints where it landed. Leaves the tab open.
const [url, pat, wait] = process.argv.slice(2);
const t = await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(url), { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 600) : r.result.value; };
const ms = Number(wait || 7000);
await new Promise((r) => setTimeout(r, ms));
console.log(await ev(`(() => { const re = new RegExp(${JSON.stringify(pat)}, "i"); const el = [...document.querySelectorAll("a,button")].find((e) => re.test((e.innerText||"").trim()) && e.getBoundingClientRect().width > 0); if (!el) return "none"; const out = el.tagName + " " + (el.innerText||"").trim() + " " + (el.getAttribute("href")||""); el.click(); return out; })()`));
await new Promise((r) => setTimeout(r, ms));
console.log(await ev(`location.href + "\npassword=" + !!document.querySelector("input[type=password]") + "\ninputs=" + [...document.querySelectorAll("input,select,textarea")].filter(e=>e.getBoundingClientRect().width>0).map(e=>e.type+":"+(e.name||e.id)).join(",") + "\n" + document.body.innerText.replace(/\s+/g," ").slice(0,900)`));
console.log("tab", t.id);
process.exit(0);
