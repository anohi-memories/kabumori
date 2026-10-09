import assert from "node:assert/strict";
import test from "node:test";
import { loadCases } from "./fixtures.ts";
import { containsContactDetails, MAX_BODY_CHARS, sanitizeBody } from "./sanitize.ts";
import { buildCase, buildCasesFile, CASE_META } from "../scripts/build_cases.ts";

const cases = await loadCases();

test("the fixture set has 22 real cases with unique ids", () => {
  assert.equal(cases.length, 22);
  assert.equal(new Set(cases.map((c) => c.caseId)).size, 22);
  for (const fixture of cases) assert.match(fixture.caseId, /-[0-9a-f]{8}$/);
});

test("it covers successes, misses, generation failures and negative controls", () => {
  const kinds = new Set(cases.map((c) => c.outcomeKind));
  assert.deepEqual([...kinds].sort(), ["generation_failure", "miss", "negative_control", "success"]);
  assert.ok(cases.filter((c) => c.outcomeKind === "generation_failure").length >= 6);
});

test("it covers every area the task named: BOJ, FX, geopolitics, North Korea, domestic incident, FSA action, TDnet", () => {
  const groups = new Set(cases.map((c) => c.group));
  for (const group of ["boj", "fx", "geopolitics", "north_korea", "domestic_incident", "fsa_action", "tdnet_earnings", "tdnet_capital", "negative_control"]) {
    assert.ok(groups.has(group as never), group);
  }
});

test("no fixture contains an email address, a phone number or a contact line", () => {
  for (const fixture of cases) {
    const text = JSON.stringify(fixture);
    assert.equal(containsContactDetails(text), false, fixture.caseId);
    assert.ok(!/代表者名|問合せ先|問い合わせ先/.test(fixture.candidate.bodySummary ?? ""), fixture.caseId);
  }
});

test("bodies are capped, and every candidate has the fields the production builders read", () => {
  for (const { candidate, caseId } of cases) {
    assert.ok((candidate.bodySummary ?? "").length <= MAX_BODY_CHARS, caseId);
    for (const key of ["sourceType", "sourceUrl", "sourceName", "title", "category", "publishedAt"] as const) {
      assert.ok(candidate[key], `${caseId}.${key}`);
    }
    assert.ok(Number.isFinite(Date.parse(candidate.publishedAt)), caseId);
    assert.match(candidate.sourceUrl, /^https:\/\//);
  }
});

test("'expected' is production's own decision except where a human hint says production was wrong", () => {
  for (const fixture of cases) {
    if (fixture.expected.source === "production_decision") {
      assert.equal(fixture.expected.importance, fixture.recorded.judgement.importance, fixture.caseId);
    } else {
      assert.equal(fixture.outcomeKind, "miss", fixture.caseId);
      assert.notEqual(fixture.expected.importance, fixture.recorded.judgement.importance);
    }
  }
  assert.equal(cases.filter((c) => c.expected.source === "human_hint").length, 1);
});

test("negative controls expect no_post and have no stored post", () => {
  for (const fixture of cases.filter((c) => c.outcomeKind === "negative_control")) {
    assert.equal(fixture.expected.importance, "no_post");
    assert.equal(fixture.recorded.generation, null);
  }
});

test("generation failures record why they failed", () => {
  for (const fixture of cases.filter((c) => c.outcomeKind === "generation_failure")) {
    const generation = fixture.recorded.generation!;
    assert.ok(generation.factStatus === "failed" || generation.voiceStatus === "failed" || generation.error, fixture.caseId);
  }
});

test("every case has a Japanese note explaining why it is in the set", () => {
  for (const fixture of cases) assert.match(fixture.note, /[ぁ-んァ-ヶ一-龠]/, fixture.caseId);
});

// --- sanitize ---------------------------------------------------------------------------------------------------

test("emails and phone numbers are masked, contact lines are dropped", () => {
  const body = ["各位", "代表者名 代表取締役社長 山田 太郎", "問合せ先 IR室 03-1234-5678", "連絡は ir@example.co.jp まで", "本日、重要な発表をしました。 TEL 03-9999-0000"].join("\n");
  const out = sanitizeBody(body)!;
  assert.ok(!out.includes("山田"));
  assert.ok(!out.includes("ir@example"));
  assert.ok(!/03-\d{4}-\d{4}/.test(out));
  assert.match(out, /重要な発表/);
  assert.equal(containsContactDetails(out), false);
});

test("long bodies are cut at a sentence or line boundary under the cap; null stays null", () => {
  const long = `${"あ".repeat(1500)}。${"い".repeat(600)}`;
  const out = sanitizeBody(long)!;
  assert.ok(out.length <= MAX_BODY_CHARS);
  assert.ok(out.endsWith("。"));
  assert.equal(sanitizeBody(null), null);
  assert.equal(sanitizeBody("short"), "short");
});

// --- build_cases ------------------------------------------------------------------------------------------------

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, source_type: "tdnet", source_name: "tdnet", source_url: "https://www.release.tdnet.info/inbs/x.pdf", title: "t",
  body_summary: "本文 03-1234-5678", company_name: "テスト", company_code: "12340", entity_key: "company:12340", category: "earnings",
  published_at: "2026-10-01 05:00:00+00", importance: "important", japan_market_relevance: "low", judgement_model: "gpt-6-luna",
  escalated_to_sol: false, confidence: 0.8, judgement_reason: "理由", fact_check_status: "passed", affected_entities: ["A"],
  generated_text: null, generation_model: null, generation_fact_status: null, generation_voice_status: null, generation_error: null,
  generation_fact_issues: null, generation_voice_issues: null, ...overrides,
});

test("build_cases reshapes a row and sanitises the body", () => {
  const id = Object.keys(CASE_META)[0];
  const fixture = buildCase(row(`${id}-0000-0000-0000-000000000000`));
  assert.equal(fixture.candidate.publishedAt, "2026-10-01T05:00:00.000Z");
  assert.ok(!fixture.candidate.bodySummary!.includes("03-1234"));
  assert.equal(fixture.recorded.generation, null);
  assert.equal(fixture.recorded.judgement.importance, "important");
});

test("build_cases refuses a row that has no case metadata, and sorts its output", () => {
  assert.throws(() => buildCase(row("ffffffff-0000-0000-0000-000000000000")), /NO_CASE_META:ffffffff/);
  const ids = Object.keys(CASE_META).slice(0, 3).map((id) => `${id}-0000-0000-0000-000000000000`);
  const file = buildCasesFile([...ids].reverse().map((id) => row(id)));
  assert.deepEqual(file.cases.map((c) => c.caseId), [...file.cases.map((c) => c.caseId)].sort());
});
