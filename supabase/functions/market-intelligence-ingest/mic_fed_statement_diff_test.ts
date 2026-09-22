import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFedStatementAiInput,
  buildFedStatementDiff,
  buildFedStatementDiffIdentity,
  classifyFedStatementBuckets,
  FED_STATEMENT_DIFF_STORAGE,
  selectPreviousFedStatement,
  shouldRunFedStatementAi,
  splitFedStatementParagraphs,
  validateFedStatementAiOutput,
  type FedStatementRecord,
} from "./mic_fed_statement_diff.ts";

const previous: FedStatementRecord = {
  eventId: "event-previous",
  centralBank: "Fed",
  meetingDate: "2026-07-29",
  documentHash: "a".repeat(64),
  statementUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm",
  decision: "hold",
  targetRange: { lower: 3.75, upper: 4 },
  normalizedText: [
    "The Committee is strongly committed to supporting maximum employment and returning inflation to its 2 percent objective.",
    "Economic activity has continued to expand at a solid pace. Job gains have remained robust, and the unemployment rate has remained low.",
    "The Committee will carefully assess incoming data, the evolving outlook, and the balance of risks.",
    "The Committee decided to maintain the target range for the federal funds rate at 3-3/4 to 4 percent.",
  ].join("\n"),
};

const current: FedStatementRecord = {
  eventId: "event-current",
  centralBank: "Fed",
  meetingDate: "2026-09-16",
  documentHash: "b".repeat(64),
  statementUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm",
  decision: "hold",
  targetRange: { lower: 3.75, upper: 4 },
  normalizedText: [
    "The Committee is strongly committed to supporting maximum employment and returning inflation to its 2 percent objective.",
    "Economic activity has continued to expand at a moderate pace. Job gains have remained solid, and the unemployment rate has remained low.",
    "The Committee will carefully assess incoming data, the evolving outlook, and the balance of risks.",
    "The Committee decided to maintain the target range for the federal funds rate at 3-3/4 to 4 percent.",
    "The Committee will continue reducing its holdings of Treasury securities and agency debt and mortgage-backed securities.",
  ].join("\n"),
};

test("previous statement selects latest earlier Fed meeting by meeting_date", () => {
  const selected = selectPreviousFedStatement([
    { ...previous, meetingDate: "2026-06-17", eventId: "older" },
    previous,
    { ...current, meetingDate: "2026-10-28", eventId: "future" },
    { ...previous, centralBank: "Fed", meetingDate: "2026-07-29", eventId: "same-date-later-created" },
  ], current.meetingDate);
  assert.equal(selected?.eventId, "event-previous");
  assert.equal(selectPreviousFedStatement([], current.meetingDate), null);
});

test("paragraph normalization filters boilerplate but preserves policy paragraphs", () => {
  const paragraphs = splitFedStatementParagraphs("Header\nThe Committee will assess incoming data and risks.\nCopyright 2026\nInflation remains elevated.");
  assert.deepEqual(paragraphs, ["The Committee will assess incoming data and risks.", "Inflation remains elevated."]);
});

test("deterministic diff finds unchanged, modified, added, and removed paragraphs", async () => {
  const result = await buildFedStatementDiff(previous, current);
  assert.equal(result.unchangedParagraphs.length, 3);
  assert.equal(result.modifiedParagraphs.length, 1);
  assert.equal(result.addedParagraphs.length, 1);
  assert.equal(result.removedParagraphs.length, 0);
  assert.equal(result.material, true);
  assert.match(result.diffHash, /^[0-9a-f]{64}$/);

  const removed = await buildFedStatementDiff(previous, {
    ...current,
    eventId: "current-with-removal",
    normalizedText: current.normalizedText.replace("The Committee will carefully assess incoming data, the evolving outlook, and the balance of risks.\n", ""),
  });
  assert.equal(removed.removedParagraphs.length, 1);
  assert.equal(removed.addedParagraphs.length, 1);
});

test("identical and punctuation-only statements are non-material", async () => {
  const identical = await buildFedStatementDiff(previous, { ...previous, eventId: "current" });
  assert.equal(identical.material, false);
  const punctuation = await buildFedStatementDiff(previous, { ...previous, eventId: "current", normalizedText: previous.normalizedText.replaceAll(".", "!") });
  assert.equal(punctuation.material, false);
});

test("semantic buckets cover inflation, labor, growth, guidance, balance sheet, and risks", () => {
  assert.ok(classifyFedStatementBuckets("Inflation remains elevated and employment is strong.").includes("inflation"));
  assert.ok(classifyFedStatementBuckets("Inflation remains elevated and employment is strong.").includes("labor"));
  assert.ok(classifyFedStatementBuckets("Economic activity and growth are moderate.").includes("growth/activity"));
  assert.ok(classifyFedStatementBuckets("The Committee expects policy to remain restrictive.").includes("forward guidance"));
  assert.ok(classifyFedStatementBuckets("The balance sheet runoff will continue.").includes("balance_sheet"));
  assert.ok(classifyFedStatementBuckets("The outlook remains uncertain and risks are balanced.").includes("risks"));
});

test("material gate returns no AI input for insignificant member/date changes", async () => {
  const diff = await buildFedStatementDiff(previous, {
    ...previous,
    eventId: "current",
    normalizedText: previous.normalizedText.replace("2026", "2027").replace("Job gains", "Voting member gains"),
  });
  assert.equal(diff.material, false);
  assert.equal(buildFedStatementAiInput(previous, current, diff), null);
});

test("material gate builds compact AI input without statement bodies", async () => {
  const diff = await buildFedStatementDiff(previous, current);
  const input = buildFedStatementAiInput(previous, current, diff);
  assert.ok(input);
  assert.equal(input?.previous.eventId, previous.eventId);
  assert.equal(input?.current.eventId, current.eventId);
  assert.ok(input && !Object.hasOwn(input, "previousStatement"));
  assert.ok(input && !Object.hasOwn(input, "currentStatement"));
  assert.ok(input?.changes.some((change) => change.buckets.includes("growth/activity")));
});

test("diff identity is versioned and duplicate AI runs are suppressed", async () => {
  const diff = await buildFedStatementDiff(previous, current);
  const identity = await buildFedStatementDiffIdentity(previous, current, diff);
  assert.match(identity, /^[0-9a-f]{64}$/);
  assert.equal(await buildFedStatementDiffIdentity(previous, current, diff), identity);
  assert.equal(shouldRunFedStatementAi(identity, []), true);
  assert.equal(shouldRunFedStatementAi(identity, [identity]), false);
  assert.notEqual(await buildFedStatementDiffIdentity(previous, current, diff, "v2"), identity);
});

test("AI output contract accepts valid mock and rejects unsafe or malformed output", () => {
  const valid = {
    summary: "Inflation wording was unchanged.",
    changes: [{ bucket: "inflation", direction: "neutral", previous: "old", current: "new", interpretation: "No directional inference.", confidence: 0.8 }],
    overall_bias_change: "neutral",
    confidence: 0.8,
  };
  assert.equal(validateFedStatementAiOutput(valid), true);
  assert.equal(validateFedStatementAiOutput({ ...valid, confidence: 1.2 }), false);
  assert.equal(validateFedStatementAiOutput({ ...valid, summary: 42 }), false);
});

test("storage recommendation avoids mutating immutable market_events", () => {
  assert.equal(FED_STATEMENT_DIFF_STORAGE.mode, "new_table");
  assert.equal(FED_STATEMENT_DIFF_STORAGE.table, "mic_fed_statement_diffs");
  assert.ok(FED_STATEMENT_DIFF_STORAGE.columns.includes("deterministic_diff_hash"));
  assert.ok(FED_STATEMENT_DIFF_STORAGE.columns.includes("prompt_version"));
});
