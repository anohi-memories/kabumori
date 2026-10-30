// Offline baseline: reads only committed files (the Phase 5 report and the ledger snapshot) and prints / writes the baseline.
//   deno run --no-config --allow-read [--allow-write=<out>] tools/provider-compare/scripts/baseline_report.ts [--out f.json]
import { loadLedgerSnapshot } from "../src/ledger_snapshot.ts";
import { runBaseline } from "../src/baseline_metrics.ts";

const report = JSON.parse(
  await Deno.readTextFile(new URL("../../../docs/model-optimization/phase5_report_2026-10-10.json", import.meta.url)),
);
const baseline = runBaseline(await loadLedgerSnapshot(), report);
console.log(JSON.stringify(baseline, null, 2));
const i = Deno.args.indexOf("--out");
if (i >= 0 && Deno.args[i + 1]) await Deno.writeTextFile(Deno.args[i + 1], JSON.stringify(baseline, null, 2) + "\n");
