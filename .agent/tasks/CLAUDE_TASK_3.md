# Claude Task 3

- task_id: x-autopost-phase1d-claim-domain-partition-and-planner-authority-20260924
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: Phase1Cで判明したsplit-brain blockerを解消するため、legacy dispatcherはunbound rowsのみ、v2 dispatcherはexplicitly bound rowsのみをclaimするsource-only Phase1D candidateを完成させる。productionには適用しない。

## Routing

- X自動投稿アプリ実装のためG3で実施する。
- G4は既存のadmin Phase2 continuationを保護する。
- H1/H2はCodexレビュー・検証用に戻す。
- このTASK完了後、ChatGPTがH1/H2の空きと競合を確認してCodexレビュー要否を判断する。

## Existing evidence to inherit

Codexが移管前に未commit・未push候補を独立worktreeで作成し、以下を確認済み:
- base: `f074560`
- disposable PostgreSQL verification PASS
- x-test-post regression: 412 PASS
- Phase1B / Phase1D SQL verification PASS
- two-session concurrent claim proof PASS
- production mutation 0
- X communication 0
- added test standalone typecheck PASS
- whole-project typecheck failed only on 14 existing unrelated errors
- disposable DBs/temp PostgreSQL cluster cleaned up
- PostgreSQL 17 remains installed; Homebrew default cluster stopped

Candidate files reported by previous worker:
- `/private/tmp/kabumori-h1-phase1d-f074560/supabase/migrations/20260924120000_x_autopost_phase1d_claim_domain_partition.sql`
- `/private/tmp/kabumori-h1-phase1d-f074560/supabase/tests/x_autopost_phase1d_claim_domain_partition.md`

These local paths are reference-only. Do not assume the candidate is still present or correct.

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read prior Phase1B/Phase1C reports and latest Codex Phase1D evidence
6. Fresh fetch origin/main
7. Inspect G4/G1/G2/H1/H2 ownership and prove no overlap
8. Re-audit current live-source claim/retry/planner semantics against fresh main
9. If the local unpublished candidate still exists, compare it semantically to fresh main before reusing any part of it
10. Never copy/cherry-pick blindly from the old base

## Scope A — claim-domain partition

Implement a source-only versioned candidate where:
- legacy claim path can claim only `social_account_id IS NULL`
- v2 claim path can claim only `social_account_id IS NOT NULL`
- no row can be eligible for both
- no brand/account-count inference
- no LIMIT 1 fallback
- no implicit binding at claim time
- no silent rebinding through retry
- historical succeeded/terminal rows remain historical

Prefer additive/versioned SQL/RPC changes. Do not replace live production RPCs in this task.

## Scope B — planner authority

Audit each active scheduled_posts producer/planner and classify:
1. trusted social_account_id already available
2. trusted account authority can be introduced explicitly
3. no trusted account authority exists

Only class 1/2 may create bound rows.
Class 3 must remain unbound/legacy or fail closed according to safest compatibility.
Do not infer one account per brand.

Produce:
planner/caller | post type | brand authority | account authority | candidate binding | claim domain | readiness/blocker.

## Scope C — retry/stale/reconcile invariants

Prove:
- legacy retry stays unbound
- v2 retry stays bound
- unbound running/stale rows never enter v2 reconcile
- bound v2 rows never enter legacy reclaim
- uncertain / confirmed-X-db-incomplete remain non-reclaimable
- claim-domain partition survives failure/retry transitions

Do not redesign provider outcome semantics here.

## Scope D — coexistence/cutover seam

Document exact future activation ordering:
- source/migration/RPC order
- when planners may begin writing bound rows
- how legacy cannot take bound rows
- how v2 cannot take unbound rows
- rollback point before provider call
- what remains disabled until later prerequisites pass

No production activation.

## Scope E — disposable verification

Use disposable PostgreSQL only.

Re-run on fresh-main candidate:
- unbound row: legacy yes / v2 no
- bound row: v2 yes / legacy no
- concurrent legacy/v2 workers cannot double-claim
- two accounts remain independently claimable
- retry/stale/reconcile preserve domain
- mismatched brand/account fails
- no automatic legacy binding
- cleanup succeeds

## Scope F — tests

Run:
- focused Phase1D SQL/claim tests
- full relevant x-test-post regression
- git diff --check
- changed-file static/type checks

Whole-project typecheck failures may be reported separately only if proven pre-existing and unrelated.

## Forbidden

- production migration/DDL/DML/backfill
- live RPC replacement
- Edge Function deploy
- Cron/OAuth/Vault/token mutation
- X API calls
- manual production row injection
- migration-history repair
- blind supabase db push
- apps/admin/**
- consumer mobile/**
- G4 files/workflow
- unrelated MIC work

## Production mutation budget

0.

## Completion / K3

When complete:
- status -> review_required
- next_owner -> chatgpt
- report:
  - fresh main SHA
  - exact changed files
  - whether old unpublished candidate was reused/reworked/rejected
  - claim-domain contract
  - planner authority matrix
  - retry/stale/reconcile proof
  - coexistence/cutover design
  - disposable PostgreSQL proof
  - exact test counts
  - existing unrelated type errors separated clearly
  - commit/push status
  - production mutation=0
  - remaining blockers
- STOP for K3.

Do not deploy/apply Phase1D to production.

## Report

- task_id: `x-autopost-phase1d-claim-domain-partition-and-planner-authority-20260924`
- result: **source-only candidate complete; production mutation 0.** An additive migration partitions the claim domain in the database: the versioned legacy claim takes only unbound rows, a `scheduled_posts` trigger makes the account binding immutable and restricts bound-row lifecycle changes to the v2 RPCs, v2 RPCs cannot touch unbound rows, and no bound row can be written or claimed while the unpartitioned live `claim_due_post()` is executable by an API role. Stop for K3.
- worktree: dedicated G3 worktree `/Users/yuya/Developer/kabumori-g3-phase1d`, branch `claude/g3-phase1d-claim-domain`. Shared checkout and other slots' worktrees/branches untouched.
- fresh main: started on `a8c5be4`; pre-commit fresh fetch `13ce1af` (control files only since start: G1/G4/H1/ORCHESTRATION/PROJECT_RULES, no overlap); implementation rebased onto `13ce1af`.
- changed_files:
  - `supabase/migrations/20260924160000_x_autopost_phase1d_claim_domain_partition.sql` (new)
  - `supabase/functions/x-test-post/claim_domain_partition_migration_test.ts` (new, 7 static tests)
  - `supabase/tests/x_autopost_phase1d_fixture.sql`, `x_autopost_phase1d_behavior.sql`, `x_autopost_phase1d_run.sh`, `x_autopost_phase1d_claim_domain_partition.md` (new)
  - this TASK file (status + Report)
  - Not changed: `x-test-post/index.ts` and every other runtime file, live legacy RPCs, Phase1B migration, `apps/admin/**`, mobile, G1/G2/G4/H1/H2 files.
- old unpublished candidate (`/private/tmp/kabumori-h1-phase1d-f074560`): **reworked, not reused.** Compared semantically against fresh main. Kept the idea of a versioned legacy claim with the live five-planner body. Rejected: (a) versioned legacy retry/fail RPCs — replaced by a DB trigger that also fences every `complete_*_post`, the morning-report stale reconciler and direct writes, which the old candidate left open; (b) changing `index.ts` in the same commit — pushing it to main before the migration is applied would break all scheduled dispatch; (c) procedural-only activation — replaced by a DB-enforced gate; (d) its concurrency test did not make lanes contend. Its files were read only; nothing was copied or cherry-picked, and it was not modified.
- claim-domain contract: NULL → legacy only; NOT NULL → v2 only; binding immutable (`CLAIM_DOMAIN_IMMUTABLE`); bound lifecycle only inside v2 (`BOUND_ROW_REQUIRES_V2_PATH`); v2 never touches unbound (`UNBOUND_ROW_IN_V2_DOMAIN`); gate `LEGACY_UNPARTITIONED_CLAIM_ACTIVE` blocks bound insert and bound `pending→running` while live `claim_due_post()` is API-executable, including after an accidental re-grant (fail closed). No brand/account-count inference, no `limit 1` account lookup, no implicit binding at claim, no rebind through retry, historical rows untouched.
- design note: a non-superuser owner cannot use `ALTER FUNCTION … SET <custom setting>` (`permission denied to set parameter`, reproduced as non-superuser). So the nine Phase1B functions are renamed to `*_core` **byte-for-byte**, EXECUTE on cores is revoked from all API roles including `service_role`, and each public v2 name is a service_role-only wrapper that sets `kabumori.x_queue_domain='v2'` transaction-locally and restores the previous value.
- planner authority matrix: in the `.md` §2. Class 1 (trusted account already available): none. Class 2: `plan_daily_posts_v2` / `schedule_account_bound_post_v2` (explicit inputs; no trusted producer yet; gate keeps them closed). Class 3: all five live planners (`plan_daily_posts`, `plan_morning_report`, `plan_close_report`, `plan_us_premarket_report`, `plan_weekly_useful_tips`) and direct writers — stay unbound/legacy. The three report planners could become class 2 only through an explicit operator-set account on their settings row; not present.
- retry/stale/reconcile proof: `.md` §3, all proved on disposable PostgreSQL (legacy retry/reclaim/fail keep NULL; v2 pre-X retry keeps the account and returns only to v2; stale reconcile sees only v2 pre-X; unbound running rows never enter v2 reconcile or ledger; uncertain / confirmed-X-DB-incomplete are claimable by neither lane; partition holds across failure/retry).
- coexistence/cutover design: `.md` §4 — (1) apply Phase1B+Phase1D after diffing live function definitions; (2) deploy the one-line `claimDuePost()` switch to `claim_due_post_legacy_unbound_v2` **after** the migration; (3) drain/verify runtime; (4) revoke `claim_due_post()` EXECUTE (opens the gate; full rollback possible until a bound row exists); (5) bound producers and v2 dispatcher stay off; (6) only after the Phase1C prerequisites, enable per slot.
- tests:
  - disposable PostgreSQL 17 (local cluster, non-superuser owner, Supabase-style default grants): behavior proof **PASS**; concurrency race (2 legacy + 2 v2 workers holding claim transactions open) **PASS** — legacy 1 unbound, v2 1 bound, no double claim, no cross-domain claim; follow-up claim serves the second account, final state 1 unbound running / 2 bound running / 2 pre-X attempts; cleanup **PASS** (databases dropped, 0 left). 3 runs on the final source (plus 3 before the trigger-function rename), identical results.
  - Phase1B's own `x_autopost_phase1b_behavior.sql` re-run on fixture → Phase1B → Phase1D: **PASS**.
  - focused static tests (Phase1D 7 + Phase1B 6): **13/13 PASS**.
  - full `x-test-post` regression (`deno test --no-check --allow-read .`): **416/416 PASS** (409 before Phase1D tests + 7 new), re-run after rebase.
  - `deno check --no-config` on the new test and the Phase1B test: PASS. Plain `deno check` in this fresh worktree fails for both identically on missing `npm:@types/node` in `node_modules` (environment, pre-existing; no dependency installed).
  - `git diff --cached --check`: PASS. `bash -n` on the runner: PASS.
- commit_hash: implementation `238247a` (`Add X autopost Phase1D claim-domain partition candidate`); this Report is a separate control commit on top.
- push: both commits pushed to `origin/main` from the G3 worktree after a fresh fetch (fast-forward); post-push read-back confirms both are ancestors of `origin/main`.
- deploy: none. Production migration/DDL/DML/backfill 0, live RPC replacement 0, Edge Function deploy 0, Cron/OAuth/Vault/token 0, X API calls 0.
- remaining_issues:
  1. **Live definitions not re-read.** A read-only production `pg_get_functiondef` query was blocked by this session's permission policy and was not worked around. The fixture uses main's live-source bodies plus the Phase1C production audit's description of the live claim. Production also has multibrand-foundation objects (brand columns, log brand trigger) whose source is not on main. Activation step 1 must diff live `claim_due_post` / `retry_scheduled_post` / `fail_scheduled_post` / planners first.
  2. Phase1B observation (unchanged): `claim_due_post_v2_core`'s `FOR … FOR UPDATE SKIP LOCKED` cursor prefetch locks every eligible account turn during one claim transaction (diagnostic: 0 of 2 lockable by a second worker). Concurrent v2 claims defer instead of serving another account; non-blocking, never double-claims. Fix later if parallel v2 workers are needed.
  3. Phase1C prerequisites remain open: exact-account credential resolver, one-request provider adapter, atomic per-type completion, tip-thread and greeting media/receipt outcome model, v2 `started`/`failed` execution logs.
  4. Unrelated pre-existing test `yume_reference_logic_test.ts` "morning_greeting remains excluded from X dispatcher claim" asserts the never-applied draft `20260901044548`; live dispatch does claim `morning_greeting` (`20260905010000`). Misleading but out of scope; not changed.
- safety_checks: dedicated worktree only; shared checkout HEAD/branch unchanged and no file in it edited or staged; no other slot's branch checked out/reset/rebased; old candidate temp tree only read; disposable cluster on a local socket in `/private/tmp`, `service_role` etc. are local fake roles; no secrets, tokens or production rows printed or stored; the runner refuses non-`/tmp` sockets.
- next_recommendation: K3 review, then an H-slot Codex review of the trigger/gate/wrapper design (DB/RPC/permission layer). Before any activation, a separately approved read-only live definition diff (remaining issue 1).


## Final K3 — 2026-09-24

Result: IMPLEMENTATION PASS / CODEX REVIEW REQUIRED.

Accepted:
- source-only Phase1D candidate is complete
- claim-domain partition contract is explicit and DB-enforced
- planner authority classification is documented
- retry/stale/reconcile invariants are covered
- disposable PostgreSQL concurrency proof PASS
- focused Phase1B/Phase1D tests 13/13 PASS
- x-test-post regression 416/416 PASS
- implementation commit `238247a57287c3bb835b6e2a0ca8ee4a2d910fdf` exists on GitHub
- production mutation / deploy / X API calls = 0
- runtime dispatcher intentionally remains unchanged pending separately reviewed activation ordering

Review requirement:
- Because this change introduces a migration, SECURITY DEFINER wrappers, trigger-based domain fencing, RPC renames/wrappers, ACL changes, and concurrent claim semantics, final acceptance requires Codex review before any activation.
- H2 is assigned for that review.
- Production apply remains prohibited.
