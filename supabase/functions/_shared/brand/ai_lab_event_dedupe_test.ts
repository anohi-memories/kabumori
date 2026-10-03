// 会社員AIラボ: 同じ開発イベントを切り口だけ変えて連投する不具合の根本修正（2026-10-03）のテスト。
// 実X投稿・DB・OpenAI呼び出しは一切なし（generate / publish / fetch は全てスタブ）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_LAB_EVENT_KEY_PATTERN,
  AI_LAB_EVERGREEN_SEED_COOLDOWN_HOURS,
  type AiLabTopicUsage,
  diaryEventsWithKeys,
  diaryUnitsFor,
  EVERGREEN_TOPIC_SEEDS,
  loadAiLabDevDiaryMarkdown,
  sanitizeDiaryEntry,
  selectAiLabRotatingTopicSeed,
} from "./ai_lab_dev_diary_context.ts";
import {
  AiLabConfirmedPostCompletionError,
  dispatchAiLabScheduledBrandPost,
} from "./ai_lab_scheduled_brand_post.ts";
import { loadAiLabTopicUsage, recordAiLabTopicUsage } from "./ai_lab_brand_post_store.ts";
import { fingerprintText } from "./cross_brand_dedupe.ts";
import { type BrandOperationalSettings, resolveBrandContext } from "./brand_context.ts";

// 実際に問題になった「同じ1つの開発イベント」（X認証確認 → テスト用アカウント重複 → 本番影響回避で停止）。
const INCIDENT_EVENT = `
## 2026-09-30
changed: X認証まわりの実データ接続を確認した
difficulty: テスト用アカウントの重複に気づいた
decided: 本番影響を避けるため一旦停止した
angle: 実データ接続では重複に気づくことが重要だった
angle: 本番影響を出さないため止める判断をした
`;

const OTHER_EVENT = `
## 2026-10-01
changed: 通知設定の画面で、種類ごとにオンオフできるようにした
difficulty: 古い設定の移行で、既存の設定が消えそうになった
decided: 移行処理を先に作ってから画面を差し替えた
`;

const NOW = new Date("2026-10-01T03:00:00Z");

function select(markdown: string, recentUsage: AiLabTopicUsage[] | null, rotationIndex = 0, now = NOW) {
  return selectAiLabRotatingTopicSeed({ markdown, now, rotationIndex, recentUsage });
}

/** 投稿が成功するたびに使用記録を足していく（本番の ai_lab_topic_event_usage の代わり）。 */
function simulatePublishedPosts(markdown: string, posts: number, startRotation = 100) {
  const usage: AiLabTopicUsage[] = [];
  const picked = [];
  for (let post = 0; post < posts; post += 1) {
    const publishedAt = new Date(NOW.getTime() + post * 3 * 3_600_000);
    const selection = select(markdown, usage, startRotation + post, publishedAt);
    picked.push(selection);
    usage.push({ eventKey: selection.eventKey, publishedAt: publishedAt.toISOString() });
  }
  return picked;
}

// --- 旧不具合の再現と、新実装での遮断 --------------------------------------------------------------

test("old-bug vector: one diary event expands into 5 angles (changed/difficulty/decided/angle1/angle2) that all share one eventKey", () => {
  const [{ entry, eventKey }] = diaryEventsWithKeys(INCIDENT_EVENT);
  const units = diaryUnitsFor(sanitizeDiaryEntry(entry)!, eventKey, 1, []);
  assert.deepEqual(units.map((unit) => unit.key), [
    "diary-2026-09-30-1#changed",
    "diary-2026-09-30-1#difficulty",
    "diary-2026-09-30-1#decided",
    "diary-2026-09-30-1#angle1",
    "diary-2026-09-30-1#angle2",
  ]);
  // 旧実装はこの5件を別々の題材として rotationIndex で巡回し、6投稿すべてを 9/30 イベントにしていた
  // （origin/main 95fcb391 で実測: angle1 → difficulty → angle2 → decided → changed → angle1）。
});

test("incident: after the 9/30 event is published once, every other angle of it is excluded (RECENT_EVENT_USED) and posts 2..6 never return to it", () => {
  const picked = simulatePublishedPosts(INCIDENT_EVENT, 6);
  assert.equal(picked[0].source, "diary");
  assert.equal(picked[0].eventKey, "diary-2026-09-30-1");
  for (const later of picked.slice(1)) {
    assert.equal(later.source, "evergreen", later.unitKey);
    assert.ok(!later.eventKey.startsWith("diary-2026-09-30"), later.unitKey);
    assert.ok(
      later.exclusions.some((e) => e.candidate === "diary-2026-09-30-1" && e.stage === "event_cooldown" && e.reason === "RECENT_EVENT_USED"),
    );
  }
});

test("incident: with another unused fresh event, post 2 uses that event (not another angle of 9/30), then evergreen", () => {
  const picked = simulatePublishedPosts(INCIDENT_EVENT + OTHER_EVENT, 4);
  assert.deepEqual(picked.map((p) => p.eventKey).slice(0, 2), ["diary-2026-10-01-1", "diary-2026-09-30-1"]);
  assert.deepEqual(picked.slice(2).map((p) => p.source), ["evergreen", "evergreen"]);
  assert.equal(new Set(picked.map((p) => p.eventKey)).size, picked.length);
});

// --- 1, 9, 10: イベント単位のクールダウン ----------------------------------------------------------

test("(1)(9) every angle of the same event has a different unitKey but the same eventKey; once published, all are excluded", () => {
  const unitKeys = new Set<string>();
  for (let i = 0; i < 30; i += 1) {
    const selection = select(INCIDENT_EVENT, [], i);
    assert.equal(selection.eventKey, "diary-2026-09-30-1");
    assert.ok(selection.unitKey.startsWith("diary-2026-09-30-1#"));
    unitKeys.add(selection.unitKey);
  }
  assert.equal(unitKeys.size, 5);
  const used = [{ eventKey: "diary-2026-09-30-1", publishedAt: "2026-09-30T23:00:00Z" }];
  for (let i = 0; i < 30; i += 1) assert.equal(select(INCIDENT_EVENT, used, i).source, "evergreen");
});

test("(2) event A used, event B unused -> B is selected", () => {
  const used = [{ eventKey: "diary-2026-10-01-1", publishedAt: "2026-10-01T01:00:00Z" }];
  const selection = select(INCIDENT_EVENT + OTHER_EVENT, used);
  assert.equal(selection.eventKey, "diary-2026-09-30-1");
});

test("(10) cooling down one event never cools down a different event (including a second entry on the same date)", () => {
  const sameDay = `${OTHER_EVENT}
## 2026-10-01
changed: 設定画面の文言を、押したら何が起きるか分かる表現に直した
`;
  const keys = diaryEventsWithKeys(sameDay).map((e) => e.eventKey);
  assert.deepEqual(keys, ["diary-2026-10-01-1", "diary-2026-10-01-2"]);
  // 同じ日付なら後から追記した方が先。#2 を使っても #1 は残る。
  assert.equal(select(sameDay, []).eventKey, "diary-2026-10-01-2");
  const used = [{ eventKey: "diary-2026-10-01-2", publishedAt: "2026-10-01T01:00:00Z" }];
  assert.equal(select(sameDay, used).eventKey, "diary-2026-10-01-1");
  const both = [...used, { eventKey: "diary-2026-10-01-1", publishedAt: "2026-10-01T02:00:00Z" }];
  assert.equal(select(sameDay, both).source, "evergreen");
});

test("(3) all fresh events used -> evergreen (never a reused angle of a used event)", () => {
  const used = [
    { eventKey: "diary-2026-09-30-1", publishedAt: "2026-09-30T23:00:00Z" },
    { eventKey: "diary-2026-10-01-1", publishedAt: "2026-10-01T01:00:00Z" },
  ];
  for (let i = 0; i < 20; i += 1) {
    const selection = select(INCIDENT_EVENT + OTHER_EVENT, used, i);
    assert.equal(selection.source, "evergreen");
    assert.ok(EVERGREEN_TOPIC_SEEDS.includes(selection.topic));
  }
});

test("(14) a newly added diary event is selected first regardless of rotationIndex", () => {
  const used = [{ eventKey: "diary-2026-09-30-1", publishedAt: "2026-09-30T23:00:00Z" }];
  for (let i = -5; i < 60; i += 1) {
    assert.equal(select(INCIDENT_EVENT + OTHER_EVENT, used, i).eventKey, "diary-2026-10-01-1");
    assert.equal(select(INCIDENT_EVENT + OTHER_EVENT, [], i).eventKey, "diary-2026-10-01-1");
  }
});

test("eventKeys are stable: adding a new day or an unsafe entry does not change existing keys", () => {
  const before = diaryEventsWithKeys(INCIDENT_EVENT).map((e) => e.eventKey);
  const after = diaryEventsWithKeys(`${INCIDENT_EVENT}\n## 2026-09-30\nchanged: 危険 https://example.com\n${OTHER_EVENT}`)
    .map((e) => e.eventKey);
  assert.equal(after[0], before[0]);
  assert.deepEqual(after, ["diary-2026-09-30-1", "diary-2026-09-30-2", "diary-2026-10-01-1"]);
  for (const key of after) assert.match(key, AI_LAB_EVENT_KEY_PATTERN);
});

// --- 13: 日記が空・stale・unsafe・履歴が読めない ------------------------------------------------------

test("(13) empty / stale / unsafe diary -> safe evergreen", () => {
  assert.equal(select("", []).source, "evergreen");
  assert.equal(select("## 2026-09-01\nchanged: だいぶ前の変更。\n", []).source, "evergreen");
  const unsafe = select("## 2026-10-01\nchanged: 危険 https://example.com を含む。\n", []);
  assert.equal(unsafe.source, "evergreen");
  assert.ok(unsafe.exclusions.some((e) => e.reason === "DIARY_ENTRY_UNSAFE_OR_INVALID"));
});

test("usage history unavailable (null) -> no diary event is used at all (fail closed to evergreen)", () => {
  for (let i = 0; i < 10; i += 1) {
    const selection = select(INCIDENT_EVENT + OTHER_EVENT, null, i);
    assert.equal(selection.source, "evergreen");
    assert.ok(selection.exclusions.some((e) => e.reason === "EVENT_USAGE_UNAVAILABLE"));
  }
});

// --- 11: evergreen の直近重複防止 -------------------------------------------------------------------

test("(11) evergreen: a seed used within the cooldown is skipped, and seeds sharing its generic theme tag are skipped too", () => {
  const recent = (eventKey: string, hours: number) => ({
    eventKey,
    publishedAt: new Date(NOW.getTime() - hours * 3_600_000).toISOString(),
  });
  // evergreen-0（地味）を2時間前に使用 → evergreen-0 と、同じ「地味」タグを持つ evergreen-5 は使わない。
  for (let i = 0; i < 20; i += 1) {
    const selection = select("", [recent("evergreen-0", 2)], i);
    assert.ok(!["evergreen-0", "evergreen-5"].includes(selection.eventKey), selection.eventKey);
  }
  const exclusions = select("", [recent("evergreen-0", 2)]).exclusions;
  assert.ok(exclusions.some((e) => e.candidate === "evergreen-0" && e.reason === "RECENT_EVERGREEN_USED"));
  assert.ok(exclusions.some((e) => e.candidate === "evergreen-5" && e.reason.startsWith("RECENT_GENERIC_THEME:")));
  // クールダウンを過ぎれば再び候補に戻る。
  const old = recent("evergreen-0", AI_LAB_EVERGREEN_SEED_COOLDOWN_HOURS + 1);
  const seen = new Set(Array.from({ length: 20 }, (_, i) => select("", [old], i).eventKey));
  assert.ok(seen.has("evergreen-0"));
});

test("(11) evergreen: consecutive simulated posts never repeat a seed, and when every seed is cooling down the least-recently-used one is chosen", () => {
  const picked = simulatePublishedPosts("", EVERGREEN_TOPIC_SEEDS.length + 3);
  for (let i = 1; i < picked.length; i += 1) assert.notEqual(picked[i].eventKey, picked[i - 1].eventKey);
  const firstSeven = picked.slice(0, EVERGREEN_TOPIC_SEEDS.length).map((p) => p.eventKey);
  assert.equal(new Set(firstSeven).size, EVERGREEN_TOPIC_SEEDS.length, firstSeven.join(","));
  const exhausted = picked[EVERGREEN_TOPIC_SEEDS.length];
  assert.equal(exhausted.eventKey, picked[0].eventKey); // 最も前に使ったもの
  assert.ok(exhausted.exclusions.some((e) => e.reason === "EVERGREEN_POOL_EXHAUSTED_LEAST_RECENT"));
});

// --- 15: 除外ログに本文・秘密・内部識別子を出さない --------------------------------------------------

test("(15) exclusion logs carry only key-shaped candidates and machine reason codes (no diary text)", () => {
  const markdown = `${INCIDENT_EVENT}
## 2026-09-29
changed: 着手前に必要な下調べをした。
angle: 下調べだけで1日が終わることもある、という個人開発のリアル。

## 2026-09-20
changed: 古い出来事。

## 2026-10-09
changed: 未来の出来事。

## 2026-10-01
changed: 危険な変更 https://example.com と sk-abcdefghijklmnop を含む。
`;
  const used = [
    { eventKey: "diary-2026-09-30-1", publishedAt: "2026-09-30T23:00:00Z" },
    { eventKey: "evergreen-0", publishedAt: "2026-10-01T01:00:00Z" },
  ];
  const selections = [select(markdown, used), select(markdown, null), select(markdown, [], 3)];
  const exclusions = selections.flatMap((s) => s.exclusions);
  assert.ok(exclusions.length >= 5);
  for (const exclusion of exclusions) {
    assert.match(exclusion.candidate, /^(?:diary-\d{4}-\d{2}-\d{2}-\d{1,2}(?:#[a-z0-9]+)?|evergreen-\d{1,2})$/u);
    assert.match(exclusion.reason, /^[A-Z_]+(?::[a-z_,]+)?$/u);
  }
  const serialized = JSON.stringify(exclusions);
  assert.doesNotMatch(serialized, /[぀-ヿ一-龯]/u); // 日本語本文が一切ない
  assert.doesNotMatch(serialized, /https?:|sk-|example/u);
  for (const selection of selections) {
    assert.match(selection.eventKey, AI_LAB_EVENT_KEY_PATTERN);
    assert.match(selection.unitKey, /^[a-z0-9#-]+$/u);
  }
});

// --- 4〜8, 12: 投稿の成否と使用記録 ----------------------------------------------------------------

const settings: BrandOperationalSettings = {
  brand_id: "ai_salaryman_lab",
  fixed_hashtags: [],
  note_url: null,
  image_policy: {},
  enabled_post_types: ["brand_post"],
};

function aiLabContext() {
  return resolveBrandContext(
    { id: "ai_salaryman_lab", display_name: "fixture", is_active: true, publish_mode: "live", code_profile_key: "ai_salaryman_lab_v1" },
    { id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform: "x", handle: "kaishain_ai_lab", publish_enabled: true, oauth_client_ref: "default" },
    settings,
  );
}

function draftOf(text: string) {
  return {
    brandId: "ai_salaryman_lab",
    postType: "brand_post",
    text,
    model: "fixture",
    inputTokens: 1,
    outputTokens: 1,
    apiCostUsd: 0,
    characterCount: Array.from(text).length,
  };
}

const GOOD_TEXT = "Xの接続画面で、前回のアカウントが残る問題を見つけた。 #個人開発";

function harness(overrides: Partial<Parameters<typeof dispatchAiLabScheduledBrandPost>[0]> = {}) {
  const calls: string[] = [];
  const usageRecords: Array<{ scheduledPostId: string; xPostId: string }> = [];
  const run = () =>
    dispatchAiLabScheduledBrandPost({
      context: aiLabContext(),
      postType: "brand_post",
      scheduledPostId: "schedule-fixture",
      openAiApiKey: "fixture-only",
      loadRecentFingerprints: async () => [],
      generate: async () => draftOf(GOOD_TEXT),
      publishText: async () => {
        calls.push("publish");
        return { data: { id: "1790000000000000001" } };
      },
      recordTopicUsage: async (args) => {
        calls.push("usage");
        usageRecords.push(args);
        return true;
      },
      completePublishedPost: async () => {
        calls.push("complete");
        return { fingerprintPersisted: true };
      },
      ...overrides,
    });
  return { run, calls, usageRecords };
}

test("(4) generation failure -> no X call, no event usage recorded", async () => {
  const h = harness({ generate: async () => { throw new Error("BRAND_POST_GENERATION_FAILED:500"); } });
  await assert.rejects(h.run, /BRAND_POST_GENERATION_FAILED/);
  assert.deepEqual(h.calls, []);
});

test("(5) content guard failure on every attempt -> no X call, no event usage recorded", async () => {
  const h = harness({ generate: async () => draftOf("個人開発は、コードを書かない日もある。") });
  await assert.rejects(h.run, /AI_LAB_CONTENT_DIVERSITY_REJECTED/);
  assert.deepEqual(h.calls, []);
});

test("(6) X post failure -> no event usage recorded", async () => {
  const h = harness({ publishText: async () => { throw new Error("X_POST_FAILED:503"); } });
  await assert.rejects(h.run, /X_POST_FAILED/);
  assert.deepEqual(h.usageRecords, []);
  const noId = harness({ publishText: async () => ({ data: {} }) });
  await assert.rejects(noId.run, /X_RESPONSE_MISSING_POST_ID/);
  assert.deepEqual(noId.usageRecords, []);
});

test("(7) X post success -> usage recorded exactly once with the confirmed X id, after X and before completion", async () => {
  const h = harness();
  const result = await h.run();
  assert.deepEqual(h.calls, ["publish", "usage", "complete"]);
  assert.deepEqual(h.usageRecords, [{ scheduledPostId: "schedule-fixture", xPostId: "1790000000000000001" }]);
  assert.equal(result.topicUsagePersisted, true);
});

test("(8) completion response uncertain -> usage still recorded, X called once, and the confirmed-post error (never a retry) is raised", async () => {
  const h = harness({ completePublishedPost: async () => { throw new Error("network"); } });
  await assert.rejects(h.run, (error) => error instanceof AiLabConfirmedPostCompletionError);
  assert.deepEqual(h.calls, ["publish", "usage"]);
});

test("(8) usage write failing or throwing never blocks completion nor causes a second X call", async () => {
  for (const recordTopicUsage of [async () => false, async () => { throw new Error("db down"); }]) {
    const h = harness({ recordTopicUsage });
    const result = await h.run();
    assert.deepEqual(h.calls.filter((c) => c === "publish"), ["publish"]);
    assert.ok(h.calls.includes("complete"));
    assert.equal(result.topicUsagePersisted, false);
  }
});

test("(12) existing cross-brand exact fingerprint dedupe still blocks before X, and no usage is recorded", async () => {
  const hash = await fingerprintText(GOOD_TEXT);
  const h = harness({
    loadRecentFingerprints: async () => [{ brandId: "kabumori", normalizedTextSha256: hash, publishedAt: new Date().toISOString() }],
  });
  await assert.rejects(h.run, /AI_LAB_CROSS_BRAND_DUPLICATE/);
  assert.deepEqual(h.calls, []);
});

// --- usage store（PostgREST 呼び出しの形。実DBなし）----------------------------------------------

test("recordAiLabTopicUsage inserts only key-shaped metadata, idempotently, and never throws", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const ok = await recordAiLabTopicUsage({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "fixture-key",
    eventKey: "diary-2026-09-30-1",
    unitKey: "diary-2026-09-30-1#difficulty",
    scheduledPostId: "00000000-0000-0000-0000-000000000001",
    xPostId: "1790000000000000001",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 201 });
    }) as typeof fetch,
  });
  assert.equal(ok, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/rest\/v1\/ai_lab_topic_event_usage\?on_conflict=scheduled_post_id$/u);
  assert.equal(requests[0].init?.method, "POST");
  assert.match(String((requests[0].init?.headers as Record<string, string>).Prefer), /resolution=ignore-duplicates/u);
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    scheduled_post_id: "00000000-0000-0000-0000-000000000001",
    event_key: "diary-2026-09-30-1",
    unit_key: "diary-2026-09-30-1#difficulty",
    x_post_id: "1790000000000000001",
  });

  const base = {
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "k",
    unitKey: "evergreen-1",
    scheduledPostId: "00000000-0000-0000-0000-000000000002",
    xPostId: "1",
  };
  assert.equal(await recordAiLabTopicUsage({ ...base, eventKey: "evergreen-1", fetchImpl: (async () => new Response("", { status: 500 })) as typeof fetch }), false);
  assert.equal(await recordAiLabTopicUsage({ ...base, eventKey: "evergreen-1", fetchImpl: (async () => { throw new Error("network"); }) as typeof fetch }), false);
  let called = false;
  assert.equal(await recordAiLabTopicUsage({ ...base, eventKey: "X認証の話", fetchImpl: (async () => { called = true; return new Response(null, { status: 201 }); }) as typeof fetch }), false);
  assert.equal(called, false, "a non-key-shaped eventKey is never sent");
});

test("loadAiLabTopicUsage reads a bounded, brand-scoped window and fails closed (null) on any error or malformed row", async () => {
  let url = "";
  const rows = await loadAiLabTopicUsage({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "k",
    now: NOW,
    fetchImpl: (async (u: string) => {
      url = String(u);
      return new Response(JSON.stringify([{ event_key: "diary-2026-09-30-1", published_at: "2026-09-30T23:00:00+00:00" }]), { status: 200 });
    }) as typeof fetch,
  });
  assert.deepEqual(rows, [{ eventKey: "diary-2026-09-30-1", publishedAt: "2026-09-30T23:00:00+00:00" }]);
  assert.match(url, /ai_lab_topic_event_usage\?/u);
  assert.match(url, /brand_id=eq\.ai_salaryman_lab/u);
  assert.match(url, /published_at=gte\.2026-09-17T03%3A00%3A00\.000Z/u);
  assert.match(url, /limit=200/u);
  assert.doesNotMatch(url, /select=[^&]*(text|body|content)/u);

  const base = { supabaseUrl: "https://example.supabase.co", serviceRoleKey: "k", now: NOW };
  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  assert.equal(await loadAiLabTopicUsage({ ...base, fetchImpl: reply({ message: "relation does not exist" }, 404) }), null);
  assert.equal(await loadAiLabTopicUsage({ ...base, fetchImpl: reply({ not: "an array" }) }), null);
  assert.equal(await loadAiLabTopicUsage({ ...base, fetchImpl: reply([{ event_key: "free text", published_at: "2026-09-30T00:00:00Z" }]) }), null);
  assert.equal(await loadAiLabTopicUsage({ ...base, fetchImpl: (async () => { throw new Error("network"); }) as typeof fetch }), null);
  assert.deepEqual(await loadAiLabTopicUsage({ ...base, fetchImpl: reply([]) }), []);
});

// --- 本番配線と migration の静的確認 ----------------------------------------------------------------

test("x-test-post wires the usage history into selection and records usage only through the dispatcher hook", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../x-test-post/index.ts", import.meta.url), "utf8");
  const start = source.indexOf('if (scheduledPost.post_type === "brand_post")');
  const block = source.slice(start, source.indexOf("AI_LAB_POST_CONFIRMED_BUT_COMPLETION_UNCONFIRMED", start));
  assert.match(block, /loadAiLabTopicUsage\(\{ supabaseUrl, serviceRoleKey \}\)/u);
  assert.match(block, /recentUsage: recentTopicUsage/u);
  assert.match(block, /recordTopicUsage: \(\{ scheduledPostId, xPostId \}\) => recordAiLabTopicUsage\(/u);
  assert.match(block, /eventKey: selection\.eventKey/u);
  // 使用記録の書き込みは dispatcher の hook 経由だけ（X 成功前に直接呼ばない）。
  assert.equal(block.match(/recordAiLabTopicUsage\(/gu)?.length, 1);
});

test("migration: AI-Lab-only table, key-shaped CHECKs matching the TS pattern, no post text column, service_role select/insert only", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const dir = new URL("../../../migrations/", import.meta.url);
  const name = (await readdir(dir)).find((file) => file.endsWith("_ai_lab_topic_event_usage.sql"));
  assert.ok(name);
  const sql = await readFile(new URL(name!, dir), "utf8");
  const body = sql.replace(/--.*$/gmu, "");
  assert.match(body, /create table if not exists public\.ai_lab_topic_event_usage/u);
  assert.match(body, /check \(brand_id = 'ai_salaryman_lab'\)/u);
  assert.match(body, /enable row level security/u);
  assert.match(body, /revoke all on table public\.ai_lab_topic_event_usage from public, anon, authenticated, service_role;/u);
  assert.match(body, /grant select, insert on table public\.ai_lab_topic_event_usage to service_role;/u);
  assert.doesNotMatch(body, /\b(text_body|post_text|content|normalized_text)\b/u);
  // 他のテーブル・関数・Cron に触れない。
  assert.deepEqual([...body.matchAll(/public\.([a-z_]+)/gu)].map((m) => m[1]).filter((t) => t !== "ai_lab_topic_event_usage"), []);
  assert.doesNotMatch(body, /create (or replace )?function|cron\.|alter table public\.(?!ai_lab_topic_event_usage)/u);
  // SQL の event_key CHECK と TS の AI_LAB_EVENT_KEY_PATTERN が同じキーを受け入れる。
  const sqlPattern = /event_key ~ '([^']+)'/u.exec(body)?.[1];
  assert.ok(sqlPattern);
  const sqlRegex = new RegExp(sqlPattern!, "u");
  for (const key of ["diary-2026-09-30-1", "diary-2026-10-01-12", "evergreen-0", "evergreen-6", "diary-2026-10-01", "evergreen-x", "X認証", "diary-2026-10-01-1#changed"]) {
    assert.equal(sqlRegex.test(key), AI_LAB_EVENT_KEY_PATTERN.test(key), key);
  }
});

// --- 本物の日記 snapshot ------------------------------------------------------------------------------

test("against the real bundled diary: simulated posts never reuse a diary event within its fresh window", async () => {
  const markdown = await loadAiLabDevDiaryMarkdown();
  const freshest = [...markdown.matchAll(/^## (\d{4}-\d{2}-\d{2})/gmu)].map((m) => m[1]).sort().at(-1)!;
  const start = new Date(`${freshest}T00:30:00Z`);
  const usage: AiLabTopicUsage[] = [];
  const diaryEvents: string[] = [];
  for (let post = 0; post < 9; post += 1) {
    const at = new Date(start.getTime() + post * 4 * 3_600_000);
    const selection = selectAiLabRotatingTopicSeed({ markdown, now: at, rotationIndex: post, recentUsage: usage });
    if (selection.source === "diary") diaryEvents.push(selection.eventKey);
    usage.push({ eventKey: selection.eventKey, publishedAt: at.toISOString() });
  }
  assert.ok(diaryEvents.length >= 2);
  assert.equal(new Set(diaryEvents).size, diaryEvents.length, diaryEvents.join(","));
  assert.equal(diaryEvents[0], diaryEventsWithKeys(markdown).filter((e) => e.entry.date === freshest).at(-1)!.eventKey);
});
