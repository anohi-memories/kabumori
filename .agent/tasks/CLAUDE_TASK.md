# Claude Task 2

- task_id: kabumori-voice-policy-phase1-shadow-20260925
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
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

## Report

### Summary

- task_id：`kabumori-voice-policy-phase1-shadow-20260925`
- result：shadowでの分類とtelemetryを実装し、PR #34を作成した（**未merge・未deploy**）。配信・保存・Fact・通知の挙動は不変。K2待ち。
- changed_files：
  - `supabase/functions/personalized-reports/delivery_policy.ts`（新規。純粋関数）
  - `supabase/functions/personalized-reports/index.ts`（+9行。source_basisにtelemetryを付与し、logに2項目を追加）
  - `supabase/functions/personalized-reports/delivery_policy_test.ts`（新規）
- tests：
  - 新規 **8/8**
  - 既存の回帰：no_material 7/7、morning_contract 8/8、report_hardening 9/9、close_validator 23/23、MIC 14/14・6/6、report_upgrade 16/16、report_logic 22/22
  - personalized-reports **119/119**、関連スイート **241/241**
  - deno check・lint・diff checkはPASS
- commit_hash：PR head `40828d31124a629e594c7ac2ac3af28e5325f6de`
- push：`origin/g2-voice-policy-phase1-shadow-20260925`。PR https://github.com/anohi-memories/kabumori/pull/34
- deploy：なし
- safety_checks：
  - production mutation 0（本番への接続もしていない）。
  - `report_logic.ts`・MIC・market_detail・_shared・prompt・validator・parser・DB・cronは未変更。
  - 共有ファイルは未変更。

### 分類の設計（`classifyDelivery(outcome)`）

完了済みのReportOutcomeだけを入力にし、生成・検査・保存には関与しない。

- **PASS**：completed で、Factが合格。
- **WARN**：ローカル検査の不合格が、**文体系のcodeだけ**の場合。
  - 対象：`TITLE/SUMMARY/OVERVIEW/IMPACT/WATCH_NOTE/MORNING_REVIEW_TOO_LONG`、`TOO_MANY_WATCH_NOTES`、`RISK_NOTES_INVALID`、`CONTAINS_LATIN_WORD`、`CONTAINS_EMOJI`、`CONTAINS_NEWS_LABEL`、`CONTAINS_ISO_DATE`
- **BLOCK**：既存の遮断要因を写すだけ。
  - 対象：Factの不合格、ローカルのFact・Safety系code（`NUMBER_NOT_IN_PACKET`、`UNKNOWN_*_TICKER`、`DUPLICATE_TICKER_NOTE`、`MISSING_HOLDING_IMPACTS`、`BASIS_NOT_AVAILABLE`、`STANCE_*`、`FALSE_NO_MATERIAL_CLAIM`、`INFERENCE_NOT_HEDGED`、`CONTAINS_INVESTMENT_ADVICE`、`CONTAINS_URL`、`CONTAINS_MARKUP`、`CONTRADICTS_SHARED_MARKET`、`UNSUPPORTED_MULTI_DAY_WORD`、`MORNING_REVIEW_ON_MORNING`、`CHECKPOINTS_INVALID`、`NOT_JAPANESE`）、構造エラー（`REPORT_INSUFFICIENT_INFORMATION`、`EMPTY_FIELD`、`INVALID_OUTPUT`、`EMPTY_OUTPUT`）。
  - **未知のcodeはBLOCKにする**。
  - report_logicが出すcodeがすべて、どちらか一方にだけ分類されていることをテストで固定した。
- **unavailable**：データの遮断（`NO_TRACKED_STOCKS`、`PRICES_UNAVAILABLE`）、transportや想定外のエラー、分類器自体の例外。`classifyDelivery` は例外を投げない。

### telemetryの形（`source_basis.delivery_policy`。既存のjsonbなのでmigration不要）

```json
{ "version": "delivery_policy.v1_shadow", "mode": "shadow",
  "voice_status": "pass|warn|block|unavailable",
  "warning_codes": [], "block_codes": [],
  "delivery_blocked_by": "data|infra|structure|local_fact_safety|local_style|fact|null",
  "would_deliver_under_warn_policy": false,
  "rewrite_attempted": false, "rewrite_succeeded": false, "fallback_original_used": false }
```

- `delivery_blocked_by`：現行の挙動で**実際に**配信を止めた要因。
- `would_deliver_under_warn_policy`：shadowの指標。文体だけで不合格になった場合もFactは未実施なので、falseになる。
- rewriteとfallbackは、Phase 1では常にfalse。
- 同じ情報をrun logとレスポンス（エンドユーザーには見えない）にも出している。アプリの画面には出さない。

### 挙動が変わらないことの証明

- `report_logic.ts` は変更していない。`index.ts` は `withDeliveryPolicy(sourceBasis, outcome)` を渡すことと、logに2項目を足すことだけ。
- テストで確認したこと：`app_enabled=false`（legacy lane）で、実際の `generateReport` の5つの結果について、`reportUpdate` が**source_basis以外の全列で完全に一致**し、source_basisの差分は `delivery_policy` キーの追加だけ。
  - 5つの結果：passed／Factの不合格／文体系のみのローカル不合格／情報不足／transportエラー。
  - このため、通知の条件（`status === "completed"`）も同じ。
- sourceのテストで、index.tsの保存・通知・dry_runのガード（`if (!dryRun && reportId)`、`if (update.status === "completed")`）が不変であることを固定した。

### recommended next step

1. K2でPR #34を確認する。shadowだけの低リスクな変更なので、現行の方針どおり、新たなCodexレビューは不要と判断している。
2. merge後のdeployは、別途の承認で行う。deployしてもshadowなので、配信の挙動は変わらない。
3. **月曜9/28の自然cron（朝刊08:35・大引け17:15）のread-only確認**は、別のgateとしてそのまま実施する。PR #34をdeployしていれば、同じ確認でtelemetryも観測できる。
4. 1〜2週間分のtelemetry（voice_statusの分布、`local_style` による欠配の件数）を見てから、Phase 2（flagによる `warn_deliver`、rewriteとfallback）を設計する。
