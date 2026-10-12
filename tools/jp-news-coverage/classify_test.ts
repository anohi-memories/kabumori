import assert from "node:assert/strict";
import test from "node:test";
import { classify, computeMetrics } from "./classify.ts";
import { FIXTURES } from "./fixtures.ts";

test("fixtures: at least 14 synthetic events covering every required group, at least 2 each", () => {
  assert.ok(FIXTURES.length >= 14);
  const groups = new Map<string, number>();
  for (const event of FIXTURES) groups.set(event.group, (groups.get(event.group) ?? 0) + 1);
  for (const group of ["corporate_scandal", "incident_accident", "financial_regulation_bank_failure", "boj_policy", "earthquake_missile", "administrative_action_litigation", "negative_control"]) {
    assert.ok((groups.get(group) ?? 0) >= 2, group);
  }
});

test("every fixture's four axes and miss reason equal the stated expectation", () => {
  for (const event of FIXTURES) assert.deepEqual(classify(event), event.expected, event.id);
});

test("axes are independent: eligible_for_app is wider than urgent_push, and discovered is wider than relevant", () => {
  const byId = new Map(FIXTURES.map((event) => [event.id, classify(event)]));
  assert.deepEqual([byId.get("ia-2")?.eligible_for_app, byId.get("ia-2")?.urgent_push], [true, false]);
  assert.deepEqual([byId.get("nc-1")?.discovered, byId.get("nc-1")?.relevant], [true, false]);
  assert.equal(FIXTURES.filter((event) => classify(event).urgent_push).every((event) => classify(event).eligible_for_app), true);
});

test("negative controls never become eligible or urgent (rumour, retraction, reprint, foreign-only)", () => {
  for (const event of FIXTURES.filter((item) => item.group === "negative_control")) {
    const result = classify(event);
    assert.equal(result.eligible_for_app, false, event.id);
    assert.equal(result.urgent_push, false, event.id);
  }
});

test("an unverified single-source or rumour item is never urgent even at emergency severity", () => {
  const rumor = FIXTURES.find((event) => event.id === "fr-2");
  assert.ok(rumor);
  assert.equal(classify({ ...rumor, feed_available: true, rights_ok: true }).urgent_push, false);
});

test("metrics: recall / app reach / miss reasons / latency computed; absent timestamps give NOT_AVAILABLE", () => {
  const truth = new Set(["cs-1", "cs-2", "ia-1", "ia-2", "fr-1", "bj-1", "em-1", "em-2", "al-1", "al-2"]);
  const metrics = computeMetrics(FIXTURES, truth);
  assert.equal(metrics.relevantEvents, 10);
  // discovered among truth: cs-1, ia-2, fr-1, bj-1, em-1, al-2 = 6
  assert.equal(metrics.eventRecall, 0.6);
  assert.equal(metrics.appReach, 1);
  assert.deepEqual(metrics.missReasons, { terms_excluded: 1, no_source: 3 });
  assert.ok(typeof metrics.latencyP50S === "number");
  assert.equal(computeMetrics([], new Set()).eventRecall, "NOT_AVAILABLE");
  const noTime = FIXTURES.map((event) => ({ ...event, first_public_to_fetched_s: null }));
  assert.equal(computeMetrics(noTime, truth).latencyP50S, "NOT_AVAILABLE");
});
