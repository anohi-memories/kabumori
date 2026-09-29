// Replay of the 2026-09-29 close (K2): the shared analysis failed on both scheduled attempts.
//   16:20 ANALYSIS_LOCAL_CHECK_FAILED  "TOPIX連動ETF（1306）をTOPIXと表記"
//   16:35 ANALYSIS_FACT_FAILED         headline / x_post asserted US-stock and semiconductor weakness as the
//                                      cause of the Tokyo decline although no input item states a reason.
// The failed drafts are not stored in production (only the issue strings), so the drafts below are
// representative of each failure class, built on the real 9/29 close input (fixtures/close_2026-09-29_*).
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalysisInput, type NewsTextRow } from "./analysis_input.ts";
import {
  type GeneratedAnalysis,
  generateSharedAnalysis,
  generationRequestBody,
  localAnalysisIssues,
  type Requester,
} from "./analysis_logic.ts";
import { type Deps, handleRequest } from "./handler.ts";

const directory = new URL("./fixtures/", import.meta.url);
const read = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(name, directory)));
const data0929 = await read("close_2026-09-29_data_packet.json");
const news0929: NewsTextRow[] = await read("close_2026-09-29_news_rows.json");

function input0929(newsRows: NewsTextRow[] = news0929, dataPacket = data0929.payload) {
  return buildAnalysisInput({ dataPacket, dataPacketId: data0929.id, dataContentHash: data0929.content_hash, newsRows });
}

const AIMECHATEC = "news:83fce291-1cf3-40bc-bdbb-1d9a1b82aa81";

/** What the fixed prompt should produce for 9/29: moves as dated facts, reason left unconfirmed once. */
function compliant0929(): GeneratedAnalysis {
  return {
    headline_ja: "日経平均とTOPIX連動ETF（1306）がそろって下落",
    market_summary_ja: "9月29日の東京市場は、日経平均が65,481.27（前日比−0.60%）、TOPIX連動ETF（1306）が425.4円（前日比−0.65%）と下落しました。9月28日の米国市場もNYダウが−0.67%、SOXが−1.61%と下げていましたが、東京市場の下落理由は入力からは確認できません。",
    claims: [
      { claim_id: "c1", text_ja: "9月29日の日経平均は65,481.27（前日比−0.60%）でした。", claim_type: "observation", evidence_refs: ["metric:nikkei225"], scope: "today" },
      { claim_id: "c2", text_ja: "9月29日のTOPIX連動ETF（1306）は425.4円（前日比−0.65%）でした。", claim_type: "observation", evidence_refs: ["metric:topix_proxy_1306"], scope: "today" },
      { claim_id: "c3", text_ja: "9月28日の米国市場ではフィラデルフィア半導体株指数（SOX）が前日比−1.61%でした。", claim_type: "consistent_with", evidence_refs: ["metric:sox"], scope: "overnight" },
      { claim_id: "c4", text_ja: "東京市場の下落理由は、入力のニュースでは確認できません。", claim_type: "insufficient_evidence", evidence_refs: [], scope: "today" },
      { claim_id: "c5", text_ja: "AIメカテック（6227）は海外の半導体関連メーカーから大口受注を発表しました。", claim_type: "observation", evidence_refs: [AIMECHATEC], scope: "today" },
    ],
    key_news: [{ ref: AIMECHATEC, why_it_matters_ja: "半導体関連の設備受注の動きです。" }],
    strong_themes: [],
    weak_themes: [],
    next_watch_ja: ["米国の半導体株指数の動き"],
    risks_ja: ["米国株の下げが続いた場合の振れ"],
    x_post: {
      lead_ja: "9月29日の東京市場は、日経平均もTOPIX連動ETF（1306）も下げました📉",
      points_ja: [
        "日経平均は65,481.27（前日比−0.60%）",
        "9月28日の米国市場はSOXが−1.61%",
        "AIメカテックが半導体関連の大口受注を発表",
      ],
      closing_ja: "下げた理由は、きょうのニュースからは確認できません。",
    },
  };
}

function requester(payloads: Array<{ step: "generate" | "fact"; payload: unknown }>, calls: Array<{ step: string; body: Record<string, unknown> }>): Requester {
  return (step, body) => {
    calls.push({ step, body });
    const next = payloads.shift();
    assert.ok(next, `unexpected ${step} call`);
    assert.equal(next.step, step);
    return Promise.resolve({ payload: next.payload, inputTokens: 1000, outputTokens: 200 });
  };
}

const NOW = () => new Date("2026-09-29T07:20:05Z");
const hasIssue = (issues: string[], prefix: string) => issues.some((issue) => issue.startsWith(prefix));
const TOPIX_ISSUE = "TOPIX連動ETF（1306）をTOPIXと表記";
const CAUSAL_ISSUE = "根拠の無い因果の断定";

// --- the real 9/29 input --------------------------------------------------------------------------

test("9/29 input: down day, TOPIX appears only as the 1306 proxy, and no news item states the reason", () => {
  const built = input0929();
  assert.equal(built.direction, "down");
  const serialized = JSON.stringify(built.modelInput);
  assert.deepEqual([...new Set(serialized.match(/TOPIX[^"]*/g))], ["TOPIX連動ETF（1306）"]);
  assert.ok(!built.news.some((item) => /下落|値下がり|株安|要因|理由/.test(`${item.headline_ja}${item.summary_ja ?? ""}`) && /東京|日経|日本株/.test(`${item.headline_ja}${item.summary_ja ?? ""}`)));
  assert.deepEqual(localAnalysisIssues(compliant0929(), built), []);
});

// --- 16:20 class: 1306 relabelled as TOPIX ----------------------------------------------------------

test("replay 16:20: 1306 written as the TOPIX index is rejected, with the offending excerpt", () => {
  const built = input0929();
  const cases: Array<[string, (a: GeneratedAnalysis) => void]> = [
    ["headline", (a) => { a.headline_ja = "日経平均とTOPIXがそろって下落"; }],
    ["x_post lead", (a) => { a.x_post.lead_ja = "9月29日は日経平均もTOPIXも下げました📉"; }],
    ["x_post point", (a) => { a.x_post.points_ja[0] = "TOPIXは425.4円（前日比−0.65%）"; }],
    ["summary with the code", (a) => { a.market_summary_ja = a.market_summary_ja.replace("TOPIX連動ETF（1306）", "TOPIX（1306）"); }],
    ["full-width", (a) => { a.headline_ja = "日経平均とＴＯＰＩＸがそろって下落"; }],
  ];
  for (const [label, mutate] of cases) {
    const analysis = compliant0929();
    mutate(analysis);
    const issues = localAnalysisIssues(analysis, built);
    const issue = issues.find((value) => value.startsWith(TOPIX_ISSUE));
    assert.ok(issue, `${label}: not detected: ${issues.join(" / ")}`);
    assert.match(issue!, /「.*TOPIX.*」/, `${label}: the issue quotes where it happened`);
  }
});

test("accurate proxy wording for 1306 is not a mislabel", () => {
  const built = input0929();
  for (const name of ["TOPIX連動ETF（1306）", "TOPIX連動ETF(1306)", "TOPIX連動型ETF（1306）", "TOPIX連動型ETF", "ＴＯＰＩＸ連動ＥＴＦ（１３０６）"]) {
    const analysis = compliant0929();
    analysis.x_post.lead_ja = `9月29日の東京市場は、日経平均も${name}も下げました📉`;
    assert.deepEqual(localAnalysisIssues(analysis, built).filter((issue) => issue.startsWith(TOPIX_ISSUE)), [], name);
  }
});

// --- 16:35 class: unconfirmed cause asserted ------------------------------------------------------

const ASSERTED_CAUSES = [
  "米株安・半導体株安を受けて東京市場も下落",
  "米株安と半導体株安で東京市場も下落",
  "米国株安につれて東京市場も下落",
  "半導体株安が重しとなり日経平均は下落",
  "米国株安の流れを引き継いで東京市場も下落",
  "米株安・半導体株安が東京市場下落の原因です",
  "米国株安の影響で日経平均も下落",
  // A hedge does not make an unsupported cause acceptable.
  "米株安が影響した可能性があります",
  "半導体株安が響いたとみられます",
];

test("replay 16:35: an unconfirmed cause in the headline is rejected locally (before Fact)", () => {
  const built = input0929();
  for (const headline of ASSERTED_CAUSES) {
    const analysis = compliant0929();
    analysis.headline_ja = headline;
    const issues = localAnalysisIssues(analysis, built);
    assert.ok(hasIssue(issues, CAUSAL_ISSUE), `headline not detected: ${headline}`);
  }
});

test("replay 16:35: the same in x_post (lead, points, closing), summary and non-causal claims", () => {
  const built = input0929();
  const placements: Array<(a: GeneratedAnalysis, text: string) => void> = [
    (a, text) => { a.x_post.lead_ja = `${text}📉`; },
    (a, text) => { a.x_post.points_ja[1] = text; },
    (a, text) => { a.x_post.closing_ja = text; },
    (a, text) => { a.market_summary_ja = `${text}。${a.market_summary_ja}`; },
    (a, text) => { a.claims[2].text_ja = text; },
  ];
  for (const text of ASSERTED_CAUSES) {
    for (const place of placements) {
      const analysis = compliant0929();
      place(analysis, text);
      assert.ok(hasIssue(localAnalysisIssues(analysis, built), CAUSAL_ISSUE), `not detected: ${text}`);
    }
  }
});

test("dated parallel facts and an explicit 'reason unconfirmed' stay allowed", () => {
  const built = input0929();
  const allowed = [
    "9月28日の米国市場も下落していましたが、東京市場の下落理由は確認できません",
    "米株安を受けた動きかどうかは、入力からは確認できません",
    "米国株安の影響かは断定できません",
    "9月28日の米国株安と9月29日の東京市場の下落は同時期に確認できますが、因果関係は確認できません",
    "日経平均は下落で取引を終えました",
  ];
  for (const text of allowed) {
    const analysis = compliant0929();
    analysis.x_post.closing_ja = text;
    assert.deepEqual(localAnalysisIssues(analysis, built).filter((issue) => issue.startsWith(CAUSAL_ISSUE)), [], text);
  }
});

test("a cause the news states (a causal claim without disclaimer) can still be written as confirmed", () => {
  const confirmed: NewsTextRow = {
    id: "0f0f0f0f-0000-4000-8000-000000000929",
    source_type: "breaking_market",
    company_code: null,
    company_name: null,
    title: "Tokyo stocks fall after semiconductor selloff",
    coverage_severity: "high",
    coverage_categories: ["japan_market", "semiconductors"],
    published_at: "2026-09-29T06:50:00Z",
    created_at: "2026-09-29T06:51:00Z",
    app_title_ja: "東京市場、米半導体株安を受けて下落",
    app_summary_ja: "9月29日の東京市場は、前日の米国市場で半導体株が売られたことを受けて、半導体関連株を中心に下落したと報じられました。",
    app_copy_fact_status: "passed",
    generated_text: null,
    generation_fact_status: null,
  };
  const packet = structuredClone(data0929.payload);
  packet.news_refs.items.push({ ...packet.news_refs.items[0], ref_id: confirmed.id });
  const built = input0929([...news0929, confirmed], packet);
  const ref = `news:${confirmed.id}`;
  assert.ok(built.newsRefs.has(ref));
  const analysis = compliant0929();
  analysis.claims[3] = { claim_id: "c4", text_ja: "東京市場は、前日の米国市場の半導体株安を受けて半導体関連株を中心に下落したと報じられました。", claim_type: "causal", evidence_refs: [ref, "metric:nikkei225"], scope: "today" };
  analysis.headline_ja = "米半導体株安を受けて東京市場は下落";
  analysis.x_post.closing_ja = "半導体関連株を中心に下げたと報じられています。";
  assert.deepEqual(localAnalysisIssues(analysis, built), []);

  // A "causal" label whose own text says the link is unconfirmed (seen 2026-09-25) does not license it.
  analysis.claims[3].text_ja = "半導体関連の報道がありましたが、市場全体の下落との因果は確認できません。";
  assert.ok(hasIssue(localAnalysisIssues(analysis, built), CAUSAL_ISSUE));
});

// --- regeneration --------------------------------------------------------------------------------

test("regeneration instructions keep qualifiers and quote what to fix", () => {
  const built = input0929();
  const bad = compliant0929();
  bad.headline_ja = "日経平均とTOPIXがそろって下落";
  const issues = localAnalysisIssues(bad, built);
  const instructions = String(generationRequestBody(built, issues).instructions);
  assert.ok(instructions.includes("「日経平均とTOPIXがそろって下落」"), "the offending text is quoted");
  assert.match(instructions, /不確実性の注記.*保/);
  assert.match(instructions, /新しい理由を足し/);
  const first = String(generationRequestBody(built, []).instructions);
  assert.ok(!/前回の生成は/.test(first));
  // The standing rules are in every generation, first or regenerated.
  for (const body of [first, instructions]) {
    assert.ok(body.includes("日経平均とTOPIXがそろって下落"), "the 1306 shorthand is named as wrong");
    assert.ok(body.includes("可能性"), "hedged causes are addressed");
  }
});

test("replay: 1306 mislabel then a compliant regeneration → Fact → one packet", async () => {
  const bad = compliant0929();
  bad.headline_ja = "日経平均とTOPIXがそろって下落";
  const calls: Array<{ step: string; body: Record<string, unknown> }> = [];
  const outcome = await generateSharedAnalysis(input0929(), requester([
    { step: "generate", payload: bad },
    { step: "generate", payload: compliant0929() },
    { step: "fact", payload: { passed: true, issues: [] } },
  ], calls), NOW);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.packet.fact.generation_attempts, 2);
  assert.deepEqual(calls.map((call) => call.step), ["generate", "generate", "fact"]);
});

test("replay 16:35 mechanism: a regeneration that turns a qualified statement into a cause is stopped before Fact", async () => {
  const first = compliant0929();
  first.headline_ja = "日経平均とTOPIXがそろって下落";
  const second = compliant0929();
  second.headline_ja = "米株安・半導体株安を受けて東京市場も下落";
  second.x_post.lead_ja = "米株安・半導体株安の流れで、東京市場も下げました📉";
  const calls: Array<{ step: string; body: Record<string, unknown> }> = [];
  const outcome = await generateSharedAnalysis(input0929(), requester([
    { step: "generate", payload: first },
    { step: "generate", payload: second },
  ], calls), NOW);
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.error, "ANALYSIS_LOCAL_CHECK_FAILED");
  assert.ok(!outcome.ok && hasIssue(outcome.issues, CAUSAL_ISSUE));
  assert.deepEqual(calls.map((call) => call.step), ["generate", "generate"], "no Fact call is spent on it");
});

// --- handler: fail closed, no transport retry, one claim -----------------------------------------

test("handler: content rejection on both generations fails closed with no transport retry and no packet", async () => {
  const SUPABASE = "https://project-ref.supabase.co";
  const SECRET = "cron-secret-for-tests";
  const bad = compliant0929();
  bad.headline_ja = "米株安を受けて東京市場も下落";
  const rpc: Array<{ name: string; body: Record<string, unknown> }> = [];
  const openai: string[] = [];
  const waits: number[] = [];
  const json = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
  const fetchMock: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (url === "https://api.openai.com/v1/responses") {
      openai.push(String(body?.instructions).includes("Factチェッカー") ? "fact" : "generate");
      return json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(bad) }] }], usage: { input_tokens: 900, output_tokens: 300 } });
    }
    const path = url.slice(`${SUPABASE}/rest/v1/`.length);
    if (path.startsWith("market_holidays")) return json([]);
    if (path.startsWith("rpc/")) {
      rpc.push({ name: path.slice(4), body });
      if (path === "rpc/claim_market_report_analysis") {
        return json([{ cycle_id: "11111111-1111-4111-8111-111111111111", claim_token: "22222222-2222-4222-8222-222222222222", attempt: 1, outcome: "claimed", data_packet_id: data0929.id }]);
      }
      return json("failed");
    }
    if (path.startsWith("market_data_packets")) return json([{ id: data0929.id, content_hash: data0929.content_hash, payload: data0929.payload, data_quality_status: "partial" }]);
    if (path.startsWith("important_news_candidates")) return json(news0929);
    return Promise.reject(new Error(`UNEXPECTED:${url}`));
  };
  const deps: Deps = {
    env: (name) => ({ SUPABASE_URL: SUPABASE, SUPABASE_SECRET_KEYS: JSON.stringify({ default: "service-secret" }), SEND_PUSH_NOTIFICATIONS_CRON_SECRET: SECRET, OPENAI_API_KEY: "openai-test-key" } as Record<string, string>)[name],
    fetch: fetchMock,
    now: () => new Date("2026-09-29T07:20:00Z"),
    sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
  };
  const response = await handleRequest(new Request("https://functions.local/market-report-analysis", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Cron-Secret": SECRET }, body: JSON.stringify({ mode: "close" }),
  }), deps);
  const body = await response.json();
  assert.equal(body.error, "ANALYSIS_LOCAL_CHECK_FAILED");
  assert.deepEqual(openai, ["generate", "generate"]);
  assert.deepEqual(waits, []);
  assert.deepEqual(rpc.map((call) => call.name), ["claim_market_report_analysis", "fail_market_report_analysis"], "one claim, one fail, no packet");
  const diagnostics = rpc[1].body.p_diagnostics as Record<string, string>;
  assert.equal(diagnostics.transport_retries, "0");
  assert.ok(diagnostics.issues.includes(CAUSAL_ISSUE), "the reason is kept for the next investigation");
  assert.ok(!JSON.stringify(rpc).includes("openai-test-key"));
});
