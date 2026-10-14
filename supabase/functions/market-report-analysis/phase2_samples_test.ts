// Phase 2 before / after (2026-10-14, F2). The "before" texts are the production reports stored in the fixtures (the old
// prompt); the "after" texts (fixtures/phase2_after_*.json) were written by hand to the new prompt from the same day's
// input, to show what the instructions ask for. They are NOT model output. Both go through the real local pipeline:
// guards, sanitizer, packet, X formatting. Offline only.
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalysisInput } from "./analysis_input.ts";
import { generateSharedAnalysis, reasonAbsenceSentences, type GeneratedAnalysis, type Requester } from "./analysis_logic.ts";
import { formatSharedXPost, type MarketReportPacket } from "../_shared/market_report_packet.ts";
import { loadFixture } from "./test_support.ts";

const directory = new URL("./fixtures/", import.meta.url);
const read = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(name, directory)));

const DAYS = [
  { name: "morning_2026-10-02", before: "morning_2026-10-02_generated_report.json", after: "phase2_after_morning_2026-10-02.json" },
  { name: "close_2026-10-06", before: "close_2026-10-06_generated_report.json", after: "phase2_after_close_2026-10-06.json" },
] as const;

/** The stock phrases the user named (allowed once at most in a whole report). */
const STOCK = ["市場の空気", "温度差", "頭の片隅", "見ておきたいところ", "注目していきたい", "注視する必要", "という見方もできます", "が確認されました", "が注目されます", "と考えられます"];

const bodyOf = (analysis: Pick<GeneratedAnalysis, "market_summary_ja" | "x_post" | "app_story">) =>
  [analysis.market_summary_ja, ...Object.values(analysis.x_post).flat(), ...Object.values(analysis.app_story ?? {})].join("\n");

async function deliver(name: string, afterFile: string) {
  const fixture = await loadFixture(name);
  const input = buildAnalysisInput({
    dataPacket: fixture.data.payload, dataPacketId: fixture.data.id, dataContentHash: fixture.data.content_hash, newsRows: fixture.news,
    newsSelection: "market_wide", japanMetrics: "nikkei_only",
  });
  const draft = await read(afterFile) as GeneratedAnalysis;
  const calls: string[] = [];
  const requester: Requester = (step) => {
    calls.push(step);
    return Promise.resolve({ payload: step === "fact" ? { passed: true, issues: [], objective_issues: [] } : draft, inputTokens: 0, outputTokens: 0 });
  };
  const outcome = await generateSharedAnalysis(input, requester, () => new Date(fixture.data.payload.generated_at));
  assert.ok(outcome.ok, JSON.stringify(!outcome.ok && outcome.issues));
  return { draft, packet: (outcome as { packet: MarketReportPacket }).packet, calls };
}

for (const day of DAYS) {
  test(`${day.name}: the after sample is delivered whole in one generation and one Fact call`, async () => {
    const { packet, calls } = await deliver(day.name, day.after);
    assert.deepEqual(calls, ["generate", "fact"]);
    assert.deepEqual(packet.fact.removed_units ?? [], [], "no sentence removed by a guard");
    assert.ok(!(packet.fact.quality_warnings ?? []).some((warning) => warning.startsWith("REASON_ABSENCE_STATED")));
  });

  test(`${day.name}: before vs after — no ETF as TOPIX, no 'no reason' refrain, no metric-recap points, her view in the body`, async () => {
    const stored = await read(day.before);
    const before = (stored.payload ?? stored) as GeneratedAnalysis;
    const { draft, packet } = await deliver(day.name, day.after);
    // Before: the shapes the user complained about, from the stored production report.
    assert.ok(bodyOf(before).includes("TOPIX連動ETF（1306）"), "before compared the ETF");
    assert.ok(reasonAbsenceSentences(before) >= 2, `before repeated 'no confirmed reason' (${reasonAbsenceSentences(before)})`);
    // After.
    const after = bodyOf(draft);
    assert.ok(!/TOPIX|1306/u.test(after), "after never mentions TOPIX or the ETF");
    assert.ok(reasonAbsenceSentences(draft) <= 1);
    for (const phrase of STOCK) assert.ok((after.match(new RegExp(phrase, "gu")) ?? []).length <= 1, phrase);
    const views = after.match(/と(?:見|み)ています|と考えています|と読んでいます|のではないか|と思います|と受け止めています/gu) ?? [];
    assert.ok(views.length >= 3, "her reading is in the text");
    assert.ok(((after.match(/とみています|と見ています/gu) ?? []).length) <= 4, "and not one refrain");
    assert.ok(draft.x_post.points_ja.every((point) => !/\d+\.\d+|前日比/u.test(point)), "points are headlines, not metric recaps");
    // X order: header + 📌 points, the commentary, her call.
    const blocks = formatSharedXPost(packet).split("\n\n");
    assert.ok(blocks[0].includes("📌 今日のポイント"));
    assert.equal(blocks[1], `${draft.x_post.lead_ja}\n${draft.x_post.context_ja}`);
    assert.ok(blocks[2].startsWith("🔮"));
    assert.ok(!formatSharedXPost(packet).includes("とみています。きょうは"), "no doubled 「とみています」 on X");
  });
}
