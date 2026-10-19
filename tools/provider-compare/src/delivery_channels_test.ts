import assert from "node:assert/strict";
import test from "node:test";
import { type ChannelRow, failureRateDefinitions, groupEvents, reachOf, shiftDay, summariseChannels } from "./delivery_channels.ts";

let counter = 0;
function row(over: Partial<ChannelRow> = {}): ChannelRow {
  counter += 1;
  return {
    id8: `r${String(counter).padStart(7, "0")}`, source_name: "tdnet", source_type: "tdnet", importance: "important", status: "published",
    title: `title ${counter}`, news_jst: "2026-10-05 10:00:00", is_duplicate: false, created_day: "2026-10-05", company_code: "12340",
    category: "other_corporate_ir", severity: "high", x_posted: true, x_text_passed: true, app_copy_passed: false, app_copy_status: "",
    japanese_title: true, feed_status: true, notifications: 0, notifications_sent: 0, ...over,
  };
}

test("X and the app are different channels: a rejected disclosure can be in the app and not on X", () => {
  const rejected = reachOf(row({ importance: "no_post", status: "rejected", severity: "medium", x_posted: false, x_text_passed: false }));
  assert.equal(rejected.x, false);
  assert.equal(rejected.appListed, true);
  assert.equal(rejected.appText, false);
  assert.equal(rejected.pushable, false);
});

test("a rejected item that is not a TDnet / company IR disclosure is not listed, whatever its severity", () => {
  const macro = reachOf(row({ source_type: "market_macro", source_name: "market_macro", company_code: "", importance: "no_post", status: "rejected", severity: "medium", x_posted: false, x_text_passed: false }));
  assert.equal(macro.appListed, false);
});

test("a failed generation can still reach the app and push through the app copy", () => {
  const r = reachOf(row({ status: "generation_failed", x_posted: false, x_text_passed: false, app_copy_passed: true, notifications: 2, notifications_sent: 2 }));
  assert.deepEqual([r.x, r.appListed, r.appText, r.pushable, r.notified, r.sent], [false, true, true, true, true, true]);
});

test("low or unknown severity is not listed, and unknown is reported rather than guessed", () => {
  assert.equal(reachOf(row({ severity: "low" })).appListed, false);
  const unknown = reachOf(row({ severity: "unknown" }));
  assert.equal(unknown.appListed, false);
  assert.equal(unknown.severityUnknown, true);
});

test("duplicates are never listed", () => {
  assert.equal(reachOf(row({ is_duplicate: true })).appListed, false);
});

test("events: one issuer, one category, one day is one event; market items group by title overlap", () => {
  const a = row({ id8: "a0000001", company_code: "25030", category: "administrative_action", title: "公取委の捜索", x_posted: false });
  const b = row({ id8: "a0000002", company_code: "25030", category: "administrative_action", title: "公取委の捜索について（続報）", x_posted: true });
  const c = row({ id8: "a0000003", company_code: "99990", category: "administrative_action" });
  const m1 = row({ id8: "m0000001", company_code: "", source_type: "breaking_market", title: "Japan beer giants raided over alleged price-fixing cartel", news_jst: "2026-10-07 18:00:00" });
  const m2 = row({ id8: "m0000002", company_code: "", source_type: "breaking_market", title: "Japan beer giants raided over price-fixing cartel allegation", news_jst: "2026-10-07 20:30:00" });
  const m3 = row({ id8: "m0000003", company_code: "", source_type: "breaking_market", title: "Yen advances sharply against the dollar", news_jst: "2026-10-07 20:40:00" });
  const g = groupEvents([a, b, c, m1, m2, m3]);
  assert.equal(g.get("a0000001"), g.get("a0000002"));
  assert.notEqual(g.get("a0000001"), g.get("a0000003"));
  assert.equal(g.get("m0000001"), g.get("m0000002"));
  assert.notEqual(g.get("m0000001"), g.get("m0000003"));
});

test("event-level reach counts an event as reached when any of its candidates was", () => {
  const rows = [
    row({ id8: "e0000001", company_code: "25030", category: "administrative_action", x_posted: false, status: "rejected", importance: "no_post", severity: "medium", x_text_passed: false }),
    row({ id8: "e0000002", company_code: "25030", category: "administrative_action", x_posted: true }),
    row({ id8: "e0000003", company_code: "77770", category: "ma", x_posted: false, status: "generation_failed", severity: "low", x_text_passed: false }),
  ];
  const s = summariseChannels(rows);
  assert.equal(s.candidates, 3);
  assert.equal(s.events, 2);
  assert.deepEqual(s.x, { candidates: 1, events: 1 });
  assert.equal(s.appListed.candidates, 2);
  assert.deepEqual(s.none, { candidates: 1, events: 1 });
});

test("one numerator, many denominators: each definition states its rule and they differ for stated reasons", () => {
  const rows: ChannelRow[] = [];
  for (let i = 0; i < 6; i += 1) rows.push(row({ created_day: "2026-09-12", status: i < 5 ? "generation_failed" : "published", x_posted: i >= 5 }));
  for (let i = 0; i < 10; i += 1) rows.push(row({ created_day: "2026-10-08", status: i < 2 ? "generation_failed" : "published", x_posted: i >= 2 }));
  for (let i = 0; i < 30; i += 1) rows.push(row({ created_day: "2026-10-08", importance: "no_post", status: "rejected", x_posted: false }));
  const defs = failureRateDefinitions(rows, { windowFrom: "2026-09-10", windowTo: "2026-10-09" });
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  assert.equal(byName["A all important+ in window"].numerator, 7);
  assert.equal(byName["A all important+ in window"].denominator, 16);
  assert.equal(byName["E all judged, no_post included"].denominator, 46);
  assert.equal(byName["F last 7 days, important+"].numerator, 2);
  assert.equal(byName["F last 7 days, important+"].denominator, 10);
  assert.equal(byName["F last 7 days, important+"].rate, 0.2);
  assert.equal(byName["I last 7 days, all judged"].denominator, 40);
  assert.ok(defs.every((d) => d.rule.length > 0 && d.window.length > 0));
});

test("day arithmetic crosses month and year ends", () => {
  assert.equal(shiftDay("2026-10-09", -6), "2026-10-03");
  assert.equal(shiftDay("2026-10-02", -6), "2026-09-26");
  assert.equal(shiftDay("2026-01-03", -6), "2025-12-28");
});
