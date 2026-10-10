import assert from "node:assert/strict";
import test from "node:test";
import { loadCases } from "./fixtures.ts";
import {
  buildFactProbeRequest,
  buildFactProbes,
  MUTATION_EXPECTATION,
  type MutationType,
  type ProbeOutcome,
  probesFor,
  splitPost,
  summariseProbeOutcomes,
} from "./fact_probes.ts";

const SOURCE = "\n\n出典: https://www.release.tdnet.info/inbs/x.pdf";
const post = (body: string) => `【速報】${body}${SOURCE}`;
const byType = (probes: ReturnType<typeof probesFor>, type: MutationType) => probes.find((p) => p.mutation === type);

test("a stored post is split into body and the source line production appends", () => {
  const split = splitPost(post("本文です。"));
  assert.equal(split.body, "【速報】本文です。");
  assert.equal(split.sourceLine, SOURCE);
  assert.deepEqual(splitPost("出典なし"), { body: "出典なし", sourceLine: "" });
});

test("currency: the first yen amount becomes dollars, everything else is untouched", () => {
  const probe = byType(probesFor("c", post("配当は11円から12円へ。")), "currency_swap")!;
  assert.equal(probe.mutatedFinalText, post("配当は11ドルから12円へ。"));
  assert.equal(probe.expected, "fail");
});

test("direction: 下方修正 becomes 上方修正; a loss becomes a profit", () => {
  assert.equal(byType(probesFor("c", post("通期予想を下方修正しました。")), "direction_flip")!.mutatedFinalText, post("通期予想を上方修正しました。"));
  assert.equal(byType(probesFor("c", post("当期は損失を計上しました。")), "direction_flip")!.mutatedFinalText, post("当期は利益を計上しました。"));
});

test("amounts of the same unit exchange places everywhere they occur", () => {
  const probe = byType(probesFor("c", post("営業利益は975億円減の1,600億円、当期利益は731億円減の1,200億円。")), "amount_swap")!;
  assert.equal(probe.change, "975億円 <-> 1,600億円");
  assert.equal(probe.mutatedFinalText, post("営業利益は1,600億円減の975億円、当期利益は731億円減の1,200億円。"));
  assert.equal(byType(probesFor("c", post("売上は100円です。")), "amount_swap"), undefined, "one amount cannot be swapped");
});

test("state: an approved resolution becomes rejected; a planned delisting becomes done", () => {
  assert.equal(byType(probesFor("c", post("議案が承認されました。")), "state_flip")!.mutatedFinalText, post("議案が否決されました。"));
  assert.equal(byType(probesFor("c", post("上場廃止となる予定です。")), "state_flip")!.mutatedFinalText, post("上場廃止となりました。"));
});

test("subject: reporter and subsidiary swap; parent and wholly owned subsidiary swap", () => {
  const raid = byType(probesFor("c", post("アサヒグループによると、傘下のアサヒビールが強制調査を受けました。")), "subject_swap")!;
  assert.match(raid.mutatedFinalText, /アサヒビールによると、傘下のアサヒグループが/);
  const parent = byType(probesFor("c", `【重大速報】テルモ（4543）は、完全子会社のTerumo BCTと供給契約を解除します。${SOURCE}`), "subject_swap")!;
  assert.match(parent.mutatedFinalText, /Terumo BCT（4543）は、完全子会社のテルモと/);
});

test("hedge removal is exploratory, and unit conversion is an equivalent that must pass", () => {
  const hedge = byType(probesFor("c", post("金額は変動する可能性があります。")), "hedge_removal")!;
  assert.equal(hedge.exploratory, true);
  assert.equal(hedge.mutatedFinalText, post("金額は変動します。"));
  const unit = byType(probesFor("c", post("取得価額は147百万円です。")), "unit_equivalent")!;
  assert.equal(unit.expected, "pass");
  assert.equal(unit.mutatedFinalText, post("取得価額は1.47億円です。"));
  const other = byType(probesFor("c", post("営業利益は1,600億円です。")), "unit_equivalent")!;
  assert.equal(other.mutatedFinalText, post("営業利益は160,000百万円です。"));
});

test("unit-equivalent probes really are numerically equivalent", () => {
  const yen = (text: string) => {
    const m = /(\d[\d,]*(?:\.\d+)?)(億|百万)円/.exec(text)!;
    return Number(m[1].replace(/,/g, "")) * (m[2] === "億" ? 1e8 : 1e6);
  };
  for (const body of ["取得価額は147百万円です。", "取得価額は26百万円です。", "利益は1,600億円です。", "利益は975億円です。"]) {
    const probe = byType(probesFor("c", post(body)), "unit_equivalent")!;
    assert.equal(Math.round(yen(probe.mutatedFinalText)), Math.round(yen(post(body))), body);
  }
});

test("a post with nothing to damage yields no probe, and no probe is identical to its original", () => {
  assert.deepEqual(probesFor("c", post("特に金額も状態も含まない短い本文です。")), []);
  for (const body of ["配当は11円から12円へ。", "下方修正しました。"]) {
    for (const probe of probesFor("c", post(body))) assert.notEqual(probe.mutatedFinalText, post(body));
  }
});

test("every probe keeps the headline label and the source line, so only the damage differs", () => {
  const original = post("営業利益は975億円減の1,600億円、当期利益は731億円減の1,200億円。通期予想を下方修正しました。");
  for (const probe of probesFor("c", original)) {
    assert.ok(probe.mutatedFinalText.startsWith("【速報】"));
    assert.ok(probe.mutatedFinalText.endsWith(SOURCE));
  }
});

test("probes over the real fixtures: deterministic, unique, from posts production passed, every harmful type present", async () => {
  const cases = await loadCases();
  const first = buildFactProbes(cases);
  const second = buildFactProbes(cases);
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((p) => p.probeId)).size, first.length);
  const passed = new Set(cases.filter((c) => c.recorded.generation?.factStatus === "passed").map((c) => c.caseId));
  for (const probe of first) assert.ok(passed.has(probe.caseId), probe.probeId);
  const types = new Set(first.map((p) => p.mutation));
  for (const type of ["currency_swap", "direction_flip", "amount_swap", "state_flip", "subject_swap", "unit_equivalent"] as MutationType[]) {
    assert.ok(types.has(type), `${type} has at least one real-post probe`);
  }
  assert.ok(first.length >= 20, `only ${first.length} probes`);
});

test("the Fact request for a probe carries production's Fact prompt and the damaged post", async () => {
  const cases = await loadCases();
  const probe = buildFactProbes(cases)[0];
  const fixture = cases.find((c) => c.caseId === probe.caseId)!;
  const request = await buildFactProbeRequest(probe, fixture);
  assert.equal(request.taskId, "fact_probe");
  assert.equal(request.caseId, probe.probeId);
  assert.match(request.system, /厳格なFactチェッカー/);
  const sent = JSON.parse(request.user) as { generated_text: string };
  assert.equal(sent.generated_text, probe.mutatedFinalText);
});

test("expectations: harmful damage must be flagged, equivalent rewrites must not", () => {
  assert.equal(MUTATION_EXPECTATION.unit_equivalent.expected, "pass");
  for (const type of ["currency_swap", "direction_flip", "amount_swap", "state_flip", "subject_swap"] as MutationType[]) {
    assert.equal(MUTATION_EXPECTATION[type].expected, "fail");
    assert.equal(MUTATION_EXPECTATION[type].exploratory, false);
  }
});

test("summary: detection rate, misses and false alarms are counted per mutation", () => {
  const make = (mutation: MutationType, flagged: boolean | null, id: string): ProbeOutcome => ({
    probe: { probeId: id, caseId: "c", mutation, expected: MUTATION_EXPECTATION[mutation].expected, exploratory: MUTATION_EXPECTATION[mutation].exploratory, change: "", mutatedFinalText: "" },
    flagged,
  });
  const summary = summariseProbeOutcomes([
    make("currency_swap", true, "a"), make("currency_swap", false, "b"), make("currency_swap", null, "c"),
    make("unit_equivalent", true, "d"), make("unit_equivalent", false, "e"),
  ]);
  const currency = summary.find((s) => s.mutation === "currency_swap")!;
  assert.deepEqual([currency.n, currency.flaggedRate, currency.missed, currency.falseAlarms], [3, 0.5, 1, 0]);
  const unit = summary.find((s) => s.mutation === "unit_equivalent")!;
  assert.deepEqual([unit.flaggedRate, unit.missed, unit.falseAlarms], [0.5, 0, 1]);
});
