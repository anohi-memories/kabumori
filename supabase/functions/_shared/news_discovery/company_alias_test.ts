import assert from "node:assert/strict";
import test from "node:test";
import { buildAliasIndex, generatedShortNames, matchTickers, type StockMasterRow } from "./company_alias.ts";

// Names exactly as stored in stocks_master (full-width ASCII included), read-only sample 2026-09-28.
const ROWS: StockMasterRow[] = [
  { ticker_code: "8136", company_name: "サンリオ" },
  { ticker_code: "7203", company_name: "トヨタ自動車" },
  { ticker_code: "3116", company_name: "トヨタ紡織" },
  { ticker_code: "6758", company_name: "ソニーグループ" },
  { ticker_code: "8729", company_name: "ソニーフィナンシャルグループ" },
  { ticker_code: "7974", company_name: "任天堂" },
  { ticker_code: "9984", company_name: "ソフトバンクグループ" },
  { ticker_code: "9434", company_name: "ソフトバンク" },
  { ticker_code: "8035", company_name: "東京エレクトロン" },
  { ticker_code: "6501", company_name: "日立製作所" },
  { ticker_code: "6305", company_name: "日立建機" },
  { ticker_code: "4689", company_name: "ＬＩＮＥヤフー" },
  { ticker_code: "4477", company_name: "ＢＡＳＥ" },
  { ticker_code: "8267", company_name: "イオン" },
  { ticker_code: "8306", company_name: "三菱ＵＦＪフィナンシャル・グループ" },
  { ticker_code: "9432", company_name: "ＮＴＴ" },
  { ticker_code: "4452", company_name: "花王" },
  { ticker_code: "7752", company_name: "リコー" },
  { ticker_code: "4481", company_name: "ベース" },
  { ticker_code: "8118", company_name: "キング" },
  { ticker_code: "7769", company_name: "リズム" },
  { ticker_code: "2531", company_name: "宝ホールディングス" },
  { ticker_code: "9999", company_name: "廃止テスト", is_listed: false },
];
const index = buildAliasIndex(ROWS);
const confirmed = (title: string, summary?: string) =>
  matchTickers({ title, summary }, index).filter((c) => c.status === "confirmed").map((c) => c.ticker);
const all = (title: string, summary?: string) => matchTickers({ title, summary }, index);

test("official company name (full-width in master) matches as EXACT", () => {
  const [hit] = all("サンリオ、通期予想を上方修正");
  assert.equal(hit.ticker, "8136");
  assert.deepEqual(hit.match_types, ["EXACT_COMPANY_NAME"]);
  assert.deepEqual(confirmed("ＬＩＮＥヤフーが新サービス"), ["4689"]);
  assert.deepEqual(confirmed("三菱UFJフィナンシャル・グループが増配"), ["8306"]);
});

test("English names and brands from the v0 seed match as STRONG", () => {
  assert.deepEqual(confirmed("Hello Kitty cafe opens in Paris"), ["8136"]);
  assert.deepEqual(confirmed("サンリオピューロランドの入場料改定"), ["8136"]);
  assert.deepEqual(confirmed("Toyota recalls 100,000 vehicles"), ["7203"]);
  assert.deepEqual(confirmed("New PlayStation price announced"), ["6758"]);
  assert.deepEqual(confirmed("ユニクロ", ""), []); // 9983 is not in this fixture: seed skipped, not invented
  assert.ok(index.warnings.some((w) => w.includes("9983")));
});

test("longest span wins: 日立建機 is not 日立製作所, トヨタ紡織 is not トヨタ自動車", () => {
  assert.deepEqual(confirmed("日立建機が新型ショベルを発売"), ["6305"]);
  assert.deepEqual(confirmed("日立、送配電事業を強化"), ["6501"]);
  assert.deepEqual(confirmed("トヨタ紡織が工場を新設"), ["3116"]);
  assert.deepEqual(confirmed("ソフトバンクグループが社債発行"), ["9984"]);
});

test("seed alias outranks another company's generated short name (ソニー)", () => {
  assert.deepEqual(confirmed("ソニー、新型カメラを発表"), ["6758"]);
  assert.deepEqual(confirmed("ソニーフィナンシャルグループの決算"), ["8729"]);
});

test("weak aliases alone never confirm: LINE, BASE, TEL, SoftBank", () => {
  assert.deepEqual(confirmed("The LINE between policy and markets"), []);
  assert.deepEqual(confirmed("BASE rate unchanged"), []);
  assert.deepEqual(confirmed("TEL Aviv stocks fall"), []);
  const line = all("LINE outage reported");
  assert.equal(line[0]?.ticker, "4689");
  assert.equal(line[0]?.status, "candidate");
  assert.deepEqual(confirmed("SoftBank shares rise"), []);
});

test("weak alias is confirmed by its context terms", () => {
  assert.deepEqual(confirmed("BASE、ネットショップ作成サービスを刷新"), ["4477"]);
  assert.deepEqual(confirmed("TEL raises outlook", "semiconductor equipment demand"), ["8035"]);
});

test("ASCII aliases need word boundaries (TEL in HOTEL, LINE in LINEAR)", () => {
  assert.deepEqual(all("HOTEL LINEAR expansion"), []);
});

test("ambiguous official name returns several candidates without confirming one", () => {
  const hits = all("ソフトバンク、決算説明会");
  assert.deepEqual(hits.map((h) => [h.ticker, h.status]).sort(), [["9434", "candidate"]]);
  // With its context term the carrier is confirmed.
  assert.deepEqual(confirmed("ソフトバンク、携帯の通信料金を値下げ"), ["9434"]);
});

test("negative context suppresses イオン inside リチウムイオン", () => {
  assert.deepEqual(confirmed("全固体リチウムイオン電池の量産へ"), []);
  assert.deepEqual(confirmed("イオン、PBの価格を据え置き"), ["8267"]);
});

test("ticker codes: explicit forms confirm; year-like parentheses need corroboration", () => {
  assert.deepEqual(confirmed("証券コード7974の株価が急騰"), ["7974"]);
  assert.deepEqual(confirmed("Shares of 7203.T fell 3%"), ["7203"]);
  assert.deepEqual(confirmed("花王(4452)が値上げ"), ["4452"]);
  assert.deepEqual(confirmed("計画(2026)を公表"), []);
});

test("structured ticker (EDINET secCode) is used as TICKER_CODE", () => {
  const [hit] = matchTickers({ title: "臨時報告書", structured_ticker: "7974" }, index);
  assert.equal(hit.ticker, "7974");
  assert.deepEqual(hit.match_types, ["TICKER_CODE"]);
});

test("multiple companies in one headline are all returned", () => {
  assert.deepEqual(confirmed("トヨタとソニーが提携").sort(), ["6758", "7203"]);
});

test("delisted rows are not matched", () => {
  assert.deepEqual(all("廃止テストの話題"), []);
});

test("generated short names strip group suffixes", () => {
  assert.deepEqual(generatedShortNames("ソニーグループ"), ["ソニー"]);
  assert.ok(generatedShortNames("三菱ＵＦＪフィナンシャル・グループ").includes("三菱UFJ"));
  assert.deepEqual(generatedShortNames("任天堂"), []);
});

// Regressions from the live run on 2026-09-28 (消費者庁 / 金融庁 / 官邸 feeds).
test("katakana names are not matched inside longer katakana words", () => {
  assert.deepEqual(all("リコール製品で火災等(リチウム電池内蔵充電器)"), []);
  assert.deepEqual(all("機能性表示食品制度届出データベース届出情報の更新").filter((c) => c.ticker === "4481"), []);
  assert.deepEqual(all("金融審議会「保険制度ワーキング・グループ」の開催"), []);
  assert.deepEqual(all("ツーリズム・エキスポ・ジャパン2026"), []);
});

test("unreviewed short katakana official names only produce candidates", () => {
  const [hit] = all("キング、新製品を発表");
  assert.equal(hit.ticker, "8118");
  assert.equal(hit.status, "candidate");
  assert.deepEqual(confirmed("リコー、複合機の新製品"), [], "リコー is a 3-char katakana name without review");
});

test("one-character generated short names are never created (宝ホールディングス -> 宝)", () => {
  assert.deepEqual(all("株式会社金宝堂に対する措置命令"), []);
});
