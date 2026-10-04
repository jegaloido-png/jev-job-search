// Presses the open form's Next for one job, the way a run does, and prints the report. Usage: npx tsx data/try-next.ts <job id>
import { loadEnv } from "../src/config.js";
loadEnv();
const { nextPage } = await import("../src/browser/formRunner.js");
const { JevClient } = await import("../src/jev/client.js");
const { loadQueue } = await import("../src/jobs/queue.js");
const { loadProfile } = await import("../src/profile/schema.js");
const id = process.argv[2]!;
const e = loadQueue().entries.find((x) => x.job.id === id)!;
const r = await nextPage(new JevClient(), loadProfile(), e.job as never, { dry: false });
console.log(r.state, r.page, r.reason, r.stuck, r.fields.length);
process.exit(0);
