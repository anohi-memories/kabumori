# Claude Task 3

- task_id: x-universal-oauth-refresh-stage3a-production-apply-20260926
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
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

- task_id: x-universal-oauth-refresh-stage3a-production-apply-20260926
- result: K3 ready — Stage 3A DB layer applied to production and read-back PASS. No hard stop triggered.
- model: Opus 5.5
- user_approval_in_chat: 2026-09-26 22:53 JST「進める」（Stage 0 PASS 報告後）
- source: PR #38 fixed head `748deb13a934129e5696ab5552401f547204b32c`. `050d62f..748deb1` changed only `x-test-post/vault_account_auth.ts` (+test); migration/tests identical. Applied file = `git show 748deb1:supabase/migrations/20260926032054_x_account_refresh_rollout_authority.sql`, sha256 `75eb5f855eed84e28a09e89ea6decf6d352c9fed2a08b0790a53582eebd2b5e9`.
- stage0 (read-only, 22:52 JST): PASS
  - A: state table present; 9 core functions md5 = Stage 1 read-back (unchanged); live begin owner postgres / SECURITY DEFINER / `search_path=""` / EXECUTE postgres+service_role only; Stage 3A objects absent (table, 4 functions, any `%rollout%` relation = 0); triggers = the 2 core triggers only.
  - B: history `20260925140000`=unrecorded, `20260926032054`=unrecorded, latest recorded `20260924024406` (known debt).
  - C: grandfather candidates = **1**: `ai_salaryman_lab_x`（handle `kaishain_ai_lab`, platform_user_id set, identity_verified, generation 6, idle, no error）. Re-checked just before apply: 1, refreshing leases 0.
  - D: `sa_bfdab0e0…` publish false / no refresh state → not eligible; Kabumori `kabumori_x` has no Vault refs (legacy); shared refs 0.
- apply: `supabase db query --linked -f <that single file>` (Management API, file's own `begin; … commit;`), 22:53:55 JST, exit 0, empty result, no error. No db push / include-all / repair / other files / manual SQL.
- readback_rollout_table: exists; columns `social_account_id, mode, pilot_expires_at, pilot_max_generation, reason_code, updated_at`; constraints mode∈off/pilot/enabled, pilot shape, reason code format, PK, FK→social_accounts; RLS on; owner postgres; anon/authenticated no privileges; service_role SELECT only. Rows: exactly `ai_salaryman_lab_x = enabled / GRANDFATHERED_PROVEN_REFRESH` (no pilot fields); no other row.
- readback_functions: `x_account_refresh_authority`（stable, owner-only EXECUTE）、`set_x_account_refresh_rollout`（service_role）、`get_x_account_refresh_health`（stable, service_role）、`resolve_stale_x_account_refresh_lease`（owner-only）、`begin_x_account_refresh_legacy_post`（grants unchanged: service_role）— all SECURITY DEFINER, owner postgres, `search_path=""`. anon/authenticated EXECUTE on any `%x_account%`/`%legacy_post%` function: none. Health result columns contain no token / secret id / lease token.
- readback_md5: the 5 new/replaced functions' `pg_get_functiondef` md5 match a disposable apply of the same file 5/5; production begin definition text byte-identical to the disposable one; other 8 core functions md5 unchanged.
- legacy_begin_semantics: = core body + the single pre-Vault authority call (static test in PR #38 pins this against the core file; production text identical to that source).
- health_rpc (read-only call): `ai_salaryman_lab_x` enabled / allowed / idle / gen 6 / not stuck / no reauth; `kabumori_x` off / `X_REFRESH_CREDENTIAL_NOT_CONFIGURED`; `sa_bfdab0e0…` off / `X_ACCOUNT_PUBLISH_DISABLED`.
- ai_lab: rollout row enabled (data-driven grandfathering, no hardcoded identity); refresh state unchanged (idle, gen 6, no error, same last_refreshed_at); social_accounts rows of all accounts unchanged (status/publish/error/updated_at).
- other_accounts: no other rollout row; none pilot/enabled.
- advisors (security, linked): 10 findings, same breakdown as baseline (authenticated_security_definer 6, anon_security_definer 2, function_search_path_mutable 1, auth_leaked_password_protection 1); attributable to 3A/core: 0.
- migration_history_after: `20260925140000` and `20260926032054` both still unrecorded (no repair, as instructed).
- production_mutations: exactly one — the Stage 3A migration apply (table + 4 functions + begin replacement + 1 grandfather row). Edge deploy 0 / env change 0 / token refresh 0 / X post 0 / rollout change 0 / repair 0.
- observation: x-test-post is v124 but its code is byte-identical to `777997a` (= origin/main = my Stage 1 v121 deploy, updated_at 00:49 JST). The +3 versions correspond to the three `X_VAULT_ACCOUNT_REFRESH` secret changes in Stage 2; no other deploy.
- remaining_risks:
  - live Edge is still the pre-3A TS (no rollout-refusal handling / proactive not-started handling from PR #38). With AI Lab enabled this is harmless; for an account set to off/pilot-limited, the old Edge throws the rollout code on 401 without recording `X_ACCESS_TOKEN_UNAUTHORIZED` (fail-closed, no token request).
  - PR #38 is not merged yet: main does not contain the applied migration file until it merges.
  - migration history debt unchanged (never `db push`).
  - AI Lab now depends on its rollout row; turning it `off` stops its refresh.
- stage3a_db_ready_for_next_step: yes — DB authority layer proven in production; ready for a separately gated PR #38 merge + x-test-post deploy/observation task.
- next_recommendation: ChatGPT K3 → merge PR #38 (reviewed head `748deb1`) and a gated Edge deploy + one AI Lab expiry-cycle observation; migration-history single-version normalization as its own approved task.


## Final K3 — Stage 3A production apply

Verdict: **PASS**.

- applied only `20260926032054_x_account_refresh_rollout_authority.sql` from reviewed PR #38 fixed head `748deb13a934129e5696ab5552401f547204b32c`.
- immediate pre-apply grandfather candidate set was exactly one proven AI Lab account; no refreshing lease present.
- post-apply rollout table/constraints/RLS/grants PASS; exactly one row exists and AI Lab is `enabled / GRANDFATHERED_PROVEN_REFRESH`.
- no other account is pilot/enabled; Kabumori remains on legacy non-Vault path.
- Stage 3A functions and replaced legacy begin owner/SECURITY DEFINER/search_path/EXECUTE grants match reviewed design; anon/authenticated receive no unintended access.
- function definitions match disposable application 5/5; other core definitions unchanged.
- advisor delta attributable to Stage 3A: 0.
- migration history debt remains intentionally unnormalized; no repair/db push occurred.
- production mutations were limited to this migration apply; Edge deploy/env/token refresh/X post = 0.
- DB authority layer is ready for the next separately scoped PR #38 merge + Edge deploy + one natural AI Lab expiry-cycle observation.
- no additional Codex review is required before that continuation unless new semantic changes are introduced.
