// H2 review of PR #101: three blockers on the debug trace.
//   F2 (P1) a credential-shaped string could survive redaction or slip past the writer's check.
//   F3 (P2) the trace shortened evidence below its advertised bound (4,000-char strings, 700-char issues,
//           10 Fact findings, 80-item arrays) while claiming full retention.
// (F1, the access graph of the table, is proved on a disposable PostgreSQL: market_report_generation_traces_run.sh.)
// Content is kept whole and credentials are not: every case here pins one of those two directions.
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalysisInput } from "./analysis_input.ts";
import { type GenerationRecord, generateSharedAnalysis, type Requester } from "./analysis_logic.ts";
import {
  containsSecret,
  MAX_FIELD_CHARS,
  persistTraces,
  redactText,
  redactValue,
  REDACTED,
  TRACE_TABLE,
  type TraceRow,
  traceRows,
} from "./debug_trace.ts";
import { rich0917 } from "./test_support.ts";

const directory = new URL("./fixtures/", import.meta.url);
const dataFixture = JSON.parse(await Deno.readTextFile(new URL("close_2026-09-17_data_packet.json", directory)));
const newsRows = JSON.parse(await Deno.readTextFile(new URL("close_2026-09-17_news_rows.json", directory)));
const input = () =>
  buildAnalysisInput({ dataPacket: dataFixture.payload, dataPacketId: dataFixture.id, dataContentHash: dataFixture.content_hash, newsRows });
const good = () => rich0917(input());
const PASSED = { passed: true, issues: [] };

const context = {
  reportType: "morning" as const, tradingDate: "2026-10-07", cycleId: null, dataPacketId: null,
  invocationId: "33333333-3333-4333-8333-333333333333", attempt: 1, model: "m", basePromptHash: null,
};
const record = (patch: Partial<GenerationRecord> = {}): GenerationRecord => ({
  generationIndex: 1, stage: "fact", hardRejection: "fact", candidate: { headline_ja: "見出し" }, localPassed: true, localIssues: [],
  localWarnings: [], factRan: true, factPassed: false, factIssues: [], selectedForDelivery: false, fallbackReason: null, removedUnits: [], deliveryIssues: [], errorCode: null,
  requestHash: null, calls: 2, inputTokens: 1, outputTokens: 1, costUsd: 0, ...patch,
});
const row = (patch: Partial<GenerationRecord> = {}) => traceRows(context, [record(patch)])[0];

// ---------------------------------------------------------------------------------------------------------
// F2: credentials
// ---------------------------------------------------------------------------------------------------------

const SECRETS = {
  quotedJson: `{"password":"hunter2-Correct-Horse","note":"ok"}`,
  escapedJson: `{\\"access_token\\":\\"abcDEF123456xyz\\",\\"user\\":\\"x\\"}`,
  singleQuoted: `{'api_key': 'AbCd-1234-EfGh'}`,
  lowerBearer: "authorization header was bearer abcdefghij1234567890 here",
  lowerBasic: "got basic dXNlcjpwYXNzd29yZDEyMw== from the client",
  upperBasic: "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxx\nyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\n-----END RSA PRIVATE KEY-----",
  pemNoEnd: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signaturepart",
  openai: "sk-proj_ABCDEFGHIJKLMNOPQRSTUVWX",
  supabase: "sb_secret_AbCdEfGhIjKlMnOp",
  github: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  aws: "AKIAIOSFODNN7EXAMPLE",
  assignment: "token=abc123def456 and password: s3cr3tValue",
  authorizationHeader: "Authorization: Basic dXNlcjpwYXNz",
  cookie: "cookie: session=abcdef123456",
};

test("F2: every recognizable credential is redacted, wherever it sits and however it is quoted", () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    const cleaned = redactText(secret);
    assert.notEqual(cleaned, secret, `${name} must change`);
    assert.equal(containsSecret(cleaned), false, `${name} left credential material: ${cleaned}`);
    for (const fragment of ["hunter2-Correct-Horse", "abcDEF123456xyz", "AbCd-1234-EfGh", "abcdefghij1234567890", "dXNlcjpwYXNzd29yZDEyMw", "QWxhZGRpbjpvcGVuIHNlc2FtZQ", "MIIEowIBAAKCAQEA", "MIIEvQIBADANBgkq", "signaturepart", "ABCDEFGHIJKLMNOPQRSTUVWX", "AbCdEfGhIjKlMnOp", "abcdefghijklmnopqrstuvwxyz0123456789", "IOSFODNN7EXAMPLE", "abc123def456", "s3cr3tValue", "dXNlcjpwYXNz", "session=abcdef123456"]) {
      assert.ok(!cleaned.includes(fragment), `${name} still shows ${fragment}`);
    }
  }
});

test("F2: the surrounding sentence is kept, only the value is replaced", () => {
  assert.equal(redactText(SECRETS.quotedJson), `{"password":"${REDACTED}","note":"ok"}`);
  assert.equal(redactText("本文 token=abc123def456 の後ろも読める"), `本文 token=${REDACTED} の後ろも読める`);
  assert.ok(redactText(SECRETS.lowerBearer).startsWith("authorization header was Bearer [redacted]"));
});

test("F2: multiple matches in one string are all redacted, not only the first", () => {
  const many = `a ${SECRETS.openai} b ${SECRETS.github} c token=zzzz9999yyyy d ${SECRETS.jwt} e {"password":"p4ssw0rd-xyz"}`;
  const cleaned = redactText(many);
  assert.equal(containsSecret(cleaned), false, cleaned);
  assert.equal((cleaned.match(/\[redacted\]/g) ?? []).length, 5);
});

test("F2: nested objects, arrays and issue lists are redacted; credential-named keys lose their value", () => {
  const cleaned = JSON.stringify(redactValue({
    x_post: { points_ja: [`a ${SECRETS.openai}`, "通常の点"], extra: [{ deep: { text: SECRETS.escapedJson } }] },
    Authorization: "Bearer abcdefghij1234567890", access_token: "t0ken-value-1", clientSecret: "cs-1", api_key: "k-1", Cookie: "c=1",
  }));
  assert.equal(containsSecret(cleaned), false, cleaned);
  assert.ok(cleaned.includes("通常の点"));
  const [r] = traceRows(context, [record({ localIssues: [`指摘 ${SECRETS.quotedJson}`], factIssues: [`Fact ${SECRETS.pem}`, `${SECRETS.lowerBasic}`] })]);
  assert.equal(containsSecret(JSON.stringify(r)), false, JSON.stringify(r));
  assert.ok(r.fact_issues[0].startsWith("Fact "));
});

test("F2: ordinary Japanese, financial and news text is not touched", () => {
  const ordinary = [
    "日経平均は70,683.98（前日比+1.05%）で、TOPIX連動ETF（1306）は440.4円でした。",
    "パスワード管理アプリのトークン発行をめぐる報道があったが、市場との関係は確認できません。",
    "Bearer bonds and basic income guarantee were discussed; the secretary of state spoke.",
    "token economics: a basic introduction", // a plain word followed by a colon-less phrase
    "米国2年債利回りは4.83%（10月2日時点・最新ではありません）。",
    "input_tokens 29,320 / output_tokens 4,984",
    "ニュースの要約: 国連人権理事会が決議を採択した。",
    "公式サイト https://example.com/news/2026/10/07?lang=ja を参照。",
  ];
  for (const text of ordinary) {
    // The one deliberately ambiguous line: "token economics:" is text, not an assignment (no value follows).
    assert.equal(redactText(text), text, text);
    assert.equal(containsSecret(text), false, text);
  }
  const kept = row({ candidate: { summary: ordinary[0], news: ordinary[1] }, factIssues: [ordinary[3]] });
  assert.deepEqual(kept.candidate, { summary: ordinary[0], news: ordinary[1] });
  assert.deepEqual(kept.fact_issues, [ordinary[3]]);
});

test("F2: redaction is idempotent, so a row built from redacted text is never refused for what was already cleaned", () => {
  for (const secret of Object.values(SECRETS)) {
    const once = redactText(secret);
    assert.equal(redactText(once), once);
    assert.equal(containsSecret(JSON.stringify({ value: once })), false);
  }
});

const written = (fn: () => Promise<boolean>) => fn();

test("F2 writer: a forged row with a live credential is dropped and the insert callback is never called", async () => {
  const clean = row();
  const forged: Array<[string, TraceRow]> = [
    ["quoted JSON key in free text", { ...clean, candidate: { text: SECRETS.quotedJson } }],
    ["escaped JSON key", { ...clean, fact_issues: [SECRETS.escapedJson] }],
    ["lowercase bearer", { ...clean, local_issues: [SECRETS.lowerBearer] }],
    ["lowercase basic", { ...clean, candidate: SECRETS.lowerBasic }],
    ["PEM block", { ...clean, candidate: { key: SECRETS.pem } }],
    ["PEM without END", { ...clean, candidate: { key: SECRETS.pemNoEnd } }],
    ["nested", { ...clean, candidate: { a: { b: [{ c: SECRETS.github }] } } }],
    ["one redacted occurrence followed by a later live secret", {
      ...clean, candidate: { text: `first {"password":"${REDACTED}"} then {"password":"live-secret-value"}` },
    }],
    ["redacted bearer then a live bearer", { ...clean, fact_issues: [`Bearer ${REDACTED} and later Bearer liveTokenValue1234567890`] }],
  ];
  for (const [name, bad] of forged) {
    let called = 0;
    const logged: string[] = [];
    const ok = await written(() => persistTraces(() => { called += 1; return Promise.resolve(); }, [bad], (line) => logged.push(line)));
    assert.equal(ok, false, name);
    assert.equal(called, 0, `${name}: the insert callback must not run`);
    assert.ok(logged[0]?.startsWith("GENERATION_TRACE_ROW_DROPPED"), `${name}: ${logged.join("|")}`);
  }
});

test("F2 writer: a batch drops only the unsafe row; a safe batch is written once", async () => {
  const clean = row();
  const bad = { ...row({ generationIndex: 2 }), candidate: { text: SECRETS.lowerBasic } };
  const seen: TraceRow[][] = [];
  assert.equal(await persistTraces((_table, batch) => { seen.push(batch); return Promise.resolve(); }, [clean, bad], () => {}), true);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].map((r) => r.generation_index), [1]);
  assert.equal(await persistTraces(() => Promise.reject(new Error("x")), [clean], () => {}), false);
});

test("F2: dropping a row or failing to write never touches the report: the handler path is non-blocking and the model is not called again", async () => {
  const calls: string[] = [];
  const request: Requester = (step) => {
    calls.push(step);
    return Promise.resolve({ payload: step === "fact" ? PASSED : good(), inputTokens: 1, outputTokens: 1 });
  };
  const sink: GenerationRecord[] = [];
  const outcome = await generateSharedAnalysis(input(), request, () => new Date("2026-09-17T07:20:30Z"), sink);
  assert.equal(outcome.ok, true);
  const before = calls.length;
  const poisoned = traceRows(context, sink).map((r) => ({ ...r, candidate: { text: SECRETS.pem } }));
  assert.equal(await persistTraces(() => Promise.resolve(), poisoned, () => {}), false);
  assert.equal(calls.length, before, "no model call from trace handling");
});

// ---------------------------------------------------------------------------------------------------------
// F3: full retention
// ---------------------------------------------------------------------------------------------------------

test("F3: a field far past the old 4,000-character cut is kept whole, with its tail", () => {
  const tail = "末尾の確認用マーカー-TAIL-9f3a";
  const long = `${"あ".repeat(4_500)}${tail}`;
  const r = row({ candidate: { market_summary_ja: long, x_post: { context_ja: `${"い".repeat(9_000)}${tail}` } } });
  const kept = r.candidate as { market_summary_ja: string; x_post: { context_ja: string } };
  assert.equal(kept.market_summary_ja, long);
  assert.ok(kept.market_summary_ja.endsWith(tail) && kept.x_post.context_ja.endsWith(tail));
  assert.equal(r.truncated, false);
  assert.equal(r.truncation, null);
  assert.equal(r.candidate_chars, JSON.stringify(r.candidate).length);
});

test("F3: arrays longer than 80 items and a deeply nested candidate keep every element", () => {
  const items = Array.from({ length: 150 }, (_, index) => `項目${index}`);
  const r = row({ candidate: { claims: items, nested: { a: { b: { c: { d: { e: { f: { g: { h: { i: "深い値" } } } } } } } } } } });
  const kept = r.candidate as { claims: string[]; nested: unknown };
  assert.equal(kept.claims.length, 150);
  assert.equal(kept.claims[149], "項目149");
  assert.ok(JSON.stringify(kept.nested).includes("深い値"), "no depth marker replaced real content");
});

test("F3: long local issue text and long Fact issue text keep their tails", () => {
  const tail = "-ISSUE-TAIL-77";
  const long = `${"指摘".repeat(400)}${tail}`; // 800 characters, past the old 700-character cut
  const r = row({ localIssues: [long], localWarnings: [long], factIssues: [long] });
  for (const field of [r.local_issues, r.local_warnings, r.fact_issues]) {
    assert.equal(field[0], long);
    assert.ok(field[0].endsWith(tail));
  }
  assert.deepEqual([r.local_issue_count, r.fact_issue_count, r.truncated], [1, 1, false]);
});

test("F3: 11 or more Fact findings are all kept in the trace while the decision cap of 10 is unchanged", async () => {
  const findings = Array.from({ length: 13 }, (_, index) => `指摘${index + 1}`);
  const sink: GenerationRecord[] = [];
  const retryNotes: string[] = [];
  const request: Requester = (step, body) => {
    if (step === "generate") {
      retryNotes.push(String(body.instructions));
      return Promise.resolve({ payload: good(), inputTokens: 1, outputTokens: 1 });
    }
    return Promise.resolve({ payload: { passed: false, issues: findings }, inputTokens: 1, outputTokens: 1 });
  };
  const outcome = await generateSharedAnalysis(input(), request, () => new Date("2026-09-17T07:20:30Z"), sink);
  // Delivery first (2026-10-07): Fact findings the guards do not confirm are advisory after one regeneration.
  assert.equal(outcome.ok, true);
  assert.deepEqual(sink[0].factIssues, findings, "the record keeps all 13");
  const [r] = traceRows(context, [sink[0]]);
  assert.deepEqual(r.fact_issues, findings);
  assert.equal(r.fact_issue_count, 13);
  // The retry note and the returned issues keep the existing cap of 10: the decision did not change.
  assert.ok(retryNotes[1].includes("指摘10") && !retryNotes[1].includes("指摘11"));
  assert.ok(outcome.ok && outcome.packet.fact.quality_warnings?.includes("FACT_ADVISORY:13"), "the packet counts every finding");
  assert.deepEqual(sink[1].factIssues, findings);
});

test("F3: the only bound is declared, and a field above it says so with its original size", () => {
  assert.equal(MAX_FIELD_CHARS, 200_000);
  const huge = { text: "あ".repeat(MAX_FIELD_CHARS + 5_000) };
  const r = row({ candidate: huge });
  const kept = r.candidate as { truncated: boolean; reason: string; original_chars: number; kept_chars: number; head: string };
  assert.equal(kept.truncated, true);
  assert.equal(kept.reason, "field_bound");
  assert.equal(kept.original_chars, JSON.stringify(huge).length);
  assert.equal(kept.kept_chars, MAX_FIELD_CHARS);
  assert.equal(kept.head.length, MAX_FIELD_CHARS);
  assert.equal(r.truncated, true);
  assert.equal(r.candidate_chars, JSON.stringify(huge).length);
  assert.deepEqual(r.truncation?.candidate, { reason: "field_bound", original_chars: JSON.stringify(huge).length, kept_chars: MAX_FIELD_CHARS });
  // Just under the bound: nothing is cut, nothing is flagged.
  const under = row({ candidate: { text: "あ".repeat(MAX_FIELD_CHARS - 100) } });
  assert.equal(under.truncated, false);
  assert.equal((under.candidate as { text: string }).text.length, MAX_FIELD_CHARS - 100);
});

test("F3: an issue list above the bound keeps the leading findings that fit and reports the original count", () => {
  const issue = "あ".repeat(10_000);
  const r = row({ factIssues: Array.from({ length: 30 }, () => issue) });
  assert.equal(r.fact_issue_count, 30);
  assert.ok(r.fact_issues.length < 30 && r.fact_issues.length >= 19);
  assert.ok(JSON.stringify(r.fact_issues).length <= MAX_FIELD_CHARS);
  assert.equal(r.truncated, true);
  assert.deepEqual([r.truncation?.fact_issues?.original_count, r.truncation?.fact_issues?.kept_count], [30, r.fact_issues.length]);
  assert.equal(r.truncation?.candidate, undefined, "only the field that exceeded is flagged");
});

test("F3: redaction does not shorten evidence, and a row carries its identity whatever its size", () => {
  const r = row({ candidate: { text: `前 ${SECRETS.openai} 後 ${"う".repeat(6_000)}` } });
  const text = (r.candidate as { text: string }).text;
  assert.ok(text.startsWith(`前 ${REDACTED} 後 `) && text.endsWith("う"));
  assert.equal(text.length, `前 ${REDACTED} 後 `.length + 6_000);
  assert.equal(r.invocation_id, context.invocationId);
});

test("prompt identity: the request hash is per generation, and the base prompt hash is named for what it is", async () => {
  const sink: GenerationRecord[] = [];
  const request: Requester = (step) =>
    Promise.resolve({ payload: step === "fact" ? { passed: false, issues: ["x"] } : good(), inputTokens: 1, outputTokens: 1 });
  await generateSharedAnalysis(input(), request, () => new Date("2026-09-17T07:20:30Z"), sink);
  assert.equal(sink.length, 2);
  assert.match(String(sink[0].requestHash), /^[0-9a-f]{16}$/);
  assert.match(String(sink[1].requestHash), /^[0-9a-f]{16}$/);
  assert.notEqual(sink[0].requestHash, sink[1].requestHash, "the retry's request carries the previous issues, so it hashes differently");
  const rows = traceRows({ ...context, basePromptHash: "0123456789abcdef" }, sink);
  assert.deepEqual(rows.map((r) => r.base_prompt_hash), ["0123456789abcdef", "0123456789abcdef"]);
  assert.deepEqual(rows.map((r) => r.request_hash), sink.map((s) => s.requestHash));
  assert.ok(!("prompt_hash" in rows[0]), "the ambiguous column name is gone");
  assert.equal(TRACE_TABLE, "market_report_generation_traces");
});
