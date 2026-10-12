# H5 CURRENT TASK — POSTONA Threads OAuth 実サーバー配線・専用DBオーナー接続実装（臨時実装）

- task_id: postona-h5-threads-auth-owner-runtime-final-wiring-20261012
- owner: codex
- slot: codex-5
- status: review_required
- next_owner: chatgpt
- start_code: H5
- finish_code: C5
- completion_code: C5
- return_to: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ**
- recommended_model: **Sol（高）**
- type: **臨時実装 / implementation-first / Auth + owner-only DB + verified OAuth Edge composition**
- Codexへ回す理由: ユーザーはThreadsテキスト実投稿を優先し、2026-10-11に「必要ならしばらくH5を使って」と臨時実装を明示許可済み。今回、複雑なAuth/SQL接続境界はH5が既にPR139で構築・所有し、G4はアプリ接続＋G5 provider-adapter PR154をソース完成、G5は独立したPR152 P2補修で稼働中。**ChatGPT判断により**H5がH5所有の本番実装候補を進める方が別所有ファイルへの改変、Claude枠の競合、無限の模擬設計の繰り返しを避ける。これはレビュー枠の流用ではなく一時的なCodex実装。H5自身は最終レビューを行わない。
- objective: **POSTONAの本人がThreads接続ボタンを押してからサーバーが安全にOAuth開始・コールバック完了・アカウント別トークン期限記録まで行うために、H5側に本物のランタイム構築・SDK検証・専用オーナーDBドライバー/設定・Edgeエントリ配線のソースコードを追加する**。G4 PR154とG5 PR152はオーナーのまま保持。失われている現実のcredential/managed permissionsは正確にBLOCKして、捏造しない。
- risk: high; Auth, `auth.sessions`, SECURITY DEFINER, owner SQL transport, Vault, OAuth state/callback, race/commit uncertainty.
- production_permission: **NO_GO**. No real Meta/Threads, managed Supabase Auth/DB/Vault/Edge/Cron, production secrets or paid API calls; no auth test user creation, migration or grants applied; no deployment, PR merge, flag enable, app release/EAS, real connection, deletion or public post. Existing Edge remains hard-disabled 503 until a separate reviewed pilot activation TASK. Source may contain a **fully composed feature-ready (but unreachable) handler** with injectable validated config; do not ship accidentally enabled handler.
- independent_reviewer_later: **H1–H4の空き枠／Sol（高）** only after final real cross-system boundary/source proof; H5 must not review own implementation.
- source_restrictions: edit **only NEW H5-owned files and carefully scoped H5-auth-runtime files/Edge index owned by H5**. Never change G4 PR154/144/140/124 source, G5 PR152/121/source/Auth/delete/entitlements, H1 PR135, G3 X/schedule or other owner branches/files, `.agent_v2/`, production workflow, G6-G10. Do not create role/grants that bypass owner-only fences; don't use `service_role` as owner, forge unverified user/session claims or remove security checks.

## Verified state and protected PR dependencies at allocation (2026-10-12 JST)

H5 startup 2026-10-12: fresh main `34b64ad4`; new isolated source/report/integration worktrees under `/private/tmp/kabumori-h5-wiring-20261012.EzokAp`. Source is exactly PR139-based new branch `codex/h5-threads-owner-runtime-wiring-20261012`; G4 PR154 unchanged. G5 PR152 advanced legitimately to `ccea1fe8132c6f573a768f0df5a033a05c62ef2c` and current G5 TASK done after K5; compatibility must use/read this repaired version as well, without editing G5. All production/pilot gates stay NO_GO.

## Report — H5 bounded source implementation / 2026-10-12 JST

- task_id: postona-h5-threads-auth-owner-runtime-final-wiring-20261012
- result: SOURCE_COMPOSITION_IMPLEMENTED / MANAGED_OWNER_PILOT_NO_GO / INDEPENDENT_REVIEW_REQUIRED
- source: Draft [PR159](https://github.com/anohi-memories/kabumori/pull/159), exact `163675c62835e84417905f98f97ceedd4dd1bcd9`, base protected PR139 branch `codex/h5-threads-runtime-20261011`. 18 H5-only paths (3 scoped edits +15 new), source pushed/readback, parents unchanged. New code constructs real pinned SDK/parameterized TLS driver+G4 handler port; existing Edge always503 and all five source gates false.
- tests: focused unit/runtime47 PASS; pinned G4/G5 source overlay18 PASS; actual Deno driver+real source G5 T13/PR124/G4 custody local fake PG6 PASS; deliberate KEY SHARE fail-before1 FAIL, corrected SHARE PASS; check/lint12/bash/diff PASS. Managed Auth/TLS/owner/Meta/device/pilot NOT_RUN.
- blockers: actual approved dedicated owner/TLS/Auth session privileges and managed policies; schema/apply/attestation/operator Meta/tester/app links; G4 PR154 cleanup ignores repaired G5 context.stillOwned during mutation, so T10 registration still needs its owners. H5 changed no G4/G5 source or slot.
- merge/deploy/flag-enable/real Supabase/Auth/DB/Vault/Meta/X/provider/API calls: 0; no production grant/secret/migration or real post. This is not own final security review.
- shared bookkeeping: separate H5-only Draft PR against fresh main, not direct main push. Canonical main remains prior state until explicitly accepted by coordinator; complete detail in new top `.agent/CODEX_REPORT_5.md`.
- next_owner: chatgpt; return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ; completion_code: C5. C5 evaluates this bounded source and frees H5; later independent H1–H4 Sol（高） review before rights/DB/Meta activation.

POSTONA｜マルチSNS化・開発統括（G4）のちゃ へ C5 を送ってください。

- Fresh GitHub `origin/main` at assignment **`add7685c782195a3a1a93cafeed5af88852b809d`** (refresh locally on start).
- **H5 Draft [PR139](https://github.com/anohi-memories/kabumori/pull/139)**: exact `b4fa672f97592e87682671454e868a92098cbd56`, OPEN/DRAFT/UNMERGED, 13 H5-owned paths; base H1 [PR135](https://github.com/anohi-memories/kabumori/pull/135) `e38788d6677082138f0990453c7d2f00549666d0`; ancestor G4 [PR124](https://github.com/anohi-memories/kabumori/pull/124) `c30f246409a77080cbc03aef6c4cb72b5481e125`. H5 PR139 has candidate `verified_actor.ts` (real getClaims+getUser interface), `owner_transport.ts` (injected SQL client, strict owner role and SET LOCAL verified actor, one-shot commit), `runtime.ts` (signed actor/state/code exchange and complete), `claim_candidate.sql` (durable claim), and `supabase/functions/threads-oauth-connect-user/index.ts` (intentionally 503 via disabled_entry).
- **G4 Draft [PR154](https://github.com/anohi-memories/kabumori/pull/154)** exact `98287392327eabfd5092a3ba89dde51a2e8beff6`, base G4 PR144 `09fd2c49114b7d26c23b71a3084574dc6a5a7ad6` → PR140 `2e75a6a842e70f3de78558681803b60935fb4251`. G4 owns `supabase/functions/_shared/social/threads_connect_edge.ts`, app-auth browser/callback/read-back source and Threads G5 T10 `threads_provider_cleanup.ts` + owner SQL. **PR139 vs PR154 paths overlap NONE**; no direct product edits to G4 files. Current G4 gate `THREADS_CONNECT_UI_ENABLED=false`, G4 `THREADS_CONNECT_EDGE_WIRED=false`; all publish gates off.
- **G5 Draft [PR152](https://github.com/anohi-memories/kabumori/pull/152)** exact `5ad5bb40cadf013f00553acd5509f4f74fdbff7c`, base PR121 `76b50e1e03f82faaa3460bab1603afa8fef3ce44`. G5 currently **ready** with correction task `common-account-g5-phase4-h4-c4-r1-r2-repair-20261012` (H4 C4 found P2 R1 provider lease lost mid-cleanup and R2 rollback foreign trigger) and **must not be preempted**. G5 owns T13 entitlement/freeze/registration and actual T10 adapter registration. H5 may refer to its exact version only, and must retest compatibility if G5 head advances; do NOT edit G5 source.
- H3 currently **ready** with a separate .agent_v2 migration review, return to こでくろ連携部屋; H1/H2/H4 done. Do not allocate reviews here or touch their TASKs/Reports.
- User's intended next stage: move beyond source-only OAuth mock to a real **source-composed and testable** server ready for separately authorized managed verification. User has NOT confirmed Meta developer app/HTTPS callback/tester/secrets or approved any public test post.

## Mandatory start preflight / own branch

1. Read `PROJECT_RULES.md`, `AGENTS.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, this H5 TASK, `.agent/CODEX_REPORT_5.md` C5, G4 K4 Report and G5 current correction task, source of all protected PRs. Fetch fresh `origin/main`, check actual PR head/base/file changes and `git status`, `git worktree list`, dirty changes and cross-slot overlap. **H5 must work in its OWN NEW, CLEAN, independent worktree.** Never checkout/rebase/reset/stop another slot server/worktree, stage/commit their uncommitted files or force-push.
2. Create a **NEW H5 feature branch based exactly on PR139 head**, a **NEW Draft stacked PR BASE `codex/h5-threads-runtime-20261011`** (PR139 branch), not a push to original protected PR139. Push only H5-owned new source/tests, preserve PR139/135/124, G4 PR154/144/140 and G5 PR152/121 HEADs exactly. Branch named e.g. `codex/h5-threads-owner-runtime-wiring-20261012`. H5 new source-only handler/composition under `supabase/candidates/postona_threads_auth_runtime/` and H5 `supabase/functions/threads-oauth-connect-user/`, plus new focused test and H5-owned docs. Separate locally disposable G4+H5 source combination is allowed; do not push G4/G5 copies into H5 PR. If overlapping import cannot resolve without other owner's source, create a **typed injection point** and integration check in disposable source, not a duplicate unsafe implementation. STOP with precise blocker rather than modify protected files.
3. `PR124`/G5 T13 owner-only SQL functions require actual controlled non-super owner authority. Verify real current role/privilege contracts **only locally/read-only**; managed role/password is not to be invented. A live owner credential cannot be supplied or embedded here. No `service_role` proxy, broad GRANT, high-privilege role fallback, bearer trust, or fake attestation success. If Supabase managed owner privilege model fundamentally blocks direct connection, report exactly the **minimal approved operator/owner SQL transport prerequisite** and leave safe source fail closed; don't circumvent it.

## Required CODE IMPLEMENTATION (not just a memo or repeated massive test suite)

**I1 — Real dependency composition (source, disabled until activation):**
- Implement a **real H5-owned Deno server factory/composition module** that instantiates `createActorVerifier()` with `supabase-js` `getClaims(jwt)` and `getUser(jwt)` using server-only trusted project config; `createOwnerTransport()` with an **actual parameterized Deno Postgres driver connection factory** (no shared pool, per-request BEGIN/COMMIT, TLS/CA/hostname config validation, bounded timeouts, safe close on errors, no DSN/client-selected SQL/role, no secrets printed); `createThreadsRuntime()` with Meta settings/official HTTPS callback + server-only attestation key; and a verified HTTP `start/callback` envelope **compatible with G4 `createThreadsConnectHandler` PR154**. Dependency injection must let local integrated source use G4 handler. Avoid importing nonexistent PR154 files into the new PR139-based branch in a way that breaks build. For live source readiness, provide a safe **explicitly non-deployable composition entry** that could be activated only in a separate reviewed build after all PRs are integrated and operator preflight is approved. Keep existing `threads-oauth-connect-user/index.ts` hard-disabled 503 on all inputs, and `THREADS_CONNECT_PREREQUISITES_MET=false` unchanged.
- Secrets: no real secrets accessed/tested, no tokens/code/state in logs or errors. Fail fast if absent env, wrong project, unverified TLS, owner role/privilege unavailable, callback mismatch, token key invalid. Leave Meta API calls injected into tests/fake only. No actual browser/meta requests.

**I2 — Session-row revocation race in H5-owned candidate:**
- H3 previously caught G4 source session verification under `FOR KEY SHARE` allowing non-key `auth.sessions.not_after` revocation UPDATE to COMMIT before token release. G4 fixed to **`FOR SHARE`** in PR144. H5's `supabase/candidates/postona_threads_auth_runtime/claim_candidate.sql` `postona_threads_runtime.assert_actor` uses `FOR KEY SHARE`, therefore patch ONLY H5-owned SQL candidate to **`FOR SHARE`** (or strictly proved equivalent) after T13 fence, without changing lock order/role/ACL/user verification. Add a deterministic TWO-connection local PG regression: owner OAuth complete vs expiry UPDATE both orderings, test non-key UPDATE wait, expiry-first denial, duplicate state/code burn and missing/revoked Auth session. If local PG privilege emulation differs from Supabase managed, classify NOT_VERIFIED and fail closed. Avoid false claim that row locks span Meta HTTP or natural TTL expiry without row UPDATE.

**I3 — Actual same-transaction account-scoped token expiry custody:**
- G4 PR144 `threads_credential_custody_candidate.sql` requires a **verified account-specific expiry write in EXACT same transaction** as PR124 `complete_social_mobile_threads_oauth_connection`; H5 existing `owner_transport.ts:complete` only calls parent complete and `postona_threads_runtime.outcome`. Implement the one bounded H5-owned custody call ***only after*** validating exact PR144 function signature/owner/dependency; do not read it from an arbitrary old attempt row or set fabricated 60-day expiry. H5 PR139 branch does not contain G4 PR144 source; use a typed/checked integration port and composite fake PG fixture copied into own disposable H5 checkout. If real G4-owned custody function cannot be invoked securely by the same owner/trx, **fail closed: callback must NOT claim connected nor store incomplete credentials.** Do not edit G4 SQL, PR144, G5 source. No new broad grants.
- Verify outcome uncertainty: local DB COMMIT unknown, Meta provider response uncertain, timed-out token exchange never retried automatically; client re-reads connection status; no second token write; late deletion/freeze stop.

**I4 — Server endpoint and G4 source-level integration proof:**
- Source-level HTTP composition path for `POST {action:start}` and `POST {action:callback,callback_url}` with runtime verifying fresh actor + owner transport, and G4's strict DTO/official Threads authorize URL/callback parser/false publish receipt. Compile/run via **G4-owned module read-only overlay** in isolated H5 disposable combination of pinned #124/#135/#139/#140/#144/#154 plus G5 exact #121/#152 T13 interface as needed; report SHA and source ancestry; no actual merge. Unauthorized/expired/foreign-user/cross-brand/account-swap/malicious callback/duplicate state/nonce/missing owner privilege/Meta timeout/redaction => fail closed with fixed codes and **zero fake credential write**.
- Make a reproducible operator “source-complete but not live” readiness checklist naming exact remaining Meta application credentials/scopes, HTTPS verified iOS/Android app-links, G5 contract T13/T10 registration and frozen lifecycle, schema/phase ordering, dedicated DB owner role/TLS/permissions, Vault attestation key custody, C5 review, one named tester. Integrate code primarily, not a long retrospective memo. Existing deployed/source `503` and all 5 static gates stay FALSE.

**I5 — Focused tests only:**
- NEW focused Deno for actual factory/dependencies/handler/session unknown outcome/least privilege, H5 local PG concurrency for session expiry, expiry same-transaction integration, combined G4 H5 G5 smoke (source-only), secret/non-log scan, `deno check`/lint, git diff check. Do not repeatedly rerun all unrelated G4 app258/G5 80+/old Deno176 unless changed import surfaces demand it. Explicit `RUN/PASS/FAIL/NOT_RUN` and reason for actual Meta/managed/Auth/TLS/owner privileges/real device.
- **Source outputs required:** new functional code + focused tests in a NEW H5 Draft PR stacked on protected PR139 with exact HEAD and base. If any interface genuinely cannot be implemented without G5 real owner permissions or Meta credentials, deliver maximal safe source code plus one precise blocker report, **not** another entirely mock-only PR claimed live ready.

## Safety/finish requirements

- Complete `H5臨時実装` fields: why Codex used (this TASK), Claude limitation/why H5 appropriate (H5-owned Auth boundary and parallel G5/G4), implementation_scope, changed_files, tests, commit_hash, push, Draft PR base/head, merge/deploy, remaining_issues, safety_checks, next_recommendation, `return_to`, `completion_code`; report exact source-only evidence, no unsigned “verified” claims.
- Write ONLY `.agent/CODEX_REPORT_5.md` with NEW `## H5 FINAL — ...` at top preserving ALL prior historic C5 ChatGPT acceptance Report, and H5 TASK own `## Report`/top status `review_required / next_owner:chatgpt`, H5 own ACTIVE_TASK section and relevant CURRENT_STATE note via fresh GitHub SHA. **Do not edit G4/G5/H1–H4 or other slot TASK/Report/ACTIVE sections**. No actual merge/deploy. On failure, STOP and mark precise blocked report, don't invent success.
- When reporting completion, **last line exactly**: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ へ C5 を送ってください。**
- After C5 ChatGPT will inspect source/implementation and decide whether 1 independent H1–H4 Sol（高） focused review is necessary before any real Auth/DB/Meta deployment (mandatory for actual authorization boundary). H5 itself must NOT do its final security review; don't hold H5 for routine review or future G5 dependencies.

---

## Preserved entire previous H5 TASK and C5 acceptance (historical; NOT current task)

# Codex H5 — CURRENT TASK — POSTONA Threads OAuth runtime connection + durable claim bridge

- task_id: postona-threads-oauth-runtime-bridge-h5-20261011
- owner: codex
- slot: codex-5
- status: done
- next_owner: none
- start_code: H5
- finish_code: C5
- completion_code: C5
- return_to: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ**
- recommended_model: **Sol（高）**
- priority: high
- type: **臨時実装 — ユーザー明示のH5利用許可に基づく、正常なThreadsアカウント接続の認証・状態永続化・権限境界実装。今回のTASKに限定した臨時実装であり、Codexを恒常的な実装枠に固定しない。**
- goal: **POSTONAアプリから自分のThreadsアカウントに正規OAuth接続し、G4の手動投稿機能へ安全に認証済みアカウントを引き渡せるコードを用意する**
- immediate_deliverable: **実ランタイム接続を可能にするAuth/owner-controlled DB boundaryのソース実装候補と検証**（本番でのOAuth/DB適用は別承認）
- production_reads_writes_provider_or_real_auth_requests: **FORBIDDEN until separately approved pilot**
- migration_apply_grants_secrets_edge_deploy_PR_merge: **FORBIDDEN**
- public_connection_gate: `THREADS_CONNECT_PREREQUISITES_MET=false` **unchanged**
- existing_X_OAuth_pr126_issue131: **OUT OF SCOPE / unchanged**
- source_owner: **Threads OAuth/authenticated callback/DB claim+owner transport+T9 integration contract; NO Threads publishing UI/provider publish client**
- other_slots: G4 G3 G5 H1-H4 G1-G10 all protected; exclusive independent H5 checkout.

## C5 FINAL — ChatGPT source-based acceptance / 2026-10-11 JST

- **Result: PASS_SOURCE_CANDIDATE / RELEASE_HOLD**. H5's implementation source Draft [PR139](https://github.com/anohi-memories/kabumori/pull/139) verified at exact head `b4fa672f97592e87682671454e868a92098cbd56`, OPEN/DRAFT/NOT_MERGED, one commit/13 all-new paths stacked on protected PR135 head `e38788d6677082138f0990453c7d2f00549666d0` (PR124 exact `c30f246409a77080cbc03aef6c4cb72b5481e125` untouched). H5 new Edge entry intentionally returns HTTP 503; production gate still false and posting disabled.
- Code/documentation examined by ChatGPT: verified Auth actor via injected SDK `getClaims/getUser`, local session checks, owner-only SQL/T13 boundary candidate, durable state/code burn with two-worker fake PostgreSQL race, provider exchange/identity/attestation use, G5 T10 handoff and G4 receipt. PR body reports 32 new focused Deno / 97 combined Deno PASS and disposable PostgreSQL17.11 tests PASS; ChatGPT did NOT independently run these suites or real managed Auth/Meta/DB.
- Main H5 Report was **not synced by Codex** (only idle template existed) at C5. ChatGPT recorded **an explicitly attributed independent C5 evaluation** in `.agent/CODEX_REPORT_5.md` from source and PR evidence, NOT a fabricated Codex-authored completion report. No further sync-only work is demanded for accepting this source candidate.
- **Outstanding release blockers**: actual owner connection/auth session privilege proof, PR124/G5 T13/schema apply and Vault config, callback to mobile, Meta tester, X exclusion, G5 T10 actual lifecycle cleanup, G4 per-account publish consent+idempotency; focused independent Sol（高） cross-boundary security review and separate explicit pilot authorization. **Not production ready; do not merge/apply/deploy/enable or post.**
- H5 C5 closure now **done / next_owner none**; slot free. Historic original unassigned template and this TASK body preserved below. No G4/G5/G3/H1-H4 changes; no production action. Return to **POSTONA｜マルチSNS化・開発統括（G4）のちゃ** as C5, recorded.

---

## Purpose and scope boundary

2026-10-11 user explicitly asked to finish actual Threads posting, allowed H5 temporarily if needed. H5 now takes only the **legitimate user-authorized Threads account connection** path. G4 in parallel owns provider Threads `POST /me/threads`, `threads_publish` and user-facing "post now" UI in `postona-threads-manual-text-publish-v1-20261011`. G3 owns unified AI/manual reservation planner; G5 owns lifecycle/entitlement/T13 and managed Auth deletion; H5 MUST NOT modify those TASKs, Reports, branches or source-owner files. This is an implementation assignment, but NOT permission to circumvent or retry a refused unsafe operation. Any safety refusal or blocked authority boundary -> stop and report remaining safe prerequisite.

Previously completed (references ONLY):
- merged PR118 provider contract `supabase/functions/_shared/social/threads_connect_contract.ts` (static gate false).
- protected Draft PR124 head `c30f246409a77080cbc03aef6c4cb72b5481e125` — offline workspace/T9/Threads begin/consume/complete owner-only RPC candidate, G5 T13 missing live.
- protected Draft PR135 head `e38788d6677082138f0990453c7d2f00549666d0`, stacked on #124 — source-only mocked OAuth start/callback and attestation flow, C1 accepted offline candidate.
- protected Draft PR121 head `76b50e1e03f82faaa3460bab1603afa8fef3ce44` — G5 T13 candidate (not live). Existing G5 deletion/Option D and T10 cleanup gates still apply.
- X OAuth PR126 remains Draft deferred [Issue131](https://github.com/anohi-memories/kabumori/issues/131); cannot change existing X auth/ACL, connections, credentials or posting.
- source migration `20261007150000_postona_social_accounts_multi_provider.sql` is *not* evidence it is applied in production.

The PR135 simulated session coordinator is not a real cross-process lease; PR124 `consume` is READ ONLY, and owner-only RPCs deny `authenticated` and `service_role` while require trusted `auth.uid()`. **Do NOT “solve” this by an unverified service-role proxy or broad EXECUTE grant.** No old X preclaim reproduction. Do not introduce a client-invocable untrusted completion writer.

## Startup and worktree requirements

1. Read `PROJECT_RULES.md`, `AGENTS.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, **this H5 TASK**, `.agent/CODEX_REPORT_5.md`, H1 final report/C1, G4 TASK and G3/G5 TASK ownership headers. Check latest Git state and real PR heads, auth/deletion/migration contracts.
2. Fresh-fetch `origin/main` from `/Users/yuya/Developer/kabumori-fresh`. Create independent H5 worktree (never reuse H1/G4 or any other slot's checkout, branch or server). For PR135/PR124 unmerged types, create fresh H5 stacked branch from **exact PR135 head**, with base PR135 branch, not from/mutating original PR135/#124 branches. Before any push verify exact parent head, base, ownership non-overlap and only H5 changed paths. If overlaps emerge, STOP and ask coordination instead of force-rebasing owner branches.
3. H5 ownership exclusively newly created runtime bridge/safe SQL candidate and tests e.g. `supabase/candidates/postona_threads_auth_runtime/**` and `supabase/functions/threads-oauth-connect-user/**` (new function source **not deployed**, entry must fail closed), `docs/postona/threads-auth-runtime-integration.md`. Do not edit PR135 four files, PR124 eight files, G4 `threads_publish_contract.ts` or `apps/social-mobile`, G5 `account_lifecycle_assert_active_service_write`/Auth, G3 scheduler, X OAuth.
4. Use approved public official Meta/Supabase auth documentation to confirm app registration/HTTPS redirect/callback/long-lived token and provider scopes. Never use real token, exchange code, session, provider app secrets or production project; use strictly dummy fixtures.

## Bounded implementation deliverables (actual code required)

A. **Verified actor + app callback contract**. Implement testable server Edge/source-only adapter that verifies caller identity and active authenticated session using an actual documented Supabase Auth verifier interface (not merely decoding user-supplied JWT or trusting userId claims); bind OAuth state to verified principal + session, exact approved HTTPS redirect, browser-to-mobile return handoff, code single-use lifecycle and OAuth CSRF/expiry. Explicit reject anonymous, foreign account/workspace, stale session, discontinued service, wrong redirect, replay. Do not place Meta secret/long-lived token or service role key in mobile client.

B. **Durable cross-instance claim**. Source SQL/typed adapter candidate for atomic state + authorization-code hash claim BEFORE Meta token exchange, with exclusive lease or equivalent one-shot burn across Edge instances/restarts, timeouts, uncertain/after-commit outcome recording, no automatic replay or rollback fiction, cleanup/reconciliation strategy. Implement LOCAL disposable PostgreSQL concurrent-session tests (race/lock/deadlock/TTL/duplicate callback/recovery) **without changing DB in any connected project**. PR124 consume is read-only; leave it unchanged and document exact additional contract/migration delta.

C. **Effective owner-controlled RPC authority**. Build an implementable, least-privilege connection route and source-only SQL ACL/grant boundary which preserves server-verified `auth.uid()` and G5's T13 same-transaction lock discipline through G4's owner-only T9/begin/complete; no client-supplied identity/credential can be attested as trusted. Test PUBLIC/anon/authenticated/service_role/inherited membership reachability and error/lock proof with fake PostgreSQL roles. If constraints prevent implementing a functioning trusted transport without G5 changes, STOP that subcomponent with concrete dependency and implement other independent safe parts — **do not invent an insecure proxy**. Never modify G5-owned service fence or Auth identities.

D. **Server token custody and OAuth finish**. Use existing PR118/135 pure provider builders/validators, plus real SDK-compatible injected adapters for documented Meta short→long token exchange, profile identity comparison (preserve >2^53 ID as string), exact actor/provider/workspace binding, server attestation, Vault persistence via reviewed RPC contract only, `publish_enabled=false` on connect. Implement source-only Edge handler that is hard-disabled by static flag and not referenced by live routers/apps; no real network in tests. Distinguish completion uncertain from error and require reconciliation, never one-use code retry.

E. **Provider-aware disconnect/delete integration contract (T10)**. Document G5 ownership and provide H5-only adapter hooks, no G5 deletion changes, no claim of confirmed remote token revoke without provider evidence. Keep current personal data deletion protected. Hand off precise later G5 interface and proof needs rather than opening destructive deletion or account revival.

F. **Handoff to G4 for actual manual post**. Return exact signed-in actor/session and social_account_id authority contract, server-controlled Threads Vault access only after per-account manual consent/permission, connection status and refresh expiry behavior, no X credential reuse, no new Threads-specific service entitlement (`x_autopost` is POSTONA-wide). State what H5 can actually guarantee after offline tests versus what needs real Meta/GoTrue/PostgREST/Vault proof.

## Tests, safety and acceptance

- Add Deno focused tests for callback/session auth, redirect/CSRF, state replay, provider identity mismatch, malicious/coerced userId, token/no logs, disabled gate default, long token/expiry, malformed provider response and unknown exchange outcomes, no retry.
- Local disposable PostgreSQL 2-session negative RLS/role/ACL/ownership/claim lock ordering tests if SQL candidate added. No remote Supabase, real provider, token, secret, production operation or billing. Explicit `RUN` vs `NOT_RUN` checks.
- Final H5 source diff limited to **new** runtime candidate/server-only paths and tests/docs; secure features **not** activated without G5 ready, independent security review and per-target user approval.
- Draft stacked PR against PR135 only if PR135 original immutable head is still verified and changed-file diff contains just H5 paths. If not safe, STOP with BLOCKED and report, preserving all work.
- Report to `.agent/CODEX_REPORT_5.md`: task_id, result, changed_files, tests, commit_hash, push/readback, PR number/head/base, source and permission checks, real service calls 0, merge/deploy, remaining_issues, next_owner. Move TASK/index `review_required/next_owner chatgpt` after actual completion; `return_to` this POSTONA G4 chat and append exact: **POSTONA｜マルチSNS化・開発統括（G4）のちゃへ C5 を送ってください。**
- Do not change H5 into a parked backlog: on completion C5 closes/free H5. All future work is separately allocated.

---

## Preserved original unused H5 template (not an active task)

# Codex Task H5 — UNASSIGNED TEMPLATE

- task_id: none
- owner: codex
- slot: codex-5
- status: idle
- next_owner: none
- start_code: H5
- finish_code: C5
- completion_code: C5
- return_to: none（未割当。割当時にChatGPTが必ず記入）
- recommended_model: none
- report: `.agent/CODEX_REPORT_5.md`

## Purpose / allocation

未割当のCodex枠（2026-10-11追加）。H1〜H5は固定プロジェクト専用にしない。主用途はClaude実装後レビュー、バグ調査、バグ修正、回帰確認、テスト追加、DB / API / RPC / Edge Function境界確認、Auth / Security確認、deploy前確認。臨時実装は必要時のみ、TASKに「臨時実装」と明記された場合だけ行う。

このテンプレートの追加自体は作業割当ではない。現時点のScope・完了条件・実行権限は未設定。

## Before assignment（ChatGPT）

- statusだけで空き判定せず、task_id・TASK本文・Report・next_owner・ACTIVE_TASK・CURRENT_STATE・fresh `origin/main`を確認する。
- 既存TASK/Reportと他workstreamの変更を保護し、変更対象の非競合と専用の独立worktree/checkoutを確認する。
- 割当時にtask_id、目的、対象branch/commit/PR、重点確認事項、変更禁止対象、テスト、安全制約、完了条件を記入する。
- 割当時に冒頭ヘッダーの `return_to`（ユーザーが `C5` を送るちゃの部屋の人間向け名称。G番号だけにしない）と `completion_code: C5` を必ず記入する。
- 割当時に推薦モデルを必ず設定する。候補：Luna（中）/ Luna（高）/ Luna（極高）/ Sol（中）/ Sol（高）/ Sol（極高）。未割当の間はnone。

## Start / H5

`PROJECT_RULES.md`、`HANDOFF.md`、`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、このTASK、`.agent/CODEX_REPORT_5.md`、Git状態とfresh `origin/main`を確認する。

statusが `ready` / `in_progress` の場合のみ `H5` で開始する。`idle` / `done` / `review_required` では開始しない。

H5専用の独立Git worktree/checkoutを `/Users/yuya/Developer/kabumori-fresh` の fresh `origin/main` から作成して使用する。安全な独立環境を用意できない場合は開始せず停止する。他slotのbranchをcheckout/reset/rebaseしない。他workstreamの未コミット変更を変更・削除・stage・commitしない。他slotの作業ファイルやdev serverを停止・再起動しない。

## Scope / tests / completion criteria

未設定。割当時に具体化する。割当がない間は変更・テスト・push・deploy等を開始しない。

## Completion / C5

完了・停止時は `.agent/CODEX_REPORT_5.md` へ報告を記録し、このTASKのstatus / next_ownerを更新する。Reportには通常項目に加えて `return_to` と `completion_code` を含める。

ユーザー向け最終報告の末尾には必ず「返却先」を置き、TASKの `return_to` をそのまま使って「`<return_to>` へ `C5` を送ってください。」と表示する。返却先は推測しない。`return_to` / `completion_code` が欠落・不明・矛盾・不一致（`C5` 以外）の場合は「返却先未確定 — ChatGPT確認待ち」とし、理由を明記する。

`C5` はH5専用の完了確認コード。ChatGPTが対応TASKとReportを評価する。未実施を成功扱いにしない。

