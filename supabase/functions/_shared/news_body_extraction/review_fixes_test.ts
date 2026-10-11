// PR #129 R1 (F1–F5, F8): each case reproduces the reviewed input. Synthetic text only.
import assert from "node:assert/strict";
import test from "node:test";
import { extractFomcStatementFacts, renderFomcStatementSummary } from "./fomc_statement_facts.ts";
import { assessKessanBody, extractKessanTankiFacts, renderKessanFactsSummary } from "./kessan_tanshin_facts.ts";

const HEAD = ["2026年3月期 第１四半期決算短信〔日本基準〕(連結)", "2026年8月７日", "(百万円未満切捨て)"];
const table = (opts: {
  section?: string[];
  header?: string;
  units?: string;
  rows: string[];
  period?: string;
}) =>
  [
    ...HEAD,
    ...(opts.section ?? ["１．2026年3月期第１四半期の連結業績（2026年4月１日～2026年6月30日）", "（１）連結経営成績(累計) (％表示は、対前年同四半期増減率)"]),
    opts.header ?? "売上高 営業利益 経常利益 親会社株主に帰属",
    "する四半期純利益",
    opts.units ?? "百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％",
    ...opts.rows,
  ].join("\n");

const Q1 = (cur: string, prior: string) => [
  `2026年3月期第１四半期 ${cur}`,
  `2025年3月期第１四半期 ${prior}`,
];

const amounts = (text: string) => extractKessanTankiFacts(text).currentRow?.values.map((v) => [v.metric, v.amount, v.changePct]);

test("F1: a minus mark standing apart from its number is joined; joined form is unchanged; a dangling mark rejects the row", () => {
  const split = table({ rows: Q1("5,000 10.0 △ 100 △ 20.0 300 5.0 200 4.0", "4,545 1.0 120 2.0 290 3.0 190 4.0") });
  const facts = extractKessanTankiFacts(split);
  assert.equal(facts.ok, true, facts.issues.join(","));
  assert.deepEqual(amounts(split), [["sales", "5,000", "10.0"], ["operating_profit", "-100", "-20.0"], ["ordinary_profit", "300", "5.0"], ["net_profit", "200", "4.0"]]);
  const joined = table({ rows: Q1("5,000 10.0 △100 △20.0 300 5.0 200 4.0", "4,545 1.0 120 2.0 290 3.0 190 4.0") });
  assert.deepEqual(amounts(joined), amounts(split));
  const rendered = renderKessanFactsSummary(extractKessanTankiFacts(split)) ?? "";
  assert.match(rendered, /営業利益-100百万円（前年同期比-20\.0%）/u);
  assert.equal(/営業利益\+?100百万円/u.test(rendered), false);
  const dangling = table({ rows: Q1("5,000 10.0 100 △ 300 5.0 200 4.0 △", "4,545 1.0 120 2.0 290 3.0 190 4.0") });
  const bad = extractKessanTankiFacts(dangling);
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((issue) => issue.startsWith("DANGLING_MINUS")));
  const stray = extractKessanTankiFacts(table({ rows: Q1("5,000 10.0 100 2.0 300 5.0 200 4.0 (注)", "4,545 1.0 120 2.0 290 3.0 190 4.0") }));
  assert.equal(stray.ok, false);
  assert.ok(stray.issues.some((issue) => issue.startsWith("UNEXPECTED_TOKEN")));
});

test("F2: amounts-then-percentages (百万円×4 then %×4) is not read as interleaved pairs", () => {
  const grouped = table({
    units: "百万円 百万円 百万円 百万円 % % % %",
    rows: Q1("1,000 100 80 50 10 20 30 40", "900 90 70 40 5 6 7 8"),
  });
  const facts = extractKessanTankiFacts(grouped);
  assert.equal(facts.ok, true, facts.issues.join(","));
  assert.deepEqual(amounts(grouped), [["sales", "1,000", "10"], ["operating_profit", "100", "20"], ["ordinary_profit", "80", "30"], ["net_profit", "50", "40"]]);
  // interleaved control: unchanged
  const inter = table({ rows: Q1("1,000 10 100 20 80 30 50 40", "900 5 90 6 70 7 40 8") });
  assert.deepEqual(amounts(inter), amounts(grouped));
});

test("F2: eight numbers without a unit line that settles the arrangement are not guessed", () => {
  const noUnits = table({ units: "（単位未記載）", rows: Q1("1,000 100 80 50 10 20 30 40", "900 90 70 40 5 6 7 8") });
  const facts = extractKessanTankiFacts(noUnits);
  assert.equal(facts.ok, false);
  assert.ok(facts.issues.some((issue) => issue.startsWith("LAYOUT_UNCONFIRMED")));
  assert.equal(renderKessanFactsSummary(facts), null);
});

test("F3: IFRS 税引前利益 keeps its own name and is never printed as 経常利益", () => {
  const ifrs = table({
    header: "売上収益 営業利益 税引前利益 親会社の所有者に帰属",
    units: "百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％",
    rows: Q1("5,000 10.0 400 5.0 80 3.0 60 2.0", "4,545 1.0 380 2.0 78 3.0 58 4.0"),
  }).replace("する四半期純利益", "する四半期利益");
  const facts = extractKessanTankiFacts(ifrs);
  assert.equal(facts.ok, true, facts.issues.join(","));
  assert.deepEqual(facts.currentRow?.values.map((v) => v.metric), ["sales", "operating_profit", "pretax_profit", "net_profit"]);
  const rendered = renderKessanFactsSummary(facts) ?? "";
  assert.match(rendered, /税引前利益80百万円/u);
  assert.equal(/経常利益/u.test(rendered), false);
});

test("F3: IFRS five columns (total profit and attributable profit) are both kept apart; a duplicated measure rejects the table", () => {
  const five = [
    ...HEAD,
    "１．2026年3月期第１四半期の連結業績（2026年4月１日～2026年6月30日）",
    "（１）連結経営成績(累計) (％表示は、対前年同四半期増減率)",
    "売上収益 営業利益 税引前利益 四半期利益 親会社の所有者に帰属",
    "する四半期利益",
    "百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％",
    "2026年3月期第１四半期 5,000 10.0 400 5.0 380 3.0 300 2.0 280 1.0",
    "2025年3月期第１四半期 4,545 1.0 390 2.0 370 3.0 290 4.0 270 5.0",
  ].join("\n");
  const facts = extractKessanTankiFacts(five);
  assert.equal(facts.ok, true, facts.issues.join(","));
  assert.deepEqual(facts.currentRow?.values.map((v) => [v.metric, v.amount]), [
    ["sales", "5,000"], ["operating_profit", "400"], ["pretax_profit", "380"], ["profit_total", "300"], ["net_profit", "280"],
  ]);
  const twice = table({ header: "売上高 営業利益 当期純利益 当期純利益", units: "百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％", rows: Q1("5,000 10.0 400 5.0 300 2.0 300 2.0", "4,545 1.0 390 2.0 290 4.0 290 4.0") });
  assert.equal(extractKessanTankiFacts(twice).ok, false);
});

test("F4: a 参考 個別 line above a table whose own heading is 連結 does not make it 個別", () => {
  const text = table({
    section: ["参考: 個別財務諸表の概要は後記のとおりです", "１．2026年3月期第１四半期の連結業績（2026年4月１日～2026年6月30日）", "（１）連結経営成績(累計) (％表示は、対前年同四半期増減率)"],
    rows: Q1("5,000 10.0 100 2.0 300 5.0 200 4.0", "4,545 1.0 120 2.0 290 3.0 190 4.0"),
  });
  const facts = extractKessanTankiFacts(text);
  assert.equal(facts.ok, true, facts.issues.join(","));
  assert.equal(facts.results?.basis, "consolidated");
  assert.match(renderKessanFactsSummary(facts) ?? "", /連結経営成績/u);
});

test("F4: a heading naming both bases is a conflict and is not read; a standalone heading stays 個別", () => {
  const both = table({ section: ["（１）連結・個別経営成績(累計)"], rows: Q1("5,000 10.0 100 2.0 300 5.0 200 4.0", "4,545 1.0 120 2.0 290 3.0 190 4.0") });
  const facts = extractKessanTankiFacts(both);
  assert.equal(facts.ok, false);
  assert.ok(facts.issues.includes("BASIS_CONFLICT"));
  const solo = table({ section: ["（１）個別経営成績(累計)"], rows: Q1("5,000 10.0 100 2.0 300 5.0 200 4.0", "4,545 1.0 120 2.0 290 3.0 190 4.0") });
  assert.equal(extractKessanTankiFacts(solo).results?.basis, "standalone");
});

test("F5: a prior row from another quarter, month or period type is not shown as the comparable prior period", () => {
  const rowsFor = (prior: string) => [`2026年3月期第１四半期 5,000 10.0 100 2.0 300 5.0 200 4.0`, prior];
  const wrongQuarter = extractKessanTankiFacts(table({ rows: rowsFor("2025年3月期第３四半期 4,545 1.0 120 2.0 290 3.0 190 4.0") }));
  assert.equal(wrongQuarter.ok, false);
  assert.ok(wrongQuarter.issues.includes("PRIOR_ROW_PERIOD_TYPE_MISMATCH"));
  assert.equal(renderKessanFactsSummary(wrongQuarter), null);
  const wrongMonth = extractKessanTankiFacts(table({ rows: rowsFor("2025年12月期第１四半期 4,545 1.0 120 2.0 290 3.0 190 4.0") }));
  assert.ok(wrongMonth.issues.includes("PRIOR_ROW_MONTH_MISMATCH"));
  const wrongYear = extractKessanTankiFacts(table({ rows: rowsFor("2024年3月期第１四半期 4,545 1.0 120 2.0 290 3.0 190 4.0") }));
  assert.ok(wrongYear.issues.includes("PRIOR_ROW_YEAR_MISMATCH"));
  const control = extractKessanTankiFacts(table({ rows: rowsFor("2025年3月期第１四半期 4,545 1.0 120 2.0 290 3.0 190 4.0") }));
  assert.equal(control.ok, true);
  assert.equal(assessKessanBody(table({ rows: rowsFor("2025年3月期第３四半期 4,545 1.0 120 2.0 290 3.0 190 4.0") }), "generic").status, "missing");
});

// ---------------------------------------------------------------- F8

const statementWith = (votes: string) =>
  `<html><body><div id="article"><p class="article__time">September 16, 2026</p><h3>Federal Reserve issues FOMC statement</h3><p>The Committee decided to lower the target range for the federal funds rate by 1/4 percentage point to 3-1/2 to 3-3/4 percent.</p><p>${votes}</p></div><div id="footer">Last Update: September 16, 2026</div></body></html>`;

test("F8: dissenters with middle initials are read in full and counted", () => {
  const facts = extractFomcStatementFacts(statementWith(
    "Voting for the monetary policy action were Jerome H. Powell, John C. Williams, and Michael S. Barr. Voting against this action were Christopher J. Waller and Michelle W. Bowman, who preferred a different action.",
  ));
  assert.equal(facts.ok, true, facts.issues.join(","));
  assert.deepEqual(facts.dissenters, ["Christopher J. Waller", "Michelle W. Bowman"]);
  assert.equal(facts.votesAgainst, 2);
  assert.equal(facts.dissentersUncertain, false);
  assert.match(renderFomcStatementSummary(facts) ?? "", /反対: Christopher J\. Waller、Michelle W\. Bowman/u);
});

test("F8: single dissenter, explicit count agreement, and no invented numbers when the sentence is unclear", () => {
  const one = extractFomcStatementFacts(statementWith("The action was approved by a 11 – 1 vote. Voting against this action was Stephen I. Miran, who preferred to lower the target range by 1/2 percentage point."));
  assert.deepEqual(one.dissenters, ["Stephen I. Miran"]);
  assert.equal(one.votesAgainst, 1);
  const mismatch = extractFomcStatementFacts(statementWith("The action was approved by a 10 – 2 vote. Voting against this action was Stephen I. Miran, who preferred a larger cut."));
  assert.equal(mismatch.votesAgainst, 2);
  assert.deepEqual(mismatch.dissenters, []);
  assert.equal(mismatch.dissentersUncertain, true);
  const vague = extractFomcStatementFacts(statementWith("Voting against this action were several members who preferred a different action."));
  assert.equal(vague.votesAgainst, null);
  assert.equal(vague.dissentersUncertain, true);
  assert.doesNotMatch(renderFomcStatementSummary(vague) ?? "", /全会一致/u);
  const unanimous = extractFomcStatementFacts(statementWith("The action was approved unanimously."));
  assert.equal(unanimous.votesAgainst, 0);
  assert.match(renderFomcStatementSummary(unanimous) ?? "", /全会一致/u);
});

// ---------------------------------------------------------------- PR #129 R3 (H4-R1, H4-R3)

const WRAPPED = (rows: string[]) =>
  [
    "2026年3月期 決算短信〔日本基準〕(連結)",
    "(百万円未満切捨て)",
    "（１）連結経営成績",
    "売上高 営業利益 経常利益 親会社株主に帰属する当期純利益",
    "百万円 % 百万円 % 百万円 % 百万円 %",
    ...rows,
  ].join("\n");

test("H4-R1: a row wrapped over two lines is joined and read as amount/percent pairs, never as four amounts", () => {
  const text = WRAPPED(["2026年3月期 1000 10 100 20", "80 30 50 40", "2025年3月期 900 5 90 6", "70 7 40 8"]);
  const facts = extractKessanTankiFacts(text);
  assert.equal(facts.ok, true, facts.issues.join(","));
  assert.deepEqual(facts.currentRow?.values.map((v) => [v.metric, v.amount, v.changePct]), [
    ["sales", "1000", "10"], ["operating_profit", "100", "20"], ["ordinary_profit", "80", "30"], ["net_profit", "50", "40"],
  ]);
  assert.equal(facts.priorRow?.values[1].amount, "90");
});

test("H4-R1: a half row that is not completed by a numbers-only line is not a result (cut, note, next period)", () => {
  const cut = extractKessanTankiFacts(WRAPPED(["2026年3月期 1000 10 100 20", "2025年3月期 900 5 90 6 70 7 40 8"]));
  assert.equal(cut.ok, false);
  assert.ok(cut.issues.some((issue) => issue.startsWith("ROW_INCOMPLETE")));
  const note = extractKessanTankiFacts(WRAPPED(["2026年3月期 1000 10 100 20", "(注) 前期は修正再表示", "80 30 50 40", "2025年3月期 900 5 90 6 70 7 40 8"]));
  assert.equal(note.ok, false);
  const over = extractKessanTankiFacts(WRAPPED(["2026年3月期 1000 10 100 20 80", "30 50 40 9", "2025年3月期 900 5 90 6 70 7 40 8"]));
  assert.equal(over.ok, false);
  assert.equal(renderKessanFactsSummary(over), null);
});

test("H4-R1: amounts-only is accepted only when the header says so; ordinary m/2m tables are unchanged", () => {
  const amountsOnly = [
    "2026年3月期 決算短信〔日本基準〕(連結)",
    "（１）連結経営成績",
    "売上高 営業利益 経常利益 親会社株主に帰属する当期純利益",
    "百万円 百万円 百万円 百万円",
    "2026年3月期 1000 100 80 50",
    "2025年3月期 900 90 70 40",
  ].join("\n");
  const facts = extractKessanTankiFacts(amountsOnly);
  assert.equal(facts.ok, true, facts.issues.join(","));
  assert.deepEqual(facts.currentRow?.values.map((v) => v.amount), ["1000", "100", "80", "50"]);
  assert.deepEqual(facts.currentRow?.values.map((v) => v.changePct), [null, null, null, null]);
  const noUnits = extractKessanTankiFacts(amountsOnly.replace("百万円 百万円 百万円 百万円", "(単位未記載)"));
  assert.equal(noUnits.ok, false);
  const plain = extractKessanTankiFacts(WRAPPED(["2026年3月期 1000 10 100 20 80 30 50 40", "2025年3月期 900 5 90 6 70 7 40 8"]));
  assert.equal(plain.ok, true);
  assert.equal(plain.currentRow?.values[2].amount, "80");
});

const FOMC_PAGE = (body: string) =>
  `<html><head><title>Federal Reserve Board - Federal Reserve issues FOMC statement</title></head><body><div id="article"><p class="article__time">October 9, 2026</p><h3>Federal Reserve issues FOMC statement</h3><p>${body}</p></div><div id="footer">Last Update: October 9, 2026</div></body></html>`;

test("H4-R3: a past meeting's raise is not this meeting's decision (hold at 4-1/4 to 4-1/2)", () => {
  const facts = extractFomcStatementFacts(FOMC_PAGE(
    "At its July meeting, the Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 4-1/4 to 4-1/2 percent. At this meeting, the Committee decided to maintain the target range for the federal funds rate at 4-1/4 to 4-1/2 percent. The action was approved by a 12 – 0 vote.",
  ));
  assert.equal(facts.ok, true, facts.issues.join(","));
  assert.equal(facts.action, "maintain");
  assert.equal(facts.changeBp, 0);
  assert.equal(facts.rangeLowerPct, 4.25);
  assert.equal(facts.rangeUpperPct, 4.5);
  const rendered = renderFomcStatementSummary(facts) ?? "";
  assert.match(rendered, /4\.25〜4\.5%（据え置き、変更なし）/u);
  assert.doesNotMatch(rendered, /引き上げ/u);
});

test("H4-R3: two different current decisions are ambiguous and not guessed; the usual single statement is unchanged", () => {
  const ambiguous = extractFomcStatementFacts(FOMC_PAGE(
    "The Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 4-1/2 to 4-3/4 percent. The Committee decided to maintain the target range for the federal funds rate at 4-1/4 to 4-1/2 percent.",
  ));
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.issues.includes("AMBIGUOUS_DECISION"));
  assert.equal(renderFomcStatementSummary(ambiguous), null);
  const usual = extractFomcStatementFacts(FOMC_PAGE(
    "In support of its goals, the Committee decided to lower the target range for the federal funds rate by 1/4 percentage point to 4 to 4-1/4 percent. The action was approved by a 11 – 1 vote.",
  ));
  assert.equal(usual.ok, true, usual.issues.join(","));
  assert.equal(usual.action, "lower");
  assert.equal(usual.changeBp, 25);
  assert.equal(usual.rangeLowerPct, 4);
  const sameTwice = extractFomcStatementFacts(FOMC_PAGE(
    "The Committee decided to maintain the target range for the federal funds rate at 4-1/4 to 4-1/2 percent. The Committee decided to maintain the target range for the federal funds rate at 4-1/4 to 4-1/2 percent.",
  ));
  assert.equal(sameTwice.ok, true);
});
