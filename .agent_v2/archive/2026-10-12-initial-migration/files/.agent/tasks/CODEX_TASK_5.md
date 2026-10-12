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

