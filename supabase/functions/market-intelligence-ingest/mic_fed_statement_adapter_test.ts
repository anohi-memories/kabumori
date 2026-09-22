import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOfficialFedStatementUrl,
  buildFedDecisionEvent,
  classifyFedDecision,
  FedStatementAdapterError,
  fetchFedStatementEvents,
  extractOfficialFedStatementUrls,
  fetchFedStatement,
  parseFedStatementHtml,
  parseFedPublishedAt,
  parseFedTargetRange,
  statementIdentityChanged,
} from "./mic_fed_statement_adapter.ts";
import { finalizeMarketEvent } from "./mic_normalize_logic.ts";

const URL = "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm";
const HTML = `
<html><head><title>Federal Reserve issues FOMC statement</title></head><body>
<h1>Federal Reserve issues FOMC statement</h1>
<p>September 15-16, 2026</p>
<p>September 16, 2026</p>
<p>For release at 2:00 p.m. EDT</p>
<p>The Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent, in support of its dual mandate.</p>
<p>Economic activity is expanding at a solid pace. Inflation remains elevated.</p>
</body></html>`;

test("official URL acceptance rejects third-party and non-statement URLs", () => {
  assert.equal(assertOfficialFedStatementUrl(URL), URL);
  assert.throws(() => assertOfficialFedStatementUrl("https://example.com/fomc.htm"), FedStatementAdapterError);
  assert.throws(() => assertOfficialFedStatementUrl("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"), /FED_NON_OFFICIAL_URL/);
});

test("calendar selector prefers the exact a.htm statement and excludes implementation notes and unrelated links", () => {
  const calendar = `
    <a href="/newsevents/pressreleases/monetary20260916a1.htm">Implementation Note</a>
    <a href="/newsevents/pressreleases/monetary20260916b.htm">Press conference materials</a>
    <a href="/newsevents/pressreleases/monetary20260916a.htm">Federal Reserve issues FOMC statement</a>
    <a href="https://example.com/monetary20260916a.htm">Statement</a>`;
  assert.deepEqual(extractOfficialFedStatementUrls(calendar), [URL]);
});

test("statement parser extracts meeting date, publication time, target range, and normalized hash", async () => {
  const parsed = await parseFedStatementHtml(URL, HTML, { lower: 3.5, upper: 3.75 });
  assert.equal(parsed.meetingDate, "2026-09-15");
  assert.equal(parsed.publishedAt, "2026-09-16T18:00:00.000Z");
  assert.deepEqual(parsed.targetRange, { lower: 3.75, upper: 4 });
  assert.equal(parsed.decision, "hike");
  assert.match(parsed.documentHash, /^[0-9a-f]{64}$/);
  assert.match(parsed.normalizedText, /Federal Reserve issues FOMC statement/);
});

test("target-range parser handles decimal and unicode fraction forms", () => {
  assert.deepEqual(parseFedTargetRange("The target range for the federal funds rate is 3.75 to 4 percent."), { lower: 3.75, upper: 4 });
  assert.deepEqual(parseFedTargetRange("The target range for the federal funds rate is 3¾ to 4 percent."), { lower: 3.75, upper: 4 });
  assert.equal(parseFedTargetRange("The Committee maintained its balance sheet policy."), null);
});

test("decision classification is deterministic for hike, cut, hold, mixed, and non-rate", () => {
  assert.equal(classifyFedDecision({ lower: 3.5, upper: 3.75 }, { lower: 3.75, upper: 4 }), "hike");
  assert.equal(classifyFedDecision({ lower: 3.75, upper: 4 }, { lower: 3.5, upper: 3.75 }), "cut");
  assert.equal(classifyFedDecision({ lower: 3.75, upper: 4 }, { lower: 3.75, upper: 4 }), "hold");
  assert.equal(classifyFedDecision({ lower: 3.75, upper: 4 }, { lower: 3.75, upper: 4.25 }), "mixed");
  assert.equal(classifyFedDecision({ lower: 3.75, upper: 4 }, null), "non_rate");
});

test("event keeps statement publication separate from effective date and carries both rate changes", async () => {
  const statement = await parseFedStatementHtml(URL, HTML, { lower: 3.5, upper: 3.75 });
  const event = buildFedDecisionEvent(statement, { lower: 3.5, upper: 3.75 });
  assert.equal(event.eventType, "central_bank_decision");
  assert.equal(event.publishedAt, "2026-09-16T18:00:00.000Z");
  assert.equal(event.occurredAt, "2026-09-15T00:00:00.000Z");
  assert.equal(event.sourceKey, "fed");
  assert.equal(event.sourceName, "Federal Reserve");
  assert.deepEqual(event.rawPayload?.rates, {
    FED_FUNDS_TARGET_LOWER: { old_rate: 3.5, new_rate: 3.75, change_bps: 25 },
    FED_FUNDS_TARGET_UPPER: { old_rate: 3.75, new_rate: 4, change_bps: 25 },
  });
  assert.equal(event.rawPayload?.effective_at, null, "effective date is not inferred from statement publication");
  assert.notEqual(event.rawPayload?.document_hash, URL, "identity is document content, not URL alone");
});

test("meeting identity yields duplicate, revision, and new-meeting outcomes", () => {
  const previous = { meetingDate: "2026-09-15", documentHash: "a".repeat(64) };
  assert.equal(statementIdentityChanged(previous, previous), "duplicate");
  assert.equal(statementIdentityChanged(previous, { meetingDate: "2026-09-15", documentHash: "b".repeat(64) }), "revision");
  assert.equal(statementIdentityChanged(previous, { meetingDate: "2026-10-27", documentHash: "a".repeat(64) }), "new_meeting");
});

test("event content identity is stable for duplicates and changes for revisions/new meetings", async () => {
  const base = await parseFedStatementHtml(URL, HTML, { lower: 3.5, upper: 3.75 });
  const duplicate = await finalizeMarketEvent(buildFedDecisionEvent(base, { lower: 3.5, upper: 3.75 }));
  const revised = await parseFedStatementHtml(URL, HTML.replace("Inflation remains elevated.", "Inflation remains elevated and persistent."), { lower: 3.5, upper: 3.75 });
  const revisionEvent = await finalizeMarketEvent(buildFedDecisionEvent(revised, { lower: 3.5, upper: 3.75 }));
  const newMeeting = { ...base, meetingDate: "2026-10-27", documentHash: "c".repeat(64) };
  const newMeetingEvent = await finalizeMarketEvent(buildFedDecisionEvent(newMeeting, { lower: 3.75, upper: 4 }));
  assert.equal(duplicate.contentHash, (await finalizeMarketEvent(buildFedDecisionEvent(base, { lower: 3.5, upper: 3.75 }))).contentHash);
  assert.notEqual(duplicate.contentHash, revisionEvent.contentHash);
  assert.notEqual(duplicate.contentHash, newMeetingEvent.contentHash);
});

test("malformed HTML and missing target range are safe", async () => {
  await assert.rejects(() => parseFedStatementHtml(URL, "<html><body>tiny</body></html>"), /FED_MALFORMED_HTML/);
  const nonRate = await parseFedStatementHtml(
    URL,
    HTML.replace(/The Committee decided[\s\S]*?<\/p>/, "The Committee continued balance sheet operations.</p>"),
  );
  assert.equal(nonRate.targetRange, null);
  assert.equal(nonRate.decision, "non_rate");
});

test("publication timestamp requires an explicit timezone and never fabricates midnight", () => {
  assert.equal(parseFedPublishedAt("September 16, 2026 For release at 2:00 p.m. EDT"), "2026-09-16T18:00:00.000Z");
  assert.throws(() => parseFedPublishedAt("September 16, 2026"), /FED_PUBLISHED_AT_MISSING/);
  assert.throws(() => parseFedPublishedAt("September 16, 2026 For release at 2:00 p.m."), /FED_PUBLISHED_AT_MISSING/);
});

test("fetch accepts only the official URL and returns HTML without storing it", async () => {
  const calls: string[] = [];
  const html = await fetchFedStatement(URL, (url) => {
    calls.push(String(url));
    return Promise.resolve(new Response(HTML, { status: 200 }));
  });
  assert.deepEqual(calls, [URL]);
  assert.match(html, /target range/);
  await assert.rejects(() => fetchFedStatement("https://example.com/fomc.htm", () => Promise.resolve(new Response(HTML))), /FED_NON_OFFICIAL_URL/);
});

test("official calendar dispatch fetches the latest statement and cross-checks FRED target range", async () => {
  const calendar = `<a href="/newsevents/pressreleases/monetary20260916a.htm">Statement</a>`;
  assert.deepEqual(extractOfficialFedStatementUrls(calendar), [URL]);
  const calls: string[] = [];
  const events = await fetchFedStatementEvents((url) => {
    calls.push(String(url));
    return Promise.resolve(new Response(String(url) === URL ? HTML : calendar, { status: 200 }));
  }, { lower: 3.5, upper: 3.75 });
  assert.deepEqual(calls, ["https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", URL]);
  assert.equal(events[0].eventType, "central_bank_decision");
  assert.equal(events[0].rawPayload?.decision, "hike");
  assert.equal(events[0].rawPayload?.is_revision, false);
  assert.equal(events[0].rawPayload?.content_hash, events[0].rawPayload?.document_hash);
  assert.deepEqual(events[0].rawPayload?.rates, {
    FED_FUNDS_TARGET_LOWER: { old_rate: 3.5, new_rate: 3.75, change_bps: 25 },
    FED_FUNDS_TARGET_UPPER: { old_rate: 3.75, new_rate: 4, change_bps: 25 },
  });
});

test("same meeting with a changed document hash is marked as a revision", async () => {
  const revisedHtml = HTML.replace("Inflation remains elevated.", "Inflation remains elevated and persistent.");
  const events = await fetchFedStatementEvents((url) => {
    const value = String(url) === URL ? revisedHtml : `<a href="${URL}">Statement</a>`;
    return Promise.resolve(new Response(value, { status: 200 }));
  }, { lower: 3.5, upper: 3.75 }, [{ meetingDate: "2026-09-15", documentHash: "a".repeat(64) }]);
  assert.equal(events[0].rawPayload?.is_revision, true);
});
