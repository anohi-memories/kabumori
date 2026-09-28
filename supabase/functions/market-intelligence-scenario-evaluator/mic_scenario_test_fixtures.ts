// Shared fixtures for the Scenario evaluator tests (no tests registered here).
export function validOutput(overrides: Record<string, unknown> = {}) {
  return {
    assessment_status: "assessed",
    base_case: {
      title: "引き締め的な金利環境の継続",
      description: "米金利が高水準で推移する場合、株式指数のバリュエーション面の重荷が続く可能性があります。",
      supporting_state_domains: ["rates", "equity_index"],
      confirmation_conditions: ["米長期金利が高水準を維持すること"],
      invalidation_conditions: ["米長期金利の明確な低下"],
      watch_items: ["米10年債利回り"],
    },
    upside_case: {
      title: "金利低下による改善",
      description: "米長期金利の低下が確認される場合、株式への圧力が和らぐ可能性があります。",
      triggers: ["米長期金利の低下"],
      implications: ["バリュエーション圧力の緩和"],
      invalidation_conditions: ["金利の再上昇"],
      watch_items: ["FOMC声明"],
    },
    downside_case: {
      title: "金利上昇の加速",
      description: "米金利の上昇が続く場合、株式指数への重荷が強まる可能性があります。",
      triggers: ["米金利の一段の上昇"],
      implications: ["バリュエーション圧力の強まり"],
      invalidation_conditions: ["金利の反落"],
      watch_items: ["米2年債利回り"],
    },
    state_conflicts: [],
    confidence: 0.7,
    needs_sol: false,
    ...overrides,
  };
}

export function responsePayload(structured: unknown, usage = { input_tokens: 1000, output_tokens: 400 }) {
  return { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(structured) }] }], usage };
}
