/**
 * Some sites take an application, show their thank-you page, and then mail a link that must be opened before the
 * application counts (Teamtailor for some companies: "Verify your email to complete the application"). After each
 * send, the person's COMPLETE_COMMAND watches the mailbox for such a mail from the job's own site, and its link is
 * opened in a tab of its own. The next job does not wait for it; the run waits for all of them before it ends.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { closeTab, newTab, sleep } from "./cdp.js";

const run = promisify(exec);
const pending = new Set<Promise<void>>();

/** Starts watching the mailbox for this send's completion link. The command may use {url}, {company} and {since}. */
export function completeByMail(job: { url: string; company: string }, since: Date): void {
  const command = process.env.COMPLETE_COMMAND;
  if (!command) return;
  const quote = (s: string) => `"${s.replace(/"/g, "")}"`;
  const cmd = command.replace(/\{url\}/g, quote(job.url)).replace(/\{company\}/g, quote(job.company)).replace(/\{since\}/g, since.toISOString());
  const p = (async () => {
    let link = "";
    try {
      const { stdout } = await run(cmd, { timeout: 240_000, windowsHide: true });
      for (const line of stdout.trim().split(/\r?\n/).reverse()) {
        try {
          const v = JSON.parse(line) as { link?: unknown };
          if (typeof v.link === "string" && v.link.trim()) link = v.link.trim();
          break;
        } catch {
          /* not the JSON line */
        }
      }
    } catch {
      return;
    }
    if (!link) return;
    // The site completes the application when the link is opened; the page it shows is its thank-you page again.
    const t = await newTab(link).catch(() => null);
    if (!t) return;
    await sleep(8_000);
    await closeTab(t.id);
    console.log(`  ${job.company}: the site mailed a link to complete the application; it was opened`);
  })().finally(() => pending.delete(p));
  pending.add(p);
}

/** Waits for every completion link still being watched for. */
export async function completionsDone(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
