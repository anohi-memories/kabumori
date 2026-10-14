// ゆめちゃんの市況コラム (2026-10-14, F2): the market-wide news selection and its exclusion log, the column voice in the
// prompt, the shared 📌 points at the top of X, and her scenario (scenario_ja) from the model to the packet and the app
// story. Offline: real repository fixtures, scripted model answers, a fake PostgREST for the handler.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnalysisInput,
  isMarketMovingCompanyNews,
  MAX_COMPANY_NEWS_ITEMS,
  type NewsInputItem,
  selectMarketWideNews,
} from "./analysis_input.ts";
import {
  assemblePacket,
  FACT_INSTRUCTIONS,
  generationRequestBody,
  parseGeneratedAnalysis,
  speculativeCausalSentences,
  unsupportedCausalSentences,
} from "./analysis_logic.ts";
import { type Deps, handleRequest, NEWS_SELECTION_ENV, newsExclusionSummary } from "./handler.ts";
import { sanitizeAnalysis } from "./unit_sanitizer.ts";
import { codeFallbacks, unitChecker } from "./analysis_logic.ts";
import { formatSharedXPost, X_POINTS_TITLE } from "../_shared/market_report_packet.ts";
import { buildAppMarketStory } from "../_shared/market_report_story.ts";
import { inputOf, loadFixture, rich0917, richMorning1001, YUME_MORNING_FIXTURE } from "./test_support.ts";

const close0917 = await loadFixture("close_2026-09-17");
const close1007 = await loadFixture("close_2026-10-07");
const close0930 = await loadFixture("close_2026-09-30");
const morning1001 = await loadFixture("morning_2026-10-01");

const item = (patch: Partial<NewsInputItem>): NewsInputItem => ({
  ref: "news:x", headline_ja: "見出し", summary_ja: null, severity: "high", categories: [], company: null, published_at: null,
  scope: "broad", ...patch,
});

// ---- 4. news selection ----------------------------------------------------------------------------------------------

test("market-wide selection: an ordinary company's disclosure is left out with a reason code; broad and sector stay", () => {
  const { kept, excluded } = selectMarketWideNews([
    item({ ref: "news:broad", scope: "broad", categories: ["geopolitics"] }),
    item({ ref: "news:sector", scope: "sector", categories: ["semiconductors"] }),
    item({ ref: "news:earnings", scope: "company", categories: ["corporate", "earnings"], company: "某社（1234）" }),
    item({ ref: "news:fx-earnings", scope: "company", categories: ["fx", "corporate", "earnings"], company: "輸出（5678）" }),
    item({ ref: "news:chip-medium", scope: "company", severity: "medium", categories: ["semiconductors", "corporate"], company: "半導体（8035）" }),
  ]);
  assert.deepEqual(kept.map((news) => news.ref), ["news:broad", "news:sector"]);
  assert.deepEqual(excluded, [
    { ref: "news:earnings", reason: "COMPANY_NOT_MARKET_WIDE" },
    { ref: "news:fx-earnings", reason: "COMPANY_NOT_MARKET_WIDE" },
    { ref: "news:chip-medium", reason: "COMPANY_NOT_MARKET_WIDE" },
  ]);
});

test("a company item that can move a major sector (semiconductors / AI, high or above) stays, at most two of them", () => {
  const chip = (ref: string) => item({ ref, scope: "company", severity: "critical", categories: ["ai_tech", "corporate"], company: "AI（9984）" });
  assert.ok(isMarketMovingCompanyNews(chip("news:a")));
  assert.ok(!isMarketMovingCompanyNews(item({ scope: "broad", categories: ["semiconductors"] })), "only company items are judged here");
  const { kept, excluded } = selectMarketWideNews([chip("news:a"), chip("news:b"), chip("news:c")]);
  assert.equal(MAX_COMPANY_NEWS_ITEMS, 2);
  assert.deepEqual(kept.map((news) => news.ref), ["news:a", "news:b"]);
  assert.deepEqual(excluded, [{ ref: "news:c", reason: "COMPANY_NEWS_CAP" }]);
});

test("a policy decision tied to a company stays (major news is never filtered)", () => {
  const boj = item({ ref: "news:boj", scope: "broad", categories: ["monetary_policy"], company: null });
  const bank = item({ ref: "news:bank", scope: "company", severity: "medium", categories: ["monetary_policy", "corporate"], company: "銀行（8306）" });
  assert.deepEqual(selectMarketWideNews([boj, bank]).kept.map((news) => news.ref), ["news:boj", "news:bank"]);
});

test("10/7 close (28 company items, 1 geopolitics): only the market-wide item reaches the model; every exclusion is logged", () => {
  const all = inputOf(close1007);
  const wide = inputOf(close1007, { newsSelection: "market_wide" });
  assert.ok(all.news.some((news) => news.scope === "company"), "the old input led with company items");
  assert.deepEqual(wide.news.map((news) => news.scope), ["broad"]);
  const modelNews = (wide.modelInput as { ニュース: Array<{ ref: string }> }).ニュース.map((news) => news.ref);
  assert.deepEqual(modelNews, wide.news.map((news) => news.ref));
  for (const excluded of wide.excludedNews) {
    assert.ok(!modelNews.includes(excluded.ref), "an excluded item never reaches the model");
    assert.ok(!wide.allowedRefs.has(excluded.ref), "nor can it be cited");
  }
  // Every referenced row is either kept or logged with a fixed reason code.
  const referenced = close1007.data.payload.news_refs.items.map((ref) => `news:${ref.ref_id}`);
  const accounted = new Set([...wide.news.map((news) => news.ref), ...wide.excludedNews.map((news) => news.ref)]);
  for (const ref of referenced.filter((ref) => close1007.news.some((row) => `news:${row.id}` === ref))) assert.ok(accounted.has(ref), ref);
  assert.ok(wide.excludedNews.every((news) => /^(NEWS_TEXT_NOT_FACT_PASSED|COMPANY_NOT_MARKET_WIDE|COMPANY_NEWS_CAP|NEWS_ITEM_CAP)$/.test(news.reason)));
  assert.match(newsExclusionSummary(wide.excludedNews), /^COMPANY_NOT_MARKET_WIDE:\d+/);
});

test("9/30 close: the two AI company items of critical severity stay as sector news; the rest of the company items go", () => {
  const wide = inputOf(close0930, { newsSelection: "market_wide" });
  const companies = wide.news.filter((news) => news.scope === "company");
  assert.ok(companies.length <= MAX_COMPANY_NEWS_ITEMS);
  assert.ok(companies.every((news) => isMarketMovingCompanyNews(news)));
  assert.ok(wide.news.filter((news) => news.scope === "broad").length >= 5, "the broad items are all still there");
});

test("the pure builder keeps the old input by default (fixtures and replays); the handler opts into market_wide", () => {
  const legacy = buildAnalysisInput({
    dataPacket: close0917.data.payload, dataPacketId: close0917.data.id, dataContentHash: close0917.data.content_hash, newsRows: close0917.news,
  });
  assert.deepEqual(legacy.excludedNews.filter((news) => news.reason === "COMPANY_NOT_MARKET_WIDE"), []);
});

// ---- handler: selection and the exclusion log -----------------------------------------------------------------------

const SUPABASE = "https://project-ref.supabase.co";
const SECRET = "cron-secret-for-tests";
type Call = { url: string; body: Record<string, unknown> | null };

function harness(env: Record<string, string>) {
  const calls: Call[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url === "https://api.openai.com/v1/responses") {
      const isFact = String(body?.instructions).includes("Factチェッカー");
      const payload = isFact ? { passed: true, issues: [] } : rich0917(inputOf(close0917));
      return json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }], usage: { input_tokens: 900, output_tokens: 300 } });
    }
    const path = url.slice(`${SUPABASE}/rest/v1/`.length);
    if (path.startsWith("market_holidays")) return json([]);
    if (path === "rpc/claim_market_report_analysis") {
      return json([{ cycle_id: "11111111-1111-4111-8111-111111111111", claim_token: "22222222-2222-4222-8222-222222222222", attempt: 1, outcome: "claimed", data_packet_id: close0917.data.id }]);
    }
    if (path.startsWith("market_data_packets")) {
      return json([{ id: close0917.data.id, content_hash: close0917.data.content_hash, payload: close0917.data.payload, data_quality_status: "partial" }]);
    }
    if (path.startsWith("important_news_candidates")) return json(close0917.news);
    if (path.startsWith("market_report_generation_traces")) return json(null, 201);
    if (path === "rpc/complete_market_report_analysis") return json("33333333-3333-4333-8333-333333333333");
    if (path === "rpc/fail_market_report_analysis") return json("failed");
    throw new Error(`UNEXPECTED_PATH:${path}`);
  };
  const deps: Deps = {
    env: (name) => ({
      SUPABASE_URL: SUPABASE, SUPABASE_SECRET_KEYS: JSON.stringify({ default: "service-NOT-REAL" }),
      SEND_PUSH_NOTIFICATIONS_CRON_SECRET: SECRET, OPENAI_API_KEY: "openai-NOT-REAL", ...env,
    } as Record<string, string>)[name],
    fetch: fetchMock,
    now: () => new Date("2026-09-17T07:20:00Z"),
    sleep: () => Promise.resolve(),
  };
  return { calls, deps };
}

const run = (deps: Deps) =>
  handleRequest(
    new Request("https://functions.local/market-report-analysis", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Cron-Secret": SECRET }, body: JSON.stringify({ mode: "close" }),
    }),
    deps,
  );

function finalDiagnostics(calls: Call[]): Record<string, string> {
  const last = calls.filter((call) => /rpc\/(complete|fail)_market_report_analysis$/.test(call.url)).at(-1)!;
  return last.body!.p_diagnostics as Record<string, string>;
}

test("handler default (env unset): company items never reach the model, and the run records what was left out and why", async () => {
  const { calls, deps } = harness({});
  await run(deps);
  const generate = calls.find((call) => call.url.includes("openai") && !String(call.body?.instructions).includes("Factチェッカー"))!;
  const modelInput = JSON.parse(String(generate.body!.input)) as { ニュース: Array<{ ref: string; 範囲: string }> };
  assert.ok(modelInput.ニュース.length > 0);
  assert.ok(modelInput.ニュース.every((news) => news.範囲 !== "個別企業"), "9/17 has no sector-moving company item");
  const diagnostics = finalDiagnostics(calls);
  assert.equal(diagnostics.news_selection, "market_wide");
  const excluded = Number(diagnostics.news_excluded);
  assert.ok(excluded > 0);
  assert.equal(diagnostics.news_excluded_refs.split(",").length, excluded);
  for (const entry of diagnostics.news_excluded_refs.split(",")) {
    const [ref, reason] = entry.split("=");
    assert.match(ref, /^news:[0-9a-f-]{36}$/);
    assert.ok(!modelInput.ニュース.some((news) => news.ref === ref));
    assert.match(reason, /^[A-Z_]+$/, "fixed codes only, never text");
  }
  assert.match(diagnostics.news_excluded_reasons, /COMPANY_NOT_MARKET_WIDE:\d+/);
  assert.equal(diagnostics.news_items, String(modelInput.ニュース.length));
});

test(`${NEWS_SELECTION_ENV}=all restores the old input without a deploy (the report completes as before)`, async () => {
  const { calls, deps } = harness({ [NEWS_SELECTION_ENV]: "all" });
  const body = await (await run(deps)).json();
  assert.equal(body.status, "completed");
  const diagnostics = finalDiagnostics(calls);
  assert.equal(diagnostics.news_selection, "all");
  assert.ok(!("news_excluded_reasons" in diagnostics) || !diagnostics.news_excluded_reasons.includes("COMPANY_NOT_MARKET_WIDE"));
});

// ---- 3. the column voice and the shared points ----------------------------------------------------------------------

test("prompt: ゆめちゃん talks to the reader with her own reading of the facts; the call stays in yume only", () => {
  for (const input of [inputOf(morning1001), inputOf(close0917)]) {
    const prompt = String(generationRequestBody(input, []).instructions);
    assert.ok(prompt.startsWith("あなたは日本株の市場レポート編集者です。この取引日の市場を、かぶモリのAI評論家「ゆめちゃん」"));
    assert.ok(prompt.includes("情報の羅列ではなく、ゆめちゃん自身の解釈を読んでもらうこと"));
    assert.ok(prompt.includes("新聞記事・ニュース速報・業務報告書・AIの要約のような硬い文にしません"));
    assert.ok(prompt.includes("判断には根拠（入力の事実）を添え"));
    assert.ok(prompt.includes("同じ情報を繰り返しません。今日のポイント（points_ja）に書いたことを本文でそのまま言い直さず"));
    assert.ok(prompt.includes("AIらしい機械的な言い回し"));
    assert.ok(prompt.includes("yume 以外の項目では今日の値動きを予想せず"), "a direction call lives in yume only");
    assert.ok(prompt.includes("yume の stance と同じ向きにし、逆の向きを書きません"), "X never contradicts her call");
    assert.ok(prompt.includes("一般的な個別企業の決算・開示は入力から外してあります"));
    assert.ok(prompt.includes("大事なニュースが少ない日は、ニュースで埋めず"));
    assert.ok(prompt.includes("「📌 今日のポイント」→「🔮 ゆめちゃんの考察・予想」（yume）→「📖 今日の相場のお話」→「⚠️ この先の注目材料」→「📊 参考資料｜主な市場指標」"));
    assert.ok(!prompt.includes("20代女性"), "ゆめちゃん is an AI commentator, not a human persona");
    assert.ok(!prompt.includes("他の項目は落ち着いた説明文"), "the whole report is her column now");
    // Fact rules are unchanged.
    assert.ok(prompt.includes("入力に無い数字、日付、固有名詞を書きません"));
    assert.ok(prompt.includes("すでに起きた値動きの理由は、入力のニュースが理由として明記している（causal の claim がある）場合だけ事実として書きます"));
  }
});

test("X opens with the same 3 points the app shows first, under one title on both reports", () => {
  const morning = inputOf(morning1001);
  const packet = assemblePacket(morning, richMorning1001(morning), { generatedAt: new Date("2026-09-30T22:56:00Z"), attempts: 1 });
  const post = formatSharedXPost(packet);
  const lines = post.split("\n");
  assert.equal(lines[1], X_POINTS_TITLE);
  assert.equal(X_POINTS_TITLE, "📌 今日のポイント");
  assert.deepEqual(lines.slice(2, 5), packet.x_post.points_ja.map((point) => `・${point}`));
  assert.equal(lines[5], "", "a blank line, then the lead");
  assert.equal(lines[6], packet.x_post.lead_ja);
});

// ---- 2. her scenario --------------------------------------------------------------------------------------------------

test("her scenario is parsed, kept in the packet and shown in the app section after her reasons", () => {
  const input = inputOf(morning1001);
  const analysis = { ...richMorning1001(input), yume: YUME_MORNING_FIXTURE };
  const parsed = parseGeneratedAnalysis(JSON.parse(JSON.stringify(analysis)))!;
  assert.equal(parsed.yume?.scenario_ja, YUME_MORNING_FIXTURE.scenario_ja);
  const packet = assemblePacket(input, parsed, { generatedAt: new Date("2026-09-30T22:56:00Z"), attempts: 1 });
  assert.equal(packet.yume?.scenario_ja, YUME_MORNING_FIXTURE.scenario_ja);
  const section = buildAppMarketStory(packet).sections.find((item) => item.key === "yume")!;
  assert.equal(section.body_ja, [YUME_MORNING_FIXTURE.headline_ja, YUME_MORNING_FIXTURE.reasons_ja, YUME_MORNING_FIXTURE.scenario_ja].join("\n"));
});

test("an invented number in her scenario is removed like any other part of her call; the rest of the call stays", () => {
  const input = inputOf(morning1001);
  const analysis = { ...richMorning1001(input), yume: { ...YUME_MORNING_FIXTURE, scenario_ja: "日経平均は71,234円まで上がるシナリオを考えています。" } };
  const result = sanitizeAnalysis(analysis, input, (kept) => unitChecker(input, kept), codeFallbacks(input));
  assert.equal(result.analysis.yume?.scenario_ja, "");
  assert.equal(result.analysis.yume?.reasons_ja, YUME_MORNING_FIXTURE.reasons_ja);
  assert.ok(result.removed.some((unit) => unit.path.startsWith("yume.scenario_ja") && unit.code === "VALUE_NOT_IN_INPUT"));
});

test("an older packet without a scenario renders as before", () => {
  const input = inputOf(morning1001);
  const { scenario_ja: _dropped, ...older } = YUME_MORNING_FIXTURE;
  const packet = assemblePacket(input, { ...richMorning1001(input), yume: older }, { generatedAt: new Date("2026-09-30T22:56:00Z"), attempts: 1 });
  assert.equal("scenario_ja" in (packet.yume ?? {}), false);
  const section = buildAppMarketStory(packet).sections.find((item) => item.key === "yume")!;
  assert.equal(section.body_ja, [older.headline_ja, older.reasons_ja].join("\n"));
});

// ---- her reading of a past move is a view, not an asserted cause ----------------------------------------------------

test("「〜と見ています」 marks a reason as her view (advisory, delivered); the same reason stated as fact is still removed", () => {
  const input = inputOf(close0917);
  const base = rich0917(input);
  const withSentence = (sentence: string) => ({ ...base, app_story: { ...base.app_story!, japan_ja: sentence } });
  const view = withSentence("私は、円安を背景に東京市場は上昇したと見ています。");
  assert.deepEqual(unsupportedCausalSentences(view, input), []);
  assert.ok(speculativeCausalSentences(view, input).length > 0, "recorded as speculative (advisory)");
  for (const phrase of ["上昇したとみています", "上昇したと考えています", "上昇したと思います"]) {
    assert.deepEqual(unsupportedCausalSentences(withSentence(`円安を背景に東京市場は${phrase}。`), input), [], phrase);
  }
  const asserted = withSentence("円安を背景に東京市場は上昇しました。");
  assert.equal(unsupportedCausalSentences(asserted, input).length, 1, "an asserted cause without news is still an objective error");
  // A view in one clause does not cover an assertion in another (clause rule, 2026-10-08 H2).
  const mixed = withSentence("円安を背景に東京市場は上昇しましたが、明日は落ち着くと見ています。");
  assert.equal(unsupportedCausalSentences(mixed, input).length, 1);
});

test("the Fact prompt treats her reading as a view", () => {
  assert.ok(FACT_INSTRUCTIONS.includes("「私は〜と見ています」「私の見立てでは〜」"));
  assert.ok(FACT_INSTRUCTIONS.includes("「〜が支えになったと見ています」"));
});
