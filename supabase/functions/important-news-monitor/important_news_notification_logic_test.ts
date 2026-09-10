import assert from "node:assert/strict";
import test from "node:test";
import {
  buildImportantNewsNotificationRows,
  buildImportantNewsNotificationTitle,
  cleanDisclosureBodySummary,
  evaluateImportantNewsNotificationEnqueue,
  extractImportantNewsTickerCode,
  extractVerifiedPostBody,
  fitImportantNewsNotificationText,
  IMPORTANT_NEWS_NOTIFICATION_EMPTY_FALLBACK,
  IMPORTANT_NEWS_NOTIFICATION_SUMMARY_MAX_CHARACTERS,
  IMPORTANT_NEWS_NOTIFICATION_TITLE_MAX_CHARACTERS,
  selectImportantNewsNotificationSummary,
  type ImportantNewsNotificationSource,
  type ImportantNewsNotificationTarget,
} from "./important_news_notification_logic.ts";
import {
  publishImportantNewsCandidate,
  type PublishCandidate,
  type PublishRepository,
} from "./publish_logic.ts";

const sourceUrl = "https://www.release.tdnet.info/inbs/example.pdf";

// Shapes below are taken from real production candidates (public TDnet disclosures):
// the PDF-scraped body_summary opens with a letterhead and spaced-out characters,
// while the generated X post text is label + prose + a trailing 出典 line.
const SBG_BODY_SUMMARY =
  "本店所在地 東京都港区海岸一丁目 7 番 1 号 会 社 名 ソフトバンクグループ株式会社 " +
  "（コード番号 9984 東証プライム市場） 孫 正義 第 70 回無担保普通社債の条件決定に関するお知らせ " +
  "当社は本日、2026 年８月 24 日付「第 70 回無担保普通社債の発行に関するお知らせ」にて公表しました" +
  "第 70 回無担保普通社債の発行条件を決定しましたので、下記のとおりお知らせいたします。";
const SBG_GENERATED_TEXT =
  "【速報】ソフトバンクグループ（9984）が、第70回無担保普通社債の発行条件を決定しました。" +
  "発行総額は1兆円、利率は年4.75％、年限は7年。各社債の金額・償還金額は100万円です。\n\n" +
  "資金は、国内社債の償還資金とABBロボティクス事業の買収資金の一部に充てる予定です。\n\n" +
  `出典: ${sourceUrl}`;

function source(
  overrides: Partial<ImportantNewsNotificationSource> = {},
): ImportantNewsNotificationSource {
  return {
    candidateId: "candidate-1",
    companyCode: "79740",
    importance: "most_important",
    title: "業績予想の修正及び配当予想に関するお知らせ",
    bodySummary: "各 位 会社名 任天堂株式会社 代表者名 代表取締役社長 （TEL. 075-662-9600） " +
      "業 績 予 想 の 修 正 及 び 配 当 予 想 に 関 す る お 知 ら せ 当社は、通期の営業利益予想を上方修正しました。",
    generatedText: `【重大速報】任天堂が通期の営業利益予想を上方修正しました。期末配当も増額します。\n\n出典: ${sourceUrl}`,
    generationFactStatus: "passed",
    generationVoiceStatus: "passed",
    ...overrides,
  };
}

function target(
  overrides: Partial<ImportantNewsNotificationTarget> = {},
): ImportantNewsNotificationTarget {
  return {
    userId: "user-1",
    trackedStockId: "tracked-1",
    tickerCode: "7974",
    companyName: "任天堂",
    ...overrides,
  };
}

// --- publish gate ----------------------------------------------------------

test("published candidate with an X post id authorizes an enqueue", () => {
  assert.deepEqual(
    evaluateImportantNewsNotificationEnqueue({
      published: true,
      importance: "most_important",
      xPostId: "1234567890",
    }),
    { enqueue: true, reason: "ENQUEUE_ALLOWED" },
  );
});

test("an unpublished outcome never enqueues", () => {
  for (const outcome of [
    { published: false, importance: "most_important", xPostId: null },
    { published: false, importance: "important", xPostId: "1234567890" },
  ]) {
    const decision = evaluateImportantNewsNotificationEnqueue(outcome);
    assert.equal(decision.enqueue, false);
    assert.equal(decision.reason, "NOT_PUBLISHED");
  }
});

test("published without an X post id never enqueues", () => {
  for (const xPostId of [null, "", "   "]) {
    assert.deepEqual(
      evaluateImportantNewsNotificationEnqueue({
        published: true,
        importance: "important",
        xPostId,
      }),
      { enqueue: false, reason: "X_POST_ID_MISSING" },
    );
  }
});

test("only the two safe importance tiers may enqueue", () => {
  for (const importance of ["no_post", "normal", null, "IMPORTANT"]) {
    assert.deepEqual(
      evaluateImportantNewsNotificationEnqueue({
        published: true,
        importance,
        xPostId: "1234567890",
      }),
      { enqueue: false, reason: "IMPORTANCE_NOT_PUSHABLE" },
    );
  }
  for (const importance of ["important", "most_important"]) {
    assert.equal(
      evaluateImportantNewsNotificationEnqueue({
        published: true,
        importance,
        xPostId: "1234567890",
      }).enqueue,
      true,
    );
  }
});

// The publish result is the only authorization the producer gets, so pin the
// dry-run and block paths against the real publish flow rather than a hand-made
// object that could drift from it.
function publishRepository(candidate: PublishCandidate): PublishRepository {
  return {
    read: async () => candidate,
    latestPublishedAt: async () => null,
    claim: async () => ({ ...candidate, status: "publishing" }),
    markPublished: async () => {},
    markFailed: async () => {},
  };
}

test("a publish dry run produces no enqueue authorization", async () => {
  const candidate: PublishCandidate = {
    id: "candidate-1",
    importance: "most_important",
    status: "ready_for_publish",
    generatedText: `【重大速報】重要ニュース本文です。\n\n出典: ${sourceUrl}`,
    generationFactStatus: "passed",
    generationVoiceStatus: "passed",
    sourceUrl,
    xPostId: null,
    publishedAt: null,
    publishAttempts: 0,
  };
  const result = await publishImportantNewsCandidate(
    "candidate-1",
    true,
    publishRepository(candidate),
    async () => {
      throw new Error("DRY_RUN_X_CALL_FORBIDDEN");
    },
    new Date("2026-09-10T04:00:00Z"),
  );
  assert.equal(result.wouldPublish, true);
  assert.equal(result.published, false);
  assert.equal(evaluateImportantNewsNotificationEnqueue(result).enqueue, false);
});

test("a fact-failed candidate blocks publication and therefore the enqueue", async () => {
  const candidate: PublishCandidate = {
    id: "candidate-1",
    importance: "most_important",
    status: "ready_for_publish",
    generatedText: `【重大速報】重要ニュース本文です。\n\n出典: ${sourceUrl}`,
    generationFactStatus: "failed",
    generationVoiceStatus: "passed",
    sourceUrl,
    xPostId: null,
    publishedAt: null,
    publishAttempts: 0,
  };
  const result = await publishImportantNewsCandidate(
    "candidate-1",
    false,
    publishRepository(candidate),
    async () => ({ id: "x-1", httpStatus: 201, refreshExecuted: false }),
    new Date("2026-09-10T04:00:00Z"),
  );
  assert.equal(result.published, false);
  assert.equal(evaluateImportantNewsNotificationEnqueue(result).enqueue, false);
});

// --- targeting / dedupe ----------------------------------------------------

test("ticker extraction mirrors get_my_important_stock_news", () => {
  assert.equal(extractImportantNewsTickerCode("79740"), "7974");
  assert.equal(extractImportantNewsTickerCode(" 46710 "), "4671");
  assert.equal(extractImportantNewsTickerCode("130A0"), "130A");
  for (const value of [null, undefined, "", "7974", "797400", "7974", "abcde", "79-40"]) {
    assert.equal(extractImportantNewsTickerCode(value), null, `expected null for ${String(value)}`);
  }
});

test("market-wide news without a company code targets nobody", () => {
  assert.equal(extractImportantNewsTickerCode(null), null);
  assert.deepEqual(buildImportantNewsNotificationRows(source({ companyCode: null }), []), []);
});

test("a matched tracked stock produces exactly one dispatcher-compatible row", () => {
  const rows = buildImportantNewsNotificationRows(source(), [target()]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    user_id: "user-1",
    tracked_stock_id: "tracked-1",
    source_type: "important_news",
    source_id: "candidate-1",
    title: "【任天堂】業績予想の修正及び配当予想に関するお知らせ",
    summary: "任天堂が通期の営業利益予想を上方修正しました。期末配当も増額します。",
    importance: "most_important",
    push_status: "pending",
  });
});

test("row keys and values match what the dispatcher reads", () => {
  const [row] = buildImportantNewsNotificationRows(source(), [target()]);
  // send-push-notifications selects push_status='pending' and maps
  // title -> push title, summary -> push body, source_type/source_id -> tap data.
  assert.deepEqual(Object.keys(row).sort(), [
    "importance", "push_status", "source_id", "source_type", "summary", "title", "tracked_stock_id", "user_id",
  ]);
  assert.equal(row.push_status, "pending");
  assert.equal(row.source_type, "important_news");
  assert.equal(row.source_id, "candidate-1");
  assert.ok(row.title.length > 0 && row.summary.length > 0);
  // notifications_importance_check only accepts these three values.
  assert.ok(["normal", "important", "most_important"].includes(row.importance));
});

test("users who do not track the stock get no row", () => {
  assert.deepEqual(buildImportantNewsNotificationRows(source(), []), []);
});

test("each targeted user gets one row and rows are deterministic", () => {
  const rows = buildImportantNewsNotificationRows(source(), [
    target({ userId: "user-b", trackedStockId: "tracked-9" }),
    target({ userId: "user-a", trackedStockId: "tracked-2" }),
  ]);
  assert.deepEqual(rows.map((row) => row.user_id), ["user-a", "user-b"]);
});

test("one user tracking the same ticker twice still gets a single stable row", () => {
  const duplicated = [
    target({ trackedStockId: "tracked-9" }),
    target({ trackedStockId: "tracked-2" }),
  ];
  const rows = buildImportantNewsNotificationRows(source(), duplicated);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tracked_stock_id, "tracked-2");
  // Re-running with the targets in the other order must pick the same row, so a
  // repeat producer run collides with notifications_dedupe instead of inserting.
  const rerun = buildImportantNewsNotificationRows(source(), [...duplicated].reverse());
  assert.deepEqual(rerun, rows);
});

test("re-running the producer for the same source yields identical dedupe keys", () => {
  const first = buildImportantNewsNotificationRows(source(), [target()]);
  const second = buildImportantNewsNotificationRows(source(), [target()]);
  const key = (row: { user_id: string; tracked_stock_id: string; source_type: string; source_id: string }) =>
    `${row.user_id}/${row.tracked_stock_id}/${row.source_type}/${row.source_id}`;
  assert.deepEqual(first.map(key), second.map(key));
});

// --- title -------------------------------------------------------------------

test("the push title stays short and keeps the company prefix", () => {
  const title = buildImportantNewsNotificationTitle("と".repeat(60), "あ".repeat(200));
  assert.ok(Array.from(title).length <= IMPORTANT_NEWS_NOTIFICATION_TITLE_MAX_CHARACTERS);
  assert.ok(title.startsWith("【"));
  assert.ok(title.endsWith("…"));
});

// --- body: strategy selection --------------------------------------------------

test("the real SoftBank Group letterhead is never used as the push body", () => {
  const summary = selectImportantNewsNotificationSummary(source({
    companyCode: "99840",
    title: "第70回無担保普通社債の条件決定に関するお知らせ",
    bodySummary: SBG_BODY_SUMMARY,
    generatedText: SBG_GENERATED_TEXT,
  }));
  assert.equal(summary.strategy, "verified_post_text");
  assert.ok(!summary.text.includes("本店所在地"));
  assert.ok(!summary.text.includes("海岸一丁目"));
  assert.ok(summary.text.startsWith("ソフトバンクグループ（9984）が、第70回無担保普通社債の発行条件を決定しました。"));
});

test("verified post text keeps the figures exactly as published", () => {
  const summary = selectImportantNewsNotificationSummary(source({ generatedText: SBG_GENERATED_TEXT }));
  for (const figure of ["1兆円", "年4.75％", "7年", "100万円"]) {
    assert.ok(summary.text.includes(figure), `missing ${figure}: ${summary.text}`);
  }
});

test("the 【速報】 label and the trailing 出典 line are removed from the post text", () => {
  assert.equal(
    extractVerifiedPostBody(`【重大速報】ムトー精工、自社株買いを決定 上限13万株、3億円。\n\n出典: ${sourceUrl}`),
    "ムトー精工、自社株買いを決定 上限13万株、3億円。",
  );
  assert.equal(extractVerifiedPostBody(`【速報】【速報】本文です。\n\n出典：${sourceUrl}`), "本文です。");
  for (const value of [null, undefined, "", `【速報】\n\n出典: ${sourceUrl}`]) {
    assert.equal(extractVerifiedPostBody(value), null);
  }
});

test("post text is only trusted when BOTH Fact and Voice passed", () => {
  for (const [fact, voice] of [["failed", "passed"], ["passed", "failed"], [null, null], ["not_run", "passed"]]) {
    const summary = selectImportantNewsNotificationSummary(source({
      generationFactStatus: fact,
      generationVoiceStatus: voice,
    }));
    assert.notEqual(summary.strategy, "verified_post_text", `${fact}/${voice}`);
    assert.ok(!summary.text.includes("任天堂が通期"), "unverified generated text must not leak into the push");
  }
});

test("without verified text the disclosure prose after the headline is used", () => {
  const summary = selectImportantNewsNotificationSummary(source({
    title: "第70回無担保普通社債の条件決定に関するお知らせ",
    bodySummary: SBG_BODY_SUMMARY,
    generatedText: null,
  }));
  assert.equal(summary.strategy, "cleaned_body_summary");
  assert.ok(summary.text.startsWith("当社は本日、2026年８月24日付"), summary.text);
  assert.ok(!summary.text.includes("本店所在地"));
  assert.ok(!/[　-鿿] [　-鿿]/u.test(summary.text), "PDF character spacing must be removed");
});

test("representative disclosure letterheads are skipped, whatever their shape", () => {
  const cases: Array<{ title: string; body: string; expectStart: string }> = [
    {
      title: "自己株式取得に係る事項の決定に関するお知らせ",
      body: "各 位 会 社 名 ムトー精工 株式会社 代 表 者 代表取締役社長 田 中 肇 電 話 ０５８－３７１－１１００ " +
        "自己株式取得に係る事項の決定に関するお知らせ 当社は、2026 年９月 10 日開催の取締役会において、自己株式取得に係る事項を決議いたしました。",
      expectStart: "当社は、2026年９月10日開催の取締役会において",
    },
    {
      title: "配当予想の修正（増配）に関するお知らせ",
      body: "（TEL. 052-957-5860） 配当予想の修正（増配）に関するお知らせ 当社は、2026 年９月 10 日開催の取締役会において、" +
        "2027 年１月期の配当予想について、下記のとおり修正することを決議いたしました。",
      expectStart: "当社は、2026年９月10日開催の取締役会において、2027年１月期の配当予想",
    },
    {
      title: "経営統合に関する基本合意の解消について",
      body: "各 位 会社名 株式会社あいちフィナンシャルグループ 代表者名 代表取締役社長執行役員 伊藤 行記 " +
        "（コード番号：7389 東証プライム・名証プレミア） 経営統合に関する基本合意の解消について " +
        "当社は、株式会社三十三フィナンシャルグループとの経営統合に関する基本合意を解消することを決定しました。",
      expectStart: "当社は、株式会社三十三フィナンシャルグループとの経営統合",
    },
    {
      // Headline absent from the PDF text: fall back to the first 当社は statement.
      title: "2027年１月期 第２四半期（中間期）決算（補足説明資料）",
      body: "Copyright(c)2026 Mitsui High-tec, Inc. All rights reserved. 当社は、2027 年１月期の通期業績予想を上方修正しました。",
      expectStart: "当社は、2027年１月期の通期業績予想を上方修正しました。",
    },
  ];
  for (const item of cases) {
    const cleaned = cleanDisclosureBodySummary(item.body, item.title);
    assert.ok(cleaned?.startsWith(item.expectStart), `${item.title} -> ${cleaned}`);
    for (const noise of ["各位", "各 位", "代表者", "TEL", "Copyright", "本店所在地"]) {
      assert.ok(!cleaned!.includes(noise), `${item.title} still contains ${noise}`);
    }
  }
});

test("latin words keep their spaces while PDF spacing between Japanese characters is removed", () => {
  const cleaned = cleanDisclosureBodySummary(
    "当 社 は 、 Mitsui High-tec の 株 式 を 取 得 し ま し た 。 詳 細 は 別 紙 の と お り で す 。",
    "見出しが本文に無いケース",
  );
  assert.equal(cleaned, "当社は、Mitsui High-tecの株式を取得しました。詳細は別紙のとおりです。");
});

test("a letterhead with no usable prose falls back to the headline, never to the address", () => {
  const summary = selectImportantNewsNotificationSummary(source({
    title: "第70回無担保普通社債の条件決定に関するお知らせ",
    bodySummary: "本店所在地 東京都港区海岸一丁目 7 番 1 号 会 社 名 ソフトバンクグループ株式会社",
    generatedText: null,
  }));
  assert.equal(summary.strategy, "headline");
  assert.equal(summary.text, "第70回無担保普通社債の条件決定に関するお知らせ");
});

test("empty or broken input never yields an empty body", () => {
  for (const overrides of [
    { title: "", bodySummary: null, generatedText: null },
    { title: "   ", bodySummary: "   ", generatedText: "   ", generationFactStatus: "passed", generationVoiceStatus: "passed" },
    { title: "", bodySummary: "", generatedText: `【速報】\n\n出典: ${sourceUrl}` },
  ] as Array<Partial<ImportantNewsNotificationSource>>) {
    const summary = selectImportantNewsNotificationSummary(source(overrides));
    assert.ok(summary.text.trim().length > 0);
  }
  assert.equal(
    selectImportantNewsNotificationSummary(source({ title: "", bodySummary: null, generatedText: null })).text,
    IMPORTANT_NEWS_NOTIFICATION_EMPTY_FALLBACK,
  );
});

// --- body: length ------------------------------------------------------------

test("long post text is cut at a sentence boundary within the limit", () => {
  const text = fitImportantNewsNotificationText(extractVerifiedPostBody(SBG_GENERATED_TEXT)!);
  assert.ok(Array.from(text).length <= IMPORTANT_NEWS_NOTIFICATION_SUMMARY_MAX_CHARACTERS);
  assert.ok(text.endsWith("。"), text);
  assert.ok(!text.includes("出典"));
});

test("a single over-long sentence is truncated, but never inside a number", () => {
  const sentence = `${"あ".repeat(130)}営業利益は3,000億円に増加`;
  const text = fitImportantNewsNotificationText(sentence);
  assert.ok(Array.from(text).length <= IMPORTANT_NEWS_NOTIFICATION_SUMMARY_MAX_CHARACTERS);
  assert.ok(text.endsWith("…"));
  // The figure "3,000" is either shown whole or not at all.
  assert.ok(!/[0-9０-９,，.．]…$/u.test(text) || text.includes("3,000"), text);
  assert.ok(!text.includes("3,0…") && !text.includes("3…"), text);
});

test("a 。 inside brackets does not end the sentence", () => {
  // Real shape (あいちFG disclosure): an inline definition closes with 「…といいます。」）.
  const prose = "株式会社あいちフィナンシャルグループ（代表取締役社長執行役員伊藤行記、以下「あいちフィナンシャルグループ」といいます。）" +
    "と株式会社三十三フィナンシャルグループは、経営統合に関する基本合意を解消することを決定しました。" +
    "詳細は以下のとおりです。".repeat(10);
  const text = fitImportantNewsNotificationText(prose);
  assert.ok(Array.from(text).length <= IMPORTANT_NEWS_NOTIFICATION_SUMMARY_MAX_CHARACTERS);
  assert.ok(!text.endsWith("といいます。"), text);
  const opened = (text.match(/[（「]/gu) ?? []).length;
  const closed = (text.match(/[）」]/gu) ?? []).length;
  assert.ok(text.endsWith("…") || opened === closed, `unbalanced brackets: ${text}`);
});

test("short text passes through unchanged apart from whitespace", () => {
  assert.equal(fitImportantNewsNotificationText("  一行目\n\n二行目。 "), "一行目 二行目。");
});

test("the row summary is the selected body and stays within the limit", () => {
  const longPost = `【速報】${"長い本文です。".repeat(40)}\n\n出典: ${sourceUrl}`;
  const [row] = buildImportantNewsNotificationRows(source({ generatedText: longPost }), [target()]);
  assert.ok(Array.from(row.summary).length <= IMPORTANT_NEWS_NOTIFICATION_SUMMARY_MAX_CHARACTERS);
  assert.ok(row.summary.startsWith("長い本文です。"));
});
