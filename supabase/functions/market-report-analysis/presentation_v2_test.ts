// Shared market report presentation v2 (2026-10-01): a ~500-character X digest and a richer app story
// from one fact spine, with hard facts separated from quality warnings. Inputs are real production
// packets (9/30 close, 10/1 morning); generated text is hand-written and grounded in them.
import assert from "node:assert/strict";
import test from "node:test";
import type { MarketDataPacket } from "../market-report-data-packet/packet_schema.ts";
import {
  emojiCount,
  formatSharedXPost,
  type MarketReportPacket,
  PRESENTATION_VERSION,
  REPORT_SCHEMA_VERSION,
  sharedXPostIssues,
  sharedXPostWarnings,
  X_POST_HARD_MAX_CHARS,
  X_POST_TARGET_MAX_CHARS,
  X_POST_TARGET_MIN_CHARS,
} from "../_shared/market_report_packet.ts";
import {
  APP_STORY_TARGET_MAX_CHARS,
  APP_STORY_TARGET_MIN_CHARS,
  appStoryText,
  buildAppMarketStory,
} from "../_shared/market_report_story.ts";
import { isMajorNews } from "./analysis_input.ts";
import {
  assemblePacket,
  type GeneratedAnalysis,
  generateSharedAnalysis,
  generationDiagnostics,
  generationRequestBody,
  localAnalysisCheck,
  parseGeneratedAnalysis,
  type Requester,
  reportContentHash,
} from "./analysis_logic.ts";
import { type Deps, handleRequest } from "./handler.ts";
import { inputOf, loadFixture, richClose0930, richMorning1001 } from "./test_support.ts";

const morning = await loadFixture("morning_2026-10-01");
const close = await loadFixture("close_2026-09-30");
const directory = new URL("./fixtures/", import.meta.url);
const stored = async (name: string): Promise<MarketReportPacket> =>
  JSON.parse(await Deno.readTextFile(new URL(name, directory))).payload;
/** Production packets written before presentation v2 (no x_post.context_ja, no app_story). */
const v1Morning0930 = await stored("morning_2026-09-30_generated_report.json");
const v1Morning1001 = await stored("morning_2026-10-01_generated_report.json");

const NOW = () => new Date("2026-10-01T22:55:20Z");
const chars = (text: string) => Array.from(text).length;
const packetOf = (analysis: GeneratedAnalysis, input = inputOf(morning)) =>
  assemblePacket(input, analysis, { generatedAt: NOW(), attempts: 1, warnings: localAnalysisCheck(analysis, input).warnings });
const hardOf = (analysis: GeneratedAnalysis, input = inputOf(morning)) => localAnalysisCheck(analysis, input).hard;
const has = (issues: string[], fragment: string) => issues.some((issue) => issue.includes(fragment));

function requester(steps: Array<{ step: "generate" | "fact"; payload: unknown }>, calls: string[] = []): Requester {
  return (step) => {
    calls.push(step);
    const next = steps.shift();
    assert.ok(next, `unexpected ${step} call`);
    assert.equal(next.step, step);
    return Promise.resolve({ payload: next.payload, inputTokens: 1000, outputTokens: 400 });
  };
}

/** The same analysis with every optional paragraph left empty: hard-fact safe, editorially thin. */
function sparse(analysis: GeneratedAnalysis): GeneratedAnalysis {
  return {
    ...analysis,
    x_post: { ...analysis.x_post, context_ja: "", news_ja: "", watch_ja: "" },
    app_story: { summary_ja: analysis.app_story!.summary_ja, overseas_ja: "", japan_ja: "", cross_asset_ja: "", news_ja: "", strong_ja: "", caution_ja: "", watch_ja: "" },
  };
}

// ---------------------------------------------------------------------------------------------
// X richness
// ---------------------------------------------------------------------------------------------

for (const [label, fixture, make] of [["morning", morning, richMorning1001], ["close", close, richClose0930]] as const) {
  test(`X ${label}: a rich packet renders a ~500-character digest with every section`, () => {
    const input = inputOf(fixture);
    const analysis = make(input);
    assert.deepEqual(localAnalysisCheck(analysis, input), { hard: [], warnings: [] });
    const packet = packetOf(analysis, input);
    assert.equal(packet.schema_version, REPORT_SCHEMA_VERSION, "the stored schema_version is unchanged (table check)");
    assert.equal(packet.presentation_version, PRESENTATION_VERSION);
    const post = formatSharedXPost(packet);
    assert.ok(chars(post) >= X_POST_TARGET_MIN_CHARS && chars(post) <= X_POST_TARGET_MAX_CHARS, `length ${chars(post)}`);
    assert.deepEqual([sharedXPostIssues(packet, post), sharedXPostWarnings(packet, post)], [[], []]);
    const sections = post.split("\n\n");
    assert.ok(sections[0].startsWith(label === "morning" ? "【朝刊】きょうの日本株、ここをチェック☀️\n" : "【大引け】きょうの日本株まとめ🌙\n"));
    assert.ok(sections[1].startsWith(label === "morning" ? "📌 今日の注目ポイント\n・" : "📌 今日の3ポイント\n・"));
    assert.equal(sections[1].split("\n").filter((line) => line.startsWith("・")).length, 3, "exactly 3 points");
    assert.equal(sections[2], analysis.x_post.context_ja, "context paragraph");
    assert.equal(sections[3], `📰 ${analysis.x_post.news_ja}`, "news paragraph");
    assert.ok(sections[4].startsWith(label === "morning" ? "👀 今日見るポイント\n" : "👀 明日以降の注目点\n"));
    assert.ok(sections[5].startsWith("💬 今日のひとこと\n"));
    assert.ok(emojiCount(post) >= 3 && emojiCount(post) <= 8, `emoji ${emojiCount(post)}`);
    assert.ok(!/https?:|[#＃]\S/.test(post), "no URL, no hashtag (fixed hashtags are appended by the X consumer)");
  });
}

test("X: a short but safe digest is a quality warning, not a failure, and is still delivered", async () => {
  const input = inputOf(morning);
  const thin = sparse(richMorning1001(input));
  const check = localAnalysisCheck(thin, input);
  assert.deepEqual(check.hard, []);
  assert.ok(has(check.warnings, "X_POST_SHORTER_THAN_TARGET"), check.warnings.join(" / "));
  assert.ok(has(check.warnings, "X_POST_CONTEXT_OMITTED") && has(check.warnings, "APP_STORY_SHORTER_THAN_TARGET"));
  const post = formatSharedXPost(packetOf(thin, input));
  assert.ok(!post.includes("📰") && !post.includes("👀"), "omitted paragraphs leave no empty headings");
  assert.deepEqual(sharedXPostIssues(packetOf(thin, input), post), [], "postable");

  // One bounded rewrite is tried; when the rewrite is no better, the safe original goes out.
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: thin }, { step: "fact", payload: { passed: true, issues: [] } },
    { step: "generate", payload: thin }, { step: "fact", payload: { passed: true, issues: [] } },
  ], calls), NOW);
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, ["generate", "fact", "generate", "fact"], "at most one rewrite: the call budget is unchanged");
  assert.ok(outcome.ok && has(outcome.packet.fact.quality_warnings ?? [], "X_POST_SHORTER_THAN_TARGET"));
});

test("X: malformed or platform-unsafe output is a hard failure", () => {
  const input = inputOf(morning);
  const twoPoints = richMorning1001(input);
  twoPoints.x_post.points_ja = twoPoints.x_post.points_ja.slice(0, 2);
  assert.ok(has(hardOf(twoPoints), "X_POST_POINTS_INVALID"));
  const endless = richMorning1001(input);
  endless.x_post.context_ja = "指数の方向が分かれています。".repeat(60);
  assert.ok(chars(formatSharedXPost(packetOf(endless, input))) > X_POST_HARD_MAX_CHARS);
  assert.ok(has(hardOf(endless), "X_POST_TOO_LONG"));
  const noLead = richMorning1001(input);
  noLead.x_post.lead_ja = "";
  assert.ok(has(hardOf(noLead), "X_POST_SECTION_EMPTY"));
  assert.equal(parseGeneratedAnalysis({ headline_ja: "", market_summary_ja: "" }), null, "missing mandatory fields do not parse");
});

// ---------------------------------------------------------------------------------------------
// App richness
// ---------------------------------------------------------------------------------------------

test("App morning: structured story with headings, prose and dated fact lines; richer than X", () => {
  const input = inputOf(morning);
  const packet = packetOf(richMorning1001(input), input);
  const story = buildAppMarketStory(packet);
  assert.deepEqual(story.sections.map((item) => item.key), ["summary", "overseas", "japan", "cross_asset", "news", "caution", "watch", "gaps"]);
  assert.deepEqual(story.sections.map((item) => item.heading_ja).slice(0, 5), [
    "☀️ 今日の市場をひとことで", "🇺🇸 前夜の米国市場", "🇯🇵 今日の日本株をどう見るか", "💹 為替・金利・半導体など", "📰 重要ニュース",
  ]);
  assert.ok(story.char_count >= APP_STORY_TARGET_MIN_CHARS && story.char_count <= APP_STORY_TARGET_MAX_CHARS, `narrative ${story.char_count}`);
  assert.ok(story.char_count > chars(formatSharedXPost(packet)) * 1.8, "materially more detailed than the X digest");
  assert.ok(story.total_char_count > story.char_count, "fact lines add to the narrative");
  // Fields are plain strings: no markup, safe for a native Text component.
  for (const item of story.sections) {
    for (const value of [item.heading_ja, item.body_ja, ...item.lines_ja]) {
      assert.equal(typeof value, "string");
      assert.ok(!/<[a-zA-Z/]|\*\*|^#+\s|https?:/m.test(value), value);
    }
  }
});

test("App close: story sections, and the morning packet of the same day is answered in code", () => {
  const input = inputOf(close);
  const packet = packetOf(richClose0930(input), input);
  const story = buildAppMarketStory(packet, v1Morning0930);
  assert.deepEqual(story.sections.map((item) => item.key), ["summary", "japan", "moves", "news", "caution", "morning_check", "watch", "gaps"]);
  assert.equal(story.sections[0].heading_ja, "🌙 今日の市場をひとことで");
  assert.ok(story.char_count >= APP_STORY_TARGET_MIN_CHARS, `narrative ${story.char_count}`);
  const check = story.sections.find((item) => item.key === "morning_check")!;
  assert.equal(check.heading_ja, "☀️ 朝刊との答え合わせ");
  assert.equal(check.lines_ja[0], `朝刊の見立て：${v1Morning0930.headline_ja}`);
  assert.ok(check.lines_ja.some((line) => line.startsWith("朝刊で挙げた注目点：")));
  assert.ok(check.lines_ja.some((line) => line.startsWith("9月30日の東京市場の結果：日経平均 66,753.72（前日比+1.94%）")));
  // No morning packet, or one from another day: the section is simply absent.
  assert.ok(!buildAppMarketStory(packet).sections.some((item) => item.key === "morning_check"));
  assert.ok(!buildAppMarketStory(packet, v1Morning1001).sections.some((item) => item.key === "morning_check"));
});

test("a stored v1 packet still renders: the short X body and a story from its existing fields", () => {
  assert.equal(v1Morning1001.presentation_version, undefined);
  const post = formatSharedXPost(v1Morning1001);
  assert.ok(post.includes("\n📌 今日の注目ポイント\n") && post.includes("\n💬 ") && !post.includes("👀"));
  assert.deepEqual(sharedXPostIssues(v1Morning1001, post), [], "still postable");
  assert.ok(has(sharedXPostWarnings(v1Morning1001, post), "X_POST_SHORTER_THAN_TARGET"));
  const story = buildAppMarketStory(v1Morning1001);
  assert.equal(story.sections[0].body_ja, v1Morning1001.market_summary_ja);
  assert.ok(story.sections.some((item) => item.key === "japan" && item.lines_ja[0].startsWith("9月30日の東京市場（前営業日の終値）：日経平均 66,753.72")));
});

// ---------------------------------------------------------------------------------------------
// Hard facts: metric -> session date -> value
// ---------------------------------------------------------------------------------------------

/**
 * The exact 2026-10-01 regression: the report date is 10/1, the Nikkei value available is the 9/29
 * close (65,481.27, −0.60%) and the 1306 value is the 9/30 close (431.5, +1.43%).
 */
function mixedSessionInput() {
  const payload: MarketDataPacket = structuredClone(morning.data.payload);
  const nikkei = payload.metrics.find((metric) => metric.key === "nikkei225")!;
  Object.assign(nikkei, {
    session_date: "2026-09-29", value: 65481.2695, previous_close: 65877.6172, change: -396.3477, change_pct: -0.6,
    freshness: "stale", observed_at: "2026-09-29T06:45:02.000Z",
  });
  return inputOf(morning, { payload });
}

function withSummary(text: string, input = mixedSessionInput()): GeneratedAnalysis {
  const analysis = richMorning1001(input);
  // Keep only text that is true for this input: 1306 on 9/30 and the US session.
  analysis.headline_ja = "前夜の米国株はまちまち";
  analysis.market_summary_ja = text;
  analysis.claims = analysis.claims.filter((claim) => !["c1", "c5", "c6"].includes(claim.claim_id));
  analysis.x_post.lead_ja = "前夜の米国株はまちまちでした📊";
  analysis.x_post.points_ja[0] = "9月30日のTOPIX連動ETF（1306）は431.5円（前日比+1.43%）";
  analysis.app_story!.summary_ja = "前夜の米国市場は指数によって方向が分かれました。";
  analysis.app_story!.japan_ja = "9月30日のTOPIX連動ETF（1306）は431.5円（前日比+1.43%）でした。";
  return analysis;
}

test("mixed session: the 10/1 wording that showed the 9/29 Nikkei under 9月30日 is a hard reject", () => {
  const input = mixedSessionInput();
  const nikkei = input.metricFacts.find((fact) => fact.key === "nikkei225")!;
  assert.deepEqual([nikkei.sessionDate, nikkei.valueDisplay, nikkei.changeDisplay, nikkei.freshness], ["2026-09-29", "65,481.27", "−0.60%", "stale"]);
  const blocked = [
    "9月30日は日経平均65,481.27（-0.60%）、1306は431.5（+1.43%）でした。",
    // The legacy app text delivered on 2026-10-01.
    "9月30日（水）は日経平均が65,481.27で-0.60%、TOPIX連動ETF（1306）が431.5で+1.43%と、入力された指数の動きは分かれました。",
    "9月30日の東京市場は、日経平均が65,481.27（前日比−0.60%）、TOPIX連動ETF（1306）が431.5円（前日比+1.43%）でした。",
    "9月30日の日経平均は65,481.27でした。",
  ];
  for (const text of blocked) {
    const issues = hardOf(withSummary(text, input), input);
    assert.ok(has(issues, "日付と指標の不一致（日経平均は9月29日の値、本文は9月30日）"), `${text} → ${issues.join(" / ")}`);
  }
});

test("mixed session: each value under its own date, or the unconfirmed value left out, is allowed", () => {
  const input = mixedSessionInput();
  const allowed = [
    "9月29日の日経平均は65,481.27（前日比−0.60%）、9月30日のTOPIX連動ETF（1306）は431.5円（前日比+1.43%）でした。",
    "日経平均は9月29日時点で65,481.27でした。9月30日のTOPIX連動ETF（1306）は431.5円（前日比+1.43%）です。",
    "9月30日のTOPIX連動ETF（1306）は431.5円（前日比+1.43%）でした。日経平均の9月30日の終値は確認できていません。",
  ];
  for (const text of allowed) assert.deepEqual(hardOf(withSummary(text, input), input), [], text);
});

test("mixed session: the app's fact lines print each value under the date of its own metric", () => {
  const input = mixedSessionInput();
  const packet = packetOf(withSummary("9月30日のTOPIX連動ETF（1306）は431.5円（前日比+1.43%）でした。", input), input);
  const japan = buildAppMarketStory(packet).sections.find((item) => item.key === "japan")!;
  assert.deepEqual(japan.lines_ja.slice(0, 2), [
    "9月29日の東京市場（前営業日の終値）：日経平均 65,481.27（前日比−0.60%）（9月29日時点・最新ではありません）",
    "9月30日の東京市場（前営業日の終値）：TOPIX連動ETF（1306） 431.5円（前日比+1.43%）",
  ]);
  for (const line of buildAppMarketStory(packet).sections.flatMap((item) => item.lines_ja)) {
    assert.ok(!(line.includes("65,481.27") && line.includes("9月30日")), line);
  }
  // The stale Nikkei is not part of the Tokyo direction: only the fresh 9/30 metric decides it.
  assert.deepEqual(packet.session_views!.find((view) => view.market === "tokyo"), { market: "tokyo", session_date: "2026-09-30", direction: "up", basis: ["topix_proxy_1306"] });
});

test("a reused metric keeps the session date of the packet it came from", () => {
  const nikkei = morning.data.payload.metrics.find((metric) => metric.key === "nikkei225")!;
  assert.equal(nikkei.provider, "market_data_packet", "the 10/1 morning Nikkei was reused from the 9/30 close packet");
  const fact = inputOf(morning).metricFacts.find((item) => item.key === "nikkei225")!;
  assert.deepEqual([fact.sessionDate, fact.dateJa, fact.valueDisplay], ["2026-09-30", "9月30日", "66,753.72"]);
  assert.ok(has(hardOf(withSummary("10月1日の日経平均は66,753.72（前日比+1.94%）でした。", inputOf(morning))), "日付と指標の不一致（日経平均は9月30日の値、本文は10月1日）"));
});

test("hard facts: wrong value for a metric, direction inversion, 1306 as TOPIX, unsupported cause, stale as fresh", () => {
  const input = inputOf(morning);
  const cases: Array<[string, string]> = [
    ["指標と数値の不一致（日経平均の値ではない数値 431.5）", "9月30日の日経平均は431.5（前日比+1.43%）でした。"],
    ["入力に無い数値: 65,481.27", "9月30日の日経平均は65,481.27でした。"],
    ["方向の逆転（日経平均は前日比+1.94%）", "9月30日の日経平均は下落しました。"],
    ["方向の逆転（前日比の符号が逆）", "9月30日の日経平均は66,753.72（前日比−1.94%）でした。"],
    ["方向の逆転（NYダウは前日比−0.86%）", "9月30日のNYダウは上昇しました。"],
    ["絵文字の向きがデータと逆", "9月30日の日経平均は66,753.72でした📉"],
    ["TOPIX連動ETF（1306）をTOPIXと表記", "9月30日は日経平均とTOPIXがそろって上昇しました。"],
    ["根拠の無い因果の断定", "9月30日の東京市場は米国株高を受けて上昇しました。"],
    ["古い値を日付なしで記載（日本国債10年利回りは8月31日時点）", "日本国債10年利回りは2.943%です。"],
    ["日付と指標の不一致（日本国債10年利回りは8月31日の値、本文は9月30日）", "9月30日の日本国債10年利回りは2.943%です。"],
  ];
  for (const [expected, text] of cases) {
    const issues = hardOf(withSummary(text, input), input);
    assert.ok(has(issues, expected), `${expected} not detected in "${text}": ${issues.join(" / ")}`);
  }
  // Honest statements of the same facts stay allowed.
  for (const text of [
    "日本国債10年利回りは8月31日時点で2.943%です。",
    "9月30日の東京市場の上昇理由を説明するニュースは確認できません。",
    "9月30日のNYダウは50,906.05（前日比−0.86%）と下落し、ナスダック総合は26,861.06（前日比+0.24%）と上昇しました。",
  ]) {
    assert.deepEqual(hardOf(withSummary(text, input), input), [], text);
  }
});

test("names that only look like a market word are not read as that market", () => {
  const input = inputOf(morning); // Tokyo up on 9/30, US mixed
  // Company and instrument names: the Tokyo / US / Nikkei guards must not fire on them.
  for (const text of [
    "東京エレクトロンは下落したと報じられました。",
    "東京海上は下落、東京電力も下げました。",
    "欧米株は下落したと伝えられました。",
    "日経平均先物は確認できる取得元がないため載せていません。",
  ]) {
    assert.deepEqual(hardOf(withSummary(text, input), input), [], text);
  }
  // The bare market words are still checked.
  assert.ok(has(hardOf(withSummary("東京は下落しました。", input), input), "方向の逆転"));
  assert.ok(has(hardOf(withSummary("9月30日の東京市場は下落しました。", input), input), "方向の逆転"));
});

// ---------------------------------------------------------------------------------------------
// Editorial priority and delivery policy
// ---------------------------------------------------------------------------------------------

test("news is ordered by reach, not severity alone: broad-market items precede one company's disclosure", () => {
  const input = inputOf(morning);
  const scopes = input.news.map((item) => item.scope);
  assert.deepEqual(scopes.slice(0, 5), ["broad", "broad", "broad", "broad", "broad"]);
  assert.ok(scopes.indexOf("company") > scopes.lastIndexOf("broad"), "no company item ahead of a broad item");
  const nidec = input.news.find((item) => item.company?.includes("ニデック") && item.headline_ja.includes("減損損失"))!;
  assert.deepEqual([nidec.severity, nidec.scope, isMajorNews(nidec)], ["critical", "company", false], "a critical company notice is not a must-surface market item");
  const instructions = String(generationRequestBody(input, []).instructions);
  assert.ok(instructions.includes("範囲が「市場全体」のニュース") && instructions.includes("「個別企業」の開示は"));
  const listed = (input.modelInput as { ニュース: Array<{ 範囲: string }> }).ニュース.map((item) => item.範囲);
  assert.deepEqual(listed.slice(0, 5), Array(5).fill("市場全体"));
});

test("10/1 replay: the packet that led with one company's impairment is reordered and flagged", () => {
  const input = inputOf(morning);
  const p = v1Morning1001;
  assert.ok(p.key_news[0].headline_ja.includes("減損損失"), "production listed the Nidec notice first");
  const replay: GeneratedAnalysis = {
    headline_ja: p.headline_ja, market_summary_ja: p.market_summary_ja, claims: p.claims,
    key_news: p.key_news.map((news) => ({ ref: news.ref_id, why_it_matters_ja: news.why_it_matters_ja })),
    strong_themes: p.strong_themes, weak_themes: p.weak_themes, next_watch_ja: p.next_watch_ja, risks_ja: p.risks_ja, x_post: p.x_post,
  };
  const check = localAnalysisCheck(replay, input);
  assert.deepEqual(check.hard, [], "its facts were right");
  // The digest told the Nidec notice and none of the five broad items available that morning.
  assert.ok(has(check.warnings, "X本文が個別企業の開示だけを扱い、市場全体のニュースに触れていない"), check.warnings.join(" / "));
  const ordered = assemblePacket(input, replay, { generatedAt: NOW(), attempts: 1 }).key_news;
  assert.deepEqual(ordered.map((news) => news.scope), ["broad", "broad", "broad", "company"]);
  assert.ok(ordered[3].headline_ja.includes("減損損失"), "the company notice is kept, after the market-wide items");
  // The v2 story lists market-wide items first and names the company only after them.
  const rich = richMorning1001(input);
  assert.deepEqual(localAnalysisCheck(rich, input).warnings, []);
  const news = buildAppMarketStory(packetOf(rich, input)).sections.find((item) => item.key === "news")!;
  assert.ok(news.lines_ja[0].startsWith("トランプ氏、AI企業と自主協定を発表") && news.lines_ja[3].includes("減損損失"));
  assert.ok(!formatSharedXPost(packetOf(rich, input)).includes("ニデック"));
});

test("an unscoped 'no material' claim is a hard reject while the input holds news; a scoped one is allowed", () => {
  const input = inputOf(morning);
  assert.ok(input.news.length > 0);
  for (const text of ["目立った材料はありません。", "きょうは材料がない一日でした。", "ニュースは特にありませんでした。", "入力には個別材料が含まれていません。"]) {
    const analysis = richMorning1001(input);
    analysis.x_post.closing_ja = text;
    assert.ok(has(hardOf(analysis, input), "範囲を示さない「材料なし」の断定"), text);
  }
  for (const text of [
    "東京市場の値動きの理由を説明するニュースは確認できません。",
    "日銀に関するニュースはありません。",
    "上昇の理由ははっきりしていません。",
  ]) {
    const analysis = richMorning1001(input);
    analysis.x_post.closing_ja = text;
    assert.deepEqual(hardOf(analysis, input), [], text);
  }
  // With no news in the input the same sentence is simply true.
  const empty = inputOf(morning, { news: [] });
  const quiet = sparse(richMorning1001(inputOf(morning)));
  quiet.claims = quiet.claims.filter((claim) => !claim.evidence_refs.some((ref) => ref.startsWith("news:")));
  quiet.key_news = [];
  quiet.x_post.points_ja[2] = "9月30日のTOPIX連動ETF（1306）は431.5円（前日比+1.43%）";
  quiet.x_post.closing_ja = "目立った材料はありません。";
  assert.deepEqual(localAnalysisCheck(quiet, empty).hard, []);
});

test("morning: Tokyo's previous session and the overnight US session stay distinct under a 'mixed' label", () => {
  const input = inputOf(morning);
  assert.equal(input.direction, "mixed", "the top-level morning label follows the US indices");
  assert.deepEqual(input.sessionViews, [
    { market: "tokyo", session_date: "2026-09-30", direction: "up", basis: ["nikkei225", "topix_proxy_1306"] },
    { market: "us", session_date: "2026-09-30", direction: "mixed", basis: ["dow", "sp500", "nasdaq_composite"] },
  ]);
  const model = input.modelInput as Record<string, unknown>;
  assert.deepEqual([model.東京市場の方向, model.米国市場の方向], ["9月30日は上昇", "9月30日はまちまち"]);
  assert.ok(String(generationRequestBody(input, []).instructions).includes("前営業日の東京市場と前夜の米国市場を別々に書き"));
  const story = buildAppMarketStory(packetOf(richMorning1001(input), input));
  const lines = (key: string) => story.sections.find((item) => item.key === key)!.lines_ja;
  assert.ok(lines("japan").includes("9月30日の東京市場の方向：上昇"));
  assert.ok(lines("overseas").includes("9月30日の米国市場の方向：まちまち"));
  assert.ok(lines("japan")[0].startsWith("9月30日の東京市場（前営業日の終値）："), "never presented as today's move");
});

test("content regeneration is recorded apart from transport retry (the 10/1 morning shape)", async () => {
  const input = inputOf(morning);
  const bad = richMorning1001(input);
  bad.headline_ja = "日経平均とTOPIXがそろって上昇";
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: bad },
    { step: "generate", payload: richMorning1001(input) },
    { step: "fact", payload: { passed: true, issues: [] } },
  ], calls), NOW);
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, ["generate", "generate", "fact"]);
  assert.deepEqual(outcome.trace, { generations: 2, hardRejections: ["local"], rejectionReasons: ["1306"], qualityRewrite: false, deliveredGeneration: 2, warnings: [] });
  assert.deepEqual(generationDiagnostics(outcome.trace), {
    generation_attempts: "2", content_regenerations: "1", hard_rejections: "local", rejection_reasons: "1306", quality_rewrite: "false",
    delivered_generation: "2", quality_warnings: "", quality_rewrite_request_failed: "false",
  });
  assert.equal(outcome.ok && outcome.packet.fact.generation_attempts, 2);
});

test("a quality rewrite that breaks a hard fact falls back to the safe original instead of failing the cycle", async () => {
  const input = inputOf(morning);
  const thin = sparse(richMorning1001(input));
  const broken = richMorning1001(input);
  broken.x_post.context_ja = "9月30日の東京市場は米国株高を受けて上昇しました。";
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: thin }, { step: "fact", payload: { passed: true, issues: [] } },
    { step: "generate", payload: broken },
  ], calls), NOW);
  assert.equal(outcome.ok, true, "the hard-fact-safe draft is delivered");
  assert.deepEqual(calls, ["generate", "fact", "generate"]);
  assert.deepEqual([outcome.trace.qualityRewrite, outcome.trace.deliveredGeneration, outcome.trace.hardRejections], [true, 1, ["local"]]);
  assert.equal(outcome.ok && outcome.packet.x_post.context_ja, "");

  // A better rewrite replaces the thin original.
  const better = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: thin }, { step: "fact", payload: { passed: true, issues: [] } },
    { step: "generate", payload: richMorning1001(input) }, { step: "fact", payload: { passed: true, issues: [] } },
  ]), NOW);
  assert.deepEqual(better.ok && [better.trace.deliveredGeneration, better.packet.fact.quality_warnings], [2, []]);
  // A hard-fact failure with no safe draft still fails closed.
  const failed = await generateSharedAnalysis(input, requester([{ step: "generate", payload: broken }, { step: "generate", payload: broken }]), NOW);
  assert.deepEqual([failed.ok, !failed.ok && failed.error], [false, "ANALYSIS_LOCAL_CHECK_FAILED"]);
});

// ---------------------------------------------------------------------------------------------
// One fact spine, privacy, handler diagnostics
// ---------------------------------------------------------------------------------------------

test("X and the app read one packet: same hash, and no number that is not in the shared input", async () => {
  const input = inputOf(close);
  const packet = packetOf(richClose0930(input), input);
  const hash = await reportContentHash(packet);
  const post = formatSharedXPost(packet);
  const story = appStoryText(buildAppMarketStory(packet, v1Morning0930));
  assert.equal(await reportContentHash(JSON.parse(JSON.stringify(packet))), hash, "both consumers see the same content hash");
  const allowed = new Set(JSON.stringify([input.modelInput, v1Morning0930.headline_ja, v1Morning0930.next_watch_ja]).match(/\d+(?:,\d{3})*(?:\.\d+)?/g)!
    .flatMap((token) => [token, token.replace(/,/g, ""), token.replace(/\.?0+$/, "")]));
  for (const text of [post, story]) {
    for (const token of text.normalize("NFKC").match(/\d+(?:,\d{3})*\.\d+/g) ?? []) assert.ok(allowed.has(token), `number not from the shared input: ${token}`);
  }
  // The story's metric lines come from packet.major_moves, the same values X cites.
  assert.ok(story.includes("日経平均 66,753.72（前日比+1.94%）") && post.includes("9月30日の日経平均は66,753.72（前日比+1.94%）"));
});

test("the shared packet and story hold no user or portfolio data", () => {
  const input = inputOf(morning);
  const packet = packetOf(richMorning1001(input), input);
  const serialized = JSON.stringify([input.modelInput, packet, buildAppMarketStory(packet)]);
  // Field names and words that only exist in the per-user layer (a news text may say 「保有していた株式」).
  for (const forbidden of ["user_id", "portfolio", "holding", "保有銘柄", "保有株", "average_price", "quantity", "評価額", "損益", "マイポート"]) {
    assert.ok(!serialized.includes(forbidden), `shared content must not carry ${forbidden}`);
  }
});

test("handler: a locally rejected first draft is content regeneration (transport_retries stays 0), one packet", async () => {
  const SUPABASE = "https://project-ref.supabase.co";
  const SECRET = "cron-secret-for-tests";
  const input = inputOf(morning);
  const bad = richMorning1001(input);
  bad.headline_ja = "日経平均とTOPIXがそろって上昇";
  const drafts = [bad, richMorning1001(input)];
  const rpc: Array<{ name: string; body: Record<string, unknown> }> = [];
  const waits: number[] = [];
  const json = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
  const fetchMock: typeof fetch = (request, init) => {
    const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (url === "https://api.openai.com/v1/responses") {
      const payload = String(body?.instructions).includes("Factチェッカー") ? { passed: true, issues: [] } : drafts.shift();
      return json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }], usage: { input_tokens: 9000, output_tokens: 3000 } });
    }
    const path = url.slice(`${SUPABASE}/rest/v1/`.length);
    if (path.startsWith("market_holidays")) return json([]);
    if (path.startsWith("rpc/")) {
      rpc.push({ name: path.slice(4), body });
      if (path === "rpc/claim_market_report_analysis") {
        return json([{ cycle_id: "11111111-1111-4111-8111-111111111111", claim_token: "22222222-2222-4222-8222-222222222222", attempt: 1, outcome: "claimed", data_packet_id: morning.data.id }]);
      }
      return json("33333333-3333-4333-8333-333333333333");
    }
    if (path.startsWith("market_data_packets")) return json([{ id: morning.data.id, content_hash: morning.data.content_hash, payload: morning.data.payload, data_quality_status: "partial" }]);
    if (path.startsWith("important_news_candidates")) return json(morning.news);
    return Promise.reject(new Error(`UNEXPECTED:${url}`));
  };
  const deps: Deps = {
    env: (name) => ({ SUPABASE_URL: SUPABASE, SUPABASE_SECRET_KEYS: JSON.stringify({ default: "service-secret" }), SEND_PUSH_NOTIFICATIONS_CRON_SECRET: SECRET, OPENAI_API_KEY: "openai-test-key" } as Record<string, string>)[name],
    fetch: fetchMock,
    now: () => new Date("2026-09-30T22:55:00Z"),
    sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
  };
  const response = await handleRequest(new Request("https://functions.local/market-report-analysis", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Cron-Secret": SECRET }, body: JSON.stringify({ mode: "morning" }),
  }), deps);
  assert.equal((await response.json()).status, "completed");
  assert.deepEqual(rpc.map((call) => call.name), ["claim_market_report_analysis", "complete_market_report_analysis"], "one claim, one packet");
  const completed = rpc[1].body;
  const diagnostics = completed.p_diagnostics as Record<string, string>;
  assert.deepEqual(
    [diagnostics.generation_attempts, diagnostics.content_regenerations, diagnostics.hard_rejections, diagnostics.transport_retries],
    ["2", "1", "local", "0"],
  );
  assert.deepEqual(waits, [], "no transport wait");
  const payload = completed.p_payload as MarketReportPacket;
  assert.equal(payload.schema_version, "market_report_packet.v1");
  assert.equal(payload.presentation_version, PRESENTATION_VERSION);
  assert.equal(completed.p_generation_calls, 3);
});
