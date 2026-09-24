# Claude Task 3

- task_id: x-autopost-phase1f-atomic-completion-provider-outcome-model-20260924
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: Phase1E merge完了後の次 prerequisite として、v2 dispatcherがX provider結果を安全に永続化し、post_type固有の完了副作用とledger更新を同一transactionで確定できる source-only Phase1F candidateを実装する。production apply/deployは行わない。

## Previous K3 closure

Previous task:
- `x-autopost-phase1e-pr22-merge-postmerge-verify-20260924`

Final K3 result:
- PASS
- PR #22 reviewed head `7406c1c60506323400247b6c24162a5da4097419` verified unchanged
- merge commit `bb297ff5b76ec8d218365d0db6e837bc4357df66`
- post-merge Phase1E/static **44/44 PASS**
- x-test-post **422/422 PASS**
- _shared **116/116 PASS**
- important-news-monitor **431/431 PASS**
- disposable PostgreSQL Phase1E PASS
- live dispatcher / legacy credential paths unchanged
- production mutation 0 excluding GitHub merge

Phase1E is now on main as a source candidate only. Production activation remains prohibited.

## Problem to solve

Phase1C/C1 still has a hard blocker:

> Provider outcome ledger update and each post_type's required completion side effects are not atomic.

Current risk:
- `complete_post_x_confirmed_v2` updates v2 attempt/schedule state
- legacy `complete_*_post` RPCs perform type-specific side effects separately
- calling them as two HTTP/RPC operations creates a failure gap
- `x_rejected` has no dedicated safe Phase1B terminal outcome
- after provider-start, retrying must never create a duplicate X post

This TASK must create the source-only atomic completion/outcome contract required before a v2 dispatcher can safely publish.

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read Phase1B/1C/1D/1E reports and H1 C1 findings
6. Fresh fetch origin/main
7. Confirm dedicated independent G3 worktree/checkout
8. Inspect active G4/H1/H2/G1/G2 ownership and prove no same-file/object overlap
9. Audit every existing `complete_*_post`, retry/fail/stale/reconcile RPC and execution-log side effect before designing
10. Do not infer production state from source; record live-definition dependencies separately

STOP if another active X task owns the same RPC/migration/provider outcome objects.

## Scope A — provider outcome model

Define an explicit v2 outcome contract for a claimed attempt.

Minimum provider states:
- pre_x_retryable
- pre_x_terminal
- provider_started
- x_created
- x_rejected
- x_outcome_uncertain
- x_confirmed_db_incomplete if required by existing design

Required invariants:
- no automatic re-claim/retry after provider_started unless provider outcome proves no X create occurred
- `x_rejected` must have an explicit durable terminal representation; do not overload it ambiguously
- uncertain outcomes remain non-reclaimable
- X-created-but-DB-incomplete remains non-reclaimable
- no outcome transition can move backward across the provider-start boundary
- duplicate completion calls must be idempotent or fail closed without duplicating side effects
- wrong claim token/attempt/account/post is rejected

Prefer additive/versioned RPC/state changes.

## Scope B — atomic per-post-type completion

Audit all currently supported scheduled post types:

- tip
- interaction
- useful_tip
- morning_report
- close_report
- us_premarket_report
- morning_greeting
- brand_post

For each, enumerate every existing confirmed-X side effect:
- scheduled_posts status/timestamps
- v2 attempt ledger
- post_execution_logs started/success/failed metadata
- tips usage
- topic usage
- interaction metrics
- report run status/X id/source/model/cost linkage
- morning_greeting publish_claims / receipt implications
- AI Lab brand_post fingerprint/logging
- any other DB effect evidenced in source

Produce a matrix:

post_type | existing completion RPC/path | side effects | safe atomic v2 completion possible now? | blocker

Implement atomic v2 completion only where semantics can be preserved exactly.

If a post type cannot safely fit a single atomic DB completion because provider has multiple steps, keep it disabled/fail-closed and document why.

## Scope C — tip thread / multi-create boundary

Do NOT pretend the text-only one-request seam can safely complete a multi-post thread.

For `tip`:
- audit `postThreadToX`
- identify per-part provider steps
- define the minimum durable provider-step ledger needed to know which tweet parts are confirmed, rejected, or uncertain
- source candidate may add versioned schema/RPCs if necessary
- no live posting

A thread must never be represented as one x_post_id if partial publication can occur and replay would duplicate already-created parts.

If fully implementing safe thread steps would make this TASK too broad, implement the shared provider-step ledger foundation and keep tip v2-disabled with a clear next-task blocker.

## Scope D — morning_greeting media + create boundary

Audit:
- media upload
- publish_claims
- generated image/storage receipt
- tweet create
- current completion/logging

Required:
- distinguish media-upload outcome from tweet-create outcome
- do not allow a media-success/tweet-uncertain path to be replayed blindly
- preserve same-day publish_claim semantics
- no live media/X calls

As with tip, if full atomic completion is not safely bounded here, create the provider-step foundation and keep this type disabled.

## Scope E — single-create post types

Prioritize safe atomic completion for types that use one X create and have deterministic DB-only side effects after confirmation:

likely candidates:
- interaction
- useful_tip
- morning_report
- close_report
- us_premarket_report
- brand_post

But do not assume; audit source first.

For each supported type, completion must be one DB transaction that:
1. validates attempt/claim/account/post identity
2. validates provider outcome
3. updates scheduled_posts
4. updates the v2 ledger
5. performs the exact type-specific side effects
6. writes required success/failure execution logs
7. records X post id only when confirmed
8. cannot partially commit

## Scope F — started / failed observability

Phase1C identified that v2 claim/outcome RPCs did not fully preserve legacy execution logging.

Add a versioned observability contract so v2 paths preserve:
- started log where semantically required
- success log with existing metadata
- failed/rejected/uncertain classification without lying about provider state

Do not mark an uncertain provider outcome as ordinary failure if doing so could make it reclaimable.

## Scope G — migration safety

If schema/RPC migration is needed:
- additive/versioned
- explicit dependencies on Phase1B/1D/1E
- fixed `search_path`
- least-privilege ACL
- explicit REVOKE/GRANT
- avoid default PUBLIC EXECUTE window
- transaction semantics documented
- re-run / partial-apply behavior documented
- no blind `db push`

If a migration cannot be safely applied independently, say so.

## Scope H — disposable verification

Use disposable PostgreSQL only.

Prove at minimum:
- confirmed single-create completion atomically updates ledger + scheduled row + type side effects
- forced exception in one side effect rolls back all completion effects
- duplicate completion cannot duplicate counters/logs
- wrong claim token/account rejected
- x_rejected terminal and non-reclaimable
- uncertain non-reclaimable
- confirmed-X-db-incomplete non-reclaimable
- legacy/unbound row cannot use v2 completion
- no cross-account completion
- cleanup PASS

For thread/media provider-step foundation, prove step identity/order and no duplicate step creation if implemented.

## Scope I — regression tests

Run:
- focused Phase1F tests
- Phase1B/1D/1E focused regression
- full x-test-post
- _shared provider/resolver suites
- relevant report/greeting/interaction completion tests
- Deno/static checks
- shell syntax
- git diff --check

Report exact counts.

## Forbidden

- production migration/DDL/DML/RPC apply
- `supabase db push`
- migration-history repair
- Edge Function deploy
- Cron mutation
- OAuth/Vault/token production mutation
- token refresh/rotation
- X API calls/posts/media
- switching live dispatcher
- enabling v2 producers
- automatic binding/backfill of legacy pending rows
- apps/admin/**
- consumer mobile/**
- G1/G2 app work
- G4 Netlify work
- unrelated MIC work

## Production mutation budget

0.

## Completion / K3

When complete:
- status -> review_required
- next_owner -> chatgpt
- Report must include:
  1. fresh main SHA
  2. worktree/branch
  3. provider outcome state machine
  4. per-post-type completion matrix
  5. exact changed files
  6. atomicity/idempotency design
  7. x_rejected treatment
  8. tip-thread status
  9. morning_greeting status
  10. execution-log/observability behavior
  11. migration/ACL safety
  12. disposable PostgreSQL proof
  13. exact tests/counts
  14. commit/push/PR status
  15. production mutation=0
  16. remaining blockers
  17. next recommendation

STOP for K3.

Do not deploy/apply/activate Phase1F in production.

## Report

- task_id: `x-autopost-phase1f-atomic-completion-provider-outcome-model-20260924`
- result: **source-only candidate complete; production mutation 0; X API calls 0.** Durable `x_rejected`, typed atomic v2 completions for 5 of 8 post types, a provider-step ledger foundation for multi-request types, v2 execution logs, and ledger ACL hardening. tip / morning_greeting / brand_post stay v2-disabled. Stop for K3.
1. fresh main SHA: started `43da78b`; pre-commit fresh fetch `9ca14d8`, then `5b65c7c` at push (15+3 commits: G1/G2/H2 app + control files, **0** files under `supabase/`); implementation rebased onto `5b65c7c`.
2. worktree/branch: dedicated G3 worktree `/Users/yuya/Developer/kabumori-g3-phase1d`, branch `claude/g3-phase1f-atomic-completion`. No overlap: G2 personalized-reports task forbids DB changes; G1/H2 app; G4/H1 done.
3. provider outcome state machine: `supabase/tests/x_autopost_phase1f_atomic_completion.md` §1. pre_x → (settle/reconcile) pre_x_retryable|pre_x_terminal; provider_started → completed | x_rejected (new) | x_outcome_uncertain | x_confirmed_db_incomplete → (same typed completion, same id) completed. Nothing returns across the provider-start boundary; rejected/uncertain/incomplete leave the post `failed` and are non-reclaimable; completion exactly-once (`FOR UPDATE`, repeat → `already_completed` with no side effect, other id → `X_COMPLETION_CONFLICT`, newer attempt makes older non-confirmable).
4. per-post-type matrix (§2): **v2 atomic completion** — interaction (`complete_interaction_post_v2`), useful_tip (`complete_useful_tip_post_v2`), morning_report / close_report / us_premarket_report (`complete_report_post_v2`, run must belong to the post). **Disabled** — tip (thread: N creates), morning_greeting (media + create, publish_claims/receipt), brand_post (`complete_ai_salaryman_lab_brand_post` SQL is production-only, not in repo source). Interaction additionally needs a poll-capable seam before dispatch.
5. changed_files (all new): `supabase/migrations/20260924180000_x_autopost_phase1f_atomic_completion.sql`; `supabase/functions/_shared/x_v2_outcome_ledger.ts` + `_test.ts`; `supabase/functions/x-test-post/atomic_completion_migration_test.ts`; `supabase/tests/x_autopost_phase1f_{fixture.sql,behavior.sql,run.sh,atomic_completion.md}`; this TASK. No existing file edited.
6. atomicity/idempotency: each typed completion is one plpgsql function (one transaction): validate claim/account/brand/type/state → post succeeded → attempt completed with x id → the exact legacy side effects (same tables/columns/messages/metadata as the matching `complete_*_post`) → success log. Any error rolls back all of it (proved with a forced `interaction_post_metrics.x_post_id` unique violation). Recovery: `record_post_x_confirmed_incomplete_v2` keeps the confirmed id; the same typed completion later finishes it exactly once (proved). Concurrency: two sessions completing the same attempt → one `completed`, one `already_completed`, one set of side effects (race proof).
7. x_rejected: new outcome value + shape constraint (provider_started_at required, x_post_id forbidden, error_code required); `record_post_x_rejected_v2` only from provider_started; post → failed; log `X_REJECTED:<code>`; non-reclaimable; cannot be completed afterwards. `ledgerCallForOutcome` maps the Phase1E seam's `x_rejected` to it.
8. tip-thread status: provider-step ledger `post_provider_steps_v2` + `begin_provider_step_v2`/`finish_provider_step_v2` (durable before each request, strictly sequential, never restarted, reply must chain to the previous confirmed part, idempotent finish). Proved for a 2-part thread with an uncertain second part (no third part can start). **tip remains v2-disabled**: no completion consumes the step ledger yet.
9. morning_greeting status: same foundation proved for media_upload → create_post with an uncertain create. **Remains v2-disabled**: publish_claims + Storage receipt lifecycle not yet folded in.
10. observability: AFTER INSERT trigger writes a legacy-shaped `started` log per v2 claim; AFTER UPDATE OF phase writes a `failed` log with `error_code` and `<OUTCOME>:<code>` for every non-completed finish (confirmed-incomplete also carries the x id); success logs only from typed completions. Log statuses stay within started/succeeded/failed; reclaimability is decided only by the ledger.
11. migration/ACL safety: single explicit `begin; … commit;` (no PUBLIC EXECUTE window; apply as its own unit with a tool that does not wrap files in a transaction; not re-runnable). Fails closed on drifted Phase1B constraints. All 10 functions SECURITY DEFINER + `search_path=''`; public RPCs service_role-only; internal helpers/trigger functions have no API EXECUTE. Retires the effect-less `complete_post_x_confirmed_v2` for service_role. `post_provider_steps_v2` SELECT-only for service_role; **hardening:** Phase1B `post_queue_attempts_v2` / `post_queue_account_turns_v2` lose service_role INSERT/UPDATE/DELETE/TRUNCATE (Supabase default privileges had left them writable). Depends on 1B/1D/1E; not independently applicable.
12. disposable PostgreSQL proof (PG17, non-superuser owner, Supabase-style default grants, fake data): Phase1F behavior **PASS ×3**, duplicate-completion race **PASS ×3**, cleanup PASS. Phase1E proof re-run PASS; Phase1D proof re-run PASS. Stacked on Phase1F: Phase1E behavior PASS; Phase1D behavior fails only on its assertion that `complete_post_x_confirmed_v2` is service_role-executable — intended by Phase1F.
13. tests: focused Phase1B/1D/1E/1F static + resolver/seam/outcome-ledger **55/55**; full `x-test-post` **429/429** (422 + 7 new; includes existing report/greeting/interaction/tip tests); `_shared` **120/120** (116 + 4 new); `important-news-monitor` **431/431**; re-run after rebase. `deno check --no-config` on new TS: PASS; `bash -n` runner: PASS; `git diff --cached --check`: PASS.
14. commit/push/PR: implementation `0b75292`; this Report is a separate control commit; both pushed directly to `origin/main` from the G3 worktree after a fresh fetch (same flow as Phase1D/1E). No PR opened.
15. production mutation: **0** (apply/DDL/DML/RPC 0, db push 0, deploy 0, Cron 0, OAuth/Vault/token 0, refresh 0, X API/posts/media 0, dispatcher/producers 0, legacy row binding 0). Generated `deno.lock` removed, not committed.
16. remaining blockers:
    - step-ledger-driven completions for tip (all parts, tip usage, one log) and morning_greeting (publish_claims + receipt); TS providers driving steps.
    - brand_post: live `complete_ai_salaryman_lab_brand_post` definition must be captured into source before a v2 completion can be written.
    - interaction polls: extend the one-request seam to a poll payload.
    - uncertain → proven-created reconciliation path (operator-reviewed) does not exist.
    - v2 dispatcher itself (claim → resolve → seam → ledger/typed completion) not written; per-account pre-X refresh writer; Kabumori credential into its account's Vault refs.
    - production gates still open: live-definition diff (legacy RPCs, planners, social_accounts Vault columns, AI Lab RPCs, Vault ACL), atomic migration proof for the 1B→1F chain (explicit transactions in 1E/1F vs. apply tooling), staged rollback plan.
17. next_recommendation: K3, then Codex review of the ledger state machine, typed completion fidelity vs. legacy RPCs, ACL hardening and trigger logging (Opus5.5/Sol high). Next implementation: Phase1G step-ledger completions for tip/morning_greeting (or, if preferred first, the v2 dispatcher for the five enabled types behind a gate that stays OFF).
