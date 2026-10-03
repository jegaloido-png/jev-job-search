// Checks DECLINE_COOKIES against banner words. Usage: npx tsx data/try-decline.ts
import { DECLINE_COOKIES } from "../src/browser/submit.js";
const re = new RegExp(DECLINE_COOKIES, "i");
for (const t of ["Rifiuta tutti i cookie non necessari", "Decline all non-necessary cookies", "Accetta tutti i cookie", "Preferenze sui cookie", "NON ACCETTO", "Rifiuta"]) console.log(re.test(t), t);
