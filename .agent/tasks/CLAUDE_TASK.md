# Claude Task 2

- task_id: kabumori-voice-policy-phase1-shadow-20260925
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: かぶモリアプリのpersonalized-reportsに、VOICEのPASS/WARN/BLOCK分類とtelemetryをshadow導入する。配信可否の挙動は変えない。app_enabled=falseのまま。

## Accepted baseline

PR #32 stabilization is accepted:
- PR #32 head: `8792622d440b008d04ca97fb780a6a765245542a`
- merge: `f34b8c48e0de35626a8c16cd6a8d6109285c2bde`
- production personalized-reports: v29
- verify_jwt=false
- app_enabled=false
- x_enabled=false
- morning dry-run 3/3 PASS
- close dry-run 3/3 PASS
- impact completeness 6/6
- reportId=null all dry-runs
- notification=not_attempted all dry-runs
- no persistence during dry-runs

Review policy:
- Codex review frequency is reduced per PROJECT_RULES/ORCHESTRATION.
- Existing deferred H2 history for PR #32 remains preserved.
- Do not create a new H1/H2 review for this low-risk shadow-only phase.

## Product policy

Fact/Safety:
- remains fail-closed
- correctness/safety issues can BLOCK

Voice:
- PASS / WARN / BLOCK classification
- shadow only in Phase 1
- must NOT change delivery behavior yet
- WARN must not become a new blocker in this phase

Target responsibilities:
- Fact: numbers, entities, dates, causation, evidence, data consistency, unsupported impact, hallucination
- Safety: explicit buy/sell recommendation, profit guarantee, fabricated user position/trade, privacy/secrets, structural invalidity
- Voice: naturalness, readability, tone, emoji, repetition, AI/news-like style, minor awkwardness

## Goal

Add observability only:
- classify existing issues/signals into PASS/WARN/BLOCK
- record telemetry
- preserve current generation / local checks / Fact outcome / save-notify behavior exactly

This task must prove:
**with shadow mode enabled, delivery outcome is byte/semantically identical to current behavior for the same inputs.**

## Scope

Prefer:
- `supabase/functions/personalized-reports/report_logic.ts`
- `supabase/functions/personalized-reports/index.ts`
- new narrowly-scoped delivery-policy/voice-policy helper under personalized-reports or _shared only if clearly reusable
- focused tests

Do not change:
- current Fact checker acceptance/rejection semantics
- current local validator acceptance/rejection semantics
- morning/close generation prompts except if needed only to expose metadata; avoid prompt changes
- parser semantics
- MIC
- market_detail
- shared market packet semantics
- DB/schema/migration
- cron
- app_enabled/x_enabled
- X/admin/G1

## Required shadow model

At minimum produce:
- `voice_status`: pass | warn | block | unavailable
- `warning_codes: string[]`
- `rewrite_attempted: false`
- `rewrite_succeeded: false`
- `fallback_original_used: false`
- `delivery_blocked_by`: current actual blocker classification, not a new blocker

Phase 1 has no rewrite.

## Classification guidance

WARN examples:
- slightly AI-like wording
- repetitive endings
- light redundancy
- awkward emoji/style
- slightly news-like tone
- minor Japanese awkwardness
- mild brand-tone drift
- minor heading/style issue

BLOCK classification should only mirror already-existing true blockers:
- Fact fail
- Safety fail
- structural invalidity
- unsupported causal/future assertion already blocked by current logic
- malformed required fields
- other existing delivery blockers

Do NOT invent a new block path.

## Telemetry storage

Prefer existing JSONB/source metadata path if already suitable.
No migration.

Record shadow data only after it can be derived without changing behavior.
Do not expose internal warning detail to end users yet.

## Tests

Must prove:
1. shadow classifier maps representative style-only issues to WARN
2. current Fact/local blockers map to BLOCK
3. clean content maps to PASS
4. evaluator/classifier unavailable maps to unavailable/WARN-like telemetry only, not new delivery failure
5. delivery/save/notification decision is unchanged compared with pre-Phase1 behavior
6. no rewrite attempted
7. app_enabled=false behavior unchanged
8. existing morning/close report suites remain green
9. PR #32 regressions remain green
10. MIC tests remain green

Run:
- new focused tests
- full personalized-reports
- related report/app suite
- deno check
- deno lint
- git diff --check

## Production

Source-only by default.
No deploy unless a later ChatGPT task explicitly authorizes it.

No production LLM/dry-run.
No settings mutation.

## Natural cron gate

Do not alter the upcoming natural cron behavior.
Monday natural morning/close read-only verification remains a separate gate before any activation discussion.

## Completion / K2

Report:
- exact classification design
- changed files
- telemetry shape
- proof behavior is unchanged
- tests/counts
- commit/PR
- production mutation=0
- recommended next step

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.
