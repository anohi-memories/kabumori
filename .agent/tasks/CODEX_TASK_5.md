# H5 CURRENT TASK — Claude API consumer integration bridge M2（Codex臨時実装）

- task_id: common-ai-h5-claude-multimodel-consumer-bridge-m2-20261014
- owner: codex
- slot: codex-5
- status: review_required
- next_owner: chatgpt
- start_code: H5
- finish_code: C5
- completion_code: C5
- return_to: **共通AI基盤のちゃ（OpenAI・Claude API専用チャット）**
- recommended_model: **Sol（高）**
- type: user-explicit Codex temporary implementation
- source_only: yes; Draft PR only; production mutation window CLOSED
- previous_task_archive: .agent_v2/archive/2026-10-14-h5-threads-runtime-task.md
- previous_report_archive: .agent_v2/archive/2026-10-14-h5-threads-runtime-report.md

## Goal
既存のOpus朝刊/大引け生成はそのまま稼働させ、F6が作成したClaude Sonnet/Haiku/Opusのマルチモデル方針を**他の各機能から安全に呼び出すための実装可能な consumer bridge**を独立した新規モジュールに作る。これは汎用接続基盤の実装であり、F2/ F8/ F9/ F1/ POSTONA の各業務機能を勝手にClaudeへ切り替えるTASKではない。

## Dependencies / owners
- F6 Draft PR #187 HEAD a7e1d3f3f6b3812e9b8b0c0f7c29835e25505d6b: model_policy.ts, model_policy_test.ts, model_catalog.ts, mod.ts, docs/ai-provider/F6_M1_ANTHROPIC_MULTIMODEL.md. These files belong to F6. DO NOT modify or rebase the F6 PR/branch.
- F6 previous L6: PASS_OFFLINE_SOURCE, F6.md done, F6 ACTIVE_TASK.md stale review_required as of assignment; only F6 chat reconciles it. Do not take over F6 slot.
- Old H5 Threads task done/C5 accepted and archived; H5 reassignment is explicitly requested by user on Oct 14. Do NOT touch old Threads PR139/#159/#161, POSTONA G4 worktree/files.
- F2 owns report prompts/handler, F8 news improvements, F9 API optimization, F1 AIに質問; protected for this TASK.

## Mandatory start gates
H5 startup 2026-10-14: fresh main `1c3c404d`, PR187 exact `a7e1d3f3f6b3812e9b8b0c0f7c29835e25505d6b` OPEN/Draft unchanged. New H5-only source/report worktrees `/private/tmp/kabumori-h5-m2-20261014.UB5vOx`, source branch `codex/h5-claude-consumer-m2-20261014`. F6 TASK done but index stale review_required, untouched. New import requires F6-owned isolation allowlist approval; no existing test/policy modified, no live/paid calls.
1. Confirm fresh origin/main, PROJECT_RULES.md, .agent/ORCHESTRATION.md, new+old ACTIVE_TASK/CURRENT_STATE, H5 old C5 report, latest F6 PR187 head/base and affected paths, other slot PRs/current TASKs, clean independent H5 worktree/checkout. If changed ownership or overlapping paths prevent isolation, STOP and report instead of overwriting.
2. Draft a new isolated H5 branch stacked on exact PR187 head only if PR187 remains unchanged; else adjust plan only after assessing current states. No modification of F6 model policy/catalog/mod/tests or any other slot paths. Source-only operation.
3. Confirm public interface and Deno import boundaries of F6 `model_policy.ts` from source read; do not guess signatures. Resolve model by registered role policy, not caller-controlled untrusted model IDs.

## Work (new-file-only integration adapter)
A. Implement a standalone reusable consumer bridge under a **new dedicated path** such as `supabase/functions/_shared/ai_consumer_bridge/` (not editing `_shared/ai_provider/` F6-owned files). Expose typed integration interface: approved feature/role, tenant-safe attribution, bounded limits/timeouts, schema/Fact validation hooks, deterministic idempotency key and audit-safe result/error. Call F6 model policy through its documented exports. If new-code-only path is insufficient, explicitly BLOCK with required F6 handoff; never change F6 files.
B. Provide mock implementations/adapters for 2 representative non-live workloads (e.g. news severity classifier using Haiku, news summary using Sonnet) exclusively as **offline samples under the new module tests/docs**. Do not hook live news monitor or overwrite F8/F9 programs. No automatic cross-provider or alternative-model fallback.
C. Implement tests for role/model mapping, invalid role/unauthorized overrides, tenant isolation, budget denied before network, retries/idempotency, bounded token and costs, structural schema errors, no secrets in errors/logs. Run with denied network, mocked transport, and locked no live credentials; check no paid calls.
D. Integration guide documenting how F8/F9/F1/F2 or POSTONA can attach later with own TASK, actual request/response format and schema, explicit budget-policy/feature migration approval, rollback/quality/cost plan. No fabricated model IDs, no undocumented secret/value access.
E. Report exact files changed, tests, actual commit SHA, PR URL/base/head, remaining issues and cross-slot handoffs. New Draft PR; may be stacked on PR187, but no GitHub merge without new user approval.

## Change permissions
- ALLOW: ONLY new `supabase/functions/_shared/ai_consumer_bridge/**`, `docs/ai-provider/H5_M2_*.md`, .agent/tasks/CODEX_TASK_5.md, .agent/CODEX_REPORT_5.md, old ACTIVE_TASK H5 section.
- FORBID: existing `_shared/ai_provider/**` including PR187, market-report-analysis live and F2-owned source, important-news-monitor/news_discovery (F8), API optimization (F9), F1 AI ask, POSTONA, DB/RLS/RPC/Edge/secrets/Cron, any live AI calls/X post/deploy/paid requests, other slot branches/worktrees. Any mandatory modification of existing shared code must be proposed as F6 handoff, not performed.

## Completion criteria / C5
- Safe typed bridge + at least two mock role integration examples, offline tests and regressions if compatible; only new files and H5 metadata/report changed; F6 PR intact.
- Report includes test counts, files, branch/base/main readback, PR/CI, merge/deploy/production=none, security/tenant/idempotency checks, model/ledger budgeting, known dependencies.
- Finish `status: review_required`, `next_owner: chatgpt`, append latest Report at top of `.agent/CODEX_REPORT_5.md`.
- **共通AI基盤のちゃ（OpenAI・Claude API専用チャット）へ C5 を送ってください。**

## Latest Report — 2026-10-14 H5 M2

- result: IMPLEMENTED_OFFLINE_CANDIDATE / F6_IMPORT_BOUNDARY_BLOCKED / MERGE_HOLD / PRODUCTION_NO_GO
- source: Draft PR198 https://github.com/anohi-memories/kabumori/pull/198; head `4223d5c01389474406291c8e4578207e317638b9`; base F6 PR187 branch/exact `a7e1d3f3f6b3812e9b8b0c0f7c29835e25505d6b` unchanged.
- changes: only 9 new bridge/test/scoped Deno dependency/guide files. Existing F6/provider and F2/F8/F9/F1/POSTONA runtime source unchanged; no live consumer wired.
- tests: H5 offline27 PASS/0 FAIL. Exact F6 baseline19 PASS/0 FAIL; H5-added unchanged F6 policy/isolation16 PASS/3 FAIL (policy11 PASS; isolation5 PASS/3 FAIL). Deno type/lint/shell/diff checks PASS. Native network denied, fake reader/transport only; child optional SDK env defaults scrubbed.
- blocker: F6 exact import/reachability/widening allowlists reject new bridge imports; SDK optional env default containment not proven under fully denied env. Do not modify F6 here; bounded F6-owner follow-up required before merge.
- remaining: verified Auth/tenant mapping, durable atomic claim store and shared ledger integration/monthly budgets, each feature's rights/quality/cost/activation approvals require separate TASK. Test fakes are not production proof.
- push: source branch verified; bookkeeping submitted separately for review, not direct main sync. merge/deploy/paid/live/production mutations: NONE. Detailed evidence in `.agent/CODEX_REPORT_5.md`; next action C5 source review + F6 handoff, not activation.
- CI readback: PR198 existing automatic Vercel check FAIL (deployment rate limited); no successful deploy, no manual retry or settings mutation. Report pre-push fresh main `6e2f46ca13c4055fc17b18abec11d2926b51789e`, unrelated J3/J5 metadata only.
