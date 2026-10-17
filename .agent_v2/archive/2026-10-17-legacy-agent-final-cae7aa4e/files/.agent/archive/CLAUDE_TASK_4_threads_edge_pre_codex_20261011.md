# Claude Task 4 — CURRENT TASK / POSTONA Threads OAuth Edge candidate (offline only)

- task_id: postona-threads-oauth-edge-offline-candidate-20261011
- owner: claude
- slot: claude-4
- status: ready
- next_owner: claude
- priority: high
- start_code: G4
- finish_code: K4
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- recommended_model: **Opus5.5（高）**
- task_type: **通常実装（G4）— Threads OAuth Edge接続候補、オフライン・未配線**
- production_read_or_write: **FORBIDDEN**
- provider_network_calls: **FORBIDDEN** (Meta/Threads/X本物の認可・token交換・投稿を含む)
- migration_apply_grant_revoke_auth_secrets_deploy_merge: **FORBIDDEN**
- existing_x_oauth_fix: **OUT OF SCOPE (deferred)**
- worktree: **G4専用の独立worktree／checkout必須**
- initial_gate: 参照PRの正確なheadとG3/G5の競合確認が安全に成立すること

## Assignment decision / previous TASK disposition

User decision 2026-10-11: Do not park an on-hold remediation in an executable G4 slot. Previous task `postona-x-oauth-preclaim-containment-readiness-20261010` was **not completed**: suspended by model safeguard then explicitly deferred by the user. Its complete previous task and Report history has been preserved, unchanged, at `.agent/archive/CLAUDE_TASK_4_pre_threads_20261011.md`; the open future remediation backlog is [Issue #131](https://github.com/anohi-memories/kabumori/issues/131). The old blocked TASK is **not** active, and Issue #131 must **not** reserve this slot. PR #126 remains protected Draft; no existing-X hardening, old-X grant or OAuth change is authorized by this task.

This is a **new standalone Threads feature implementation**, not a disguised continuation of security containment. Begin using `G4` when requested; report `K4`.

## Objective and accepted baseline

Develop a source-only, **unwired** and off-line testable Threads OAuth Edge connection candidate that integrates:
- Main's merged PR #118 pure `supabase/functions/_shared/social/threads_connect_contract.ts` contract (no live imports; static `THREADS_CONNECT_PREREQUISITES_MET=false`).
- Draft PR #124 Threads workspace/OAuth RPC candidate head `c30f246409a77080cbc03aef6c4cb72b5481e125`, especially `supabase/functions/_shared/social/threads_connect_rpc_contract.ts` and `supabase/candidates/postona_threads_oauth_workspace_candidate.sql` (not a migration). The PR is **OPEN DRAFT and UNMERGED**. Recheck exact live head, never assume fixed.
- Draft PR #121 G5 T13 service-write guard head `76b50e1e03f82faaa3460bab1603afa8fef3ce44` (source-only, not live).
- G4/G5 signed contract `docs/postona/threads-g5-t9-t10-t13-shared-contract-20261010.md` (T9/T10/T13).
- Draft PR #126 existing X OAuth v2 (reference-only, deferred; never touch), G3 Stage3B Draft PR #127 (reference-only).

**Not authorized:** Production Threads connection, app UI enablement, provider callback traffic, RPC grants or DB migrations, Vault/secrets changes, deploy, PR merge, X OAuth remediation. No false claim Threads is connected, launch-ready or proven against managed Supabase/Meta.

## Mandatory startup and concurrency controls

1. Read `PROJECT_RULES.md`, `AGENTS.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, `.agent/ACTIVE_TASK.md`, **this exact current G4 task**, relevant G3/G5 TASK headers, PR #118/#121/#124/#126/#127 and shared contract. Read Issue #131 only for boundary; do not reopen its remediation.
2. From `/Users/yuya/Developer/kabumori-fresh` fresh-fetch `origin/main` and relevant PR heads. Confirm this G4 TASK is `ready` / `in_progress`; confirm physical isolation of the new G4 worktree from G1/G2/G3/G5/H1/H2 and all existing/legacy worktrees. Do not reset, rebase, checkout, stage, commit, stop dev servers or modify any other slot's worktree/branch or uncommitted files.
3. Because PR #124 carries unmerged types and SQL candidates, build a **new G4 branch from exact PR #124 head** using an independent checkout/worktree; do **not** alter or rebase PR #124's original branch. If safe, create a **new Draft stacked PR** whose base is PR #124's branch. Verify actual diff consists only of new G4 candidate work, not the underlying PR #124 changes. If this cannot safely be arranged, stop with BLOCKED / scoped details instead of editing another owner's state.
4. Confirm protected path non-overlap with PR #121/#126/#127 and current G3/G5 work. No PR status/merge/deploy/production config may be changed.

## Scope — source-only Edge handler/adapter candidate

A. Implement an isolated candidate module/test harness (prefer `supabase/candidates/postona_threads_edge/` or similarly isolated candidate path, **not** an automatically deployed `supabase/functions/threads-oauth-connect-user` directory). It must **not** be imported into a deployed function, router, or mobile app. Keep the current static Thread gate `false` and ensure environment variables alone cannot enable Threads connection.

B. Start flow: authenticate a signed-in caller using an injectable verified-auth abstraction; generate/validate cryptographically random state according to existing PR #118 contract; bind state hash to authenticated user/workspace through PR #124 begin typed payload (fake-RPC tests); validate registered exact HTTPS redirect and scopes; return only a properly formed authorization URL and nonsensitive metadata. Never assume JWT presence alone is verified identity.

C. Callback flow: parse strict state/code/redirect result, re-check caller and consume state with PR #124 contract before provider exchange; use the existing pure Threads request/response adapters with **injected fake HTTP**; short-lived token → long-lived token → `/me` identity; preserve large numeric provider IDs exactly (no JavaScript number precision loss). No provider network access in tests.

D. Completion flow: validate provider identity matches token-exchange observed identity, compute server-side attestation from provider-observed data using the PR #124 typed contract, call candidate complete RPC through an injected mock, and return fixed non-sensitive status. Credentials should cross the owned-RPC boundary only, never appear in logs/errors/client results. Keep `publish_enabled=false` and no new entitlements.

E. Failure / race controls: expired/mismatched/replayed/foreign state; invalid code/redirect; unknown/broken provider response; differing identities; G5 T13 denial before any write; account ended during provider exchange; DB/Vault failure; loss of network outcome; no retry for single-use authorization code; fail-closed without token/state leakage. Do not claim simulated verification is a genuine Auth/Meta/production assurance.

F. Document the exact wiring/activation dependencies without enabling them: phase 2a-2 deployed schema; G5 T13 real guard + permission checks; G4 T9 actual integration; T10 provider-aware cleanup; Meta configuration; Vault/attestation secret agreement; controlled activation and independent focused security review. Existing X OAuth remains unchanged. Avoid scope creep into G3 schedule/post, G5 Auth/deletion, or Instagram work.

## Mandatory offline tests

- Successful start → callback → verified identity → complete with mocked authentication/RPC/provider HTTP.
- Not authenticated, invalid JWT, missing/foreign/replayed/expired state and mismatch with current user/workspace.
- Invalid redirect, denial, duplicate callback, missing or bad code, oversized/rounded provider ID, /me identity mismatch.
- Long-lived token exchange error/unavailable/malformed response, no retry after uncertain code exchange.
- G5 inactive/ended/deleting entitlement denial at begin **and** complete; late callback after state transition. Verify no simulated credentials are persisted on a rejected path.
- Attestation deterministic contract and error propagation (fake signing key only).
- Vault/RPC failure and rollback expectations.
- Ensure actual connections are disabled, `THREADS_CONNECT_PREREQUISITES_MET=false`, new candidate imports 0 from deployed paths.
- Regression for existing X OAuth and G3 X posting in **mock/local source-only** scope, as appropriate.
- `deno check`, `deno lint`, focused unit tests, secret scan, `git diff --check`; preserve test evidence and distinguish `RUN` vs `NOT_RUN`.

Use no real login, token, client secret, Meta/Threads/X calls, live Supabase read/write, production DB, EAS, native build or provider/scheduler run.

## Deliverables / completion report

- Separate Draft stacked PR against original PR #124 branch if and only if safe after current-head/file-ownership checks.
- New code/tests/docs only in isolated G4 candidate scope; no modifications to PR #124/121/126/127 branches.
- TASK completion report with: `task_id`, `result`, `changed_files`, `tests`, `commit_hash`, `push`, `PR/head/base`, `merge`, `deploy`, `remaining_issues`, `safety_checks`, `next_recommendation`.
- Preserve full historical archives. Change status to `review_required`, next_owner `chatgpt` only after actually implemented and pushed/read back; return `K4` here.
- Completion is **offline candidate only**, not user connection enabled. No automatic merge, activation or live secrets.
