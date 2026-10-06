// The three points are the day's headlines, not three metric lines (2026-10-05 close: 「日経平均は69,946.86
// （前日比+2.40%）。」「TOPIX連動ETF（1306）は436.3円（前日比+1.42%）。」「10月2日のSOXは13,136.67（前日比+2.40%）。」).
// Morning points are what to watch / be careful about today; close points are what happened, what mattered
// and what to watch next. The values move to the context paragraph and the app story. Every hard check
// still applies to the points; the editorial check is telemetry and never costs a generation.
import assert from "node:assert/strict";
import test from "node:test";
import type { MarketReportPacket } from "../_shared/market_report_packet.ts";
import {
  type GeneratedAnalysis,
  generateSharedAnalysis,
  generationRequestBody,
  isMetricRecapPoint,
  localAnalysisCheck,
  pointsEditorialWarnings,
  qualityRewriteHints,
  type Requester,
} from "./analysis_logic.ts";
import { inputOf, loadFixture, richClose1001 } from "./test_support.ts";

const morningInput = inputOf(await loadFixture("morning_2026-10-02"));
const closeInput = inputOf(await loadFixture("close_2026-10-01"));
const delivered1002: MarketReportPacket = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/morning_2026-10-02_generated_report.json", import.meta.url)),
).payload;
const LIVE_1005_CLOSE_POINTS = [
  "日経平均は69,946.86（前日比+2.40%）。",
  "TOPIX連動ETF（1306）は436.3円（前日比+1.42%）。",
  "10月2日のSOXは13,136.67（前日比+2.40%）。",
];
const has = (issues: string[], fragment: string) => issues.some((issue) => issue.includes(fragment));
const recap = (warnings: string[]) => warnings.filter((warning) => warning.startsWith("X_POINTS_"));

/** The 10/2 morning generation (US 10/1 up, Tokyo 10/1 up) with its points replaced. */
function morning(points: string[]): GeneratedAnalysis {
  const p = structuredClone(delivered1002);
  return {
    headline_ja: p.headline_ja, market_summary_ja: p.market_summary_ja, claims: p.claims,
    key_news: p.key_news.map((news) => ({ ref: news.ref_id, why_it_matters_ja: news.why_it_matters_ja })),
    strong_themes: p.strong_themes, weak_themes: p.weak_themes, next_watch_ja: p.next_watch_ja, risks_ja: p.risks_ja,
    x_post: { ...p.x_post, points_ja: points }, app_story: p.app_story,
  };
}

function close(points: string[]): GeneratedAnalysis {
  const analysis = richClose1001(closeInput);
  analysis.x_post.points_ja = points;
  return analysis;
}

function requester(payloads: unknown[], calls: string[]): Requester {
  return (step) => {
    calls.push(step);
    const payload = step === "fact" ? { passed: true, issues: [] } : payloads.shift();
    return Promise.resolve({ payload, inputTokens: 1000, outputTokens: 400 });
  };
}

test("prompt: the points are headlines with a morning role and a close role", () => {
  const morningPrompt = String(generationRequestBody(morningInput, []).instructions);
  const closePrompt = String(generationRequestBody(closeInput, []).instructions);
  for (const prompt of [morningPrompt, closePrompt]) {
    assert.ok(prompt.includes("points_ja: ちょうど3つ、各40字以内の見出し"));
    assert.ok(prompt.includes("最低1つ入れます"), "each headline carries a specific word of the day");
    assert.ok(prompt.includes("どの日にも当てはまる見出しは書きません"));
    assert.ok(prompt.includes("数値そのものがその日の出来事である場合は、数値を入れた見出しにしてかまいません"), "milestone exception");
    assert.ok(prompt.includes("入力だけでは確かめられない記録の言葉は使いません"), "no unprovable records");
    assert.ok(prompt.includes("もっとも重要な別々のテーマを選びます"));
    assert.ok(prompt.includes("根拠の無い理由を見出しにしない"));
  }
  assert.ok(morningPrompt.includes("朝刊の3つのポイントは、今日の「注目点」「注意点」「相場を見る軸」"));
  assert.ok(morningPrompt.includes("上昇した・下落したと言い切りません"));
  assert.ok(!morningPrompt.includes("大引けの3つのポイント"));
  assert.ok(closePrompt.includes("「何が起きたか」「何が重要だったか（根拠のある材料）」「次に何を見るか」"));
  assert.ok(closePrompt.includes("causal の claim がある"));
  assert.ok(closePrompt.includes("理由が確認できないことを正直に書きます"));
  assert.ok(!closePrompt.includes("朝刊の3つのポイント"));
});

test("recap: a metric with its value, or a metric with only a direction, is a recap; a headline is not", () => {
  for (
    const point of [
      ...LIVE_1005_CLOSE_POINTS,
      "日経平均 68,956.72円",
      "TOPIX連動ETF +0.67%",
      "NYダウ +0.42%",
      "日経平均 +1.20%",
      "1306 +0.85%",
      "SOX +2.1%",
      "9月30日の米国はNYダウ−0.86%、ナスダック総合+0.24%",
      "米国株も上昇",
      "日経平均とTOPIX連動ETF（1306）がそろって上昇📈",
    ]
  ) assert.equal(isMetricRecapPoint(point), true, point);
  for (
    const point of [
      "前夜の米株高を日本株が引き継げるか",
      "半導体株の強さが続くかに注目",
      "円相場の変化には要注意",
      "米重要指標を前に様子見ムードも",
      "主要指数がそろって上昇、主因は絞れず",
      "上昇したが、主因は一つに絞れず",
      "G7が原油の協調放出で合意",
      "明日は米指標と為替を確認",
    ]
  ) assert.equal(isMetricRecapPoint(point), false, point);
});

test("recap: three (or two) metric lines are recorded; one number inside a headline set is not", () => {
  assert.deepEqual(pointsEditorialWarnings(LIVE_1005_CLOSE_POINTS), ["X_POINTS_METRIC_RECAP:3"]);
  assert.deepEqual(pointsEditorialWarnings([...LIVE_1005_CLOSE_POINTS.slice(0, 2), "G7が原油の協調放出で合意"]), [
    "X_POINTS_METRIC_RECAP:2",
  ]);
  // A number that is the news itself (a policy rate) may lead one headline.
  assert.deepEqual(pointsEditorialWarnings(["日銀が政策金利を0.75%に引き上げ", "円相場の変化には要注意", "次は銀行株の反応を確認"]), []);
});

test("duplicates: the same point said twice is recorded; distinct roles are not", () => {
  assert.deepEqual(pointsEditorialWarnings(["日経平均が大幅に上昇した", "日経平均が大幅に上昇して終えた", "ユーロ圏のGDP改定値を確認"]), [
    "X_POINTS_NEAR_DUPLICATE",
  ]);
  assert.deepEqual(pointsEditorialWarnings(["日経平均が大幅高、上昇の主因は絞れず", "G7が原油の協調放出で合意", "次は米国株と為替の反応を確認"]), []);
});

test("morning: watch / caution headlines on rich prior-session data pass every hard check without a points warning", () => {
  const check = localAnalysisCheck(
    morning(["前夜の米株高を日本株が引き継げるか", "半導体株の強さが続くかに注目", "為替の動きには要注意"]),
    morningInput,
  );
  assert.deepEqual(check.hard, []);
  assert.deepEqual(recap(check.warnings), []);
});

test("morning: a headline that turns the prior-night move around is still a hard failure", () => {
  const check = localAnalysisCheck(
    morning(["米国株の下落を日本株が引き継ぐか", "半導体株の強さが続くかに注目", "為替の動きには要注意"]),
    morningInput,
  );
  assert.ok(has(check.hard, "方向の逆転"), check.hard.join("\n"));
});

test("close: recap / material / next-watch headlines with honest uncertainty pass", () => {
  const check = localAnalysisCheck(
    close(["日経平均が大幅高、上昇の主因は絞れず", "韓国の9月輸出が過去最高", "次は米国株の方向とドル円を確認"]),
    closeInput,
  );
  assert.deepEqual(check.hard, []);
  assert.deepEqual(recap(check.warnings), [], "one generic watch point is allowed");
});

test("close: a market cause the news does not state cannot become a headline", () => {
  for (const cause of ["米国株高を受けて日本株が上昇", "半導体輸出の増加を背景に日経平均が上昇"]) {
    const check = localAnalysisCheck(close([cause, "韓国の9月輸出が過去最高", "次は米国株の方向とドル円を確認"]), closeInput);
    assert.ok(has(check.hard, "根拠の無い因果"), `${cause}\n${check.hard.join("\n")}`);
  }
});

test("close: wrong-date values and the 1306 identity are still checked inside a headline", () => {
  const wrongDate = localAnalysisCheck(close(["9月30日の日経平均は68,956.72で上昇", "韓国の9月輸出が過去最高", "次は米国株を確認"]), closeInput);
  assert.ok(has(wrongDate.hard, "日付と指標の不一致"), wrongDate.hard.join("\n"));
  const topix = localAnalysisCheck(close(["TOPIXが小幅に上昇", "韓国の9月輸出が過去最高", "次は米国株を確認"]), closeInput);
  assert.ok(topix.hard.length > 0, "1306 written as TOPIX stays hard");
});

test("exactly three points stays a hard requirement", () => {
  const check = localAnalysisCheck(close(["日経平均が大幅高、上昇の主因は絞れず", "韓国の9月輸出が過去最高"]), closeInput);
  assert.ok(check.hard.includes("X_POST_POINTS_INVALID"));
});

test("a metric-recap draft is delivered as is: recorded, no rewrite, the call count unchanged", async () => {
  assert.deepEqual(qualityRewriteHints(["X_POINTS_METRIC_RECAP:3", "X_POINTS_NEAR_DUPLICATE"]), []);
  // The 10/5 shape on the 10/1 input: three correct 10/1 metric lines.
  const calls: string[] = [];
  const lines = ["日経平均は68,956.72（前日比+3.30%）", "TOPIX連動ETF（1306）は434.4円（前日比+0.67%）", "10月1日の東京市場は上昇"];
  const outcome = await generateSharedAnalysis(closeInput, requester([close(lines)], calls), () => new Date("2026-10-01T06:20:30Z"));
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, ["generate", "fact"]);
  assert.ok(outcome.ok && (outcome.packet.fact.quality_warnings ?? []).includes("X_POINTS_METRIC_RECAP:3"));
  assert.equal(outcome.trace.qualityRewrite, false);
});
