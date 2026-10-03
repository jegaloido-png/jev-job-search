/**
 * One posting by its link: the way to apply to a job the person found themselves. The posting is
 * read from its board's own API, rated like any other, and put in the queue at the top.
 */
import { JevClient } from "../jev/client.js";
import { ashbyJobId, ashbySlug, fetchAshbyBoard } from "../sources/ats/ashby.js";
import { fetchGreenhouseBoard, greenhouseJobId, greenhouseSlug } from "../sources/ats/greenhouse.js";
import { fetchLeverBoard, leverJobId, leverSlug } from "../sources/ats/lever.js";
import type { Profile } from "../profile/schema.js";
import { canonicalUrl, jobId, type Job } from "./normalize.js";
import { describe } from "./describe.js";
import { entryFor, loadQueue, saveQueue, type QueueEntry } from "./queue.js";
import { rateJob } from "./rate.js";

export const looksLikeUrl = (s: string) => /^https?:\/\//i.test(s);

/** The posting behind a link, from the board's API. Null when the board is not one the tool reads. */
export async function fetchPosting(url: string): Promise<Job | null> {
  const want = canonicalUrl(url);
  const pick = (jobs: Job[], id: string | null) => jobs.find((j) => j.url === want || j.id === jobId(want) || (id !== null && j.url.includes(id))) ?? null;
  const gh = greenhouseSlug(url);
  if (gh) return pick(await fetchGreenhouseBoard(gh, gh), greenhouseJobId(url));
  const lv = leverSlug(url);
  if (lv) return pick(await fetchLeverBoard(lv, lv), leverJobId(url));
  const ab = ashbySlug(url);
  if (ab) return pick(await fetchAshbyBoard(ab, ab), ashbyJobId(url));
  return null;
}

/** Reads, rates and queues one posting. Returns its queue entry, or throws with the reason it could not be read. */
export async function addJob(jev: JevClient, profile: Profile, url: string): Promise<QueueEntry> {
  const job = await fetchPosting(url);
  if (!job) throw new Error(`could not read a posting at ${url}. The tool reads Greenhouse, Lever and Ashby links; for another board, run discover and apply from the queue.`);
  const q = loadQueue();
  const previous = q.entries.find((e) => e.job.id === job.id);
  if (previous?.status === "applied") return previous;
  const fit = await rateJob(jev, job, profile);
  const entry = { ...entryFor(job, fit, null, previous), status: "queued" as const, statusReason: null };
  q.entries = [entry, ...q.entries.filter((e) => e.job.id !== job.id)];
  saveQueue(q);
  return entry;
}

/**
 * One posting from a batch line "tag|url|company|title|city", for any board. Greenhouse, Lever and
 * Ashby links are read and rated as above; any other board is queued from the line itself, with the
 * page text as its description and no rating.
 */
export async function addBatchJob(jev: JevClient, profile: Profile, line: string): Promise<QueueEntry> {
  const [, url = "", company = "", title = "", city = ""] = line.split("|").map((s) => s.trim());
  if (!looksLikeUrl(url)) throw new Error(`no link in batch line: ${line}`);
  try {
    if (await fetchPosting(url)) return await addJob(jev, profile, url);
  } catch {
    /* not a board the tool reads: queued from the line below */
  }
  const q = loadQueue();
  const id = jobId(url);
  const previous = q.entries.find((e) => e.job.id === id);
  if (previous?.status === "applied") return previous;
  const base: Job = { id, source: "batch", company, title, url: canonicalUrl(url), ats: "other", locations: [city ? `${city}, Italy` : "Italy"], postedAt: null, terms: [], sponsorship: "unknown", degrees: [], category: null };
  const job = await describe(base).catch(() => base);
  const entry = { ...entryFor(job, null, null, previous), status: "queued" as const, statusReason: null };
  q.entries = [entry, ...q.entries.filter((e) => e.job.id !== id)];
  saveQueue(q);
  return entry;
}
