import assert from "node:assert/strict";
import test from "node:test";
import {
  EVERGREEN_TOPIC_SEEDS,
  isSanitizedDiaryField,
  isValidCalendarDate,
  loadAiLabDevDiaryMarkdown,
  loadSanitizedDiaryEntries,
  parseDevDiaryMarkdown,
  sanitizeDiaryEntry,
  selectAiLabTopicSeed,
  type DevDiaryEntry,
} from "./ai_lab_dev_diary_context.ts";

function entry(overrides: Partial<DevDiaryEntry> = {}): DevDiaryEntry {
  return {
    date: "2026-09-28",
    eventId: "20260928-detail-screen-review",
    project: "個人で作っているアプリ",
    changed: "今日は投稿の詳細画面を見直した。",
    difficulty: "想定外のパターンに気づいて時間がかかった。",
    decided: "できないことは隠さず、理由つきで表示することにした。",
    remaining: "同じ考え方を他の画面にも広げる。",
    angles: ["嘘をつかないことを優先した話。"],
    ...overrides,
  };
}

// --- parsing ---

test("parses one entry with every label, angle repeatable", () => {
  const markdown = `
## 2026-09-28
event_id: 20260928-detail-screen-review
project: 個人で作っているアプリ
changed: 今日は投稿の詳細画面を見直した。
difficulty: 想定外のパターンに気づいて時間がかかった。
decided: できないことは隠さず、理由つきで表示することにした。
remaining: 同じ考え方を他の画面にも広げる。
angle: 一つ目の角度。
angle: 二つ目の角度。
`;
  const entries = parseDevDiaryMarkdown(markdown);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    date: "2026-09-28",
    eventId: "20260928-detail-screen-review",
    project: "個人で作っているアプリ",
    changed: "今日は投稿の詳細画面を見直した。",
    difficulty: "想定外のパターンに気づいて時間がかかった。",
    decided: "できないことは隠さず、理由つきで表示することにした。",
    remaining: "同じ考え方を他の画面にも広げる。",
    angles: ["一つ目の角度。", "二つ目の角度。"],
  });
});

test("parses multiple entries and ignores unlabeled prose / the leading comment block", () => {
  const markdown = `
<!-- 説明文。これは無視される。 -->
何かの前置き。

## 2026-09-20
changed: 一日目の変更。

## 2026-09-21
changed: 二日目の変更。
`;
  const entries = parseDevDiaryMarkdown(markdown);
  assert.deepEqual(entries.map((e) => e.date), ["2026-09-20", "2026-09-21"]);
  assert.deepEqual(entries.map((e) => e.changed), ["一日目の変更。", "二日目の変更。"]);
});

test("an entry with no changed: line is dropped (changed is required)", () => {
  const markdown = `
## 2026-09-20
project: 何か
`;
  assert.deepEqual(parseDevDiaryMarkdown(markdown), []);
});

test("empty-value labeled lines are ignored", () => {
  const markdown = `
## 2026-09-20
changed: 本物の変更。
difficulty:
angle:
`;
  const entries = parseDevDiaryMarkdown(markdown);
  assert.equal(entries[0].difficulty, null);
  assert.deepEqual(entries[0].angles, []);
});

// --- field-level sanitization: sensitive/raw orchestration data must never pass ---

test("isSanitizedDiaryField accepts ordinary Japanese diary prose", () => {
  assert.equal(isSanitizedDiaryField("今日は投稿の詳細画面を見直した。"), true);
  assert.equal(isSanitizedDiaryField("複数のAIに役割を分けて進めている。"), true);
});

test("isSanitizedDiaryField rejects empty or overlong text", () => {
  assert.equal(isSanitizedDiaryField(""), false);
  assert.equal(isSanitizedDiaryField("   "), false);
  assert.equal(isSanitizedDiaryField("あ".repeat(401)), false);
  assert.equal(isSanitizedDiaryField("あ".repeat(400)), true);
});

test("isSanitizedDiaryField rejects every forbidden category", () => {
  const unsafe = [
    "詳細は https://example.com/internal を見て。",
    "連絡先は someone@example.com です。",
    "鍵は sk-abcdefghijklmnop です。",
    "トークンは eyJhbGciOiJIUzI1NiJ9abcdefghij です。",
    "branch g4/social-mobile-home-posting-ux-phase1-20260928 で作業した。",
    "branch claude/g3-social-mobile-onboarding を見た。",
    "PR #44 をマージした。",
    "PR44をマージした。",
    "コミット 0cc48fe3ac1c376d747a を確認した。",
    "task x-social-mobile-posting-interaction-phase2-20260928 を進めた。",
    "scheduled_posts テーブルを見直した。",
    "post_execution_logs を読む処理を書いた。",
    "service_role の権限を確認した。",
    "RLS ポリシーを直した。",
    "新しい RPC を作った。",
    "ADMIN_INVITE_BINDING_SECRET を設定した。",
  ];
  for (const text of unsafe) {
    assert.equal(isSanitizedDiaryField(text), false, text);
  }
});

test("sanitizeDiaryEntry drops the whole entry when changed is unsafe or the date is malformed", () => {
  assert.equal(sanitizeDiaryEntry(entry({ changed: "詳細は https://example.com で。" })), null);
  assert.equal(sanitizeDiaryEntry(entry({ date: "2026/09/28" })), null);
  assert.equal(sanitizeDiaryEntry(entry({ date: "not-a-date" })), null);
});

// --- strict calendar-date validation (not just the YYYY-MM-DD shape) ---
//
// JS silently normalizes an overflowing day/month instead of rejecting it (e.g. 2026-09-31
// becomes 2026-10-01), so a shape-only check could let an impossible date slip through and later
// be misread as a real, nearby date by the freshness window -- never as intended.

test("isValidCalendarDate rejects an impossible day-of-month (2026-09-31: September has 30 days)", () => {
  assert.equal(isValidCalendarDate("2026-09-31"), false);
});

test("isValidCalendarDate rejects Feb 29 on a non-leap year (2026-02-29)", () => {
  assert.equal(isValidCalendarDate("2026-02-29"), false);
});

test("isValidCalendarDate accepts a real leap day (2028-02-29: 2028 is a leap year)", () => {
  assert.equal(isValidCalendarDate("2028-02-29"), true);
});

test("isValidCalendarDate accepts valid month-end dates", () => {
  assert.equal(isValidCalendarDate("2026-09-30"), true);
  assert.equal(isValidCalendarDate("2026-01-31"), true);
  assert.equal(isValidCalendarDate("2026-12-31"), true);
});

test("isValidCalendarDate rejects other impossible dates and malformed shapes", () => {
  for (const invalid of ["2026-13-01", "2026-00-01", "2026-04-31", "2026-02-30", "2026/09/28", "not-a-date", "", "2026-9-1"]) {
    assert.equal(isValidCalendarDate(invalid), false, invalid);
  }
});

test("sanitizeDiaryEntry drops an entry with an impossible calendar date, even though it matches the YYYY-MM-DD shape", () => {
  assert.equal(sanitizeDiaryEntry(entry({ date: "2026-09-31" })), null);
  assert.equal(sanitizeDiaryEntry(entry({ date: "2026-02-29" })), null);
  // A real date in the same shape still sanitizes normally.
  assert.ok(sanitizeDiaryEntry(entry({ date: "2026-09-30" })));
});

test("an impossible-date entry never reaches diary/current-progress mode; selectAiLabTopicSeed falls back to evergreen", () => {
  const markdown = `
## 2026-09-31
changed: 存在しない日付の変更。
angle: 存在しない日付の角度。
`;
  const result = selectAiLabTopicSeed({ markdown, now: new Date("2026-09-30T09:00:00Z"), random: () => 0 });
  assert.equal(result.source, "evergreen");
  assert.ok(EVERGREEN_TOPIC_SEEDS.includes(result.topic));
});

test("sanitizeDiaryEntry drops only the unsafe optional field, keeps the rest, and filters unsafe angles", () => {
  const sanitized = sanitizeDiaryEntry(
    entry({
      difficulty: "connect@example.com に聞いた。",
      angles: ["安全な角度。", "https://leak.example.com を含む角度。"],
    }),
  );
  assert.ok(sanitized);
  assert.equal(sanitized?.difficulty, null);
  assert.equal(sanitized?.changed, entry().changed);
  assert.deepEqual(sanitized?.angles, ["安全な角度。"]);
});

test("loadSanitizedDiaryEntries excludes unsafe entries but keeps safe ones from the same document", () => {
  const markdown = `
## 2026-09-20
changed: 安全な変更。

## 2026-09-21
changed: 危険な変更 https://example.com 。
`;
  const entries = loadSanitizedDiaryEntries(markdown);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].date, "2026-09-20");
});

// --- topic-seed selection: freshness, no fabrication, deterministic fixtures ---

const FIXED_RANDOM = () => 0; // always picks index 0, for deterministic fixtures

test("a fresh, safe entry's angle is selected over the evergreen fallback", () => {
  const markdown = `
## 2026-09-27
changed: 直近の変更。
angle: 直近の角度。
`;
  const result = selectAiLabTopicSeed({ markdown, now: new Date("2026-09-28T09:00:00Z"), random: FIXED_RANDOM });
  assert.deepEqual(result, { topic: "直近の角度。", source: "diary" });
});

test("an entry with no angles falls back to its changed field as the topic", () => {
  const markdown = `
## 2026-09-27
changed: 直近の変更だけ。
`;
  const result = selectAiLabTopicSeed({ markdown, now: new Date("2026-09-28T09:00:00Z"), random: FIXED_RANDOM });
  assert.deepEqual(result, { topic: "直近の変更だけ。", source: "diary" });
});

test("an entry older than maxAgeDays does not fabricate a 'today' topic; falls back to evergreen", () => {
  const markdown = `
## 2026-09-01
changed: だいぶ前の変更。
angle: だいぶ前の角度。
`;
  const result = selectAiLabTopicSeed({
    markdown,
    now: new Date("2026-09-28T09:00:00Z"),
    maxAgeDays: 3,
    random: FIXED_RANDOM,
  });
  assert.equal(result.source, "evergreen");
  assert.ok(EVERGREEN_TOPIC_SEEDS.includes(result.topic));
});

test("no diary content at all falls back to evergreen, never throws", () => {
  const result = selectAiLabTopicSeed({ markdown: "", now: new Date("2026-09-28T09:00:00Z"), random: FIXED_RANDOM });
  assert.equal(result.source, "evergreen");
  assert.ok(EVERGREEN_TOPIC_SEEDS.includes(result.topic));
});

test("an entry dated in the future relative to now is never selected (never claims something happened today ahead of time)", () => {
  const markdown = `
## 2026-10-05
changed: まだ起きていない変更。
angle: まだ起きていない角度。
`;
  const result = selectAiLabTopicSeed({ markdown, now: new Date("2026-09-28T09:00:00Z"), random: FIXED_RANDOM });
  assert.equal(result.source, "evergreen");
});

test("among multiple fresh entries, the most recent date wins", () => {
  const markdown = `
## 2026-09-26
changed: 古い方の変更。
angle: 古い方の角度。

## 2026-09-28
changed: 新しい方の変更。
angle: 新しい方の角度。
`;
  const result = selectAiLabTopicSeed({ markdown, now: new Date("2026-09-28T09:00:00Z"), random: FIXED_RANDOM });
  assert.deepEqual(result, { topic: "新しい方の角度。", source: "diary" });
});

test("an unsafe entry is skipped in favor of an older-but-safe fresh entry", () => {
  const markdown = `
## 2026-09-27
changed: 安全な変更。
angle: 安全な角度。

## 2026-09-28
changed: 危険な変更 https://example.com 。
`;
  const result = selectAiLabTopicSeed({ markdown, now: new Date("2026-09-28T09:00:00Z"), random: FIXED_RANDOM });
  assert.deepEqual(result, { topic: "安全な角度。", source: "diary" });
});

test("random selects among the candidates deterministically for a fixed seed", () => {
  const markdown = `
## 2026-09-28
changed: 変更点。
angle: 角度A。
angle: 角度B。
`;
  const first = selectAiLabTopicSeed({ markdown, now: new Date("2026-09-28T09:00:00Z"), random: () => 0 });
  const second = selectAiLabTopicSeed({ markdown, now: new Date("2026-09-28T09:00:00Z"), random: () => 0.9 });
  assert.equal(first.topic, "角度A。");
  assert.equal(second.topic, "角度B。");
});

// --- the real canonical file and its bundled snapshot (not a fixture) ---
//
// Supabase's Edge Function deploy bundles the module graph the function actually imports, not
// every sibling file in a directory -- a non-imported ai_lab_dev_diary_context.md is not
// guaranteed to reach production. So the *runtime* path (loadAiLabDevDiaryMarkdown, used by
// index.ts) reads a committed, `import`-ed snapshot constant instead of the .md file. This parity
// test is the guard against the two ever silently diverging (e.g. someone edits the Markdown and
// forgets to rerun generate_ai_lab_dev_diary_snapshot.ts before committing).

test("the bundled snapshot (what production actually loads) is byte-identical to a fresh read of the canonical Markdown -- no silent drift", async () => {
  const { readFile } = await import("node:fs/promises");
  const freshMarkdown = await readFile(new URL("./ai_lab_dev_diary_context.md", import.meta.url), "utf8");
  const bundledMarkdown = await loadAiLabDevDiaryMarkdown();
  assert.equal(
    bundledMarkdown,
    freshMarkdown,
    "ai_lab_dev_diary_context.snapshot.ts is stale -- rerun generate_ai_lab_dev_diary_snapshot.ts and commit both files",
  );
});

test("the real diary content (via the same loader index.ts uses) loads, parses, and every entry passes sanitization intact", async () => {
  const markdown = await loadAiLabDevDiaryMarkdown();
  const raw = parseDevDiaryMarkdown(markdown);
  const safe = loadSanitizedDiaryEntries(markdown);
  assert.ok(raw.length > 0, "expected at least one diary entry in the canonical file");
  assert.equal(safe.length, raw.length, "no entry in the checked-in diary file should be flagged unsafe");
  for (const e of safe) assert.ok(e.changed.length > 0);
});

test("selectAiLabTopicSeed against the real bundled diary picks a diary-sourced (not evergreen) topic the day after its freshest entry", async () => {
  const markdown = await loadAiLabDevDiaryMarkdown();
  const entries = parseDevDiaryMarkdown(markdown);
  const freshestDate = entries.map((e) => e.date).sort().at(-1);
  assert.ok(freshestDate, "expected at least one dated entry");
  const dayAfter = new Date(`${freshestDate}T00:00:00Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  const result = selectAiLabTopicSeed({ markdown, now: dayAfter, random: () => 0 });
  assert.equal(result.source, "diary");
});

test("evergreen topic seeds are themselves sanitized, non-empty, and phrased as ongoing reflections (not a specific past-tense 'today I did X' claim)", () => {
  for (const topic of EVERGREEN_TOPIC_SEEDS) {
    assert.equal(isSanitizedDiaryField(topic), true, topic);
    // A seed may reference "today" as part of a general habit/mindset (as in the
    // TASK's own approved example 3), but must not itself assert a completed,
    // dated event -- the model still writes the actual post from this seed plus
    // the brand voice instructions, which forbid inventing results.
    assert.doesNotMatch(topic, /今日は.*(した|だった|完了した)/u, topic);
  }
});
