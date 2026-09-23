import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFedStatementAiInput,
  buildFedStatementDiff,
  buildFedStatementDiffIdentity,
  classifyFedStatementBuckets,
  computeFedStatementDiffHash,
  FED_STATEMENT_DIFF_STORAGE,
  selectPreviousFedStatement,
  shouldRunFedStatementAi,
  splitFedStatementParagraphs,
  validateFedStatementAiOutput,
  type FedStatementRecord,
} from "./mic_fed_statement_diff.ts";
import { parseFedStatementHtml } from "./mic_fed_statement_adapter.ts";
import { buildFedStatementDiffRow } from "./mic_fed_statement_diff_persistence.ts";

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

test("no previous statement is an empty non-material baseline, not an all-added diff", async () => {
  const result = await buildFedStatementDiff(null, current);
  assert.equal(result.comparisonStatus, "baseline_only");
  assert.equal(result.skipReason, "first_statement_no_baseline");
  assert.equal(result.addedParagraphs.length, 0);
  assert.equal(result.changes.length, 0);
  assert.equal(result.material, false);
});

test("paragraph normalization filters boilerplate but preserves policy paragraphs", () => {
  const paragraphs = splitFedStatementParagraphs([
    "Header",
    "The Committee will assess incoming data and risks.",
    "Copyright 2026",
    "Voting against the monetary policy action were A. Member and B. Member.",
    "Inflation remains elevated.",
  ].join("\n"));
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

test("structured policy facts gate materiality independently of paragraph wording", async () => {
  const sameHold = await buildFedStatementDiff(previous, { ...previous, eventId: "same-hold" });
  assert.equal(sameHold.policyDecisionChange.material, false);
  assert.equal(sameHold.material, false);

  const hike = await buildFedStatementDiff(previous, {
    ...previous,
    eventId: "hike",
    decision: "hike",
    targetRange: { lower: 4, upper: 4.25 },
  });
  assert.equal(hike.policyDecisionChange.material, true);
  assert.equal(hike.policyDecisionChange.lowerChangeBps, 25);
  assert.equal(hike.policyDecisionChange.upperChangeBps, 25);
  assert.ok(hike.buckets.includes("policy stance"));
  assert.equal(hike.material, true);
  const factOnlyAiInput = buildFedStatementAiInput(previous, {
    ...previous, eventId: "hike", decision: "hike", targetRange: { lower: 4, upper: 4.25 },
  }, hike);
  assert.ok(factOnlyAiInput);
  assert.equal(factOnlyAiInput?.changes.length, 0, "structured facts do not fabricate a statement paragraph");
  assert.equal(factOnlyAiInput?.policyDecisionChange.material, true);
  assert.equal(buildFedStatementDiffRow({
    ...previous, eventId: "hike", decision: "hike", targetRange: { lower: 4, upper: 4.25 },
  }, previous, hike).material_change_count, 1);

  const cut = await buildFedStatementDiff({ ...previous, decision: "hike", targetRange: { lower: 3.75, upper: 4 } }, {
    ...current,
    decision: "cut",
    targetRange: { lower: 3.5, upper: 3.75 },
  });
  assert.equal(cut.policyDecisionChange.material, true);

  const lowerOnly = await buildFedStatementDiff(previous, { ...previous, eventId: "lower-only", decision: "mixed", targetRange: { lower: 4, upper: 4 } });
  assert.equal(lowerOnly.policyDecisionChange.material, true);
  assert.equal(lowerOnly.policyDecisionChange.lowerChangeBps, 25);
  assert.equal(lowerOnly.policyDecisionChange.upperChangeBps, 0);

  const upperOnly = await buildFedStatementDiff(previous, { ...previous, eventId: "upper-only", decision: "mixed", targetRange: { lower: 3.75, upper: 4.25 } });
  assert.equal(upperOnly.policyDecisionChange.material, true);
  assert.equal(upperOnly.policyDecisionChange.lowerChangeBps, 0);
  assert.equal(upperOnly.policyDecisionChange.upperChangeBps, 25);
});

test("policy-stance wording change is material but punctuation and boilerplate alone are not", async () => {
  const guidance = await buildFedStatementDiff(previous, {
    ...previous,
    eventId: "guidance-change",
    normalizedText: previous.normalizedText.replace("carefully assess incoming data", "expects policy to remain restrictive"),
  });
  assert.equal(guidance.policyDecisionChange.material, false);
  assert.equal(guidance.material, true);

  const boilerplate = await buildFedStatementDiff(previous, {
    ...previous,
    eventId: "boilerplate-only",
    normalizedText: `${previous.normalizedText}\nVoting against the monetary policy action were A. Member and B. Member.`,
  });
  assert.equal(boilerplate.addedParagraphs.length, 0);
  assert.equal(boilerplate.removedParagraphs.length, 0);
  assert.equal(boilerplate.material, false);
});

test("policy paragraph remains material when voting text appears in the same paragraph", async () => {
  const prior = {
    ...previous,
    normalizedText: "The Committee decided to maintain the target range for the federal funds rate. Voting members agreed on the action.",
  };
  const next = {
    ...current,
    decision: prior.decision,
    targetRange: prior.targetRange,
    normalizedText: "The Committee decided to raise the target range for the federal funds rate. Voting members agreed on the action.",
  };
  const diff = await buildFedStatementDiff(prior, next);
  assert.equal(diff.policyDecisionChange.material, false);
  assert.equal(diff.changes.length, 1);
  assert.equal(diff.changes[0].material, true);
  assert.ok(diff.buckets.includes("policy stance"));
});

test("official July-to-September statement fixtures create a material policy-stance diff", async () => {
  const julyUrl = "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm";
  const septemberUrl = "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm";
  const julyHtml = `<html><body><header>site header</header><nav>site nav</nav><main>
    <h1>Federal Reserve issues FOMC statement</h1><p>July 29, 2026</p><p>For release at 2:00 p.m. EDT</p>
    <p>The Federal Open Market Committee approved the following statement for release by a 9 - 3 vote:</p>
    <p>The Committee decided to maintain the target range for the federal funds rate at 3-1/2 to 3-3/4 percent, in support of the Federal Reserve's dual mandate. The Committee is continuing its policy of maintaining ample reserves in the banking system.</p>
    <p>Economic activity is expanding at a solid pace despite elevated uncertainty that owes, in part, to the conflict in the Middle East. Productivity growth and capital investment are strong. Job gains have kept pace with the workforce, and the unemployment rate has changed little.</p>
    <p>Inflation remains elevated relative to the Committee's 2 percent goal, in part reflecting supply shocks that have driven price increases in certain sectors, including energy. The Committee will deliver price stability.</p>
    <p>Voting against the monetary policy action were Beth M. Hammack, Neel Kashkari, and Lorie K. Logan, who preferred to raise the target range for the federal funds rate by 1/4 percentage point at this meeting.</p>
    <p>For media inquiries, please email media@example.gov.</p></main><footer>site footer</footer></body></html>`;
  const septemberHtml = `<html><body><header>site header</header><nav>site nav</nav><main>
    <h1>Federal Reserve issues FOMC statement</h1><p>September 16, 2026</p><p>For release at 2:00 p.m. EDT</p>
    <p>The Federal Open Market Committee approved the following statement for release by a 12 - 0 vote:</p>
    <p>The Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent, in support of the Federal Reserve's dual mandate. The Committee is continuing its policy of maintaining ample reserves in the banking system.</p>
    <p>Economic activity is expanding at a solid pace. While uncertainty remains elevated owing, in part, to geopolitical developments, domestic spending has been resilient. Productivity growth is strong, and capital investment is robust. Job gains have kept pace with the workforce, and the unemployment rate has changed little.</p>
    <p>Inflation remains elevated. Today's policy action will support a timelier return to the Committee's 2 percent goal. The Committee will deliver price stability.</p>
    <p>For media inquiries, please email media@example.gov.</p></main><footer>site footer</footer></body></html>`;
  const july = await parseFedStatementHtml(julyUrl, julyHtml, { lower: 3.5, upper: 3.75 });
  const september = await parseFedStatementHtml(septemberUrl, septemberHtml, { lower: 3.5, upper: 3.75 });
  const julyRecord: FedStatementRecord = {
    eventId: "july-official-fixture", centralBank: "Fed", meetingDate: july.meetingDate,
    documentHash: july.documentHash, normalizedText: july.normalizedText, statementUrl: july.statementUrl,
    decision: july.decision, targetRange: july.targetRange,
  };
  const septemberRecord: FedStatementRecord = {
    eventId: "september-official-fixture", centralBank: "Fed", meetingDate: september.meetingDate,
    documentHash: september.documentHash, normalizedText: september.normalizedText, statementUrl: september.statementUrl,
    decision: september.decision, targetRange: september.targetRange,
  };
  const diff = await buildFedStatementDiff(julyRecord, septemberRecord);
  const row = buildFedStatementDiffRow(septemberRecord, julyRecord, diff);
  const aiInput = buildFedStatementAiInput(julyRecord, septemberRecord, diff);

  assert.equal(julyRecord.meetingDate, "2026-07-29");
  assert.equal(septemberRecord.meetingDate, "2026-09-16");
  assert.equal(julyRecord.decision, "hold");
  assert.equal(septemberRecord.decision, "hike");
  assert.deepEqual(julyRecord.targetRange, { lower: 3.5, upper: 3.75 });
  assert.deepEqual(septemberRecord.targetRange, { lower: 3.75, upper: 4 });
  assert.equal(diff.policyDecisionChange.lowerChangeBps, 25);
  assert.equal(diff.policyDecisionChange.upperChangeBps, 25);
  assert.equal(diff.policyDecisionChange.material, true);
  assert.ok(diff.material);
  assert.ok(diff.buckets.includes("policy stance"));
  assert.ok(row.changed_paragraph_count > 0);
  assert.ok(row.material_change_count > 0);
  assert.ok(aiInput, "candidate gate opens without making an AI call");
  assert.deepEqual(splitFedStatementParagraphs(july.normalizedText).filter((p) => /voting against|committee approved|media inquiries/i.test(p)), []);
  assert.ok(splitFedStatementParagraphs(september.normalizedText).some((p) => /target range.*3-3\/4 to 4 percent/i.test(p)));
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
  const dateAndMembersOnly = {
    ...previous,
    normalizedText: "The Committee met on July 29, 2026.\nVoting members: Alice Example and Bob Example.",
  };
  const diff = await buildFedStatementDiff(dateAndMembersOnly, {
    ...dateAndMembersOnly,
    eventId: "current",
    normalizedText: "The Committee met on September 16, 2026.\nVoting members: Carol Example and Dan Example.",
  });
  assert.equal(diff.material, false);
  assert.equal(buildFedStatementAiInput(dateAndMembersOnly, { ...dateAndMembersOnly, eventId: "current" }, diff), null);
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

test("deterministic diff hash is stable across JSONB object key ordering", async () => {
  const diff = await buildFedStatementDiff(previous, current);
  const reordered = {
    ...diff,
    policyDecisionChange: Object.fromEntries(Object.entries(diff.policyDecisionChange).reverse()) as typeof diff.policyDecisionChange,
    changes: diff.changes.map((change) => Object.fromEntries(Object.entries(change).reverse()) as typeof change),
  };
  assert.equal(await computeFedStatementDiffHash(diff), await computeFedStatementDiffHash(reordered));
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
