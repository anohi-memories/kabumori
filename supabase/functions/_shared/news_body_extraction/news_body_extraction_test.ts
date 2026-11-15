// Phase 6 offline extraction: synthetic fixtures only (fictional companies and figures; the layout mirrors what the PDF
// text extractor produces for a 決算短信 / a BOJ notice / a Federal Reserve statement page). No real document text is
// stored in the repository.
import assert from "node:assert/strict";
import test from "node:test";
import { assessBodyText, collapseCjkSpacing } from "./body_quality.ts";
import { buildBojBody, BOJ_BODY_MAX_CHARS, classifyBojDocumentUrl, extractBojHtmlMainText } from "./boj_document_text.ts";
import {
  classifyFedMonetaryTitle,
  extractFomcStatementFacts,
  parseFedRatePercent,
  renderFomcStatementSummary,
} from "./fomc_statement_facts.ts";
import { assessKessanBody, extractKessanTankiFacts, renderKessanFactsSummary } from "./kessan_tanshin_facts.ts";

// ------------------------------------------------------------ 決算短信

const Q3 = [
  "2026年11月期 第３四半期決算短信〔日本基準〕(連結)",
  "2026年10月９日",
  "上 場 会 社 名 テスト商事株式会社 上場取引所 東",
  "(百万円未満切捨て)",
  "１．2026年11月期第３四半期の連結業績（2025年12月１日～2026年８月31日）",
  "（１）連結経営成績(累計) (％表示は、対前年同四半期増減率)",
  "売上高 営業利益 経常利益 親会社株主に帰属",
  "する四半期純利益",
  "百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％",
  "2026年11月期第３四半期 12,782 23.9 2,939 86.3 2,308 149.5 2,554 287.2",
  "2025年11月期第３四半期 10,314 30.4 1,577 37.3 925 25.8 659 31.4",
  "(注) 包括利益 2026年11月期第３四半期 2,563百万円( 211.2％) 2025年11月期第３四半期 823百万円( 53.7％)",
  "１株当たり",
  "四半期純利益",
  "円 銭 円 銭",
  "2026年11月期第３四半期 182.12 －",
  "2025年11月期第３四半期 47.04 －",
  "２．配当の状況",
  "３．2026年11月期の連結業績予想（2025年12月１日～2026年11月30日）",
  "(％表示は、対前期増減率)",
  "売上高 営業利益 経常利益 親会社株主に帰属",
  "する当期純利益",
  "１株当たり",
  "当期純利益",
  "百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％ 円 銭",
  "通期 17,730 △7.0 4,150 △21.6 2,920 △34.1 2,620 49.7 186.82",
].join("\n");

test("kessan: the current period row and the prior period row are read apart, with units, sign and basis", () => {
  const facts = extractKessanTankiFacts(Q3);
  assert.equal(facts.ok, true, facts.issues.join(","));
  assert.equal(facts.results?.basis, "consolidated");
  assert.equal(facts.results?.unit, "百万円");
  assert.equal(facts.currentRow?.label, "2026年11月期第3四半期");
  assert.deepEqual(facts.currentRow?.values.map((v) => [v.metric, v.amount, v.changePct]), [
    ["sales", "12,782", "23.9"], ["operating_profit", "2,939", "86.3"], ["ordinary_profit", "2,308", "149.5"], ["net_profit", "2,554", "287.2"],
  ]);
  assert.equal(facts.priorRow?.label, "2025年11月期第3四半期");
  assert.equal(facts.priorRow?.values[0].amount, "10,314");
  assert.notEqual(facts.currentRow?.values[0].amount, facts.priorRow?.values[0].amount);
  assert.equal(facts.forecast?.rows[0].label, "通期");
  assert.deepEqual(facts.forecast?.rows[0].values.map((v) => [v.amount, v.changePct]), [["17,730", "-7.0"], ["4,150", "-21.6"], ["2,920", "-34.1"], ["2,620", "49.7"]]);
});

test("kessan: the rendered summary carries the current row first and never mixes it with the prior row", () => {
  const summary = renderKessanFactsSummary(extractKessanTankiFacts(Q3)) ?? "";
  const lines = summary.split("\n");
  assert.match(lines[0], /連結経営成績（百万円/);
  assert.match(lines[1], /^当期 2026年11月期第3四半期: 売上高12,782百万円（前年同期比\+23\.9%）、営業利益2,939百万円（前年同期比\+86\.3%）/);
  assert.match(lines[2], /^前期 2025年11月期第3四半期: 売上高10,314百万円/);
  assert.match(summary, /予想 連結通期: 売上高17,730百万円（前年同期比-7\.0%）/);
});

test("kessan: loss / negative values keep their sign (△ ▲ -), dashes become 'no value'", () => {
  const text = [
    "２０２７年２月期 中間期決算短信〔日本基準〕（連結）",
    "（１）連結経営成績(累計)",
    "売上高 営業利益 経常利益 親会社株主に帰属",
    "する中間純利益",
    "百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％",
    "2027年2月期中間期 8,552 － △757 － ▲709 － -182 －",
    "2026年2月期中間期 7,010 12.0 △120 － △100 － △90 －",
  ].join("\n");
  const facts = extractKessanTankiFacts(text);
  assert.equal(facts.ok, true, facts.issues.join(","));
  assert.deepEqual(facts.currentRow?.values.map((v) => v.amount), ["8,552", "-757", "-709", "-182"]);
  assert.deepEqual(facts.currentRow?.values.map((v) => v.changePct), [null, null, null, null]);
  assert.match(renderKessanFactsSummary(facts) ?? "", /営業利益-757百万円/);
});

test("kessan: header names that wrap across lines are still four columns (no silent column loss)", () => {
  const facts = extractKessanTankiFacts(Q3);
  assert.deepEqual(facts.results?.metrics, ["sales", "operating_profit", "ordinary_profit", "net_profit"]);
});

test("kessan: a ratio / per-share table that mentions 売上高 and 営業利益 is not mistaken for the results", () => {
  const text = [
    "（１）連結経営成績",
    "売上高 営業利益 経常利益 親会社株主に帰属する",
    "当期純利益",
    "百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％",
    "2026年8月期 64,504 4.8 1,645 15.9 1,702 19.1 1,140 31.0",
    "2025年8月期 61,578 0.5 1,419 13.8 1,429 16.4 870 △3.7",
    "自己資本当期純利益率 総資産経常利益率 売上高営業利益率",
    "％ ％ ％",
    "2026年8月期 85.98 - 8.5 6.4 2.6",
    "2025年8月期 66.00 - 6.8 4.9 2.3",
  ].join("\n");
  const facts = extractKessanTankiFacts(text);
  assert.equal(facts.ok, true, facts.issues.join(","));
  assert.equal(facts.currentRow?.values[0].amount, "64,504");
});

test("kessan: fail closed — wrong column count, prior-year mismatch, no table, no unit are never turned into numbers", () => {
  const wrongCount = Q3.replace("2026年11月期第３四半期 12,782 23.9 2,939 86.3 2,308 149.5 2,554 287.2", "2026年11月期第３四半期 12,782 23.9 2,939");
  const a = extractKessanTankiFacts(wrongCount);
  assert.equal(a.ok, false);
  assert.ok(a.issues.some((issue) => issue.startsWith("TOKEN_COUNT_MISMATCH")));
  assert.equal(renderKessanFactsSummary(a), null);

  const extra = Q3.replace("2,554 287.2", "2,554 287.2 9,999 1.0");
  assert.equal(extractKessanTankiFacts(extra).ok, false, "surplus tokens mean a column was not recognised");

  const yearGap = Q3.replace("2025年11月期第３四半期 10,314", "2023年11月期第３四半期 10,314");
  assert.ok(extractKessanTankiFacts(yearGap).issues.includes("PRIOR_ROW_YEAR_MISMATCH"));

  assert.equal(extractKessanTankiFacts("本文のみで表はありません。").ok, false);
  assert.ok(extractKessanTankiFacts("本文のみで表はありません。").issues.includes("NO_RESULTS_TABLE"));
});

test("kessan: a table-less document falls back to the document's own results sentence, flagged prose_only", () => {
  const prose = [
    "２０２７年５月期 第１四半期決算短信",
    "当第１四半期連結会計期間の業績は、売上高3,069百万円（前年同四半期比16.5％減）、営業損失54百万円（前年同期は68百万円の営業利益）、",
    "経常損失61百万円（前年同期は63百万円の経常利益）、親会社株主に帰属する四半期純損失36百万円となりました。",
  ].join("\n");
  const assessed = assessKessanBody(prose, "（一般要約）");
  assert.equal(assessed.status, "prose_only");
  assert.match(assessed.body ?? "", /売上高3,069百万円\(前年同四半期比16\.5%減\)、営業損失54百万円/);
  assert.equal(assessKessanBody("表も本文の業績記述もない文書です。", null).status, "missing");
  assert.equal(assessKessanBody("表も本文の業績記述もない文書です。", null).body, null);
});

test("kessan: facts come first and survive the 6,000 character cap even when the generic summary is long", () => {
  const generic = "配当に関する一般要約。".repeat(900);
  const assessed = assessKessanBody(Q3, generic, 6000);
  assert.equal(assessed.status, "complete");
  assert.ok((assessed.body ?? "").length <= 6000);
  assert.match((assessed.body ?? "").split("\n")[1], /^当期 2026年11月期第3四半期: 売上高12,782百万円/);
});

test("kessan: standalone (個別) results are labelled as such, not as consolidated", () => {
  const text = Q3.replace("（１）連結経営成績(累計)", "（１）個別経営成績(累計)").replace("(連結)", "(非連結)").replace("の連結業績", "の個別業績").replace("３．2026年11月期の連結業績予想", "３．2026年11月期の個別業績予想");
  const facts = extractKessanTankiFacts(text);
  assert.equal(facts.results?.basis, "standalone");
  assert.match(renderKessanFactsSummary(facts) ?? "", /個別経営成績/);
});

// ------------------------------------------------------------ 日銀

test("BOJ: only boj.or.jp links are allowed; kind is taken from the path", () => {
  assert.deepEqual(classifyBojDocumentUrl("http://www.boj.or.jp/mopo/mpmdeci/mpr_2026/mpr261009a.pdf"), { kind: "pdf", allowed: true, reason: "ok" });
  assert.equal(classifyBojDocumentUrl("https://www.boj.or.jp/research/brp/rer/rer261008.htm").kind, "html");
  assert.equal(classifyBojDocumentUrl("https://www.boj.or.jp/statistics/other/toukai/toukai.xlsx").kind, "spreadsheet");
  assert.equal(classifyBojDocumentUrl("https://boj.or.jp.evil.example/a.pdf").allowed, false);
  assert.equal(classifyBojDocumentUrl("https://evil-boj.or.jp/a.pdf").allowed, false);
  assert.equal(classifyBojDocumentUrl("ftp://www.boj.or.jp/a.pdf").reason, "not_http");
  assert.equal(classifyBojDocumentUrl("not a url").reason, "malformed");
});

test("BOJ: CJK-spaced PDF text is normalised and kept; important figures stay intact", () => {
  const spaced = "２ ０ ２６ 年 １ ０ 月 ９ 日\n日 本 銀 行\n政 策 金 利 を ０ . ７ ５ ％ 程 度 で 推 移 す る よ う 促 す こ と と し た 。\n全 員 一 致 で 決 定 し た 。";
  const collapsed = collapseCjkSpacing(spaced);
  assert.match(collapsed, /2026年10月9日/);
  const body = buildBojBody(spaced, "pdf");
  assert.equal(body.status, "usable");
  assert.match(body.body ?? "", /政策金利を0\.75%程度で推移するよう促すこととした。/);
});

test("BOJ: empty, garbled, too short, non-Japanese and non-text documents are 'unusable', never an empty body", () => {
  assert.equal(buildBojBody("", "pdf").status, "unusable");
  assert.equal(buildBojBody("", "pdf").reason, "empty");
  assert.equal(buildBojBody(null, "pdf").body, null);
  assert.equal(buildBojBody("������������������������������������������", "pdf").reason, "garbled");
  assert.equal(buildBojBody("短い。", "html").reason, "too_short");
  assert.equal(buildBojBody("This is an English page about nothing in particular, long enough to pass the length check.", "html").reason, "no_japanese");
  assert.equal(buildBojBody("日本銀行の本文", "spreadsheet").reason, "not_a_text_document");
});

test("BOJ: HTML main text drops head / script / navigation and keeps the content block", () => {
  const html = "<html><head><title>x</title><script>var a=1;</script></head><body><nav>メニュー</nav><div id=\"contents\"><h1>地域経済報告</h1><p>各地域の景気は、緩やかに回復している。各支店からの報告では、個人消費は底堅く推移している。</p></div><footer>著作権</footer></body></html>";
  const text = extractBojHtmlMainText(html);
  assert.match(text, /各地域の景気は、緩やかに回復している。/);
  assert.doesNotMatch(text, /メニュー|著作権|var a/);
  assert.equal(buildBojBody(text, "html").status, "usable");
});

test("BOJ: the bounded body never cuts a line and stays under the cap", () => {
  const line = "金融政策決定会合では、物価と経済の見通しを踏まえて政策を決定した。";
  const body = buildBojBody(Array.from({ length: 400 }, () => line).join("\n"), "pdf");
  assert.equal(body.status, "usable");
  assert.ok((body.body ?? "").length <= BOJ_BODY_MAX_CHARS);
  assert.ok((body.body ?? "").split("\n").every((l) => l === line));
});

// ------------------------------------------------------------ FOMC

const STATEMENT = (decision: string, votes: string) =>
  `<html><head><title>Federal Reserve Board - Federal Reserve issues FOMC statement</title></head><body><div id="article"><div class="heading"><p class="article__time">September 16, 2026</p><h3>Federal Reserve issues FOMC statement</h3><p>For release at 2:00 p.m. EDT</p><div class="share">Share</div></div><div class="col-xs-12 col-sm-8"><p>${decision}</p><p>Economic activity is expanding at a solid pace.</p><p>${votes}</p></div></div><div id="footer">Last Update: September 16, 2026</div></body></html>`;

test("FOMC: a rate increase is read with change size, target range and vote", () => {
  const html = STATEMENT(
    "The Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent, in support of the Federal Reserve's dual mandate.",
    "Voting for the monetary policy action were Alpha One, Beta Two, and Gamma Three. Voting against this action was Delta Four, who preferred to maintain the target range. The vote was by a 11 – 1 vote.",
  );
  const facts = extractFomcStatementFacts(html);
  assert.equal(facts.ok, true, facts.issues.join(","));
  assert.equal(facts.action, "raise");
  assert.equal(facts.changeBp, 25);
  assert.equal(facts.rangeLowerPct, 3.75);
  assert.equal(facts.rangeUpperPct, 4);
  assert.equal(facts.releaseDate, "September 16, 2026");
  assert.equal(facts.votesFor, 11);
  assert.equal(facts.votesAgainst, 1);
  assert.deepEqual(facts.dissenters, ["Delta Four"]);
  const summary = renderFomcStatementSummary(facts, "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm") ?? "";
  assert.match(summary, /3\.75〜4%（引き上げ、25bp引き上げ）/);
  assert.match(summary, /反対1/);
});

test("FOMC: lower, maintain (unchanged) and basis-point wording", () => {
  const lower = extractFomcStatementFacts(STATEMENT("The Committee decided to lower the target range for the federal funds rate by 1/2 percentage point to 4 to 4-1/4 percent.", "The action was approved by a 12 – 0 vote."));
  assert.equal(lower.action, "lower");
  assert.equal(lower.changeBp, 50);
  assert.deepEqual([lower.rangeLowerPct, lower.rangeUpperPct], [4, 4.25]);
  const hold = extractFomcStatementFacts(STATEMENT("The Committee decided to maintain the target range for the federal funds rate at 4-1/4 to 4-1/2 percent.", "The action was approved by unanimous vote."));
  assert.equal(hold.action, "maintain");
  assert.equal(hold.changeBp, 0);
  assert.equal(hold.votesAgainst, 0);
  assert.match(renderFomcStatementSummary(hold) ?? "", /据え置き、変更なし/);
  const bp = extractFomcStatementFacts(STATEMENT("The Committee decided to raise the target range for the federal funds rate by 25 basis points to 3.75 to 4.00 percent.", "By a 12 – 0 vote."));
  assert.equal(bp.changeBp, 25);
  assert.equal(bp.rangeLowerPct, 3.75);
});

test("FOMC: anything without a decision and a range is not ok — no numbers are invented", () => {
  const minutes = extractFomcStatementFacts("<div id=\"article\"><p>Minutes of the Federal Open Market Committee, September 15-16, 2026. Participants noted that inflation remained elevated.</p></div>");
  assert.equal(minutes.ok, false);
  assert.equal(renderFomcStatementSummary(minutes), null);
  const noRange = extractFomcStatementFacts(STATEMENT("The Committee decided to raise the target range for the federal funds rate.", "By a 12 – 0 vote."));
  assert.equal(noRange.ok, false);
  assert.ok(noRange.issues.includes("NO_TARGET_RANGE"));
  const noSize = extractFomcStatementFacts(STATEMENT("The Committee decided to raise the target range to 3-3/4 to 4 percent.", "By a 12 – 0 vote."));
  assert.ok(noSize.issues.includes("CHANGE_SIZE_UNKNOWN"));
});

test("FOMC: title classification and rate parsing", () => {
  assert.equal(classifyFedMonetaryTitle("Federal Reserve issues FOMC statement"), "statement");
  assert.equal(classifyFedMonetaryTitle("Minutes of the Federal Open Market Committee, July 28–29, 2026"), "minutes");
  assert.equal(classifyFedMonetaryTitle("Federal Reserve Board and Federal Open Market Committee release economic projections"), "projections");
  assert.equal(classifyFedMonetaryTitle("Federal Reserve Board announces implementation note"), "implementation_note");
  assert.equal(parseFedRatePercent("3-3/4"), 3.75);
  assert.equal(parseFedRatePercent("1/4"), 0.25);
  assert.equal(parseFedRatePercent("4"), 4);
  assert.equal(parseFedRatePercent("abc"), null);
});

// ------------------------------------------------------------ shared quality gate

test("quality gate: boilerplate-only and NUL / replacement characters are not a body", () => {
  assert.equal(assessBodyText("ホーム\n印刷\nPrint", { minChars: 5 }).reason, "only_boilerplate");
  assert.equal(assessBodyText("a\u0000b".repeat(3), { minChars: 3, expectJapanese: false }).usable, true);
  assert.equal(assessBodyText(undefined).reason, "empty");
});
