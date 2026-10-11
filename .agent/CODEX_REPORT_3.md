## H3 FINAL — POSTONA Threads PR144 Auth/SQL focused independent review — 2026-10-12 JST

- task_id: postona-threads-pr144-auth-publish-p1-security-review-h3-20261012
- result: **CHANGES_REQUIRED / REAL_PILOT_HOLD** (one reproducible P2 session-lock race; no product edits).
- reviewed_pr_sha: PR144 `d4a1e87b77d1fbd362dc51809ce2d998afda15ea`, OPEN/DRAFT/UNMERGED, base PR140 `2e75a6a842e70f3de78558681803b60935fb4251`, 24-file delta. Target SHA read back again at completion.
- fresh_main_sha: initial `1a4b5f3802982853ecd79abb4bf3b977c678c36e`, report base `36e0ded3d22e026d9961c2ac251e6315f07b6178`; no changed-path overlap between PR144's 24 paths and main changes since their common base. Local base's unrelated `supabase/.temp/` was protected; independent source checkout `/private/tmp/kabumori-h3-pr144.pJtncQ` remained clean.
- protected_heads: PR124 `c30f246409a77080cbc03aef6c4cb72b5481e125`, PR135 `e38788d6677082138f0990453c7d2f00549666d0`, PR139 `b4fa672f97592e87682671454e868a92098cbd56`, PR121 `76b50e1e03f82faaa3460bab1603afa8fef3ce44`, PR140 `2e75a6a842e70f3de78558681803b60935fb4251`: exact source refs inspected, all OPEN/DRAFT/UNMERGED at preflight; no branch or source mutations.

### R1 — P2: session expiry update can commit before token release

`supabase/candidates/postona_threads_publish/threads_publish_release_candidate.sql:229-232` checks the current session and locks it with `FOR KEY SHARE`. That lock conflicts with deletion/key changes but not a non-key UPDATE of `auth.sessions.not_after`. The claimed session authorization is therefore not held consistently until the credential release transaction commits.

Independent PostgreSQL 17.11 two-connection reproduction on the exact candidate:

1. A valid attested `create_container` release passes its session check. An H3-only BEFORE INSERT trigger on the nonce table pauses it for 2 seconds immediately after authorization, before Vault read/state transition.
2. Connection B runs `UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE user_id=<synthetic owner>` with a 500ms lock timeout. It commits during A's pause; its subsequent `not_after<clock_timestamp()` returns true.
3. A then returns `released`. Thus a session-expiry revocation committed before credential handoff, yet the release succeeds. No Meta request was made; this proves the SQL ordering gap, not the actual managed GoTrue API's choice of revocation SQL.
4. In a LOCAL-only control variant replacing that row lock with `FOR SHARE`, B hits lock timeout while A runs; A's release commits first. This removes the demonstrated non-key-update ordering gap. Product files were not patched.

Minimal correction owner: **G4**. Strengthen the session row lock to conflict with the supported expiry/revocation UPDATEs, preserve its place after T13 in lock order, and add a two-connection regression for both orderings (revocation first => no release; release first => revocation waits). Verify effective managed owner privileges for row locking separately; do not add broad grants during a source fix. PR139's protected H5 `claim_candidate.sql` also uses KEY SHARE on this row; the common session-revocation contract must be coordinated with H5 in its own task, not edited by H3.

### Other focused assessments

- S1: old claim/redeem/record functions are actually dropped. New release/record have locked empty search_path, authenticated-only EXECUTE, caller `auth.uid()` and session binding; service_role/anon routes and direct table access were refused by actual local SQL ACL tests. Membership/brand/account/permission locks, platform and credential expiry checks, one-open index and write-step CAS were exercised. No cross-user/brand token leak or service-role impersonation found in the reviewed paths. R1 is the remaining session-lock defect.
- T13: the supplied combined runner uses MOCK_ONLY T13. H3 additionally copied the exact PR121 `20261010051938_common_account_service_write_guard.sql` into its own temporary test runner, replaced only the fixture's T13 function, and reran the chain on the real lifecycle-table fixtures. The actual G5 source guard, SQLSTATE 42501 normalization, service ending and the SQL chain PASS. This remains fake Auth/Vault/local DB evidence, not managed Supabase deployment/permission proof.
- S2: TS/SQL HMAC known answer and message bytes agree; exact result fields, nonce, timestamp, user/attempt/step and record grant are bound. Nonce replay/forged proof/wrong user or session are rejected; grants are single-use. H5 verifies claims through the injected signature verifier plus getUser and seals its actor; G4 uses the caller JWT in PostgREST plus server proof, not a decoded JWT or service-role proxy. Tokens/attestation keys/provider bodies are not exposed in public responses or source logs.
- Duplicate control: container and publish are separate writes; unknown publish remains uncertain and is reconciled read-only. Compare-and-set + one-open attempt constrain concurrent writers. No resend after an ambiguous publish was found. The finite release-COMMIT-to-Meta-HTTP window remains a documented limitation: DB locks do not cover the HTTP call, and provider timeout is not a guarantee about process scheduling time before fetch.
- S3: credential custody binds exact Vault secret id and the latest verified_at; reconnect without matching custody reads NULL and publishing refuses. The writer is owner-only and accepts the same connection transaction's timestamp. H5's protected owner transport still lacks the documented custody statement; real owner transport, managed Auth row-lock privileges, callback and provider-aware G5 T10 are genuinely missing prerequisites, not completed implementation.
- Additional deletion probe: with the actual inherited workspace deletion guard, starting a `social_mobile_account_deletions` tombstone after publish release makes result record return ACCOUNT_LIFECYCLE_BLOCKED and leave the attempt `publishing`. This is the parent's intentional deletion write fence, not permission to bypass deletion. Late result persistence is proven for service ending, not unconditionally for workspace deletion. Document that boundary and the provider-aware deletion/audit ownership; no automatic republish is permitted.
- S4: all four connect/server/manual/UI flags remain false; deployed entry behavior in tests is 503 before environment or network access. Combined SQL and TS simulations are separate local mock proofs; they do not establish real Auth/PostgREST/Vault/Meta interoperability. H3 did not alter G3 reservations, G5/H5 code, X dispatcher or Issue131.

### Independently executed tests

- Standalone Deno publish/shared-social suite: **93 PASS**, with type checking (no --no-check).
- Provided composite runner: exact protected PR124/135/139 bounded copies, SQL chain + TS chain + **176 Deno PASS**. Its scope/ownership manifest was read back. The 176 includes overlapping tests with the 93; these counts are not summed as unique tests.
- H3 real-T13 local control: actual pinned PR121 guard applied on fake foundations; SQL chain PASS, composite **176 PASS** again.
- `postona_threads_release_run.sh`: apply/preconditions/reapply refusal/behavior/concurrent release PASS; **8/8 safety mutations detected**.
- Protected PR140 `postona_threads_publish_run.sh`: apply/preconditions/reapply refusal/behavior/race PASS; **6/6 mutations detected**. This tests the old parent contract as regression, not approval to retain its superseded privileged route.
- App suite: **258/258 PASS**. Initial missing dependencies were resolved only by copying matching installed TypeScript 6.0.3, Supabase 2.115.0 dependencies and expo-web-browser into the H3 clone's ignored node_modules; no network install or other worktree modification. Focused Threads app tests also **24/24 PASS**.
- `deno check --no-config` publish entry + integration contract PASS; targeted `deno lint --no-config` 8 runtime files PASS; `git diff --check` PASS.
- H3 adversarial SQL: R1 repro succeeds (expiry UPDATE commits first, release still succeeds); FOR SHARE control blocks UPDATE; workspace-deletion result-record probe returns the fixed refusal above. Scratch probes: `/private/tmp/h3-threads-pg-utf8.cEHq3Q/`.
- DB setup: H3-owned PostgreSQL 17.11, UTF8/C, Unix socket `/private/tmp/h3-threads-pg-utf8.cEHq3Q/socket`, port 54974, TCP listen disabled. Initial SQL_ASCII setup falsely rejected Japanese fixture text; switching the disposable cluster to UTF8 resolved that environment failure without source changes.
- NOT_RUN: actual managed Auth/PostgREST/Vault permissions, actual GoTrue refresh/revocation API, real Meta/OAuth/X/Threads, native device, deploy or paid provider call.

### Prioritized rollout ownership (all still held)

| Priority / owner | Required next evidence |
| --- | --- |
| 1 G4 | R1 bounded SQL lock correction and concurrent regression; keep flags false |
| 2 G5 | Effective live T13/entitlement/deletion ordering and provider-aware T10 footprint including permissions, attempts, nonces, custody and Vault cleanup |
| 3 H5 | Trusted dedicated owner channel; Auth session privileges/revocation contract; custody write in the same complete transaction; HTTPS callback forwarding/GoTrue proof |
| 4 G4 | Exact combined SQL/Edge apply and source flags only after resolved dependencies and separate preflight/approval |
| 5 Meta operator/user | Developer app, tester/scopes/redirects and attestation key custody; explicit named tester + text authorization for a single real post |

- changed_files: product source **0**; only H3 TASK/Report, H3 ACTIVE_TASK section and H3 CURRENT_STATE entry.
- commit_hash: reviewed product source `d4a1e87b77d1fbd362dc51809ce2d998afda15ea`; no product commit created. H3 bookkeeping commit is synchronized independently and identified by final remote read-back.
- push: product branches unchanged; H3 bookkeeping only via non-force fast-forward sync.
- merge: 0. deploy: 0. production_changes: 0. real_api_calls: 0. AI/paid_calls: 0. posts: 0.
- remaining_issues: R1 source race plus owner-dependent real-pilot proof gaps above; no repeated UI audit requested.
- safety_checks: physically separate H3 checkout, dedicated local fake cluster, no actual credentials/environment files or provider endpoints used, all protected histories preserved. H3-owned SQL runners clean their fake test databases; H3 cluster stopped after review.
- next_recommendation: return one narrow R1 correction to G4, coordinate the session contract with H5/G5, then complete the owner-specific real proof gates. Do not merge/apply/deploy or enable flags from this review verdict. H3 is released after C3, not parked for dependencies.
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: C3

---

# Codex Report 3

Codex slot 3（H3）の完了報告専用ファイルです（2026-10-11追加）。H3 TASK `.agent/tasks/CODEX_TASK_3.md` の報告をここへ記録します。新しい報告は先頭へ追加し、過去の報告は削除・改変しません。未実施項目も省略せず記録します。

## H3 FINAL — PR143 on-demand queue/Auth/security review — 2026-10-11 JST

- task_id: kabumori-pr143-ondemand-queue-auth-security-review-20261011
- result: **CHANGES_REQUIRED / PRODUCTION_NO_GO**. Reviewed PR #143 exact head `1d0529bb68b0e60b32ce0a2cb0002872b1671177` (OPEN/DRAFT/UNMERGED); no source edits, merge, or PR review submission.
- fresh_main_sha: `ccad07fa679cde4f07b0d3ecb8e3658a91ea6128`; candidate merge base `7e63397b6729e6191dc443206584f3749911c1b8`. Main is 36 commits ahead of base and PR is 2 ahead / 36 behind; changes since base are .agent coordination and social-mobile scheduling paths, with no product-file overlap against PR143.
- **P2 finding — expired lease can still mutate through fail RPC.** In `supabase/migrations/20261011150000_personalized_ondemand_analysis_v1.sql:479-480`, `fail_personalized_analysis_job` fences status/token/version but omits `lease_expires_at >= v_now`, although the matching complete RPC checks expiry at lines 425-426 and the migration/PR contract says both writes require a live lease. A worker that finishes with a failure after its lease expiry but before the next claim sweep can requeue or terminally fail a job after its authority expired. Minimal correction: include the expiry predicate in the fail fence and add a test for expired-but-not-yet-reclaimed lease; current worker-model test covers only the case after another worker has reclaimed/completed.
- Auth/RLS/SECURITY DEFINER review: no P0/P1 issue found. Request identity comes from `auth.uid()`; owner RLS and narrow authenticated column grants hide user_id, lease fields, source_basis, cost/tokens; app RPCs are authenticated-only; worker RPCs service_role-only; definer functions pin empty search_path. The public report RPC requires auth, completed cycle, bounded dates and an allowlisted projection. New feature gates are explicitly independent in the runbook; `public_market_feed_enabled` is the gateway, so bypassing legacy `market_report_consumer_settings.app_enabled` in the worker is documented, not an accidental implicit default.
- Queue/pipeline: request replay/per-user active lock, global claim serialization, FIFO + SKIP LOCKED, max-parallel cap, attempt bound, token/version completion fence, private persisted result, result-save before notification and separate notification retries are coherent. Global `push_enabled=false` or absent settings skip only notification, not the completed result. No cross-user portfolio input found; user_id is fixed in queries and rows are filtered again. Correct-date market basis / no future Yahoo bars / Fact-pass-only completion are covered in source and tests. Possible provider retry after ambiguous timeout can repeat paid model work; DB fencing cannot undo provider billing.
- Capacity caveat (estimate, not measured): at the stated two 90-second AI calls/job and default 4 concurrent slots, theoretical worst-case service rate is about 80 jobs/hour; a 1,000-job backlog could take about 12.5 hours before fetch/queue overhead. FIFO avoids modeled starvation, but large-queue latency is not proven by the mock fairness tests.
- Existing known blocker retained: broadcast push for common morning/close reports to all users is not implemented. Runbook calls it a blocker; no fanout/priority/recipient design was added by this PR. Expo delivery and real Edge/pg_net runtime limits were NOT_RUN.
- tests: 31 worker + 5 legacy gate + 22 app routing/presentation tests = **58 PASS** using `deno test --no-check` (runtime tests only; type-check bypassed). `deno check` worker entry PASS. Normal Deno test/type resolution is blocked by missing local `npm:@types/node`. `deno lint` found one unchanged `saveError` unused variable at `src/app/(tabs)/reports/index.tsx:79`; it is outside the candidate hunk. `git diff --check` PASS. Disposable PostgreSQL suite NOT_RUN: no listener at /tmp:5432; Podman socket access denied in this environment.
- changed_files: product source none; task-control records only (.agent/CODEX_REPORT_3.md, .agent/tasks/CODEX_TASK_3.md, H3 entry in .agent/ACTIVE_TASK.md and .agent/CURRENT_STATE.md).
- commit_hash: reviewed source `1d0529bb68b0e60b32ce0a2cb0002872b1671177`; no source commit created.
- push: product PR branch unchanged; report/control update recorded on main separately.
- merge: not_performed. deploy: not_performed. production_changes: 0.
- safety_checks: isolated clean H3 checkout; no provider/X/Expo/API calls, no DB/Cron/Vault/secret writes, no production connection.
- remaining_issues: P2 live-lease check in fail RPC; full checked Deno run and disposable PostgreSQL unavailable; common all-user broadcast remains a separate release blocker; large-queue runtime throughput not measured.
- next_recommendation: G2 should add expiry fencing to failure RPC plus expired/unreclaimed test, then request focused H3/C3 confirmation before any merge. Keep PR #143 draft; do not apply migration/deploy or stop legacy Cron until separate gates and the all-user broadcast decision are resolved.
- return_to: かぶモリアプリG2のちゃ
- completion_code: C3

## Report

- task_id: none
- result: not_started（未割当）
- status: idle
- next_owner: none
- return_to: none（未割当）
- completion_code: C3
- changed_files: none
- tests: not_run
- commit_hash: none
- push: not_performed
- deploy: not_performed
- remaining_issues: none（作業未割当）
- safety_checks: not_started
- next_recommendation: 明示割当までidleを維持する。
