# Claude Task 3

- task_id: x-autopost-phase1g-multistep-tip-greeting-completion-20260925
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
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
