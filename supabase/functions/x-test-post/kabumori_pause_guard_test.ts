// かぶモリ休止の停止候補（F2 2026-10-15）のオフライン検証。偽の通信だけ（実 HTTP・DB・X・課金なし）。
//   deno test --no-config --deny-net --deny-env --deny-write --allow-read supabase/functions/x-test-post/kabumori_pause_guard_test.ts
// index.ts は読み込むとサーバーが起動するため、組み込みの位置はソースの静的な検査で確かめる（runtime の証明ではない）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { BrandContext, BrandPublishMode } from "../_shared/brand/brand_context.ts";
import type { XAuthContext } from "../_shared/x_oauth2_post.ts";
import {
  assertKabumoriGenerationAllowed,
  authorizeKabumoriGenerationIngress,
  isKabumoriGenerationOnlyMode,
  KABUMORI_GENERATION_ONLY_MODES,
  kabumoriSendRecheck,
} from "./kabumori_pause_guard.ts";
import { runMorningGreetingManualPublish } from "./morning_greeting_publish_logic.ts";
import type { MorningGreetingPayloadDryRunResult } from "./morning_greeting_payload_logic.ts";

function context(publishMode: BrandPublishMode, overrides: { id?: string; isActive?: boolean; accountEnabled?: boolean } = {}): BrandContext {
  const id = overrides.id ?? "kabumori";
  return {
    brand: { id, display_name: id, is_active: overrides.isActive ?? true, publish_mode: publishMode, code_profile_key: id },
    socialAccount: { id: "acct", brand_id: id, platform: "x", handle: "h", publish_enabled: overrides.accountEnabled ?? true, oauth_client_ref: "default" },
    codeProfile: {} as BrandContext["codeProfile"],
    operationalSettings: { brand_id: id, fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: [] },
  };
}

const rejects = async (fn: () => Promise<unknown>, code: string) =>
  await assert.rejects(fn, (error: unknown) => error instanceof Error && error.message === code);

// ---- the helpers ------------------------------------------------------------------------------------------------------

test("send recheck: live passes; disabled / dry_run / inactive / account off / read error / other brand stop the send", async () => {
  await kabumoriSendRecheck(() => Promise.resolve(context("live")))();
  await rejects(kabumoriSendRecheck(() => Promise.resolve(context("disabled"))), "BRAND_PUBLISH_MODE_DISABLED");
  await rejects(kabumoriSendRecheck(() => Promise.resolve(context("dry_run"))), "BRAND_PUBLISH_MODE_DRY_RUN");
  await rejects(kabumoriSendRecheck(() => Promise.resolve(context("live", { isActive: false }))), "BRAND_DISABLED");
  await rejects(kabumoriSendRecheck(() => Promise.resolve(context("live", { accountEnabled: false }))), "BRAND_X_ACCOUNT_DISABLED");
  await rejects(kabumoriSendRecheck(() => Promise.reject(new Error("BRAND_CONTEXT_READ_FAILED"))), "BRAND_CONTEXT_READ_FAILED");
  await rejects(kabumoriSendRecheck(() => Promise.resolve(context("live", { id: "postona_user_a" }))), "KABUMORI_SEND_RECHECK_BRAND_MISMATCH");
});

test("send recheck reads the brand again on every call (a pause between two sends stops the second)", async () => {
  let mode: BrandPublishMode = "live";
  let reads = 0;
  const recheck = kabumoriSendRecheck(() => {
    reads += 1;
    return Promise.resolve(context(mode));
  });
  await recheck();
  mode = "disabled";
  await rejects(recheck, "BRAND_PUBLISH_MODE_DISABLED");
  assert.equal(reads, 2);
});

test("generation-only modes: allowed on live and dry_run, refused on disabled / inactive / read error", async () => {
  await assertKabumoriGenerationAllowed(() => Promise.resolve(context("live")));
  await assertKabumoriGenerationAllowed(() => Promise.resolve(context("dry_run")));
  await rejects(() => assertKabumoriGenerationAllowed(() => Promise.resolve(context("disabled"))), "BRAND_PUBLISH_MODE_DISABLED");
  await rejects(() => assertKabumoriGenerationAllowed(() => Promise.resolve(context("live", { isActive: false }))), "BRAND_DISABLED");
  await rejects(() => assertKabumoriGenerationAllowed(() => Promise.reject(new Error("BRAND_CONTEXT_READ_FAILED"))), "BRAND_CONTEXT_READ_FAILED");
  assert.ok(isKabumoriGenerationOnlyMode("morning_report_dry_run"));
  for (const mode of [undefined, null, "", "publish_morning_greeting_manual", "dispatch", "brand_post"]) {
    assert.equal(isKabumoriGenerationOnlyMode(mode), false, String(mode));
  }
});

test("ingress decision: caller first (a throwing / false check is 401 and the brand is not read), then the pause (423)", async () => {
  let brandReads = 0;
  const loadBrand = (mode: BrandPublishMode) => () => {
    brandReads += 1;
    return Promise.resolve(context(mode));
  };
  const safeCode = (error: unknown) => error instanceof Error ? error.message : "UNEXPECTED_ERROR";
  const cases: Array<[() => Promise<boolean>, BrandPublishMode, unknown]> = [
    [() => Promise.reject(new Error("AUTH_LOOKUP_CRASHED")), "live", { allowed: false, status: 401, error: "GENERATION_INGRESS_UNAUTHORIZED" }],
    [() => Promise.resolve(false), "live", { allowed: false, status: 401, error: "GENERATION_INGRESS_UNAUTHORIZED" }],
    [() => Promise.resolve(true), "disabled", { allowed: false, status: 423, error: "BRAND_PUBLISH_MODE_DISABLED" }],
    [() => Promise.resolve(true), "dry_run", { allowed: true }],
    [() => Promise.resolve(true), "live", { allowed: true }],
  ];
  for (const [isAdminCaller, mode, expected] of cases) {
    brandReads = 0;
    const decision = await authorizeKabumoriGenerationIngress({ isAdminCaller, loadBrand: loadBrand(mode), safeCode });
    assert.deepEqual(decision, expected);
    assert.equal(brandReads, (decision as { status?: number }).status === 401 ? 0 : 1, "the brand is read only for an authorized caller");
  }
});

// ---- morning greeting: the media upload and the post are both re-checked ------------------------------------------

const DATE = "2026-09-02";
const TEXT = "おはようございます☕️ 9月の朝ですね。今日も無理なく、ひとつずつ進めていきましょう🌿";

function freshXAuth(): XAuthContext {
  return {
    tokens: { accessToken: "x-secret", refreshToken: "refresh-old" },
    clientId: "client-id",
    clientSecret: "client-secret",
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-secret",
    refreshExecuted: false,
  };
}

function readyPayload(): MorningGreetingPayloadDryRunResult {
  return {
    success: true, date_jst: DATE, text: TEXT, theme: "generic", theme_name: null,
    visual_theme: "朝の窓辺", image_path: `storage://morning-greeting-assets/generated/${DATE}.png`, image_exists: true,
    theme_match: true, payload_ready: true, openai_text_api_called: 1, retry_count: 0, x_api_called: 0, x_posted: false,
    payload: { text: TEXT, image_path: `storage://morning-greeting-assets/generated/${DATE}.png`, scheduled_date: DATE, theme: "generic" },
  };
}

/** The greeting's whole I/O, faked; returns the X calls it saw. */
function greetingRun(beforeSend: (() => Promise<void>) | undefined) {
  const xCalls: string[] = [];
  const run = () =>
    runMorningGreetingManualPublish({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-secret",
      openAiApiKey: "openai-secret",
      brandId: "kabumori",
      xAuth: freshXAuth(),
      beforeSend,
      now: new Date("2026-09-01T15:30:00Z"),
      buildPayload: () => Promise.resolve(readyPayload()),
      fetchImpl: (input, init) => {
        const url = String(input);
        if (url.startsWith("https://api.x.com/")) xCalls.push(url);
        if (url.includes(`/published/${DATE}.json`) && !init?.method) {
          return Promise.resolve(new Response(JSON.stringify({ message: "Object not found" }), { status: 400 }));
        }
        if (url.includes("/rest/v1/publish_claims")) return Promise.resolve(Response.json([{ post_type: "morning_greeting", date_jst: DATE, status: "publishing" }]));
        if (url.includes("/storage/v1/object/")) {
          return Promise.resolve(new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } }));
        }
        if (url === "https://api.x.com/2/media/upload") return Promise.resolve(Response.json({ data: { id: "123456789" } }));
        if (url === "https://api.x.com/2/tweets") return Promise.resolve(Response.json({ data: { id: "987654321" } }));
        if (url.includes(`/published/${DATE}.json`)) return Promise.resolve(new Response(null, { status: 201 }));
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      },
    });
  return { run, xCalls };
}

test("greeting: live → the check runs before the upload and before the post, and both are sent", async () => {
  let checks = 0;
  const { run, xCalls } = greetingRun(() => {
    checks += 1;
    return Promise.resolve();
  });
  const result = await run();
  assert.equal(result.x_posted, true);
  assert.deepEqual(xCalls, ["https://api.x.com/2/media/upload", "https://api.x.com/2/tweets"]);
  assert.equal(checks, 2);
});

test("greeting: paused before the run reaches X → no X request at all", async () => {
  const { run, xCalls } = greetingRun(kabumoriSendRecheck(() => Promise.resolve(context("disabled"))));
  await assert.rejects(run);
  assert.deepEqual(xCalls, []);
});

test("greeting: paused between the upload and the post (in flight) → the post is not sent", async () => {
  let mode: BrandPublishMode = "live";
  const { run, xCalls } = greetingRun(async () => {
    const recheck = kabumoriSendRecheck(() => Promise.resolve(context(mode)));
    await recheck();
    mode = "disabled"; // the operator pauses right after the upload was allowed
  });
  await assert.rejects(run);
  assert.deepEqual(xCalls, ["https://api.x.com/2/media/upload"], "the media upload went out, the tweet did not");
});

// ---- index.ts wiring (static: index.ts starts a server when imported) -----------------------------------------------

const INDEX = await readFile(new URL("./index.ts", import.meta.url), "utf8");

function postToXBody(): string {
  const start = INDEX.indexOf("async function postToX(");
  const end = INDEX.indexOf("async function postThreadToX(", start);
  assert.ok(start > 0 && end > start);
  return INDEX.slice(start, end);
}

test("wiring: on Kabumori's legacy auth every X create request is preceded by beforeSend (incl. after a refresh)", () => {
  const body = postToXBody();
  const legacy = body.slice(body.indexOf("let result = await requestXPost(") - 60);
  const requests = [...legacy.matchAll(/requestXPost\(/g)].map((match) => match.index!);
  const checks = [...legacy.matchAll(/await auth\.beforeSend\?\.\(\);/g)].map((match) => match.index!);
  assert.equal(requests.length, 2, "first try and the retry after refresh");
  assert.equal(checks.length, 2);
  for (let index = 0; index < requests.length; index += 1) assert.ok(checks[index] < requests[index], `check ${index} precedes request ${index}`);
  // The Vault branch keeps its own beforeCreate and is not routed through beforeSend.
  const vault = body.slice(body.indexOf("if (auth.vaultAccount) {"), body.indexOf("return sent.body;"));
  assert.ok(vault.includes("await beforeCreate?.();"));
  assert.ok(!vault.includes("beforeSend"));
});

test("wiring: both Kabumori legacy auth contexts (scheduled and manual greeting) carry the send recheck, and the greeting gets it", () => {
  const recheck = /beforeSend: kabumoriSendRecheck\(\(\) =>\s*loadBrandContext\(\{ supabaseUrl, serviceRoleKey, brandId: LEGACY_KABUMORI_BRAND_ID \}\)\s*\)/g;
  assert.equal([...INDEX.matchAll(recheck)].length, 2);
  assert.equal([...INDEX.matchAll(/runMorningGreetingManualPublish\(\{[^}]*beforeSend: (?:manualXAuth|xAuth)\.beforeSend/gs)].length, 2);
  // The scheduled recheck is attached only on the legacy Kabumori branch (after the non-Kabumori Vault return).
  const vaultReturn = INDEX.indexOf("vaultAccount,\n        };\n      }");
  const scheduledRecheck = INDEX.indexOf("beforeSend: kabumoriSendRecheck", vaultReturn);
  assert.ok(vaultReturn > 0 && scheduledRecheck > vaultReturn);
});

test("wiring: the generation-only gate runs before every generation-only handler, and the mode list matches index.ts", () => {
  const gate = INDEX.indexOf("if (isKabumoriGenerationOnlyMode(requestBody.mode))");
  assert.ok(gate > 0);
  for (const handler of [
    "if (isMorningGreetingPayloadTest)", "if (isMorningGreetingImageTest)", "if (isMorningReportDryRun)", "if (isCloseReportDryRun)",
    "if (isUsPremarketDryRun)", "if (isVoiceDryRun)", "if (isUsefulTipDryRun)",
  ]) {
    const at = INDEX.indexOf(handler);
    assert.ok(at > gate, `${handler} after the gate`);
  }
  const literal = [...INDEX.matchAll(/requestBody\.mode === "([a-z_]+_dry_run)"/g)].map((match) => match[1]);
  for (const mode of literal) assert.ok(KABUMORI_GENERATION_ONLY_MODES.includes(mode), `${mode} is gated`);
  assert.equal(KABUMORI_GENERATION_ONLY_MODES.length, literal.length + 2, "the five dry runs plus the two greeting tests");
  // The manual publish mode is not generation-only: it posts, and keeps its own publish gate.
  assert.equal(isKabumoriGenerationOnlyMode("publish_morning_greeting_manual"), false);
});
