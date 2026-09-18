// Content-quality regressions from the first natural close on 2026-09-18
// (K1 review: field-name leakage, cross-date wording, theme semantics,
// major-material prioritisation, repetitive disclaimers).
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalysisInput } from "./analysis_input.ts";
import { assemblePacket, generationRequestBody, type GeneratedAnalysis, localAnalysisIssues } from "./analysis_logic.ts";
import { appMarketSection, formatSharedXPost, sharedXPostIssues } from "../_shared/market_report_packet.ts";

const directory = new URL("./fixtures/", import.meta.url);
const read = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(name, directory)));
const data0918 = await read("close_2026-09-18_data_packet.json");
const news0918 = await read("close_2026-09-18_news_rows.json");
const generated0918 = await read("close_2026-09-18_generated_report.json");
const data0917 = await read("close_2026-09-17_data_packet.json");
const news0917 = await read("close_2026-09-17_news_rows.json");

const BOJ = "news:cafc0f82-aae4-43ae-ad9f-b814564079ab";

function input0918() {
  return buildAnalysisInput({ dataPacket: data0918.payload, dataPacketId: data0918.id, dataContentHash: data0918.content_hash, newsRows: news0918 });
}

/** The analysis part of the packet actually generated at 16:35 on 2026-09-18 (Fact passed). */
function generatedAnalysis(): GeneratedAnalysis {
  const p = generated0918.payload;
  return {
    headline_ja: p.headline_ja,
    market_summary_ja: p.market_summary_ja,
    claims: p.claims,
    key_news: p.key_news.map((news: { ref_id: string; why_it_matters_ja: string }) => ({ ref: news.ref_id, why_it_matters_ja: news.why_it_matters_ja })),
    strong_themes: p.strong_themes,
    weak_themes: p.weak_themes,
    next_watch_ja: p.next_watch_ja,
    risks_ja: p.risks_ja,
    x_post: p.x_post,
  };
}

/** What the fixed prompt should produce for 2026-09-18 (hand-written, grounded in the fixture). */
function compliantAnalysis(): GeneratedAnalysis {
  return {
    headline_ja: "日銀が政策金利を1.25%へ、日経平均は+1.38%",
    market_summary_ja: "9月18日は日銀が政策金利を1.00%から1.25%へ引き上げました。東京市場では日経平均が65,018.95（前日比+1.38%）と上げた一方、TOPIX連動ETF（1306）は426.3円（前日比−0.26%）で、指数によって方向が分かれました。利上げと値動きの因果はニュースでは明記されていません。",
    claims: [
      { claim_id: "c1", text_ja: "日銀が政策金利を1.00%から1.25%へ引き上げました。", claim_type: "observation", evidence_refs: [BOJ], scope: "today" },
      { claim_id: "c2", text_ja: "日経平均は65,018.95（前日比+1.38%）、TOPIX連動ETF（1306）は426.3円（前日比−0.26%）でした。", claim_type: "observation", evidence_refs: ["metric:nikkei225", "metric:topix_proxy_1306"], scope: "today" },
      { claim_id: "c3", text_ja: "日銀の決定発表後に日経225が上昇したと報じられていますが、利上げとの因果関係はニュースでは明記されていません。", claim_type: "consistent_with", evidence_refs: [BOJ, "metric:nikkei225"], scope: "today" },
      { claim_id: "c4", text_ja: "9月17日の米国市場ではSOXが前日比+3.14%でした。9月18日の東京市場への影響は、それぞれ日付が異なるため参考情報です。", claim_type: "consistent_with", evidence_refs: ["metric:sox"], scope: "overnight" },
      { claim_id: "c5", text_ja: "利上げ後の銀行株や不動産株の反応は、次の取引日も確認したい点です。", claim_type: "watch_point", evidence_refs: [BOJ], scope: "next" },
    ],
    key_news: [{ ref: BOJ, why_it_matters_ja: "政策金利の引き上げは金利に敏感な業種の見方に関わります。" }],
    strong_themes: [{ name_ja: "半導体", claim_ids: ["c4"] }],
    weak_themes: [],
    next_watch_ja: ["利上げ後の銀行株・不動産株の反応"],
    risks_ja: ["金利上昇が続いた場合の株価の振れ"],
    x_post: {
      lead_ja: "日銀が政策金利を1.25%へ引き上げた日、日経平均は+1.38%でした📈",
      points_ja: [
        "日銀が政策金利を1.00%→1.25%に",
        "日経平均65,018.95、前日比+1.38%",
        "TOPIX連動ETF（1306）は−0.26%で逆方向",
      ],
      closing_ja: "利上げと値動きの因果ははっきりしないので、次の取引日の銀行株の反応も見たいです",
    },
  };
}

test("the model input uses Japanese keys only (no English field names to copy)", () => {
  const built = input0918();
  const serialized = JSON.stringify(built.modelInput);
  assert.ok(!serialized.includes("change_pct"));
  assert.ok(!serialized.includes("session_date"));
  const keys: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        walk(child);
      }
    }
  };
  walk(built.modelInput);
  assert.deepEqual([...new Set(keys.filter((key) => /[A-Za-z]/.test(key)))], ["ref"]);
});

test("2026-09-18: sessions differ, the BOJ decision is a major item listed first", () => {
  const built = input0918();
  assert.equal(built.sessionsDiffer, true);
  assert.deepEqual([...built.majorNewsRefs], [BOJ]);
  assert.deepEqual(built.majorKeywords, ["日銀", "政策金利"]);
  const firstNews = (built.modelInput.ニュース as Array<{ ref: string; 重要材料: boolean }>)[0];
  assert.equal(firstNews.ref, BOJ);
  assert.equal(firstNews.重要材料, true);
  assert.ok(String(built.modelInput.日付の注意).includes("「同じ日」とは書きません"));
});

test("the prompt no longer suggests 『同じ日に』 wording and asks for explicit dates", () => {
  const instructions = String(generationRequestBody(input0918(), []).instructions);
  assert.ok(!instructions.includes("「〜と同じ日に〜」のように書く"));
  assert.ok(instructions.includes("それぞれの日付を明記します"));
  assert.ok(instructions.includes("「重要材料」が true のニュース"));
  assert.ok(instructions.includes("根拠が足りなければ空の配列"));
});

test("regression: the 16:20 Fact failure (『同じ日に』 across 9/17 US and 9/18 Tokyo) is now caught locally", () => {
  const analysis = compliantAnalysis();
  analysis.claims[3].text_ja = "9月17日の米国市場の上昇と同じ日に確認できます。";
  const issues = localAnalysisIssues(analysis, input0918());
  assert.ok(issues.includes("日付の違う東京市場と米国市場を「同じ日」と表現"), issues.join(" / "));
});

test("regression: the 16:35 packet that passed Fact is now rejected for every K1 finding", () => {
  const issues = localAnalysisIssues(generatedAnalysis(), input0918());
  const has = (fragment: string) => issues.some((issue) => issue.includes(fragment));
  assert.ok(has("本文に内部の項目名や識別子: change_pct"), issues.join(" / "));
  assert.ok(has("X本文で不確実性の注記を繰り返している"), issues.join(" / "));
  assert.ok(has("insufficient_evidence の claim が複数ある"), issues.join(" / "));
  assert.ok(has("テーマではない（指数・方向差・報道）: 日経平均の上昇"), issues.join(" / "));
  assert.ok(has("テーマではない（指数・方向差・報道）: 日経平均とTOPIX連動ETF（1306）の方向差"), issues.join(" / "));
  assert.ok(has("テーマではない（指数・方向差・報道）: 日銀決定発表後の上昇報道"), issues.join(" / "));
  assert.ok(has("重要材料（日銀・政策金利）が要約に無い"), issues.join(" / "));
});

test("a date-explicit analysis that surfaces the BOJ decision passes, with readable X and app text", () => {
  const built = input0918();
  const analysis = compliantAnalysis();
  assert.deepEqual(localAnalysisIssues(analysis, built), []);
  const packet = assemblePacket(built, analysis, { generatedAt: new Date("2026-09-18T07:35:30Z"), attempts: 1 });
  const post = formatSharedXPost(packet);
  assert.deepEqual(sharedXPostIssues(packet, post), []);
  assert.ok(post.includes("日銀が政策金利を1.00%→1.25%に"));
  assert.ok(!/[A-Za-z]+_[A-Za-z]+/.test(post));
  const section = appMarketSection(packet, "r-sample", "c".repeat(64));
  assert.ok(section.market_summary_ja.startsWith("9月18日は日銀が政策金利"));
  assert.equal(packet.market_direction, "mixed");
});

test("each K1 rule is enforced individually", () => {
  const built = input0918();
  const cases: Array<[string, (analysis: GeneratedAnalysis) => void]> = [
    ["本文に内部の項目名や識別子: session_date", (a) => { a.claims[1].text_ja = "session_dateは9月18日です。"; }],
    ["本文に内部の項目名や識別子: metric:", (a) => { a.risks_ja = ["metric:nikkei225 の変動"]; }],
    ["X本文で不確実性の注記を繰り返している", (a) => { a.x_post.closing_ja = "理由は確認できません。影響も断定できません。"; }],
    ["要約で不確実性の注記を繰り返している", (a) => { a.market_summary_ja = "日銀が政策金利を1.25%へ引き上げました。理由は確認できません。影響も断定できません。"; }],
    ["重要材料のニュースが key_news に無い", (a) => { a.key_news = []; }],
    ["重要材料（日銀・政策金利）がX本文に無い", (a) => {
      a.x_post.lead_ja = "日経平均は+1.38%でした";
      a.x_post.points_ja = ["日経平均65,018.95、前日比+1.38%", "TOPIX連動ETF（1306）は−0.26%", "指数で方向が分かれました"];
      a.x_post.closing_ja = "次の取引日も見たいです";
    }],
    ["テーマの根拠（ニュース等）が無い", (a) => {
      a.claims.push({ claim_id: "c9", text_ja: "日経平均は65,018.95でした。", claim_type: "observation", evidence_refs: ["metric:nikkei225"], scope: "today" });
      a.strong_themes = [{ name_ja: "輸出関連", claim_ids: ["c9"] }];
    }],
  ];
  for (const [expected, mutate] of cases) {
    const analysis = compliantAnalysis();
    mutate(analysis);
    const issues = localAnalysisIssues(analysis, built);
    assert.ok(issues.some((issue) => issue.includes(expected)), `${expected} not detected: ${issues.join(" / ")}`);
  }
});

test("same-date sessions may say 同日 (morning: Tokyo and US both 9/16)", () => {
  const built = buildAnalysisInput({
    dataPacket: { ...data0917.payload, session: { ...data0917.payload.session, jpx_session_date: "2026-09-16", us_session_date: "2026-09-16" } },
    dataPacketId: data0917.id, dataContentHash: data0917.content_hash, newsRows: news0917,
  });
  assert.equal(built.sessionsDiffer, false);
});
