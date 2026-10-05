/**
 * Turns a dumped form into a fill plan with one JEV call per chunk of fields.
 *
 * Text-like fields: a choice over every profile key, bank intent and special
 * key, so the answer is "which value goes here" in one shot.
 * Select, radio and combobox fields: a choice over the field's own options
 * (plus "none") given the candidate's facts, so the answer is the option.
 * Checkboxes: a noul, "should this be checked".
 * File inputs: resume upload, no model needed.
 */
import { FORM, CACHE, PATHS } from "../config.js";
import { hashOf, KeyedCache } from "../util/cache.js";
import { dateFormatOf, isoOf, shapedForBox, toYmd } from "../util/dates.js";
import type { JevClient } from "../jev/client.js";
import { choice, noul } from "../jev/questions.js";
import type { Answer, ChoiceAnswer, NoulAnswer, Questions } from "../jev/types.js";
import { ALL_KEYS, isProfileKey, isSpecialKey, profileFacts, valueFor, type FieldKey } from "../profile/fieldKeys.js";
import { monthName, type Profile } from "../profile/schema.js";
import { BANK_INTENTS } from "../answers/bank.js";
import { locationTier } from "../jobs/hardFilters.js";
import type { Job } from "../jobs/normalize.js";
import type { DumpedField, FieldsDump, FillPlan, PlannedField } from "./fields.js";
import { documentPolicy, documentsFor, tailorJob } from "../documents/tailor.js";
import { loadQueue } from "../jobs/queue.js";
import { toItalian } from "./localWords.js";

const NONE = "__none__";

/** Italian places that postings name without the country. */
const ITALIAN_PLACE = /\b(ital[iy]a?|italian|milan[o]?|rom[ae]|torino|turin|napoli|naples|bologna|firenze|florence|bari|genova|genoa|padova|verona|venezia|venice|brescia|bergamo|parma|modena|trieste|catania|palermo|pisa|monza|treviso|vicenza|ancona|perugia|pescara|lecce)\b/i;

/** The country a posting is in, as far as work authorization goes. */
export function jobCountry(job: Job, remote = "unknown"): string {
  const tier = locationTier(job.locations);
  if (tier === "vancouver" || tier === "canada") return "Canada";
  if (tier === "us") return "United States";
  if (job.locations.some((l) => ITALIAN_PLACE.test(l))) return "Italy";
  return tier === "remote" ? remote : "unknown";
}

export function buildFormState(profile: Profile, job: Job, dump: FieldsDump, fields: DumpedField[]): Record<string, unknown> {
  const country = jobCountry(job, "remote (treat as the company's country)");
  return {
    page: { url: dump.url, title: dump.title, context: dump.context },
    job: { company: job.company, title: job.title, locations: job.locations, country },
    candidate: {
      facts: profileFacts(profile),
      work_authorization: {
        citizenships: profile.workAuthorization.citizenships,
        authorized_without_sponsorship_in: profile.workAuthorization.authorizedCountries,
        needs_sponsorship_elsewhere: profile.workAuthorization.requiresSponsorshipElsewhere,
        statement: profile.workAuthorization.statement,
        for_this_job: authForCountry(profile, country),
      },
      education: {
        ...profile.education[0],
        degree_start: `${monthName(profile.education[0]?.startMonth ?? 1)} ${profile.education[0]?.startYear} (month ${profile.education[0]?.startMonth})`,
        degree_end_or_graduation: `${monthName(profile.education[0]?.gradMonth ?? 1)} ${profile.education[0]?.gradYear} (month ${profile.education[0]?.gradMonth})`,
      },
      /** What the candidate has done, so a count or a yes/no about it is answered from the record and not guessed. */
      background: {
        experience: profile.experience.map((e) => ({ company: e.company, title: e.title, location: e.location, start: e.start, end: e.end, current: e.current })),
        internships_and_jobs_held: profile.experience.length,
        projects: profile.projects.map((p) => ({ name: p.name, role: p.role, start: p.start, end: p.end })),
        skills: profile.skills,
        spoken_languages: profile.spokenLanguages,
        notes: profile.facts,
      },
      demographics: profile.demographics,
      preferences: profile.preferences,
      /** The candidate's own answers to recurring questions. They outrank any guess. */
      standing_answers: profile.answers,
      gpa_policy: "Only give a GPA if the field is required. The cumulative GPA is " + (profile.education[0]?.gpa?.cumulative ?? "not provided") + " on a 4.0 scale.",
      rules: [
        `The candidate may work without sponsorship only in: ${profile.workAuthorization.authorizedCountries.join(", ")}. Never claim work authorization anywhere else.`,
        "Never write a cover letter.",
        "Salary expectation is left blank or set to negotiable.",
        "Marketing opt-ins are optional and left unchecked. Consent and acknowledgement boxes required to apply are checked.",
        "A Start Date or End Date that follows School, Degree or Field of Study fields is the degree's start or end, never the job start. The job start is only asked by fields that say available, start work, or join.",
      ],
    },
    fields: fields.map((f, i) => ({
      id: f.id,
      kind: f.kind,
      section: f.section,
      /** Labels of the two fields just above this one: "Start Date" after "School" and "Degree" is an education date. */
      preceded_by: fields.slice(Math.max(0, i - 2), i).map((p) => p.label).filter(Boolean),
      label: f.label,
      hint: f.hint,
      placeholder: f.placeholder,
      name: f.name,
      autocomplete: f.autocomplete,
      required: f.required,
      options: hasChoosableOptions(f) ? f.options.map((o) => o.label) : [],
    })),
  };
}

export function authForCountry(profile: Profile, country: string): { authorized: "Yes" | "No"; requires_sponsorship: "Yes" | "No" } {
  const ok = profile.workAuthorization.authorizedCountries.some((c) => country.toLowerCase().includes(c.toLowerCase()));
  return { authorized: ok ? "Yes" : "No", requires_sponsorship: ok ? "No" : "Yes" };
}

const TEXT_KINDS = new Set(["text", "email", "tel", "url", "number", "date", "calendar", "textarea"]);

/** Input types whose value is fixed by the type itself; JEV only picks among the matching keys. */
const KEYS_BY_KIND: Partial<Record<string, string[]>> = {
  url: ["linkedin_url", "github_url", "website_url", "leave_blank"],
};

export function questionsFor(fields: DumpedField[]): Questions {
  const q: Questions = {};
  const keyCriteria: Record<string, string> = { ...ALL_KEYS };
  for (const [intent, desc] of Object.entries(BANK_INTENTS)) keyCriteria[`bank:${intent}`] = desc;
  for (const f of fields) {
    const section = f.section ? ` in the "${f.section}" section` : "";
    const i = fields.indexOf(f);
    const before = fields.slice(Math.max(0, i - 2), i).map((p) => p.label).filter(Boolean);
    const context = before.length ? ` (directly after the fields ${before.map((b) => `"${b.slice(0, 40)}"`).join(" and ")})` : "";
    const title = `Field "${f.label || f.placeholder || f.name}"${section}${context}${f.hint ? ` (${f.hint.slice(0, 120)})` : ""}${f.required ? ", required" : ", optional"}`;
    if (f.kind === "email" || isPhoneBox(f)) continue; // fixed by the input type; see planField
    const restricted = KEYS_BY_KIND[f.kind === "tel" ? "number" : f.kind];
    if (restricted) {
      q[f.id] = choice(`${title}, an input of type ${f.kind}: which value should fill it?`, Object.fromEntries(restricted.map((k) => [k, keyCriteria[k] as string])));
    } else if (TEXT_KINDS.has(f.kind)) {
      q[f.id] = choice(`${title}: which value should fill it?`, keyCriteria);
    } else if (f.kind === "select" || f.kind === "radio" || f.kind === "combobox") {
      const opts = f.options;
      if (!hasChoosableOptions(f)) {
        // No list yet, or one too long to show (countries, schools): JEV names the value and code finds it in the list.
        q[f.id] = choice(`${title}: a dropdown ${opts.length ? `with ${opts.length} options, too many to list` : "whose options are not visible yet"}. Which value belongs in it?`, keyCriteria);
        continue;
      }
      const criteria: Record<string, string> = {};
      opts.forEach((o, i) => (criteria[`o${i}`] = o.label || o.value));
      criteria[NONE] = f.required ? "No option fits the candidate at all" : "Leave unselected: optional and not applicable";
      q[f.id] = choice(`${title}: which option is correct for the candidate?`, criteria);
    } else if (f.kind === "checkbox") {
      q[f.id] = noul(`${title}: should this checkbox be checked for the candidate?`, {
        true: "A consent, acknowledgement, terms or accuracy box needed to submit, or a true statement about the candidate",
        false: "A marketing or alert opt-in, or a statement that is not true of the candidate",
      });
    }
  }
  return q;
}

/** A list JEV can pick from directly: present, and short enough to show whole. */
export function hasChoosableOptions(f: DumpedField): boolean {
  return (f.kind === "select" || f.kind === "radio" || f.kind === "combobox") && f.options.length > 0 && f.options.length <= (f.wholeList ? FORM.maxOptionsSecondLook : FORM.maxOptionsForJev);
}

const SALARY_LABEL = /salary|compensation|desired pay|expected pay|pay (rate|range|expectation)|hourly rate|wage|stipendio|retribuzione|\bral\b|gehalt|salaire|salario/i;

/** Italian degree names and the English words a form in English uses for them. */
const ENGLISH_DEGREE: [RegExp, string][] = [
  [/laurea (triennale|di primo livello)|^laurea$/i, "Bachelor's degree"],
  [/laurea (magistrale|specialistica)/i, "Master's degree"],
  [/dottorato/i, "PhD"],
  [/diploma|maturità/i, "High school diploma"],
];

/** How many label words a form has in English and in Italian: the language the form is written in. */
export function formLanguageCounts(fields: Pick<DumpedField, "label">[]): { en: number; it: number } {
  const labels = fields.map((f) => f.label).join(" ");
  const en = (labels.match(/\b(name|first|last|email|phone|address|city|country|date|degree|school|resume|upload|company|title|start|end)\b/gi) ?? []).length;
  const it = (labels.match(/\b(nome|cognome|telefono|indirizzo|città|paese|data|laurea|scuola|curriculum|azienda|ruolo|inizio|fine)\b/gi) ?? []).length;
  return { en, it };
}
export const isItalianForm = (fields: Pick<DumpedField, "label">[]) => { const c = formLanguageCounts(fields); return c.it > c.en; };
export { toItalian };
const LANGUAGE_ASK = /fluent|fluency|proficien|speak|spoken|conversational|fluentemente|parli|conosc\w* (la lingua|l'|il )|sprichst|sprechen|fließend|parlez|courant|hablas|hablar|fluido/i;
const YES_OPTION = /^(yes|s[iì]|ja|oui|s[ií]|sim)\b/i;
const NO_OPTION = /^(no|nein|non|não)\b/i;
const LANGUAGE_NAMES: Record<string, string[]> = {
  english: ["english", "inglese", "englisch", "anglais", "ingl[eé]s"],
  italian: ["italian", "italiano", "italienisch", "italien"],
  german: ["german", "tedesco", "deutsch", "allemand", "alem[aã]n"],
  french: ["french", "francese", "franz[oö]sisch", "fran[cç]ais", "franc[eé]s"],
  spanish: ["spanish", "spagnolo", "spanisch", "espagnol", "espa[nñ]ol"],
};
const languageWords = (name: string) => LANGUAGE_NAMES[name.trim().toLowerCase()] ?? [name.trim().toLowerCase()];
/** A box that holds one language of a language entry, by its whole label. */
const LANGUAGE_BOX = /^\s*\*?\s*(language|lingua|sprache|langue|idioma|língua)\s*(name|\d+)?\s*:?\s*\*?\s*$/i;
/** A box for the level of that language ("Speaking Proficiency", "Livello scritto"). */
const LEVEL_BOX = /proficien|level|livello|niveau|nivel|kenntnis|competenz|fluency|padronanza/i;
/** The option of a level list nearest the profile's level, tried from the most precise words down. */
function levelOption(level: string, options: { label: string; value: string }[]) {
  const l = level.toLowerCase();
  const ladder = /native|madre|mother|c2/.test(l)
    ? ["native|madrelingua|mother ?tongue|muttersprach|maternelle|nativ", "bilingu", "c2", "fluent|fluente|fließend|courant", "excellent|eccellente|ottim|expert|very good", "advanced|avanzat|c1", "high|alto"]
    : /c1|fluent|advanced/.test(l)
      ? ["c1", "advanced|avanzat|fluent|fluente", "very good|ottim|proficient", "upper.?intermediate|b2", "good|buon"]
      : /b2|upper/.test(l)
        ? ["b2", "upper.?intermediate", "good|buon", "intermediate|intermedi", "b1"]
        : /b1|intermediate/.test(l)
          ? ["b1", "intermediate|intermedi", "fair|discret", "b2"]
          : ["a2", "a1", "basic|base|elementar|beginner|scolastic", "limited|limitat"];
  for (const words of ladder) {
    const hit = options.find((o) => new RegExp(`\\b(${words})`, "i").test(o.label));
    if (hit) return hit;
  }
  return undefined;
}

const EDUCATION_NEIGHBOUR =/school|university|college|degree|field of study|major|education|graduat|start date|end date/i;
const DATE_LABEL = /^(start|end)\s*(date|month|year)?$/i;

/**
 * A Start Date or End Date select that sits right after education fields is
 * the degree's dates. That is a fact from the profile, so it is resolved in
 * code: month selects get the month (by name or number), year selects the year.
 * Returns null when the field is not one of these.
 */
export function educationDatePlan(f: DumpedField, previous: DumpedField[], profile: Profile): PlannedField | null {
  // A whole date box of a school entry (Workday's "From" / "To (Actual or Expected)" year boxes in "#education-11--…").
  const eduEntry = profile.education[0];
  if (f.kind === "date" && eduEntry && /education/i.test(f.selector) && /^(from|to|start|end|dal|al|da|a)\b/i.test(f.label.trim())) {
    const isStart = /^(from|start|dal|da)\b/i.test(f.label.trim());
    const value = `${monthName(isStart ? eduEntry.startMonth : eduEntry.gradMonth)} ${isStart ? eduEntry.startYear : eduEntry.gradYear}`;
    return { id: f.id, selector: f.selector, kind: f.kind, label: f.label, required: f.required, optionLabel: null, action: "fill", key: isStart ? "education_start_date" : "graduation_date", value, confidence: 1, note: "degree date from the profile" };
  }
  if (!DATE_LABEL.test(f.label.trim()) || (f.kind !== "select" && f.kind !== "combobox") || f.options.length === 0) return null;
  if (!previous.some((p) => EDUCATION_NEIGHBOUR.test(p.label))) return null;
  const edu = profile.education[0];
  if (!edu) return null;
  const isStart = /^start/i.test(f.label.trim());
  const month = isStart ? edu.startMonth : edu.gradMonth;
  const year = isStart ? edu.startYear : edu.gradYear;
  const labels = f.options.map((o) => o.label.trim());
  const looksLikeYears = labels.filter((l) => /^(19|20)\d\d$/.test(l)).length >= Math.max(2, labels.length / 2);
  const looksLikeMonths = labels.some((l) => /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(l)) || labels.filter((l) => /^(0?[1-9]|1[0-2])$/.test(l)).length >= 12;
  let opt: { value: string; label: string } | undefined;
  if (looksLikeYears) opt = f.options.find((o) => o.label.trim() === String(year) || o.value === String(year));
  else if (looksLikeMonths) {
    const name = monthName(month).toLowerCase();
    opt = f.options.find((o) => o.label.trim().toLowerCase().startsWith(name.slice(0, 3)) || o.label.trim() === String(month) || o.label.trim() === String(month).padStart(2, "0") || o.value === String(month));
  }
  const base = { id: f.id, selector: f.selector, kind: f.kind, label: f.label, required: f.required };
  if (!opt) return { ...base, action: "review", key: isStart ? "education_start_date" : "graduation_date", value: null, optionLabel: null, confidence: 0.4, note: `education ${isStart ? "start" : "end"} date, no matching option for ${monthName(month)} ${year}` };
  return { ...base, action: "fill", key: isStart ? "education_start_date" : "graduation_date", value: f.kind === "select" ? opt.value : opt.label, optionLabel: opt.label, confidence: 1, note: "degree date from the profile" };
}

const EMPLOYMENT_NEIGHBOUR = /company|employer|job title|^title$|position|^role$|role description|job description|responsibilit|azienda|datore|qualifica|ruolo|mansion/i;
const SCHOOL_NEIGHBOUR = /school|university|college|degree|discipline|field of study|major/i;
// "From" / "To" in a work entry (Workday) are its start and end too, and so are their Italian words.
const WORK_DATE_LABEL = /^(start|end|from|to|dal|al|da|a|inizio|fine|data (?:di )?inizio|data (?:di )?fine)\s*(?:date)?\s*(month|year)?\s*\*?$/i;
const WORK_START = /^(start|from|dal|da|inizio|data (?:di )?inizio)$/i;
const CURRENT_ROLE = /^(current role|current position|i currently work here|currently work here)$/i;

/** Which block a date field sits in, from the nearest field above it that is not itself a date. */
export function sectionOf(previous: DumpedField[]): "education" | "employment" | null {
  for (let i = previous.length - 1; i >= 0; i--) {
    const label = (previous[i] as DumpedField).label.trim();
    if (/^(start|end)\b/i.test(label) || WORK_DATE_LABEL.test(label) || CURRENT_ROLE.test(label)) continue;
    if (EMPLOYMENT_NEIGHBOUR.test(label)) return "employment";
    return SCHOOL_NEIGHBOUR.test(label) ? "education" : null;
  }
  return null;
}

/**
 * Dates and the "current role" box of a work-history block are facts about the most recent job
 * in the profile, so they are resolved in code. Returns null when the field is not one of these.
 */
export function employmentDatePlan(f: DumpedField, previous: DumpedField[], profile: Profile): PlannedField | null {
  const exp = profile.experience[0];
  // A box named for the work history ("workExperience-10--endDate") is in it whatever the labels above it say.
  if (!exp || (sectionOf(previous) !== "employment" && !/work.?experience|employment|job.?history/i.test(f.selector))) return null;
  const label = f.label.trim();
  const base = { id: f.id, selector: f.selector, kind: f.kind, label: f.label, required: f.required, optionLabel: null as string | null };
  if (f.kind === "checkbox" && CURRENT_ROLE.test(label)) {
    return exp.current
      ? { ...base, action: "fill", key: "checked", value: "true", confidence: 1, note: "the most recent job is the current one" }
      : { ...base, action: "skip", key: "unchecked", value: null, confidence: 1, note: "the most recent job has ended" };
  }
  const m = WORK_DATE_LABEL.exec(label);
  if (!m) return null;
  const isStart = WORK_START.test(m[1] as string);
  const date = /^(\d{4})-(\d{2})/.exec(isStart ? exp.start : exp.end);
  if (!date) return isStart || !exp.current ? null : { ...base, action: "skip", key: "leave_blank", value: null, confidence: 1, note: "still in this job, no end date" };
  const year = date[1] as string;
  const month = parseInt(date[2] as string, 10);
  const labels = f.options.map((o) => o.label.trim());
  const part = (m[2]?.toLowerCase() as "month" | "year" | undefined) ?? (labels.filter((l) => /^(19|20)\d\d$/.test(l)).length >= 2 ? "year" : labels.length ? "month" : undefined);
  const key = isStart ? "employment_start_date" : "employment_end_date";
  const note = "work history date from the profile";
  if ((f.kind === "select" || f.kind === "combobox") && f.options.length) {
    const name = monthName(month).toLowerCase();
    const opt = part === "year"
      ? f.options.find((o) => o.label.trim() === year || o.value === year)
      : f.options.find((o) => o.label.trim().toLowerCase().startsWith(name.slice(0, 3)) || o.label.trim() === String(month) || o.label.trim() === String(month).padStart(2, "0") || o.value === String(month));
    if (!opt) return { ...base, action: "review", key, value: null, confidence: 0.4, note: `work history ${isStart ? "start" : "end"} date, no matching option for ${monthName(month)} ${year}` };
    return { ...base, action: "fill", key, value: f.kind === "select" ? opt.value : opt.label, optionLabel: opt.label, confidence: 1, note };
  }
  if (part === "year" && (f.kind === "text" || f.kind === "number")) return { ...base, action: "fill", key, value: year, confidence: 1, note };
  // A whole date box (Workday's month/year spin boxes): the month and year, which the date filler writes its way.
  if (!part && f.kind === "date") return { ...base, action: "fill", key, value: `${monthName(month)} ${year}`, confidence: 1, note };
  return null;
}

const SLOT_LABEL = /assess|interview|session|time slot|schedule|appointment|attend|preferred date/i;
const SLOT_OPTION = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+[a-z]*\s*\d|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}:\d{2}\b/i;

/** A question that asks the candidate to pick one of several dates or times for an interview, a test or an event. */
export function isSlotChoice(f: DumpedField): boolean {
  return SLOT_LABEL.test(f.label) && f.options.filter((o) => SLOT_OPTION.test(o.label)).length >= 2;
}

/** Typing a name to sign an agreement is the candidate's act, not the tool's. An NDA is theirs to read first, whatever the box looks like. */
const SIGNATURE_LABEL = /\bNDA\b|non-?disclosure|e-?signature|electronic signature|(typ(e|ing)|enter(ing)?) your (full |legal )*name/i;

let plans: KeyedCache<FillPlan> | null = null;

/**
 * Maps a form to a fill plan. A form that was mapped before, with nothing changed in the form,
 * the job or the candidate, gets the same plan back without asking JEV: this is the second fill
 * of a form, and the real run after a rehearsal.
 */
export async function mapForm(jev: JevClient, profile: Profile, job: Job, dump: FieldsDump): Promise<FillPlan> {
  if (!CACHE.plans) return mapFormFresh(jev, profile, job, dump);
  plans ??= new KeyedCache<FillPlan>(PATHS.plans, "all", CACHE.maxPlans);
  // The values a form happens to hold (an earlier fill, an autofill) do not change what belongs in it.
  const fields = dump.fields.map(({ value: _value, checked: _checked, ...rest }) => rest);
  // A plan made with the profile's resume is not the plan for a run that wants a tailored one, and the other way round.
  const key = hashOf({ fields, submit: dump.submitSelectors, state: buildFormState(profile, job, { ...dump, url: "" }, []), form: FORM, documents: documentPolicy() });
  const hit = plans.get(key);
  if (hit) return { ...hit, jobId: job.id, url: dump.url, jevCostUsd: 0 };
  const plan = await mapFormFresh(jev, profile, job, dump);
  // A plan whose resume box went without the job's resume (its draft was not written then) is not kept: next time
  // the resume may be there.
  if (plan.fields.some((f) => f.key === "resume_upload" && f.action !== "upload")) return plan;
  plans.set(key, plan);
  plans.save();
  return plan;
}

async function mapFormFresh(jev: JevClient, profile: Profile, job: Job, dump: FieldsDump): Promise<FillPlan> {
  const planned: PlannedField[] = [];
  const startCost = jev.usage.costUsd;
  const resolvedInCode = new Set<string>();
  dump.fields.forEach((f, i) => {
    const above = dump.fields.slice(Math.max(0, i - 8), i);
    // A box named for its block (Workday: "#education-11--…", "#workExperience-10--…") belongs to it, wherever it was read.
    const named = /education/i.test(f.selector) ? "education" : /work.?experience|employment|job.?history/i.test(f.selector) ? "employment" : null;
    const p = named === "education"
      ? educationDatePlan(f, dump.fields.slice(Math.max(0, i - 4), i), profile)
      : employmentDatePlan(f, above, profile) ?? (sectionOf(above) === "employment" || named ? null : educationDatePlan(f, dump.fields.slice(Math.max(0, i - 4), i), profile));
    if (p) {
      planned.push(p);
      resolvedInCode.add(f.id);
    }
  });
  // Tailored documents, when the person asked for them: the resume written for this job goes in the resume box,
  // and a cover letter is written when the form has a box for one, as a file or as text.
  // A file box is read as the attach step reads it, so a box named only by its section ("Upload Cover Letter") counts.
  const coverBox = dump.fields.some((f) => (f.kind === "file" ? fileBoxWants(f) === "cover" : COVER_LABEL.test(`${f.label} ${f.name} ${f.hint}`)));
  const policy = documentPolicy();
  let docs = documentsFor(job.id, profile);
  if ((policy.resume && !docs) || (policy.cover && coverBox && !docs?.coverText)) {
    const entry = loadQueue().entries.find((e) => e.job.id === job.id);
    if (entry) {
      try {
        docs = await tailorJob(profile, entry, { cover: policy.cover && coverBox });
      } catch (err) {
        // A letter that failed leaves the resume already written for this job; the profile's own resume never goes.
        console.log(`   tailored documents not written: ${err instanceof Error ? err.message : String(err)}.`);
        docs = documentsFor(job.id, profile);
      }
    }
  }
  const coverText = policy.cover ? (docs?.coverText ?? null) : null;
  dump.fields.forEach((f) => {
    if (f.kind !== "textarea" || resolvedInCode.has(f.id) || !coverText || !COVER_LABEL.test(`${f.label} ${f.name} ${f.hint}`)) return;
    planned.push({ id: f.id, selector: f.selector, kind: f.kind, label: f.label, required: f.required, optionLabel: null, action: "fill", key: "cover_letter", value: f.maxLength ? coverText.slice(0, f.maxLength) : coverText, confidence: 1, note: "the cover letter written for this job" });
    resolvedInCode.add(f.id);
  });
  const askable = dump.fields.filter((f) => f.kind !== "file" && !resolvedInCode.has(f.id));
  // A chunk too large for JEV's context (long questions, long option lists) is halved and asked again.
  const ask = async (chunk: DumpedField[]): Promise<Record<string, Answer>> => {
    const questions = questionsFor(chunk);
    if (!Object.keys(questions).length) return {};
    try {
      return await jev.decide(buildFormState(profile, job, dump, chunk), questions, `map-form:${job.id}:${job.company}`);
    } catch (err) {
      if (chunk.length < 2 || !/max_tokens_exceeded|context length|too large/i.test(err instanceof Error ? err.message : "")) throw err;
      const half = Math.ceil(chunk.length / 2);
      return { ...(await ask(chunk.slice(0, half))), ...(await ask(chunk.slice(half))) };
    }
  };
  for (let i = 0; i < askable.length; i += FORM.fieldsPerCall) {
    const chunk = askable.slice(i, i + FORM.fieldsPerCall);
    const answers = await ask(chunk);
    // An optional field JEV is unsure of is left blank, not handed to the writer: a guess there only risks a wrong fact
    // ("Agricultural Economics" for "Economia"), and an empty optional box never stops a form.
    for (const f of chunk) {
      const p = planField(f, answers[f.id], profile, job);
      // The job the candidate still holds has no end date: the form drops that box once "I currently work here" is ticked.
      if (p.key === "experience_end_date" && p.action !== "fill" && (profile.experience[0]?.current ?? false)) {
        planned.push({ ...p, action: "skip", value: null, note: "the candidate still works there" });
        continue;
      }
      planned.push(p.action === "review" && !p.required ? { ...p, action: "skip", value: null, note: `optional, left blank (${p.note ?? "unsure"})` } : p);
    }
  }
  const fileBoxes = dump.fields.filter((f) => f.kind === "file");
  const wants = fileBoxes.map(fileBoxWants);
  // A box that names no document is the resume box only when no other box on the form asks for the resume.
  const unnamedResume = wants.includes("resume") ? -1 : wants.indexOf("unnamed");
  fileBoxes.forEach((f, i) => {
    const want = i === unnamedResume ? "resume" : wants[i];
    // The one transcript on file is the undergraduate one unless the profile holds a graduate degree.
    const graduate = profile.education.some((e) => /master|\bm\.?sc?\b|\bmba\b|ph\.?d|doctor/i.test(e.degree));
    const file =
      want === "resume" ? (policy.resume ? (docs?.resume ?? null) : profile.resume.path)
      : want === "cover" ? (policy.cover && docs?.cover ? docs.cover : null)
      : want === "transcript" || (want === "graduate_transcript" && graduate) ? (profile.transcript?.path ?? null)
      // A photo goes in whenever the form has a box for one (owner's rule) and the profile holds one.
      : want === "photo" ? (profile.photo?.path ?? null)
      : null;
    planned.push({
      id: f.id, selector: f.selector, kind: f.kind, label: f.label, required: f.required,
      action: file ? "upload" : "skip", key: want === "resume" ? "resume_upload" : "leave_blank",
      value: file, optionLabel: null, confidence: 1,
      note: file ? (want === "resume" && file !== profile.resume.path ? "the resume written for this job" : want === "cover" ? "the cover letter written for this job" : null) : want === "autofill" ? "autofill helper, skipped so it does not overwrite the plan" : want === "photo" ? "asks for a photo. Set photo.path in your profile to attach one" : want === "transcript" ? "asks for a transcript. Set transcript.path in your profile to attach one" : want === "graduate_transcript" ? "asks for a graduate transcript, and the profile has no graduate degree" : want === "cover" ? "asks for a cover letter. Run apply --cover to write one" : "not a resume upload",
    });
  });
  // A group of boxes whose question is required gets at least one ticked: the one most likely to be the candidate's.
  const groups = new Map<string, DumpedField[]>();
  for (const f of dump.fields.filter((x) => x.kind === "checkbox" && x.groupRequired)) groups.set(f.section, [...(groups.get(f.section) ?? []), f]);
  for (const boxes of groups.values()) {
    const plans = boxes.map((f) => planned.find((p) => p.id === f.id)).filter((p): p is PlannedField => !!p);
    if (!plans.length || plans.some((p) => p.action === "fill")) continue;
    const likely = (p: PlannedField) => (p.action === "skip" ? 1 - p.confidence : 0.5);
    const best = plans.reduce((a, b) => (likely(b) > likely(a) ? b : a));
    const at = planned.indexOf(best);
    planned[at] = { ...best, action: "fill", key: "checked", value: "true", required: true, note: "one box of a required group" };
  }
  // A pick with a qualifier the profile never names ("Agricultural Economics", "Applied Economics") gives way to the
  // plain row the list also holds ("Economics").
  const said = JSON.stringify(profile).toLowerCase();
  planned.forEach((p, at) => {
    const f = dump.fields.find((x) => x.id === p.id);
    if (!f || p.action !== "fill" || !p.value || f.options.length < 2) return;
    const pick = p.value.trim();
    const plain = f.options.map((o) => o.label.trim()).find((o) => o.length >= 4 && o.length < pick.length && pick.toLowerCase().endsWith(` ${o.toLowerCase()}`));
    if (!plain) return;
    const qualifier = pick.slice(0, pick.length - plain.length).toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
    if (qualifier.length && !qualifier.some((w) => said.includes(w.slice(0, 5)))) planned[at] = { ...p, value: plain, optionLabel: plain, note: p.note ?? `the plain "${plain}" rather than "${pick}"` };
  });
  // A form written in English gets the candidate's degree in English words ("Laurea triennale" as "Bachelor's degree").
  const { en, it } = formLanguageCounts(dump.fields);
  if (en > 2 * it) {
    planned.forEach((p, at) => {
      if (p.action !== "fill" || !p.value || !["degree", "education_level"].includes(p.key ?? "")) return;
      const english = ENGLISH_DEGREE.find(([re]) => re.test(p.value as string))?.[1];
      if (english && !dump.fields.find((x) => x.id === p.id)?.options.length) planned[at] = { ...p, value: english, note: p.note ?? `the degree in the form's language` };
    });
  }
  // A form written in Italian gets the profile's English words in Italian ("Italy" as "Italia", "Italian (Native)" as
  // "Italiano (madrelingua)"), in boxes and in lists that are searched by what is typed. A list whose options were read
  // keeps the option it picked.
  if (it > en) {
    planned.forEach((p, at) => {
      const f = dump.fields.find((x) => x.id === p.id);
      if (p.action !== "fill" || !p.value || !f || ["email", "file"].includes(f.kind) || f.options.some((o) => o.label === p.value || o.value === p.value)) return;
      const italian = toItalian(p.value);
      if (italian !== p.value) planned[at] = { ...p, value: italian, note: p.note ?? "in the form's language" };
    });
  }
  // A box for one language (a language entry: "Language", then "Speaking Proficiency", "Writing Proficiency") takes one
  // language's name, never the whole list with levels; repeated entries take the profile's languages in order. The
  // entry's level lists take that language's level, as one of their options.
  let entry = -1;
  dump.fields.forEach((f) => {
    if (LANGUAGE_BOX.test(f.label) && f.kind !== "file") {
      entry++;
      const spoken = profile.spokenLanguages[entry];
      const at = planned.findIndex((p) => p.id === f.id);
      if (!spoken || at < 0) return;
      const words = languageWords(spoken.name);
      const option = f.options.find((o) => words.some((w) => new RegExp(`^\\s*${w}\\b`, "i").test(o.label)));
      if (f.options.length && !option) return;
      const name = it > en ? toItalian(spoken.name) : spoken.name;
      planned[at] = { ...planned[at]!, action: "fill", key: "spoken_languages", value: option ? (f.kind === "select" ? option.value : option.label) : name, optionLabel: option?.label ?? null, confidence: 0.9, note: `language ${entry + 1} of the profile` };
      return;
    }
    if (entry < 0 || !LEVEL_BOX.test(f.label) || !f.options.length) return;
    const spoken = profile.spokenLanguages[entry];
    const at = planned.findIndex((p) => p.id === f.id);
    if (!spoken || at < 0) return;
    const option = levelOption(spoken.level, f.options);
    if (option) planned[at] = { ...planned[at]!, action: "fill", key: "spoken_languages", value: f.kind === "select" ? option.value : option.label, optionLabel: option.label, confidence: 0.9, note: `${spoken.name} ${spoken.level} in the profile` };
  });
  // A Yes/No question on speaking a language the profile lists ("Are you fluent in English?") is answered from its
  // level: B1 and up is yes (a near miss is yes), A1/A2 is no.
  planned.forEach((p, at) => {
    const f = dump.fields.find((x) => x.id === p.id);
    if (!f || !LANGUAGE_ASK.test(f.label)) return;
    const yes = f.options.find((o) => YES_OPTION.test(o.label.trim()));
    const no = f.options.find((o) => NO_OPTION.test(o.label.trim()));
    if (!yes || !no || f.options.filter((o) => o.label.trim() && !/^(select|seleziona|choose|scegli)/i.test(o.label.trim())).length !== 2) return;
    const spoken = profile.spokenLanguages.find((l) => languageWords(l.name).some((w) => new RegExp(`\\b${w}`, "i").test(f.label)));
    if (!spoken) return;
    const pick = /\b(a1|a2|basic|beginner|elementar|base)\b/i.test(spoken.level) ? no : yes;
    planned[at] = { ...p, action: "fill", key: "spoken_languages", value: f.kind === "select" ? pick.value : pick.label, optionLabel: pick.label, confidence: 0.9, note: `${spoken.name} ${spoken.level} in the profile` };
  });
  const ordered = dump.fields.map((f) => planned.find((p) => p.id === f.id) as PlannedField);
  return {
    jobId: job.id,
    url: dump.url,
    fields: ordered,
    fills: ordered.filter((p) => p.action === "fill" && p.value !== null).map((p) => ({ selector: p.selector, kind: p.kind, value: p.value as string, required: p.required })),
    uploads: ordered.filter((p) => p.action === "upload").map((p) => ({ selector: p.selector, path: p.value as string })),
    drafts: ordered.filter((p) => p.action === "draft").map((p) => {
      const f = dump.fields.find((x) => x.id === p.id) as DumpedField;
      return { id: p.id, selector: p.selector, label: p.label, hint: f.hint, maxLength: f.maxLength, intent: p.key };
    }),
    reviews: ordered.filter((p) => p.action === "review").map((p) => {
      const f = dump.fields.find((x) => x.id === p.id) as DumpedField;
      return { id: p.id, selector: p.selector, kind: p.kind, label: p.label, options: f.options.map((o) => o.label), why: p.note ?? "low confidence" };
    }),
    submitSelectors: dump.submitSelectors,
    jevCostUsd: jev.usage.costUsd - startCost,
  };
}

/**
 * A tel input is the phone number, except when its label names something else: some boards (HiBob)
 * use type tel for any digits-only box, such as the desired salary.
 */
const isPhoneBox = (f: DumpedField) => f.kind === "tel" && !(SALARY_LABEL.test(f.label) || /stipendio|retribuzione|\bral\b|years|anni|\bage\b|amount|importo/i.test(f.label));

export function planField(f: DumpedField, answer: Answer | undefined, profile: Profile, job: Job): PlannedField {
  const base = { id: f.id, selector: f.selector, kind: f.kind, label: f.label, required: f.required, optionLabel: null as string | null };
  if (f.kind === "email") return { ...base, action: "fill", key: "email", value: profile.email, confidence: 1, note: null };
  if (isPhoneBox(f)) {
    // National digits unless the placeholder or hint shows an international format.
    // Outside North America the number goes in with its country code: European boards (TalentLyft) refuse bare national digits.
    const northAmerica = ["United States", "Canada"].includes(jobCountry(job));
    const intl = !northAmerica || /\+\d|country code|international/i.test(`${f.placeholder} ${f.hint}`);
    return { ...base, action: "fill", key: intl ? "phone_with_country_code" : "phone", value: intl ? `${profile.phone.countryCode}${profile.phone.national}` : profile.phone.national, confidence: 1, note: null };
  }
  if (SIGNATURE_LABEL.test(f.label)) return { ...base, action: "review", key: "signature", value: null, confidence: 1, note: "signing an agreement is for the candidate to do" };
  if (isSlotChoice(f)) return { ...base, action: "review", key: "schedule", value: null, confidence: 1, note: "choosing a date or a time slot is for the candidate to do" };
  // "I currently work here" in a work entry, "currently studying here" in an education entry: the profile says it outright.
  if (f.kind === "checkbox" && CURRENT_JOB.test(f.label)) {
    const now = profile.experience[0]?.current ?? false;
    return now ? { ...base, action: "fill", key: "experience_current", value: "true", confidence: 1, note: null } : { ...base, action: "skip", key: "experience_current", value: null, confidence: 1, note: "left unchecked" };
  }
  // "I have a preferred name" opens boxes for another name: ticked only when the profile holds one.
  if (f.kind === "checkbox" && /preferred name|nome preferito|bevorzugter name|nom d'usage|nombre preferido/i.test(f.label)) {
    const other = !!profile.name.preferred && profile.name.preferred !== profile.name.first;
    return other ? { ...base, action: "fill", key: "preferred_name", value: "true", confidence: 1, note: null } : { ...base, action: "skip", key: "preferred_name", value: null, confidence: 1, note: "no other name in the profile" };
  }
  if (f.kind === "checkbox" && CURRENT_STUDY.test(f.label)) {
    const now = profile.education[0]?.status === "in_progress";
    return now ? { ...base, action: "fill", key: "currently_enrolled", value: "true", confidence: 1, note: null } : { ...base, action: "skip", key: "currently_enrolled", value: null, confidence: 1, note: "left unchecked" };
  }
  if (!answer) return { ...base, action: "review", key: "unknown", value: null, confidence: 0, note: "no answer" };

  if (f.kind === "checkbox") {
    const p = (answer as NoulAnswer).noul;
    if (p >= 0.7) return { ...base, action: "fill", key: "checked", value: "true", confidence: p, note: null };
    if (p <= 0.3) return { ...base, action: "skip", key: "unchecked", value: null, confidence: 1 - p, note: "left unchecked" };
    return { ...base, action: "review", key: "unknown", value: null, confidence: Math.max(p, 1 - p), note: "unsure whether to check" };
  }

  let a = answer as ChoiceAnswer;
  if (hasChoosableOptions(f)) {
    if (a.choice === NONE) {
      if (f.required) return { ...base, action: "review", key: "unknown", value: null, confidence: a.confidence, note: "required but no option fits" };
      return { ...base, action: "skip", key: "leave_blank", value: null, confidence: a.confidence, note: "optional, left unselected" };
    }
    const idx = parseInt(a.choice.replace(/^o/, ""), 10);
    const opt = f.options[idx];
    if (!opt) return { ...base, action: "review", key: "unknown", value: null, confidence: 0, note: "option index out of range" };
    const action = a.confidence >= FORM.reviewConfidence ? "fill" : "review";
    // Radios and comboboxes are matched by label in fillFields.js: radio value attributes are often missing or all "on".
    const value = f.kind === "select" ? opt.value : opt.label;
    return { ...base, action, key: `option:${a.choice}`, value, optionLabel: opt.label, confidence: a.confidence, note: a.confidence < FORM.autoConfidence ? `confidence ${a.confidence.toFixed(2)}` : null };
  }

  const key = a.choice;
  // Keys that would put the same text in the box are one answer, so their probabilities add up:
  // "country", "citizenship" and "work authorization country" all say Canada.
  const confidence = agreedConfidence(a, profile, job);
  a = { ...a, confidence };
  const note = a.confidence < FORM.autoConfidence ? `confidence ${a.confidence.toFixed(2)}` : null;
  const textLike = f.kind === "text" || f.kind === "textarea";
  // A required salary box that takes digits only gets the candidate's own figure as digits ("25.000 EUR" as 25000).
  const ownFigure = (profile.preferences.salaryExpectation || profile.preferences.salaryIfRequired || "").match(/\d[\d.,' ]*\d|\d/)?.[0].replace(/[.,' ]/g, "");
  if (f.required && (f.kind === "tel" || f.kind === "number") && SALARY_LABEL.test(f.label) && ownFigure) {
    return { ...base, action: "fill", key: "salary_expectation", value: ownFigure, confidence: 1, note: "the candidate's own salary figure, as digits" };
  }
  // A salary box that will not submit empty gets the profile's standing wording, never a number the candidate did not give.
  if (f.required && textLike && SALARY_LABEL.test(f.label) && !profile.preferences.salaryExpectation && (key === "salary_expectation" || key === "leave_blank" || key === "unknown" || key === "free_text")) {
    return { ...base, action: "fill", key: "salary_expectation", value: profile.preferences.salaryIfRequired, confidence: a.confidence, note: "salary is required, so the standing wording is used" };
  }
  if (a.confidence < FORM.reviewConfidence) {
    // An open question is drafted whatever the confidence: the writer reads the question itself, not JEV's guess at its intent.
    if (f.kind === "textarea" && (key.startsWith("bank:") || key === "free_text")) return { ...base, action: "draft", key: key.startsWith("bank:") ? key.slice(5) : key, value: null, confidence: a.confidence, note: `intent is a guess (${a.confidence.toFixed(2)})` };
    return { ...base, action: "review", key, value: null, confidence: a.confidence, note: `low confidence, best guess ${key}` };
  }
  if (key.startsWith("bank:")) return { ...base, action: "draft", key: key.slice(5), value: null, confidence: a.confidence, note };
  if (isSpecialKey(key)) {
    if (key === "free_text") return { ...base, action: "draft", key: "free_text", value: null, confidence: a.confidence, note };
    if (key === "resume_upload") return { ...base, action: "review", key, value: null, confidence: a.confidence, note: "text field mapped to resume; probably a link or name" };
    if (key === "leave_blank") return { ...base, action: f.required ? "review" : "skip", key, value: null, confidence: a.confidence, note: f.required ? "required but mapped to leave blank" : null };
    return { ...base, action: "review", key, value: null, confidence: a.confidence, note: "unknown field" };
  }
  if (isProfileKey(key)) {
    const value = valueForJob(profile, job, key as FieldKey);
    if (value === null || !value.trim()) {
      if (key === "gpa") return { ...base, action: f.required ? "fill" : "skip", key, value: f.required ? gpaValue(profile) : null, confidence: a.confidence, note: f.required ? "GPA given only because the field is required" : "GPA not volunteered" };
      return { ...base, action: f.required ? "review" : "skip", key, value: null, confidence: a.confidence, note: f.required ? "required but the profile has no value" : null };
    }
    // A link to a site's front page ("https://linkedin.com") names no profile: it stands in only where a link is
    // required. An optional box is left empty, and boards that check the link (SmartRecruiters) refuse it.
    if (/_url$/.test(key) && !f.required && /^https?:\/\/[^/]+\/?$/i.test(value.trim())) {
      return { ...base, action: "skip", key: "leave_blank", value: null, confidence: a.confidence, note: "optional, and the profile's link names no profile" };
    }
    if (f.kind === "calendar") {
      // A calendar takes a day. A value that names only a month is its first day; anything that is not a date goes to Claude.
      const day = toYmd(value);
      if (!day) return { ...base, action: "review", key, value: null, confidence: a.confidence, note: "the calendar needs a date, and the profile's value is not one" };
      return { ...base, action: "fill", key, value: isoOf(day), confidence: a.confidence, note };
    }
    // A start date written as words ("Immediatamente (preavviso 2 settimane)") goes into a date box as the day it names.
    if (key === "earliest_start_date" && TEXT_KINDS.has(f.kind) && !toYmd(value) && dateFormatOf(`${f.placeholder} ${f.hint}`)) {
      const day = startDayOf(value, new Date());
      if (day) return { ...base, action: "fill", key, value: shapedForBox(day, `${f.placeholder} ${f.hint}`), confidence: a.confidence, note: `"${value}" as a date` };
    }
    // A date picker that names no format ("Pick date...") is typed the day as yyyy-mm-dd, which reads one way only;
    // the picker rewrites it in its own format (Ashby: "10/07/2026").
    if (key === "earliest_start_date" && TEXT_KINDS.has(f.kind) && PICK_A_DATE.test(f.placeholder.trim())) {
      const day = toYmd(value) ? isoOf(toYmd(value)!) : startDayOf(value, new Date());
      if (day) return { ...base, action: "fill", key, value: day, confidence: a.confidence, note: `"${value}" as a date` };
    }
    // A box that asks only for the year of a date ("Anno di nascita", a number box) takes the year.
    const whole = TEXT_KINDS.has(f.kind) ? toYmd(value) : null;
    if (whole && (f.kind === "number" || YEAR_ONLY.test(f.label))) return { ...base, action: "fill", key, value: String(whole.year), confidence: a.confidence, note };
    // A date picker box that names no format ("Pick a date") takes a month and year as digits: "01/2022".
    const d = MONTH_YEAR_KEYS.has(key) && TEXT_KINDS.has(f.kind) && PICK_A_DATE.test(f.placeholder.trim()) ? toYmd(value) : null;
    if (d) return { ...base, action: "fill", key, value: `${String(d.month).padStart(2, "0")}/${d.year}`, confidence: a.confidence, note };
    // A text box that names a date format gets the date written that way: typed as "May 2027", a masked box keeps "02/27/".
    return { ...base, action: "fill", key, value: TEXT_KINDS.has(f.kind) ? shapedForBox(value, `${f.placeholder} ${f.hint}`) : value, confidence: a.confidence, note };
  }
  return { ...base, action: "review", key, value: null, confidence: a.confidence, note: "unrecognized key" };
}

/** Which document a file box asks for, from its question, its name and its hint. The resume is never put in a box that asks for something else. */
/** A box that asks for a cover letter, as a file or as text. */
/** A box ticked when the job in a work entry is the candidate's current one. */
const CURRENT_JOB = /currently (work|working) (here|there)|current (job|position|role|employer)|i still work|lavoro (qui )?attualmente|attualmente (lavoro|impiegat)|posizione attuale|ich arbeite (hier )?derzeit|aktuelle (stelle|position)|j'occupe actuellement|poste actuel|trabajo aqu[ií] actualmente|trabajo actual/i;
/** A box ticked when the school in an education entry is still being attended. */
const CURRENT_STUDY = /currently (study|studying|enrolled|attend)|still (studying|enrolled)|attualmente (studio|iscritt)|in corso di studi|studiere derzeit|j'[ée]tudie actuellement|estudio actualmente/i;

/**
 * The day a start written in words falls on, as yyyy-mm-dd: "immediately", "subito", or a notice period ("2 weeks",
 * "preavviso 2 settimane", "1 mese") counted from today. Null when the words name no such day.
 */
export function startDayOf(words: string, today: Date): string | null {
  const w = words.toLowerCase();
  const n = (re: RegExp) => Number(re.exec(w)?.[1] ?? NaN);
  const days = n(/(\d+)\s*(giorn|day|tag|jour|d[ií]a)/), weeks = n(/(\d+)\s*(settiman|week|woche|semaine|semana)/), months = n(/(\d+)\s*(mes|month|monat|mois)/);
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!Number.isNaN(months)) d.setMonth(d.getMonth() + months);
  else if (!Number.isNaN(weeks)) d.setDate(d.getDate() + weeks * 7);
  else if (!Number.isNaN(days)) d.setDate(d.getDate() + days);
  else if (!/immediat|subito|asap|right away|sofort|imm[ée]diatement|inmediat/.test(w)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A box that asks only for a year: "Anno di nascita", "Year of birth", "Graduation year". */
const YEAR_ONLY = /^\s*(anno|year|jahr|ann[ée]e|año|ano)\b|\b(anno|year|jahr|ann[ée]e|año)\s*(di|of|de|der|du)?\s*(nascita|birth|geburt|naissance|nacimiento|laurea|graduation|diploma)\b/i;

/** Profile dates that name only a month and a year. */
const MONTH_YEAR_KEYS = new Set(["education_start_date", "graduation_date", "experience_start_date", "experience_end_date"]);
/** The placeholder of a date picker that names no format of its own. */
const PICK_A_DATE = /^(pick|select|choose|enter|seleziona|scegli|inserisci|wähle|choisir|elige|selecciona)\s+(a |an |una |un |eine |une )?(date|data|datum|fecha)\s*(\.{1,3}|…)?$/i;

export const COVER_LABEL = /cover\s*letter|covering letter|letter of (motivation|interest|application)|motivation letter|anschreiben|motivationsschreiben|lettera di (presentazione|motivazione|accompagnamento)|lettre de motivation|carta de presentaci[oó]n/i;

export function fileBoxWants(f: Pick<DumpedField, "label" | "name" | "hint" | "selector"> & { accept?: string; section?: string }): "resume" | "cover" | "transcript" | "graduate_transcript" | "autofill" | "photo" | "other" | "unnamed" {
  const text = `${f.label} ${f.name} ${f.hint} ${f.selector}`;
  // SmartRecruiters' "apply with your resume" box reads the file and writes what it finds over the form.
  if (/autofill|auto-fill|parse|prefill|apply[-_ ]with[-_ ](your[-_ ])?resume/i.test(text)) return "autofill";
  // A box that takes only pictures is a photo box, whatever its words ("Carica immagine del profilo").
  const accept = (f.accept ?? "").trim();
  if (accept && /image|\.(jpe?g|png|gif|webp|heic|bmp)\b/i.test(accept) && !/pdf|\.docx?\b|application\//i.test(accept)) return "photo";
  if (/\b(immagine|foto|fotografia|photo|picture|image|bild|avatar)\b/i.test(f.label) && !/resume|\bcv\b|curriculum/i.test(f.label)) return "photo";
  // A box that takes only videos is a question answered on camera: never a document of the candidate's.
  if ((accept && accept.split(",").every((x) => /video\/|\.(mp4|mpe?g|avi|mov|mkv|wmv|ogv|webm|flv|m4v)$/i.test(x.trim()))) || /\(a video answer\)$/.test(f.label)) return "other";
  // The box's own question decides first. One box that asks for the resume and the cover letter together
  // (Cornerstone: "Please upload your resume and cover letter") gets the resume, which no application goes without.
  const RESUME = /resume|résumé|\bcv\b|curriculum|lebenslauf/i;
  // A transcript box never gets the resume, even when it names the resume ("your transcript (not your resume)").
  if (/transcript/i.test(f.label)) return /\b(graduate|master|phd|doctoral)\b/i.test(f.label) && !/undergraduate/i.test(f.label) ? "graduate_transcript" : "transcript";
  if (COVER_LABEL.test(f.label) && !RESUME.test(f.label)) return "cover";
  if (RESUME.test(f.label) && !COVER_LABEL.test(f.label)) return "resume";
  if (COVER_LABEL.test(text) && !RESUME.test(text)) return "cover";
  if (/transcript/i.test(text)) return /\b(graduate|master|phd|doctoral)\b/i.test(text) && !/undergraduate/i.test(text) ? "graduate_transcript" : "transcript";
  if (RESUME.test(text)) return "resume";
  // A box that names no document ("Upload Document") under a heading that does (Cornerstone: "Upload Cover Letter").
  const section = /other|additional|attachment|allegat|aggiuntiv|weitere|anhang/i.test(f.label) ? "" : f.section ?? "";
  if (COVER_LABEL.test(section) && !RESUME.test(section)) return "cover";
  if (RESUME.test(section) && !COVER_LABEL.test(section)) return "resume";
  if (/cover|letter|portfolio|photo|picture|certificate|writing sample|work sample|reference|other|additional|supplementar|aggiuntiv|ulterior|altri (documenti|allegati|file)|certificat|attestat|zusätzlich|weitere|supplémentaire|adicional/i.test(text)) return "other";
  return "unnamed";
}

function agreedConfidence(a: ChoiceAnswer, profile: Profile, job: Job): number {
  const valueOf = (key: string) => (isProfileKey(key) ? valueForJob(profile, job, key as FieldKey) : null);
  const value = valueOf(a.choice);
  if (value === null) return a.confidence;
  const agreed = Object.entries(a.probabilities).reduce((sum, [key, p]) => (valueOf(key) === value ? sum + p : sum), 0);
  return Math.min(1, Math.max(a.confidence, agreed));
}

function gpaValue(profile: Profile): string | null {
  const g = profile.education[0]?.gpa;
  if (g?.cumulative === undefined) return null;
  // A grade on another scale than 4 is written with its scale, the way the candidate's country states it: "105/110".
  return g.scale === 4 ? g.cumulative.toFixed(2) : `${g.cumulative}/${g.scale}`;
}

/** Profile value for a key, with the two job-dependent keys resolved against the posting's country. */
export function valueForJob(profile: Profile, job: Job, key: FieldKey): string | null {
  if (isSpecialKey(key)) return null;
  if (key === "authorized_to_work" || key === "requires_sponsorship") {
    const auth = authForCountry(profile, jobCountry(job));
    return key === "authorized_to_work" ? auth.authorized : auth.requires_sponsorship;
  }
  return valueFor(profile, key);
}
