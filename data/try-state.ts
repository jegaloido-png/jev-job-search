// Asks JEV the page state of a saved page text, plain and with an after-Submit note. Usage: npx tsx data/try-state.ts <textfile> <url> '<signals json>' <controlsBefore> <controlsNow>
import fs from "node:fs";
import { loadEnv } from "../src/config.js";
import { JevClient } from "../src/jev/client.js";
import { afterSubmitNote, decidePageState } from "../src/forms/pageState.js";
loadEnv();
const [file, url, signals, before, now] = process.argv.slice(2);
const text = fs.readFileSync(file, "utf8");
const jev = new JevClient();
const a = await decidePageState(jev, text, url);
console.log("plain:", a.state, a.confidence.toFixed(2));
const after = { signals: JSON.parse(signals || "[]"), controlsBefore: Number(before || 0), controlsNow: Number(now || 0) };
console.log("note:", afterSubmitNote(after));
const b = await decidePageState(jev, text, url, "", after);
console.log("with note:", b.state, b.confidence.toFixed(2), JSON.stringify(b.probabilities));
