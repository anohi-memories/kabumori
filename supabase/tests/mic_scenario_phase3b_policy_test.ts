// Source-only comparison against the exact pre-extraction evaluator.
// deno test --no-config --allow-run=git --allow-read this_file
import assert from "node:assert/strict";
import * as shared from "../functions/_shared/mic_scenario/policy.ts";
import * as evaluator from "../functions/market-intelligence-scenario-evaluator/mic_scenario_state_logic.ts";

Deno.test("Phase3B extraction: pre-candidate policy, trigger, fingerprint and confidence agree over boundary matrix", async () => {
  const result = await new Deno.Command("git", { args: ["show",
    "ecfab7a9a76e787ace3405f600871c1f52bcec11^:supabase/functions/market-intelligence-scenario-evaluator/mic_scenario_state_logic.ts"],
    stdout: "piped", stderr: "piped" }).output();
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
  const source = new TextDecoder().decode(result.stdout).replace('"./mic_scenario_types.ts"',
    JSON.stringify(new URL("../functions/market-intelligence-scenario-evaluator/mic_scenario_types.ts", import.meta.url).href));
  const original = await import(`data:application/typescript,${encodeURIComponent(source)}`) as typeof evaluator;
  const now = Date.parse("2026-09-29T05:00:00Z");
  assert.deepEqual(shared.FRESHNESS_HOURS, original.FRESHNESS_HOURS);
  for (const domain of shared.SCENARIO_DOMAINS) {
    for (const age of [-300001, -300000, 0, 36 * 3600000, 36 * 3600000 + 1, 96 * 3600000,
      96 * 3600000 + 1, 168 * 3600000, 840 * 3600000, 840 * 3600000 + 1]) {
      const at = new Date(now - age).toISOString();
      assert.equal(shared.classifyFreshness(domain, at, now), original.classifyFreshness(domain, at, now));
      for (const confidence of [0, 0.299, 0.3, 0.6, 0.7, 1, NaN, Infinity]) {
        const rows = shared.SCENARIO_DOMAINS.map((d, i) => ({ domain: d, narrative: "interpretation",
          bullish_factors: [], bearish_factors: [], key_risks: [], ai_confidence: 0.8,
          data_confidence: d === domain ? confidence : 0.9, coverage_status: "full", observation_status: "fresh",
          ai_evaluated_at: d === domain ? at : new Date(now).toISOString(),
          source_evaluation_run_id: `${i + 1}1111111-1111-4111-8111-111111111111` }));
        const current = shared.classifyStates(rows, now);
        const old = original.classifyStates(rows, now);
        assert.deepEqual(current, old);
        assert.equal(shared.confidenceCap(current.usable, current.excluded.length), original.confidenceCap(old.usable, old.excluded.length));
        assert.equal(evaluator.inputFingerprint(current.usable), original.inputFingerprint(old.usable));
        const seed = { updatedAt: new Date(now).toISOString(), sourceStateRunIds: [], sourceScenarioRunId: null, inputFingerprint: null };
        assert.deepEqual(evaluator.decideScenarioRegeneration(current, seed), original.decideScenarioRegeneration(old, seed));
        const cap = shared.confidenceCap(current.usable, current.excluded.length);
        assert.deepEqual(evaluator.clampScenarioConfidence(0.8, cap, "assessed"), original.clampScenarioConfidence(0.8, cap, "assessed"));
      }
    }
  }
});
