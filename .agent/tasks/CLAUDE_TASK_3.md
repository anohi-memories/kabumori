# Claude Task 3

- task_id: x-universal-oauth-refresh-production-stage0-2-20260926
- owner: claude
- slot: claude-3
- status: in_progress
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: reviewed universal X OAuth refreshをproductionへ段階反映し、AI Labの401障害を1アカウント限定で復旧確認する。

## Authorization

User approved proceeding on 2026-09-26 JST.

This task is limited to:
- Stage 0 read-only production preflight
- Stage 1 reviewed core migration only + reviewed x-test-post deploy with refresh gate OFF
- Stage 2 one controlled AI Lab recovery validation
- safe rollback / gate OFF on any anomaly

Not authorized:
- Phase1B–1I bulk activation
- generic all-account rollout
- Kabumori credential migration
- unrelated DB/Auth/Cron/Admin/important-news changes
- bulk replay of failed posts

## Reviewed source

- universal refresh source merged through PR #37
- merge: `777997a13c39c12ba409a0c6dc95cad18360038a`
- C1/K3 accepted
- Kabumori legacy path unchanged
- production mutation before this task: 0

## Mandatory startup

1. Read PROJECT_RULES.md, .agent/ORCHESTRATION.md, .agent/CURRENT_STATE.md and H1/C1 report.
2. Read current Supabase changelog/docs relevant to migrations, Edge Functions and secrets.
3. Fresh fetch origin/main and require no semantic drift in reviewed refresh files.
4. Use independent G3 worktree.
5. Do not touch apps/admin/**, important-news/common-search, or H1 PR #33 files.
6. Never print token values, secret values, secret identifiers, Authorization headers, or raw sensitive provider bodies.

## Stage 0 — read-only preflight

Confirm:
- reviewed core objects are not already applied under another migration.
- required social_accounts / scheduled_posts schema and constraints still match review assumptions.
- AI Lab exact X account is publish-enabled, uses default OAuth client routing, and has both required credential references present and distinct.
- no credential reference is shared across accounts.
- Kabumori remains on its legacy credential path.
- live x-test-post baseline and refresh gate state are known.
- required server-side OAuth client configuration is available without revealing values.
- migration history and apply path are safe for the reviewed single core migration.

Any material drift => STOP with production mutation 0.

## Stage 1 — reviewed core + Edge deploy, gate OFF

Apply only:
`supabase/migrations/20260925140000_x_account_credential_refresh_core.sql`

Do not apply Phase1B–1I or unrelated migrations.

After apply, read back:
- functions/table/trigger definitions
- SECURITY DEFINER / search_path / owner
- EXECUTE and table grants
- no unintended PUBLIC access
- migration history
- new security/advisor findings attributable to this migration

If read-back differs materially from reviewed source => STOP before deploy.

Then deploy the exact reviewed `x-test-post` source from fresh main with refresh gate OFF.

Verify:
- deployed source/version corresponds to reviewed main
- gate remains OFF
- no real refresh occurred
- no credential write occurred
- Kabumori behavior/source remains unchanged

Mismatch => rollback Edge deployment if safe, keep gate OFF, STOP.

## Stage 2 — one controlled AI Lab recovery

Only if Stage 1 passes.

Immediately re-check exact AI Lab account binding and that no refresh/reconnect is already in progress.

Enable the reviewed refresh gate only for the controlled validation window.

Observe exactly one AI Lab due attempt. Do not replay historical failures or create duplicates.

Required proof:
- exact AI Lab account is the only account used
- at most one refresh request
- at most one safe retry of the intended X request
- account health state updates truthfully
- no other account is changed
- Kabumori credential path remains untouched

Hard stop and gate OFF on:
- invalid_grant / reauth-required outcome
- uncertain/network/timeout/server error
- second 401
- lease or account mismatch
- persistence/commit failure
- deadlock
- unexpected duplicate provider request
- any cross-account effect

No automatic retry after a hard stop.

After the single validation, return gate to OFF unless keeping it ON is proven to affect only this exact account and is separately justified. Generic Stage 3/4 enablement is not part of this task.

## Verification

Record only non-secret evidence:
- Stage 0 PASS/STOP
- exact migration applied and migration history entry
- ACL/search_path/owner read-back
- advisor result
- deployed x-test-post version/source identity
- gate before/during/after
- controlled AI Lab attempt result
- refresh count and X create/retry count
- account health before/after
- Kabumori unchanged
- cross-account mutation check
- rollback action if any
- actual production mutations performed
- whether AI Lab normal scheduling is recovered
- remaining risks

## Completion / K3

Set:
- status -> review_required
- next_owner -> chatgpt

STOP for K3.

## Report

- pending
