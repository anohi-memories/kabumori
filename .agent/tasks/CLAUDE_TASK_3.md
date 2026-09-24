# Claude Task 3

- task_id: x-autopost-phase1g-multistep-tip-greeting-completion-20260925
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: Phase1Fで導入したprovider-step ledgerを使い、tip thread と morning_greeting のmulti-request投稿を安全に完了できるsource-only completion/provider-step契約を実装する。production apply/deploy/X API callは行わない。

## Previous K3 closure

Previous task:
- `x-autopost-phase1f-pr25-merge-postmerge-verify-20260924`

Final K3 result:
- PASS
- PR #25 reviewed head `b3740cc7c39010f02ad3505721a5b37d2e707dba` merged unchanged
- merge commit `b2fdc1f58114eac55b3f31a1f781e3c555558cf4`
- focused Phase1B/1D/1E/1F 55/55 PASS
- x-test-post 429/429 PASS
- _shared 120/120 PASS
- important-news-monitor 431/431 PASS
- disposable Phase1D/1E/1F behavior/race PASS
- production mutation 0 excluding GitHub merge

Phase1F is now on main as source candidate only. Production activation remains prohibited.

## Goal

Close the two remaining multi-request completion blockers:

1. `tip` thread posting:
   - multiple create requests
   - reply chaining
   - partial success/uncertain outcome
   - exactly-once DB completion after all expected parts confirm

2. `morning_greeting`:
   - media upload
   - tweet create
   - publish_claims / receipt lifecycle
   - partial media/create outcomes
   - exactly-once same-day completion

Do not enable either type in production.

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read Phase1F migration/docs/tests and H1 C1 findings
6. Fresh fetch origin/main
7. Confirm dedicated independent G3 worktree
8. Inspect G4/H1/H2/G1/G2 scopes and prove no overlap
9. Audit the current legacy tip thread and morning_greeting posting/completion paths end-to-end
10. Record production-only dependencies separately; do not infer them from source

## Scope A — tip provider-step contract

Audit current `postThreadToX` and legacy tip completion.

Define exact durable step semantics for a thread:
- step 1 = root `create_post`
- step N>1 = `create_reply`
- each reply parent must equal the previous confirmed X post id
- expected part count must be known before starting provider execution
- no step may start until the previous step is confirmed
- confirmed step cannot be replayed
- rejected/uncertain step blocks later steps
- retry must never duplicate already-confirmed parts

Store enough data to prove:
- part index
- expected total parts
- step kind
- parent id where applicable
- confirmed X post id
- terminal error/outcome

Do not collapse a multi-part thread into one X id.

## Scope B — tip atomic completion

Implement a versioned source-only completion for `tip` that succeeds only when:
- all expected thread steps exist
- every expected step is confirmed
- reply chain is internally consistent
- no extra/unexpected step exists
- attempt/account/post/claim identity matches
- post is still in valid running state

One DB transaction must:
- mark schedule success
- finalize v2 attempt
- preserve all confirmed thread X ids in an auditable structure
- perform legacy-equivalent tip usage/topic side effects exactly once
- write exactly one success execution log
- reject duplicate/replayed completion without duplicating counters/logs

If source legacy semantics cannot be reproduced exactly, stop and keep tip disabled instead of approximating.

## Scope C — morning_greeting provider-step contract

Audit current:
- image/media generation/storage
- media upload
- tweet create
- publish_claims
- receipt / asset references
- completion/logging

Define durable steps at minimum:
1. media_upload
2. create_post

Required:
- create_post cannot start until media_upload confirmed
- media id used by create_post must equal the confirmed media step output
- confirmed media must not be re-uploaded automatically after later uncertainty
- tweet uncertainty must not cause blind replay
- same-day publish claim ownership must remain tied to the same post/attempt/account
- stale or competing attempt cannot reuse another attempt's media receipt

## Scope D — morning_greeting atomic completion

Implement source-only completion only if all source-backed side effects can be preserved exactly.

A successful completion transaction must cover:
- scheduled_posts
- attempt ledger
- provider-step records
- publish_claim / receipt state
- greeting-specific success metadata
- execution log

If storage receipt lifecycle requires an external/non-transactional system that cannot be atomically proven, model the durable DB receipt boundary explicitly and keep any unsafe transition fail-closed.

## Scope E — multi-step provider helpers

Add server-only helpers for:
- begin next provider step
- finish confirmed/rejected/uncertain step
- return only the next safe action
- reconstruct confirmed prior step ids without secret leakage

No helper may:
- auto-loop through all steps without persisting each boundary
- retry an uncertain step
- re-upload confirmed media
- recreate a confirmed tweet/reply
- infer account by brand

Reuse Phase1E exact-account credential resolver; do not weaken it.

## Scope F — disabled/enabled matrix

Update v2 post-type support matrix.

Expected target if safely completed:
- tip -> v2-ready source candidate
- morning_greeting -> v2-ready source candidate
- brand_post -> still disabled unless exact completion source is now available and independently auditable

Do not enable live routing.

## Scope G — adversarial disposable PostgreSQL tests

Prove at minimum:

Tip:
- 2-part happy path completes once
- 3-part happy path completes once
- duplicate finish/completion is idempotent
- wrong reply parent rejected
- missing middle part rejected
- uncertain part blocks later steps
- rejected part blocks later steps
- concurrent completion creates one set of side effects
- forced side-effect failure rolls back completion

Morning greeting:
- media then create happy path
- create before media rejected
- media id mismatch rejected
- uncertain create blocks replay
- competing attempt cannot reuse receipt/media step
- duplicate completion idempotent
- forced completion failure rolls back all DB effects

Cross-cutting:
- wrong claim/account/brand rejected
- terminal attempt cannot accept new step outcome
- legacy/unbound row cannot use v2 multi-step completion
- cleanup PASS

## Scope H — regression

Run:
- Phase1G focused tests
- Phase1B/1D/1E/1F regressions
- full x-test-post
- _shared
- important-news-monitor
- morning_greeting-specific tests
- tip/thread-specific tests
- Deno/static checks
- bash -n
- git diff --check

Report exact counts.

## Migration / ACL rules

Any migration must:
- be additive/versioned
- depend explicitly on 1B/1D/1E/1F
- use SECURITY DEFINER + fixed empty search_path where appropriate
- qualify schema names
- be service_role-only for API-callable RPCs
- close PUBLIC/default grant windows transactionally
- leave step/ledger tables non-writable directly by API roles
- document transaction/apply-tool assumptions
- remain unapplied in production

## Forbidden

- production migration/DDL/DML/RPC apply
- `supabase db push`
- migration-history repair
- deploy
- Cron/OAuth/Vault/token mutation
- real X API calls/posts/media uploads
- switching/enabling v2 dispatcher or producers
- automatic legacy binding/backfill
- apps/admin/**
- consumer mobile/**
- G1/G2 app work
- G4 work
- unrelated MIC work

## Production mutation budget

0.

## Completion / K3

Report:
1. fresh main SHA
2. worktree/branch
3. tip step model
4. tip completion semantics
5. greeting step model
6. greeting completion semantics
7. changed files
8. ACL/migration safety
9. exact adversarial tests
10. regression counts
11. commit/push/PR
12. production mutation=0
13. remaining blockers
14. next recommendation

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Do not implement or enable the live v2 dispatcher in this task.

## Report

- task_id: `x-autopost-phase1g-multistep-tip-greeting-completion-20260925`
- result: **source-only candidate complete; tip and morning_greeting are v2 source-ready; production mutation 0; X API calls 0.** Nothing wired into the live dispatcher, legacy greeting publisher or producers. Stop for K3.
1. fresh main SHA: started `f029759`; pre-commit fetch `0629e65` (6 commits, G2/H2 + control files, **0** under `supabase/`); implementation rebased onto `0629e65`.
2. worktree/branch: dedicated G3 worktree `/Users/yuya/Developer/kabumori-g3-phase1d`, branch `claude/g3-phase1g-multistep`. Other slots: G2 review_required (personalized-reports only), G1/G4/H1/H2 done — no overlap.
3. tip step model (`supabase/tests/x_autopost_phase1g_multistep_completion.md` §2): immutable pre-X plan `tip_thread` with expected parts 1–3 (legacy `generatePostParts` range); step 1 `create_post` (no parent), steps 2..N `create_reply` parented by the previous confirmed id; started only via `begin_planned_provider_step_v2` (Phase1F raw begin revoked from service_role); no step beyond the plan, no restart, previous must be confirmed, uncertain/rejected part blocks all later parts; attempt with a confirmed create can never be recorded `x_rejected`.
4. tip completion (§3): `complete_tip_post_v2` requires all planned parts confirmed, chained, distinct, nothing extra; one transaction = identity/state (Phase1F core, type `tip`) + post succeeded + attempt completed with the root id + legacy-exact `tips` usage and one `X post created` log (tip_id, root id); every part id stays in `post_provider_steps_v2`. Repeat → `already_completed`; confirmed-incomplete (root id) recovers exactly once.
5. greeting step model (§4): `acquire_greeting_publish_claim_v2` takes the brand/day `publish_claims` row with `execution_id = attempt id` (pre-X, owner-idempotent, `GREETING_ALREADY_PUBLISHED` / `GREETING_PUBLISH_CLAIM_HELD`, never transferred — legacy-equivalent); plan `morning_greeting_media_post` (2 steps) requires the claim; step 1 `media_upload`, step 2 `create_post` whose `input_provider_object_id` must equal this attempt's confirmed media id; uncertain create blocks replay; confirmed media is never re-uploaded; non-completed ends fail the claim (`<OUTCOME>:<code>`), confirmed-incomplete keeps it `publishing`.
6. greeting completion: `complete_morning_greeting_post_v2` requires exactly media→create confirmed with matching media; one transaction = identity/state + post succeeded + attempt completed with the create id + this attempt's claim `published`/`x_post_id`/`published_at` + legacy `X post created` log. Storage receipt remains a best-effort write after commit (external, non-transactional; publish_claims authoritative, as in legacy). Deliberate fail-closed difference: an already-published day ends `pre_x_terminal` instead of the legacy "succeeded with existing id".
7. changed_files: new — `supabase/migrations/20260925090000_x_autopost_phase1g_multistep_completion.sql`, `supabase/functions/_shared/x_v2_multistep.ts` + `_test.ts`, `supabase/functions/x-test-post/multistep_completion_migration_test.ts`, `supabase/tests/x_autopost_phase1g_{fixture.sql,behavior.sql,run.sh,multistep_completion.md}`; modified — `supabase/functions/_shared/x_v2_outcome_ledger.ts` + `_test.ts` (tip/greeting moved to typed completions, `V2_MULTISTEP_PLAN_KIND`; only brand_post disabled); this TASK.
8. ACL/migration safety: single explicit transaction (apply alone; not re-runnable); fails closed unless Phase1F objects exist and `publish_claims` has a unique non-partial index on exactly `(brand_id, post_type, date_jst)`; additive only (plan table, one nullable column, 8 SECURITY DEFINER `search_path=''` functions, 2 attempt triggers, 1 revoke); public RPCs service_role-only; internal/trigger functions no API EXECUTE; plan table SELECT-only for service_role. Residual: `publish_claims` keeps its live service_role SELECT/INSERT/UPDATE for the unchanged legacy REST helpers.
9. adversarial tests (disposable PostgreSQL 17, non-superuser owner, Supabase-style grants, fixture-only fault injection) — Phase1G behavior **PASS ×4**, concurrent thread-completion race **PASS ×4** (one completed / one already_completed / one set of side effects), cleanup PASS. Covered: 2-part + 3-part (+1-part recovery) threads exactly once with all ids; duplicate plan/finish/completion idempotent; plan conflict/invalid/type/token/claim; wrong parent/kind/input; missing middle (out-of-order + incomplete completion); uncertain and rejected parts block later steps; rejected-after-confirmed refused; terminal attempt refuses new steps; partial thread non-reclaimable; forced tip failure rollback + recovery; greeting create-before-media, media mismatch, foreign attempt's media, uncertain create blocks replay/re-upload and fails the claim, stale/competing attempt cannot take the claim, already-published day, happy path + duplicate, forced greeting failure rolls back and keeps the claim; wrong claim/account/brand; legacy row; anon/authenticated denied; raw Phase1F begin denied.
10. regression: Phase1D/1E/1F proofs re-run **PASS** standalone. Stacked on 1G: Phase1E behavior PASS; Phase1F behavior fails only on its assertion that `begin_provider_step_v2` is service_role-executable (intentionally revoked here). Deno: focused 1B/1D/1E/1F/1G static + resolver/seam/outcome-ledger/multistep **72/72**; full `x-test-post` **437/437** (429 + 8); morning_greeting/publish_claim/tip-specific files **138/138**; `_shared` **129/129** (120 + 9); `important-news-monitor` **431/431**; re-run after rebase. `deno check --no-config` + `deno lint` on new/changed TS: PASS. `bash -n` runner: PASS. `git diff --cached --check`: PASS.
11. commit/push/PR: implementation `e0f7785`; this Report is a separate control commit; both pushed directly to `origin/main` from the G3 worktree after a fresh fetch. No PR.
12. production mutation: **0** (apply/DDL/DML/RPC 0, db push 0, deploy 0, Cron/OAuth/Vault/token 0, refresh 0, X API/posts/media 0, dispatcher/producers 0, legacy binding 0). Generated `deno.lock` removed.
13. remaining blockers: v2 dispatcher + producers (not written/enabled); brand_post completion SQL not in source; interaction poll seam; per-account pre-X refresh writer; Kabumori credential into its account's Vault refs; uncertain→proven-created reconciliation; operator path for failed greeting days; production gates (live-definition diff incl. publish_claims/tips/scheduled_posts writers, atomic 1B→1G apply proof, staged rollback plan).
14. next_recommendation: K3, then Codex review (step/plan invariants, greeting claim lifecycle, legacy-fidelity of tip/greeting side effects). Next source-only step: the v2 dispatcher behind a gate that stays OFF, composed from the Phase1E resolver/seam, Phase1F/1G ledger and typed completions (Opus5.5（高）).
