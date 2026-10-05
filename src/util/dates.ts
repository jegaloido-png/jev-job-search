/**
 * Dates as people and forms write them. A profile says "May 2027", a form
 * wants a day picked in a calendar, and the box then shows "May 1, 2027".
 * These helpers turn one into the other and tell whether two are the same day.
 */
export type Ymd = { year: number; month: number; day: number };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// Boards in other languages write their own month names ("Set 2020" on an Italian form is September).
const LOCAL_MONTHS = [
  ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"],
  ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
  ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"],
  ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
  ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
];
/** The month a word names: the full name or a short form of it ("Sep", "Sept.", "Set"). "Maybe" is not May. */
const monthIndex = (word: string) => {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return -1;
  for (const names of [MONTHS, ...LOCAL_MONTHS]) {
    const i = names.findIndex((m) => m.startsWith(w));
    if (i >= 0) return i;
  }
  return -1;
};

/**
 * A date from the ways a profile or the writer states one: 2027-05-03, 05/03/2027, May 3, 2027,
 * 3 May 2027, and a bare month, May 2027, which is taken as its first day.
 */
export function toYmd(value: string): Ymd | null {
  const v = value.trim();
  let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(v);
  if (m) return valid({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3] ?? 1) });
  // A month and year with no day ("09-2020", "09/2020"), as month pickers write it: its first day.
  m = /^(\d{1,2})[\/.-](\d{4})$/.exec(v);
  if (m) return valid({ year: Number(m[2]), month: Number(m[1]), day: 1 });
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) return valid({ year: Number(m[3]), month: Number(m[1]), day: Number(m[2]) });
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(v);
  if (m && monthIndex(m[1] as string) >= 0) return valid({ year: Number(m[3]), month: monthIndex(m[1] as string) + 1, day: Number(m[2]) });
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(v);
  if (m && monthIndex(m[2] as string) >= 0) return valid({ year: Number(m[3]), month: monthIndex(m[2] as string) + 1, day: Number(m[1]) });
  m = /^(\p{L}{3,9})\.?,?\s+(\d{4})$/u.exec(v);
  if (m && monthIndex(m[1] as string) >= 0) return valid({ year: Number(m[2]), month: monthIndex(m[1] as string) + 1, day: 1 });
  return null;
}

function valid(d: Ymd): Ymd | null {
  const made = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return d.year >= 1900 && d.year <= 2100 && made.getUTCMonth() === d.month - 1 && made.getUTCDate() === d.day ? d : null;
}

export const isoOf = (d: Ymd) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/** The month and year a calendar's heading names: "October 2026", "Oct 2026", "2026 October". */
export function monthOfHeading(heading: string): { year: number; month: number } | null {
  const year = /\b(19|20)\d{2}\b/.exec(heading)?.[0];
  const word = heading.split(/[^A-Za-z]+/).find((w) => w.length >= 3 && monthIndex(w) >= 0);
  return year && word ? { year: Number(year), month: monthIndex(word) + 1 } : null;
}

/** True when what a date box shows is the date that was meant, however the box writes it. */
export function showsDate(shown: string, d: Ymd): boolean {
  const direct = toYmd(shown);
  if (direct) return direct.year === d.year && direct.month === d.month && direct.day === d.day;
  const numbers = (shown.match(/\d+/g) ?? []).map(Number);
  const word = shown.split(/[^A-Za-z]+/).some((w) => w.length >= 3 && monthIndex(w) === d.month - 1);
  return numbers.includes(d.year) && numbers.includes(d.day) && (word || numbers.filter((n) => n === d.month).length >= (d.month === d.day ? 2 : 1));
}

/** The date format a box asks for in its placeholder or hint ("MM/DD/YYYY", "dd-mm-yyyy", "YYYY-MM-DD"), or null when it names none. */
export function dateFormatOf(text: string): string | null {
  // Italian "gg-mm-aaaa", French "jj/mm/aaaa" and German "TT.MM.JJJJ" name the same parts in their own letters.
  const local = text.replace(/\b(gg|jj|tt)(?=[\/.-])/gi, "dd").replace(/(?<=[\/.-])(gg|jj|tt)\b/gi, "dd").replace(/\b(aaaa|jjjj)\b/gi, "yyyy");
  const m = /\b(mm|dd|yyyy)([\/.-])(mm|dd|yyyy)\2(mm|dd|yyyy)\b/i.exec(local);
  // A month picker names a month and a year only ("mm-aaaa", "MM/YYYY").
  const my = m ? null : /\b(mm[\/.-]yyyy|yyyy[\/.-]mm)\b/i.exec(local);
  if (my) return (my[1] as string).toLowerCase();
  if (!m) return null;
  const parts = [m[1], m[3], m[4]].map((p) => (p as string).toLowerCase());
  return new Set(parts).size === 3 ? parts.join(m[2] as string) : null;
}

/** A date written the way a box asks for it: May 2027 in an MM/DD/YYYY box is 05/01/2027. A value that is not a date, or a box that names no format, is left as it is. */
export function shapedForBox(value: string, boxText: string): string {
  const d = toYmd(value);
  const format = dateFormatOf(boxText);
  if (!d || !format) return value;
  return format.replace(/yyyy/, String(d.year)).replace(/mm/, String(d.month).padStart(2, "0")).replace(/dd/, String(d.day).padStart(2, "0"));
}

/**
 * True when what a box shows is the value that was meant. Sites reshape what they are given: a phone
 * gains brackets, a link gains its scheme, a date is written in the box's own format, and a long
 * answer loses its double spaces. What they must not do is show something else.
 */
/** "Present" and its words in other languages: the end of a job the candidate still holds. */
export const PRESENT = /^(present|current|now|today|presente|attuale|ad oggi|oggi|in corso|actuel|aujourd'hui|aktuell|heute|actual|actualidad|atual)$/i;

export function showsValue(want: string, shown: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const w = norm(want);
  const s = norm(shown);
  if (!s) return false;
  if (w === s) return true;
  // One inside the other: a city shown with its region, a link shown without its scheme. A bare number is not loose like that.
  // Whole words only: "Male" is not inside "Female".
  const within = (outer: string, inner: string) => new RegExp(`(^|[^a-z0-9])${inner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(outer);
  if ((/[a-z]/.test(w) || w.length >= 4) && (within(s, w) || within(w, s))) return true;
  // Several things picked one by one from a list ("Excel, Word, Outlook" shown as "Microsoft Excel, Microsoft Word"):
  // one of them shown is the value taken.
  const items = w.split(",").map((x) => x.trim()).filter((x) => x.length >= 3);
  if (items.length >= 3 && items.some((x) => within(s, x))) return true;
  // Numbers: the same digits, or a phone shown with the country code the box added in front.
  const digits = (x: string) => x.replace(/\D/g, "");
  const dw = digits(w);
  const ds = digits(s);
  if (dw && ds && (dw === ds || (Math.min(dw.length, ds.length) >= 7 && (dw.endsWith(ds) || ds.endsWith(dw))))) return true;
  const d = toYmd(want);
  if (d && showsDate(shown, d)) return true;
  // "Present" written as this month by a box that has no word for it.
  const now = new Date();
  const asDate = toYmd(shown.trim());
  if (PRESENT.test(w) && asDate && asDate.year === now.getFullYear() && asDate.month === now.getMonth() + 1) return true;
  // A place picked from a list comes back in the list's own spelling: "Edmonton, Alberta, Canada" shows as "Edmonton, AB, CAN".
  const place = (x: string) => x.split(",")[0]?.trim() ?? "";
  if (w.includes(",") && s.includes(",") && place(w).length >= 3 && place(w) === place(s)) return true;
  // A pick shown as its short form: "Canada" chosen, "+1 CA" shown. Only a shown value made of short forms counts:
  // "I am a current SEL Employee" does not show "SEL Website" because both hold "SEL".
  const parts = s.split(/[^a-z]+/).filter(Boolean);
  if (/[a-z]/.test(w) && parts.length && parts.every((part) => part.length <= 3) && parts.some((part) => part.length >= 2 && (w.split(/[^a-z]+/)[0] ?? "").startsWith(part))) return true;
  const bare = (x: string) => x.replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
  return bare(w) === bare(s);
}
