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
