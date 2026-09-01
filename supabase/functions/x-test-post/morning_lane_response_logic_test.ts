import assert from "node:assert/strict";
import test from "node:test";
import {
  MorningLaneResponseError,
  attachMorningLaneFailureContext,
  parseMorningLaneResponse,
} from "./morning_lane_response_logic.ts";
import type { MorningSearchLane } from "./morning_candidate_logic.ts";

const candidate = {
  title: "米国半導体株の動き",
  summary: "前営業日の米国市場で半導体株に動きがあった。",
  publisher: "Reuters",
  source_url: "https://www.reuters.com/markets/example",
  supporting_source_urls: [],
  timestamp: "2026-08-28",
  timestamp_precision: "date",
  material_type: "market_session",
  japan_relevance: "日本の半導体株に関係する。",
  japan_relevance_level: "high",
  market_impact: "high",
  importance_class: "major",
  causal_claim_strength: "none",
  affected_sectors: ["半導体"],
  what_to_watch: "半導体株の反応。",
};

const packet = (lane: MorningSearchLane) => ({
  lane,
  us_session_date: "2026-08-28",
  candidates: [{ ...candidate }],
  conditional_factors: [],
  source_urls: [candidate.source_url],
  date_consistency_passed: true,
  fact_check_notes: ["確認済み"],
});

const response = (lane: MorningSearchLane, text = JSON.stringify(packet(lane))) => ({
  status: "completed",
  output: [
    { type: "web_search_call", action: { type: "search" } },
    { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] },
  ],
});

function expectCategory(action: () => unknown, category: string): MorningLaneResponseError {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  assert.equal(caught instanceof MorningLaneResponseError, true);
  const typed = caught as MorningLaneResponseError;
  assert.equal(typed.diagnostics.failureCategory, category);
  return typed;
}

test("a single structured JSON output parses successfully", () => {
  const result = parseMorningLaneResponse(response("lane_a_us_market"), "lane_a_us_market");
  assert.equal(result.packet.lane, "lane_a_us_market");
  assert.equal(result.diagnostics.outputTextItemCount, 1);
  assert.equal(result.diagnostics.jsonParsePassed, true);
  assert.equal(result.diagnostics.schemaValidationPassed, true);
});

test("multiple output_text items are not concatenated", () => {
  const raw = response("lane_a_us_market") as { status: string; output: Array<Record<string, unknown>> };
  raw.output.push({
    type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: JSON.stringify(packet("lane_a_us_market")) }],
  });
  const error = expectCategory(() => parseMorningLaneResponse(raw, "lane_a_us_market"), "SCHEMA_INVALID");
  assert.equal(error.diagnostics.outputTextItemCount, 2);
  assert.equal(error.diagnostics.parseTargetLength, 0);
});

test("empty output has a dedicated error", () => {
  expectCategory(() => parseMorningLaneResponse({ status: "completed", output: [] }, "lane_a_us_market"), "EMPTY_OUTPUT");
});

test("incomplete response records its reason", () => {
  const error = expectCategory(() => parseMorningLaneResponse({
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [],
  }, "lane_b_macro_policy"), "INCOMPLETE");
  assert.equal(error.diagnostics.incompleteReason, "max_output_tokens");
});

test("refusal has a dedicated error", () => {
  expectCategory(() => parseMorningLaneResponse({
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "cannot comply" }] }],
  }, "lane_b_macro_policy"), "REFUSAL");
});

test("malformed JSON has a parse-specific error", () => {
  const error = expectCategory(
    () => parseMorningLaneResponse(response("lane_c_supplement", "{broken"), "lane_c_supplement"),
    "JSON_PARSE_FAILED",
  );
  assert.equal(error.diagnostics.jsonParsePassed, false);
  assert.equal(error.diagnostics.parseTargetLength, 7);
});

test("a packet with a structurally broken root is still rejected outright", () => {
  const invalid = packet("lane_c_supplement") as unknown as Record<string, unknown>;
  invalid.us_session_date = "not-a-date";
  const error = expectCategory(
    () => parseMorningLaneResponse(response("lane_c_supplement", JSON.stringify(invalid)), "lane_c_supplement"),
    "SCHEMA_INVALID",
  );
  assert.equal(error.diagnostics.jsonParsePassed, true);
  assert.equal(error.diagnostics.schemaIssues.some((issue) => issue.includes("us_session_date")), true);
});

test("a candidate missing a required field is excluded, not the whole packet", () => {
  const withBadCandidate = packet("lane_c_supplement");
  delete (withBadCandidate.candidates[0] as { publisher?: string }).publisher;
  const result = parseMorningLaneResponse(
    response("lane_c_supplement", JSON.stringify(withBadCandidate)),
    "lane_c_supplement",
  );
  assert.equal(result.diagnostics.schemaValidationPassed, true);
  assert.equal(result.packet.candidates.length, 0);
  assert.equal(result.diagnostics.candidateReturnedCount, 1);
  assert.equal(result.diagnostics.candidateExclusions.length, 1);
  assert.equal(result.diagnostics.candidateExclusions[0].index, 0);
  assert.equal(
    result.diagnostics.candidateExclusions[0].reasons.includes("LANE_CANDIDATE_SCHEMA_INVALID:publisher"),
    true,
  );
});

test("one candidate with an unparseable timestamp is excluded while the other two survive", () => {
  const threeCandidates = packet("lane_a_us_market");
  threeCandidates.candidates = [
    { ...candidate, source_url: "https://www.reuters.com/markets/0" },
    { ...candidate, source_url: "https://www.reuters.com/markets/1", timestamp: "not-a-timestamp" },
    { ...candidate, source_url: "https://www.reuters.com/markets/2" },
  ];
  const result = parseMorningLaneResponse(
    response("lane_a_us_market", JSON.stringify(threeCandidates)),
    "lane_a_us_market",
  );
  assert.equal(result.diagnostics.schemaValidationPassed, true);
  assert.equal(result.packet.candidates.length, 2);
  assert.equal(result.diagnostics.candidateReturnedCount, 3);
  assert.equal(result.diagnostics.candidateExclusions.length, 1);
  assert.equal(result.diagnostics.candidateExclusions[0].index, 1);
  assert.equal(
    result.diagnostics.candidateExclusions[0].reasons.includes("LANE_CANDIDATE_SCHEMA_INVALID:timestamp"),
    true,
  );
});

test("a space-separated datetime timestamp is normalized instead of excluded", () => {
  const withSpacedTimestamp = packet("lane_b_macro_policy");
  withSpacedTimestamp.candidates = [{
    ...candidate,
    timestamp_precision: "datetime",
    timestamp: "2026-08-28 14:30:00Z",
  }];
  const result = parseMorningLaneResponse(
    response("lane_b_macro_policy", JSON.stringify(withSpacedTimestamp)),
    "lane_b_macro_policy",
  );
  assert.equal(result.diagnostics.schemaValidationPassed, true);
  assert.equal(result.packet.candidates.length, 1);
  assert.equal(result.packet.candidates[0].timestamp, "2026-08-28T14:30:00Z");
  assert.equal(result.diagnostics.candidateExclusions.length, 0);
  assert.equal(result.diagnostics.candidateNormalizations.length, 1);
  assert.equal(result.diagnostics.candidateNormalizations[0].fields.includes("timestamp"), true);
});

test("a slash-separated date-only timestamp is normalized to the hyphenated form", () => {
  const withSlashDate = packet("lane_a_us_market");
  withSlashDate.candidates = [{ ...candidate, timestamp: "2026/08/28" }];
  const result = parseMorningLaneResponse(
    response("lane_a_us_market", JSON.stringify(withSlashDate)),
    "lane_a_us_market",
  );
  assert.equal(result.packet.candidates.length, 1);
  assert.equal(result.packet.candidates[0].timestamp, "2026-08-28");
  assert.equal(result.diagnostics.candidateNormalizations[0].fields.includes("timestamp"), true);
});

test("a candidate with an invalid enum value is excluded with a field-specific reason", () => {
  const withBadEnum = packet("lane_a_us_market");
  withBadEnum.candidates = [{ ...candidate, market_impact: "extreme" } as unknown as typeof candidate];
  const result = parseMorningLaneResponse(
    response("lane_a_us_market", JSON.stringify(withBadEnum)),
    "lane_a_us_market",
  );
  assert.equal(result.packet.candidates.length, 0);
  assert.equal(
    result.diagnostics.candidateExclusions[0].reasons.includes("LANE_CANDIDATE_SCHEMA_INVALID:market_impact"),
    true,
  );
});

test("a non-object candidate entry is excluded rather than failing the packet", () => {
  const withGarbageEntry = packet("lane_a_us_market") as unknown as { candidates: unknown[] };
  withGarbageEntry.candidates = [{ ...candidate }, "not-an-object"];
  const result = parseMorningLaneResponse(
    response("lane_a_us_market", JSON.stringify(withGarbageEntry)),
    "lane_a_us_market",
  );
  assert.equal(result.packet.candidates.length, 1);
  assert.equal(result.diagnostics.candidateExclusions.length, 1);
  assert.equal(
    result.diagnostics.candidateExclusions[0].reasons.includes("LANE_CANDIDATE_SCHEMA_INVALID:not_object"),
    true,
  );
});

test("when every candidate is excluded, the lane still succeeds with an empty candidate list", () => {
  const allBad = packet("lane_a_us_market");
  allBad.candidates = [
    { ...candidate, source_url: "https://www.reuters.com/markets/0", timestamp: "bad" },
    { ...candidate, source_url: "https://www.reuters.com/markets/1", material_type: "unknown_type" } as unknown as typeof candidate,
  ];
  const result = parseMorningLaneResponse(
    response("lane_a_us_market", JSON.stringify(allBad)),
    "lane_a_us_market",
  );
  assert.equal(result.diagnostics.schemaValidationPassed, true);
  assert.deepEqual(result.packet.candidates, []);
  assert.equal(result.diagnostics.candidateExclusions.length, 2);
});

test("Lane A, B and C use the same parser successfully", () => {
  for (const lane of ["lane_a_us_market", "lane_b_macro_policy", "lane_c_supplement"] as const) {
    assert.equal(parseMorningLaneResponse(response(lane), lane).packet.lane, lane);
  }
});

test("Lane A and B accept at most three candidates and Lane C at most two", () => {
  for (const lane of ["lane_a_us_market", "lane_b_macro_policy"] as const) {
    const atLimit = packet(lane);
    atLimit.candidates = Array.from({ length: 3 }, (_, index) => ({
      ...candidate,
      title: `${candidate.title}${index}`,
      source_url: `${candidate.source_url}/${index}`,
    }));
    assert.equal(parseMorningLaneResponse(response(lane, JSON.stringify(atLimit)), lane).packet.candidates.length, 3);
  }

  const laneCAtLimit = packet("lane_c_supplement");
  laneCAtLimit.candidates = Array.from({ length: 2 }, (_, index) => ({
    ...candidate,
    title: `${candidate.title}${index}`,
    source_url: `${candidate.source_url}/${index}`,
  }));
  assert.equal(
    parseMorningLaneResponse(
      response("lane_c_supplement", JSON.stringify(laneCAtLimit)),
      "lane_c_supplement",
    ).packet.candidates.length,
    2,
  );

  laneCAtLimit.candidates.push({ ...candidate, title: "上限超過" });
  expectCategory(
    () => parseMorningLaneResponse(
      response("lane_c_supplement", JSON.stringify(laneCAtLimit)),
      "lane_c_supplement",
    ),
    "SCHEMA_INVALID",
  );
});

test("an empty candidate array is valid only as a structured empty result", () => {
  const empty = packet("lane_c_supplement");
  empty.candidates = [];
  const result = parseMorningLaneResponse(
    response("lane_c_supplement", JSON.stringify(empty)),
    "lane_c_supplement",
  );
  assert.deepEqual(result.packet.candidates, []);
  assert.equal(result.diagnostics.schemaValidationPassed, true);
});

test("Lane C failure retains completed Lane A and B diagnostics", () => {
  const error = expectCategory(
    () => parseMorningLaneResponse(response("lane_c_supplement", "not-json"), "lane_c_supplement"),
    "JSON_PARSE_FAILED",
  );
  attachMorningLaneFailureContext(error, {
    completedLanes: ["lane_a_us_market", "lane_b_macro_policy"],
    laneCandidateCounts: [3, 2],
    publisherCount: 1,
    hasUsMarketOrSemiconductor: true,
    supplementReasons: ["PUBLISHER_SHORTAGE"],
  });
  assert.deepEqual(error.context?.completedLanes, ["lane_a_us_market", "lane_b_macro_policy"]);
  assert.deepEqual(error.context?.supplementReasons, ["PUBLISHER_SHORTAGE"]);
});
