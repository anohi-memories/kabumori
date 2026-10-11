# Claude G4 — CURRENT TASK — POSTONA Threads text publish + user-facing manual publish V1

- task_id: postona-threads-manual-text-publish-v1-20261011
- owner: claude
- slot: claude-4
- status: ready
- next_owner: claude
- start_code: G4
- finish_code: K4
- return_to: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ**
- recommended_model: **Opus5.5（高）**
- priority: high
- type: **通常実装 — Threadsテキスト投稿の実API対応可能なprovider adapterと手動投稿UI / source + mock integration tests**
- main_product_goal: **POSTONAからユーザー自身の接続済みThreadsアカウントに1件のテキストを投稿し、投稿結果を確認できる状態（後段で限定実機pilot）**
- immediate_deliverable: implementation PR with real API request builders, explicit server-side publish-authorization boundary, testable two-step publish flow, safe one-shot user UI; **do not claim live functionality until separately authorized activation**
- remote_meta_supabase_x_api_calls: **FORBIDDEN until a separate user-approved tester/pilot TASK**
- production_DB_Auth_RPC_write_or_deploy_or_flags_or_secrets: **FORBIDDEN**
- PR_merge: **FORBIDDEN**
- shared_G5_Auth_schema_deletion_or_G3_scheduler_edits: **FORBIDDEN**
- source_owner: **Threads publication adapter, manual publish backend endpoint, scoped POSTONA manual publisher UI; NOT Threads OAuth**
- worktree: independent fresh G4 checkout; no H5/G3/G5 checkout sharing

## Authority and boundaries

User requested Threads **real posting capability**, authorized parallel G4 development with Codex H5 where useful. Phase 1 target is ONE user-initiated text-only post (not images, auto schedule, bulk posts or Threads+X simultaneous posting). H5 separately owns the **Threads OAuth Edge/Auth trusted-identity/attempt persistence** integration under `postona-threads-oauth-runtime-bridge-h5-20261011`; H5 code and PR cannot be edited here. G3 separately owns the AI/manual **reservation planner** Draft PR138 and related `apps/social-mobile/src/app/(tabs)/schedule.tsx` paths; do not modify G3 composer/schedule or X dispatcher. G5 owns common account lifecycle/entitlement/T13 and Auth deletion, and cannot be changed. H1 accepted source-only PR135; PR124 pending. Existing X OAuth hardening Issue #131 is deferred but is NOT the G4 TASK or authorization to alter X.

**Work toward deployable, testable Threads posting code; do not produce only another prose architecture memo.** Do not use safety-risky authentication circumvention, token harvesting, fake identities or unattended public posting. This code is legitimate user-authorized publication. No production posting, operator token reading, Meta app changes, real auth session or Supabase data writes without separate narrow consent.

## Mandatory baseline and Git isolation

Read `PROJECT_RULES.md`, `AGENTS.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, this G4 TASK, H5 TASK (ownership only), G3/G5 TASK headers and Reports. Fetch fresh `origin/main` via clean base `/Users/yuya/Developer/kabumori-fresh` and obtain current PR metadata/heads, ensuring no overlapping changed paths/worktree. Check existing app `apps/social-mobile` accounts routes, post UI, X publish permission and selected account/domain models, phase 2a-2 schema; current X publisher `supabase/functions/x-test-post` is reference-only and must remain unchanged. Docs `docs/postona/multi-social-phase1.md` and shared T9/T10/T13 contract. Reverify Meta official Threads publish API contract before hard-coding version/URLs.

Use new G4 branch from **fresh main**, own independent worktree; PR135/PR124/H5 branches must not be checked out/rebased/modified. G4 may import merged main's `threads_connect_contract.ts` only for safe common types; cannot import unmerged H5 or PR124 code until a later integration decision. If independent worktree/current ownership cannot be proven, STOP before editing.

## Implementation — four bounded deliverables

1. **Official Threads text publish transport** — provider-specific tested module (e.g. `supabase/functions/_shared/social/threads_publish_contract.ts`, associated `_test.ts`) that performs explicit `POST /me/threads` with `media_type=TEXT` and `text` to create a container, then `POST /me/threads_publish` with `creation_id` to publish. No reliance on `auto_publish_text=true` by default; explicitly consider whether a one-call path changes duplicate safety. Strict Meta API host/path, version and redirect validation, response ID preservation as STRING, provider error classification, content length/UTF-8/empties/newlines, fixed user-safe errors, provider post ID read-back contract; `threads_basic` and `threads_content_publish` confirmed. No client-disclosed access tokens. Inject fake HTTP/network in tests.
2. **Manual one-shot publish orchestration** — distinct account-specific Threads publish path (new isolated server module and/or Edge function source) that requires verified signed-in POSTONA user, active service entitlement, currently connected verified Threads account, **explicit per-account publish authorization**, durable attempt/step idempotency before any provider POST, exclusive exact account ownership, read-only status/read-back, and a fresh DB authorization check immediately before EACH external provider write. Server retrieves only this specific account's credential from Vault through a separately reviewed owner-controlled reader; no caller-supplied provider ID, credential, secret id, workspace/user/account ID as sole authority. Unknown provider/timeout outcomes -> record UNCERTAIN / read-back or human-assisted reconciliation, **never blindly retry either Threads write**. Preserve no credential/token data in logs/response. Connect-created accounts remain publish_disabled until an explicit reviewed user permission change. If migration/RPC required, create a **source-only guarded migration/candidate** with mock PG/RLS/ACL test; do not apply or activate. Never invent an effective service_role/owner privilege bridge absent a proven contract.
3. **User-facing manual posting UI (standalone, no G3 schedule screen modifications)** — scoped Threads-account tab/action in POSTONA accounts/navigation so user can see disconnected/ready/consent/expired/unavailable states, type and edit text, view exactly which Threads account will post, inspect preview, explicitly tap publish once, and see `publishing` / confirmed with provider ID/link / pending-uncertain / failed states. Never display successful posting on optimistic HTTP alone, and do not present mock preview as a live post. Disabled release flag until Auth/Meta/DB prereqs and approved pilot; do not create an always-on public “post now” control. No fake demo token accepted.
4. **Integration contract** with H5 OAuth owner: documented exact `verified_user_id`, `social_account_id`, provider='threads', active lifecycle T13, token-read grant, publish permission and provider result ledger I/O. Keep app/service keys `x_autopost` (POSTONA global entitlement), no new Threads entitlement. If H5/G5 prereqs are absent, implement injectable port with a **nonworking production adapter that fails closed**, report missing exact boundary; never mislabel as connected or deployable. Show the remaining SQL/Meta config and manual pilot gates needed to make actual one-post demo work.

## Independent tests and acceptance

- Auth absent/expired; wrong brand or account; cross-user, cross-brand, X-account routed to Threads; ended/deleting/suspended/no entitlement; publish disabled; token/Vault missing; expired token; expired/revoked connection; duplicate click; concurrent attempts; provider container accepted but publish failed; unknown publish outcome; invalid content/provider errors/429/timeouts; result response malformed; two steps each gets new permission check; no blind retry.
- Text-only one-post golden happy path through fake account, provider, repository, worker & UI. No real POST, real token, paid calls, production data mutation or migrations. Preserve existing X post tests and G3 planner; run focused app TypeScript/lint/tests, Deno tests, mock PG where needed, secret scan, `git diff --check`.
- Ensure safe deployment flags are false by default, no leak to logs, no mobile direct Meta Graph request; read-back result treats publication identity as verified provider-returned ID only after confirmation.
- Document concrete external operator steps to request later (Meta Threads app/tester and callback config; privacy/delete callbacks; minimal real test account) **without asking user to paste app secret into chat/GitHub**.
- Report actual change paths, tests RUN/NOT_RUN, exact PR/commit/push, dependency on H5/G5, remaining release blockers; Draft PR to main if isolated. Do not touch H5/G5/H1/H2/G3 branches, source, tasks, reports or force push.
- After completing source PR and read-back, append G4 Report to current TASK, set `review_required/next_owner:chatgpt`, and send `K4`. Do not silently enable public posting. Recommend targeted Sol（高） security review only when publish+OAuth+T13 boundaries actually integrate.

## Preserve prior G4 idle state and historical pointers

# Claude Task 4 — NO CURRENT TASK

- task_id: none
- owner: claude
- slot: claude-4
- status: idle
- next_owner: none
- start_code: G4
- finish_code: K4
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- recommended_model: **none — select for the next actual G4 implementation task**

## Disposition and preserved history — 2026-10-11 JST

- User explicitly reassigned the prior Threads OAuth Edge offline implementation to Codex H1 (special temporary implementation), task `postona-h1-threads-oauth-edge-offline-implementation-20261011`; H1 start `H1`, finish `C1` in this chat.
- Former G4 Threads task `postona-threads-oauth-edge-offline-candidate-20261011` was interrupted by Claude Code's safety mechanism **before a submitted completion**. It was transferred, not marked implemented/done; original complete task and any future-local-ownership concerns are archived verbatim in `.agent/archive/CLAUDE_TASK_4_threads_edge_pre_codex_20261011.md`.
- Preceding X OAuth containment task remains **deferred and uncompleted**, tracked as [Issue #131](https://github.com/anohi-memories/kabumori/issues/131); preceding detailed record is `.agent/archive/CLAUDE_TASK_4_pre_threads_20261011.md`.
- G4 is **idle and available for a newly allocated separate POSTONA feature**, not an active implementation. Do not interpret a lone `G4` as permission to start old archived work; only a new `ready` TASK can begin. Never use G4 worktree to do H1 work.
- This bookkeeping does **not** grant production deploy, source merge, OAuth security bypass, database modification or provider calls.


