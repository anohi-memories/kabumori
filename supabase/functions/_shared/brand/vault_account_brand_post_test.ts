// Fake callbacks are async by contract even when they do not await.
// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import test from "node:test";
import type { BrandContext } from "./brand_context.ts";
import {
  AI_SALARYMAN_LAB_CODE_PROFILE,
  KABUMORI_CODE_PROFILE,
  SOCIAL_MOBILE_USER_CODE_PROFILE,
} from "./brand_profiles.ts";
import { fingerprintText } from "./cross_brand_dedupe.ts";
import { SOCIAL_MOBILE_USER_DEFAULTS, type SocialMobileContentSettings } from "./social_mobile_content_settings.ts";
import {
  checkVaultAccountPublishAuthority,
  completeVaultAccountBrandPost,
  dispatchVaultAccountScheduledBrandPost,
  loadSocialMobileContentSettingsForPublish,
  VAULT_ACCOUNT_PUBLISH_LENGTH_POLICY,
  VaultAccountConfirmedPostCompletionError,
} from "./vault_account_brand_post.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("REAL_FETCH_FORBIDDEN_IN_TESTS"); }) as typeof fetch;
addEventListener("unload", () => { globalThis.fetch = realFetch; });

function pilotContext(overrides: Partial<BrandContext> = {}): BrandContext {
  return {
    brand: { id: "u_pilot", display_name: "pilot", is_active: true, publish_mode: "live", code_profile_key: "social_mobile_user_v1" },
    socialAccount: { id: "sa_pilot", brand_id: "u_pilot", platform: "x", handle: "pilot", publish_enabled: true, oauth_client_ref: "default" },
    codeProfile: SOCIAL_MOBILE_USER_CODE_PROFILE,
    operationalSettings: { brand_id: "u_pilot", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: ["brand_post"] },
    ...overrides,
  };
}
const AUTO: SocialMobileContentSettings = { ...SOCIAL_MOBILE_USER_DEFAULTS, approvalMode: "auto_post_preference", optionalNgWords: ["禁止語"] };

function harness(options: { text?: string; settings?: SocialMobileContentSettings | null; complete?: () => Promise<{ fingerprintPersisted: boolean }>;
  publishResponse?: unknown; fingerprints?: Array<{ brandId: string; normalizedTextSha256: string; publishedAt: string }>;
  /** Publish-authority answers per call ("allowed" or a refusal code). */
  authority?: string[] } = {}) {
  const authority = [...(options.authority ?? ["allowed", "allowed"])];
  const calls: string[] = [];
  const generated: Array<{ context: BrandContext; contentSettings?: SocialMobileContentSettings }> = [];
  const published: string[] = [];
  const completions: unknown[] = [];
  const text = options.text ?? "毎朝5分だけ机を片付けると、仕事の始まりが少し軽くなります。";
  return {
    calls, generated, published, completions,
    deps: {
      postType: "brand_post",
      scheduledPostId: "post_1",
      socialAccountId: "sa_pilot",
      openAiApiKey: "sk-test-not-real",
      checkPublishAuthority: async () => {
        calls.push("authority");
        const answer = authority.shift() ?? "UNEXPECTED_EXTRA_AUTHORITY_CHECK";
        if (answer !== "allowed") throw new Error(answer);
      },
      loadContentSettings: async () => { calls.push("settings"); return options.settings === undefined ? AUTO : options.settings; },
      loadRecentFingerprints: async () => { calls.push("fingerprints"); return options.fingerprints ?? []; },
      generate: async (args: { context: BrandContext; postType: string; contentSettings?: SocialMobileContentSettings }) => {
        calls.push("generate");
        generated.push({ context: args.context, contentSettings: args.contentSettings });
        return { brandId: args.context.brand.id, postType: args.postType, text, model: "m", inputTokens: 1, outputTokens: 1, apiCostUsd: 0, characterCount: Array.from(text).length };
      },
      publishText: async (t: string) => { calls.push("publish"); published.push(t); return options.publishResponse ?? { data: { id: "1234567890" } }; },
      completePublishedPost: async (args: unknown) => { calls.push("complete"); completions.push(args); return options.complete ? options.complete() : { fingerprintPersisted: true }; },
    },
  };
}
const rejects = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof Error && e.message === code);

test("pilot account: consented, account-bound, length-bounded generation -> one publish -> exact-account completion", async () => {
  const h = harness();
  const result = await dispatchVaultAccountScheduledBrandPost({ context: pilotContext(), ...h.deps });
  assert.deepEqual(h.calls, ["authority", "settings", "fingerprints", "generate", "authority", "publish", "complete"]);
  assert.equal(h.published.length, 1);
  assert.deepEqual(h.generated[0].context.codeProfile.postLengthPolicy, VAULT_ACCOUNT_PUBLISH_LENGTH_POLICY);
  assert.equal(h.generated[0].contentSettings?.approvalMode, "auto_post_preference");
  assert.equal(SOCIAL_MOBILE_USER_CODE_PROFILE.postLengthPolicy, undefined, "shared profile object is not mutated");
  assert.deepEqual(h.completions[0], {
    scheduledPostId: "post_1", socialAccountId: "sa_pilot", xPostId: "1234567890",
    normalizedTextSha256: await fingerprintText(h.published[0]),
  });
  assert.equal(result.socialAccountId, "sa_pilot");
  assert.equal(result.brandId, "u_pilot");
});

test("no user consent (missing settings or manual_review) stops before fingerprints, generation and X", async () => {
  for (const settings of [null, { ...SOCIAL_MOBILE_USER_DEFAULTS }]) {
    const h = harness({ settings });
    await rejects(dispatchVaultAccountScheduledBrandPost({ context: pilotContext(), ...h.deps }), "SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED");
    assert.deepEqual(h.calls, ["authority", "settings"]);
  }
});

test("AI Lab and Kabumori can never publish through this path (brand and profile)", async () => {
  const cases: BrandContext[] = [
    pilotContext({
      brand: { id: "ai_salaryman_lab", display_name: "AI Lab", is_active: true, publish_mode: "live", code_profile_key: "ai_salaryman_lab_v1" },
      socialAccount: { id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform: "x", handle: "kaishain_ai_lab", publish_enabled: true, oauth_client_ref: "default" },
      codeProfile: AI_SALARYMAN_LAB_CODE_PROFILE,
    }),
    pilotContext({
      brand: { id: "kabumori", display_name: "kabumori", is_active: true, publish_mode: "live", code_profile_key: "kabumori_v1" },
      codeProfile: KABUMORI_CODE_PROFILE,
    }),
  ];
  for (const context of cases) {
    const h = harness();
    await rejects(dispatchVaultAccountScheduledBrandPost({ context, ...h.deps }), "VAULT_BRAND_POST_BRAND_NOT_ELIGIBLE");
    assert.deepEqual(h.calls, []);
  }
  // A user brand whose profile object and brand key disagree.
  const h = harness();
  await rejects(dispatchVaultAccountScheduledBrandPost({ context: pilotContext({ codeProfile: AI_SALARYMAN_LAB_CODE_PROFILE }), ...h.deps }), "VAULT_BRAND_POST_PROFILE_NOT_APPROVED");
  assert.deepEqual(h.calls, []);
});

test("account/content binding: wrong account, missing account, foreign-brand account fail before anything", async () => {
  const cases: Array<[BrandContext, string]> = [
    [pilotContext(), "ai_salaryman_lab_x"],
    [pilotContext({ socialAccount: null }), "sa_pilot"],
    [pilotContext({ socialAccount: { id: "sa_pilot", brand_id: "ai_salaryman_lab", platform: "x", handle: "p", publish_enabled: true, oauth_client_ref: "default" } }), "sa_pilot"],
    [pilotContext(), ""],
  ];
  for (const [context, socialAccountId] of cases) {
    const h = harness();
    await rejects(dispatchVaultAccountScheduledBrandPost({ context, ...h.deps, socialAccountId }), "VAULT_BRAND_POST_ACCOUNT_MISMATCH");
    assert.deepEqual(h.calls, []);
  }
});

test("admin authority: brand_post must be enabled; brand live; account publish-enabled", async () => {
  const h1 = harness();
  await rejects(dispatchVaultAccountScheduledBrandPost({
    context: pilotContext({ operationalSettings: { brand_id: "u_pilot", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: [] } }), ...h1.deps,
  }), "VAULT_BRAND_POST_TYPE_NOT_ENABLED");
  const h2 = harness();
  await rejects(dispatchVaultAccountScheduledBrandPost({ context: pilotContext(), ...h2.deps, postType: "tip" }), "VAULT_BRAND_POST_TYPE_NOT_ENABLED");
  const h3 = harness();
  await rejects(dispatchVaultAccountScheduledBrandPost({
    context: pilotContext({ brand: { id: "u_pilot", display_name: "p", is_active: true, publish_mode: "dry_run", code_profile_key: "social_mobile_user_v1" } }), ...h3.deps,
  }), "BRAND_PUBLISH_MODE_DRY_RUN");
  const h4 = harness();
  await rejects(dispatchVaultAccountScheduledBrandPost({
    context: pilotContext({ socialAccount: { id: "sa_pilot", brand_id: "u_pilot", platform: "x", handle: "p", publish_enabled: false, oauth_client_ref: "default" } }), ...h4.deps,
  }), "BRAND_X_ACCOUNT_DISABLED");
  for (const h of [h1, h2, h3, h4]) assert.deepEqual(h.calls, []);
});

test("content gates after generation: length, NG word, cross-brand duplicate, generator context -> no X call", async () => {
  const long = harness({ text: "あ".repeat(141) });
  await rejects(dispatchVaultAccountScheduledBrandPost({ context: pilotContext(), ...long.deps }), "VAULT_BRAND_POST_LENGTH_LIMIT_EXCEEDED");
  const ng = harness({ text: "これは禁止語を含む投稿です。" });
  await rejects(dispatchVaultAccountScheduledBrandPost({ context: pilotContext(), ...ng.deps }), "VAULT_BRAND_POST_NG_WORD");
  const text = "他ブランドと全く同じ文章です。";
  const dup = harness({ text, fingerprints: [{ brandId: "ai_salaryman_lab", normalizedTextSha256: await fingerprintText(text), publishedAt: new Date().toISOString() }] });
  await rejects(dispatchVaultAccountScheduledBrandPost({ context: pilotContext(), ...dup.deps }), "VAULT_BRAND_POST_CROSS_BRAND_DUPLICATE");
  const wrong = harness();
  await rejects(dispatchVaultAccountScheduledBrandPost({
    context: pilotContext(), ...wrong.deps,
    generate: async () => ({ brandId: "ai_salaryman_lab", postType: "brand_post", text: "x", model: "m", inputTokens: 0, outputTokens: 0, apiCostUsd: 0, characterCount: 1 }),
  }), "VAULT_BRAND_POST_GENERATION_CONTEXT_MISMATCH");
  for (const h of [long, ng, dup]) assert.ok(!h.calls.includes("publish"));
  // Length is also enforced after the final authority re-check, adjacent to X.
  assert.ok(!long.calls.includes("publish"));
});

test("confirmed X post whose completion fails is never reported as a plain failure; missing id is not completed", async () => {
  const h = harness({ complete: async () => { throw new Error("DB down"); } });
  await assert.rejects(dispatchVaultAccountScheduledBrandPost({ context: pilotContext(), ...h.deps }), (e: unknown) => e instanceof VaultAccountConfirmedPostCompletionError);
  assert.equal(h.published.length, 1);
  const noId = harness({ publishResponse: { data: {} } });
  await rejects(dispatchVaultAccountScheduledBrandPost({ context: pilotContext(), ...noId.deps }), "X_RESPONSE_MISSING_POST_ID");
  assert.ok(!noId.calls.includes("complete"));
});

test("content settings loader: own brand row only; undeployed table or no row = no consent; other errors fail closed", async () => {
  const seen: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const load = (reply: Response) => loadSocialMobileContentSettingsForPublish({
    supabaseUrl: "https://e.supabase.co/", serviceRoleKey: "srk", brandId: "u_pilot",
    fetchImpl: async (input, init) => { seen.push({ url: String(input), redirect: init?.redirect }); return reply; },
  });
  const row = { brand_id: "u_pilot", settings: { ...AUTO }, persona_profile: {}, persona_provenance: "conversation", persona_confirmed: false };
  assert.equal((await load(Response.json([row])))?.approvalMode, "auto_post_preference");
  assert.equal(await load(Response.json([])), null);
  assert.equal(await load(Response.json({ message: 'relation "public.social_mobile_content_settings" does not exist' }, { status: 400 })), null);
  assert.equal(await load(new Response(null, { status: 404 })), null);
  await rejects(load(Response.json({ message: "boom" }, { status: 500 })), "CONTENT_SETTINGS_READ_FAILED");
  await rejects(load(Response.json([{ ...row, brand_id: "ai_salaryman_lab" }])), "CONTENT_SETTINGS_READ_FAILED");
  // Malformed settings normalize to the defaults (manual_review) -> no consent.
  assert.equal((await load(Response.json([{ ...row, settings: { approvalMode: "auto_post_preference" } }])))?.approvalMode, "manual_review");
  assert.ok(seen.every((s) => s.url.includes("/rest/v1/social_mobile_content_settings?") && s.url.includes("brand_id=eq.u_pilot") && s.redirect === "manual"));
});

test("completion RPC adapter: exact post/account parameters, manual redirect, strict response", async () => {
  const sent: Array<{ url: string; body: unknown; redirect: RequestRedirect | undefined }> = [];
  const call = (reply: Response) => completeVaultAccountBrandPost({
    supabaseUrl: "https://e.supabase.co", serviceRoleKey: "srk", scheduledPostId: "post_1", socialAccountId: "sa_pilot",
    xPostId: "123", normalizedTextSha256: "a".repeat(64),
    fetchImpl: async (input, init) => { sent.push({ url: String(input), body: JSON.parse(String(init?.body)), redirect: init?.redirect }); return reply; },
  });
  assert.deepEqual(await call(Response.json([{ fingerprint_persisted: true }])), { fingerprintPersisted: true });
  assert.deepEqual(sent[0], {
    url: "https://e.supabase.co/rest/v1/rpc/complete_vault_account_brand_post",
    body: { p_scheduled_post_id: "post_1", p_social_account_id: "sa_pilot", p_x_post_id: "123", p_normalized_text_sha256: "a".repeat(64) },
    redirect: "manual",
  });
  await rejects(call(Response.json({}, { status: 400 })), "VAULT_BRAND_POST_COMPLETION_RPC_FAILED");
  await rejects(call(Response.json([{}])), "VAULT_BRAND_POST_COMPLETION_RPC_INVALID_RESPONSE");
});

test("source: brand names only in the exclusion set; no env tokens, token store, console, or raw fetch outside the adapters", async () => {
  const source = (await Deno.readTextFile(new URL("./vault_account_brand_post.ts", import.meta.url))).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");
  assert.equal((source.match(/ai_salaryman_lab|kabumori/gu) ?? []).length, 2);
  assert.match(source, /const SPECIALIZED_BRAND_IDS: ReadonlySet<string> = new Set\(\["kabumori", "ai_salaryman_lab"\]\);/u);
  assert.doesNotMatch(source, /oauth_token_store|Deno\.env|console\.|X_OAUTH2_/u);
  assert.doesNotMatch(source, /api\.x\.com/u);
});

test("publish authority missing/off/revoked/not started/expired or consent/admin refused at the first check -> no generation, no X", async () => {
  for (const code of ["VAULT_PUBLISH_AUTHORITY_OFF", "VAULT_PUBLISH_AUTHORITY_REVOKED", "VAULT_PUBLISH_AUTHORITY_NOT_STARTED",
    "VAULT_PUBLISH_AUTHORITY_EXPIRED", "SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED", "VAULT_PUBLISH_BRAND_DISABLED", "X_ACCOUNT_PUBLISH_DISABLED"]) {
    const h = harness({ authority: [code] });
    await rejects(dispatchVaultAccountScheduledBrandPost({ context: pilotContext(), ...h.deps }), code);
    assert.deepEqual(h.calls, ["authority"], code);
  }
});

test("revocation/expiry/consent withdrawal committed during generation: the pre-create re-check stops the X create", async () => {
  for (const code of ["VAULT_PUBLISH_AUTHORITY_REVOKED", "VAULT_PUBLISH_AUTHORITY_EXPIRED", "VAULT_PUBLISH_AUTHORITY_OFF",
    "SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED", "VAULT_PUBLISH_BRAND_DISABLED", "X_ACCOUNT_PUBLISH_DISABLED"]) {
    const h = harness({ authority: ["allowed", code] });
    await rejects(dispatchVaultAccountScheduledBrandPost({ context: pilotContext(), ...h.deps }), code);
    assert.deepEqual(h.calls, ["authority", "settings", "fingerprints", "generate", "authority"], code);
    assert.equal(h.published.length, 0, code);
  }
});

test("publish authority adapter: exact post/account/brand, manual redirect, only 'allowed' passes, fixed codes", async () => {
  const sent: Array<{ url: string; body: unknown; redirect: RequestRedirect | undefined }> = [];
  const call = (reply: Response) => checkVaultAccountPublishAuthority({
    supabaseUrl: "https://e.supabase.co/", serviceRoleKey: "srk", scheduledPostId: "post_1", socialAccountId: "sa_pilot", brandId: "u_pilot",
    fetchImpl: async (input, init) => { sent.push({ url: String(input), body: JSON.parse(String(init?.body)), redirect: init?.redirect }); return reply; },
  });
  await call(Response.json("allowed"));
  assert.deepEqual(sent[0], {
    url: "https://e.supabase.co/rest/v1/rpc/check_x_account_publish_authority",
    body: { p_scheduled_post_id: "post_1", p_social_account_id: "sa_pilot", p_brand_id: "u_pilot" },
    redirect: "manual",
  });
  await rejects(call(Response.json({ message: "VAULT_PUBLISH_AUTHORITY_EXPIRED" }, { status: 400 })), "VAULT_PUBLISH_AUTHORITY_EXPIRED");
  await rejects(call(Response.json({ message: "permission denied for table x" }, { status: 403 })), "VAULT_PUBLISH_AUTHORITY_UNAVAILABLE");
  await rejects(call(Response.json("maybe")), "VAULT_PUBLISH_AUTHORITY_UNAVAILABLE");
  await rejects(call(Response.json(null)), "VAULT_PUBLISH_AUTHORITY_UNAVAILABLE");
});
