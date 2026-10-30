import assert from "node:assert/strict";
import test from "node:test";
import { currentRowStatus, isOperatingCompanyReport, periodOf } from "./tanshin_extraction.ts";

test("periods are read from Western and Reiwa labels, full-width digits included", () => {
  assert.deepEqual(periodOf("2027年２月期 第２四半期（中間期）決算短信"), { year: 2027, month: 2 });
  assert.deepEqual(periodOf("令和９年２月期 第２四半期"), { year: 2027, month: 2 });
  assert.equal(periodOf("決算短信"), null);
});

test("the first row of the results table decides whether the current period is present", () => {
  const title = "2027年２月期 第２四半期（中間期）決算短信〔日本基準〕（連結）";
  const header = "経営成績（累計） （％表示は、対前年中間期増減率） 売上高 営業利益 経常利益 百万円 ％";
  const prior = `${header} 2026年２月期中間期 27,042 △3.1 △213 － (注) 包括利益`;
  const current = `${header} 2027年２月期中間期 28,100 3.9 120 － 2026年２月期中間期 27,042 △3.1 △213 －`;
  assert.equal(currentRowStatus(title, prior), "prior_period_only");
  assert.equal(currentRowStatus(title, current), "current_row_present");
  assert.equal(currentRowStatus(title, "本文に表がありません"), "no_table");
});

test("a mention in the table of contents is not mistaken for the table", () => {
  const title = "2027年1月期 第2四半期（中間期）決算短信";
  const toc = "（１）経営成績に関する説明 ………… 2 （２）財政状態に関する説明 ………… 3";
  assert.equal(currentRowStatus(title, toc), "unclear");
  const withTable = `${toc} 経営成績（累計） 売上高 営業利益 2026年1月期中間期 22,871 12.8 1,726 53.4`;
  assert.equal(currentRowStatus(title, withTable), "prior_period_only");
});

test("funds, ETFs and REITs are outside the check", () => {
  assert.equal(isOperatingCompanyReport("2026年7月期 決算短信（ＲＥＩＴ）"), false);
  assert.equal(isOperatingCompanyReport("ＭＡＸＩＳ日本株高配当ＳＭＡＲＴ５０上場投信 決算短信（2026年8月期）"), false);
  assert.equal(isOperatingCompanyReport("2026年７月期 決算短信〔日本基準〕（連結）"), true);
});
