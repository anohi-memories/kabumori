## H5 FINAL — authenticated owner runtime wiring source — 2026-10-12 JST

- task_id: `postona-h5-threads-auth-owner-runtime-final-wiring-20261012`
- result: **SOURCE_COMPOSITION_IMPLEMENTED / LIVE_NO_GO / INDEPENDENT_REVIEW_REQUIRED** (implementation evidence, not own final security PASS)
- status: review_required / next_owner: chatgpt
- return_to: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ** / completion_code: **C5**
- recommended_model: Sol（高）; type: 臨時実装
- 臨時実装理由/Claude limitation: ChatGPT explicitly chose H5 for its already-owned PR139 high-risk Auth/SQL boundary, while G4/G5 workstreams were separately allocated. No unverified claim that Claude is generally unable/safety-blocked; this is owner-specific temporary assignment, not a bypass or permanent implementation slot.
- implementation_scope: actual pinned SDK/driver/source handler composition, H5 session row SHARE correction, same-transaction G4 account-custody integration port, focused offline/local proof and operator prerequisites. No publish/mobile/G5 source changes.
- source_commit_hash: **163675c62835e84417905f98f97ceedd4dd1bcd9**
- source_push: CONFIRMED new `codex/h5-threads-owner-runtime-wiring-20261012`; GitHub readback exact.
- source_PR: [Draft PR159](https://github.com/anohi-memories/kabumori/pull/159), OPEN/Draft/unmerged; base `codex/h5-threads-runtime-20261011` (protected PR139 head `b4fa672f97592e87682671454e868a92098cbd56`). 18 H5-only files: 3 edits +15 new. No force push, existing owner branch mutated0.
- own_bookkeeping_sync: separate Draft control PR against fresh main (not direct main mutation). Only H5 Report/TASK/H5 ACTIVE block/relevant H5 CURRENT_STATE note, prior histories preserved. Main has prior ready state until coordinator approval; no merge performed.
- merge/deploy/activation/EAS/real post: **NOT_PERFORMED**.
- real Supabase/Auth/DB/Vault/Meta/Threads/X/provider/API calls: **0**. GitHub/public docs/registries read; SQL apply restricted to explicitly dedicated disposable local fake PG. No real credential/env inspected, registered or changed.

### Changes / functional code

- Edited ONLY `supabase/candidates/postona_threads_auth_runtime/{claim_candidate.sql,owner_transport.ts,runtime.ts}`. New `wiring/{server_factory.ts,config.ts,postgres_connector.ts,custody_port.ts,nondeployable.ts,deno.json,deno.lock,offline.fixture.ts,connector_test.ts,composed_handler.smoke.ts,source_isolation.smoke.ts,postgres_integration.smoke.ts,postgres_setup_run.sh,source_overlay_run.sh}` and `docs/postona/threads-owner-runtime-wiring-20261012.md`.
- Real supabase-js2.115.0 getClaims/getUser (signature, configured issuer/project, non-anonymous authenticated user/session/expiry) → sealed principal; actual @db/postgres0.19.5 dedicated parameterized driver → owner/T13/verified SET LOCAL claims; existing provider/attestation runtime → injected pinned G4 HTTP factory. SDK/driver exact pinned with scoped lockfile. Factory is functional source, not mock-only architecture; actual Edge remains hard-disabled503/unwired, no env activation route. Nondeployable seam deliberately imports no absent G4 path on PR139 base.
- Explicit expected-project direct host5432, non-default non-API owner, CA PEM/TLS enforcement/session check, one connection attempt, statement4s/lock2s/idle-tx6s/connect-query5s/close500ms, sanitized constructor/query errors and late-connect close; no pool/DSN/unverified user/service-role proxy/high-privilege fallback.
- H5 SQL now FOR SHARE after T13, before workspace/account/Vault. Locks serialize non-key not_after UPDATE and session deletion only during SQL transaction, not Meta HTTP or passage of time. Real managed revocation policies are not inferred.
- Before begin/complete token writer, G4 custody signature/return/owner/invoker/search_path and PUBLIC/API/inherited reachability checked. Bound claimed account from owner SQL only; **same connection/transaction** parent complete→custody(observed expiry)→outcome→COMMIT. Missing/failed custody prevents connected and rolls back parent state/Vault token; conservative provider expires_in clock captured BEFORE exchange, no 60-day fallback/old attempt authority.
- Actual-driver test exposed PR139 duplicate SET LOCAL output column names; H5 query now uses unique aliases. No G4/G5 function source modified. Unknown commit never retries/reports fictitious rollback; Meta timeout never retries; receipt contains no token/code and does not grant publish authority.

### Exact protected source / independence

- Fresh main start `34b64ad4`, prepush fresh `b012da640a33518cee52c2927e4d3c21ff253bf7` (other slots changed control files only; own H5 TASK/Report no conflict). Source/report/disposable combination separated under `/private/tmp/kabumori-h5-wiring-20261012.EzokAp`, new source from exact PR139; no reuse/reset/prune of prior or other worktrees.
- Readback OPEN/Draft exact preserved: PR139 b4fa672f97592e87682671454e868a92098cbd56; PR135 e38788d6677082138f0990453c7d2f00549666d0; PR124 c30f246409a77080cbc03aef6c4cb72b5481e125; G4 PR154 98287392327eabfd5092a3ba89dde51a2e8beff6 on PR144 09fd2c49114b7d26c23b71a3084574dc6a5a7ad6 on PR140 2e75a6a842e70f3de78558681803b60935fb4251; G5 PR121 76b50e1e03f82faaa3460bab1603afa8fef3ce44.
- G5 PR152 advanced legitimately from task allocation5ad5bb40 to **ccea1fe8132c6f573a768f0df5a033a05c62ef2c**, C4 R1/R2 correction accepted by its own K5; H5 used repaired source read-only. T13 source file same contract from PR121; latest provider port smoke retested. H5 made no G5 source/slot/main mutation.

### RUN — focused evidence (actual code, offline services)

| Check | Result / boundary |
| --- | --- |
| Config/actual driver construction + touched H5 regression | **47 PASS** =15 focused connector/config +32 runtime. No runtime net/env permission. |
| Real SDK/RSA-JWKS + actual G4 HTTP + H5 owner composition | **16 PASS** fake Auth/SQL/Meta: valid flow, replay, bad signature/issuer/expiry/role/anonymous, foreign actor, missing custody/owner/session, malformed envelopes/account-swap, Meta unknown/8s timeout no retry, late freeze, custody failure, commit response lost. Negative precommit outcomes0 committed credential; lost complete COMMIT1 may be durable, reported UNKNOWN not0. |
| Overlay isolation / repaired G5 port | **2 PASS** all5 gates false, source composition unreachable from actual Edge, no code console/env/serve; revised G5 port refuses lease lost after hasConnection before cleanup (0 mutation). |
| Actual Deno driver + real PR124/G4 custody/G5 T13 on fake PG | **6 PASS** exact account/ref/recorded_by/expiry same transaction, completion-first blocks non-key revoke UPDATE, update-first wait rechecks revoked row→0 token/custody write, missing/API-executable custody drift→0 token, trigger-injected custody failure after parent→Vault/state/token rollback, missing session/ended service/replay/foreign actor/cross-workspace duplicate code/swapped state refusal. |
| Deliberate old KEY SHARE mutation | **1 expected FAIL** LOCK_BARRIER_NOT_REACHED: revoke UPDATE did not wait; corrected SHARE version PASS. |
| Build/lint/shell/diff | nondeployable deno check PASS; lint12 files PASS; bash syntax + source/staged diff check PASS; secrets/log scan only dummy fixtures/denial role names/comments, no real credentials/native live calls. |

- Local PG17.11 socket56525 only, fake DB `h5_wiring_12318` / non-super `h5_wiring_owner_12318`; **real pinned G5 T13 source** (not PR124 mock), real parent/G4 custody + fake Auth/Vault tables. Test-only fixture permissions are not deployment grants. This is not managed Supabase/Auth/TLS evidence. Final logs `/private/tmp/kabumori-h5-wiring-20261012.EzokAp/{unit-final.log,overlay.log,pg-focused.log,pg-old-lock.log}`; overlay `/private/tmp/h5-wiring-overlay.EcwUgI`, copied G4/G5 sources never committed/pushed into H5.
- Repro commands and operator checklist in new H5 doc. Broad unchanged G4 app258/G5 suites/old combined176 **NOT_RUN intentionally**, scope-focused work requested. Existing X source/branches untouched; no live X regression/provider calls made.

### Remaining dependencies / precise LIVE blocker

1. **No approved provisioned owner channel**: actual non-super LOGIN which is same reviewed parent/T13/custody owner, Auth SELECT + row-lock UPDATE authority, effective role/ACL, TLS CA/hostname/direct connectivity/connection pressure and controlled server credential isolation. Source connector refuses default postgres/service_role/other privilege fallback; does not move ownership or grant around a managed denial. Operator-designed reviewed route and approval required; managed policy/owner proof NOT_RUN.
2. Real GoTrue session timebox/inactivity/signout and runtime TLS/CA/DNS are NOT_VERIFIED by fake Auth/local Unix driver. No claims that locks span HTTP/natural TTL.
3. Exact schema source/apply ordering, Vault attestation key custody, Meta developer app/scopes/tester/HTTPS verified iOS universal + Android links/device/callback, one named tester and explicit controlled pilot approval. None supplied/accessed/activated.
4. **Fresh G4/G5 T10 semantic mismatch**: repaired G5 `ProviderCleanupContext.stillOwned()` must be consulted inside adapter before awaited mutations; G4 PR154 adapter ignores context internally. Structural type/lease-before-cleanup smoke is NOT safe registration proof. G4/G5 owners must reconcile/authorize actual adapter registration; H5 did not repair foreign-owned code.
5. Source runtime still reports uncertain if token issued remotely or commit response lost; no replay/reconcile executor provided. G4 readback/per-account manual consent still separate authority. All five gates/Edge503 stay OFF.

### Safety / next recommendation

Supabase/Postgres skills influenced SDK signature/issuer verification, package pin+lock, least-privilege refusals and short lock-ordered SQL transactions. Production URL/DNS/DB/Auth/Vault/secrets/entitlements/Cron/buckets and other slots/source files/branch heads unchanged; no actual merge/deploy/connection/post/paid call. H5 implementation is not its own independent final security review.

C5 should inspect source PR159 and this separate control PR, decide bounded source completion and free H5, then allocate one independent H1–H4 Sol（高） focused Auth/owner/custody review before any managed right/DB/Meta activation. Resolve the named owner and G4/G5 T10 dependencies separately; do not park H5 for later operator work.

**POSTONA｜マルチSNS化・開発統括（G4）のちゃ へ C5 を送ってください。**

---

# C5 ChatGPT acceptance record — POSTONA Threads authenticated runtime bridge — 2026-10-11 JST

- task_id: **postona-threads-oauth-runtime-bridge-h5-20261011**
- owner_of_implementation: codex (H5), temporary implementation (臨時実装)
- report_author: **ChatGPT C5 verification**, reconstructed from GitHub PR/source; **this is NOT a Codex-authored formal completion Report and does not assert Codex synced one**. H5 canonical Report was still original idle template at C5 inspection.
- result: **PASS_SOURCE_CANDIDATE / SOURCE_IMPLEMENTATION_ACCEPTED / RUNTIME_DISABLED / RELEASE_HOLD**
- status_after_C5: **done**
- next_owner: **none** (H5 freed after this C5, not kept for postponed work)
- return_to: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ**
- completion_code: **C5**
- recommended_model_of_task: **Sol（高）**
- source_PR: **[Draft PR139](https://github.com/anohi-memories/kabumori/pull/139)** — verified OPEN/DRAFT/NOT_MERGED; head `b4fa672f97592e87682671454e868a92098cbd56`, base original Draft PR135 head `e38788d6677082138f0990453c7d2f00549666d0` (which stacks on PR124 `c30f246409a77080cbc03aef6c4cb72b5481e125`); 1 commit, 13 NEW H5 paths only.
- changed_files:
  - `docs/postona/threads-auth-runtime-integration.md`
  - `supabase/candidates/postona_threads_auth_runtime/claim_candidate.sql`
  - `supabase/candidates/postona_threads_auth_runtime/deletion_contract.ts`
  - `supabase/candidates/postona_threads_auth_runtime/disabled_entry.ts`
  - `supabase/candidates/postona_threads_auth_runtime/owner_transport.ts`
  - `supabase/candidates/postona_threads_auth_runtime/parent_integration_run.sh`
  - `supabase/candidates/postona_threads_auth_runtime/postgres_behavior.sql`
  - `supabase/candidates/postona_threads_auth_runtime/postgres_fixture.sql`
  - `supabase/candidates/postona_threads_auth_runtime/postgres_run.sh`
  - `supabase/candidates/postona_threads_auth_runtime/runtime.ts`
  - `supabase/candidates/postona_threads_auth_runtime/runtime_test.ts`
  - `supabase/candidates/postona_threads_auth_runtime/verified_actor.ts`
  - `supabase/functions/threads-oauth-connect-user/index.ts`
- implemented: injected `getClaims`+`getUser` actor/session verifier; strict HTTPS callback and state/code digest; owner-role-gated source-only SQL transport, local PostgreSQL atomic one-shot claim and burned code tombstones, session/lifecycle checks, server-only provider token exchange with PR118 contract and attestation with PR124 types; unknown outcome non-retry; T10 deletion evidence DTO; G4 handoff receipt with `publishEnabled:false`. **New Edge entry deliberately always returns 503** and no production transport/credentials are connected.
- tests: **Codex PR139 body reports** focused Deno 32 PASS, combined Deno 97 PASS, lint 7 files/shell syntax/diff check PASS; separate local disposable PostgreSQL 17.11 role/ACL, race/restart, duplicate code, session locking and fake-G5/parent integration PASS. **ChatGPT independently inspected code, tests, SQL/test-runner structure, PR metadata and source; did NOT execute Deno/Postgres suites, inspect Codex's local uncommitted worktree, or verify real managed services.** Local runner's fake Auth/T13/Vault cannot be treated as production evidence.
- commit_hash: **b4fa672f97592e87682671454e868a92098cbd56** verified from PR head (one source commit).
- push: **CONFIRMED** source branch/PR visible on GitHub; H5 main bookkeeping was not synced by Codex at inspection; C5 ChatGPT recorded this independent closure on main. Read-back actual C5 bookkeeping only if verified after update.
- merge: **NOT_DONE**; deploy: **NOT_DONE**; real Supabase/Auth/Meta/Threads/X calls: **NOT_PERFORMED according to PR and no connection activated**; app secret/Vault credentials/production migration/grant: **NOT_DONE**.
- safety_checks: no existing G4/G3/G5/H1 PR source changed in the 13-file PR delta; new code is disabled; no user/brand service entitlement created, no `publish_enabled` flip; no old X OAuth hardening performed. Audit of real ACL, Auth privileges, owner credential isolation, Meta app/callback configuration NOT_RUN.
- remaining_issues / **no production PASS**: source-only owner adapter needs an approved dedicated authenticated owner connection, least-privilege validation, actual Auth sessions/managed permissions, production G5 T13, PR124 T9 and PR135 integration, phase2a-2 schema, Vault attestation key custody, browser/mobile callback handoff, real Meta tester, provider-specific deletion T10, and G4's verified per-account manual publisher. Claim-outcome uncertainty/reconciliation must be independently verified before live use. Preserve `THREADS_CONNECT_PREREQUISITES_MET=false`; no merge/deploy/post granted.
- next_recommendation: allow G4 separate Threads text publish TASK to complete, then one focused independent Sol（高） cross-boundary Auth/DB/publish security review when real ownership/T13/contracts are integrated; request explicit user-authorized Meta test connection and one test post only after verified prerequisites. This C5 closes H5 **source candidate**; further work requires a NEW TASK and is not parked in H5.
- assessment_origin: User submitted `C5` while H5 TASK/ACTIVE status remained `ready` and Report original template idle, but complete Draft PR139 source exists. To avoid repeating the H1 report-sync delay, ChatGPT explicitly authored this C5 acceptance from verified GitHub evidence; **it is not misrepresented as a Codex signed-off Report**.

---

# Codex Report 5

Codex slot 5（H5）の完了報告専用ファイルです（2026-10-11追加）。H5 TASK `.agent/tasks/CODEX_TASK_5.md` の報告をここへ記録します。新しい報告は先頭へ追加し、過去の報告は削除・改変しません。未実施項目も省略せず記録します。

## Report

- task_id: none
- result: not_started（未割当）
- status: idle
- next_owner: none
- return_to: none（未割当）
- completion_code: C5
- changed_files: none
- tests: not_run
- commit_hash: none
- push: not_performed
- deploy: not_performed
- remaining_issues: none（作業未割当）
- safety_checks: not_started
- next_recommendation: 明示割当までidleを維持する。
