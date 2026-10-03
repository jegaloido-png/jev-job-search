// Watches the runner's Chrome (port 9333) from outside: screenshots every page tab
// each second and writes its last frame when the tab closes (the page after Submit),
// plus every frame whose URL or title reads as a confirmation.
import { writeFileSync, mkdirSync } from "node:fs";
const OUT = "C:/Users/corna/Desktop/jev-job-search/data/screens-it";
mkdirSync(OUT, { recursive: true });
const ver = await (await fetch("http://127.0.0.1:9333/json/version")).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  setTimeout(() => { if (pending.delete(i)) rej(new Error("timeout " + method)); }, 4000);
});
const tabs = new Map(); // targetId -> { sessionId, url, title, last }
const stamp = () => new Date().toISOString().slice(11, 19).replace(/:/g, "");
const slug = (u) => { try { const x = new URL(u); return (x.host + x.pathname).replace(/[^a-z0-9]+/gi, "_").slice(0, 80); } catch { return "page"; } };
const save = (t, tag) => { if (!t.last) return; const f = `${OUT}/${stamp()}_${tag}_${slug(t.url)}.png`; writeFileSync(f, Buffer.from(t.last, "base64")); console.log("saved", f, "|", t.title); };
ws.onmessage = async (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
  if (m.method === "Target.targetCreated" || m.method === "Target.targetInfoChanged") {
    const info = m.params.targetInfo; if (info.type !== "page") return;
    let t = tabs.get(info.targetId);
    if (!t) { t = { url: info.url, title: info.title }; tabs.set(info.targetId, t);
      try { t.sessionId = (await send("Target.attachToTarget", { targetId: info.targetId, flatten: true })).sessionId; } catch {} }
    t.url = info.url; t.title = info.title;
  }
  if (m.method === "Target.targetDestroyed") { const t = tabs.get(m.params.targetId); if (t) { save(t, "closed"); tabs.delete(m.params.targetId); } }
};
await new Promise((r) => (ws.onopen = r));
await send("Target.setDiscoverTargets", { discover: true });
const CONF = /confirm|thank|success|submitted|received|grazie/i;
setInterval(async () => {
  for (const t of tabs.values()) {
    if (!t.sessionId || t.busy) continue; t.busy = true;
    try {
      const r = await send("Page.captureScreenshot", { format: "png" }, t.sessionId); t.last = r.data;
      const sig = t.url + "|" + t.title;
      if (CONF.test(sig) && t.savedSig !== sig) { t.savedSig = sig; save(t, "confirm"); }
    } catch {} finally { t.busy = false; }
  }
}, 1000);
ws.onclose = () => { for (const t of tabs.values()) save(t, "end"); process.exit(0); };
console.log("watching");
