/**
 * A resume and a cover letter written for one job, from the profile and the posting, by the
 * writer. Every line of them is checked against the profile before it is kept: a number the
 * profile does not hold, or a name of a tool or a place the profile never mentions, is a claim
 * the candidate did not make, and the document is refused. The method follows the drafter and
 * verifier workflow of MadsLorentzen/ai-job-search (MIT), redone here in code against the profile.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DOCUMENTS, PATHS, WRITER } from "../config.js";
import { candidateContext, contextFingerprint, runWriter } from "../answers/resolve.js";
import { jobContext } from "../answers/context.js";
import { loadQueue, type QueueEntry } from "../jobs/queue.js";
import type { Profile } from "../profile/schema.js";
import { hashOf } from "../util/cache.js";
import { coverHtml, prettyMonth, printPdf, resumeHtml } from "./render.js";

export const Tailored = z.object({
  /** One line under the name: the role the candidate is applying for, in the posting's words. */
  headline: z.string().min(3).max(120),
  /** Two or three sentences, written for this posting. */
  summary: z.string().min(40).max(900),
  /** The skills that matter for this posting, most relevant first, each one taken from the profile. A longer list is cut, not refused. */
  skills: z.array(z.preprocess((k) => (typeof k === "string" ? shortSkill(k) : k), z.string().min(1).max(60))).min(3).transform((a) => a.slice(0, DOCUMENTS.maxSkills)),
  /** The profile's jobs, with the bullets that matter for this posting, in the profile's own words. */
  experience: z.array(z.object({ company: z.string(), title: z.string(), bullets: z.array(z.string().min(10).max(400)).min(1).transform((b) => b.slice(0, DOCUMENTS.maxBullets)) })).min(1),
  projects: z.array(z.object({ name: z.string(), bullets: z.array(z.string().min(10).max(400)).min(1).transform((b) => b.slice(0, DOCUMENTS.maxBullets)) })).default([]),
  /** A writer may send null when no letter was asked: that is no letter, not a broken draft. A letter sent as
   *  one plain text is split into its greeting, paragraphs and closing rather than thrown away; paragraphs too short
   *  to stand alone are joined. A letter that still does not fit is no letter: the resume is kept, never lost with it. */
  coverLetter: z.preprocess((c) => (typeof c === "string" ? letterFromText(c) : isLetter(c) ? { ...c, paragraphs: paragraphsFrom(c.paragraphs) } : c), z.object({ greeting: z.string().max(80), paragraphs: z.array(z.string().min(40).max(1200)).min(1).transform((p) => p.slice(0, 5)), closing: z.string().max(80) }).nullish()).catch(undefined).transform((c) => c ?? undefined),
  /** The posting's keywords the resume now carries, and the ones the profile cannot support. */
  keywordsCovered: z.array(z.string()).default([]),
  keywordsMissing: z.array(z.string()).default([]),
});

/** A letter written as one text: a short first line ending in a comma is the greeting, a short last line the
 *  closing, the blocks between are the paragraphs (a block too short to stand alone joins the next one). */
function letterFromText(text: string): unknown {
  const blocks = text.split(/\n\s*\n|\r?\n/).map((b) => b.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (blocks.length === 0) return null;
  const first = blocks[0] ?? "";
  const greeting = blocks.length > 2 && first.length <= 80 && /[,:]$/.test(first) ? (blocks.shift() ?? "") : "";
  let closing = "";
  const lastLength = () => (blocks[blocks.length - 1] ?? "").length;
  while (blocks.length > 2 && lastLength() < 40 && closing.length + lastLength() < 80) closing = `${blocks.pop()} ${closing}`.trim();
  return { greeting, paragraphs: paragraphsFrom(blocks), closing };
}

const isLetter = (c: unknown): c is { paragraphs: unknown[] } => !!c && typeof c === "object" && Array.isArray((c as { paragraphs?: unknown }).paragraphs);

/** A skill written as a phrase longer than the box takes is cut at a word, not refused. */
function shortSkill(k: string): string {
  const t = k.replace(/\s+/g, " ").trim();
  if (t.length <= 60) return t;
  const cut = t.slice(0, 60);
  return (cut.lastIndexOf(" ") > 20 ? cut.slice(0, cut.lastIndexOf(" ")) : cut).replace(/[\s,;:(–-]+$/, "");
}

/** Blocks too short to stand alone join the next one; a single block is split in two at a sentence. */
function paragraphsFrom(blocks: unknown[]): string[] {
  const paragraphs: string[] = [];
  for (const b of blocks.filter((x): x is string => typeof x === "string").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    const last = paragraphs[paragraphs.length - 1];
    if (last !== undefined && last.length < 40) paragraphs[paragraphs.length - 1] = `${last} ${b}`;
    else paragraphs.push(b);
  }
  const only = paragraphs.length === 1 ? paragraphs[0] : undefined;
  if (only !== undefined) {
    const sentences = only.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [only];
    const half = Math.ceil(sentences.length / 2);
    const [one, two] = [sentences.slice(0, half).join("").trim(), sentences.slice(half).join("").trim()];
    if (one.length >= 40 && two.length >= 40) paragraphs.splice(0, 1, one, two);
  }
  return paragraphs;
}
export type Tailored = z.infer<typeof Tailored>;

export type Documents = { dir: string; resume: string; cover: string | null; coverText: string | null; json: string };

/** What this run wants: a resume written per job, and a cover letter wherever a form has a box for one. Off unless asked. */
let policy = { resume: false, cover: false };
export const documentPolicy = () => policy;
export const setDocumentPolicy = (p: { resume: boolean; cover: boolean }) => {
  policy = p;
};

const SYSTEM = [
  "You write a one-page resume and, when asked, a one-page cover letter for one candidate and one job posting. You are given the candidate's facts, experience, projects and skills, the voice rules, and the posting.",
  "Reply with one JSON object and nothing else: {\"headline\": string, \"summary\": string, \"skills\": [string], \"experience\": [{\"company\": string, \"title\": string, \"bullets\": [string]}], \"projects\": [{\"name\": string, \"bullets\": [string]}], \"coverLetter\": {\"greeting\": string, \"paragraphs\": [string], \"closing\": string} | omitted, \"keywordsCovered\": [string], \"keywordsMissing\": [string]}.",
  "",
  "Truth comes first.",
  "- Every company, title, project, date, number, tool, language, place and credential comes from the candidate's facts. Never add one. A keyword the posting wants and the candidate's facts do not support goes in keywordsMissing, never in the resume.",
  "- Bullets are the candidate's own bullets, kept whole or shortened. You may reorder them and pick the ones that matter for this posting. You may not add a number, a tool or an outcome that the bullet did not have.",
  "- Work authorization, citizenship, education and dates are exactly as given and are not mentioned unless the posting asks.",
  "",
  "What makes it tailored.",
  "- The headline names the role in the posting's words. The summary says in two or three sentences what the candidate has built and why it fits this posting.",
  "- Skills: only skills the facts hold, ordered by what the posting asks for first. Use the posting's spelling when the facts have the same thing.",
  "- Experience: every job from the facts, most recent first, with the bullets that speak to this posting. Projects: the ones that speak to it, with their bullets.",
  "- Cover letter, when asked: greeting, three or four paragraphs, closing. The closing is the sign-off words only (\"Sincerely,\" or \"Thank you for your time,\"); the name is printed under it by the page. Paragraph one names the role and one specific thing from the posting. The middle ties two or three concrete facts to what the posting asks for. The last says what the candidate wants to build there. It reads as the candidate typed it, follows the voice rules, and never claims to have done something the facts do not say. The company's own name and the posting's words are fine; nothing else that is not in the facts.",
  "- Plain words. No hype, no em dashes, no exclamation marks, no first-person in the resume bullets.",
  "- Language: the resume is in Italian, as the candidate's own resume is. The cover letter is in the posting's language: Italian for an Italian posting, English for an English one.",
].join("\n");

/** What the second pass is told to do with the first draft. It returns the same JSON shape, revised. */
const REVIEW_RULES = [
  "You are now the reviewer. Read the draft as the hiring manager for this posting would, then return the revised document in the same JSON shape.",
  "Cut every sentence that says nothing specific. Each bullet starts with a verb and carries one fact. No bullet repeats another.",
  "The summary leads with the one thing from the facts that best answers what this posting asks for, in plain words.",
  "Skills: the posting's words first, then the rest; nothing the facts do not hold.",
  "Cover letter: the first sentence names something specific about this posting or company, never 'I am applying for'. One paragraph ties two or three facts to the posting's own asks. The last paragraph says what the candidate wants to build there. Four paragraphs, each with something new.",
  "Keep every number and name exactly as in the facts. Add nothing. Remove any claim the facts do not support.",
];

/** The claims a draft makes that the profile does not hold: numbers, and capitalized names of tools, places and companies. */
export function unsupportedClaims(t: Tailored, profile: Profile, posting: string): string[] {
  const raw = JSON.stringify({ e: profile.experience, p: profile.projects, s: profile.skills, f: profile.facts, su: profile.summary, ed: profile.education, n: profile.name, l: profile.links, a: profile.address, b: profile.answers }).toLowerCase();
  // "18,000+" in the draft and "18,000" in the profile are the same number; "REST APIs" and "REST API" the same thing.
  const corpus = `${raw} ${raw.replace(/(\d),(?=\d{3})/g, "$1")}`;
  const postingCorpus = posting.toLowerCase();
  const plain = new Set<string>(DOCUMENTS.plainWords.map((w) => w.toLowerCase()));
  const known = (word: string, allowPosting: boolean) => {
    const forms = [word, word.replace(/s$/, ""), word.replace(/es$/, ""), `${word}s`];
    return forms.some((f) => f.length >= 2 && (corpus.includes(f) || (allowPosting && postingCorpus.includes(f))));
  };
  const bad = new Set<string>();
  const check = (text: string, allowPosting: boolean) => {
    for (const n of text.match(/\d[\d,.]*\s*(?:%|k\b|\+)?/g) ?? []) {
      const digits = n.replace(/[^\d]/g, "");
      if (digits.length >= 2 && !corpus.includes(digits) && !(allowPosting && postingCorpus.includes(digits))) bad.add(n.trim());
    }
    const sentences = text.split(/(?<=[.!?:;])\s+|\n+/);
    for (const s of sentences) {
      const words = s.split(/\s+/);
      words.forEach((raw, i) => {
        const w = raw.replace(/^[("'\[]+|[)"',.:;!?\]]+$/g, "");
        if (!/^[A-Z][A-Za-z0-9+#.-]{1,}$/.test(w) || i === 0 || plain.has(w.toLowerCase())) return;
        if (known(w.toLowerCase(), allowPosting)) return;
        bad.add(w);
      });
    }
  };
  check(t.headline, true);
  check(t.summary, true);
  // A skill is a phrase; it is the profile's when every word of it that carries meaning is.
  for (const s of t.skills) {
    const words = s.toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length >= 3 && !plain.has(w));
    if (!corpus.includes(s.toLowerCase()) && !(words.length && words.every((w) => known(w, false)))) bad.add(s);
  }
  for (const e of t.experience) {
    if (!profile.experience.some((x) => x.company.toLowerCase().includes(e.company.toLowerCase()) || e.company.toLowerCase().includes(x.company.toLowerCase()))) bad.add(`job at ${e.company}`);
    for (const b of e.bullets) check(b, false);
  }
  for (const p of t.projects) {
    if (!profile.projects.some((x) => x.name.toLowerCase().includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(x.name.toLowerCase()))) bad.add(`project ${p.name}`);
    for (const b of p.bullets) check(b, false);
  }
  if (t.coverLetter) for (const p of t.coverLetter.paragraphs) check(p, true);
  return [...bad];
}

/** A folder name a person can read: Company_Role_id, with anything that is not a letter or a digit folded to one underscore. */
const slug = (s: string) => s.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
export const documentsDir = (entry: Pick<QueueEntry, "job">) => path.join(PATHS.documents, `${slug(entry.job.company)}_${slug(entry.job.title)}_${entry.job.id}`);

/** The folder of a job's tailored documents, found by the job id at the end of its name. */
const findDir = (jobId: string): string | null => {
  if (!existsSync(PATHS.documents)) return null;
  const name = readdirSync(PATHS.documents).find((n) => n.endsWith(`_${jobId}`) || n === jobId);
  return name ? path.join(PATHS.documents, name) : null;
};

/** The tailored documents on disk for a job, when they were written for the current profile, or null. */
export function documentsFor(jobId: string, profile?: Profile): Documents | null {
  const dir = findDir(jobId);
  if (!dir) return null;
  const json = path.join(dir, "tailored.json");
  if (!existsSync(json)) return null;
  try {
    const saved = z.object({ fingerprint: z.string(), tailored: Tailored }).parse(JSON.parse(readFileSync(json, "utf8")));
    if (profile && saved.fingerprint !== tailorFingerprint(profile)) return null;
    const resume = path.join(dir, "resume.pdf");
    const cover = path.join(dir, "cover.pdf");
    if (!existsSync(resume)) return null;
    const letter = saved.tailored.coverLetter;
    return { dir, resume, cover: existsSync(cover) ? cover : null, coverText: letter ? [letter.greeting, ...letter.paragraphs, letter.closing].join("\n\n") : null, json };
  } catch {
    return null;
  }
}

const tailorFingerprint = (profile: Profile) => hashOf(`${contextFingerprint(profile)}|${SYSTEM}|${WRITER.model}`);

const parse = (text: string): Tailored => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the writer did not return JSON");
  const r = Tailored.safeParse(JSON.parse(text.slice(start, end + 1)));
  if (!r.success) throw new Error(`the draft is not in the expected shape: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 4).join("; ")}`);
  return r.data;
};

/**
 * Writes the documents for one job: asks the writer, checks every claim against the profile (once
 * more with the unsupported ones named, if the first draft had any), renders the PDFs, and keeps
 * them under documents/tailored/<Company>_<Role>_<job id>/. Existing documents for the same profile are reused unless fresh.
 */
const inflight = new Map<string, Promise<Documents & { tailored: Tailored; reused: boolean }>>();

/** One job's documents are written once at a time: a second call while the first is running joins it. */
/**
 * The resume a job's form may see. With tailoring on, only the one written for this job: the profile's own file is
 * never shown to a site, not even to read it into the form. A draft that fails is written once more from scratch; a
 * second failure is a reason not to apply, given back as text. With tailoring off, the profile's own file.
 */
export async function resumeFor(profile: Profile, jobId: string): Promise<{ resume: string } | { why: string }> {
  if (!policy.resume) return { resume: profile.resume.path };
  const have = documentsFor(jobId, profile);
  if (have) return { resume: have.resume };
  const entry = loadQueue().entries.find((e) => e.job.id === jobId);
  if (!entry) return { why: "the resume for this job could not be written: the job is not in the queue" };
  let last = "";
  for (const fresh of [false, true]) {
    try {
      return { resume: (await tailorJob(profile, entry, { cover: false, fresh })).resume };
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      console.log(`   the resume for this job was not written${fresh ? " again" : ""}: ${last}`);
    }
  }
  return { why: `the resume for this job could not be written: ${last.slice(0, 160)}` };
}

export function tailorJob(profile: Profile, entry: QueueEntry, opts: { cover: boolean; fresh?: boolean }): Promise<Documents & { tailored: Tailored; reused: boolean }> {
  const running = inflight.get(entry.job.id);
  if (running && !opts.fresh) return running;
  const p = tailorJobNow(profile, entry, opts).finally(() => inflight.delete(entry.job.id));
  inflight.set(entry.job.id, p);
  return p;
}

async function tailorJobNow(profile: Profile, entry: QueueEntry, opts: { cover: boolean; fresh?: boolean }): Promise<Documents & { tailored: Tailored; reused: boolean }> {
  const have = opts.fresh ? null : documentsFor(entry.job.id, profile);
  if (have && (!opts.cover || have.cover)) {
    const saved = JSON.parse(readFileSync(have.json, "utf8")) as { tailored: Tailored };
    return { ...have, tailored: saved.tailored, reused: true };
  }
  const system = `${SYSTEM}\n\nThe candidate:\n${JSON.stringify(candidateContext(profile), null, 1)}`;
  const job = jobContext(entry);
  const posting = `${entry.job.company} ${entry.job.title} ${entry.job.description ?? ""}`;
  let prompt = JSON.stringify({ job, write_cover_letter: opts.cover }, null, 1);
  let tailored = parse(await runWriter(prompt, system, { purpose: "tailor", jobId: entry.job.id }));
  if (DOCUMENTS.review) {
    // A second pass with fresh eyes, as a reviewer would read it: cuts filler, sharpens the opening, keeps every fact.
    const reviewed = JSON.stringify({ job, write_cover_letter: opts.cover, draft_to_review: tailored, review_rules: REVIEW_RULES }, null, 1);
    tailored = parse(await runWriter(reviewed, system, { purpose: "tailor", jobId: entry.job.id }));
  }
  let claims = unsupportedClaims(tailored, profile, posting);
  if (claims.length) {
    prompt = JSON.stringify({ job, write_cover_letter: opts.cover, remove_these_claims_the_facts_do_not_support: claims, previous_draft: tailored }, null, 1);
    tailored = parse(await runWriter(prompt, system, { purpose: "tailor", jobId: entry.job.id }));
    claims = unsupportedClaims(tailored, profile, posting);
    if (claims.length) throw new Error(`the draft still claims what the profile does not say: ${claims.slice(0, 8).join(", ")}`);
  }
  const dir = documentsDir(entry);
  mkdirSync(dir, { recursive: true });
  const resume = path.join(dir, "resume.pdf");
  // A resume over the page limit loses its last project bullets, then its last experience bullets, until it fits.
  let fitted = tailored;
  for (let round = 0; round < 8; round++) {
    const pages = await printPdf(resumeHtml(profile, fitted), resume);
    if (pages <= DOCUMENTS.resumePages) break;
    const trimmed = trimOnce(fitted);
    if (!trimmed) break;
    fitted = trimmed;
  }
  let cover: string | null = null;
  if (opts.cover && fitted.coverLetter) {
    cover = path.join(dir, "cover.pdf");
    await printPdf(coverHtml(profile, entry, fitted), cover);
  }
  writeFileSync(path.join(dir, "tailored.json"), JSON.stringify({ fingerprint: tailorFingerprint(profile), job: { id: entry.job.id, company: entry.job.company, title: entry.job.title, url: entry.job.url }, at: new Date().toISOString(), tailored: fitted }, null, 2));
  writeFileSync(path.join(dir, "resume.md"), resumeMarkdown(profile, fitted));
  const letter = fitted.coverLetter;
  return { dir, resume, cover, coverText: letter ? [letter.greeting, ...letter.paragraphs, letter.closing].join("\n\n") : null, json: path.join(dir, "tailored.json"), tailored: fitted, reused: false };
}

/** Drops one bullet: the last of the last project with more than one, else the last of the last job with more than one. */
export function trimOnce(t: Tailored): Tailored | null {
  for (let i = t.projects.length - 1; i >= 0; i--) {
    const p = t.projects[i];
    if (p && p.bullets.length > 1) return { ...t, projects: t.projects.map((x, j) => (j === i ? { ...x, bullets: x.bullets.slice(0, -1) } : x)) };
  }
  if (t.projects.length > 1) return { ...t, projects: t.projects.slice(0, -1) };
  for (let i = t.experience.length - 1; i >= 0; i--) {
    const e = t.experience[i];
    if (e && e.bullets.length > 1) return { ...t, experience: t.experience.map((x, j) => (j === i ? { ...x, bullets: x.bullets.slice(0, -1) } : x)) };
  }
  return null;
}

/** The resume as plain Markdown, next to the PDF, for reading and for pasting. */
export function resumeMarkdown(profile: Profile, t: Tailored): string {
  const lines = [`# ${profile.name.first} ${profile.name.last}`, t.headline, "", t.summary, "", `**Skills:** ${t.skills.join(", ")}`, "", "## Experience"];
  for (const e of t.experience) {
    const src = profile.experience.find((x) => x.company.toLowerCase().includes(e.company.toLowerCase()) || e.company.toLowerCase().includes(x.company.toLowerCase()));
    lines.push("", `**${e.title}**, ${e.company}${src ? ` (${prettyMonth(src.start)} to ${src.current ? "present" : prettyMonth(src.end)})` : ""}`);
    for (const b of e.bullets) lines.push(`- ${b}`);
  }
  if (t.projects.length) {
    lines.push("", "## Projects");
    for (const p of t.projects) {
      lines.push("", `**${p.name}**`);
      for (const b of p.bullets) lines.push(`- ${b}`);
    }
  }
  lines.push("", "## Education");
  for (const e of profile.education) lines.push(`- ${e.degree}, ${e.field}${e.minor ? `, minor in ${e.minor}` : ""}, ${e.school}, ${e.startYear} to ${e.status === "in_progress" ? "expected " : ""}${e.gradYear}`);
  return lines.join("\n") + "\n";
}
