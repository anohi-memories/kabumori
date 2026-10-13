import assert from "node:assert/strict";
import test from "node:test";
import {
  buildJudgementTrace,
  classifyStoredJudgement,
  GATE_SENTENCE,
  inferMissingInformation,
  type ModelOutput,
  reasonSignal,
  runProductionGate,
} from "./gate_analysis.ts";

const imp = ["no_post", "important", "most_important"] as const;
const fact = ["passed", "needs_review"] as const;

function output(importance: ModelOutput["importance"], factCheckStatus: ModelOutput["factCheckStatus"], confidence = 0.9, needsSol = false): ModelOutput {
  return { importance, factCheckStatus, confidence, needsSol };
}

test("the gate sentence in this module is the one production appends", async () => {
  const source = await Deno.readTextFile(new URL("../../../supabase/functions/important-news-monitor/importance_judgement_logic.ts", import.meta.url));
  assert.ok(source.includes(GATE_SENTENCE.slice(1, -1)), "production's gate sentence changed: update GATE_SENTENCE and the SQL that matches it");
});

test("truth table through the production function: every stored outcome is classified, and no_post only comes from three places", async () => {
  const seen = new Set<string>();
  for (const lunaImportance of imp) for (const lunaFact of fact) for (const confidence of [0.9, 0.5]) for (const needsSol of [false, true]) {
    for (const solEnabled of [false, true]) for (const solImportance of imp) for (const solFact of fact) {
      const luna = output(lunaImportance, lunaFact, confidence, needsSol);
      const sol = output(solImportance, solFact, 0.9, false);
      const required = needsSol || confidence < 0.7 || lunaImportance === "most_important" || lunaFact === "needs_review";
      const ranSol = solEnabled && required;
      const { stored, result } = await runProductionGate(luna, ranSol ? sol : null, { solEscalationEnabled: solEnabled });
      const c = classifyStoredJudgement(stored);
      assert.equal(c.solRan, ranSol);
      assert.equal(result.escalatedToSol, ranSol);
      const finalFact = ranSol ? solFact : lunaFact;
      const finalImportance = ranSol ? solImportance : lunaImportance;
      const gateFires = finalFact !== "passed" || (!ranSol && required);
      assert.equal(c.gateApplied, gateFires, JSON.stringify({ luna, sol, solEnabled }));
      if (gateFires) {
        assert.equal(stored.importance, "no_post");
        assert.equal(stored.factCheckStatus, "needs_review");
        assert.equal(c.outcome, ranSol ? "gate_after_sol" : "gate_sol_required_not_run");
        assert.equal(c.preGateImportance, "not_stored");
      } else {
        assert.equal(stored.importance, finalImportance);
        assert.equal(c.outcome, finalImportance === "no_post" ? "model_no_post" : "final_positive");
      }
      seen.add(c.outcome);
    }
  }
  assert.deepEqual([...seen].sort(), ["final_positive", "gate_after_sol", "gate_sol_required_not_run", "model_no_post"]);
});

test("what is recoverable: Luna's output is lost whenever Sol ran, and the pre-gate Fact status is known only after Sol", () => {
  const afterSol = classifyStoredJudgement({
    importance: "no_post", judgementModel: "gpt-6-sol", escalatedToSol: true, factCheckStatus: "needs_review",
    reason: `r${GATE_SENTENCE}`, solEscalationReasons: "MODEL_REQUESTED_REVIEW+FACT_NEEDS_REVIEW",
  });
  assert.deepEqual(afterSol.escalationReasons, ["MODEL_REQUESTED_REVIEW", "FACT_NEEDS_REVIEW"]);
  assert.equal(afterSol.preGateFactStatus, "needs_review");
  assert.equal(afterSol.lunaOutput, "not_stored");
  const notRun = classifyStoredJudgement({
    importance: "no_post", judgementModel: "gpt-6-luna", escalatedToSol: false, factCheckStatus: "needs_review",
    reason: `r${GATE_SENTENCE}`, solEscalationReasons: "",
  });
  assert.equal(notRun.outcome, "gate_sol_required_not_run");
  assert.equal(notRun.preGateFactStatus, "not_stored");
  assert.equal(notRun.lunaOutput, "stored");
  const older = classifyStoredJudgement({
    importance: "no_post", judgementModel: "gpt-5.6-sol", escalatedToSol: true, factCheckStatus: "needs_review",
    reason: `r${GATE_SENTENCE}`, solEscalationReasons: "",
  });
  assert.equal(older.escalationReasons, null, "older rows have no recorded escalation reasons");
});

test("the trace records what the gate overwrites, for every combination", async () => {
  for (const lunaImportance of imp) for (const lunaFact of fact) for (const solEnabled of [false, true]) {
    const luna = output(lunaImportance, lunaFact, 0.9, lunaFact === "needs_review");
    const required = lunaFact === "needs_review" || lunaImportance === "most_important";
    const sol = solEnabled && required ? output("important", "needs_review") : null;
    const { result, stored } = await runProductionGate(luna, sol, { solEscalationEnabled: solEnabled });
    const gateApplied = classifyStoredJudgement(stored).gateApplied;
    const trace = buildJudgementTrace(luna, sol, { solEnabled }, result, gateApplied);
    assert.equal(trace.final.importance, stored.importance);
    assert.equal(trace.escalation.ran, sol !== null);
    assert.equal(trace.escalation.required, required);
    if (gateApplied) {
      assert.equal(trace.gate.preGateImportance, (sol ?? luna).importance);
      assert.ok(trace.gate.trigger !== null);
    } else {
      assert.equal(trace.gate.preGateImportance, null);
    }
    if (!sol && required) assert.equal(trace.escalation.notRunBecause, "disabled");
  }
});

test("missing-information kinds are read from real gate-suppressed reasons", () => {
  assert.deepEqual(inferMissingInformation(`修正後数値や減額率が要約から確認できず、影響規模は判定困難。${GATE_SENTENCE}`), ["numbers_missing"]);
  const quarter = inferMissingInformation("第1四半期は営業利益134.4％増。ただし通期予想の修正はなく、要約冒頭と本文で数値・年度表記に不整合がある。");
  assert.ok(quarter.includes("current_period_missing") && quarter.includes("inconsistent_summary"));
  assert.ok(inferMissingInformation("日銀審議委員の記者会見資料だが本文要約がなく、政策変更や市場への具体的影響を確認できない").includes("body_empty"));
  assert.ok(inferMissingInformation("ただし単一のオピニオン記事に基づき、合意や再開は確認できない。").includes("single_source"));
  assert.deepEqual(inferMissingInformation("通常の配当の開示。"), []);
});

test("reason wording signal separates 'important but unverifiable' from routine items", () => {
  assert.equal(reasonSignal("第三者委員会の調査報告書を公表。影響額が未確定であるため重要だが、規模を確認できず最重要とは判定しない。"), "material");
  assert.equal(reasonSignal("ETFの収益分配金見込額に関する通知。要約に具体的な金額や大幅な変更はなく、重要性は確認できない。"), "not_material");
  assert.equal(reasonSignal("エチオピア連邦軍による掌握が報じられた。日本株への具体的な影響は入力から確認できない。"), "not_material");
  assert.equal(reasonSignal("本文が空で内容を確認できない。"), "unclear");
});
