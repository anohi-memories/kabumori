import assert from "node:assert/strict";
import test from "node:test";
import {
  buildImportantNewsNotificationRows,
  buildImportantNewsNotificationSummary,
  buildImportantNewsNotificationTitle,
  evaluateImportantNewsNotificationEnqueue,
  extractImportantNewsTickerCode,
  IMPORTANT_NEWS_NOTIFICATION_SUMMARY_MAX_CHARACTERS,
  IMPORTANT_NEWS_NOTIFICATION_TITLE_MAX_CHARACTERS,
  type ImportantNewsNotificationSource,
  type ImportantNewsNotificationTarget,
} from "./important_news_notification_logic.ts";
import {
  publishImportantNewsCandidate,
  type PublishCandidate,
  type PublishRepository,
} from "./publish_logic.ts";

const sourceUrl = "https://www.release.tdnet.info/inbs/example.pdf";

function source(
  overrides: Partial<ImportantNewsNotificationSource> = {},
): ImportantNewsNotificationSource {
  return {
    candidateId: "candidate-1",
    companyCode: "79740",
    importance: "most_important",
    title: "業績予想の修正及び配当予想に関するお知らせ",
    bodySummary: "通期の営業利益予想を上方修正し、期末配当も増額する。",
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
    summary: "通期の営業利益予想を上方修正し、期末配当も増額する。",
    importance: "most_important",
    push_status: "pending",
  });
});

test("row keys and values match what the dispatcher reads", () => {
  const [row] = buildImportantNewsNotificationRows(source(), [target()]);
  // send-push-notifications selects push_status='pending' and maps
  // title -> push title, summary -> push body, source_type/source_id -> tap data.
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

test("push text stays within a sane length and never invents content", () => {
  const longTitle = "あ".repeat(200);
  const longSummary = "い".repeat(6000);
  const title = buildImportantNewsNotificationTitle("と".repeat(60), longTitle);
  const summary = buildImportantNewsNotificationSummary(longSummary, longTitle);
  assert.ok(Array.from(title).length <= IMPORTANT_NEWS_NOTIFICATION_TITLE_MAX_CHARACTERS);
  assert.ok(Array.from(summary).length <= IMPORTANT_NEWS_NOTIFICATION_SUMMARY_MAX_CHARACTERS);
  assert.ok(title.endsWith("…"));
  assert.ok(summary.endsWith("…"));
  assert.ok(summary.startsWith("い"));
});

test("a missing body summary falls back to the headline instead of empty text", () => {
  for (const bodySummary of [null, "", "   \n  "]) {
    assert.equal(
      buildImportantNewsNotificationSummary(bodySummary, "業績予想の修正"),
      "業績予想の修正",
    );
  }
});

test("newlines in stored news text are collapsed for the push payload", () => {
  assert.equal(
    buildImportantNewsNotificationSummary("一行目\n\n二行目\t三行目", "見出し"),
    "一行目 二行目 三行目",
  );
});
