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

test("valid JSON with an invalid schema is rejected", () => {
  const invalid = packet("lane_c_supplement");
  delete (invalid.candidates[0] as { publisher?: string }).publisher;
  const error = expectCategory(
    () => parseMorningLaneResponse(response("lane_c_supplement", JSON.stringify(invalid)), "lane_c_supplement"),
    "SCHEMA_INVALID",
  );
  assert.equal(error.diagnostics.jsonParsePassed, true);
  assert.equal(error.diagnostics.schemaIssues.some((issue) => issue.includes("publisher")), true);
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
