import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNewsPresentation,
  DETAIL_MAX,
  fitText,
  isJapanese,
  LIST_SUMMARY_MAX,
  marketRelationText,
  type NewsPresentationInput,
  ORIGINAL_EXCERPT_MAX,
  sourceLabelFor,
  stripMarkup,
  TITLE_MAX,
  verifiedPostParagraphs,
} from "../../src/lib/news-presentation.ts";

// Fixtures mirror real production rows (public news; trimmed).
const YEN: NewsPresentationInput = {
  title: "Yen advances sharply, gaining about ¥5 against the dollar over two days",
  summary: "The yen strengthened to around ¥155.75–155.85 per dollar, its strongest level in about one month.",
  verified_text: "【速報】円が2日間で約5円上昇し、1ドル＝155.75〜155.85円と約1カ月ぶりの円高水準です。日銀の利上げ加速観測に加え、円キャリートレードの巻き戻しが円高を支えています。\n\n政策変更そのものではありませんが、急速な為替変動。日本株では、輸出企業や市場全体に影響し得る動きです。\n\n出典: https://big.nikkei.com/article/abc",
  source_type: "breaking_market",
  source_url: "https://www.nikkei.com/article/abc",
  company_name: "市場全体",
  matched_sector: "電気機器",
  relevance_reason: "fx",
};

const GREER: NewsPresentationInput = {
  title: "Ambassador Greer Issues Statement on President Trump’s Response to Canada’s Continued Retaliation Against the United States",
  summary: '<span id="pageTitle" class="field field--name-title field--type-string field--label-hidden">Ambassador Greer Issues Statement on President Trump&rsquo;s Response to Canada</span> <p>WASHINGTON &ndash; United States Trade Representative Jamieson Greer issued the following statement.</p>',
  // The generated Japanese text for this row FAILED the Fact check, so the RPC returns null.
  verified_text: null,
  source_type: "market_macro",
  source_url: "https://ustr.gov/about-us/policy-offices/press-office/press-releases/2026/september/x",
  company_name: "市場全体",
  matched_sector: "機械",
  relevance_reason: "autos,trade",
};

const KDDI_BUYBACK: NewsPresentationInput = {
  title: "自己株式の取得状況に関するお知らせ",
  summary: "各 位 会 社 名 ＫＤＤＩ株式会社 代表者名 代表取締役社長 CEO 松田 浩路 （電話番号：03－3347－0077） 自己株式の取得状況に関するお知らせ 当社は、会社法第 165 条第３項の規定により読み替えて適用される同法第 156 条の規定に基づく 自己株式の取得につきまして、以下の通り、取得状況をお知らせいたします。 取得した株式の総数 12,345,600 株。",
  verified_text: null,
  source_type: "tdnet",
  source_url: "https://www.release.tdnet.info/inbs/140120260902000000.pdf",
  company_name: "ＫＤＤＩ",
  matched_sector: null,
  relevance_reason: null,
};

const CANADA: NewsPresentationInput = {
  title: "Canada strikes back with tariffs on about $20 billion worth of U.S. goods",
  summary: "Canada announced retaliatory tariffs covering approximately $20 billion of U.S. goods.",
  verified_text: "【速報】カナダが、約200億ドル相当の米国製品を対象に報復関税を発表しました。北米の貿易摩擦がさらに激化する形です。 日本株への影響は、リスク心理を通じた間接的なものにとどまる見通しで、現時点では追加措置は確認されていません。 出典: https://apnews.com/article/461f9e97",
  source_type: "breaking_market",
  source_url: "https://apnews.com/article/461f9e97",
  company_name: "市場全体",
  matched_sector: "機械",
  relevance_reason: "trade",
};

function allText(p: ReturnType<typeof buildNewsPresentation>): string {
  return [p.title, p.listSummary, ...p.keyPoints, ...p.detailParagraphs, p.originalExcerpt ?? "", p.marketRelation ?? ""].join("\n");
}

test("an English title with verified Japanese text is shown in Japanese", () => {
  const p = buildNewsPresentation(YEN);
  assert.equal(p.origin, "verified_post");
  assert.equal(p.titleIsJapanese, true);
  assert.ok(isJapanese(p.title), p.title);
  assert.ok(Array.from(p.title).length <= TITLE_MAX);
  assert.equal(p.originalTitle, YEN.title);
});

test("figures, dates and direction survive exactly as in the verified text", () => {
  const p = buildNewsPresentation(YEN);
  const text = allText(p);
  for (const fact of ["約5円上昇", "155.75〜155.85円", "約1カ月ぶり", "円高水準"]) {
    assert.ok(text.includes(fact), `missing ${fact}`);
  }
  const canada = allText(buildNewsPresentation(CANADA));
  assert.ok(canada.includes("約200億ドル相当"));
  assert.ok(canada.includes("報復関税"));
});

test("the 【速報】 label, the 出典 line and URLs never reach the screen", () => {
  for (const item of [YEN, CANADA]) {
    const text = allText(buildNewsPresentation(item));
    assert.ok(!text.includes("【速報】") && !text.includes("【重大速報】"), text);
    assert.ok(!text.includes("出典"), text);
    assert.ok(!/https?:\/\//.test(text), text);
  }
  assert.deepEqual(verifiedPostParagraphs("【重大速報】本文です。\n\n出典: https://example.com/a"), ["本文です。"]);
});

test("HTML tags, attributes and entities are never shown", () => {
  const p = buildNewsPresentation(GREER);
  const text = allText(p);
  assert.ok(!/[<>]/.test(text), text);
  assert.ok(!text.includes("pageTitle") && !text.includes("field--name"), text);
  assert.ok(!text.includes("&rsquo;") && !text.includes("&ndash;"), text);
  assert.equal(stripMarkup('<span class="x">A&amp;B</span><br/>C &#39;D&#39; &#x2014;'), "A&B\nC 'D' —");
  assert.equal(stripMarkup("text before a cut <span id=\"page"), "text before a cut");
});

test("with no verified Japanese text, nothing is translated or invented", () => {
  const p = buildNewsPresentation(GREER);
  assert.equal(p.origin, "original_only");
  assert.equal(p.titleIsJapanese, false);
  assert.equal(p.title, GREER.title.replace(/\s+/g, " "));
  assert.equal(p.listSummary, "");
  assert.deepEqual(p.detailParagraphs, []);
  assert.ok(p.originalExcerpt && p.originalExcerpt.startsWith("Ambassador Greer Issues Statement"));
  assert.ok(Array.from(p.originalExcerpt!).length <= ORIGINAL_EXCERPT_MAX);
});

test("a Japanese TDnet disclosure drops the letterhead and PDF spacing", () => {
  const p = buildNewsPresentation(KDDI_BUYBACK);
  assert.equal(p.origin, "disclosure");
  assert.equal(p.title, "自己株式の取得状況に関するお知らせ");
  assert.ok(p.listSummary.startsWith("当社は、会社法第165条第３項"), p.listSummary);
  for (const noise of ["各 位", "代表者名", "電話番号", "会 社 名"]) {
    assert.ok(!allText(p).includes(noise), noise);
  }
  assert.ok(allText(p).includes("12,345,600株"));
});

test("list summary stays short and detail is never empty when Japanese exists", () => {
  const longVerified = { ...YEN, verified_text: `【速報】${"円相場が大きく動きました。".repeat(60)}` };
  const p = buildNewsPresentation(longVerified);
  assert.ok(Array.from(p.listSummary).length <= LIST_SUMMARY_MAX);
  assert.ok(p.detailParagraphs.length > 0);
  const tdnet = buildNewsPresentation({ ...KDDI_BUYBACK, summary: `当社は${"本日決議しました。".repeat(200)}` });
  assert.ok(tdnet.detailParagraphs.join("").length > 0);
  assert.ok(Array.from(tdnet.detailParagraphs.join("")).length <= DETAIL_MAX);
});

test("a thin source is not padded into a long article", () => {
  const p = buildNewsPresentation({
    ...KDDI_BUYBACK,
    summary: "自己株式の取得状況に関するお知らせ 当社は取得状況をお知らせします。",
  });
  assert.equal(p.detailParagraphs.join(""), "当社は取得状況をお知らせします。");
  assert.deepEqual(p.keyPoints, []);
});

test("empty or broken input still yields a non-empty title and no crash", () => {
  const p = buildNewsPresentation({ title: "", summary: null, source_url: "not a url", company_name: "" });
  assert.equal(p.title, "（タイトルなし）");
  assert.equal(p.sourceUrl, null);
  assert.equal(p.sourceLabel, null);
});

test("market relation explains the link and never the direction", () => {
  const relation = marketRelationText("電気機器", "fx,rates")!;
  assert.equal(relation, "為替・金利に関するニュースです。登録している電気機器の銘柄に関係する可能性があるため表示しています。");
  for (const forbidden of ["上がる", "下がる", "上昇", "下落", "買い", "売り", "推奨"]) {
    assert.ok(!relation.includes(forbidden), forbidden);
  }
  assert.equal(marketRelationText(null, "fx"), null);
  assert.equal(buildNewsPresentation(KDDI_BUYBACK).marketRelation, null);
});

test("sources get a readable Japanese label", () => {
  assert.equal(sourceLabelFor("https://www.release.tdnet.info/inbs/a.pdf"), "TDnet（適時開示）");
  assert.equal(sourceLabelFor("https://ustr.gov/x"), "米通商代表部（USTR）");
  assert.equal(sourceLabelFor("https://apnews.com/article/x"), "AP通信");
  assert.equal(sourceLabelFor("https://www.mof.go.jp/english/x"), "財務省");
  assert.equal(sourceLabelFor("https://example.org/x"), "example.org");
  assert.equal(sourceLabelFor(null), null);
});

test("a forced cut never lands inside a number", () => {
  const text = fitText(`${"あ".repeat(190)}1,234,567億円`, LIST_SUMMARY_MAX);
  assert.ok(!/[0-9,]…$/.test(text) || text.includes("1,234,567"), text);
});
