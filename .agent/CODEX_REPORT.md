# H1 — Phase 1D stopped before source candidate

- task_id: `x-autopost-phase1d-claim-domain-partition-and-planner-authority-20260924`
- status: `review_required`; next_owner: `chatgpt`
- fresh main SHA at startup: `1497fab3af25fb20d3e02675eeb0e958e1cac412`
- fresh main SHA before report sync: `a1a17954bef88fe9fef30ce7ab96451baab9bd53`
- result: **No source candidate was created, tested, committed, or pushed.** Work stopped before implementation because a safe fresh checkout and the mandatory disposable PostgreSQL verification were unavailable. Production mutation: 0.

## Startup / ownership

- Read latest `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, `.agent/tasks/CODEX_TASK.md`, `PROJECT_RULES.md`, and H1 task context from `CODEX_REPORT_2.md`.
- H1 was `ready`; H2 was `idle`. G1 owns mobile Auth E2E; G2 owns admin Phase2 merge. Their declared file scopes do not overlap queue SQL/planners/`x-test-post`.
- Formal checkout `/Users/yuya/Developer/kabumori`: HEAD `e9cb57f713d15e58e82fb4b2230099d2fe6789b8`, with extensive unrelated dirty/deleted/untracked files including `.agent/**`, `x-test-post`, and migrations. It was not edited or staged. `git fetch origin main` could not update its FETCH_HEAD due filesystem permission.
- Existing clean temp clone `/private/tmp/kabumori-h2-phase1c-qghsg8` is at `0c141e883343c2e4c4e239a0cb45b80c61156928`, behind fresh main; network fetch failed because `github.com` DNS was unavailable.
- No local `psql`, Docker, or PostgreSQL server/initdb binary was available. Thus no disposable Postgres proof or tests could be run.

## Read-only source audit

- Legacy source `20260828203000_create_post_scheduler.sql` has `claim_due_post()` select any due `pending` row, with no `social_account_id` filter.
- `20260901044548_add_morning_greeting_schedule.sql` redefines the live-source claim to exclude `morning_greeting`, but still does not partition by account binding.
- Phase1B candidate `20260924023133_x_autopost_phase1b_account_bound_queue.sql` makes `claim_due_post_v2()` require a non-null bound account and keeps pre-X retry/stale reconciliation inside its v2 attempt ledger. Since legacy claim has no corresponding `IS NULL` exclusion, the split-brain overlap is confirmed from source.
- Phase1B `plan_daily_posts_v2` accepts explicit brand/account inputs, but other legacy planner paths remain unbound. No account inference or planner changes were made.
- Detailed Phase1C audit already recorded in `.agent/CODEX_REPORT_2.md`: current legacy planner set, lack of trusted account authority, and unresolved provider/completion boundaries.

## Verification / safety

- No candidate SQL/RPC/function/planner was changed.
- No disposable PostgreSQL test, focused test suite, static check, or `git diff --check` was possible because no implementation checkout was available.
- No production reads/writes, DDL/DML, migration apply, deploy, Cron/OAuth/Vault/token changes, or X API/network calls were made.
- Files changed by this task: `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md` (control-only stop synchronization; no source code files).
- Source commit/push: none. Control status/report synchronized to GitHub main; candidate source is not pushed.

## Blockers / next step

Resume only after an isolated checkout at current `origin/main` is available and a disposable PostgreSQL runtime can be provided. Then create and test the versioned claim-domain partition candidate, planner authority matrix, retry/stale/reconcile and concurrency proofs. Keep production mutation at 0. Outstanding architectural blockers remain exact-account credential resolver, atomic per-post-type completion contracts, and provider-step outcome model.

---

# H1 — PR #17 final Auth/security review (2026-09-24)

- task_id: `kabumori-mobile-recovery-pr17-final-auth-security-review-20260924`
- result: **PASS after one minimal P2 fix**; ready for C1 review. PR #17 remains open and unmerged.
- fresh `origin/main`: `e6bc2964263acadc6b54358f27245e117e7ee7ca` immediately before source push; `d297e3721e79a19a1c9c93289abb2d7e30036676` at report sync. No `src/`, `tests/app/`, `app.json`, or `package.json` drift from the K1-reviewed base.
- PR #17 original head: `7dc5c9ae2b5c5dea626c8a21bc2bc7c18c724a43`; reviewed and pushed head: `b3798aa6be82b6a29d8d2dcf21ca27fb19ef5f50`.
- source commit/push: `b3798aa` pushed to `claude1/recovery-deeplink-fix` (PR #17).
- deploy: none. Production mutation: **0**.

## Findings and fix

- **P2, fixed:** the prior recovery classifier used substring matching for `reset-password` and accepted `type=recovery` on any URL. An unrelated route such as `kabumori://news/reset-password-guide?code=...` could be sent to the password reset gate, and an external URL with that path could be treated as a recovery link. The classifier now accepts this app's schemes (plus the internal bare-path test origin), exact recovery routes, and a recovery callback only when it carries a recovery payload. Unknown and unrelated URLs pass through.
- No remaining P1/P2 finding in the PR scope. No auth/session policy was weakened. Token and fragment content stay in the original `expo-linking` URL; the router receives `/` only for classified recovery links. No token/password logging or persistence was added.
- Expo Router 57.0.17 source confirms `redirectSystemPath` is applied to both initial and subsequent URL events. `expo-linking` reads the original native initial URL/event separately. The G1/K1 record shows recovery UI, reset, re-login, in-app deletion and account cascade passed on a real iPhone at the pre-fix PR head. This H1 change was not re-run on a device; its accepted link forms are covered by tests.
- Account deletion and session handling files were not changed. Their affected regression tests passed.

## Changed files

- `src/lib/password-recovery.ts` — constrain recovery URL recognition.
- `tests/app/recovery-routing_test.ts` — cover Expo Go route forms and unrelated-link passthrough.
- `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md` — H1 control/report sync only.

## Checks

- `deno test --no-check --no-lock --allow-read tests/app/ supabase/functions/account-delete/`: **98 passed, 0 failed**.
- Mobile `src/` TypeScript scope: **0 errors**, using a temporary review tsconfig/CSS declaration because repository-wide `tsc --noEmit` includes unrelated admin/Deno code and lacks CSS declarations. Temporary files were removed after checking.
- `expo export --platform web` with dummy public Supabase values: **PASS**, 10 static routes, unchanged route count. No real credentials or network data were used.
- `git diff --check`: **PASS**.
- GitHub PR #17: `MERGEABLE` but Vercel required status is **FAILURE** from the free-tier build rate limit at the pushed head. Checks were not bypassed.

## Assessment / next step

PR #17 is safe to merge **once the required repository checks pass**, subject to C1 acceptance. Remaining release blockers outside this PR are custom SMTP, the unreachable confirmation/recovery Site URL, and undecided privacy/terms/support URLs. The owner's iPhone push token side effect from the earlier G1 disposable-account E2E remains documented in G1; this H1 review made no production change.

---

# H1 — PR #18 privacy/data-flow/EAS review (2026-09-24)

- task_id: `kabumori-release-pr18-privacy-dataflow-eas-light-review-20260924`
- status: `review_required`; next_owner: `chatgpt`
- result: **PASS after minimal privacy copy/test correction; C1 review required.** PR #18 remains open and unmerged. Production mutation: **0**.
- fresh `origin/main`: `188b16541a13998e5ff32501e52082b94e3251fe` (review/report sync base).
- PR #18 initial/K1 head: `2b91cc482be05536abca2a83ef2e346e5f4522f4`.
- PR #18 reviewed/pushed head: `6f3277639bc19fb1f420cd0e771c1d77f6d23519` (`codex/h1-pr18-privacy-correction-20260924` pushed to `claude1/release-foundation-web-links`).
- main-side drift since PR base `76a76b600428b555a7f3895e602df32cdafcc0de` did not touch PR #18's legal pages, legal-links, release docs, EAS config, or their tests. G2's current task/report was read without editing G2 files.

## Findings and fixes

- **P2, fixed:** the OpenAI disclosure listed portfolio details but omitted related-news headlines/summaries and shared public-market data/analysis that G2's `buildPacket` actually sends. The policy now names those data categories while retaining the accurate exclusion of email, user ID, memo, and target prices.
- **P2, fixed:** the prior `store: false` wording could imply that OpenAI retained no request data. The policy and release-readiness doc now distinguish Responses API application-state storage from abuse-monitoring logs and disclose the default up-to-30-day retention described in [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data).
- **P2, fixed:** deletion copy said all data was deleted with no qualification. It now says active service data is removed and explains that external-provider backups/security logs may retain copies according to provider retention periods. This is consistent with documented backup snapshots; see [Supabase database backups](https://supabase.com/docs/guides/platform/backups).
- **P3, fixed:** the collected-data table omitted the auth-generated user identifier. It is now listed as account data.
- No remaining P1/P2 code-level finding in the reviewed PR scope. Legal text remains a factual first draft; operator/professional review is still needed before publication.

## Review assessment

- **Data flow:** `tracked_stocks` supplies ticker/name/sector, tracking type, quantity, average price and position/side data. Report inputs include derived portfolio totals/P&L, related stock/market-news headlines and summaries, and shared public market facts/analysis. The reviewed G2 implementation uses `store: false` on both OpenAI requests. It strips user IDs from the packet and does not include email, memo, or target prices. Supabase remains the account/app-data store; push delivery uses Expo Push/APNs and the app's device push token/notification data. The privacy page lists the processors found in source. No ads/analytics SDK or tracking flow was found in the reviewed app dependencies/source.
- **Account deletion:** the page's in-app Settings path matches the implemented account-delete flow, which authenticates the caller and deletes only that caller's auth account; owned rows cascade as documented. Backup/log retention caveat was added. No real-device flow was repeated during this review.
- **Terms/support:** copy accurately describes informational/AI-generated reports, password-account support, reset guidance, and the deletion route. They are release drafts and should receive operator/legal review.
- **Legal links/site build:** URL normalization permits only an HTTPS origin and page routes are centralized and match built routes. Production builds reject missing/malformed operator values; preview builds visibly mark missing values and set `noindex,nofollow`. Secret/internal-identifier scan tests pass. Netlify configuration is a static Node 22 build with baseline response headers; no production Netlify setup/deploy was performed.
- **EAS:** `appVersionSource: remote` plus production `autoIncrement: true` is a supported remote build-number setup. No EAS build or submission was run. Existing blockers remain: template app icon/splash, absent EAS production Supabase/legal-web environment values, uncreated App Store Connect record/submit profile, operator-chosen display name, encryption declaration, public-site/operator configuration, Auth Site URL/SMTP.

## Changed files

- `apps/kabumori-web/pages/privacy.html`
- `apps/kabumori-web/pages/account-deletion.html`
- `apps/kabumori-web/build_test.ts`
- `docs/mobile-release/RELEASE_READINESS.md`
- `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md` — H1 control/report sync only

## Checks and safety

- `deno test --no-check --no-lock` on the web build, legal-links and settings-menu suites at PR head `6f32776`: **17 passed, 0 failed**.
- `git diff --check`: **PASS**.
- TypeScript check was attempted but could not run to completion in this checkout: `node_modules` is absent, Deno cannot resolve `npm:@types/node` for the TS tests, and Deno's direct check of the Expo test files cannot resolve the project's `@/*` path alias. No app TypeScript implementation file changed; the changed `.ts` file is assertion-only test coverage and executed successfully.
- GitHub PR #18 after push: OPEN, head `6f32776`, branch mergeable, required Vercel status **FAILURE** (`build-rate-limit`). No bypass attempted.
- No merge, Netlify/DNS/EAS/App Store operation, Supabase read/write/configuration, migration, deploy, or production mutation was performed.

## Recommendation

The privacy corrections are pushed to PR #18, but **do not merge yet** while the required Vercel status is failing. Once the required check passes, the source change is review-ready subject to C1 and operator/legal approval of the first-draft legal text. The App Store/EAS and public-site blockers above remain outside this PR review.


## Final C1 assessment — PR #18

- verdict: **PASS after H1 fixes**
- reviewed head: `6f3277639bc19fb1f420cd0e771c1d77f6d23519`
- focused tests: 17 passed / 0 failed
- production mutation: 0
- Vercel rate-limit failure is not treated as a Kabumori Web merge-quality blocker because Kabumori Web Preview/Production uses Netlify.
- next: G1 fresh-main merge + post-merge verification for PR #18.

---

# H1 — Phase1E exact-account Auth/secret/provider final review (2026-09-24)

- task_id: `x-autopost-phase1e-auth-secret-provider-final-review-20260924`
- status: `review_required`; next_owner: `chatgpt`
- verdict: **PASS-WITH-FIX for source-only candidate**, subject to C1 review of [PR #22](https://github.com/anohi-memories/kabumori/pull/22). **NO for production activation.**
- fresh `origin/main`: `ee862bb8226091a1bf55bed9be8aef6ffad87704` at review start; `87c18660e1d3f6f41656677d548ce331c454f233` after pre-push fetch. New intervening main changes were in app/report lanes, not Phase1E files or H1 TASK/Report.
- reviewed implementation commit: `1868cc0e418ebda15ecfdfc88c55c9dd25a471f7`; fix commit: `7406c1c60506323400247b6c24162a5da4097419` on `codex/h1-phase1e-security-review-20260924`, pushed as PR #22.
- production mutation/deploy/token refresh/X API calls: **0**. No live dispatcher or legacy routing changed.

## Findings by severity and fixes

- **P1, fixed in PR #22 — automatic redirects violated the one-create guarantee.** Default `fetch` redirect following could replay `POST /2/tweets` on a 307/308, preserving method/body after the durable provider-start mark. Both X requests now use `redirect: 'manual'`; create 3xx/unexpected statuses are conservatively `x_outcome_uncertain`, not `x_rejected`. The credential RPC request also uses manual redirects so a service-role-key-bearing request cannot be followed to another host. Regression tests check request mode and 307 classification.
- **P1, fixed in PR #22 — Vault-origin `P0001` could leak a secret/reference message.** The outer SQL handler intentionally rethrows local fixed-code `P0001`, but it also rethrew any `P0001` raised by `vault.decrypted_secrets`. A nested Vault-only handler now maps every Vault error to fixed `X_CREDENTIAL_UNAVAILABLE`; a disposable PostgreSQL view that throws a fake secret/reference-bearing `P0001` proves masking.
- **P2, fixed in PR #22 — default PUBLIC EXECUTE commit window.** The token-returning `CREATE FUNCTION` and REVOKE/GRANT are now explicitly in one transaction. The disposable ACL proof confirms service_role EXECUTE and anon/authenticated denial after commit.
- **P2, residual architecture boundary — service_role direct Vault access in production.** Prior Phase18 catalog-only audit recorded `service_role` SELECT on production `vault.decrypted_secrets`; the Phase1E fixture deliberately revokes it. Thus the test proves this RPC's exact-account path, **not** that arbitrary service_role SQL is confined by the RPC. Keep the key only in the trusted server runtime and recheck live grants/owner without reading plaintext before any activation. No ACL change was authorized or made.

## Assessment

- **Exact account:** The open `pre_x` attempt ID+claim token is the authority; account and brand inputs must match it, the scheduled post must still be running/bound, and account lookup is by PK. X platform, `identity_verified`, nonblank platform ID and publish-enabled (for the publisher's `requirePublishEnabled=true`) are checked before reading only that row's access reference. Same-brand multi-account and cross-brand negative proofs pass. No brand-only/first-row/current-count/legacy-store/env/AI-Lab/fallback path exists in the new resolver. Production schema/unique constraints are still a rollout preflight, not assumed applied.
- **RPC/Vault/ACL:** `SECURITY DEFINER`, empty search_path, qualified objects, service_role-only EXECUTE in the disposable proof; no generic ref input or refresh-token output; read-only. Explicit transaction closes the PUBLIC grant window. Function owner, live dependencies and Vault ACL must be read back before apply. The migration is intentionally non-idempotent and has not been applied.
- **TS secret boundary:** Resolver is server-only and unreferenced by mobile/admin/live dispatcher. Token is a private field, omitted from JSON/string/Deno inspect and fixed-code errors; raw RPC responses are not logged. `bearerHeader()` intentionally reveals it to a trusted caller, so this is defense in depth, not confinement against arbitrary server code holding the object.
- **Provider:** GET `/2/users/me` proves the X platform user ID before the provider mark. 401 there is pre-X retryable with zero creates; mismatch is terminal. The mark callback must **actually commit** `mark_post_provider_started_v2` before resolving (future dispatcher obligation). Afterward the seam issues one manual-redirect POST with no refresh/retry; 401 is rejection, 408/5xx/network/timeout/2xx-without-ID/3xx are uncertain. Identity GET has rate-limit/outage implications: failures remain pre-X and send no create.
- **Outcome seam:** Phase1B has no `x_rejected` ledger state. A future dispatcher must map that result to uncertain until a dedicated safe terminal contract exists; never auto-retry after provider start. Per-post-type atomic completion, tip thread steps, morning-greeting media/create, per-account pre-X refresh writer and credential move remain separate gates.
- **Migration/source safety:** Phase1E depends on Phase1B/1D objects and the live social-account Vault reference column. The Phase1D claim-domain migration still requires an atomic, live-definition-vetted rollout; do not apply Phase1E alone or run a blanket `db push`. No production read-back was performed in this H1 review.

## Changed files and verification

PR #22 changes only:

- `supabase/migrations/20260924170000_x_autopost_phase1e_claim_bound_credential_reader.sql`
- `supabase/functions/_shared/x_v2_claim_credentials.ts`, `x_v2_claim_credentials_test.ts`
- `supabase/functions/_shared/x_v2_one_request_provider.ts`, `x_v2_one_request_provider_test.ts`
- `supabase/functions/x-test-post/claim_bound_credential_reader_migration_test.ts`
- `supabase/tests/x_autopost_phase1e_behavior.sql`, `x_autopost_phase1e_exact_account_credentials.md`

Checks at the fixed source: focused Phase1E **31/31**; Phase1B+1D focused static **13/13** (with Phase1E static, **19/19**); full `x-test-post` **422/422**; full `_shared` **116/116**; `important-news-monitor` **431/431**; disposable local PostgreSQL Phase1E behavior and cleanup **PASS**; `deno check` of changed source **PASS**, and changed tests with `--no-config` **PASS**; `git diff --check` **PASS**. Ordinary repository-configured `deno check` of test files could not resolve missing local `npm:@types/node`; the same files type-checked with `--no-config` and executed successfully. Secret/legacy-helper grep found only explanatory comments, no code path. The disposable PostgreSQL instance held fake data only and was stopped; no cloud database was used.

## Next recommendation

C1 review PR #22 and this report. The Phase1E candidate may remain in source after merge, but **do not activate/deploy**. First complete Phase1B/1D atomic rollout preflight and live-definition/ACL read-back, per-account Vault credential preparation, provider-start durability wiring, post-type completion/outcome contracts, and dedicated production authorization. `x_rejected` must remain uncertain in any interim mapping.

---

# H1 — Phase1F ledger / atomic completion final review (2026-09-24)

- task_id: `x-autopost-phase1f-ledger-atomic-completion-final-review-20260924`
- status: `review_required`; next_owner: `chatgpt`
- verdict: **PASS-WITH-FIX for source candidate**; [PR #25](https://github.com/anohi-memories/kabumori/pull/25) awaits C1. **Production activation: NO.**
- reviewed implementation: `0b752925b28b1b922b94a4cb7629ee942f82120f`; fix commit: `b3740cc7c39010f02ad3505721a5b37d2e707dba` on `codex/h1-phase1f-ledger-review-20260924`.
- fresh `origin/main`: `0d1aec0105de7f7bccb8bad56b2a44c2a42b6f51` at startup; `a359f0808ed8126ae4de8b694c9a4ec8db3f1d15` at report preparation. Intervening main changes did not touch Phase1F source or the H1 task.
- source push: complete; PR #25 open. Deploy, production migration/DDL/DML, Cron/OAuth/Vault/token change, and X API call/post: **0**. The dirty `/Users/yuya/Developer/kabumori` checkout was not changed; work used independent throwaway worktrees.

## Findings and minimal fixes

- **P1, fixed — direct schedule-table DML bypass.** Default `service_role` table grants left `scheduled_posts` writable. Phase1D's `kabumori.x_queue_domain` is a caller-settable custom setting, not an ACL, so a privileged API client could mutate a bound post's lifecycle without the attempt ledger. Phase1F now revokes API-role direct INSERT/UPDATE/DELETE/TRUNCATE on `scheduled_posts`. The disposable proof shows direct UPDATE denied even after setting the domain marker, while owner-executed bound and legacy unbound RPCs still work. Production direct-write consumers and live grants need read-back before any apply.
- **P2, fixed — provider-step chain integrity.** Step 1 could previously be a `create_reply` naming an arbitrary parent. After a confirmed step, an unrelated second root post or a reply to a media ID could be recorded. The RPC now requires first create/media and kind order `media_upload → create_post` or `create_post → create_reply → …`, preserving exact reply-parent matching.
- **P2, fixed — late step outcome after terminal attempt.** `finish_provider_step_v2` accepted an unfinished step after the parent attempt became terminal. It now locks the attempt before the step and requires active `provider_started` for a new outcome. Exact replay of an already-finished step remains read-only/idempotent.
- No remaining confirmed P1/P2 source defect within this Phase1F review scope. `service_role` is still a trusted privileged runtime; this contract is not confinement against arbitrary SQL with broader table/Vault privileges.

## Assessment

- **State machine:** The Phase1B/1D claim-domain partition and Phase1F outcome checks keep pre-X retry/terminal transitions before provider start; `x_rejected`, `x_outcome_uncertain`, `x_confirmed_db_incomplete`, and `completed` are non-reclaimable after provider start. Claim token, attempt, post/account/brand/type, provider phase, and running status are checked under row locks. Duplicate completion returns `already_completed`, with one set of side effects; a local concurrent two-session race proves this. Error-injection proof shows mid-completion failure rolls back status, attempt and side effects.
- **Typed completion fidelity:** Interaction, useful_tip, morning_report, close_report, and us_premarket_report functions were compared with the legacy completion source. Each moves the post and attempt together, writes the success execution log only after the type-specific effects, and updates the corresponding topic/tip/report-run linkage in one PostgreSQL function transaction. No generic success path remains executable by service_role.
- **Disabled types:** tip, morning_greeting and brand_post have no v2 typed completion and stay disabled in the outcome mapping. The provider-step ledger is foundation only; it does not enable multi-request posting. No live dispatcher wiring was changed.
- **Observability:** A claim records one started log; terminal non-success outcomes record failed logs with fixed error codes, without turning the attempt retryable. The completion race produced one success log. No secret/token/response body was added to logs or reports.
- **ACL:** Public functions use `SECURITY DEFINER` and fixed empty search path, with qualified objects. API EXECUTE on internal helpers/triggers is closed; public typed RPCs are service_role-only. service_role can SELECT, not directly write, the attempt/turn/step ledgers or `scheduled_posts`. This was checked with actual disposable role grants, not only text matching.
- **Migration:** Phase1F is deliberately non-idempotent and depends on ordered Phase1B → 1D → 1E → 1F application. It uses an explicit transaction plus a preflight assertion of the old attempt constraint; a failed statement rolls back the transaction in the disposable proof. The migration must be reviewed against the chosen apply tool's transaction behavior and live definitions/ACLs. Retiring generic completion is safe only while the live dispatcher has not switched to v2; source confirms it remains unwired. No production read-back/apply was performed.

## Changed files and checks

- PR #25 source files: `supabase/migrations/20260924180000_x_autopost_phase1f_atomic_completion.sql`, `supabase/tests/x_autopost_phase1f_behavior.sql`, `supabase/functions/x-test-post/atomic_completion_migration_test.ts`, `supabase/tests/x_autopost_phase1f_atomic_completion.md`.
- Control/report sync: `.agent/tasks/CODEX_TASK.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, `.agent/CODEX_REPORT.md`.
- Focused Phase1B/1D/1E/1F and provider/seam tests: **55 passed, 0 failed**.
- Full `x-test-post`, `_shared`, `important-news-monitor`: **980 passed, 0 failed** (respective suites 429/120/431).
- Disposable local PostgreSQL: Phase1D behavior/concurrency/cleanup **PASS**; Phase1E behavior/cleanup **PASS**; Phase1F behavior/duplicate-completion race/cleanup **PASS**. Fake data only; cluster stopped and removed.
- `deno check --no-config` and `deno lint --no-config` for the changed TS test, `bash -n` on all three runners, and `git diff --check`: **PASS**.
- PR #25 has a Vercel `build-rate-limit` failure at report time; no check bypass, merge, or production action was attempted.

## Remaining blockers / recommendation

C1 should review PR #25 and this report. The source candidate can remain for further work, but **do not apply or activate in production**. Before any separately approved rollout: read back live constraints, function definitions, owners, grants and direct-write consumers; agree on an ordered atomic migration/apply and rollback plan; complete exact-account Vault readiness, provider-start durability wiring, typed dispatcher use, multi-request completion for tip/greeting, and the AI Lab brand_post path. Keep disabled types disabled until those gates are independently reviewed.

---

# H1 — Phase1G tip/greeting multi-step final review (2026-09-25)

- task_id: `x-autopost-phase1g-multistep-tip-greeting-final-review-20260925`
- status: `review_required`; next_owner: `chatgpt`
- verdict: **PASS-WITH-FIX for source candidate**, subject to C1 review of [PR #27](https://github.com/anohi-memories/kabumori/pull/27). **Production activation: NO.**
- reviewed implementation `e0f7785`; fix commit `5a62af547dbc840c1f7b140d6d51d8876c1a7223` on `codex/h1-phase1g-multistep-review-20260925` (pushed). Fresh `origin/main` at start/pre-push: `66fb046276fecb5c68f493f3f14c10ea2cdd6928`; no Phase1G source or H1-task drift. PR #27 is open/mergeable, with Vercel check passing at report time. No merge was attempted.
- Independent H1 worktree: `/private/tmp/kabumori-h1-phase1g-review-20260925`. Dirty `/Users/yuya/Developer/kabumori` and other slots were not modified. Production DB/DDL/DML/RPC, deploy, Cron/OAuth/Vault/token/refresh, X API/post/media calls: **0**.

## Findings by severity

- **P1, fixed in PR #27 — overdue greeting could publish on the wrong day.** The original `acquire_greeting_publish_claim_v2` used a scheduled row's `schedule_date` for the brand/day claim without checking today's JST date. The v2 claim lane can pick overdue rows; a prior-day greeting could thus acquire a prior-day claim and send X media/create today, separately from today's claim. The unchanged legacy greeting publisher determines `date_jst` from its actual execution time. A disposable adversarial test first failed on the original migration (`EXPECTED_ERROR_NOT_RAISED: GREETING_SCHEDULE_DATE_STALE`). Acquisition now rejects a non-current-JST schedule date; the plan-aware begin RPC rechecks before **each** provider step, so a claim made before midnight cannot authorize a later-day request. The fixed test passes, including a case where a legacy-privileged direct claim row is inserted for the overdue attempt. A future dispatcher must safely settle/flag stale rows; it must not send X. If a request itself spans JST midnight, its outcome is still handled through the ordinary durable step ledger rather than replaying it.
- **P3, fixed — next-action helper accepted duplicate confirmed thread IDs.** DB completion already rejects duplicate part IDs; the server helper now returns `THREAD_STEPS_INCONSISTENT` rather than suggesting a completion that DB must reject. Regression added.
- An attempted owner-level corruption of a non-reply parent was rejected by the **existing Phase1F table CHECK constraint**. No redundant parent-ID migration change was retained. No other confirmed P1/P2 finding remains in the reviewed source scope.

## Review assessment

- **Tip plan/steps:** One immutable pre-X plan fixes 1–3 parts. The plan-aware RPC and Phase1F table/step rules require step 1 `create_post`, later `create_reply`, contiguous numbers, previous-step confirmation, matching parent, no duplicate start and no step beyond the plan. Rejected/uncertain or unfinished steps block later steps; any confirmed create prevents recording the entire attempt as `x_rejected`. The helper returns one next action, never an automatic loop or replay.
- **Tip completion:** Compared with legacy `complete_tip_post`: the typed RPC locks the attempt, verifies every planned step and distinct part IDs, then atomically marks post/attempt success, increments tip usage once, and writes one success log carrying the root X ID. All part IDs remain in the step ledger. Duplicate and two-session concurrent completions produce one side-effect set; a forced downstream tip failure rolls back the post/attempt/log effects. `x_confirmed_db_incomplete` can recover only with the same root ID.
- **Greeting claim/media/create:** The claim is keyed by brand, post type and JST date, with `execution_id` set to the exact attempt. It is not transferred after failure. Plan step 1 is media upload; step 2 is create-post using precisely the confirmed media ID from that attempt. Wrong order, foreign/mismatched media, uncertain create, repeat media/create, and stale day fail closed. The Phase1F CHECK also enforces that non-reply steps have no parent. No live legacy path was changed.
- **Greeting completion:** Exactly two confirmed steps are required. One DB function transaction moves post and attempt to success, publishes that attempt's same-day `publish_claims` row with the X post ID/timestamp, and writes one success log. Duplicate completion is read-only/idempotent; injected log failure rolls all DB changes back. The external Storage receipt is intentionally best-effort and must be written **after** DB commit by a future dispatcher; it is not claimed to be transactional.
- **Helper/secret boundary:** The server helper validates action/request kind, parent and media input, durably begins one step before one manual-redirect X request, and does not refresh, retry, loop, infer an account from brand, or log credentials/provider bodies. It relies on the unchanged Phase1E exact-account credential resolver and on a future caller to commit begin/finish in the required order. No live dispatcher is wired.
- **ACL:** New public RPCs are `SECURITY DEFINER`, empty `search_path`, schema-qualified, and service_role-only; internal/trigger EXECUTE and raw Phase1F step-begin API entry are revoked. Plan and step tables are SELECT-only to service_role. The disposable role proof checks ACLs. `publish_claims` still grants service_role direct SELECT/INSERT/UPDATE for the unchanged legacy REST path; therefore this is a trusted-service-role contract, not confinement from arbitrary privileged SQL. Live grants and all direct-write consumers must be read back before rollout.
- **Migration/apply:** Phase1G is additive, non-idempotent and ordered after 1B/1D/1E/1F. It preflights Phase1F objects and the brand/day unique index, and encloses functions, table changes and grants in one explicit transaction, closing the default PUBLIC EXECUTE window. Any apply tool must not add incompatible nested transaction behavior; live definitions, ownership, constraints, grants, migration history and rollback plan remain unverified. No production apply was performed.

## Changed files, verification and next recommendation

- PR #27 contains only: `supabase/migrations/20260925090000_x_autopost_phase1g_multistep_completion.sql`; `supabase/tests/x_autopost_phase1g_fixture.sql`, `x_autopost_phase1g_behavior.sql`, `x_autopost_phase1g_multistep_completion.md`; `supabase/functions/_shared/x_v2_multistep.ts`, `x_v2_multistep_test.ts`; `supabase/functions/x-test-post/multistep_completion_migration_test.ts`.
- Control/report sync: `.agent/tasks/CODEX_TASK.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, `.agent/CODEX_REPORT.md`.
- Focused Phase1B/1D/1E/1F/1G + credential/provider/outcome/multistep: **72 passed, 0 failed**. Full `x-test-post`, `_shared`, `important-news-monitor`: **997 passed, 0 failed** (437/129/431). Greeting/tip-specific: **138 passed, 0 failed**.
- Disposable PostgreSQL: Phase1D behavior/concurrency/cleanup **PASS**; Phase1E behavior/cleanup **PASS**; Phase1F behavior/race/cleanup **PASS**; Phase1G behavior/duplicate-completion race/cleanup **PASS**. All clusters used fake data and were stopped/removed. The Phase1F standalone proof intentionally expects its old raw-step EXECUTE and is not claimed to pass stacked on Phase1G, where that privilege is revoked by design.
- Changed TS Deno check/lint, runner `bash -n`, and `git diff --check`: **PASS**.
- **Next:** C1 review PR #27 and this report. Phase1G may remain a source candidate, but do not merge automatically or apply/activate in production. Later gates include live schema/ACL/definition preflight, ordered atomic 1B→1G migration and rollback plan, exact-account credential readiness, gated v2 dispatcher/producer wiring, interaction poll seam, brand_post completion source, and operator handling of failed/stale greeting days. Production activation needs separate authorization.

---

# H1 — Phase1H gated v2 dispatcher final review (2026-09-25)

- task_id: `x-autopost-phase1h-gated-dispatcher-final-review-20260925`
- status: `review_required`; next_owner: `chatgpt`
- verdict: **PASS-WITH-FIX for the source-only candidate**, pending C1 and [PR #28](https://github.com/anohi-memories/kabumori/pull/28). **Production activation: NO.**
- reviewed implementation: `59bd54412eae989400b6ce7e9ecb56dc943db94f` (present unchanged in `origin/main` at review start `413e896`). Fix commit: `ce60d7a29022956d049521ffaeb533a749152a60`, pushed to `codex/h1-phase1h-final-review-20260925`. Pre-push fresh main: `45c3b966ad8923cf0ffb38ffa8a73286d02d372e`; pre-report fresh main: `f96be6be8b9a06da1e4b7a4c8dbbe9891b15384d`. Intervening G4 control and important-news changes did not touch Phase1H/H1 files. Dedicated review and report worktrees under `/private/tmp/kabumori-h1-phase1h-*`; other slots' worktrees were not changed.

## Findings by severity

- **P2, fixed in PR #28 — reported pre-X result diverged from the committed ledger.** `settle_post_pre_x_v2` returns `pre_x_terminal` at attempt 3 even when asked for retry. The adapter discarded that return value, and the dispatcher reported `pre_x_retryable`. It also swallowed a failed settle write but returned the requested terminal/retry class; an unsupported type could be labelled `unsupported_type` while its attempt remained open. The dispatcher now consumes and validates the RPC's committed class. A failed/invalid settle response yields `blocked_manual_reconciliation` with a fixed code; unsupported is reported only after a committed terminal settle. Regressions cover attempt cap, write failure and malformed RPC response. No migration or existing live path changed.
- **Residual operational limitation, not an X-replay path:** if the pre-X settle write fails, the existing Phase1D stale-pre-X reconciler can later requeue the still-open attempt. The new result deliberately does not claim durable terminality. An unsupported type still makes zero provider calls if reclaimed, but the bound-row producer policy and stale-reconcile monitoring must be settled before activation. No automatic production rollback/retry safety is inferred from the result label alone.
- No other confirmed P1/P2 source defect was found in the reviewed Phase1H scope. The exported dispatcher accepts a boolean gate from its future trusted server caller; it is **not imported by the live entrypoint**. Future wiring must pass only `isV2DispatchGateOn(Deno.env.get)`, not request/admin/mobile data. That wiring does not exist yet and is not approved here.

## Boundary assessment

- **Gate / legacy:** only exact server env value `enabled` returns true; missing, case/whitespace/alternate truthy values and env-read failure are OFF. `gate_off` returns before any ledger/credential/X call. `index.ts` remains unchanged and does not import the v2 dispatcher; no fallback from a partly-started v2 attempt to the legacy sender was found. No gate was enabled.
- **Claim / exact account:** adapter calls `claim_due_post_v2`, not the old unpartitioned claim; Phase1D partitions bound and legacy rows. Claim's attempt/token/account/brand is carried into the Phase1E resolver and Phase1H resume reader. The resume SQL requires matching attempt token, social account, brand, running bound post, eligible plan/steps, verified X identity and that account's own Vault access reference. Wrong-account fake responses fail before X. No brand-first, env-token, legacy-store or refresh fallback was found.
- **Resume:** SQL orders eligible attempts by provider-start time/id and excludes finished, rejected, uncertain, in-flight and pre-X states; the open-attempt index and running-post check block stale/newer attempt reuse. Plan and snapshot are immutable before provider start; resumed tip/greeting content is read from the snapshot, not regenerated. Confirmed steps are skipped, in-flight or nonconfirmed steps block replay. A fully confirmed multi-step attempt re-enters typed DB completion without provider requests. A recorded `x_confirmed_db_incomplete` is non-reclaimable by the dispatcher and requires operator same-ID typed completion; no automatic X retry occurs.
- **Provider / typed completion:** single create durably marks provider start before one manual-redirect POST; mark failure sends no create. No refresh or hidden retry. Rejection/401 makes no second create; timeout, 408/5xx/3xx, network and 2xx without ID are uncertain. Multi-step begins and finishes each planned media/create/reply step durably, with one request per step and no replay after finish-write failure. Tip replies chain to confirmed ledger IDs; greeting create uses that attempt's confirmed media ID. Stale JST greeting sends zero provider calls; publish claim is attempt-bound; Storage receipt callback runs only after typed completion succeeds. Completion failures retain the confirmed X ID for manual reconciliation.
- **Types / classes:** interaction stays disabled because the poll seam is absent; brand_post and unknown types also fail closed with zero provider calls. All 11 return classes were reviewed. After the fix, pre-X classes mirror committed DB results. Provider rejected/uncertain, confirmed incomplete, completed, unsupported and manual-blocked states are not automatically re-claimed by the dispatcher. The stale-pre-X caveat above remains.
- **ACL / migration:** Phase1H depends in order on 1B→1G, is additive and non-idempotent, and wraps object creation plus REVOKE/GRANT in one explicit transaction. New SECURITY DEFINER functions use empty search_path and qualified relation references; API RPC EXECUTE is service_role-only, internal helper/trigger EXECUTE is revoked, and the snapshot table is SELECT-only for service_role. The trigger requires a plan and snapshot before tip/greeting provider start. Disposable role/behavior proofs pass. Live definitions/owners/grants, direct-write consumers, Vault ACL and apply-tool nested transaction behavior were **not** read back; no production apply is approved. service_role remains a trusted server boundary, not a confinement guarantee against arbitrary privileged SQL.

## Changed files, verification and recommendation

- PR #28 changed only `supabase/functions/x-test-post/v2_dispatcher.ts`, `v2_dispatch_ledger_rpc.ts`, `v2_dispatcher_test.ts`, `v2_dispatch_ledger_rpc_test.ts`, and `supabase/tests/x_autopost_phase1h_gated_dispatcher.md`. Control sync changed only this report, H1 TASK, H1 index/status lines in ACTIVE_TASK and CURRENT_STATE.
- Focused Phase1B–1H + provider/credential/ledger tests: **102/102 PASS**. Full `x-test-post`: **467/467**; `_shared`: **129/129**; `important-news-monitor`: **431/431**; greeting/tip/publish_claim-specific: **138/138**. Disposable local PostgreSQL Phase1D behavior/concurrency/cleanup, Phase1E, Phase1F behavior/race/cleanup, Phase1G behavior/race/cleanup and Phase1H behavior/cleanup: **PASS**. Fake data only; each runner dropped its database and the local cluster was stopped after the suite. Changed TS Deno check/lint, five runner `bash -n`, `git diff --check`: **PASS**. Real X/network calls: **0**; tests used fake transports.
- Push: fix branch and PR #28 created; merge: **not done**; deploy: **not done**. Production DB/DDL/DML/RPC, Edge, Cron, OAuth/Vault/token/refresh, X post/media, gate or scheduler/claim switch: **0 mutations**.
- **Source-candidate acceptance:** yes, with PR #28 fix and C1 review; **production activation: NO**. Next: C1 review PR #28 and this report. Before any separately authorized rollout, finish Phase1I exact-account refresh writer, real v2 content adapters and gate-OFF entrypoint, Kabumori account Vault readiness, interaction poll/brand_post seams, operator reconciliation/failed greeting-day procedures, and live schema/ACL/apply/rollback preflight. Do not deploy/apply/activate from this report.

---

# H1 — Phase1I exact-account refresh final review (2026-09-25)

- task_id: `x-autopost-phase1i-exact-account-refresh-final-review-20260925`
- status: `review_required`; next_owner: `chatgpt`; finish code: C1
- verdict: **PASS-WITH-FIX for the source candidate only**. [PR #30](https://github.com/anohi-memories/kabumori/pull/30) awaits C1 and remains unmerged. **Production activation: NO.**
- reviewed implementation: `12e9fd1`, present in main at H1 start `7da825d017e498a4700c1251f3d2287e66aab41a`; fix branch head `94000720e10649612e84cb3811327de1a63364e9`, pushed to `codex/h1-phase1i-review-20260925` after rebasing on fresh main `72042530a1f63c92b0f2faf9d7ac7398b4032ff7`. Intervening main changes did not touch Phase1I source/H1 files. Dedicated source and control worktrees under `/private/tmp/kabumori-h1-phase1i-*`; no other slot's checkout was modified.

## Findings by severity

- **P1, fixed in PR #30 — cross-account Vault write after silent ref change.** Original `commit_x_account_refresh_v2` checked `updated_at` and non-null refs, but did not compare either destination with its lease-start value or recheck exclusive ownership. The disposable fake-Vault proof changed `acct_b.vault_access_token_secret_id` to `acct_a`'s secret without changing `updated_at`; the original function returned `committed` and overwrote `acct_a`'s access secret. The fix snapshots exact brand/X user/OAuth client/both secret IDs at begin, compares them and checks no shared refs at commit, and takes a `SHARE` lock on `social_accounts` while checking/writing so concurrent account DML cannot create a phantom shared ref. Regression now returns `account_changed`, leaves both account secrets untouched and makes the lease `uncertain`.
- **P2, fixed in PR #30 — stale attempt could write after settlement.** A pre-X attempt may be settled while the external refresh request is in flight. The old commit only checked the lease/account, not whether its attempt/post remained open. The fix locks and rechecks the lease-bound attempt and running post before Vault writes; the regression settles the attempt first, then proves commit refuses and marks the account uncertain. No replay or new provider call is introduced.
- No other confirmed P1/P2 source defect in this review. `SHARE` serializes commits with account DML and can briefly delay OAuth reconnect/account updates; this is deliberate safety behavior, not a throughput claim. Operator intervention remains necessary for uncertain/reauth/stuck-refresh states.

## Boundary assessment

- **Exact account / authority:** begin requires exact attempt ID + claim token, pre-X/no outcome, running bound post, exact account/brand, X/verified identity/publish enabled, configured OAuth client, distinct present Vault refs and no shared refs before returning a server-only lease. Commit now rechecks account identity, client, refs, exclusivity and the live attempt/post. Wrong account/brand/claim, shared refs, missing refs, stale/used lease, silent ref swap and settled attempt fail closed. No brand-first/first-row, hardcoded, env-token, legacy-store or caller-supplied secret-ID authority was found.
- **Vault / secret boundary:** the helper sends one refresh token only to the server token request; its result to the dispatcher contains fixed codes/counters, not plaintext. The RPC is a trusted service-role surface that necessarily returns a refresh token to its server caller; this is **not** confinement against a compromised service-role key or arbitrary privileged SQL. Vault read/write errors are masked by fixed codes; optional rotated refresh updates both secrets atomically with lease release in Postgres; omitted refresh leaves it unchanged. API roles cannot execute the three RPCs or write state in the disposable ACL proof. Live service-role Vault grants and owner rights were not read back.
- **Provider semantics / external atomicity:** helper makes at most one POST to X OAuth token endpoint, manual redirect, timeout, no retries, no create/media call. Malformed 2xx, network/timeout/3xx/408/5xx are uncertain; 400 invalid_grant requires reauth; 429 is not-rotated/retryable; other 4xx are not-rotated/terminal per source policy. A DB commit failure rolls back Vault/state and is never success; failed release leaves `refreshing` and blocks provider start. X token rotation itself cannot be atomic with DB commit, so uncertain results require operator reconnection, not blind retry.
- **Concurrency / integration:** one lease per account, other-account refresh independent, provider-start/step insert blocked during lease, used/lost lease cannot commit; local multi-session proof passed. Stale pre-X attempt and account/ref mutation now fail at commit. Optional dispatcher port is used only for pre-X refresh-required identity failure; it settles for a later re-entry and does not chain a hidden X create. Provider-started resume path does not refresh. Live legacy entrypoint remains unwired/OFF.
- **Migration / ACL:** Phase1I is additive, non-idempotent, ordered after 1B→1H and wrapped in one explicit transaction; no unrelated live object is replaced. Functions are SECURITY DEFINER with empty search path and schema-qualified relations; the three RPCs are service_role-only, guard has no API EXECUTE, state is service-role SELECT-only. The `SHARE` lock requires appropriate production owner rights. No live definition/owner/GRANT, migration history or apply-tool transaction read-back was performed; those and a separate authorization are required before any production apply. The default PUBLIC EXECUTE window is closed inside the migration transaction.

## Changed files, tests and next recommendation

- PR #30 source files: `supabase/migrations/20260925150000_x_autopost_phase1i_account_refresh.sql`, `supabase/functions/x-test-post/account_refresh_migration_test.ts`, `supabase/tests/x_autopost_phase1i_behavior.sql`, `supabase/tests/x_autopost_phase1i_account_refresh.md`. Control/report sync: `.agent/tasks/CODEX_TASK.md`, `.agent/ACTIVE_TASK.md` H1 only, `.agent/CURRENT_STATE.md` H1 summary only, `.agent/CODEX_REPORT.md` appended.
- Focused Phase1I helper/static/dispatcher: **41/41 PASS** with type checking. Full `x-test-post` + `_shared`: **618/618 PASS**; `important-news-monitor`: **473/473 PASS** with `--no-check` because broad type checking reports 18 existing unrelated errors in brand/greeting/lane files. Changed Phase1I TS and dispatcher Deno check/lint: **PASS**. Greeting/tip tests are included in the 618. Disposable fake-data PostgreSQL Phase1D/1E/1F/1G/1H behavior/concurrency and Phase1I behavior/concurrency/cleanup: **PASS**. Phase1I includes the new cross-account-ref and settled-attempt regressions. Six runners `bash -n` and `git diff --check`: **PASS**. No real X or production Vault calls.
- Source commit pushed and PR #30 created; merge/deploy/production migration: **not done**. Production DB/DDL/DML/RPC, Edge, Cron, OAuth/Vault/token rotation, X post/media, gate and scheduler/claim switch mutations: **0**.
- **Next:** C1 review PR #30 and this report. Do not merge or apply from this H1 alone. Before separately approved activation, read back live schema/owner/ACL/definitions and migration history, verify client/ref readiness and apply-tool transaction behavior, finalize operator recovery/monitoring, and keep the v2 entrypoint gate OFF until reviewed. Production activation decision remains **NO**.

---

# H1 — Universal exact-account X OAuth refresh final review (2026-09-26)

- task_id: `x-universal-oauth-refresh-final-review-20260925`; status: `review_required`; next_owner: `chatgpt`; finish code: C1.
- verdict: **PASS-WITH-FIX for source candidate only**. Reviewed G3/K3 implementation `acbac42` on fresh `origin/main` `cb17d89dacc8e8c80e00b1218c6766cc55592872`; source fix head `7309805953b4e4ec9763377a0a02093065da8c82` pushed to `codex/h1-universal-refresh-review-20260926`, [PR #37](https://github.com/anohi-memories/kabumori/pull/37). PR is open/unmerged; production activation **NO**. Dedicated H1 source/control worktrees; dirty shared checkout and H2/G1–G4 files untouched.

## Findings and scope

- **P2 fixed — hidden X create redirect.** The OAuth token request and PostgREST RPCs already used `redirect: manual`, but `requestXPost` used Fetch's default redirect-follow. A 307/308 on a Vault-backed create could silently issue an additional POST, contrary to the one-intended-request boundary before any explicit 401 recovery. PR #37 supplies `redirect: manual` only for Vault-backed X writes, keeps the Kabumori legacy default unchanged, and adds a static regression. A 3xx now remains a non-2xx failure with no automatic follow/retry. No OAuth/Vault/DB logic changed.
- **Exact-account / Vault:** the legacy core derives the running unbound post's brand, requires exactly one X account and equality to the caller's account ID, and refuses missing/equal/shared Vault refs before reading plaintext. Begin snapshots post attempt, brand, X user, client, refs and account stamp; commit rechecks all under locks and writes only those refs. Phase1I uses the same state table with a distinct v2 lease kind; stale lease, settled attempt and silent ref changes fail closed. No caller-supplied secret-ID authority, brand-first fallback or generic env-token path for Vault-backed accounts. The Kabumori `oauth_token_store`/env branch was not changed.
- **Refresh / retry:** `runXTokenRefresh` has one token-endpoint POST with manual redirect and timeout, no retry. The Vault port permits one refresh per publish attempt and one retry of the same X request only after a 401, never after an accepted X write; second 401 terminates the attempt and requests reauthorization. `invalid_grant` → reauth; network/timeout/3xx/408/5xx/malformed 2xx → uncertain; omitted refresh token leaves stored refresh secret unchanged. Unknown X outcome and DB commit failure are not success or blind replay. External X rotation cannot be rolled back by Postgres.
- **Concurrency:** local fake-data proofs establish one lease per account, independent accounts and parallel commits without the previous SHARE-lock upgrade deadlock. The documented reconnect-vs-commit cycle remains possible if a reconnect transaction takes an account row lock before requesting its table write lock while a commit holds `SHARE ROW EXCLUSIVE`; Postgres aborts one transaction. This is fail-closed (no cross-account write or unacknowledged commit), but after external rotation may leave `uncertain` and require operator reconnection. Acceptable only for a supervised, one-account Stage 2 with no concurrent reconnect; monitor and stop on any deadlock/uncertain result. Stuck `refreshing` requires reviewed owner recovery, never automatic lease replay.
- **ACL / migration:** core `20260925140000` is standalone on the observed production baseline; Phase1I requires core plus 1B–1H and remains unapplied. Core is additive, single explicit transaction, preflights absent state table and required Vault/queue objects; default PUBLIC EXECUTE is revoked before commit. RPCs are SECURITY DEFINER with empty search path and service_role-only EXECUTE, state table SELECT-only for service_role. `service_role` is a trusted runtime, **not** isolated from Vault: production already grants it direct `SELECT vault.decrypted_secrets` and `EXECUTE vault.update_secret`, and this candidate does not widen or revoke those grants. Live Data API exposure and grants must be read back after Stage 1.

## Stage 0 read-back and rollout decision

- Read-only production metadata on `stock-x-autopost` (2026-09-26): AI Lab is `identity_verified`, publish enabled, `oauth_client_ref=default`, has two distinct Vault refs; shared-ref count across accounts is **0**. `social_accounts` has the expected columns, `UNIQUE(brand_id, platform)`, X-only platform and expected connection-status CHECK; no user triggers. `vault.update_secret(uuid,text,text,text,uuid)` and decrypted view exist; inspection/migration role `postgres` can execute/read. `scheduled_posts` has attempt_count/status and no `social_account_id`. Core state/RPC, Phase1I RPC and v2 attempt table are absent. Migration history ends before the core/Phase1I timestamps. Live `x-test-post` was active v120, `verify_jwt=false` at inspection. No secret value or secret UUID was read.
- Stage 0 remains **partial**: Edge runtime `X_CLIENT_ID`/`X_CLIENT_SECRET` presence, exact deploy artifact bytes, live post-apply ACL/definition and apply-tool transaction handling were not verified. Stage 1 may be planned only after C1 and separate production approval: apply **core alone**, deploy exact reviewed `x-test-post` with `X_VAULT_ACCOUNT_REFRESH` OFF, then read back function/ACL/deployed bytes and verify Kabumori unchanged. Do not apply Phase1B–1I as a batch.
- AI Lab Stage 2 controlled recovery **must not proceed now**. After successful Stage 1, explicit owner approval, confirmed client env names, and a no-concurrent-reconnect window, one natural due slot may be observed with gate on; stop on `invalid_grant`, uncertainty, deadlock or failed byte/ACL proof. Any token rotation is irreversible; rollback means gate OFF/previous Edge and possibly account reconnection, not restoring the old token. Stage 3/4 activation is out of scope.

## Verification, changes and safety

- PR #37 changed only `supabase/functions/x-test-post/index.ts` and `supabase/functions/x-test-post/account_refresh_core_migration_test.ts`; control sync changed H1 TASK, H1 index/current-state entries and appended this report. No migration or other Function changed.
- Focused core/vault/v2 static+behavior TS: **41/41** before fix; new redirect regression **9/9**. Full `x-test-post` + `_shared`: **642/642** after fix. Disposable PostgreSQL core-alone behavior/race/cleanup: **PASS**; stacked Phase1I behavior/race/cleanup: **PASS** (fake tokens only). Targeted changed-module Deno check/lint, two runner `bash -n`, `git diff --check`, and secret-pattern scan: **PASS**. `deno check index.ts` still reports **6 pre-existing** unrelated errors; `deno lint index.ts` reports **3 pre-existing** unrelated findings; none on changed lines. The live production project was queried only for metadata, constraints, ACL booleans, migration presence and non-secret account flags.
- Source push/PR: **done**; merge, migration apply, Edge deploy, OAuth refresh, Vault write, X API/media/post, Cron/settings/business-data mutation: **not done**. Production mutation: **0**.
- **Next:** C1 review PR #37 and this report. Do not treat H1 as Stage 1/2 authorization. Resolve the remaining read-back/deploy/operational gates and secure separate production approval.
