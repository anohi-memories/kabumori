import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateImportantNewsRateControl,
  orderImportantNewsPublishQueue,
} from "./rate_control_logic.ts";

const now = new Date("2026-08-31T06:20:00.000Z");

test("important can publish eleven minutes after the previous important-news post", () => {
  assert.equal(evaluateImportantNewsRateControl("important", "2026-08-31T06:09:00Z", now).allowed, true);
});

test("important waits five minutes after the previous important-news post", () => {
  const result = evaluateImportantNewsRateControl("important", "2026-08-31T06:15:00Z", now);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "NEWS_PUBLISH_RATE_LIMITED");
  assert.equal(result.rateLimitedUntil, "2026-08-31T06:25:00.000Z");
});

test("exactly ten minutes is publishable", () => {
  assert.equal(evaluateImportantNewsRateControl("important", "2026-08-31T06:10:00Z", now).allowed, true);
});

test("most_important bypasses the ordinary ten-minute interval", () => {
  const result = evaluateImportantNewsRateControl("most_important", "2026-08-31T06:19:00Z", now);
  assert.equal(result.allowed, true);
  assert.equal(result.bypassed, true);
});

test("important with no prior important-news post remains publishable", () => {
  assert.equal(evaluateImportantNewsRateControl("important", null, now).allowed, true);
});

test("publish queue prioritizes importance and then the oldest candidate", () => {
  const ordered = orderImportantNewsPublishQueue([
    { id: "important-new", importance: "important", generatedAt: "2026-08-31T06:10:00Z" },
    { id: "most-new", importance: "most_important", generatedAt: "2026-08-31T06:15:00Z" },
    { id: "important-old", importance: "important", generatedAt: "2026-08-31T06:00:00Z" },
    { id: "most-old", importance: "most_important", generatedAt: "2026-08-31T06:05:00Z" },
  ]);
  assert.deepEqual(ordered.map((item) => item.id), ["most-old", "most-new", "important-old", "important-new"]);
});
