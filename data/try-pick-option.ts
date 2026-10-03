// Checks pickOption on an address list. Usage: npx tsx data/try-pick-option.ts
import { pickOption } from "../src/browser/dropdowns.js";
console.log(pickOption(["Via Roma, 1, 70131 Bari, Italy", "Via Roma, 1, 70028 Sannicandro di Bari, Italy", "70121 Bari, Italy", "Via Roma, 1, 70025 Grumo Appula, Italy"], "Via Roma 1, Bari, BA 70121, Italy", ["Bari", "Puglia", "Italy", "70121"]));
