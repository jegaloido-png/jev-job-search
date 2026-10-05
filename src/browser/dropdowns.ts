/**
 * Dropdowns. A component that keeps its options on its own props (react-select,
 * Ashby's search boxes) is read and set through them, which is instant. Anything
 * else is opened with a real click, searched by typing, and picked by clicking.
 */
import { BROWSER, FORM } from "../config.js";
import type { DumpedField } from "../forms/fields.js";
import { sleep, type Page } from "./cdp.js";
import { inFront, norm, shownValues, trace, type Point } from "./session.js";
import { showsValue } from "../util/dates.js";
import { toEnglish, toItalian } from "../forms/localWords.js";

/** Polls an open dropdown until its options settle, or until `enough` says the wanted one has arrived. */
async function waitOptions(page: Page, selector: string, typed: boolean, enough?: (opts: string[]) => boolean): Promise<string[]> {
  const deadline = Date.now() + (typed ? BROWSER.optionsMs : BROWSER.optionsMs / 4);
  const clean = (opts: string[]) => opts.filter((o) => !/^(loading|searching|no options|no results|type to search)/i.test(o));
  let last = "";
  let stable = 0;
  let opts: string[] = [];
  while (Date.now() < deadline) {
    await sleep(BROWSER.pollMs);
    opts = clean(await page.awj<string[]>("options", selector));
    if (enough) {
      if (enough(opts)) break;
      continue;
    }
    const sig = opts.join("|");
    stable = opts.length > 0 && sig === last ? stable + 1 : 0;
    last = sig;
    if (stable >= 1) break;
  }
  return opts;
}

/**
 * Picks the option that matches the wanted value. Among several matches, the one that names the
 * candidate's own city, region or country wins. A location like "Edmonton, Alberta, Canada" also
 * matches "Edmonton, AB, Canada": same first part, and at least one of the candidate's places named.
 * Returns null rather than something merely similar.
 */
/** The ways a list lets a person decline a voluntary question, in the languages the boards use. */
export const DECLINE = /prefer not|rather not|do not wish|don'?t wish|not wish to|decline|not to (say|disclose|answer|self.?identify)|choose not|preferisco non|non desider|non (voglio|intendo) (rispondere|dichiarare)|keine angabe|möchte (ich )?nicht|ne (souhaite|veux) pas|prefiero no|no deseo|prefiro não/i;

/** The same degree level in the words of other languages: a value matching the first is looked for as the second. */
const DEGREE_KIN: [RegExp, RegExp][] = [
  [/laurea (triennale|di primo livello)|^laurea$|bachelor|licence|grado/, /bachelor|\bba\b|\bbsc\b|undergraduate|laurea (triennale|di primo livello)|licence|grado|first.?level/],
  [/laurea (magistrale|specialistica)|master/, /master|\bmsc\b|\bma\b|postgraduate|laurea (magistrale|specialistica)|second.?level/],
  [/dottorato|ph\.?d|doctor/, /ph\.?d|doctor|dottorato/],
  [/diploma (di maturità|superiore)|high school|maturità|ragioneria/, /high school|secondary|diploma|maturità|a.?level/],
];

export function pickOption(options: string[], value: string, hints: string[], other = true): string | null {
  const want = norm(value);
  if (!want) return null;
  const found = pickIn(options, value, want, hints);
  if (found || !other) return found;
  // A list that names a country or a language in the other language ("Italia" in a list of English names, "Italy" in
  // an Italian one) is tried with the value in that language.
  for (const v of [toEnglish(value), toItalian(value)]) if (v !== value) {
    const kin = pickOption(options, v, hints, false);
    if (kin) return kin;
  }
  return null;
}

function pickIn(options: string[], value: string, want: string, hints: string[]): string | null {
  // Declining a voluntary question takes the list's own way of declining, and nothing near it: "I do not wish to
  // answer" is never matched by its words to "Bisexual" or "Non binary".
  if (DECLINE.test(value)) return options.find((o) => DECLINE.test(o)) ?? null;
  const word = (h: string) => new RegExp(`(^|[^a-z0-9])${norm(h).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
  const score = (o: string) => hints.filter((h) => h && word(h).test(norm(o))).length;
  const best = (pool: string[]) => [...pool].sort((a, b) => score(b) - score(a) || a.length - b.length)[0] ?? null;
  const exact = options.filter((o) => norm(o) === want);
  const starts = options.filter((o) => norm(o).startsWith(want));
  const includes = options.filter((o) => norm(o).includes(want));
  const pool = exact.length ? exact : starts.length ? starts : includes;
  if (pool.length) return best(pool);
  // A degree named the Italian way, in a list that names degrees in English (or the other way round).
  for (const [re, kin] of DEGREE_KIN) {
    if (!re.test(want)) continue;
    const same = options.filter((o) => kin.test(norm(o)));
    if (same.length) return best(same);
  }
  // A country asked as a nationality: "Italy" is "Italian", "Italiana", "Citizen (Italian)"; "Germany" is "German".
  // A one-word value matches a word that starts with all of it but its last letter.
  if (/^[a-z]{5,}$/.test(want)) {
    const stem = want.slice(0, -1);
    const kin = options.filter((o) => norm(o).split(/[^a-z]+/).some((w) => w.startsWith(stem) && w.length <= want.length + 4));
    if (kin.length) return best(kin);
  }
  // A street address comes back in the list's own order ("Via Roma 1, Bari" as "Via Roma, 1, 70131 Bari, Italy"):
  // the same street, the same house number, and one part that is the candidate's city once its postal code is taken off.
  const street = /^(\D+?)[\s,]+(\d+[a-z]?)$/i.exec((value.split(",")[0] ?? "").trim());
  const city = norm(value.split(",")[1] ?? "");
  if (street && city) {
    const [name, num] = [norm(street[1] as string), (street[2] as string).toLowerCase()];
    const same = options.filter((o) => {
      const n = norm(o);
      return n.includes(name) && new RegExp(`(^|[^0-9a-z])${num}([^0-9a-z]|$)`).test(n) && o.split(",").some((part) => norm(part.replace(/\d+/g, "")) === city);
    });
    if (same.length) return best(same);
  }
  const head = norm(value.split(",")[0] ?? "");
  if (!head || head === want) return null;
  // The city alone proves nothing (there is an Edmonton in Kentucky): a region or country of the candidate's must be named too.
  const beyondHead = hints.filter((h) => h && norm(h) !== head);
  const sameHead = options.filter((o) => norm(o.split(",")[0] ?? "") === head && beyondHead.some((h) => word(h).test(norm(o))));
  return best(sameHead);
}

async function openDropdown(page: Page, selector: string): Promise<boolean> {
  const p = await page.awj<Point>("point", selector);
  if (!p.ok) return false;
  await page.click(p.x, p.y);
  return true;
}

async function closeDropdown(page: Page): Promise<void> {
  await page.key("Escape");
  await page.evaluate("window.__awj.blur()");
}

/** Reads the options of one dropdown that only renders them once opened. */
export async function readOptions(page: Page, selector: string): Promise<string[]> {
  const react = () => page.awj<string[] | null>("reactOptions", selector);
  const opts = await react();
  if (opts?.length) return opts;
  if (opts !== null) {
    // A react-select with a lazy list: ask its own loader, or open it through its handler and watch.
    const viaLoader = await page.awj<string[] | null>("reactLoad", selector, "").catch(() => null);
    if (viaLoader?.length) return viaLoader;
    if (!(await page.awj<boolean>("reactMenu", selector, true))) return [];
    const deadline = Date.now() + BROWSER.optionsMs / 2;
    let loaded: string[] = [];
    while (!loaded.length && Date.now() < deadline) {
      await sleep(BROWSER.pollMs);
      loaded = (await react()) ?? [];
    }
    await page.awj("reactMenu", selector, false);
    return loaded;
  }
  return inFront(page, async () => {
    if (!(await openDropdown(page, selector))) return [];
    // A search typed into the menu on an earlier try would hide most of the list.
    if (await page.awj<boolean>("clearListSearch", selector)) await sleep(BROWSER.pollMs * 2);
    let seen = await waitOptions(page, selector, false);
    // A list that draws only the rows in view (Workday's prompts) is read whole by scrolling it, when it is short enough
    // to show JEV. A longer one is not shown as if its first rows were all: the box is searched instead.
    if (await page.awj<boolean>("listIsPartial", selector)) {
      const size = await page.awj<number>("listSize", selector);
      const all = new Set(seen);
      for (let i = 0; size <= FORM.maxOptionsSecondLook && all.size < size && i < 40 && (await page.awj<boolean>("scrollList", selector)); i++) {
        await sleep(BROWSER.pollMs);
        for (const o of await page.awj<string[]>("options", selector)) all.add(o);
      }
      seen = all.size >= size ? [...all] : [];
    }
    await closeDropdown(page);
    return seen;
  });
}

/** Gives every dropdown its real options, so JEV chooses among them. Long lists (countries, schools) are searched by typing instead. */
export async function readDropdownOptions(page: Page, fields: DumpedField[]): Promise<void> {
  await Promise.all(
    fields
      .filter((f) => f.kind === "combobox" && f.options.length === 0 && f.widget !== "panel")
      .map(async (f) => {
        const opts = await readOptions(page, f.selector);
        if (opts.length > 0 && opts.length <= FORM.maxOptionsForJev) f.options = opts.map((o) => ({ value: o, label: o }));
      }),
  );
}

/** Sets a react-select through its own handler: no clicks, no waiting on menus. Null when it cannot. */
async function fillDropdownDirect(page: Page, selector: string, value: string, hints: string[]): Promise<boolean | null> {
  const read = () => page.awj<string[] | null>("reactOptions", selector);
  let opts = await read();
  if (opts === null) return null;
  let choice = pickOption(opts, value, hints);
  if (!choice) {
    // A paginated list answers a search through its own loader in one round trip.
    const found = await page.awj<string[] | null>("reactLoad", selector, value).catch(() => null);
    choice = found ? pickOption(found, value, hints) : null;
  }
  if (!choice) {
    // A search-as-you-type list only loads while its menu counts as open, and it has to see that before the search text arrives.
    await page.awj("reactMenu", selector, true);
    await sleep(BROWSER.pollMs);
  }
  // A place is searched by its city first; anything else by the full value.
  const head = value.split(",")[0]?.trim() ?? "";
  for (const typed of choice ? [] : [...new Set(head && head !== value ? [head, value] : [value])]) {
    if (!(await page.awj<boolean>("reactSearch", selector, typed))) break;
    const begun = Date.now();
    let asked = 1;
    while (!choice && Date.now() - begun < BROWSER.optionsMs) {
      await sleep(BROWSER.pollMs);
      opts = (await read()) ?? [];
      choice = pickOption(opts, value, hints);
      // A search sent while the component was still mounting is dropped, so ask once more halfway through.
      if (!choice && !opts.length && asked === 1 && Date.now() - begun > BROWSER.optionsMs / 2) {
        asked = 2;
        await page.awj("reactSearch", selector, typed);
      }
    }
    if (choice) break;
    // Leave the search box empty again, so a fallback that types starts clean.
    await page.awj("reactSearch", selector, "");
  }
  if (!choice) await page.awj("reactMenu", selector, false);
  if (!choice) return false;
  return page.awj<boolean>("reactSelect", selector, choice);
}

/**
 * Sets a dropdown: through the component's own handlers when it has them, by clicking otherwise.
 * `byClicking` skips the first way, for a site where it is already known not to work.
 * Returns why it failed, or null, and which way set it.
 */
export async function fillDropdown(page: Page, selector: string, value: string, hints: string[], byClicking = false): Promise<{ why: string | null; method: "script" | "clicked" }> {
  if (!byClicking) {
    const direct = await fillDropdownDirect(page, selector, value, hints);
    if (direct) return { why: null, method: "script" };
    // The component itself said it has no such option, so typing the same text into it would only be slower.
    if (direct === false) return { why: `no option matches "${value}"`, method: "script" };
  }
  return { why: await fillDropdownByClicking(page, selector, value, hints), method: "clicked" };
}

export function fillDropdownByClicking(page: Page, selector: string, value: string, hints: string[]): Promise<string | null> {
  return inFront(page, () => clickAndPick(page, selector, value, hints));
}

async function clickAndPick(page: Page, selector: string, value: string, hints: string[], keep = false): Promise<string | null> {
  const prompt = await page.awj<boolean>("isPrompt", selector);
  // A list of several things for a prompt that takes many picks ("Excel, Word, Outlook" for the skills) is picked one
  // item at a time: the whole line is no row of the list. A place ("Bari, Italia") is one thing.
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (prompt && !keep && items.length > 1 && norm(items[0] ?? "") !== norm(hints[0] ?? "")) {
    let picked = 0;
    for (const item of items.slice(0, 5)) if (!(await clickAndPick(page, selector, item, hints, true))) picked++;
    trace(`dropdown ${selector}: ${picked} of ${Math.min(items.length, 5)} items picked one by one`);
    return picked ? null : `no option matches any of "${value}"`;
  }
  // A Workday prompt keeps every pick: one that is not the wanted value (left by an earlier try) is removed first.
  if (prompt && !keep && (await dropWrongPicks(page, selector, value))) return null;
  // A list that already shows the value keeps it: a committed choice is not picked again.
  const before = (await shownValues(page, [selector]))[0] ?? "";
  if (before && showsValue(value, before) && !(await page.awj<boolean>("pickPending", selector))) return null;
  // A list another control left open (an address's suggestions) would be read as this one's rows: it is closed first.
  await closeDropdown(page);
  if (!(await openDropdown(page, selector))) return "control not found";
  let opts = await waitOptions(page, selector, false);
  if (!opts.length) {
    // The first click may only have closed the list before it; a second one opens this list.
    await openDropdown(page, selector);
    opts = await waitOptions(page, selector, false);
  }
  // A list of Italian regions and provinces together (Workday: "Puglia" and "Bari"): the province is what the city box
  // is checked against ("Enter a city that is part of the region you entered"), so the candidate's city wins when it is
  // a province too. Hints are [city, region, region code, country].
  const [city, region] = hints;
  if (city && region && norm(value) === norm(region) && opts.some((o) => norm(o) === norm(city)) && opts.some((o) => norm(o) === norm(region))) value = city;
  let choice = pickOption(opts, value, hints);
  // A list that draws only the rows in view (Workday's prompts) may hold the row further down: the list is scrolled
  // until the row is drawn ("Website" under ten other sources), before any search. Only a short list: a long one
  // (countries, citizenships) is searched instead.
  const short = !choice && (await page.awj<boolean>("listIsPartial", selector)) && (await page.awj<number>("listSize", selector)) <= FORM.maxOptionsForJev;
  for (let i = 0; short && !choice && i < 10 && (await page.awj<boolean>("scrollList", selector)); i++) {
    await sleep(BROWSER.pollMs);
    const more = await page.awj<string[]>("options", selector);
    if (more.join("|") === opts.join("|")) break;
    opts = more;
    choice = pickOption(opts, value, hints);
  }
  if (!choice) {
    // Search-as-you-type lists. A place is searched by its city; anything else by the full value, then its first word.
    const head = value.split(",")[0]?.trim() ?? "";
    // A decline is searched by the words lists use for it; a word of one or two letters ("I") is never searched alone:
    // it matches nearly every row, and the list may keep the row it lit up.
    // A one-word value is also searched by its stem, which finds it in another language ("Economia" finds "Economics").
    const stem = /^\p{L}{6,}$/u.test(value.trim()) ? value.trim().slice(0, -2) : "";
    // A country or a language is also searched in the other language ("Italia" in a list of English names).
    const otherWords = [toEnglish(head || value), toItalian(head || value)].filter((v) => v !== (head || value));
    const attempts = DECLINE.test(value) ? ["prefer", "decline", "wish", "not", "non"] : [...(head && head !== value ? [head, value] : [value, value.split(/\s+/)[0] ?? "", stem]), ...otherWords];
    for (const typed of [...new Set(attempts)]) {
      if (!typed || typed.length < 3) continue;
      // Keys go wherever the focus is. A click that did not put it in this box (the window was still coming to the front) is made good here.
      if (!(await page.awj<boolean>("hasFocus", selector)) && !(await page.awj<boolean>("focus", selector))) break;
      // A Workday prompt's search box keeps what an earlier try typed: it is emptied first. (Elsewhere a Backspace could
      // remove a choice already made.)
      // A text box that is the list's own search box and shows another value (SuccessFactors' picklist shows the
      // current choice in it) is emptied too, or the search text lands after it.
      const ownText = await page.call<string>("function (s) { const el = window.__awj.q(s); return el && el.tagName === 'INPUT' && el.type !== 'hidden' ? el.value : ''; }", selector).catch(() => "");
      if ((await page.awj<boolean>("isPrompt", selector)) || ownText) {
        await page.awj("selectAll");
        await page.key("Backspace");
      }
      await page.type(typed);
      // The first word only widens the search. The pick still has to match the whole value.
      opts = await waitOptions(page, selector, true, (seen) => pickOption(seen, value, hints) !== null);
      choice = pickOption(opts, value, hints);
      if (choice) break;
      // A list that filters only on key events (SuccessFactors' paginated picklist, 100 rows a page) ignores pasted
      // text: the same words are typed again key by key.
      if (!(await page.awj<boolean>("isPrompt", selector))) {
        for (let i = 0; i < typed.length; i++) await page.key("Backspace");
        await page.typeKeys(typed);
        opts = await waitOptions(page, selector, true, (seen) => pickOption(seen, value, hints) !== null);
        choice = pickOption(opts, value, hints);
        if (choice) break;
      }
      // A list that searches only on Enter (Workday's prompt), and picks a lone match by itself. Elsewhere Enter would
      // take whatever row is highlighted, so only there.
      if (!(await page.awj<boolean>("isPrompt", selector))) {
        for (let i = 0; i < typed.length; i++) await page.key("Backspace");
        continue;
      }
      await page.key("Enter");
      await sleep(BROWSER.pollMs * 4);
      const picked = (await shownValues(page, [selector]))[0] ?? "";
      if (picked && (showsValue(value, picked) || pickOption([picked], value, hints))) return null;
      // Enter picks a lone match by itself, whatever it is ("Non Vedenti (Italy)" for the search "non"): a pick that
      // does not hold the wanted value is taken off at once, and the box is opened again for the next search.
      if (picked && !before) {
        trace(`dropdown ${selector}: Enter picked "${picked.slice(0, 40)}" for "${value.slice(0, 40)}", taken off`);
        await dropWrongPicks(page, selector, value);
        await openDropdown(page, selector);
        await waitOptions(page, selector, false);
        continue;
      }
      opts = await waitOptions(page, selector, true, (seen) => pickOption(seen, value, hints) !== null);
      choice = pickOption(opts, value, hints);
      if (choice) break;
      for (let i = 0; i < typed.length; i++) await page.key("Backspace");
    }
  }
  if (!choice) {
    await closeDropdown(page);
    // A list that was empty before is left empty: a row the search lit up is not kept as a choice nobody made.
    if (!before && (await page.awj<boolean>("isPrompt", selector))) await dropWrongPicks(page, selector, value);
    const now = (await shownValues(page, [selector]))[0] ?? "";
    if (!before && now && (await page.awj<boolean>("focus", selector))) {
      await page.awj("selectAll");
      await page.key("Backspace");
      await page.key("Escape");
      await page.evaluate("window.__awj.blur()");
      trace(`dropdown ${selector}: no option matched, "${now.slice(0, 40)}" taken off again`);
    }
    // A drawn list that showed no rows (inRecruiting's bootstrap-select, now and then): the real <select> behind it is picked.
    const twin = await page.awj<string[]>("twinOptions", selector).catch(() => [] as string[]);
    const pick = twin.length ? pickOption(twin, value, hints) : null;
    if (pick && (await page.awj<boolean>("selectTwin", selector, pick))) {
      await sleep(BROWSER.pollMs);
      const shown = (await shownValues(page, [selector]))[0] ?? "";
      if (showsValue(pick, shown)) return null;
    }
    return `no option matches "${value}"${opts.length ? ` among: ${opts.slice(0, 12).join(" | ")}` : ""}`;
  }
  // Finding the option scrolls it into view, and a list drawn beside its box moves with the box a moment later.
  // The point is read again once the page has settled, so the click lands on this row and not the one below.
  let p = await page.awj<Point>("optionPoint", selector, choice);
  if (p.ok) {
    await sleep(BROWSER.pollMs);
    p = await page.awj<Point>("optionPoint", selector, choice);
  }
  if (!p.ok) {
    await closeDropdown(page);
    return `option "${choice}" could not be clicked`;
  }
  await page.click(p.x, p.y);
  await sleep(BROWSER.pollMs);
  // A row that opens a list of its own (Workday's "How did you hear about us?": "Job Posting Sites" > "LinkedIn"):
  // nothing is picked yet and other rows are shown. The row that best fits the wanted value is taken there, a few levels deep.
  const top = choice;
  for (let depth = 0; depth < 3 && !((await shownValues(page, [selector]))[0] ?? ""); depth++) {
    let sub = await waitOptions(page, selector, false);
    if (!sub.length || sub.join("|") === opts.join("|")) break;
    let next = pickOption(sub, value, hints);
    // A list inside the row that draws only the rows in view ("Italy" > "Citizen (Aruba)", "Citizen (Algeria)"…) is
    // scrolled to the wanted row. Its first drawn row is never taken in the wanted row's place.
    const partial = await page.awj<boolean>("listIsPartial", selector);
    for (let i = 0; partial && !next && i < 60 && (await page.awj<boolean>("scrollList", selector)); i++) {
      await sleep(BROWSER.pollMs);
      sub = await page.awj<string[]>("options", selector);
      next = pickOption(sub, value, hints);
    }
    if (!next && !partial) next = subRow(sub, value);
    const q = next ? await page.awj<Point>("optionPoint", selector, next) : null;
    if (!next || !q?.ok) break;
    await page.click(q.x, q.y);
    await sleep(BROWSER.pollMs * 2);
    opts = sub;
    choice = next;
  }
  // The pick was made inside the row that was asked for: the box is marked with that row, so reading it back shows
  // "Corporate Website > Company Website" and the wanted "Corporate Website" is seen to be there.
  if (choice !== top) await page.call("function (s, under) { const el = window.__awj.q(s); if (el) el.setAttribute('data-awj-under', under); }", selector, top);
  let shown = (await shownValues(page, [selector]))[0] ?? "";
  // A list that moved under the pointer as it opened (SuccessFactors draws its rows twice, then drops one copy) took the
  // row next to the wanted one: it is opened again and the wanted row clicked once more, where it now is.
  if (shown && choice === top && !showsValue(choice, shown) && !showsValue(value, shown)) {
    trace(`dropdown ${selector}: "${shown.slice(0, 40)}" taken in place of "${choice}", clicking it again`);
    await openDropdown(page, selector);
    await waitOptions(page, selector, false);
    await sleep(BROWSER.pollMs * 2);
    const again = await page.awj<Point>("optionPoint", selector, choice);
    if (again.ok) {
      await page.click(again.x, again.y);
      await sleep(BROWSER.pollMs * 2);
      shown = (await shownValues(page, [selector]))[0] ?? "";
    } else await closeDropdown(page);
  }
  if (shown && !showsValue(choice, shown) && !showsValue(value, shown)) return `the list shows "${shown.slice(0, 40)}" after "${choice}" was clicked`;
  if (!shown && (await page.awj<boolean>("isPrompt", selector))) return `nothing was picked after "${choice}" was clicked`;
  return null;
}

/**
 * Takes off a Workday prompt's picks that do not hold the wanted value. True when a pick holding it stays.
 * A pick holds the value when it names it whole ("Citizen (Italy)" for Italy); the looser page check would take
 * "Citizen (Italy)" for "Citizen (Nepal)".
 */
async function dropWrongPicks(page: Page, selector: string, value: string): Promise<boolean> {
  const holds = (label: string) => norm(label) === norm(value) || norm(label).includes(norm(value)) || pickOption([label], value, []) !== null;
  for (let i = 0; i < 6; i++) {
    const picks = await page.awj<(Point & { label: string })[]>("promptPicks", selector);
    const wrong = picks.find((p) => p.ok && !holds(p.label));
    if (!wrong) return picks.some((p) => holds(p.label));
    await page.click(wrong.x, wrong.y);
    await sleep(BROWSER.pollMs * 3);
    // Removing a pick opens the list; it is closed so the next click opens it afresh with the keyboard in the box.
    await closeDropdown(page);
    await sleep(BROWSER.pollMs * 2);
  }
  return false;
}

/** In a list opened from another row: the row sharing a word with the wanted value, else a general one (a website, "other"), else the first. */
function subRow(rows: string[], value: string): string | null {
  const words = norm(value).split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  return (
    rows.find((r) => words.some((w) => norm(r).includes(w))) ??
    rows.find((r) => /linkedin|website|web site|sito|internet|online|career|carriere|other|altro|altri/i.test(r)) ??
    rows[0] ??
    null
  );
}

/**
 * A combobox that opens a panel of fields of its own (inRecruiting's address: country, then "postal code or city",
 * from which the site fills in the rest). The panel is opened, the candidate's postal code is typed into its search
 * box, then the city, and the suggestion that names the candidate's places is clicked. Returns why it failed, or null.
 */
export function fillPanel(page: Page, selector: string, searches: string[], hints: string[], street = ""): Promise<string | null> {
  return inFront(page, async () => {
    const why = await panelOnce(page, selector, searches, hints, street);
    // A panel left open covers the fields below it, filled or not: the next field's click would land in its lists
    // (the country list's first row, "Andorra"). So it is closed before anything else is filled.
    if ((await page.awj<unknown[]>("panelBoxes", selector)).length) {
      await page.key("Escape");
      if ((await page.awj<unknown[]>("panelBoxes", selector)).length) {
        const p = await page.awj<Point>("point", selector);
        if (p.ok) await page.click(p.x, p.y);
      }
    }
    return why;
  });
}

async function panelOnce(page: Page, selector: string, searches: string[], hints: string[], street: string): Promise<string | null> {
  {
    const p = await page.awj<Point>("point", selector);
    if (!p.ok) return "control not found";
    await page.click(p.x, p.y);
    let boxes: { selector: string; label: string; value: string }[] = [];
    const deadline = Date.now() + BROWSER.optionsMs;
    let clickedAgain = false;
    while (!boxes.length && Date.now() < deadline) {
      await sleep(BROWSER.pollMs);
      boxes = await page.awj("panelBoxes", selector);
      // The first click may only have closed another popup (a calendar left open); a second one opens the panel.
      if (!boxes.length && !clickedAgain && Date.now() > deadline - BROWSER.optionsMs / 2) {
        clickedAgain = true;
        await page.key("Escape");
        const again = await page.awj<Point>("point", selector);
        if (again.ok) await page.click(again.x, again.y);
      }
    }
    // A panel that starts with an empty country keeps its other boxes switched off until one is picked.
    const country = await page.awj<{ selector: string; label: string; value: string } | null>("panelCountry", selector);
    // The first letters find the country in any language the list is written in: "Ital" is Italia, Italy, Italien.
    const countryName = hints[hints.length - 1] ?? "";
    const countryStart = countryName.slice(0, 4);
    // A country the panel set by itself (the list's first, "Andorra") is as good as none.
    if (country && country.label && countryStart && !norm(country.value).startsWith(norm(countryStart))) {
      if (await page.awj<boolean>("focus", country.selector)) {
        await page.evaluate("window.__awj.selectAll()");
        await page.key("Backspace");
        await page.typeKeys(countryStart);
        let label: string | undefined;
        const until = Date.now() + BROWSER.optionsMs;
        while (!label && Date.now() < until) {
          await sleep(BROWSER.pollMs * 2);
          label = (await page.awj<(Point & { label: string })[]>("suggestions", countryStart)).find((r) => r.ok && norm(r.label).startsWith(norm(countryStart)))?.label;
        }
        const row = label ? await page.awj<Point & { label: string }>("suggestionPoint", countryStart, label) : undefined;
        if (row?.ok) {
          await page.click(row.x, row.y);
          await sleep(BROWSER.pollMs * 3);
        }
      }
      boxes = await page.awj("panelBoxes", selector);
    }
    if (!boxes.length) return "the panel opened no box to type in";
    // The search box: the one asking for a postal code or a city, else the first empty one.
    // The search box is emptied before typing, so one that still shows a placeholder or an old search is fine.
    const SEARCH = /\b(cap|postal|zip|plz|code postal|citt[aà]|city|comune|town)\b/i;
    // The panel draws its boxes one after another; the search box can come a moment after the country.
    for (const until = Date.now() + BROWSER.optionsMs; !boxes.some((b) => SEARCH.test(b.label)) && Date.now() < until; ) {
      await sleep(BROWSER.pollMs * 2);
      boxes = await page.awj("panelBoxes", selector);
    }
    const box = boxes.find((b) => SEARCH.test(b.label)) ?? boxes.find((b) => !b.value);
    if (!box) return `the panel has no search box among: ${boxes.map((b) => `${b.label || "?"}=${b.value}`).join(", ")}`;
    for (const typed of searches.filter(Boolean)) {
      if (!(await page.awj<boolean>("focus", box.selector))) return "could not focus the panel's search box";
      await page.evaluate("window.__awj.selectAll()");
      await page.key("Backspace");
      await page.typeKeys(typed);
      let rows: (Point & { label: string })[] = [];
      let choice: string | null = null;
      const until = Date.now() + BROWSER.optionsMs;
      while (!choice && Date.now() < until) {
        await sleep(BROWSER.pollMs * 2);
        rows = await page.awj("suggestions", typed);
        choice = pickOption(rows.map((r) => r.label), typed, hints);
      }
      const row = choice ? await page.awj<Point & { label: string }>("suggestionPoint", typed, choice) : undefined;
      if (!row?.ok) continue;
      await page.click(row.x, row.y);
      await sleep(BROWSER.pollMs * 3);
      // Only an address naming what was searched counts: a country alone, or another town, is not the candidate's.
      const shown = norm(await page.awj<string>("shown", selector));
      if (searches.some((x) => x && shown.includes(norm(x)))) {
        await streetInPanel(page, selector, street);
        return null;
      }
      trace(`panel ${selector}: "${choice}" was clicked, the panel shows "${shown.slice(0, 60)}"`);
    }
    return `no suggestion matched ${searches.filter(Boolean).join(" or ")}`;
  }
}

/**
 * A panel that wants the full address (inRecruiting's "Indirizzo di residenza") draws a street box and a house-number
 * box once the town is picked, and refuses the address without them. Empty ones get the candidate's street and number.
 */
async function streetInPanel(page: Page, selector: string, street: string): Promise<void> {
  if (!street) return;
  await sleep(BROWSER.pollMs * 3);
  const boxes = await page.awj<{ selector: string; label: string; value: string }[]>("panelBoxes", selector);
  const m = /^(.*?)[,\s]+(\d+[a-z]?(\/\d+)?)\s*$/i.exec(street.trim());
  const [road, number] = m ? [m[1]!.trim(), m[2]!] : [street.trim(), ""];
  const NUMBER = /\b(civico|n\.?\s*civ|numero|number|house ?n|hausnummer|num[eé]ro)\b/i;
  const ROAD = /\b(indirizzo|via|street|address|strada|stra(ss|ß)e|rue|calle|direcci[oó]n)\b/i;
  for (const b of boxes.filter((x) => !x.value)) {
    const value = NUMBER.test(b.label) ? number : ROAD.test(b.label) ? road : "";
    if (!value || !(await page.awj<boolean>("focus", b.selector))) continue;
    await page.typeKeys(value);
    await page.key("Tab");
    trace(`panel ${selector}: "${b.label}" typed "${value}"`);
  }
}

/** The options most like the wanted value, by shared word stems, so a list of hundreds fits in one JEV question. */
export function closestOptions(options: string[], wanted: string, limit: number): string[] {
  if (options.length <= limit) return options;
  const stems = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3).map((w) => w.slice(0, 5));
  const want = new Set(stems(wanted));
  const scored = options.map((o) => ({ o, score: stems(o).filter((w) => want.has(w)).length + (norm(o).includes(norm(wanted)) ? 2 : 0) }));
  const hits = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.o.length - b.o.length);
  return (hits.length ? hits : scored).slice(0, limit).map((x) => x.o);
}

/** Every option a search-as-you-type list offers for the wanted value: its starting list plus a search per word stem. */
export async function candidateOptions(page: Page, selector: string, wanted: string): Promise<string[]> {
  const found = new Set(await readOptions(page, selector));
  // A Workday prompt shows only the first rows of a long list and searches on Enter: each telling word of the wanted
  // value is searched ("Econom" finds Economics for "Economia", "Bari" the university for "Università degli Studi di Bari").
  if (await page.awj<boolean>("isPrompt", selector)) {
    const GENERIC = /^(universit|degli|della|studi|studies|school|scuola|istituto|institute|college|politecnico|academy|accademia|the|and|per|with)/;
    const words = norm(wanted).normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    for (const word of [...words.filter((w) => !GENERIC.test(w)), ...words.filter((w) => GENERIC.test(w))].slice(0, 3)) {
      for (const o of await promptSearch(page, selector, word.slice(0, 6))) found.add(o);
    }
    return [...found];
  }
  for (const word of norm(wanted).split(/[^a-z0-9]+/).filter((w) => w.length >= 4)) {
    const more = await page.awj<string[] | null>("reactLoad", selector, word.slice(0, 6)).catch(() => null);
    for (const o of more ?? []) found.add(o);
  }
  return [...found];
}

/** The rows a Workday prompt shows for a search, read without keeping any pick the search made. */
function promptSearch(page: Page, selector: string, typed: string): Promise<string[]> {
  return inFront(page, async () => {
    const before = (await page.awj<{ label: string }[]>("promptPicks", selector)).map((p) => p.label);
    if (!(await openDropdown(page, selector))) return [];
    if (!(await page.awj<boolean>("hasFocus", selector)) && !(await page.awj<boolean>("focus", selector))) return [];
    await page.awj("selectAll");
    await page.key("Backspace");
    await page.type(typed);
    await page.key("Enter");
    const seen = await waitOptions(page, selector, true);
    await page.awj("selectAll");
    await page.key("Backspace");
    await closeDropdown(page);
    // Enter picks a lone match by itself; the search was only to read the rows, so such a pick is taken off again.
    for (const p of await page.awj<(Point & { label: string })[]>("promptPicks", selector)) {
      if (before.includes(p.label) || !p.ok) continue;
      await page.click(p.x, p.y);
      await sleep(BROWSER.pollMs * 3);
      seen.push(p.label);
    }
    await closeDropdown(page);
    return seen;
  });
}
