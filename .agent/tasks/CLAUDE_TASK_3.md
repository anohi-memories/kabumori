# Claude Task 3

- task_id: x-stage3b-publish-authority-and-ai-lab-exclusion-fix-20260927
- owner: claude
- slot: claude-3
- status: in_progress
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: C1 FAILとなったPR #41 Stage 3B準備を修正する。bounded pilotを本当に「投稿停止」できる明示的publish authority/timeboxへ分離し、generic completion RPCからAI Labを明示除外する。source/test only。production activationはしない。

## Review source

- PR #41 reviewed head: `cd7adf5d1eb5a91773f21c7d8959766e1dd38229`
- H1 verdict: FAIL
- production mutation: 0

## Blocking findings to fix

### P1 — rollout refresh authority is not publish authority

Existing Stage 3A rollout OFF/PILOT/ENABLED gates refresh begin, not access-token read/X create.

Therefore a still-valid token can post when:
- rollout is off
- pilot expiry has passed
- pilot generation ceiling is exhausted
- rollout rollback has begun but brand/account disablement has not yet completed

Do NOT silently reinterpret Stage 3A refresh rollout as a publish gate for AI Lab.

Implement a separate explicit publish authority for Stage 3B generic Vault-backed brand_post only.

Required contract:
- checked immediately before generation/X publish and again immediately before X create if necessary to close TOCTOU
- exact social_account_id scoped
- no brand-first/first-row fallback
- no environment fallback
- fail closed when no publish-authority row
- bounded pilot start/end or equivalent explicit expiry
- explicit enabled/off/revoked state
- owner/user consent revocation must stop new posts
- admin disable / publish_enabled false / brand inactive must stop new posts
- revocation/off must stop new X creates even if access token is still valid
- pilot expiry must stop new X creates even if token is still valid
- refresh generation ceiling remains a refresh control only; do not mislabel it as publish lifetime
- AI Lab current production path/authority must remain behaviorally unchanged unless separately designed and approved
- Kabumori legacy path unchanged

Prefer the smallest clean schema/authority model that reuses existing account identifiers and consent settings. Do not invent a broad public policy system.

### P2 — generic completion RPC must exclude AI Lab

Update `complete_vault_account_brand_post` so it refuses:
- Kabumori
- AI Lab
- wrong account
- wrong brand
- non-running row
- rows belonging to legacy/specialized paths

Add the exact regression H1 described:
- matching AI Lab brand_post row + matching `ai_salaryman_lab_x` must still return/not-found/fail-closed and must not write fingerprint/log.

## Product contract for this task

For the Stage 3B pilot, the bounded pilot means:
- consent + admin enablement + explicit Stage 3B publish authority are all required
- expiration or revocation of any one gate stops NEW X posts
- rollback's first safety mutation should be the publish authority OFF/revoked gate because that gate must itself be sufficient to prevent new X creates
- subsequent brand/account/window disablement is defense in depth and cleanup
- owner consent is still required before any future production activation

This source task does NOT record real owner consent or activate a pilot.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, latest G3 report, latest H1/C1 report.
2. Use independent G3 worktree.
3. Fresh fetch origin/main and PR #41.
4. Read current Supabase skill and current relevant docs/changelog.
5. Verify PR #41 head before modifying.
6. Do not touch G4/PR #33.

## Tests required

At minimum add/verify:

1. valid token + publish authority missing => no generation/X create.
2. valid token + publish authority off/revoked => no X create.
3. valid token + publish pilot expired => no X create.
4. valid token + refresh generation ceiling exhausted but publish authority still valid:
   - if no refresh is required, behavior must follow explicit publish policy, not accidental refresh policy.
   - document the intended result clearly.
5. consent revoked => no X create.
6. brand disabled => no X create.
7. account publish disabled => no X create.
8. wrong account/brand => fail closed.
9. AI Lab cannot enter generic dispatcher/completion path.
10. Kabumori cannot enter generic dispatcher/completion path.
11. generic completion RPC rejects exact matching AI Lab row/account.
12. generic completion RPC rejects cross-account row.
13. rollback publish-authority OFF alone blocks new X create.
14. race/revocation near publish boundary fails closed or has explicitly documented atomicity semantics.
15. AI Lab existing tests unchanged/pass.
16. Stage 3A refresh behavior unchanged/pass.
17. no duplicate claims/posts.

Run:
- x-test-post relevant/full suite
- _shared relevant/full suite
- disposable PostgreSQL behavior/race/ACL tests
- deno check/lint changed files
- bash -n runners
- git diff --check
- targeted secret scan
- advisors for any new DB objects

## Migration/security rules

If a schema change is needed:
- create migration with current Supabase CLI workflow
- disposable/local verification only
- RLS on exposed tables
- SECURITY DEFINER only if truly necessary
- empty/fixed search_path
- revoke PUBLIC EXECUTE
- service_role-only internal mutations where appropriate
- no production apply
- no db push
- no migration repair
- do not replay historical migrations

## Production restrictions

production_mutation=0 required.

Do NOT:
- merge PR #41
- apply migration
- deploy Edge
- set rollout/publish authority in production
- enable candidate account/brand/window
- refresh token
- post to X
- modify AI Lab/Kabumori production state
- touch G4

## Deliverable

Report:
- final PR head
- publish-authority design
- how expiry/revocation blocks valid-token posting
- consent/admin/publish authority interaction
- AI Lab exclusion fix
- changed_files
- schema/migration details
- ACL/security review
- tests/results
- rollback semantics
- production_mutation=0
- whether corrected PR is ready for one focused re-review
- remaining product/operator gates

## Completion / K3

Set:
- status -> review_required
- next_owner -> chatgpt

STOP for K3.

## Report

- pending
