// Opens a URL in the runner's Chrome (port 9333) and lists the visible buttons and links that match formRunner's
// APPLY_BUTTON, in the order clickByText sees them, and what clickByText picks. Closes the tab.
import fs from "node:fs";
const src = fs.readFileSync("src/browser/formRunner.ts", "utf8");
const pattern = eval(src.match(/const APPLY_BUTTON =([\s\S]*?);\n/)[1]);
const url = process.argv[2];
const t = await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(url), { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 600) : r.result.value; };
await new Promise((r) => setTimeout(r, 8000));
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
const list = (re) => {
  const out = [];
  for (const x of document.querySelectorAll("a, button, [role=button]")) {
    const w = (x.innerText || "").trim();
    if (!new RegExp(re, "i").test(w)) continue;
    const r = x.getBoundingClientRect();
    out.push(`${x.tagName} ${x.getAttribute("role") || ""} [${w.slice(0, 50)}] ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} href=${x.getAttribute("href") || ""}`);
  }
  out.push("PICK " + JSON.stringify(window.__awj.clickByText(re)));
  return out;
};
const res = await ev(`(${list.toString()})(${JSON.stringify(pattern)})`);
console.log(Array.isArray(res) ? res.join("\n") : res);
await fetch("http://127.0.0.1:9333/json/close/" + t.id);
ws.close();
