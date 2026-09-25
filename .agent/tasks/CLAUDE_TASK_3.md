# Claude Task 3

- task_id: x-autopost-phase1h-gated-v2-dispatcher-source-candidate-20260925
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
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
