# Claude Task 3

- task_id: x-universal-oauth-refresh-stage3a-rollout-foundation-20260926
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: AI Labでproduction実証済みのUniversal X OAuth refreshを、将来の全ユーザー運用へ安全に広げるためのStage 3A rollout foundationを実装する。全ユーザー一括ONはしない。

## Background

Stage 0–2 production rollout completed:
- x-test-post v121 live
- reviewed core refresh migration live
- AI Lab scheduled posts recovered
- refresh generation 0→1→2 proven under real expiry/401 behavior
- Kabumori legacy path unchanged
- cross-account mutation 0
- current global refresh gate is ON for existing eligible Vault-backed flow

Known risk:
- current gate can affect future Vault-backed + publish-enabled accounts if they become active
- this is not sufficient as a public multi-user rollout control
- core migration SQL is live but migration history entry is absent; do not blind db push/repair

## Goal

Build the source/schema/observability foundation required so rollout can be controlled **per X account**, not merely by one global environment gate.

Stage 3A must make it possible to safely classify each X account as:
- not eligible / off
- controlled pilot
- generally enabled

Exact schema naming is an implementation decision after inspecting current conventions. Do not invent a parallel authorization model if an existing field/state can safely represent this.

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - prior G3 Stage 0–2 report
   - prior H1/C1 OAuth/Vault/concurrency review
2. Use an independent G3 worktree/checkout.
3. Fresh fetch `origin/main`.
4. Read current Supabase skill.
5. Fetch current Supabase changelog index and relevant docs before implementing:
   - Edge Functions
   - secrets/env handling
   - Postgres/RLS/SECURITY DEFINER
   - migration workflow/history
6. Check current Supabase CLI version and discover needed commands with `--help`.
7. Do not touch G4/Admin Auth PR #33 files.

## Stage 3A requirements

### A. Explicit account-level rollout authority

Introduce one explicit source of truth for whether an X account may use universal Vault refresh.

Requirements:
- global env gate alone must never be enough for a newly eligible account
- eligibility must be exact-account scoped
- no brand-first fallback
- no first-row fallback
- no implicit "publish_enabled means refresh enabled" shortcut
- no cross-account credential lookup
- disabled/unconfigured accounts fail closed before token refresh

Prefer a small durable DB field/state on the exact social account or a dedicated tightly scoped rollout table, whichever fits the existing model best.

If schema is changed:
- RLS/GRANT/SECURITY DEFINER implications must be reviewed
- anon/authenticated must not gain privilege to enable their own rollout unless that is explicitly the intended product authorization model
- service-side mutation path must be explicit and minimal

### B. Rollout modes

Support at minimum:
- OFF
- PILOT
- ENABLED

Semantics:
- OFF: never refresh
- PILOT: refresh only when all pilot safety gates pass
- ENABLED: normal account-scoped automatic refresh

Do not infer mode from brand name, user email, row order, or env-only allowlist.

### C. Refresh eligibility contract

Centralize the exact predicate used before reading Vault credentials.

It must require, at minimum, the existing valid account health and publishability conditions plus account rollout authority.

The contract must be reusable by every future X publishing path.

Tests must prove:
- wrong account cannot inherit another account's rollout state
- disabled account cannot reach Vault read
- account with missing refs cannot reach refresh
- account with invalid health/connection state fails closed
- Kabumori legacy path remains unchanged
- PILOT/OFF/ENABLED behave exactly as specified

### D. Reauth/reconnect state

When refresh returns a terminal user-action case such as `invalid_grant`:
- exact account must move to the existing appropriate reauth/reconnect state if one exists
- if no existing state safely expresses it, add the narrowest required state/schema change
- automatic refresh must stop for that account
- scheduled posting must not silently fall back to stale/other credentials
- operator/user-facing state must be queryable without exposing token values

Do not build the full public reconnect UI in this Stage 3A unless it is already trivial and in-scope. Provide the stable backend contract for it.

### E. Observability

Add a read-safe operational view/query/RPC or existing-admin-compatible data contract for:
- rollout mode
- refresh state
- generation
- last refresh success time
- access expiry if already tracked
- last connection error code
- reauth required / stuck refreshing indication

Constraints:
- no token values
- no Vault secret IDs in end-user surfaces
- no Authorization headers/provider bodies
- least privilege
- if a DB view is used, follow current Supabase `security_invoker` guidance where applicable

### F. Stuck refresh safety

Preserve the current fail-closed concurrency model.

Add tests/detection for:
- stale `refreshing` lease
- reconnect-vs-commit conflict
- second 401
- uncertain token endpoint result
- owner/manual intervention path

Do not auto-replay an uncertain token refresh.

### G. Migration-history debt

The already-live core refresh migration is not currently recorded in `supabase_migrations.schema_migrations`.

For this Stage 3A:
- inspect and document the exact state
- do not blind `db push`
- do not blind `migration repair`
- if new schema is needed, devise a migration path that cannot accidentally replay the already-live core SQL
- production history normalization itself is NOT authorized unless a safe exact procedure is proven and separately reported

## Tests

At minimum:
- account A enabled / account B off isolation
- account A pilot / account B enabled isolation
- disabled account reaches zero Vault/token requests
- missing rollout state defaults fail-closed
- invalid_grant -> exact account reauth-required, no cross-account mutation
- uncertain refresh -> no credential commit
- second 401 -> no second refresh
- concurrent refresh lease behavior unchanged
- Kabumori legacy flow unchanged
- existing Phase1B–1I regression suites PASS
- x-test-post regression PASS
- _shared X regression PASS
- relevant scheduler/dispatcher regression PASS

Also run:
- TypeScript/lint/build where applicable
- SQL disposable DB behavior tests if schema/RPC changes
- Supabase advisors for DB security changes
- git diff --check
- targeted secret scan

## Production restrictions

Stage 3A is **source-first**.

Allowed:
- source implementation
- migration file creation using current Supabase CLI workflow
- local/disposable DB verification
- PR creation/update
- Netlify/CI-style source checks where relevant

Not allowed without a new explicit TASK:
- enabling rollout for any additional real X account
- changing AI Lab rollout mode
- generic all-user activation
- bulk Vault migration
- bulk reconnect/replay
- production migration apply
- production Edge deploy
- production env changes
- Kabumori credential migration

## Deliverable

Produce:
1. exact Stage 3A architecture
2. changed files
3. schema/data-contract changes
4. rollout mode semantics
5. reauth contract
6. observability contract
7. migration-history-safe deployment plan
8. tests/results
9. security checks
10. remaining work for:
   - Stage 3B controlled second-account pilot
   - Stage 3C multi-account pilot
   - Stage 4 general user rollout

## Completion / K3

Set:
- status -> review_required
- next_owner -> chatgpt

Report:
- task_id
- result
- changed_files
- tests
- commit_hash
- push/PR
- production_mutation=0 unless explicitly reauthorized
- migration_history_findings
- safety_checks
- remaining_issues
- next_recommendation

STOP for K3.

## Report

- pending
