# POSTONA Threads connect + manual publish — release readiness (G4-02 #17, 2026-11-13)

task_id: `postona-g4-gen2-17-threads-manual-publish-local-integration-and-release-gates-20261113` (Issue #561).
Evidence: this repository at this PR's HEAD (stacked on PR #657) and the local runner. **Production / managed / hosted were
NOT read** (forbidden in this TASK): every statement about production below is "to be confirmed read-only in a separately
approved window". Nothing here is a GO; every stage needs its own explicit approval.

## 1. What a release would ship (this stack vs `origin/main` 92884b33)

- 313 files, all Draft PRs, none merged. **No file under `supabase/migrations/`**: every SQL change is a reviewed *candidate*
  (`supabase/candidates/…`, "NOT A MIGRATION"), applied only by a person, in order, as the lifecycle owner.
- Edge functions touched: `threads-oauth-connect-user`, `social-mobile-threads-publish`, `social-mobile-threads-disconnect`,
  `threads-meta-callbacks`, `x-oauth-connect-user`, **`x-test-post`** (G4-02 #9: the X refresh precheck wired into the writer —
  deploying `x-test-post` from this stack also ships that change; see memory "x-test-post deploy bundles PRs": diff the deployed
  bytes first).
- App (`apps/social-mobile`): Threads connect / manual publish screens and hooks, behind `THREADS_CONNECT_UI_ENABLED = false` and
  `THREADS_MANUAL_PUBLISH_UI_ENABLED = false`.
- X OAuth candidates of the same stack (G4-02 #5–#9) are a separate release decision.

## 2. Gates (source constants; no environment variable can open any of them)

| Gate | Where | Prerequisites named in source |
| --- | --- | --- |
| `THREADS_CONNECT_PREREQUISITES_MET = false` | `_shared/social/threads_connect_contract.ts` | PHASE_2A2_MIGRATION_APPLIED, COMMON_ACCOUNT_WRITER_FENCE, CONNECT_RPC_REVIEWED, PROVIDER_AWARE_DELETION, META_APP_CONFIGURED |
| `THREADS_CONNECT_EDGE_WIRED = false` | `_shared/social/threads_connect_edge.ts` | — (the entry is H5's hard-disabled handler while closed) |
| `THREADS_MANUAL_PUBLISH_PREREQUISITES_MET = false` | `social-mobile-threads-publish/logic.ts` | PHASE_2A2_MIGRATION_APPLIED, THREADS_CONNECT_RUNTIME_LIVE, COMMON_ACCOUNT_WRITER_FENCE_LIVE, PUBLISH_LEDGER_APPLIED, PUBLISH_ATTESTATION_KEY_PROVISIONED, META_APP_PUBLISH_READY, INTEGRATED_SECURITY_REVIEW, PILOT_APPROVED |
| `THREADS_DISCONNECT_SERVER_ENABLED = false` | `_shared/social/threads_disconnect.ts` | — |
| `THREADS_META_CALLBACKS_ENABLED = false` | `_shared/social/threads_meta_callback.ts` | — (deauthorize / data deletion; N1 store is a central STOP) |
| `THREADS_ACCOUNT_BINDING_ENABLED`, `THREADS_TOKEN_REFRESH_ENABLED`, `THREADS_SEND_PORT_ENABLED`, `THREADS_CREDENTIAL_PORT_ENABLED`, `THREADS_VERTICAL_PATH_ENABLED` = false | `_shared/social/…` | older ports; not part of the manual path |
| `THREADS_CONNECT_UI_ENABLED`, `THREADS_MANUAL_PUBLISH_UI_ENABLED` = false | app domain | — |

## 3. Secrets / configuration each function would need (names only; no value was read or set)

| Function | Names |
| --- | --- |
| `threads-oauth-connect-user` (H5 runtime + G4 composition) | `POSTONA_THREADS_PROJECT_URL`, `…_PROJECT_REF`, `…_PUBLISHABLE_KEY`, `…_DB_HOST`, `…_DB_PORT`, `…_DB_NAME`, `…_DB_OWNER`, `…_DB_PASSWORD`, `…_DB_CA_PEM`, `…_APP_ID`, `…_APP_SECRET`, `…_CALLBACK`, `…_ATTESTATION_KEY`, `POSTONA_THREADS_G4_AUTH_PROFILE` (`full` / `personal`, must match the database) |
| `social-mobile-threads-publish` | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `THREADS_PUBLISH_ATTESTATION_KEY` (the same random value as the Vault secret `postona_threads_publish_attestation_v1`) |
| `social-mobile-threads-disconnect` | `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| `threads-meta-callbacks` | `THREADS_APP_SECRET`, `THREADS_META_DELETION_STATUS_URL` |

Setting Supabase function secrets bumps every function's version (memory "Supabase prod write path"): plan it with the deploy.

## 4. SQL candidates: install order (as the runner builds both G5 profiles) and rollback

Prerequisites already on `main` (production state NOT read): the social-mobile / common-account migrations the runner loads
(20260918120000 brand_memberships … 20261013120000 service deletion ownership, 20261007150000 multi-provider social_accounts).
Memory: some POSTONA base tables were created by no migration — confirm their real shape read-only first.

**G5 profile `personal` (G5 personal MVP):** G5 chain @ `21a5cad4` (reconciliation facts, enrollment session fence, X
unconfirmed snapshot record) → G5 `MVP_INSTALL.sql` @ PR #563 `9846c0f0` → PR #124 `postona_threads_oauth_workspace_candidate.sql`
→ `postona_threads_publish/threads_credential_custody_candidate.sql` → G4 `postona_g4_threads_personal_mvp/001_threads_binding_g5pv.sql`.

**G5 profile `full` (F5 owner epoch):** F5 `common_account_brand_owner_epoch/001` → PR #124 workspace → custody →
`postona_threads_binding_epoch/001` → G5 S2-3 predicate @ `bbc52a6b` + S2-2 session @ `6d59f3b6` → G4
`postona_g4_threads_personal_auth/001` (G4-42) → `002` (G4-43).

**Then, both profiles (the manual publish stack):**
1. `postona_threads_binding_epoch/002_custody_connect_proof.sql`
2. `postona_threads_auth_runtime/claim_candidate.sql` (H5)
3. `postona_threads_publish/threads_manual_publish_candidate.sql`
4. `postona_threads_publish/threads_publish_release_candidate.sql`
5. `postona_threads_cleanup/threads_provider_cleanup_candidate.sql`
6. `postona_threads_disconnect/threads_disconnect_candidate.sql`
7. `postona_g4_credential_verdict/001_threads_publish_credential_verdict.sql`
8. `postona_g4_threads_manual_publish_verdict/001_manual_publish_requires_credential_verdict.sql`
9. `postona_g4_threads_manual_publish_verdict/002_manual_publish_attempt_credential_generation.sql` (generation pin, send
   fence, read-before-rebind recovery; requires H5's `postona_threads_runtime.attempts` owned by the same owner)

Each file is one transaction with pinned pre/postconditions (it refuses, changing nothing, on any drift). **Rollback** strictly
in reverse: 002's rollback (refuses `G4MG_ROLLBACK_NOT_APPLIED` / `_OWNER` / `_FENCE_DRIFT` / `_TABLE_DRIFT` /
`_RECOVERY_DRIFT` before any change) → 001's rollback (refuses `G4MP_ROLLBACK_002_PRESENT` / `_002_PARTIAL` / `_STACK_UNKNOWN`)
→ the earlier candidates' own rollbacks. Rolling back 002 re-opens the H1 #40–#44 gaps: only together with stopping manual
publish. Measured locally: install, twice-refused, rollback, reinstall, 002 → 001 rollback leaving nothing, 25 drift cases.

## 5. Before any external write (each a separate approval)

| Step | Who | Evidence needed first |
| --- | --- | --- |
| Read production's real schema / roles / owners / Vault entries (read-only) | central + user window | that the prerequisites in §4 match; owner role; `postona_threads_runtime` present or not |
| Apply SQL candidates (§4) | user-operated, lifecycle owner, in a mutation window | the read-only diff; a rehearsal on a production-shaped copy |
| Provision the attestation key (Vault + function secret) | user | — |
| Meta app: Threads permissions (`threads_basic`, `threads_content_publish`), exact redirect URI, deauthorize / deletion callbacks, review | user (Meta console) | — |
| Deploy the Edge functions with gates still closed; byte-verify | user / central | memory: deploy from a worktree ships the shared checkout unless `supabase/config.toml` is there |
| Real-provider checks with a named tester (read-only first) | user + central approval | §6 |
| Lift the gates by a reviewed source change, for a named pilot | central + integrated security review | all of the above |

## 6. Provider contract: NOT_VERIFIED (must be checked on real Threads before the pilot)

- Can a token from a NEW grant of the same Threads user read a container created under the OLD grant? (The reconnect recovery
  depends on it; if not, an expired credential + unknown outcome stays fenced until a support path exists.)
- Are container statuses (PUBLISHED / ERROR / EXPIRED / FINISHED) final and truthful, and how long until EXPIRED?
- Is there any container → post link that could prove a post id? (Without it every lost answer stays `published_unidentified`.)
- Does a timed-out publish request still post? Does an old token keep working after a reconnect?
- Token lifetime / refresh behaviour for long-lived tokens.

## 7. Local integration (this TASK)

Scenario 35 runs the whole journey in one run: connect → consent → post (final) → post whose answer is lost → reconcile
(`published_unidentified`) → post → unknown + expired credential → the reconnect reads first and rebinds while another session
of the same person holds the account (H1 #45's NOT_RUN case: waited ~2 s, no deadlock) → post → disconnect → connect from
scratch → consent → post. 6 publish requests for 6 attempts, 0 non-GET from the connect side, deny-net empty.
Measured 2026-11-13 (runner `G4T_APP_FLOW=1`, disposable PG17.11, fake Threads / PostgREST / GoTrue over loopback): e2e
**35/35** personal and **35/35** full, exit 0 `G4T_APP_FLOW_ALL_PASS` both; the reconnect waited 2,050 ms (personal) /
2,018 ms (full) for the other session and completed, with no new SQL error. Every earlier stage (fail-before stacks, 15
mutants, 25 rollback drift cases) ran in both profiles; `G4T_VERDICT` / `G4T_BRIDGE_FLOW` ALL_PASS.
