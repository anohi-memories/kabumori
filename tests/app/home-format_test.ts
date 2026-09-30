import assert from "node:assert/strict";
import test from "node:test";

import { companyInitial, companyMark, newsTint, rowTint, relativeTimeJa } from "../../src/lib/home-format.ts";

const NOW = new Date("2026-09-30T12:00:00Z");

test("relativeTimeJa renders minutes, hours and days", () => {
  assert.equal(relativeTimeJa("2026-09-30T11:59:40Z", NOW), "たった今");
  assert.equal(relativeTimeJa("2026-09-30T11:15:00Z", NOW), "45分前");
  assert.equal(relativeTimeJa("2026-09-30T10:00:00Z", NOW), "2時間前");
  assert.equal(relativeTimeJa("2026-09-30T09:00:00Z", NOW), "3時間前");
  assert.equal(relativeTimeJa("2026-09-28T12:00:00Z", NOW), "2日前");
});

test("relativeTimeJa falls back to month/day after a week, and never shows a wrong time", () => {
  assert.match(relativeTimeJa("2026-09-01T12:00:00Z", NOW), /^\d{1,2}\/\d{1,2}$/);
  assert.equal(relativeTimeJa("not a date", NOW), "");
  assert.equal(relativeTimeJa("2026-09-30T13:00:00Z", NOW), "たった今", "a clock-skewed future item is not shown as negative");
});

test("companyInitial takes the first character, tolerating whitespace and empty names", () => {
  assert.equal(companyInitial("サンリオ"), "サ");
  assert.equal(companyInitial("  ニッスイ"), "ニ");
  assert.equal(companyInitial(""), "·");
});

test("newsTint is deterministic from coverage categories with a neutral fallback", () => {
  assert.equal(newsTint(["monetary_policy"]).foreground, "#2f5fb3");
  assert.equal(newsTint(["unknown", "semiconductors"]).foreground, "#1f7a63");
  assert.deepEqual(newsTint(null), newsTint([]));
  assert.equal(newsTint([]).background, "#e9f3ec");
});

test("companyMark keeps companies with the same initial apart", () => {
  assert.equal(companyMark("サンリオ"), "サン");
  assert.equal(companyMark("サイバーエージェント"), "サイ");
  assert.notEqual(companyMark("サンリオ"), companyMark("サイバーエージェント"));
  assert.equal(companyMark("A"), "A");
  assert.equal(companyMark(""), "·");
});

test("rowTint gives neighbouring rows different colours and wraps around", () => {
  const tints = [0, 1, 2, 3, 4, 5].map((index) => rowTint(index).background);
  for (let index = 1; index < tints.length; index++) assert.notEqual(tints[index], tints[index - 1]);
  assert.deepEqual(rowTint(5), rowTint(0));
  assert.deepEqual(rowTint(-1), rowTint(4));
});
