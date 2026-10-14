// ゆめちゃん（AI 評論家）の見立て (2026-10-13, F2): the morning call, the close's look-back decided in code against the
// immutable morning record, the next-session view, and every guard that keeps opinion apart from fact. Offline: real
// repository fixtures, scripted model answers, a fake PostgREST for the handler.
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalysisInput } from "./analysis_input.ts";
import {
  assemblePacket,
  factRequestBody,
  FACT_INSTRUCTIONS,
  type GeneratedAnalysis,
  generateSharedAnalysis,
  generationRequestBody,
  localAnalysisCheck,
  type Requester,
  yumeReviewConsistent,
} from "./analysis_logic.ts";
import { type Deps, handleRequest, loadMorningReport } from "./handler.ts";
import { inputOf, loadFixture, richClose0930, richMorning1001, YUME_CLOSE_FIXTURE, YUME_MORNING_FIXTURE } from "./test_support.ts";
import { formatSharedXPost, REPORT_DISCLAIMER_JA, sharedXPostIssues } from "../_shared/market_report_packet.ts";
import { buildAppMarketStory } from "../_shared/market_report_story.ts";
import {
  evaluateMorningForecast,
  morningForecastOf,
  parseChangeDisplay,
  verdictOf,
  YUME_FLAT_BAND_PCT,
  YUME_VERSION,
  type YumeMorningSource,
} from "../_shared/market_report_yume.ts";

const close0930 = await loadFixture("close_2026-09-30");
const morning1001 = await loadFixture("morning_2026-10-01");
const PASS = { passed: true, issues: [], objective_issues: [] };
const MORNING_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** A stored morning packet of 9/30 as the morning run would have written it (only the fields the look-back reads). */
function morningPacket(overrides: Record<string, unknown> = {}, yume: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    report_type: "morning",
    trading_date: "2026-09-30",
    headline_ja: "朝刊の見出し",
    yume: {
      version: YUME_VERSION, target: "nikkei225", horizon: "this_session", horizon_date: "2026-09-30", flat_band_pct: 0.3,
      stance: "up", headline_ja: "きょうは買いが入りやすい一日とみています", reasons_ja: "理由", scenario_ja: "", counter_ja: "反対", invalidation_ja: "外れる条件",
      ...yume,
    },
    ...overrides,
  };
}
const source = (packet: unknown): YumeMorningSource => ({ packetId: MORNING_ID, packet });
const closeInput = (morning: YumeMorningSource) =>
  buildAnalysisInput({ dataPacket: close0930.data.payload, dataPacketId: close0930.data.id, dataContentHash: close0930.data.content_hash, newsRows: close0930.news, morning });

function scripted(steps: Array<{ step: "generate" | "fact"; payload: unknown }>): Requester {
  return (step) => {
    const next = steps.shift();
    assert.ok(next, `unexpected ${step} call`);
    assert.equal(next.step, step);
    return Promise.resolve({ payload: next.payload, inputTokens: 1000, outputTokens: 400 });
  };
}

// ---- the verdict (code, fixed in advance) ---------------------------------------------------------------------------

test("verdict: same stance is a hit; a call against a day inside the band is partial; the opposite is a miss", () => {
  const band = 0.3;
  assert.equal(verdictOf("up", 1.94, band), "hit");
  assert.equal(verdictOf("down", -0.5, band), "hit");
  assert.equal(verdictOf("flat", 0.29, band), "hit");
  assert.equal(verdictOf("flat", -0.29, band), "hit");
  assert.equal(verdictOf("up", 0.1, band), "partial", "up called, the day ended inside the band");
  assert.equal(verdictOf("down", 0.29, band), "partial");
  assert.equal(verdictOf("flat", 0.45, band), "partial", "flat called, a small move");
  assert.equal(verdictOf("flat", -0.59, band), "partial");
  assert.equal(verdictOf("flat", 0.6, band), "miss", "flat called, a move of two bands or more");
  assert.equal(verdictOf("up", -1.2, band), "miss");
  assert.equal(verdictOf("down", 0.3, band), "miss", "the band edge counts as a move");
});

test("the change is read only from the input's own display form", () => {
  assert.equal(parseChangeDisplay("+1.94%"), 1.94);
  assert.equal(parseChangeDisplay("−0.45%"), -0.45);
  assert.equal(parseChangeDisplay("±0.00%"), 0);
  for (const bad of [null, "", "1.94%", "+1.9%", "-0.45%", "+1.94", "上昇"]) assert.equal(parseChangeDisplay(bad), null, String(bad));
});

test("the look-back uses the band stored in the morning record, never today's constant", () => {
  const actual = { sessionDate: "2026-09-30", changeDisplay: "+0.40%", freshness: "fresh" as const };
  const at = (band: number) => evaluateMorningForecast({ tradingDate: "2026-09-30", morning: source(morningPacket({}, { stance: "flat", flat_band_pct: band })), actual });
  assert.equal(at(0.3).verdict, "partial");
  assert.equal(at(0.5).verdict, "hit", "the morning's own band decides");
  assert.equal(at(0.5).flat_band_pct, 0.5);
});

test("nothing is reconstructed: every missing or mismatched record is 「判定できません」 with its own reason", () => {
  const actual = { sessionDate: "2026-09-30", changeDisplay: "+1.94%", freshness: "fresh" as const };
  const reason = (morning: YumeMorningSource, a: typeof actual | null = actual) =>
    evaluateMorningForecast({ tradingDate: "2026-09-30", morning, actual: a });
  const cases: Array<[string, ReturnType<typeof reason>]> = [
    ["NO_MORNING_REPORT", reason(null)],
    ["MORNING_READ_FAILED", reason("error")],
    ["MORNING_TARGET_MISMATCH", reason(source(morningPacket({ trading_date: "2026-09-29" })))],
    ["MORNING_TARGET_MISMATCH", reason(source(morningPacket({ report_type: "close" })))],
    ["NO_MORNING_FORECAST", reason(source({ ...morningPacket(), yume: undefined }))],
    ["FORECAST_DEFINITION_INVALID", reason(source(morningPacket({}, { target: "topix_proxy_1306" })))],
    ["FORECAST_DEFINITION_INVALID", reason(source(morningPacket({}, { horizon_date: "2026-09-29" })))],
    ["FORECAST_DEFINITION_INVALID", reason(source(morningPacket({}, { horizon: "next_session" })))],
    ["FORECAST_DEFINITION_INVALID", reason(source(morningPacket({}, { stance: "mixed" })))],
    ["FORECAST_DEFINITION_INVALID", reason(source(morningPacket({}, { flat_band_pct: 0 })))],
    ["FORECAST_DEFINITION_INVALID", reason(source(morningPacket({}, { version: "yume.v0" })))],
    ["ACTUAL_UNAVAILABLE", reason(source(morningPacket()), null)],
    ["ACTUAL_NOT_THIS_SESSION", reason(source(morningPacket()), { ...actual, freshness: "stale" as never })],
    ["ACTUAL_NOT_THIS_SESSION", reason(source(morningPacket()), { ...actual, sessionDate: "2026-09-29" })],
    ["ACTUAL_CHANGE_UNAVAILABLE", reason(source(morningPacket()), { ...actual, changeDisplay: null as never })],
  ];
  for (const [code, review] of cases) {
    assert.deepEqual([review.verdict, review.reason_code], ["undeterminable", code], code);
    assert.equal(review.actual_change_pct, null, `${code}: no actual is recorded as compared`);
  }
  // A comparable record still stores who it compared.
  const hit = reason(source(morningPacket()));
  assert.deepEqual(
    [hit.verdict, hit.reason_code, hit.morning_report_packet_id, hit.morning_stance, hit.actual_change_pct, hit.actual_change_display],
    ["hit", "COMPARED", MORNING_ID, "up", 1.94, "+1.94%"],
  );
  assert.equal(morningForecastOf(morningPacket(), "2026-09-30").ok, true);
});

test("the review text must say the code's verdict and no other", () => {
  assert.equal(yumeReviewConsistent("朝の予想は当たりでした。", "hit"), true);
  assert.equal(yumeReviewConsistent("朝の予想は外れました。", "hit"), false);
  assert.equal(yumeReviewConsistent("部分的に当たりという結果です。", "partial"), true);
  assert.equal(yumeReviewConsistent("当たりでした。", "partial"), false);
  assert.equal(yumeReviewConsistent("朝の予想は外れました。読み違えたのは為替です。", "miss"), true);
  assert.equal(yumeReviewConsistent("当たりでした。", "miss"), false);
  assert.equal(yumeReviewConsistent("朝の予想は当たりませんでした。外れです。", "miss"), true);
  assert.equal(yumeReviewConsistent("記録が無いので答え合わせができません。", "undeterminable"), true);
  assert.equal(yumeReviewConsistent("たぶん当たりだったと思います。", "undeterminable"), false);
});

// ---- morning: the call ------------------------------------------------------------------------------------------------

test("morning: the prompt and the schema ask for ゆめちゃん's call; the stored packet fixes target, date and band", async () => {
  const input = inputOf(morning1001);
  const body = generationRequestBody(input, []);
  const instructions = String(body.instructions);
  assert.ok(instructions.includes("AI評論家「ゆめちゃん」"));
  assert.ok(instructions.includes("きょう（取引日）の日経平均の終値"));
  assert.ok(instructions.includes("yume 以外の項目では今日の値動きを予想せず"), "the fact sections still do not forecast");
  const schema = (body.text as { format: { schema: { required: string[]; properties: Record<string, { required: string[] }> } } }).format.schema;
  assert.ok(schema.required.includes("yume"));
  assert.deepEqual(schema.properties.yume.required, ["stance", "headline_ja", "reasons_ja", "scenario_ja", "counter_ja", "invalidation_ja", "review_ja"]);
  assert.equal((input.modelInput as Record<string, unknown>)["ゆめちゃんの予想の基準"], "日経平均の前日比が±0.3%未満なら横ばい、それ以上なら上昇・下落");

  const outcome = await generateSharedAnalysis(input, scripted([
    { step: "generate", payload: richMorning1001(input) }, { step: "fact", payload: PASS },
  ]), () => new Date("2026-09-30T22:56:00Z"));
  assert.equal(outcome.ok, true);
  const packet = outcome.ok ? outcome.packet : null!;
  assert.deepEqual(
    [packet.yume?.version, packet.yume?.target, packet.yume?.horizon, packet.yume?.horizon_date, packet.yume?.flat_band_pct, packet.yume?.stance],
    [YUME_VERSION, "nikkei225", "this_session", packet.trading_date, YUME_FLAT_BAND_PCT, "up"],
  );
  assert.equal(packet.yume?.review, undefined, "a morning has no look-back");
  // The morning record is exactly what tomorrow's... today's close will judge.
  assert.equal(morningForecastOf(packet, packet.trading_date).ok, true);

  // X: her call is the closing paragraph; one disclaimer; postable.
  const post = formatSharedXPost(packet);
  // Phase 2: her lines carry their own 🔮 and close the post without the 💬 title.
  assert.ok(post.includes(`\n\n🔮ゆめちゃんの予想：きょうの日経平均は「上昇」とみています。${YUME_MORNING_FIXTURE.headline_ja}`), post);
  assert.ok(!post.includes("💬 今日のひとこと"), post);
  assert.equal(post.split(REPORT_DISCLAIMER_JA).length, 2);
  assert.deepEqual(sharedXPostIssues(packet, post), []);
  // App: her own section, with the rule and the counter-arguments.
  const yume = buildAppMarketStory(packet).sections.find((item) => item.key === "yume")!;
  assert.equal(yume.heading_ja, "🔮 ゆめちゃんの予想");
  assert.deepEqual(yume.lines_ja.slice(0, 2), ["予想：きょうの日経平均は「上昇」", "基準：日経平均の前日比が±0.3%未満なら横ばい、それ以上なら上昇・下落"]);
  assert.ok(yume.lines_ja.includes(`反対の材料：${YUME_MORNING_FIXTURE.counter_ja}`));
  assert.ok(yume.lines_ja.includes(`外れるとしたら：${YUME_MORNING_FIXTURE.invalidation_ja}`));
});

// ---- close: the look-back and the next view -------------------------------------------------------------------------

test("close: the morning call is judged in code and given to the model as a fixed fact; her words are kept when they agree", async () => {
  const input = closeInput(source(morningPacket()));
  assert.deepEqual([input.yumeReview?.verdict, input.yumeReview?.reason_code], ["hit", "COMPARED"]);
  const given = (input.modelInput as Record<string, Record<string, unknown>>)["朝刊の予想との答え合わせ"];
  assert.deepEqual(given, {
    判定: "当たり",
    朝刊の予想: "上昇",
    朝刊の見立て: "きょうは買いが入りやすい一日とみています",
    判定の基準: "日経平均の前日比が±0.3%未満なら横ばい、それ以上なら上昇・下落",
    実績: "9月30日の日経平均 前日比+1.94%",
  });
  assert.ok(String(generationRequestBody(input, []).instructions).includes("判定を変えたり"), "the close prompt forbids re-judging");

  const review = "朝の予想は当たりでした。買いが入りやすいという見立てどおりの一日だったと思います。";
  const analysis: GeneratedAnalysis = { ...richClose0930(input), yume: { ...YUME_CLOSE_FIXTURE, review_ja: review } };
  const outcome = await generateSharedAnalysis(input, scripted([{ step: "generate", payload: analysis }, { step: "fact", payload: PASS }]), () => new Date("2026-09-30T07:21:00Z"));
  assert.equal(outcome.ok, true);
  const packet = outcome.ok ? outcome.packet : null!;
  assert.deepEqual(
    [packet.yume?.horizon, packet.yume?.horizon_date, packet.yume?.review?.verdict, packet.yume?.review?.morning_report_packet_id, packet.yume?.review?.text_ja],
    ["next_session", null, "hit", MORNING_ID, review],
  );
  const post = formatSharedXPost(packet);
  assert.ok(post.includes("\n\n🔮朝の予想は「上昇」→ 結果は「当たり」（日経平均 前日比+1.94%）\nゆめちゃんの次の見立ては「横ばい」。"), post);
  assert.deepEqual(sharedXPostIssues(packet, post), []);
  const check = buildAppMarketStory(packet).sections.find((item) => item.key === "morning_check")!;
  assert.deepEqual(check.lines_ja.slice(0, 2), ["ゆめちゃんの予想の答え合わせ：朝の予想は「上昇」→ 結果は「当たり」（日経平均 前日比+1.94%）", review]);
  assert.equal(buildAppMarketStory(packet).sections.find((item) => item.key === "yume")!.heading_ja, "🔮 ゆめちゃんの次の見立て");
});

test("close: a review that contradicts the code's verdict is dropped (the verdict stands), recorded, and costs no extra call", async () => {
  const input = closeInput(source(morningPacket({}, { stance: "down" })));
  assert.equal(input.yumeReview?.verdict, "miss");
  const analysis: GeneratedAnalysis = { ...richClose0930(input), yume: { ...YUME_CLOSE_FIXTURE, review_ja: "朝の予想はほぼ当たりだったと言えそうです。" } };
  assert.ok(localAnalysisCheck(analysis, input).warnings.includes("YUME_REVIEW_INCONSISTENT:miss"));
  const requested: string[] = [];
  const steps: Array<{ step: "generate" | "fact"; payload: unknown }> = [{ step: "generate", payload: analysis }, { step: "fact", payload: PASS }];
  const counting: Requester = (step, body) => {
    requested.push(step);
    return scripted(steps.slice(requested.length - 1))(step, body);
  };
  const outcome = await generateSharedAnalysis(input, counting, () => new Date("2026-09-30T07:21:00Z"));
  assert.deepEqual(requested, ["generate", "fact"], "no rewrite call is bought by her findings");
  const packet = outcome.ok ? outcome.packet : null!;
  assert.deepEqual([packet.yume?.review?.verdict, packet.yume?.review?.text_ja], ["miss", ""]);
  assert.ok(formatSharedXPost(packet).includes("🔮朝の予想は「下落」→ 結果は「外れ」"));
});

test("close without a morning call: 「判定できません」 in the app, nothing invented, and the X digest keeps only her next view", () => {
  const input = closeInput(null);
  const given = (input.modelInput as Record<string, Record<string, unknown>>)["朝刊の予想との答え合わせ"];
  assert.deepEqual(given, { 判定: "判定できません", 比べられない理由: "この日の朝刊が見つかりません", 朝刊の予想: null, 朝刊の見立て: null });
  const packet = assemblePacket(input, richClose0930(input), { generatedAt: new Date("2026-09-30T07:21:00Z"), attempts: 1 });
  assert.deepEqual([packet.yume?.review?.verdict, packet.yume?.review?.reason_code], ["undeterminable", "NO_MORNING_REPORT"]);
  assert.equal(packet.yume?.review?.text_ja, YUME_CLOSE_FIXTURE.review_ja, "her words say it cannot be judged");
  const post = formatSharedXPost(packet);
  assert.ok(!post.includes("結果は「"), "no verdict on X");
  assert.ok(post.includes("\n\n🔮ゆめちゃんの次の見立ては「横ばい」。"), post);
  const check = buildAppMarketStory(packet).sections.find((item) => item.key === "morning_check")!;
  assert.equal(check.lines_ja[0], "ゆめちゃんの予想の答え合わせ：朝の予想との答え合わせはできません（この日の朝刊が見つかりません）");
});

// ---- guards: opinion never carries an invented fact ----------------------------------------------------------------

test("an invented number, date or advice in her call is removed; without a safe headline or reasons her call is left out", async () => {
  const input = inputOf(morning1001);
  const base = richMorning1001(input);
  const cases: Array<[string, Partial<GeneratedAnalysis["yume"] & object>, "kept" | "dropped"]> = [
    ["a target level not in the input", { headline_ja: "きょうの日経平均は70,000円を目指すとみています" }, "dropped"],
    ["a made-up date", { reasons_ja: "10月20日の日銀会合が支えになると考えています。" }, "dropped"],
    ["certainty", { headline_ja: "きょうは必ず上がるとみています" }, "dropped"],
    ["advice", { reasons_ja: "いまが買い時だと考えています。" }, "dropped"],
    // (A small bare number such as 「3兆円」 can match a digit elsewhere in the input: the existing number guard's limit.)
    ["an invented number in the counter only", { counter_ja: "海外勢が4,321億円売る可能性もあります。" }, "kept"],
  ];
  for (const [label, yume, expected] of cases) {
    const analysis: GeneratedAnalysis = { ...base, yume: { ...YUME_MORNING_FIXTURE, ...yume } };
    const outcome = await generateSharedAnalysis(input, scripted([{ step: "generate", payload: analysis }, { step: "fact", payload: PASS }]), () => new Date("2026-09-30T22:56:00Z"));
    assert.equal(outcome.ok, true, `${label}: the report is still delivered`);
    const packet = outcome.ok ? outcome.packet : null!;
    if (expected === "dropped") {
      assert.equal(packet.yume, undefined, label);
      assert.ok(packet.fact.removed_units?.some((unit) => unit.startsWith("UNIT_REMOVED:YUME_DROPPED@yume")), label);
      assert.equal(packet.x_post.closing_ja, base.x_post.closing_ja, `${label}: the model's own closing is the fallback`);
    } else {
      assert.equal(packet.yume?.counter_ja, "", label);
      assert.ok(packet.fact.removed_units?.some((unit) => unit.includes("@yume.counter_ja")), label);
    }
    const all = JSON.stringify(packet);
    for (const leaked of ["70,000", "10月20日", "必ず上がる", "買い時", "4,321億円"]) assert.ok(!all.includes(leaked), `${label}: ${leaked}`);
  }
});

test("a past fact stated the wrong way round inside her call is removed like any other wrong fact", async () => {
  const input = closeInput(null);
  // 9/30: the Nikkei rose 1.94%. Stating it fell is a wrong fact, opinion section or not.
  const analysis: GeneratedAnalysis = { ...richClose0930(input), yume: { ...YUME_CLOSE_FIXTURE, reasons_ja: "9月30日の日経平均は66,753.72（前日比+1.94%）と下落しました。あすは様子見になりやすいと考えています。" } };
  const outcome = await generateSharedAnalysis(input, scripted([{ step: "generate", payload: analysis }, { step: "fact", payload: PASS }]), () => new Date("2026-09-30T07:21:00Z"));
  assert.equal(outcome.ok, true);
  const packet = outcome.ok ? outcome.packet : null!;
  assert.equal(packet.yume?.reasons_ja, "あすは様子見になりやすいと考えています。", "only the wrong sentence is removed");
  assert.ok(packet.fact.removed_units?.includes("UNIT_REMOVED:WRONG_DIRECTION@yume.reasons_ja#0"));
});

test("older output without ゆめちゃん renders as before (no section, the model's closing, no warning, no extra call)", async () => {
  const input = inputOf(morning1001);
  const { yume: _yume, ...older } = richMorning1001(input);
  const outcome = await generateSharedAnalysis(input, scripted([{ step: "generate", payload: older }, { step: "fact", payload: PASS }]), () => new Date("2026-09-30T22:56:00Z"));
  assert.equal(outcome.ok && outcome.calls, 2);
  const packet = outcome.ok ? outcome.packet : null!;
  assert.equal(packet.yume, undefined);
  assert.equal(packet.x_post.closing_ja, older.x_post.closing_ja);
  assert.ok(!buildAppMarketStory(packet).sections.some((item) => item.key === "yume"));
  assert.ok(!(packet.fact.quality_warnings ?? []).some((warning) => warning.startsWith("YUME_")));
});

test("the Fact check sees her call and is told it is opinion, but still checks the facts inside it and the verdict", () => {
  const input = closeInput(source(morningPacket()));
  const analysis: GeneratedAnalysis = { ...richClose0930(input), yume: YUME_CLOSE_FIXTURE };
  const body = factRequestBody(input, analysis);
  const sent = JSON.parse(String(body.input));
  assert.deepEqual(sent.analysis.yume, YUME_CLOSE_FIXTURE);
  assert.equal(sent.input["朝刊の予想との答え合わせ"]["判定"], "当たり");
  assert.ok(FACT_INSTRUCTIONS.includes("analysis.yume は、AI評論家「ゆめちゃん」の予想・見立て（意見）です"));
  assert.ok(FACT_INSTRUCTIONS.includes("「判定」と違う判定を書いていたら問題にします"));
});

// ---- handler: the morning record as stored ---------------------------------------------------------------------------

test("loadMorningReport reads the completed morning cycle's current packet only; anything else is none or an error", async () => {
  const db = (cycles: unknown, packets: unknown, fail = false) => {
    const paths: string[] = [];
    return {
      paths,
      get: <T>(path: string): Promise<T> => {
        paths.push(path);
        if (fail) return Promise.reject(new Error("REST_GET_FAILED"));
        return Promise.resolve((path.startsWith("market_report_cycles") ? cycles : packets) as T);
      },
    };
  };
  const ok = db([{ report_status: "completed", current_report_packet_id: MORNING_ID }], [{ id: MORNING_ID, payload: morningPacket() }]);
  assert.deepEqual(await loadMorningReport(ok, "2026-09-30"), { packetId: MORNING_ID, packet: morningPacket() });
  assert.deepEqual(ok.paths, [
    "market_report_cycles?select=report_status,current_report_packet_id&report_type=eq.morning&trading_date=eq.2026-09-30",
    `market_report_packets?select=id,payload&id=eq.${MORNING_ID}`,
  ]);
  assert.equal(await loadMorningReport(db([], []), "2026-09-30"), null, "no morning cycle");
  assert.equal(await loadMorningReport(db([{ report_status: "failed", current_report_packet_id: null }], []), "2026-09-30"), null);
  assert.equal(await loadMorningReport(db([{ report_status: "completed", current_report_packet_id: MORNING_ID }], []), "2026-09-30"), "error");
  assert.equal(await loadMorningReport(db(null, null, true), "2026-09-30"), "error");
  const injected = db([], []);
  assert.equal(await loadMorningReport(injected, "2026-09-30&report_type=eq.close"), "error");
  assert.deepEqual(injected.paths, [], "a malformed date is never put in a query");
});

test("handler E2E: the close run reads the morning record, stores the code's verdict, and the morning run reads nothing", async () => {
  const SUPABASE = "https://project-ref.supabase.co";
  const SECRET = "cron-secret-for-tests";
  const run = async (mode: "close" | "morning", morningRows: { cycles: unknown; packets: unknown } | "throw") => {
    const fixture = mode === "close" ? close0930 : morning1001;
    const analysis = mode === "close"
      ? { ...richClose0930(inputOf(close0930)), yume: { ...YUME_CLOSE_FIXTURE, review_ja: "朝の予想は当たりでした。" } }
      : richMorning1001(inputOf(morning1001));
    const paths: string[] = [];
    let complete: Record<string, unknown> | null = null;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const fetchMock: typeof fetch = (input, init) => Promise.resolve(respond(input, init));
    const respond = (input: RequestInfo | URL, init?: RequestInit): Response => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (url === "https://api.openai.com/v1/responses") {
        const payload = String(body?.instructions).includes("Factチェッカー") ? PASS : analysis;
        return json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }], usage: { input_tokens: 900, output_tokens: 300 } });
      }
      if (!url.startsWith(`${SUPABASE}/rest/v1/`)) throw new Error(`UNEXPECTED_HOST:${url}`);
      const path = url.slice(`${SUPABASE}/rest/v1/`.length);
      paths.push(path.split("?")[0]);
      if (path.startsWith("market_holidays")) return json([]);
      if (path === "rpc/claim_market_report_analysis") {
        return json([{ cycle_id: "11111111-1111-4111-8111-111111111111", claim_token: "22222222-2222-4222-8222-222222222222", attempt: 1, outcome: "claimed", data_packet_id: fixture.data.id }]);
      }
      if (path.startsWith("market_data_packets")) return json([{ ...fixture.data, data_quality_status: "partial" }]);
      if (path.startsWith("important_news_candidates")) return json(fixture.news);
      if (path.startsWith("market_report_cycles") || path.startsWith("market_report_packets")) {
        if (morningRows === "throw") return json({ message: "boom" }, 500);
        return json(path.startsWith("market_report_cycles") ? morningRows.cycles : morningRows.packets);
      }
      if (path === "rpc/complete_market_report_analysis") {
        complete = body;
        return json("33333333-3333-4333-8333-333333333333");
      }
      if (path === "rpc/fail_market_report_analysis") return json("failed");
      if (path.startsWith("market_report_generation_traces")) return new Response(null, { status: 201 });
      throw new Error(`UNEXPECTED_PATH:${path}`);
    };
    const env: Record<string, string> = { SUPABASE_URL: SUPABASE, SUPABASE_SECRET_KEYS: JSON.stringify({ default: "service-NOT-REAL" }), KABUMORI_MARKET_REPORT_NEWS_SELECTION: "all", KABUMORI_MARKET_REPORT_JAPAN_METRICS: "legacy_1306", SEND_PUSH_NOTIFICATIONS_CRON_SECRET: SECRET, OPENAI_API_KEY: "openai-NOT-REAL" };
    const now = mode === "close" ? "2026-09-30T07:20:00Z" : "2026-09-30T22:55:20Z";
    const deps: Deps = { env: (name) => env[name], fetch: fetchMock, now: () => new Date(now), sleep: () => Promise.resolve() };
    const res = await handleRequest(new Request("https://functions.local/market-report-analysis", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Cron-Secret": SECRET }, body: JSON.stringify({ mode }),
    }), deps);
    return { body: await res.json(), paths, complete: complete as Record<string, unknown> | null };
  };

  const hit = await run("close", { cycles: [{ report_status: "completed", current_report_packet_id: MORNING_ID }], packets: [{ id: MORNING_ID, payload: morningPacket() }] });
  assert.equal(hit.body.status, "completed", JSON.stringify(hit.body));
  const stored = hit.complete!.p_payload as { yume: { review: { verdict: string; morning_report_packet_id: string; text_ja: string } } };
  assert.deepEqual([stored.yume.review.verdict, stored.yume.review.morning_report_packet_id, stored.yume.review.text_ja], ["hit", MORNING_ID, "朝の予想は当たりでした。"]);
  assert.equal((hit.complete!.p_diagnostics as Record<string, string>).yume_review, "hit:COMPARED");

  const failedRead = await run("close", "throw");
  assert.equal(failedRead.body.status, "completed", "a failed morning read never fails the close");
  assert.equal((failedRead.complete!.p_diagnostics as Record<string, string>).yume_review, "undeterminable:MORNING_READ_FAILED");

  const morning = await run("morning", "throw");
  assert.equal(morning.body.status, "completed", JSON.stringify(morning.body));
  assert.ok(!morning.paths.some((path) => path.startsWith("market_report_cycles") || path.startsWith("market_report_packets")), "the morning run reads no report");
  assert.equal((morning.complete!.p_diagnostics as Record<string, string>).yume_review, undefined);
});

// ---- 2026-10-13 additional instruction: facts and calls are checked by different standards ------------------------

/** One delivery with a scripted Fact verdict; returns the packet. */
async function deliver(input: ReturnType<typeof closeInput>, analysis: GeneratedAnalysis, fact: unknown = PASS) {
  const outcome = await generateSharedAnalysis(input, scripted([{ step: "generate", payload: analysis }, { step: "fact", payload: fact }]), () => new Date("2026-09-30T07:21:00Z"));
  assert.equal(outcome.ok, true);
  return outcome.ok ? outcome.packet : null!;
}

test("① a call with no evidence behind it passes: no hard issue, nothing removed, no warning", async () => {
  const input = closeInput(null);
  const call = "根拠ははっきりしませんが、私は明日の日本株は反発すると予想しています。";
  const analysis: GeneratedAnalysis = { ...richClose0930(input), yume: { ...YUME_CLOSE_FIXTURE, stance: "up", headline_ja: "私は明日は反発するとみています", reasons_ja: call } };
  const check = localAnalysisCheck(analysis, input);
  assert.deepEqual(check.hard, []);
  const packet = await deliver(input, analysis);
  assert.deepEqual([packet.yume?.headline_ja, packet.yume?.reasons_ja], ["私は明日は反発するとみています", call]);
  assert.ok(!(packet.fact.removed_units ?? []).some((unit) => unit.includes("@yume")));
});

test("② an exact fact and a call in one paragraph: both are delivered", async () => {
  const input = closeInput(null);
  const text = "9月30日の日経平均は66,753.72（前日比+1.94%）と上昇しました。私は明日は反落すると予想しています。";
  const packet = await deliver(input, { ...richClose0930(input), yume: { ...YUME_CLOSE_FIXTURE, stance: "down", reasons_ja: text } });
  assert.equal(packet.yume?.reasons_ja, text);
});

test("③ an invented price or invented news fails: the guard or the Fact check removes it, the call stays", async () => {
  const input = closeInput(null);
  // A price not in the input: removed by the code guard.
  const price = await deliver(input, { ...richClose0930(input), yume: { ...YUME_CLOSE_FIXTURE, reasons_ja: "日経平均は70,000円台に乗せました。私は明日は横ばいとみています。" } });
  assert.equal(price.yume?.reasons_ja, "私は明日は横ばいとみています。");
  // News not in the input, without a number: the Fact check names it as an objective issue and only that sentence goes.
  const invented = "日銀が追加の利上げを決めたと発表しました。";
  const fact = { passed: false, issues: ["input に無いニュース"], objective_issues: [{ quote_ja: invented, reason_ja: "input に無い発表" }] };
  const news = await deliver(input, { ...richClose0930(input), yume: { ...YUME_CLOSE_FIXTURE, reasons_ja: `${invented}私は明日は横ばいとみています。` } }, fact);
  assert.equal(news.yume?.reasons_ja, "私は明日は横ばいとみています。");
  assert.ok(!JSON.stringify(news).includes("追加の利上げ"));
});

test("④ a wrong fact next to a sound call: only the fact sentence is removed (see also the direction test above)", async () => {
  const input = closeInput(null);
  const packet = await deliver(input, { ...richClose0930(input), yume: { ...YUME_CLOSE_FIXTURE, reasons_ja: "9月30日の日経平均は前日比+1.94%と下落しました。私は明日は反発すると予想しています。" } });
  assert.equal(packet.yume?.reasons_ja, "私は明日は反発すると予想しています。");
});

test("⑤ saying the call may be wrong is not a Fact error, and the Fact prompt says so", async () => {
  const input = closeInput(null);
  const text = "この見立ては外れる可能性も十分あります。";
  const analysis: GeneratedAnalysis = { ...richClose0930(input), yume: { ...YUME_CLOSE_FIXTURE, invalidation_ja: text } };
  assert.deepEqual(localAnalysisCheck(analysis, input).hard, []);
  assert.equal((await deliver(input, analysis)).yume?.invalidation_ja, text);
  assert.ok(FACT_INSTRUCTIONS.includes("外れる可能性がある、という理由だけで passed を false にせず、objective_issues にも入れません"));
  assert.ok(FACT_INSTRUCTIONS.includes("objective_issues には誤った事実の文だけを入れます（予想の文は入れません）"));
  assert.ok(FACT_INSTRUCTIONS.includes("「〜と予想しています」「〜とみています」のように意見だと分かるものは問題にしない"));
});

test("⑥ the disclaimer stays the code's: one on X and in the app; a model-written one inside her call is removed", async () => {
  const input = inputOf(morning1001);
  const analysis: GeneratedAnalysis = { ...richMorning1001(input), yume: { ...YUME_MORNING_FIXTURE, counter_ja: "最終的な投資判断はご自身でお願いします。" } };
  const outcome = await generateSharedAnalysis(input, scripted([{ step: "generate", payload: analysis }, { step: "fact", payload: PASS }]), () => new Date("2026-09-30T22:56:00Z"));
  const packet = outcome.ok ? outcome.packet : null!;
  assert.equal(packet.yume?.counter_ja, "");
  assert.ok(packet.fact.removed_units?.some((unit) => unit.startsWith("UNIT_REMOVED:MODEL_DISCLAIMER@yume.counter_ja")));
  assert.equal(formatSharedXPost(packet).split(REPORT_DISCLAIMER_JA).length, 2);
  const story = buildAppMarketStory(packet);
  assert.equal(story.sections.at(-1)?.body_ja, REPORT_DISCLAIMER_JA);
  assert.equal(story.sections.filter((item) => item.body_ja.includes(REPORT_DISCLAIMER_JA)).length, 1);
});

test("multi-day record words stay out of calls; 反発 / 反落 are allowed only where no past fact is stated", () => {
  const input = closeInput(null);
  const at = (reasons_ja: string) => localAnalysisCheck({ ...richClose0930(input), yume: { ...YUME_CLOSE_FIXTURE, reasons_ja } }, input).hard;
  assert.deepEqual(at("私は明日は反発すると予想しています。"), []);
  assert.ok(at("私は明日は続伸すると予想しています。").some((issue) => issue.includes("続伸")));
  assert.ok(at("明日は最高値を更新するとみています。").some((issue) => issue.includes("最高値")));
  assert.ok(at("きょうの日経平均は反発しました。").some((issue) => issue.includes("反発")), "a past 反発 is a multi-day fact");
  // The fact sections keep the old rule.
  const watch = { ...richClose0930(input), yume: YUME_CLOSE_FIXTURE, headline_ja: "日経平均が反発" };
  assert.ok(localAnalysisCheck(watch, input).hard.some((issue) => issue.includes("反発")));
});
