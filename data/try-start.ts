// Checks startDayOf. Usage: npx tsx data/try-start.ts
import { startDayOf } from "../src/forms/mapForm.js";
for (const w of ["Immediatamente (preavviso 2 settimane)", "subito", "1 mese", "dopo la laurea"]) console.log(w, "->", startDayOf(w, new Date(2026, 9, 3)));
