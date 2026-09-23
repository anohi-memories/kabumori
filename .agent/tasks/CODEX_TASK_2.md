# Codex Task 2

- task_id: social-mobile-app-phase20-production-history-access-rpc-rollout-20260923
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Sol
- purpose: Phase19 C2 PASS済みの `read_social_mobile_history_access_token(uuid,text)` SECURITY DEFINER RPC candidateだけをproductionへ安全に適用し、definition/owner/search_path/ACLをread-backする。Vault plaintext read・history-learning Function deploy・real X history callはこのPhaseでは禁止。

## Scope

This is a **single-RPC production security-boundary rollout**.

Allowed production mutation:
- apply exactly `supabase/migrations/20260923120000_social_mobile_history_access_token_reader.sql`
- only if fresh preflight confirms the candidate is still compatible and absent
- then read back exact function metadata/definition/ACL

Everything else remains out of scope.

## Mandatory fresh start

H2開始時:
1. `git fetch origin main`
2. fresh `origin/main`
3. `.agent/ORCHESTRATION.md`
4. `.agent/CURRENT_STATE.md`
5. this TASK
6. `.agent/CODEX_REPORT_2.md`
7. Phase19 migration + source + tests read-back
8. other-slot overlap check

If H1/G1/G2 now touches the same migration/RPC/Vault/history-learning production objects, STOP.

## Model policy

- **Sol推奨・原則Solで実施**
- 理由: production SECURITY DEFINER RPC + Vault access pathという本番security boundary mutation
- Lunaに落とさない
- ただし通常のread-only metadata read-backはSolのまま継続してよい

## Gate A — exact source integrity

Before touching production:
- confirm migration path exactly:
  `supabase/migrations/20260923120000_social_mobile_history_access_token_reader.sql`
- record exact SHA-256
- compare file contents with Phase19-approved candidate
- confirm no new drift in:
  - function name/signature
  - SECURITY DEFINER
  - fixed empty search_path
  - fully qualified public/vault references
  - revoke/grant ACL
  - service_role-only execute
  - no refresh-token selection
  - no arbitrary secret-id parameter
  - normalized error behavior
- rerun relevant static/security tests if source changed after Phase19

If migration drift exists, STOP for C2. Do not apply.

## Gate B — production read-only preflight

Target production:
- project: `stock-x-autopost`
- ref: `wsmznyzcvmuitkglfeuj`

Read-only preflight only:
- target RPC absent
- migration version/name not already recorded
- `social_accounts`, `brand_memberships`, `vault.decrypted_secrets` still exist
- required columns still have compatible types
- required roles `public`, `anon`, `authenticated`, `service_role` exist
- production Vault catalog shape still compatible
- no same-name/same-signature conflicting function
- existing OAuth/admin RPCs unchanged from latest known approved baseline
- no active parallel task mutating same objects

Do NOT select:
- `decrypted_secret`
- access tokens
- refresh tokens
- secret ids unless catalog/type metadata inherently requires object identity; do not report actual secret ids
- QA handle/user PII

If any preflight mismatch exists, STOP before mutation.

## Gate C — exact production migration apply

User has explicitly authorized proceeding to this production rollout by saying to continue after Phase19 C2 PASS.

Apply only the exact approved migration.

Rules:
- use migration API / exact migration application path
- no `supabase db push`
- no migration-history repair/reconcile
- no manual ad-hoc SQL rewrite in production
- no extra ACL/RLS/schema changes
- no Function deploy
- no Vault plaintext read
- no X call

If automated safety tooling blocks the apply, STOP and report. Do not work around it.

## Gate D — immediate postflight

Read back and verify:
- function exists exactly once:
  `public.read_social_mobile_history_access_token(uuid,text)`
- language = plpgsql
- SECURITY DEFINER = true
- search_path fixed exactly as candidate
- function owner recorded
- source/definition hash matches approved candidate semantics
- EXECUTE:
  - public = no
  - anon = no
  - authenticated = no
  - service_role = yes
- no extra overloads
- no refresh-token reference in function definition
- no generic secret selector
- migration history contains exactly one new corresponding entry
- existing OAuth/admin RPC definitions/ACL/search_paths unchanged
- no production row mutation expected

Do not call the new RPC with a real account in this Phase.

## Gate E — safe smoke without Vault plaintext

Permitted smoke:
- metadata/catalog validation only
- optional call that deterministically fails **before Vault read** using non-sensitive impossible/invalid identifiers, only if you can prove from function structure that failure occurs before Vault lookup

Preferred: skip invocation entirely if metadata/read-back proves rollout.

Forbidden smoke:
- any call capable of resolving a real account
- any Vault plaintext read
- any service-role token retrieval
- any X API call

## Rollback posture

Do not automatically rollback a successfully applied migration unless postflight finds a concrete critical defect.

If rollback is needed:
- STOP and report exact defect first
- design reverse migration separately
- do not ad-hoc drop/change the function without approval unless immediate security exposure exists and authorized safety tooling requires containment

## Verification

Minimum:
- exact migration hash recorded
- preflight PASS
- exact migration apply result
- postflight function metadata/ACL/search_path PASS
- existing OAuth/admin objects unchanged
- production Vault plaintext reads = 0
- X calls = 0
- Function deploys = 0
- publish changes = 0
- `git diff --check` / relevant tests if source was touched
- fresh origin/main before final control/report push

## Production boundary

Allowed:
- exactly one approved migration/RPC production apply

Forbidden:
- deploy `social-mobile-history-learning`
- wire service-role env into live Function
- call new RPC for a real account/token
- read Vault plaintext
- real X history API
- OAuth scope/Portal change
- persona/settings writes
- OpenAI live call
- X post/media/repost
- `publish_enabled=true`
- Cron/scheduler/scheduled_posts
- unrelated schema/RLS/ACL/RPC changes
- migration history repair
- blind db push

## Completion / C2

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- `.agent/CODEX_REPORT_2.md` must include:
  1. source SHA/hash
  2. production preflight
  3. exact migration apply result
  4. production migration history version/name
  5. RPC signature
  6. owner / SECURITY DEFINER / search_path
  7. exact ACL read-back
  8. no-refresh/no-generic-secret proof
  9. existing OAuth/admin compatibility read-back
  10. Vault plaintext read count = 0
  11. Function deploy = 0
  12. X history call = 0
  13. production mutations limited to this one RPC migration
  14. remaining risks
  15. next gate recommendation
- commit/push control files
- fresh origin/main verification
- STOP for C2

## Next gate after PASS

Only after C2 PASS:
- separate Phase21 for deploying `social-mobile-history-learning` with server-only configuration while keeping real history fetch disabled
- later separate QA phase for exactly-one real Vault read + X history fetch with explicit user consent
- publishing remains separate and disabled
