# Claude Task 3

- task_id: x-universal-oauth-refresh-stage3a-production-apply-20260926
- owner: claude
- slot: claude-3
- status: in_progress
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: C1 PASS-WITH-FIX済みのStage 3A rollout authorityをproductionへ限定適用し、exact-account rollout/ACL/grandfatheringをread-back検証する。Edge deploy・2つ目アカウントpilot・migration history repairは行わない。

## Authorization

User explicitly approved assigning this production-apply task on 2026-09-26 JST.

This task authorizes ONLY:
- read-only production preflight
- Stage 3A migration `20260926032054_x_account_refresh_rollout_authority.sql` の単独production apply
- apply後のread-back verification
- 必要なら安全な即時停止

Not authorized:
- x-test-post / Edge Function deploy
- global gate変更
- AI Lab rollout mode変更（migrationのdata-driven grandfathering以外）
- 2つ目の実アカウントpilot
- Stage 3B / 3C / 4
- bulk Vault migration
- reconnect/replay
- Kabumori credential migration
- `db push`
- `--include-all`
- migration repair
- historical batch migration apply
- unrelated DB/Auth/Admin/Cron/important-news changes

## Reviewed source

- PR #38
- reviewed source head: `050d62f57971c9d88420da993e9f839929d7197e`
- Codex fixed head: `748deb13a934129e5696ab5552401f547204b32c`
- C1 verdict: PASS-WITH-FIX
- production mutation before this task for Stage 3A: 0
- existing live core migration SQL is already applied but not recorded in remote migration history
- current AI Lab universal refresh is live and working under the prior Stage 0–2 implementation

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - prior G3 Stage 3A report
   - latest H1/C1 Stage 3A report
2. Use an independent G3 worktree/checkout.
3. Fresh fetch `origin/main`.
4. Read current Supabase skill.
5. Fetch current Supabase changelog index and relevant docs for:
   - migrations / SQL execution
   - SECURITY DEFINER / grants
   - RLS
   - Edge secrets only as background; do not change them
6. Check current Supabase CLI version and discover needed commands via `--help`.
7. Verify PR #38 fixed head `748deb13a934129e5696ab5552401f547204b32c` has not semantically drifted.
8. Do not touch G4/Admin Auth work.

## Stage 0 — production preflight (read-only)

Before any mutation, confirm:

### A. Core object identity

Verify the already-live core refresh objects still match the reviewed assumptions:
- required refresh state table exists
- required core functions exist
- current live `begin_x_account_refresh_legacy_post` owner / SECURITY DEFINER / search_path / EXECUTE grants match expected pre-Stage3A state
- no Stage 3A rollout table/functions already exist under another name/version
- no unexpected trigger/function replacement has occurred

Any material drift => STOP with production mutation 0.

### B. Migration history

Read-only inspect remote migration history.

Required:
- core migration version `20260925140000` remains unrecorded
- Stage 3A version `20260926032054` is unrecorded
- do NOT repair either version in this task
- do NOT use db push or historical batch apply

If state differs from expected, STOP and report exact discrepancy.

### C. Grandfather candidate set

Immediately before apply, query the exact rows that the migration's grandfather INSERT would select.

Required result:
- exactly one account qualifies
- it is the already-proven AI Lab exact account from Stage 0–2 evidence
- generation > 0
- refresh state idle
- no unresolved refresh error
- identity_verified
- no other account qualifies

Do not identify by brand name alone; verify exact account identity/binding using safe non-secret identifiers already used in prior reports.

If count != 1 or candidate differs => STOP before apply.

### D. Other accounts

Confirm:
- no other publish-enabled/Vault-backed account would become enabled implicitly
- Kabumori remains on legacy non-Vault path
- no cross-account credential-ref sharing has appeared since C1

Any unexpected delta => STOP.

## Stage 1 — apply only Stage 3A migration

Apply ONLY:

`supabase/migrations/20260926032054_x_account_refresh_rollout_authority.sql`

Use the exact reviewed file content corresponding to PR #38 fixed head `748deb1`.

Safety rules:
- no db push
- no include-all
- no migration repair
- no other migration file
- no manual SQL edits during apply
- execute as one bounded operation using the documented linked SQL/file path appropriate for the installed CLI
- capture only non-secret command/result metadata

If apply fails or output is ambiguous:
- STOP
- do not retry blindly
- do not partially recreate objects manually
- do not run repair
- report exact non-secret failure

## Stage 2 — post-apply read-back

Immediately after successful apply, verify:

### A. Rollout table

`x_account_refresh_rollout`
- exists
- expected columns/constraints/modes
- RLS enabled
- no anon/authenticated write access
- service_role SELECT as designed
- row count and contents exactly match expected grandfather result
- exactly AI Lab is `enabled`
- no unrelated account is `pilot` or `enabled`

### B. Authority and RPCs

Verify exact function definitions/metadata for:
- `x_account_refresh_authority`
- `set_x_account_refresh_rollout`
- `get_x_account_refresh_health`
- `resolve_stale_x_account_refresh_lease`
- replaced `begin_x_account_refresh_legacy_post`

Check:
- owner
- SECURITY DEFINER/INVOKER
- empty/fixed search_path as reviewed
- EXECUTE grants
- no PUBLIC/anon/authenticated exposure beyond design
- service_role-only mutation path
- owner-only stale lease resolver
- no token/secret/lease-token exposure from health RPC

### C. Live begin semantics

Read back `begin_x_account_refresh_legacy_post` and confirm:
- semantically matches reviewed core body
- only intended Stage 3A pre-Vault authority call was added
- exact-account authority check happens before Vault-related reads
- no unrelated publish behavior drift

### D. Grandfathering

Verify:
- AI Lab row exists as `enabled`
- source is data-driven grandfathering
- no hardcoded identity
- no second account enabled
- existing AI Lab refresh state/generation/error state unchanged except rollout row creation

### E. Advisors

Run current supported Supabase security/advisor check if available.

Record:
- existing baseline findings
- any new findings attributable to Stage 3A

Any new security finding attributable to Stage 3A => STOP and report; do not proceed to later stages.

## Stage 3 — no Edge deploy

This task STOPS after DB apply/read-back.

Explicitly DO NOT:
- deploy x-test-post
- change `X_VAULT_ACCOUNT_REFRESH`
- trigger manual token refresh
- trigger manual X post
- enable a second account
- change AI Lab rollout row
- normalize migration history

Reason:
the Edge source currently live must be handled in a separately gated task after this DB authority layer is proven in production.

## Required report

Record:
- task_id
- exact source/PR head used
- Stage 0 preflight PASS/STOP
- exact grandfather candidate count before apply
- migration apply command class used (no secrets)
- migration apply result
- rollout table/rows read-back
- function owner/search_path/security/grants read-back
- legacy begin semantic read-back
- AI Lab rollout row result
- other-account rollout result
- advisor delta
- migration history state after apply
- production mutations performed
- confirmation that Edge deploy/env/token refresh/X post = 0
- remaining risks
- whether Stage 3A DB layer is ready for the next separately gated Edge deployment/observation step
- next recommendation

## Hard stops

STOP immediately on:
- grandfather candidate count != 1
- unexpected qualifying account
- source/head drift
- unexpected existing Stage 3A objects
- migration history mismatch beyond known debt
- partial/ambiguous migration execution
- ACL/search_path/owner mismatch
- PUBLIC/anon/authenticated privilege expansion
- rollout row mismatch
- unrelated account enabled
- Kabumori path change
- new advisor finding attributable to this migration
- any token/secret exposure
- any cross-account mutation

Do not attempt automatic recovery from a hard stop.

## Completion / K3

After successful apply/read-back OR safe stop:

- status -> review_required
- next_owner -> chatgpt
- STOP for K3

## Report

- pending
