// 会社員AIラボの重複テーマ連投 応急修正(2026-10-01)のテスト。実X投稿・DB・OpenAI呼び出しは一切なし
// （generate / fetch は全てスタブ）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  EVERGREEN_TOPIC_SEEDS,
  loadAiLabDevDiaryMarkdown,
  selectAiLabRotatingTopicSeed,
  type AiLabTopicUsage,
} from "./ai_lab_dev_diary_context.ts";
import {
  aiLabDiversityInstructions,
  collectAiLabContentViolations,
  detectGenericThemes,
  startsWithKojinKaihatsuOpener,
} from "./ai_lab_theme_guard.ts";
import {
  AI_LAB_MAX_GENERATION_ATTEMPTS,
  dispatchAiLabScheduledBrandPost,
} from "./ai_lab_scheduled_brand_post.ts";
import { countAiLabBrandPostsBefore } from "./ai_lab_brand_post_store.ts";
import { generateBrandPost } from "./brand_post_generator.ts";
import { type BrandOperationalSettings, resolveBrandContext } from "./brand_context.ts";

// 実際に連続投稿された3テーマ相当（本文そのものではなく、同じ結論の言い換え）。
const INCIDENT_POSTS = [
  "個人開発は、コードを書かない日もある。今日は1行も書かずに1日が終わった。",
  "個人開発、仕様を決めるために調べて、比較するだけで1日が終わることがある。",
  "進んでいないようでも、それは手戻りを減らす時間だったりする。個人開発は地味な作業の連続。",
];

const NOW = new Date("2026-10-01T03:00:00Z");

const DIARY = `
## 2026-09-29
changed: 投稿の中身を安全に読み書きする作業の前に、必要な下調べをした。
difficulty: 担当者の判定がまだ正式にできない状態だと分かった。
decided: 土台がないまま進めると矛盾が出そうなので、いったん手を止めた。
angle: 下調べだけで1日が終わることもある、という個人開発のリアル。

## 2026-09-30
changed: iOS版で実データ接続とX認証の確認を進めた。
difficulty: テスト用のXアカウントが既存の接続と重なっていた。
decided: 先に進めるより安全側で止めることを優先した。
angle: 開発の記録を、そのまま発信のネタに変える仕組みを整えた話。

## 2026-10-01
changed: Xを接続するとき、前回ログインしたアカウントが引き継がれる問題を見つけた。
difficulty: ソース上のテストが通っても、実際のログイン画面で切り替えられるかは確認できない。
decided: ログイン状態を共有しにくい認証方法へ変更した。
angle: テストが全部通っても、外部サービスのログイン画面は実際に触って確かめる必要があると分かった話。
`;

function select(
  rotationIndex: number,
  markdown = DIARY,
  recentPostTexts: string[] = [],
  recentUsage: AiLabTopicUsage[] | null = [],
) {
  return selectAiLabRotatingTopicSeed({ markdown, now: NOW, rotationIndex, recentPostTexts, recentUsage });
}

// --- 1. fresh diary は generic evergreen より優先 -----------------------------------------------

test("fresh diary exists: every rotation step picks diary, never the generic evergreen", () => {
  for (let i = 0; i < 40; i += 1) {
    const selected = select(i);
    assert.equal(selected.source, "diary", `rotation ${i}`);
    assert.ok(!EVERGREEN_TOPIC_SEEDS.includes(selected.topic));
  }
});

test("a generic diary angle (下調べだけで1日が終わる) is excluded with a reason code and never used as a topic", () => {
  // 新しい2件を使用済みにして、汎用角度を持つ 9/29 のイベントが選ばれる状況を作る。
  const used: AiLabTopicUsage[] = [
    { eventKey: "diary-2026-10-01-1", publishedAt: "2026-10-01T01:00:00Z" },
    { eventKey: "diary-2026-09-30-1", publishedAt: "2026-09-30T09:00:00Z" },
  ];
  const selected = select(0, DIARY, [], used);
  assert.equal(selected.eventKey, "diary-2026-09-29-1");
  const reasons = selected.exclusions.map((e) => `${e.candidate}:${e.reason}`);
  assert.ok(reasons.some((r) => r.startsWith("diary-2026-09-29-1#angle1:GENERIC_THEME:research_only_day")), reasons.join("\n"));
  for (let i = 0; i < 40; i += 1) {
    assert.doesNotMatch(select(i, DIARY, [], used).topic, /今回の切り口: 下調べだけで/u);
  }
});

test("diary seeds carry the concrete facts (what changed / what got stuck), not only an abstract angle", () => {
  for (let i = 0; i < 40; i += 1) {
    assert.match(select(i).topic, /できごと: /u);
  }
});

// --- 3. 同じ diary イベントは一度投稿したら fresh 期間中は再利用しない（2026-10-03 でイベント単位に変更）---
// 2026-10-01 版の「同じエントリの切り口を巡回する」テストは、まさに今回の不具合の挙動なので廃止し、
// ai_lab_event_dedupe_test.ts のイベント単位テストへ置き換えた。

test("rotationIndex never moves selection off the newest unused event (it only varies the angle)", () => {
  const eventKeys = new Set(Array.from({ length: 40 }, (_, i) => select(i).eventKey));
  assert.deepEqual([...eventKeys], ["diary-2026-10-01-1"]);
});

// --- 4. 別テーマの fresh diary は正常に選択される -------------------------------------------------

test("a fresh diary about a different theme is selected normally, with its own concrete facts", () => {
  const markdown = `
## 2026-10-01
changed: アプリの通知設定画面を作り直し、通知の種類ごとにオンオフできるようにした。
difficulty: 古い設定の移行で、既存ユーザーの設定が消えそうになった。
decided: 移行処理を先に作ってから画面を差し替えた。
`;
  const selected = select(0, markdown);
  assert.equal(selected.source, "diary");
  assert.match(selected.topic, /通知設定画面/u);
  assert.equal(select(1, markdown).source, "diary");
});

// --- 6. fresh diary が本当に無い場合は evergreen -------------------------------------------------

test("no fresh diary: evergreen fallback works and rotates (not the same seed twice in a row)", () => {
  const stale = "## 2026-09-01\nchanged: だいぶ前の変更。\n";
  const picked = Array.from({ length: EVERGREEN_TOPIC_SEEDS.length * 2 }, (_, i) => select(i, stale));
  for (const selected of picked) {
    assert.equal(selected.source, "evergreen");
    assert.ok(EVERGREEN_TOPIC_SEEDS.includes(selected.topic));
  }
  for (let i = 0; i < picked.length - 1; i += 1) assert.notEqual(picked[i].topic, picked[i + 1].topic);
  assert.equal(select(0, "").source, "evergreen");
});

test("a future-dated or unsafe diary entry never becomes a topic (falls back to evergreen)", () => {
  const markdown = "## 2026-10-05\nchanged: まだ起きていない変更。\n\n## 2026-10-01\nchanged: 危険 https://example.com を含む。\n";
  const selected = select(0, markdown);
  assert.equal(selected.source, "evergreen");
  const reasons = selected.exclusions.map((e) => e.reason);
  assert.ok(reasons.includes("DIARY_ENTRY_IN_FUTURE"));
  assert.ok(reasons.includes("DIARY_ENTRY_UNSAFE_OR_INVALID"));
});

// --- 2. 直近投稿との意味重複（実インシデント3投稿をfixture）---------------------------------------

test("incident fixture: every paraphrase of the 3 repeated posts is detected as a generic theme", () => {
  assert.deepEqual(detectGenericThemes(INCIDENT_POSTS[0]).includes("no_code_day"), true);
  assert.deepEqual(detectGenericThemes(INCIDENT_POSTS[1]).includes("research_only_day"), true);
  assert.deepEqual(detectGenericThemes(INCIDENT_POSTS[2]).includes("rework_reduction"), true);
  assert.deepEqual(detectGenericThemes(INCIDENT_POSTS[2]).includes("looks_no_progress"), true);
  // 言い換え（別の表現・別の単語）も同じカテゴリ
  assert.ok(detectGenericThemes("今日はコードを一行も書かなかった。").includes("no_code_day"));
  assert.ok(detectGenericThemes("仕様を決めるために調べる、比較する。それだけで1日が終わる。").includes("research_only_day"));
  assert.ok(detectGenericThemes("下調べだけで今日が終わった").includes("research_only_day"));
  assert.ok(detectGenericThemes("手戻りを減らすための時間").includes("rework_reduction"));
  assert.ok(detectGenericThemes("進んでいないように見えても").includes("looks_no_progress"));
  assert.ok(detectGenericThemes("AIと試行錯誤の毎日").includes("ai_trial_error"));
  assert.ok(detectGenericThemes("個人開発は大変だ").includes("solo_dev_hard"));
  assert.ok(detectGenericThemes("個人開発は地味な作業が多い").includes("unglamorous_work"));
});

test("incident fixture: with those 3 posts as recent history, a reworded same-theme candidate is rejected", () => {
  const reworded = [
    "仕様を固めるために比較検討だけして、結局コードを書かない日もある。",
    "調べてばかりで進んでいないように見えるけど、手戻りを減らす大事な時間。",
    "今日は下調べだけで終わった。地味だけど必要な作業。",
  ];
  for (const candidate of reworded) {
    const violations = collectAiLabContentViolations({ text: candidate, recentPostTexts: INCIDENT_POSTS });
    assert.ok(violations.length > 0, candidate);
    assert.ok(violations.includes("RECENT_SAME_THEME") || violations.some((v) => v.startsWith("GENERIC_THEME:")), candidate);
  }
});

test("incident fixture: with those 3 posts as recent history, the evergreen fallback skips seeds of the same generic themes", () => {
  const stale = "## 2026-09-01\nchanged: だいぶ前の変更。\n";
  const unglamorousIndexes = [0, 5]; // 直す時間(地味) / 仕様→確認→直すサイクル(手戻り・地味)
  for (let i = 0; i < 30; i += 1) {
    const selected = select(i, stale, INCIDENT_POSTS);
    const index = EVERGREEN_TOPIC_SEEDS.indexOf(selected.topic);
    assert.ok(index >= 0);
    assert.ok(!unglamorousIndexes.includes(index), `rotation ${i} picked evergreen#${index}`);
  }
  const reasons = select(0, stale, INCIDENT_POSTS).exclusions.map((e) => e.reason);
  assert.ok(reasons.some((r) => r.startsWith("RECENT_GENERIC_THEME:")));
});

test("a concrete, different-theme candidate passes against the incident history", () => {
  const candidate = "Xを接続したら、前回ログインしたアカウントが残っていて別のアカウントを選べなかった。認証の方法を見直した。 #個人開発";
  assert.deepEqual(collectAiLabContentViolations({ text: candidate, recentPostTexts: INCIDENT_POSTS }), []);
});

test("a generic theme is allowed only when the seed itself is that theme (evergreen fallback)", () => {
  const text = "テストが通ったのに地味に手が止まった。";
  assert.ok(collectAiLabContentViolations({ text, seedText: "" }).includes("GENERIC_THEME:unglamorous_work"));
  assert.deepEqual(
    collectAiLabContentViolations({ text, seedText: "地味な作業が続く日の話" }),
    [],
  );
});

// --- 5. 「個人開発は〜」書き出しの連続防止 --------------------------------------------------------

test("opener '個人開発は、/個人開発、/個人開発では、' is detected; hashtag and mid-sentence use are not", () => {
  for (const text of ["個人開発は、地道だ。", "個人開発、思ったより進む。", "個人開発では、止める判断も大事。", "  「個人開発は、」と思った"]) {
    assert.equal(startsWithKojinKaihatsuOpener(text), true, text);
    assert.deepEqual(collectAiLabContentViolations({ text }), ["OPENER_KOJIN_KAIHATSU"]);
  }
  for (const text of ["#個人開発 を続けている。", "今日の個人開発は進んだ。", "ログイン画面で詰まった。 #個人開発"]) {
    assert.equal(startsWithKojinKaihatsuOpener(text), false, text);
  }
});

// --- ディスパッチャ: 再生成・失敗側の挙動 + 実X投稿なし ---------------------------------------------

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

function dispatchWith(texts: string[], extra: Partial<Parameters<typeof dispatchAiLabScheduledBrandPost>[0]> = {}) {
  const published: string[] = [];
  const seenViolations: Array<readonly string[]> = [];
  let call = 0;
  const run = () =>
    dispatchAiLabScheduledBrandPost({
      context: aiLabContext(),
      postType: "brand_post",
      scheduledPostId: "schedule-fixture",
      openAiApiKey: "fixture-only",
      loadRecentFingerprints: async () => [],
      publishText: async (text) => {
        published.push(text);
        return { data: { id: "x-post-fixture" } };
      },
      completePublishedPost: async () => ({ fingerprintPersisted: true }),
      generate: async ({ retryViolations }) => {
        seenViolations.push(retryViolations);
        return draftOf(texts[Math.min(call++, texts.length - 1)]);
      },
      ...extra,
    });
  return { run, published, seenViolations };
}

test("dispatcher regenerates once when the first draft is a generic-theme repeat, then publishes the good draft", async () => {
  const good = "Xの接続画面で、前回のアカウントが残る問題を見つけた。 #個人開発";
  const { run, published, seenViolations } = dispatchWith([INCIDENT_POSTS[0], good]);
  const result = await run();
  assert.equal(result.xPostId, "x-post-fixture");
  assert.deepEqual(published, [good]);
  assert.deepEqual(seenViolations[0], []);
  assert.ok(seenViolations[1].includes("OPENER_KOJIN_KAIHATSU"));
  assert.ok(seenViolations[1].includes("GENERIC_THEME:no_code_day"));
});

test("dispatcher fails closed (no publish) when every attempt repeats a generic theme or the banned opener", async () => {
  const rejections: number[] = [];
  const { run, published } = dispatchWith([INCIDENT_POSTS[0]], { onContentRejected: ({ attempt }) => rejections.push(attempt) });
  await assert.rejects(run, /AI_LAB_CONTENT_DIVERSITY_REJECTED/);
  assert.deepEqual(published, []);
  assert.equal(rejections.length, AI_LAB_MAX_GENERATION_ATTEMPTS);
});

test("dispatcher with a clean, concrete draft publishes on the first attempt (existing behavior preserved)", async () => {
  const { run, published, seenViolations } = dispatchWith(["今日はログイン画面の切り替えを確認した。 #個人開発"]);
  await run();
  assert.equal(published.length, 1);
  assert.equal(seenViolations.length, 1);
});

// --- 生成プロンプト: AI Lab だけに追加指示、他ブランドは不変 ----------------------------------------

async function capturedInstructions(contextBrand: ReturnType<typeof aiLabContext>, extra?: readonly string[]) {
  let instructions = "";
  await generateBrandPost({
    openAiApiKey: "fixture-only",
    context: contextBrand,
    postType: "brand_post",
    topicSeed: "固定の題材",
    extraInstructions: extra,
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      instructions = JSON.parse(String(init?.body)).instructions;
      return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "本文です。" }] }] }), { status: 200 });
    }) as typeof fetch,
  });
  return instructions;
}

test("generator: without extraInstructions the prompt is unchanged; with them they are added (AI Lab only wires them)", async () => {
  const ctx = aiLabContext();
  const plain = await capturedInstructions(ctx);
  const withExtra = await capturedInstructions(ctx, aiLabDiversityInstructions());
  const explicitEmpty = await capturedInstructions(ctx, []);
  assert.equal(plain, explicitEmpty);
  assert.notEqual(plain, withExtra);
  assert.match(withExtra, /個人開発は、」「個人開発、」「個人開発では、」にしない/u);
  assert.match(withExtra, /コードを書かない日/u);
  // 既存のbrand voice（ハッシュタグ方針）は壊れない
  assert.match(withExtra, /#個人開発/u);
  assert.match(withExtra, /固定のハッシュタグ指定はありません/u);
  assert.match(plain, /#個人開発/u);
});

test("retry instructions name the previous violations", () => {
  const lines = aiLabDiversityInstructions(["GENERIC_THEME:rework_reduction", "OPENER_KOJIN_KAIHATSU"]).join("\n");
  assert.match(lines, /手戻りを減らす/u);
  assert.match(lines, /書き出しが「個人開発は」系/u);
});

// --- 他ブランドへ影響しない（静的な境界確認）--------------------------------------------------------

test("only the AI Lab dispatcher/entry wire the new guard; Kabumori and other brand modules never import it", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const dir = new URL("./", import.meta.url);
  const importers: string[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".ts") || name.endsWith("_test.ts")) continue;
    const body = await readFile(new URL(name, dir), "utf8");
    if (/ai_lab_theme_guard\.ts/u.test(body)) importers.push(name);
  }
  assert.deepEqual(importers.sort(), ["ai_lab_dev_diary_context.ts", "ai_lab_scheduled_brand_post.ts"]);
  const generator = await readFile(new URL("brand_post_generator.ts", dir), "utf8");
  assert.doesNotMatch(generator, /ai_salaryman_lab|ai_lab_theme_guard/u);
});

// --- 連番（ローテーション用）の読み取り: 失敗しても投稿を止めない ----------------------------------

test("countAiLabBrandPostsBefore reads the exact count from content-range and is brand/post-type scoped (read-only)", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const count = await countAiLabBrandPostsBefore({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "fixture-key",
    scheduledFor: "2026-10-01T03:00:00+00:00",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response("[]", { status: 206, headers: { "content-range": "0-0/17" } });
    }) as typeof fetch,
  });
  assert.equal(count, 17);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, undefined); // GET only
  assert.match(calls[0].url, /brand_id=eq\.ai_salaryman_lab/u);
  assert.match(calls[0].url, /post_type=eq\.brand_post/u);
});

test("countAiLabBrandPostsBefore returns null (caller falls back) on HTTP error, bad header, or thrown fetch", async () => {
  const base = { supabaseUrl: "https://example.supabase.co", serviceRoleKey: "k", scheduledFor: "2026-10-01T03:00:00Z" };
  assert.equal(await countAiLabBrandPostsBefore({ ...base, fetchImpl: (async () => new Response("", { status: 500 })) as typeof fetch }), null);
  assert.equal(await countAiLabBrandPostsBefore({ ...base, fetchImpl: (async () => new Response("[]", { status: 200 })) as typeof fetch }), null);
  assert.equal(await countAiLabBrandPostsBefore({ ...base, fetchImpl: (async () => { throw new Error("network"); }) as typeof fetch }), null);
});

// --- 本物の日記 snapshot に対して ----------------------------------------------------------------

test("against the real bundled diary, the day after its freshest entry never yields a generic evergreen or a generic angle", async () => {
  const markdown = await loadAiLabDevDiaryMarkdown();
  const freshest = [...markdown.matchAll(/^## (\d{4}-\d{2}-\d{2})/gmu)].map((m) => m[1]).sort().at(-1)!;
  const now = new Date(`${freshest}T09:00:00Z`);
  for (let i = 0; i < 60; i += 1) {
    const selected = selectAiLabRotatingTopicSeed({ markdown, now, rotationIndex: i, recentUsage: [] });
    assert.equal(selected.source, "diary");
    assert.match(selected.topic, /できごと: /u);
    // seed全体が汎用テーマ(切り口行)に当たらないこと: 切り口行だけを検査する
    const focus = selected.topic.split("\n").find((line) => line.startsWith("今回の切り口: ")) ?? "";
    assert.deepEqual(detectGenericThemes(focus), [], focus);
  }
});
