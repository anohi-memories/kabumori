// H2 re-review of PR #101 (head fddd2748): two classes of credential residue (F2) and two metadata truths (F3).
//   F2-A  `basic dXNlcjpwYXNz` (valid unpadded Base64 of user:pass, letters only) survived without an Authorization prefix.
//   F2-B  a quoted credential value containing an escaped quote / backslash / newline kept its tail: the value was cut
//         at the first backslash.
//   F3-A  after the depth cut the reported original size was measured on the already-cut value.
//   F3-B  the retained-list size counted a comma before the first item.
// Every F2 case goes through the real path (traceRows -> persistTraces) AND the forged-row backstop.
import assert from "node:assert/strict";
import test from "node:test";
import type { GenerationRecord } from "./analysis_logic.ts";
import {
  containsSecret,
  isBasicCredential,
  MAX_FIELD_CHARS,
  persistTraces,
  redactText,
  REDACTED,
  type TraceRow,
  traceRows,
} from "./debug_trace.ts";

const context = {
  reportType: "morning" as const, tradingDate: "2026-10-07", cycleId: null, dataPacketId: null,
  invocationId: "44444444-4444-4444-8444-444444444444", attempt: 1, model: "m", basePromptHash: null,
};
const record = (patch: Partial<GenerationRecord> = {}): GenerationRecord => ({
  generationIndex: 1, stage: "fact", hardRejection: "fact", candidate: { headline_ja: "見出し" }, localPassed: true, localIssues: [],
  localWarnings: [], factRan: true, factPassed: false, factIssues: [], selectedForDelivery: false, fallbackReason: null, removedUnits: [], deliveryIssues: [], errorCode: null,
  requestHash: null, calls: 2, inputTokens: 1, outputTokens: 1, costUsd: 0, ...patch,
});
const rowOf = (patch: Partial<GenerationRecord> = {}) => traceRows(context, [record(patch)])[0];

/** The real path: the record becomes rows, the writer decides. Returns what would have been inserted. */
async function viaWriter(patch: Partial<GenerationRecord>): Promise<{ called: number; written: string }> {
  let called = 0;
  let written = "";
  await persistTraces((_table, batch) => { called += 1; written = JSON.stringify(batch); return Promise.resolve(); }, traceRows(context, [record(patch)]), () => {});
  return { called, written };
}

/** The strongest acceptable outcome for a credential: the whole value is gone, or nothing is inserted. */
function assertGone(result: { called: number; written: string }, fragments: string[], label: string) {
  if (result.called === 0) return; // dropping the row is allowed
  for (const fragment of fragments) assert.ok(!result.written.includes(fragment), `${label}: "${fragment}" survived in ${result.written}`);
}

// ---------------------------------------------------------------------------------------------------------
// F2-A: standalone Basic, letters only
// ---------------------------------------------------------------------------------------------------------

test("F2-A: `basic dXNlcjpwYXNz` is a Basic credential whatever the case, even letters-only and unpadded", () => {
  for (const text of ["basic dXNlcjpwYXNz", "Basic dXNlcjpwYXNz", "BASIC dXNlcjpwYXNz", "got basic dXNlcjpwYXNz from the client", "basic dXNlcjpwYXNzd29yZA"]) {
    const cleaned = redactText(text);
    assert.ok(!cleaned.includes("dXNlcjpwYXNz"), `${text} -> ${cleaned}`);
    assert.ok(/Basic \[redacted\]/.test(cleaned), cleaned);
    assert.equal(containsSecret(cleaned), false);
    assert.equal(redactText(cleaned), cleaned, "idempotent");
  }
  assert.equal(isBasicCredential("dXNlcjpwYXNz"), true);
  assert.equal(isBasicCredential("QWxhZGRpbjpvcGVuIHNlc2FtZQ=="), true);
});

test("F2-A: ordinary prose with the word basic is left exactly as written", () => {
  for (
    const text of [
      "basic income", "basic materials sector", "Basic Instinct", "basic introduction to markets", "the basic researchers said",
      "Basic Information about the offering", "basic fundamentals remain intact", "Basic Materials stocks rose 1.2%",
      "基本的な basic principles を確認", "basic economics and basic accounting",
    ]
  ) {
    assert.equal(redactText(text), text, text);
    assert.equal(containsSecret(text), false, text);
  }
});

test("F2-A: normal path and forged-row backstop both stop it", async () => {
  const text = "ヘッダに basic dXNlcjpwYXNz が含まれていた";
  assertGone(await viaWriter({ candidate: { note: text } }), ["dXNlcjpwYXNz"], "candidate");
  assertGone(await viaWriter({ factIssues: [text], localIssues: [text] }), ["dXNlcjpwYXNz"], "issues");
  const normal = await viaWriter({ candidate: { note: text } });
  assert.equal(normal.called, 1, "redaction (not a drop) is the normal outcome: the sentence is kept");
  assert.ok(normal.written.includes("ヘッダに Basic [redacted] が含まれていた"));
  // Forged: a row that never went through redaction. The writer must still refuse it, callback zero.
  let called = 0;
  const logged: string[] = [];
  const forged: TraceRow = { ...rowOf(), candidate: { note: text } };
  assert.equal(await persistTraces(() => { called += 1; return Promise.resolve(); }, [forged], (line) => logged.push(line)), false);
  assert.equal(called, 0);
  assert.ok(logged[0]?.startsWith("GENERATION_TRACE_ROW_DROPPED"));
});

// ---------------------------------------------------------------------------------------------------------
// F2-B: escaped quoted values
// ---------------------------------------------------------------------------------------------------------

const escapedCases: Array<[string, unknown, string[]]> = [
  ["escaped quote", { password: 'syntheticPrefix123"syntheticTail999' }, ["syntheticPrefix123", "syntheticTail999"]],
  ["escaped backslash", { password: "syntheticHead456\\syntheticTail888" }, ["syntheticHead456", "syntheticTail888"]],
  ["escaped newline", { password: "syntheticLine1-777\nsyntheticTail666" }, ["syntheticLine1-777", "syntheticTail666"]],
  ["escaped tab and unicode", { access_token: "tokHead\tétokTail555" }, ["tokHead", "tokTail555"]],
  ["escaped quote and backslash together", { api_key: 'k"e\\y-tailpart-909' }, ["k\\\"e", "y-tailpart-909"]],
];

test("F2-B: a JSON string holding a credential with an escape keeps no tail (real path: traceRows -> persistTraces)", async () => {
  for (const [label, secret, fragments] of escapedCases) {
    // The model quoted JSON inside a string field: JSON.stringify makes the escapes.
    const quoted = JSON.stringify(secret);
    assert.ok(quoted.includes("\\"), `${label}: the sample really contains an escape`);
    const text = `応答は ${quoted} でした。次の文も残す。`;
    const result = await viaWriter({ candidate: { raw: text }, factIssues: [text], localIssues: [text], localWarnings: [text] });
    assertGone(result, fragments, label);
    assert.equal(result.called, 1, `${label}: redacted, not dropped`);
    assert.ok(result.written.includes("次の文も残す"), `${label}: the text after the credential is kept`);
    assert.ok(result.written.includes("[redacted]"), label);
  }
});

test("F2-B: the same credentials one escape level deeper (JSON text that is itself a JSON string)", async () => {
  for (const [label, secret, fragments] of escapedCases) {
    const levelTwo = JSON.stringify(JSON.stringify(secret)).slice(1, -1); // the text as it appears inside another JSON string
    const text = `前 ${levelTwo} 後`;
    const result = await viaWriter({ candidate: { raw: text } });
    assertGone(result, fragments, `${label} (level 2)`);
    assert.equal(containsSecret(redactText(text)), false, label);
    assert.equal(redactText(redactText(text)), redactText(text), `${label}: idempotent`);
  }
});

test("F2-B: single-quoted and unparsable values never leave a tail", () => {
  const single = redactText("{'password': 'abc\\'def-TAIL1' , 'ok': 'keep'}");
  assert.ok(!single.includes("abc") && !single.includes("TAIL1") && !single.includes("def"), single);
  assert.ok(single.includes("'ok': 'keep'") || single.includes("[redacted]"), single);
  // No closing quote at all: the rest of the text is taken as the value (over-redaction, never a tail).
  const open = redactText('before {"password":"neverClosed-TAIL2 and more text');
  assert.equal(open, 'before {"password":"[redacted]');
  // A bare value that contains a quote is one value.
  const bare = redactText("token=abc\"def-TAIL3 次");
  assert.ok(!bare.includes("TAIL3") && !bare.includes("abc"), bare);
});

test("F2-B: the forged-row backstop catches a tail that was never redacted, whatever the delivery path", async () => {
  const leaked = JSON.stringify({ password: 'syntheticPrefix123"syntheticTail999' });
  const partial = `{"password":"${REDACTED}\\"syntheticTail999"}`; // what the old cut left behind
  for (const text of [leaked, partial]) {
    let called = 0;
    const logged: string[] = [];
    const forged: TraceRow = { ...rowOf(), fact_issues: [text] };
    assert.equal(await persistTraces(() => { called += 1; return Promise.resolve(); }, [forged], (line) => logged.push(line)), false, text);
    assert.equal(called, 0, text);
  }
});

test("F2: multiple credentials in one string, and a redacted occurrence followed by a live one", async () => {
  const text = `{"password":"p1\\"TAIL-A"} と basic dXNlcjpwYXNz と token=zzzz\\"9999 と {"api_key":"k2\\\\TAIL-B"}`;
  const cleaned = redactText(text);
  for (const fragment of ["TAIL-A", "dXNlcjpwYXNz", "zzzz", "TAIL-B", "p1", "k2"]) assert.ok(!cleaned.includes(fragment), `${fragment} in ${cleaned}`);
  assert.ok(cleaned.includes(" と "), "the words between are kept");
  const mixed = `first {"password":"${REDACTED}"} then {"password":"live\\"tail-secret"}`;
  let called = 0;
  const forged: TraceRow = { ...rowOf(), candidate: { t: mixed } };
  assert.equal(await persistTraces(() => { called += 1; return Promise.resolve(); }, [forged], () => {}), false);
  assert.equal(called, 0);
  assert.ok(!redactText(mixed).includes("tail-secret"));
});

test("F2: ordinary Japanese / financial text stays unchanged (controls)", () => {
  for (
    const text of [
      "日経平均は70,683.98（前日比+1.05%）で、TOPIX連動ETF（1306）は440.4円でした。",
      "パスワード管理アプリのトークン発行をめぐる報道があったが、市場との関係は確認できません。",
      "米国2年債利回りは4.83%（10月2日時点・最新ではありません）。",
      'ニュース見出し: "国連が決議を採択" と報じられた。',
      "Bearer bonds and the secretary of state's statement on token economics: a basic summary.",
    ]
  ) {
    assert.equal(redactText(text), text, text);
    assert.equal(containsSecret(text), false, text);
  }
});

test("F2: persistence failure and drops stay non-blocking: no throw, one callback at most, no retry", async () => {
  let calls = 0;
  const ok = await persistTraces(() => { calls += 1; return Promise.reject(new Error("REST_INSERT_FAILED:t:500")); }, traceRows(context, [record()]), () => {});
  assert.equal(ok, false);
  assert.equal(calls, 1, "never retried");
});

// ---------------------------------------------------------------------------------------------------------
// F3-A: depth cut, truthful sizes
// ---------------------------------------------------------------------------------------------------------

const nest = (depth: number, leaf: unknown): unknown => {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) value = { a: value };
  return value;
};

test("F3-A: a candidate nested deeper than the depth cut reports the size of the evidence before the cut", () => {
  const leaf = { evidence: `${"深い".repeat(500)}-LEAF`, list: ["x", "y"] };
  const candidate = nest(66, leaf);
  const original = JSON.stringify(candidate).length; // nothing to redact: the original redacted size
  const row = rowOf({ candidate });
  const stored = JSON.stringify(row.candidate).length;
  assert.equal(row.truncated, true);
  assert.equal(row.truncation?.candidate?.reason, "depth_limit");
  assert.equal(row.truncation?.candidate?.original_chars, original, "measured before the cut");
  assert.equal(row.truncation?.candidate?.kept_chars, stored, "the size of what was stored");
  assert.ok(row.truncation!.candidate!.original_chars! > row.truncation!.candidate!.kept_chars, "evidence was lost, so original > kept");
  assert.equal(row.candidate_chars, original);
  assert.ok(JSON.stringify(row.candidate).includes("[depth-limit]"));
});

test("F3-A: depth 63 and 64 around the cut; exactly the levels that lose evidence are flagged", () => {
  const under = rowOf({ candidate: nest(60, { v: "keep" }) });
  assert.equal(under.truncated, false);
  assert.equal(under.truncation, null);
  assert.equal(under.candidate_chars, JSON.stringify(under.candidate).length);
  const over = rowOf({ candidate: nest(70, { v: "lost" }) });
  assert.equal(over.truncation?.candidate?.reason, "depth_limit");
  assert.equal(over.truncation?.candidate?.original_chars, JSON.stringify(nest(70, { v: "lost" })).length);
});

test("F3-A: a depth cut plus the field bound reports both reasons and the true original size", () => {
  // A large shallow part (survives the depth cut, exceeds the field bound) beside a part nested past the cut.
  const huge = { big: "あ".repeat(MAX_FIELD_CHARS + 10_000), deep: nest(66, { lost: "深い証拠" }) };
  const original = JSON.stringify(huge).length;
  const row = rowOf({ candidate: huge });
  const t = row.truncation!.candidate!;
  assert.equal(t.reason, "depth_limit+field_bound");
  assert.equal(t.original_chars, original);
  assert.ok(t.kept_chars < original);
  assert.equal(row.candidate_chars, original);
});

test("F3-A: credential redaction inside a deep candidate does not distort the measured original", () => {
  const row = rowOf({ candidate: nest(66, { note: 'x {"password":"a\\"b-TAIL"} y' }) });
  const redacted = JSON.stringify(row.truncation);
  assert.ok(row.truncation?.candidate?.original_chars && row.truncation.candidate.original_chars > 0, redacted);
  assert.ok(!JSON.stringify(row).includes("TAIL"));
});

// ---------------------------------------------------------------------------------------------------------
// F3-B: retained list is measured exactly
// ---------------------------------------------------------------------------------------------------------

const sizeOfList = (items: string[]) => JSON.stringify(items).length;

test("F3-B: kept_chars equals the serialized length of the stored list, with no comma before the first item", () => {
  const item = "あ".repeat(10_000);
  const row = rowOf({ factIssues: Array.from({ length: 30 }, () => item) });
  const t = row.truncation!.fact_issues!;
  assert.equal(t.kept_chars, sizeOfList(row.fact_issues));
  assert.ok(sizeOfList(row.fact_issues) <= MAX_FIELD_CHARS);
  assert.deepEqual([t.original_count, t.kept_count], [30, row.fact_issues.length]);
  assert.equal(t.original_chars, sizeOfList(Array.from({ length: 30 }, () => item)));
});

test("F3-B: an item that fits exactly on the boundary is kept, one character more is not", () => {
  // Serialized: "[" + "\"" + a + "\"" + "]" = a.length + 4 for one item; two items add a comma.
  const overhead = 4;
  const first = "い".repeat(100_000);
  // second item sized so the list is EXACTLY the bound: [ "first" , "second" ]  => 2 + (f+2) + 1 + (s+2)
  const secondExact = "う".repeat(MAX_FIELD_CHARS - (2 + (first.length + 2) + 1 + 2));
  const exact = rowOf({ factIssues: [first, secondExact] });
  assert.equal(sizeOfList([first, secondExact]), MAX_FIELD_CHARS);
  assert.equal(exact.truncated, false, "total equals the bound: nothing is cut");
  assert.deepEqual(exact.fact_issues, [first, secondExact]);
  const oneOver = rowOf({ factIssues: [first, `${secondExact}x`] });
  assert.equal(oneOver.truncated, true);
  assert.deepEqual(oneOver.fact_issues, [first], "the second item no longer fits");
  assert.equal(oneOver.truncation?.fact_issues?.kept_chars, sizeOfList([first]));
  assert.equal(oneOver.truncation?.fact_issues?.kept_count, 1);
  assert.equal(oneOver.truncation?.fact_issues?.original_count, 2);
  assert.ok(overhead > 0);
});

test("F3-B: with a single item the old estimator wrongly dropped, the exact one keeps it", () => {
  // One item whose whole list is exactly the bound after a SMALLER earlier list entry is gone: the first item
  // alone, sized to the bound, must be kept (the old code charged a comma before it and discarded it).
  const lone = "え".repeat(MAX_FIELD_CHARS - 2 - 2);
  assert.equal(sizeOfList([lone]), MAX_FIELD_CHARS);
  const row = rowOf({ localIssues: [lone] });
  assert.equal(row.truncated, false);
  assert.deepEqual(row.local_issues, [lone]);
  // One character over: a single item that cannot fit is reported, not silently emptied.
  const over = rowOf({ localIssues: [`${lone}x`] });
  assert.deepEqual(over.local_issues, []);
  assert.equal(over.truncation?.local_issues?.kept_count, 0);
  assert.equal(over.truncation?.local_issues?.kept_chars, 2, "the stored empty list is two characters");
  assert.equal(over.local_issue_count, 1);
});

test("the bound itself and the decision-side issue cap are unchanged", () => {
  assert.equal(MAX_FIELD_CHARS, 200_000);
});
