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
  normalizeNewsText,
  partitionVerifiedSentences,
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

test("list summary stays short and duplicate detail may be omitted", () => {
  const longVerified = { ...YEN, verified_text: `【速報】${"円相場が大きく動きました。".repeat(60)}` };
  const p = buildNewsPresentation(longVerified);
  assert.ok(Array.from(p.listSummary).length <= LIST_SUMMARY_MAX);
  assert.deepEqual(p.detailParagraphs, []);
  const tdnet = buildNewsPresentation({ ...KDDI_BUYBACK, summary: `当社は${"本日決議しました。".repeat(200)}` });
  assert.deepEqual(tdnet.detailParagraphs, []);
  assert.ok(Array.from(tdnet.detailParagraphs.join("")).length <= DETAIL_MAX);
});

test("a thin source is not padded into a long article", () => {
  const p = buildNewsPresentation({
    ...KDDI_BUYBACK,
    summary: "自己株式の取得状況に関するお知らせ 当社は取得状況をお知らせします。",
  });
  assert.deepEqual(p.detailParagraphs, []);
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

test("Fact-passed Japanese app copy turns an English item fully Japanese", () => {
  const p = buildNewsPresentation({
    ...GREER,
    app_title_ja: "米国、カナダ原産品500億ドル相当を政府調達から除外　USTRが声明",
    app_summary_ja: "米通商代表部のグリア代表は、カナダの報復措置に対するトランプ大統領の対応を説明しました。",
    app_detail_ja: "米通商代表部のグリア代表が声明を出しました。\n\n大統領は、カナダ原産品500億ドル相当を政府調達の対象から外すよう指示しました。",
    app_key_points_ja: ["USTRのグリア代表が声明", "カナダ原産品500億ドル相当を政府調達から除外"],
  });
  assert.equal(p.origin, "app_copy");
  assert.equal(p.titleIsJapanese, true);
  assert.ok(p.title.startsWith("米国、カナダ原産品500億ドル相当"));
  assert.equal(p.originalTitle, GREER.title);
  assert.equal(p.detailParagraphs.length, 2);
  assert.deepEqual(p.keyPoints, ["USTRのグリア代表が声明", "カナダ原産品500億ドル相当を政府調達から除外"]);
  assert.ok(p.listSummary.startsWith("米通商代表部のグリア代表は"));
  assert.equal(p.originalExcerpt, null);
  assert.ok(!/[<>]/.test(allText(p)));
});

test("without Fact-passed app copy (the RPC returns null) the item stays on the pending fallback", () => {
  const p = buildNewsPresentation({ ...GREER, app_title_ja: null, app_summary_ja: null, app_detail_ja: null, app_key_points_ja: null });
  assert.equal(p.origin, "original_only");
  assert.equal(p.listSummary, "");
});

test("a verified X post still wins over app copy, and app copy markup is stripped", () => {
  const both = buildNewsPresentation({ ...YEN, app_title_ja: "別の見出し", app_detail_ja: "別の本文です。" });
  assert.equal(both.origin, "verified_post");
  const dirty = buildNewsPresentation({
    ...GREER,
    app_title_ja: "<b>米国</b>がカナダ製品を除外",
    app_detail_ja: "<p>本文です。</p> https://ustr.gov/x",
    app_summary_ja: "要約です。",
  });
  assert.equal(dirty.title, "米国 がカナダ製品を除外".replace(" ", " "));
  assert.ok(!/[<>]|https?:/.test(allText(dirty)), allText(dirty));
});

test("market relation names the ranked matched sectors, still without direction", () => {
  assert.equal(
    marketRelationText("電気機器", "fx", ["電気機器", "機械", "輸送用機器"]),
    "為替に関するニュースです。登録している電気機器・機械・輸送用機器の銘柄に関係する可能性があるため表示しています。",
  );
  assert.equal(
    marketRelationText("電気機器", "fx", ["電気機器", "機械", "輸送用機器", "精密機器"]),
    "為替に関するニュースです。登録している電気機器・機械・輸送用機器の銘柄に関係する可能性があるため表示しています。",
    "at most three sectors",
  );
  assert.equal(
    marketRelationText("銀行業", "rates", null),
    "金利に関するニュースです。登録している銀行業の銘柄に関係する可能性があるため表示しています。",
    "older RPC without the list",
  );
  const p = buildNewsPresentation({ ...YEN, matched_sectors: ["電気機器", "機械"] });
  assert.ok(p.marketRelation!.includes("電気機器・機械"));
});

test("a forced cut never lands inside a number", () => {
  const text = fitText(`${"あ".repeat(190)}1,234,567億円`, LIST_SUMMARY_MAX);
  assert.ok(!/[0-9,]…$/.test(text) || text.includes("1,234,567"), text);
});

test("comparison normalization ignores whitespace and punctuation variants", () => {
  assert.equal(normalizeNewsText("円相場が上昇しました。"), normalizeNewsText("円相場が 上昇しました！"));
});

test("identical app summary/detail is not repeated under 詳細", () => {
  const p = buildNewsPresentation({
    ...GREER,
    app_title_ja: "米国が声明",
    app_summary_ja: "米国が声明を出しました。",
    app_key_points_ja: ["米国が声明を出しました。"],
    app_detail_ja: "米国が声明を出しました。",
  });
  assert.deepEqual(p.keyPoints, []);
  assert.deepEqual(p.detailParagraphs, []);
});

test("verified post partitions distinct sentences between 要点 and 詳細", () => {
  const p = buildNewsPresentation({
    ...YEN,
    verified_text: "一つ目の事実です。二つ目の事実です。三つ目の事実です。四つ目の追加情報です。",
  });
  assert.equal(p.keyPoints.length, 2);
  assert.deepEqual(p.detailParagraphs, ["三つ目の事実です。", "四つ目の追加情報です。"]);
  assert.equal(new Set([...p.keyPoints, ...p.detailParagraphs].map(normalizeNewsText)).size, 4);
});

test("a short verified post keeps content once without manufacturing detail", () => {
  const p = buildNewsPresentation({
    ...YEN,
    verified_text: "短い一文です。補足はありません。",
  });
  assert.equal(p.keyPoints.length, 1);
  assert.deepEqual(p.keyPoints, ["短い一文です。"]);
  assert.deepEqual(p.detailParagraphs, []);
});

test("realistic geopolitical posts keep event facts in 詳細 and drop generic market filler", () => {
  const cases = [
    {
      input: {
        title: "North Korea touts new weapons system described as hypersonic",
        summary: "North Korea said Tuesday that its latest missile tests involved a new weapons system of major significance. South Korea said the missiles flew approximately 450 and 600 kilometers toward the sea, while Japan’s military assessed that they fell outside Japan’s exclusive economic zone.",
        verified_text: "【速報】北朝鮮が、新型兵器システムとするミサイル試験を実施しました。韓国側によると、ミサイルは約450〜600km飛行して海上に落下。日本の防衛当局は、日本のEEZ外に落下したと評価しています。現時点で直接の被害は示されていませんが、日本株では安全保障関連を含めた反応が見られるかが注目されそうです。",
      },
      detail: "日本の防衛当局は、日本のEEZ外に落下したと評価しています。",
      omitted: "日本株では",
    },
    {
      input: {
        title: "UN condemns attempted Houthi strike on Riyadh as Yemen displacement surges past 130,000",
        summary: "The UN has condemned continued cross-border attacks by Houthi forces against Saudi Arabia, including an attempted strike on the capital Riyadh, as fighting inside Yemen drives one of the country’s fastest displacement surges in years.",
        verified_text: "【速報】国連が、フーシ派によるサウジアラビアへの越境攻撃を非難しました。首都リヤドへの攻撃未遂も含まれています。イエメン国内の戦闘を受け、国内避難民は13万人を超えました。中東情勢の緊迫化を示す動きですが、日本株への具体的な影響は確認できていません。",
      },
      detail: "国内避難民は13万人を超えました。",
      omitted: "日本株への具体的な影響は確認できていません。",
    },
    {
      input: {
        title: "Projectile strikes tanker entering Strait of Hormuz, injuring two crew members",
        summary: "The UK Maritime Trade Operations Center reported that a tanker was struck by an unknown projectile as it entered the Strait of Hormuz. Two crew members sustained minor injuries, and the vessel continued toward its next port under its own power.",
        verified_text: "【速報】ホルムズ海峡に進入したタンカーが、不明な飛翔体を受けました。乗組員2人が軽傷を負いましたが、船舶は自力で次の港へ向けて航行を続けています。現時点で、海峡の封鎖や供給障害は確認されていません。",
      },
      detail: "海峡の封鎖や供給障害は確認されていません。",
      omitted: "",
    },
  ] as const;

  for (const fixture of cases) {
    const presentation = buildNewsPresentation({
      ...fixture.input,
      source_url: "https://apnews.com/example",
      company_name: "市場全体",
    });
    assert.ok(presentation.detailParagraphs.some((paragraph) => paragraph.includes(fixture.detail)), fixture.input.title);
    if (fixture.omitted) assert.ok(!presentation.detailParagraphs.join("\n").includes(fixture.omitted), fixture.input.title);
  }
});

test("partition helper omits generic filler but retains a concrete status fact", () => {
  const partition = partitionVerifiedSentences([
    "船舶が自力で次の港へ向けて航行を続けています。",
    "現時点で海峡の封鎖は確認されていません。",
    "日本株では反応が見られるかが注目されそうです。",
  ]);
  assert.deepEqual(partition.keyPoints, ["船舶が自力で次の港へ向けて航行を続けています。", "現時点で海峡の封鎖は確認されていません。"]);
  assert.deepEqual(partition.detail, []);
});
