import assert from "node:assert/strict";
import test from "node:test";

import {
  isTopicLevel,
  mapDifficultyToLevel,
  parseDailyTipRow,
  readTopicLevelFrom,
  topicCardStatus,
  topicKeyMatches,
  writeTopicLevelTo,
  TOPIC_LEVEL_STORAGE_KEY,
  type KeyValueStorage,
} from "../../src/lib/home-topic.ts";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => {
      store.set(key, value);
    },
  };
}

function failingStorage(): KeyValueStorage {
  return {
    getItem: async () => {
      throw new Error("boom");
    },
    setItem: async () => {
      throw new Error("boom");
    },
  };
}

// --- preference read/write ------------------------------------------------

test("reads default beginner when nothing is stored", async () => {
  assert.equal(await readTopicLevelFrom(memoryStorage()), "beginner");
});

test("round-trips all three valid levels", async () => {
  for (const level of ["beginner", "intermediate", "advanced"] as const) {
    const storage = memoryStorage();
    assert.equal(await writeTopicLevelTo(storage, level), true);
    assert.equal(await readTopicLevelFrom(storage), level);
  }
});

test("a malformed stored value fails soft to beginner", async () => {
  const storage = memoryStorage({ [TOPIC_LEVEL_STORAGE_KEY]: "expert" });
  assert.equal(await readTopicLevelFrom(storage), "beginner");
});

test("a storage read failure fails soft to beginner", async () => {
  assert.equal(await readTopicLevelFrom(failingStorage()), "beginner");
});

test("a storage write failure returns false -- callers must not claim success", async () => {
  assert.equal(await writeTopicLevelTo(failingStorage(), "advanced"), false);
});

test("isTopicLevel rejects anything outside the three canonical values", () => {
  assert.equal(isTopicLevel("beginner"), true);
  assert.equal(isTopicLevel("expert"), false);
  assert.equal(isTopicLevel(null), false);
  assert.equal(isTopicLevel(42), false);
});

// --- difficulty <-> level mapping -----------------------------------------

test("maps every DB difficulty value to its app level", () => {
  assert.equal(mapDifficultyToLevel("初級"), "beginner");
  assert.equal(mapDifficultyToLevel("中級"), "intermediate");
  assert.equal(mapDifficultyToLevel("実践"), "advanced");
});

test("rejects an unrecognized difficulty rather than guessing", () => {
  assert.equal(mapDifficultyToLevel("expert"), null);
  assert.equal(mapDifficultyToLevel(""), null);
  assert.equal(mapDifficultyToLevel(null), null);
  assert.equal(mapDifficultyToLevel(123), null);
});

// --- daily tip row validation ----------------------------------------------

test("parses a well-formed RPC row into a HomeTopic, keeping id and category", () => {
  const row = { id: "t1", title: "PERって何？", category: "株の基礎", base_text: "PERの説明。", difficulty: "初級" };
  assert.deepEqual(parseDailyTipRow(row), {
    id: "t1",
    level: "beginner",
    category: "株の基礎",
    title: "PERって何？",
    body: "PERの説明。",
  });
});

test("a row with a missing/blank category still parses, with category null", () => {
  const row = { id: "t1", title: "t", base_text: "b", difficulty: "初級" };
  assert.deepEqual(parseDailyTipRow(row), { id: "t1", level: "beginner", category: null, title: "t", body: "b" });
  const blank = { id: "t1", title: "t", category: "  ", base_text: "b", difficulty: "初級" };
  assert.equal(parseDailyTipRow(blank)?.category, null);
});

test("no row (RPC returned nothing) is the honest empty state, not an error", () => {
  assert.equal(parseDailyTipRow(null), null);
  assert.equal(parseDailyTipRow(undefined), null);
});

test("a row with an unrecognized difficulty is rejected rather than shown with a wrong badge", () => {
  const row = { id: "t1", title: "t", base_text: "b", difficulty: "expert" };
  assert.equal(parseDailyTipRow(row), null);
});

test("a row missing id, title, or base_text is rejected rather than shown blank/mismatched", () => {
  assert.equal(parseDailyTipRow({ id: "", title: "t", base_text: "b", difficulty: "初級" }), null);
  assert.equal(parseDailyTipRow({ id: "t1", title: "", base_text: "b", difficulty: "初級" }), null);
  assert.equal(parseDailyTipRow({ id: "t1", title: "t", base_text: "   ", difficulty: "初級" }), null);
  assert.equal(parseDailyTipRow({ id: "t1", difficulty: "初級" }), null);
});

// --- topic card status (mirrors reportCardStatus) --------------------------

test("topicCardStatus: a fetch error is never shown as the '準備中' empty state", () => {
  assert.equal(topicCardStatus(false, false, "今日のトピックを取得できませんでした。"), "error");
});

test("topicCardStatus: loading only applies while nothing is shown yet", () => {
  assert.equal(topicCardStatus(false, true, ""), "loading");
  assert.equal(topicCardStatus(true, true, ""), "topic");
});

test("topicCardStatus: an already-loaded topic survives a later refresh error", () => {
  assert.equal(topicCardStatus(true, false, "今日のトピックを取得できませんでした。"), "topic");
});

test("topicCardStatus: no topic and no error, loading finished, is the honest empty state", () => {
  assert.equal(topicCardStatus(false, false, ""), "empty");
});

// --- topic request key (K1 finding 1: stale content across a level/date change) ---

test("topicKeyMatches: a topic loaded for beginner does not match after changing to advanced", () => {
  const loaded = { level: "beginner" as const, jstDate: "2026-09-28" };
  const currentAfterChange = { level: "advanced" as const, jstDate: "2026-09-28" };
  assert.equal(topicKeyMatches(loaded, currentAfterChange), false);
});

test("topicKeyMatches: same date + same level (a same-key refresh failure) may still show the loaded topic", () => {
  const loaded = { level: "beginner" as const, jstDate: "2026-09-28" };
  const current = { level: "beginner" as const, jstDate: "2026-09-28" };
  assert.equal(topicKeyMatches(loaded, current), true);
});

test("topicKeyMatches: a successful level change is reflected once the key is updated to match", () => {
  const afterSuccessfulFetch = { level: "advanced" as const, jstDate: "2026-09-28" };
  const current = { level: "advanced" as const, jstDate: "2026-09-28" };
  assert.equal(topicKeyMatches(afterSuccessfulFetch, current), true);
});

test("topicKeyMatches: a topic loaded for yesterday does not match after the JST date rolls over", () => {
  const loaded = { level: "beginner" as const, jstDate: "2026-09-27" };
  const currentAfterRollover = { level: "beginner" as const, jstDate: "2026-09-28" };
  assert.equal(topicKeyMatches(loaded, currentAfterRollover), false);
});

test("topicKeyMatches: nothing loaded yet never matches", () => {
  assert.equal(topicKeyMatches(null, { level: "beginner", jstDate: "2026-09-28" }), false);
});
