/**
 * Profile words written in English (countries, nationalities, languages, levels) and the words a form in Italian uses
 * for them. A list may name a country either way whatever language its labels are in, so a pick tries both.
 */
const PAIRS: [string, string][] = [
  ["Italy", "Italia"], ["Germany", "Germania"], ["France", "Francia"], ["Spain", "Spagna"], ["Switzerland", "Svizzera"],
  ["United Kingdom", "Regno Unito"], ["Italian", "Italiano"], ["English", "Inglese"], ["German", "Tedesco"],
  ["French", "Francese"], ["Spanish", "Spagnolo"], ["Native", "madrelingua"], ["Fluent", "fluente"], ["Female", "Femmina"],
  ["Male", "Maschio"],
];

const swap = (value: string, from: 0 | 1) => PAIRS.reduce((v, pair) => v.replace(new RegExp(`\\b${pair[from]}\\b`, "g"), pair[from === 0 ? 1 : 0]), value);

/** "Italy" as "Italia", "Italian (Native)" as "Italiano (madrelingua)". */
export const toItalian = (value: string) => swap(value, 0);
/** "Italia" as "Italy", "Italiano" as "Italian". */
export const toEnglish = (value: string) => swap(value, 1);
