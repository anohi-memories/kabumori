# Claude Task 3

- task_id: x-autopost-phase1h-gated-v2-dispatcher-source-candidate-20260925
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: Phase1E〜1Gのexact-account credential、provider boundary、outcome ledger、typed completion、multi-step planを一つのv2 dispatcher source candidateとして接続する。ただしlive gateはOFFのまま、production deploy/activation/X API callは行わない。

## Previous K3 closure

Previous task:
- `x-autopost-phase1g-pr27-merge-postmerge-verify-20260925`

Final K3 result:
- PASS
- PR #27 reviewed head `5a62af547dbc840c1f7b140d6d51d8876c1a7223` merged unchanged
- merge commit `3b33321d474946d1da117c647cdc3691e5618a3d`
- focused Phase1B/1D/1E/1F/1G 72/72 PASS
- x-test-post 437/437 PASS
- _shared 129/129 PASS
- important-news-monitor 431/431 PASS
- greeting/tip-specific 138/138 PASS
- disposable Phase1D/E/F/G behavior/race PASS
- production mutation 0 excluding GitHub merge
- live dispatcher, greeting publisher and producers remain unwired

## Goal

Build the first complete source-only v2 dispatcher path behind a hard OFF gate.

Required composition:

1. claim bound due post through the Phase1D v2 claim domain
2. exact-account credential resolve from Phase1E
3. pre-X identity verification
4. optional post-type preparation/plan
5. durable provider-start / provider-step begin
6. exactly one provider request per durable step
7. durable provider outcome recording
8. typed atomic completion from Phase1F/1G
9. safe fail-closed handling for uncertain/rejected/incomplete states

No live route may switch to this dispatcher in this task.

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read Phase1D/1E/1F/1G TASK/Report + C1/C2 findings
6. Fresh fetch origin/main
7. Confirm dedicated independent G3 worktree
8. Inspect G4/H1/H2/G1/G2 scopes and prove no overlap
9. Audit current legacy `x-test-post` dispatcher end-to-end before adding a parallel v2 path
10. Audit all env/config/gate readers used by X posting
11. Do not alter live legacy behavior

## Scope A — hard gate

Introduce a fail-closed v2 dispatcher gate.

Requirements:
- default OFF when missing/malformed
- cannot be enabled by client/mobile/admin input
- server-side only
- exact accepted values documented
- gate must be checked before v2 claim/provider work
- legacy path remains the only live path unless separately activated later
- no silent fallback from a partially-started v2 attempt to legacy posting

Prefer a dedicated server env/config flag.

## Scope B — dispatcher composition

Create a source-only dispatcher entrypoint/helper that composes existing reviewed primitives.

Single-create types:
- interaction
- useful_tip
- morning_report
- close_report
- us_premarket_report

Multi-step types:
- tip
- morning_greeting

brand_post remains disabled unless completion source has since become available and is independently audited.

The dispatcher must never select an unsupported type.

## Scope C — claim and exact-account authority

Dispatcher must:
- use only account-bound v2 claim RPC/domain
- never call old unpartitioned claim
- use claim.social_account_id as sole credential authority
- verify brand/account/platform/publish state through Phase1E resolver
- never infer account by brand/first row/hardcode/fallback
- never bind legacy pending rows implicitly

## Scope D — provider-start durability

Before any X create/media request:
- durable provider-start or provider-step-begin must commit successfully
- if persistence fails, provider request count = 0
- after durable start, no retry/refresh path may issue a hidden second create
- network/5xx/408/3xx/2xx-without-id => uncertain
- confirmed provider rejection => x_rejected where semantically safe
- uncertain/rejected/completed/incomplete attempt never falls back to legacy

## Scope E — single-create flow

For supported single-create types:
1. claim
2. resolve credential
3. identity precheck
4. durable provider-start
5. exactly one X request
6. record outcome
7. typed atomic completion on x_created
8. if typed completion fails after confirmed X create, record confirmed-incomplete with same X id

No automatic retry after provider-start.

Interaction:
- if current production interaction requires poll payload unsupported by Phase1E one-request seam, keep interaction disabled/fail-closed until a poll-capable seam is added.
- do not silently post text-only instead.

## Scope F — tip thread flow

Use Phase1G plan/step model.

Requirements:
- precompute/validate exact expected parts before first provider request
- persist plan before provider work
- begin one planned step
- issue one request
- finish durable outcome
- re-enter dispatcher only to determine the next safe action
- never loop through all thread parts in memory without persistence
- never recreate confirmed parts
- uncertain/rejected step stops execution
- completion only after all expected steps confirmed

Tests should simulate process restart between every part.

## Scope G — morning_greeting flow

Use Phase1G greeting claim/plan.

Requirements:
- reject stale/non-current JST schedule before provider work
- acquire exact attempt-bound publish claim
- persist media_upload step before upload
- media result durable before create_post
- create request references exactly confirmed media id
- no media re-upload after confirmed media
- uncertain create blocks replay
- completion uses Phase1G typed RPC
- external Storage receipt remains after-commit/best-effort only if that matches reviewed source contract

No live image/media upload.

## Scope H — retry / reconciliation boundary

Define dispatcher return classes at minimum:
- no_work
- gate_off
- pre_x_retryable
- pre_x_terminal
- provider_rejected
- provider_uncertain
- confirmed_db_incomplete
- completed
- unsupported_type
- blocked_manual_reconciliation

Ensure scheduler semantics do not automatically reclaim non-retryable classes.

Do not implement uncertain→proven-created reconciliation unless separately bounded and safe; expose a clear manual/operator blocker instead.

## Scope I — refresh writer boundary

Audit how access-token refresh should happen before provider-start.

If no exact-account pre-X refresh writer exists:
- do not implement unsafe fallback
- return a dedicated pre-X retryable/terminal result as appropriate
- document Phase1I/next blocker

Do not rotate/refetch production tokens in this task.

## Scope J — tests

Required fake-provider/injected-RPC tests:
- gate missing/off => zero claim/X calls
- unsupported type => zero provider calls
- exact account A never uses account B credential
- resolver failure => zero provider calls
- provider-start persistence failure => zero provider calls
- single-create success => exactly one create
- single-create 401 after start => no second create
- timeout/5xx/3xx/2xx-no-id => uncertain, no retry
- completion failure after confirmed create => confirmed-incomplete with same id
- re-entry of confirmed-incomplete does not create again
- tip 3-part simulated restart between every step => three total creates, no duplicates
- tip uncertain part => no later create
- greeting media confirmed + simulated restart => no second media upload
- greeting create uncertain => no create replay
- stale JST greeting => zero provider calls
- legacy path unchanged/gate OFF
- no X calls in tests except injected fake transport

Run regressions:
- Phase1B/1D/1E/1F/1G focused
- x-test-post
- _shared
- important-news-monitor
- greeting/tip-specific
- Deno check/lint
- git diff --check

## Scope K — activation safety document

Document exact future activation order without executing it:
1. live-definition/ACL read-back
2. ordered migration apply proof 1B→1G
3. exact-account credential/Vault readiness
4. refresh writer readiness
5. v2 dispatcher deploy with gate OFF
6. shadow/no-provider dry validation if available
7. gate enable for one explicitly selected account/type cohort
8. observe
9. staged expansion
10. old legacy claim revoke only after drain/read-back

Include rollback points and what cannot safely be rolled back after provider-start.

## Forbidden

- production migration/DDL/DML/RPC apply
- db push/history repair
- Edge deploy
- Cron mutation
- OAuth/Vault/token mutation/refresh
- real X API/post/media calls
- enabling v2 dispatcher gate
- switching live scheduler/claim path
- revoking old live claim
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
3. gate contract
4. supported/disabled post-type matrix
5. dispatcher state machine
6. changed files
7. single-create exact-once proof
8. tip restart proof
9. greeting restart proof
10. refresh boundary
11. exact test counts
12. commit/push/PR
13. production mutation=0
14. activation safety document
15. remaining blockers
16. next recommendation

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Do not deploy or activate the v2 dispatcher.

## Report

- task_id: `x-autopost-phase1h-gated-v2-dispatcher-source-candidate-20260925`
- result: **source-only v2 dispatcher complete behind a hard OFF gate; production mutation 0; X API calls 0.** Not imported by `x-test-post/index.ts`; live scheduler, legacy claim and producers unchanged. Stop for K3.
1. fresh main SHA: started and pre-commit `786f90a` (no drift).
2. worktree/branch: dedicated G3 worktree `/Users/yuya/Developer/kabumori-g3-phase1d`, branch `claude/g3-phase1h-gated-dispatcher`. Other slots: G2 in_progress = personalized-reports PR #26 (merged, redeploy) — no overlap; G1/G4/H1/H2 done.
3. gate contract (`supabase/tests/x_autopost_phase1h_gated_dispatcher.md` §1): server env `X_AUTOPOST_V2_DISPATCH`; ON only for exactly `enabled`; missing/empty/`true`/`1`/`on`/case or whitespace variants/throwing env read = OFF; `runV2DispatchOnce` requires `gateOn === true` and returns `gate_off` before any ledger or X access; no client/admin/mobile input; no legacy fallback anywhere in the v2 path.
4. post-type matrix: single create — useful_tip, morning_report, close_report, us_premarket_report; multi-step — tip (thread), morning_greeting (media → create); disabled — interaction (`V2_INTERACTION_POLL_SEAM_MISSING`: legacy may attach a poll, never silently dropped), brand_post (`V2_BRAND_POST_COMPLETION_SOURCE_MISSING`), others (`V2_UNSUPPORTED_POST_TYPE`); a bound disabled type is settled `pre_x_terminal` after claim with 0 provider calls.
5. dispatcher state machine (§3): one unit per run — resume the oldest resumable multi-step attempt, else claim via `claim_due_post_v2`; credential only from the claim's account (Phase1E); single: prepare → identity → durable provider start → exactly one create → rejected/uncertain/pre-X recorded, created → typed completion or confirmed-incomplete with the same id; multi: [greeting: JST day check with no X call] → identity → prepare → [greeting day claim] → plan → snapshot → provider start → per step: re-read ledger → next safe action → durable begin → one request → durable finish; rejected after a confirmed create recorded as uncertain; completion needs no provider request; failed ledger write after start → `blocked_manual_reconciliation`, never re-sent. Classes: gate_off, no_work, unsupported_type, pre_x_retryable, pre_x_terminal, provider_rejected, provider_uncertain, confirmed_db_incomplete, completed, in_progress, blocked_manual_reconciliation; `V2_NON_RECLAIMABLE_CLASSES` exported.
6. changed files (all new): `supabase/functions/x-test-post/v2_dispatcher.ts`, `v2_dispatch_ledger_rpc.ts`, `v2_dispatcher_test.ts`, `v2_dispatch_ledger_rpc_test.ts`, `dispatch_resume_migration_test.ts`; `supabase/migrations/20260925120000_x_autopost_phase1h_dispatch_resume.sql` (content snapshot table + `record_v2_content_snapshot`, trigger requiring plan+snapshot before provider start for tip/greeting, `list_resumable_v2_attempts`, `read_x_publish_credential_for_resume_v2`; single transaction, precondition-checked, additive, Phase1E reader untouched, 5 SECURITY DEFINER `search_path=''` functions, API RPCs service_role-only, snapshot table SELECT-only); `supabase/tests/x_autopost_phase1h_{behavior.sql,run.sh,gated_dispatcher.md}`; this TASK.
7. single-create exact-once proof: one create per claim with the claimed account's own token (A→tok_A, B→tok_B); other-account credential refused with 0 X calls; resolver failure 0 X calls; provider-start failure 0 creates; 401 after start → rejected, 1 create, no refresh; timeout/503/307/2xx-no-id → uncertain, 1 create, no retry; completion failure → confirmed-incomplete with the same id, three re-runs make no request, typed completion then completes exactly once.
8. tip restart proof: 3 parts, one provider step per run, fresh ports per run → runs `in_progress, in_progress, completed`, exactly 3 creates, texts from the snapshot, replies chained, 3 distinct ids, one completion; uncertain 2nd part → no 3rd create ever; rejected reply after confirmed root → uncertain; crash between X response and finish → blocked, never re-sent.
9. greeting restart proof: run 1 uploads media and stops; run 2 with fresh memory creates with exactly the ledger's media id and completes; 1 upload, 1 create, day claim published, after-commit receipt hook once; uncertain create never replayed and claim failed; stale JST → 0 X calls of any kind; expired token detected before the day claim.
10. refresh boundary (§5): no refresh anywhere in v2; identity 401 → `pre_x_retryable X_ACCESS_TOKEN_REFRESH_REQUIRED_PRE_X` (attempt cap applies); on resume → `in_progress` with no ledger change. Next blocker Phase1I: per-account pre-X refresh writer rotating that account's own Vault secrets.
11. tests: dispatcher 17/17, adapter 5/5, Phase1H static 5/5; focused Phase1B–1H + resolver/seam/outcome-ledger/multistep **99/99**; full `x-test-post` **464/464** (437 + 27); greeting/publish_claim/tip-specific **138/138**; `_shared` **129/129**; `important-news-monitor` **431/431**. Disposable PostgreSQL 17: Phase1H behavior PASS; Phase1D/1E/1F/1G proofs re-run PASS standalone. Stacked on 1H, Phase1G's behavior stops at `V2_CONTENT_SNAPSHOT_REQUIRED` (it marks tip/greeting without snapshots) — intended by the 1H guard. `deno check --no-config` + `deno lint` on new TS: PASS; `bash -n`: PASS; `git diff --cached --check`: PASS. Tests replace global `fetch` with a thrower; all X traffic is a fake transport.
12. commit/push/PR: implementation `59bd544`; this Report is a separate control commit; both pushed directly to `origin/main` from the G3 worktree after a fresh fetch. No PR.
13. production mutation: **0** (apply/DDL/DML/RPC 0, db push 0, deploy 0, Cron 0, OAuth/Vault/token 0, refresh 0, X API/posts/media 0, gate enable 0, scheduler/claim switch 0, legacy claim revoke 0, legacy binding 0). Generated `deno.lock` removed.
14. activation safety document: `x_autopost_phase1h_gated_dispatcher.md` §6 — live-definition/ACL read-back → ordered 1B→1H apply proof (each file alone) → exact-account Vault readiness (Kabumori out of `oauth_token_store`) → refresh writer → deploy with gate OFF → shadow/no-provider validation → one account + one type cohort (legacy dispatcher switched to `claim_due_post_legacy_unbound_v2`, drained, then `claim_due_post` EXECUTE revoked, which opens the Phase1D bound-row gate) → observe → staged expansion (tip/greeting last) → legacy retirement after drain/read-back. Rollback: full before the first bound row; after provider start nothing is automatically reversible (operator reconciliation only); gate OFF stops new work and leaves in-progress attempts parked.
15. remaining blockers: Phase1I refresh writer; Kabumori credential into its account's Vault refs; interaction poll seam; brand_post completion source; real v2 content adapters (OpenAI generation, report-run creation, greeting Storage media) — injected ports only here; uncertain→proven-created operator tooling; failed-greeting-day operator path; production gates in §6.
16. next recommendation: K3, then Codex review of the dispatcher composition (gate, no-fallback, restart/resume safety, resume credential RPC). Next source-only step: Phase1I per-account pre-X refresh writer (Opus5.5（高）), then the content adapters + a gate-OFF entrypoint.
