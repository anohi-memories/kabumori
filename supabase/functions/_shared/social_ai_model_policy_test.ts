// The central X / social auto-post text-model policy, and the drift guard that keeps model ids and token
// rates in that one file. Scope is X / social auto-post only (POSTONA, AI Lab, かぶモリ X); the Kabumori
// app's reports, news monitoring and MIC own their model decisions elsewhere and are not scanned here.
import assert from "node:assert/strict";
import test from "node:test";
import {
  isSocialQualityTextModel,
  SOCIAL_AI_WORKLOADS,
  SOCIAL_TEXT_MODELS,
  socialTextModel,
  socialTextModelCostUsd,
  socialTextModelTokenCostUsd,
} from "./social_ai_model_policy.ts";

test("catalog: routine tier is gpt-6-luna at $0.10/$0.50, quality tier is gpt-6.1-sol at $2/$10 per 1M tokens", () => {
  assert.deepEqual(SOCIAL_TEXT_MODELS, {
    fast: { id: "gpt-6-luna", inputUsdPer1M: 0.10, outputUsdPer1M: 0.50 },
    quality: { id: "gpt-6.1-sol", inputUsdPer1M: 2.00, outputUsdPer1M: 10.00 },
  });
});

test("workloads: every routine X/social workload resolves to Luna, every existing escalation to Sol", () => {
  const luna = [
    "postonaConsult",
    "brandPostGeneration",
    "kabumoriXText",
    "kabumoriXWebSearchCollection",
    "kabumoriXVoiceEvaluation",
    "kabumoriXVoiceRewrite",
    "kabumoriXMorningGreeting",
    "usefulTipBase",
    "usPremarketBase",
  ] as const;
  const sol = ["usefulTipQualityEscalation", "usPremarketQualityEscalation"] as const;
  for (const workload of luna) assert.equal(socialTextModel(workload), "gpt-6-luna", workload);
  for (const workload of sol) assert.equal(socialTextModel(workload), "gpt-6.1-sol", workload);
  // Nothing is mapped implicitly: the table is exactly these workloads.
  assert.deepEqual(Object.keys(SOCIAL_AI_WORKLOADS).sort(), [...luna, ...sol].sort());
  assert.equal(isSocialQualityTextModel(socialTextModel("usefulTipQualityEscalation")), true);
  assert.equal(isSocialQualityTextModel(socialTextModel("usefulTipBase")), false);
  assert.equal(isSocialQualityTextModel("gpt-5.6-sol"), false);
});

test("cost: exact token prices per tier, rounded once; unknown models are refused", () => {
  assert.equal(socialTextModelCostUsd("gpt-6-luna", 1_000_000, 1_000_000), 0.6);
  assert.equal(socialTextModelCostUsd("gpt-6.1-sol", 1_000_000, 1_000_000), 12);
  assert.equal(socialTextModelCostUsd("gpt-6-luna", 150, 90), 0.00006);
  assert.equal(socialTextModelCostUsd("gpt-6.1-sol", 150, 90), 0.0012);
  assert.equal(socialTextModelTokenCostUsd("gpt-6-luna", 1, 0), 0.1 / 1_000_000);
  // Never a 6-series call at stale 5.6 prices (Luna 0.2/1.2, Sol 5/30).
  assert.notEqual(socialTextModelCostUsd("gpt-6-luna", 1_000_000, 1_000_000), 1.4);
  assert.notEqual(socialTextModelCostUsd("gpt-6.1-sol", 1_000_000, 1_000_000), 35);
  assert.throws(() => socialTextModelCostUsd("gpt-5.6-luna" as never, 1, 1), /SOCIAL_TEXT_MODEL_UNKNOWN/u);
});

// --- drift guard ------------------------------------------------------------------------------------

const functionsDir = new URL("../", import.meta.url);
/** X / social auto-post runtime: these directories' non-test sources (G2 / news / MIC are not listed). */
const SCOPE_DIRS = ["x-test-post", "_shared/brand", "social-mobile-consult", "social-mobile-brand-dry-run", "social-mobile-history-learning", "social-mobile-publish-setting"];
const POLICY_FILE = "_shared/social_ai_model_policy.ts";

async function scopeSources(): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = [];
  for (const dir of SCOPE_DIRS) {
    for await (const entry of Deno.readDir(new URL(`${dir}/`, functionsDir))) {
      if (!entry.isFile || !entry.name.endsWith(".ts") || entry.name.endsWith("_test.ts")) continue;
      const path = `${dir}/${entry.name}`;
      out.push({ path, text: await Deno.readTextFile(new URL(path, functionsDir)) });
    }
  }
  out.push({ path: POLICY_FILE, text: await Deno.readTextFile(new URL(POLICY_FILE, functionsDir)) });
  return out;
}

test("drift: no 5.6 text model and no raw Luna/Sol id outside the central policy in X/social runtime", async () => {
  const sources = await scopeSources();
  assert.ok(sources.length > 40, "scope actually scanned");
  for (const { path, text } of sources) {
    assert.doesNotMatch(text, /gpt-5\.6-(luna|sol)/u, `${path} still names a 5.6 model`);
    if (path === POLICY_FILE) continue;
    assert.doesNotMatch(text, /["'`]gpt-[0-9][0-9.]*-(luna|sol)\b/u, `${path} hard-codes a text model id; use socialTextModel()`);
  }
});

test("drift: token rates live only in the policy (no per-file rate tables or per-million math)", async () => {
  for (const { path, text } of await scopeSources()) {
    if (path === POLICY_FILE) continue;
    // Per-million token math, or a rate table such as { input: 0.2, output: 1.2 } (zero token counters
    // like { input: 0, output: 0 } are usage defaults, not rates).
    assert.doesNotMatch(text, /\/\s*1_000_000|\/\s*1000000|\{\s*input:\s*(?!0\s*,)[0-9.]+,\s*output:\s*(?!0\s*\})[0-9.]+\s*\}/u, `${path} computes token cost locally`);
  }
});

test("wiring: each X/social caller resolves its model through the policy", async () => {
  const read = (path: string) => Deno.readTextFile(new URL(path, functionsDir));
  assert.match(await read("social-mobile-consult/logic.ts"), /export const CONSULT_MODEL = socialTextModel\("postonaConsult"\);/u);
  const generator = await read("_shared/brand/brand_post_generator.ts");
  assert.match(generator, /const MODEL = socialTextModel\("brandPostGeneration"\);/u);
  assert.match(generator, /socialTextModelCostUsd\(MODEL, input, output\)/u);
  // POSTONA preview, POSTONA live and AI Lab all generate through that one generator (no own model).
  for (const path of ["social-mobile-brand-dry-run/logic.ts", "_shared/brand/vault_account_brand_post.ts", "_shared/brand/ai_lab_scheduled_brand_post.ts"]) {
    const text = await read(path);
    assert.match(text, /generateBrandPost|BrandPostDraft/u, path);
    assert.doesNotMatch(text, /socialTextModel\(|model:\s*["']/u, `${path} must not pick its own model`);
  }
  assert.match(await read("x-test-post/report_voice_rewrite_logic.ts"), /REPORT_VOICE_REWRITE_MODEL = socialTextModel\("kabumoriXVoiceRewrite"\)/u);
  assert.match(await read("x-test-post/morning_greeting_logic.ts"), /const MODEL = socialTextModel\("kabumoriXMorningGreeting"\);/u);
  const x = await read("x-test-post/index.ts");
  const count = (re: RegExp) => (x.match(re) ?? []).length;
  // Three web-search collections (morning / close / US premarket), unchanged in number.
  assert.equal(count(/model: socialTextModel\("kabumoriXWebSearchCollection"\), store: false/gu), 3);
  // Existing escalations keep their conditions; only the tier target comes from the policy.
  assert.equal(count(/socialTextModel\("usefulTipQualityEscalation"\), 2400, solAttempt\)/gu), 1);
  assert.match(x, /packet\.requires_sol\s+\? socialTextModel\("usPremarketQualityEscalation"\)\s+: socialTextModel\("usPremarketBase"\)/u);
  assert.equal(count(/model: socialTextModel\("kabumoriXVoiceEvaluation"\)/gu), 1);
  // Image generation is a separate model decision and stays as it is.
  assert.match(await read("x-test-post/morning_greeting_image_logic.ts"), /OPENAI_MORNING_GREETING_IMAGE_MODEL = "gpt-image-2"/u);
});
