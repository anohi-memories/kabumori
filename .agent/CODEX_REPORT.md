# H1 — Common-account Phase 2 service enrollment review — 2026-10-06

- task_id: common-account-v1-phase2-service-enrollment-review-20261006
- status: Pending.
- target_pr: 95
- target_head: c06fac6492708331b6ba816122c9852cdcea73e7
- recommended_model: Sol（高）

---

# Previous H1 report history — preserved

# H1 — PR #95 Phase 2 service-enrollment security review — 2026-10-06

- task_id: `common-account-v1-phase2-service-enrollment-review-20261006`
- result / verdict: **CHANGES REQUIRED**. Source-only review; do not merge/deploy this candidate.
- status: `review_required`; next_owner: `chatgpt` (STOP for C1).
- target: [PR #95](https://github.com/anohi-memories/kabumori/pull/95), exact head `c06fac6492708331b6ba816122c9852cdcea73e7`. Head unchanged at final fresh fetch; GitHub read-back OPEN/unmerged. GitHub mergeability was `unknown`, not claimed clean.
- Fresh main: startup `4756c5015bd55a1ae9612f40a33fed2ddca4a3c4`, final review `f69527897597ccb82439622860ac41651aa7abc2`. Main's changed-file overlap with PR95's 11 product files: 0.
- changed_files (H1): **only** `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md`. Product-source edits: **0**. No other slot/control index rewritten.
- commit_hash: reviewed source `c06fac6492708331b6ba816122c9852cdcea73e7`; no H1 product commit. Control sync SHA is the commit introducing this section, to be verified by GitHub read-back and reported in the final response.
- push: no source push. Only H1 TASK/Report synchronization to main; completion must be verified from remote, not assumed from a local commit.
- merge / deploy / production access / production mutation / EAS / Auth / Storage / OAuth / Vault / Cron / X API: **0**.

## Blocking findings

### R1 — P1: automatic start can silently reactivate a service ended after the read

Locations: `src/lib/service-enrollment.ts:72-80` and identical `apps/social-mobile/src/domain/service-enrollment.ts:72-80`; canonical server contract `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql:818-840` (unchanged by PR95).

The client only declines automatic enrollment if its earlier SELECT observed `ended`. When it observed active/missing, it unconditionally invokes the no-argument start RPC. The RPC locks the current entitlement and **reactivates ended** without distinguishing automatic bootstrap from explicit re-enrollment. The lock protects row consistency, not user intent.

Independent PostgreSQL 17.11 proof, exact foundation + production-shaped repository fixtures, autocommit interleaving:

1. Authenticated fake user starts Kabumori and SELECT observes active.
2. Backend `withdraw_kabumori_service(user)` completes and returns ended; entitlement is ended, profile removed.
3. The stale automatic client invokes `start_kabumori_service()` with no new user action.
4. It returns `{status:active, service:kabumori, started:true}`; entitlement is active and profile is recreated.
5. X reproduces the same active -> backend begin/finish-service-deletion -> ended -> stale `start_x_autopost_service()` -> active sequence, without creating a workspace.

No arbitrary status UPDATE was used to simulate withdrawal. These are real candidate lifecycle functions in a dedicated local fixture, not evidence of a production incident. The TASK explicitly requires safety for Phase3 lifecycle states: G5's documented “no ended-producing route today” does not discharge this gate.

Minimum correction: automatic bootstrap must refuse ended **inside the same server lifecycle transaction/lock**; explicit reactivation must be distinguishable and tied to the current user/session/action (and stale action/version invalidation where necessary). A second client SELECT alone cannot close this TOCTOU window. Any server-contract/source-candidate change must be separately scoped by ChatGPT/G5; H1 did not edit/apply a migration.

### R2 — P1: X re-enrollment intent is reused after changing users

Location: `apps/social-mobile/src/features/service-enrollment/service-enrollment-gate.tsx:48-67,74-78`.

`attempt.reenroll` stays true after the click; changing `userId` reruns the effect and calls `enrollment.reenroll(newUserId)`. The outcome is tagged by user, but the consent is not. The existing X AuthProvider can replace A with B without unmounting this gate (`onAuthStateChange` sets the next session and loading=false).

Executed the actual transpiled TSX with a hook/effect dependency+cleanup harness and fake RLS/RPC client: A and B both ended; switching without a click caused no writes (control); A clicked “利用登録する”, producing write A; switching to B with no B click produced **write B**. Expected only A. The harness replaces rendering/native APIs, not the component's effect/attempt code; this is not device E2E.

Minimum correction: one-use re-enrollment intent pinned to the exact initiating user/session/request generation; consume it and invalidate it on user/session change, sign-out, recovery and cancellation. Tagging only the returned view is insufficient. Add a mounted-gate A-click -> B-switch regression.

### R3 — P2: Kabumori retry enables Push hooks before enrollment succeeds

Location: `src/app/_layout.tsx:59-63`; producer `src/providers/auth-provider.tsx:141-155`.

Retry/re-enroll clears `serviceAccess` and `profileError`, retains session and sets loading=true. `serviceSession` tests only the absence of errors, not loading or positively verified current-session enrollment. Before the new result, both Push hooks receive that session. The registration hook can request permissions/upsert a token and notification navigation can consume a pending tap even if enrollment is rejected again.

Actual AuthProvider -> AuthGate TSX harness: begin with `SERVICE_NOT_READY`, click retry, keep preparation pending. Provider emits `{session:A, loading:true, serviceAccess:null, profileError:null}`; both hooks receive **A**, expected null. The signed-in UI itself remains a spinner; this finding concerns side effects, not a falsely claimed rendered-app bypass.

Minimum correction: gate effects on positive ready for the **current** session/generation and `!loading` (also preserve recovery ordering), not merely “no error yet.” Add rejected -> pending retry -> rejected tests proving no token or routing side effects.

### R4 — P1: an obsolete A request can issue the start RPC using B's current credential

Locations: `src/lib/auth.ts:18-35`, `src/lib/service-enrollment.ts:103-125`; same singleton client pattern in X gate `:22-29` and duplicate domain gate.

`ensure(userId)` only tags the cache; the run does not receive/pin that user/session. `reset()` forgets a promise but does not invalidate its pending read/start chain. Supabase obtains its **current** access token when each request is dispatched. After the A SELECT waits across sign-out/user switch, the A continuation can dispatch the start RPC authenticated as B. Provider/effect generation guards prevent rendering stale results, not the already-issued mutation.

Independent test with actual installed supabase-js **2.115.0**, actual `enrollService/createEnrollmentGate`, synthetic A/B sessions, and fully intercepted fetch: delay A's entitlement SELECT; reset; set SDK session B; release A's read. Captured RPC subject is **B** (expected no RPC from the invalidated request). No real credentials/network were used. RLS still binds the write to B; this is unintended enrollment/possible reactivation of B, not arbitrary cross-user SQL access.

Minimum correction: bind enrollment run, response and credential to immutable current user/session context; invalidate/cancel stale operations before dispatch and scope single-flight accordingly. Ensure the RPC cannot inherit a changed singleton credential. Add delayed SELECT + switch/sign-out + pending explicit re-enrollment regressions for both clients; UI stale-completion suppression alone does not fix it.

### R5 — P2: incomplete active RPC payload is treated as ready

Locations: `src/lib/service-enrollment.ts:85-88` and duplicate X domain.

The canonical active response always includes boolean `started`; the client converts every missing/wrong value into false. Actual domain probe with `{status:'active', service:'kabumori'}` (no started) returns ready. This fails the TASK's explicit requirement that malformed responses never open the gate. This is a boundary-validation defect, not a claim that the reviewed SQL currently produces such payloads.

Minimum correction: structurally validate the full active response, including `typeof started === 'boolean'`, and fail closed otherwise. Cover missing/null/string/number started and wrong service for both apps.

## Other review dispositions

- **Canonical RPC/grants/RLS:** source inspection and local fixture confirm only no-argument service-specific public RPCs, auth.uid() identity, SECURITY DEFINER empty search_path and authenticated-only EXECUTE. No direct client common-account INSERT/UPDATE or email-based merge/inference was introduced. Kabumori profile is created atomically by start; no active bootstrap `ensure_my_profile` fallback remains.
- **Lifecycle states:** known account locked/deleting and service deleting/suspended/provisioning/invalid-login fail closed in canonical responses. Normal active idempotence, missing service-only addition and explicit static-ended UI are covered and pass. Atomic ended intent safety fails R1, cross-user consent R2/R4, malformed contract R5.
- **Session concurrency:** same-user concurrent promises share a run; transient exceptions clear current cache, and decided outcomes are user-tagged. Generation/cancelled guards avoid accepting many stale UI results. They do not pin session/credential or cancel mutations (R2/R4); therefore this review gate fails.
- **Kabumori UI:** rejected/error screens and logout are present, signed-in navigator waits on loading/decision, no profile-only shortcut. Push/notification effect gate fails R3. Recovery screen ordering remains before application UI; no native recovery E2E claim.
- **X/OAuth separation:** ServiceEnrollmentGate is inside auth/recovery routing and outside DataProvider/OnboardingGate. Enrollment only reads entitlement and starts `x_autopost`; it creates no workspace/social-account/OAuth state/credential/publish enablement. X connection remains explicit; no posting authorization was expanded. Logout and account-deletion help remain reachable without loading workspace data. Explicit mock selection/invalid-config fail-closed logic and provider-token stripping are unchanged. Enrollment consent/mutation safety still fails R2/R4.

## PR94 compatibility / freshness

- PR94 advanced from `64c71bd6a49c6d1f65cb84642b3f68f60ef9648a` to final `97d374b48886ad33b61cd2288188d4b690e27a5c` during review; delta was three 375pt review images, no product source delta.
- Product overlap: only `src/app/_layout.tsx`. PR94 adds root `news-detail` registration in SignedInNavigator; PR95 changes the separate AuthGate enrollment hunk.
- Both `git merge-tree --write-tree PR94 PR95` and reverse order succeed with the **same tree** `00ab532dd8565c330d070bab369d622d45996ffe`.
- Archived that combined tree into a separate temporary directory; **392/392 Kabumori App tests passed**, preserving PR94 root-detail/native-intent/swipe source contracts and PR95 gates (including the still-present R3 defect). This is source/behavior compatibility, not native visual/swipe E2E.
- Neither PR was merged/modified. PR94 remains OPEN/unmerged at API read-back. PR94 was moving: do not blind-merge. After fixing PR95 and C1 acceptance, rebase against then-current main/PR94 merge state, refetch both heads and rerun overlap + combined tests. PR95 is **not merge-ready** due to R1–R5 regardless of textual compatibility.

## Independent tests / builds

- Exact PR95: `deno test --no-check --no-config --allow-read tests/app/` — **352 passed / 0 failed**.
- X `npm test --prefix apps/social-mobile` — **157 passed / 0 failed**. Initial missing dependency-loader failures were resolved using read-only symlinks in the isolated H1 directory to existing dependency installations; no dependency source or shared worktree changed.
- X `npm run typecheck` and `npm run lint` — **PASS**.
- Kabumori app-only `tsc --noEmit` (temporary config includes src + expo-env, excludes unrelated Deno functions) — **two pre-existing unchanged CSS-resolution diagnostics**: `src/components/animated-icon.web.tsx:5` (`animated-icon.module.css`) and `src/constants/theme.ts:6` (`@/global.css`). No PR95 changed-file diagnostic; do not report full repository typecheck as clean.
- Both `expo export --platform web` — **PASS**, dummy public config, output only in H1 temporary directory. No deployment/EAS/native build.
- Exact foundation `common_account_lifecycle_run.sh` on dedicated local Unix-socket PostgreSQL17.11/non-superuser fixture owner — **20 PASS markers**, including behavior, both commit orders, lock order/no-deadlock, additive/preflight/rollback and cleanup.
- Additional actual lifecycle ended interleavings for both services — **unsafe behavior reproduced** (R1); not included in ordinary runner's passing assertions.
- Additional local actual-logic/TSX/SDK adversarial assertions — **0 passed / 4 failed**, corresponding exactly to R2–R5 expected-safe properties; these are reviewer-added probes outside the product tree, not four failures in G5's shipped suite. Tests can all be rerun via `node --test` on the artifact below.
- Combined PR94/95 App tests — **392 passed / 0 failed**.
- `git diff --check` — **PASS**. Changed-file secret-pattern scan for secret keys/private keys/GitHub tokens/JWT literals — **0 matches**; no secret values printed. Scan is not a blanket security assurance.

Local evidence (temporary, not committed product changes): `/private/tmp/kabumori-h1-pr95-review-20261006.xvKugu/` contains `adversarial.mjs`, `adversarial.log`, `ended-proof.sql`, `ended-proof.log`, `lifecycle-proof.log`, `combined-tests.log`, app export logs and app-only tsc log. Reproduction descriptions above remain self-contained if temp files expire. No simulator/device E2E was performed; this TASK is source-only.

## Safety / remaining issues / next recommendation

- Independent detached exact-head source and own control branch from `/Users/yuya/Developer/kabumori-fresh`; no shared checkout, no other slot's files/staging/server changed. Reviewer probes/exports/fixtures remained temporary. The dedicated fake-data DB was dropped and the dedicated PostgreSQL server stopped after proof.
- Supabase and Postgres-best-practices skills informed the current-session credential checks, privilege inspection and atomic lifecycle/lock review; production access was not required.
- Remaining blockers: **R1–R5**. No H1 product repair, new migration, RPC change or Phase3 broadening was attempted.
- **Next recommendation:** C1 / ChatGPT accept this review result and return focused corrections to G5. Recommended model for C1 and exact-head re-review: **Sol（高）**. Server intent-contract correction requires a clearly scoped source-candidate task, not production apply permission. After fixes, re-review both clients + canonical RPC together with pending-read/user-switch/ended-race/effect tests; refresh PR94 compatibility again.
- **STOP for C1**; no PR95 merge/deploy recommendation until corrected head passes. Production rollout/enforcement remains a separate approval gate.

---

# H1 — PR #87 editorial “今日のポイント3点” review — 2026-10-06

- task_id: `kabumori-pr87-editorial-three-points-review-20261006`
- verdict: **PASS** for exact PR #87 head `3561f1eaac41df0f23dcce8fdaace0decc654a0a`.
- GitHub read-back before verdict: PR OPEN, unmerged, `mergeable=true`, `mergeable_state=clean`; PR head unchanged.
- Fresh `origin/main`: `e303d81e940d413ed62ec93885b09063b3661aee`; it is 44 commits beyond merge-base `a775ec8d4447bf0c84b12f6dedbd74e89be1a1c2`. Changed-file overlap with the PR's 13 files: **0**.
- H1 product source changes: **0**. Production mutation/deploy/manual invocation/consumer activation/DB/Auth/Vault/X changes: **0**.

## Review findings

- **A — Editorial contract: PASS.** Morning instructions steer the three points toward today's focus, risks and watch axes; close instructions distinguish what happened, supported material/significance and the next watch. The exactly-three validation remains a hard requirement. The new metric-recap and near-duplicate detectors are narrow warning telemetry; the prompt adds no hard-coded sector or theme claim.
- **B — Factual/causal safety: PASS.** `MARKET_NAMES` is exported for reuse; no Hard Fact decision logic was changed. Existing date/session, value/sign, stale-data, 1306 identity, reference, unsupported-causality and false-absence checks remain in the analysis path. The close causal and morning watch regressions pass.
- **C — Delivery/model calls: PASS.** The new `X_POINTS_*` warnings are explicitly cosmetic and `qualityRewriteHints` does not turn them into a rewrite. No additional generation/fact call or retry was added; existing bounded delivery and safe-original behavior remains covered by regression tests.
- **D — X/App shared truth: PASS.** X formatting consumes `x_post.points_ja`; presentation-v2 `market_detail.points_ja` copies those same values. The home card prefers shared points, while older/v1 data with no shared points keeps the pre-existing today-claims/checkpoints fallback. Type additions are optional/additive; no second App analysis path was introduced.
- **E — Regression verification: PASS.** Focused/full runs: market-report-analysis **147/147**, personalized-reports **129/129**, X shared consumer **8/8**, App home highlights **17/17**, market-report-data-packet **42/42**. Deno check passed on changed runtime modules; Deno lint passed on the nine changed runtime/test files selected. `git diff --check` passed.

## Caveats / recommendation

- A broader lint invocation including `analysis_test.ts` reports the existing `require-await` at line 34. `git blame origin/main` confirms that line predates this PR and it is unchanged by PR #87; this is not a new blocker.
- Deno's default type-checked invocation of the App test cannot resolve the Expo `@/` TypeScript path alias; the App behavior suite passes with `--no-check`. Server-side changed runtime modules pass typed `deno check`.
- **Merge recommendation:** PASS after C1 acceptance. **Deploy recommendation:** no deploy in this H1; keep production rollout and natural morning/close observation as a separate controlled gate.
- Remaining review blockers: none found. C1 / ChatGPT is the next owner. PR #87 remains unmerged; H1 did not alter its source.

---

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

---

# H1 — PR #33 Web Admin password recovery/invite final Auth review (2026-09-26)

- task_id: `x-admin-pr33-final-auth-security-review-20260926`; status: `review_required`; next_owner: `chatgpt`; finish code: C1.
- verdict: **FAIL — do not merge PR #33 at this head.** Reviewed exact PR head `e6b93beccfb9209dbe640fb9ea1464f2568f3c74` against fresh `origin/main` (`5d4bcb5` initially, `befb39c` at report sync). PR remains OPEN/MERGEABLE; Netlify deploy-preview check SUCCESS, Vercel check FAILURE (build-rate limit). No source fix or PR push was made. Separate H1 read-only worktree was used; the dirty shared checkout and other slots were not changed.

## Findings

1. **P1 — wrong authentication method admitted for reset.** `hasRecoveryContext()` permits `otp` and `magiclink` in addition to `recovery`/`invite` (`apps/admin/src/lib/password-recovery.ts:47-52,177-185`). Supabase's JWT claims reference explicitly distinguishes recovery, invite, OTP and magic-link AMR values. Generic OTP can originate from phone verification, and a generic magic-link session is not proof that a recovery/invite link was used. A signed, recent `otp` or `magiclink` claim causes the reset form to render; the existing test positively asserts both. Local reproduction returned `true` for each. The PKCE callback also accepts any syntactically valid code without a recovery/invite type and relies on this broad AMR check. Restrict the reset authority to the exact documented recovery/invite AMR values, or establish another independently verified link-purpose binding. If production Auth emits another method for an actual recovery/invite link, fail closed and require bounded real E2E before changing the allowlist; do not loosen to all OTP/magic-link sessions.
2. **P2 — 15-minute limit is checked only when rendering.** `reset-password/page.tsx` reads the JWT once, passes `recoveryContext: true` to the client, and `completePasswordReset()` trusts that boolean on submit (`apps/admin/src/lib/password-recovery.ts:235-245`; `reset-password/reset-password-form.tsx:30-39`). Leaving the form open past 15 minutes still calls `updateUser`. Local fake-client reproduction after the render-time window returned `updated` and called `updateUser` then `signOut`. Recheck verified claims, AMR, and the current clock immediately before update, and add a stale-open-form regression. The 15-minute rule is currently a UI promise, not a server-enforced Auth policy.
3. **P2 — sign-out failure is reported as a completed reset.** `completePasswordReset()` ignores the `signOut()` error result and catches thrown errors before returning `updated` (`password-recovery.ts:250-257`); the existing test even expects success when sign-out throws. Supabase Auth normally clears the local session for many API failures, but a thrown storage/session failure can leave it active. Do not claim the user has been signed out without verifying that outcome; provide a safe retry/failure state and regression for returned and thrown failures.

## Boundary assessment and verification

- **AMR/session:** ordinary password-only AMR fails the current form-render gate; malformed/stale AMR fails at render. The three findings above mean the claimed recovery-only and expiry/sign-out semantics do not hold. Actual production recovery/invite JWT claim shape, cookie exchange, and browser sign-out were **not** exercised with a real email link; real E2E is required before merge after source fixes. No real reset/invite email was sent.
- **Redirect/URL:** callback chooses fixed relative paths with own query strings; user `next`/`redirect_to` is ignored. Read-only Netlify Preview probe of `/auth/confirm?next=https%3A%2F%2Fexample.com` returned `307 Location: /reset-password?from=email-link`, not an external redirect. The callback's code/token_hash is not copied to that Location. The implicit fragment is removed before the explicit `setSession` call. PKCE and token_hash links are still sensitive credentials in the inbound URL/request; production proxy/log and Auth redirect allowlist settings were not inspected or changed.
- **Enumeration/credentials:** UI maps all Supabase reset responses to the same generic sent message; [Supabase password documentation](https://supabase.com/docs/guides/auth/passwords) says `resetPasswordForEmail()` does not reveal account existence. No password is placed in a form GET or URL; changed source has no credential logging, service-role key, or Auth body rendering. A targeted changed-file scan and `git diff --check` passed.
- **Admin/brand:** public reset/invite pages do not query `admin_users` or grant Admin. Protected `(admin)/layout.tsx` still calls `getUser()`, requires an `admin_users` row, then resolves allowed brands. Non-admin Admin-entry denial and PR #15 brand-isolation structural/query tests passed. This is source/test evidence, not a real non-admin production E2E.
- **Checks:** `apps/admin/src/lib/*.test.ts` **73/73 PASS**, including recovery/invite, redirect/session and admin/brand tests; TypeScript `tsc --noEmit` PASS; ESLint PASS; production `next build` PASS with dummy public Supabase configuration; `git diff --check` PASS. Initial build with a cross-worktree `node_modules` symlink failed only because Turbopack rejects out-of-root symlinks; isolated offline `npm ci` then build passed. Generated `next-env.d.ts` was restored; review source worktree is clean. Production mutation **0**.

## Recommendation / operator gates

- Return PR #33 to G4 for narrowly scoped source/test fixes of all three findings; C1 should not approve merge at `e6b93be`. Re-review the new head, including malicious callback types, stale-open-form, OTP/magic-link and sign-out failure cases.
- Before merge, perform one bounded real recovery and invite flow on a disposable or expressly approved account/Preview to verify actual AMR methods, PKCE/implicit cookie establishment and logout. This review did not authorize sending email or changing users. Operator must separately confirm exact Supabase Auth Site/Redirect allowlist, template URLs, SMTP deliverability and Netlify proxy/log credential handling. Production Auth/config/user changes and deploy/merge remain unapproved.

---

# H1 — PR #33 Auth-fix round 2 final source review (2026-09-26)

- task_id: `x-admin-pr33-auth-fix-round2-final-review-20260926`; status: `review_required`; next_owner: `chatgpt`; finish code: C1.
- verdict: **PASS for source readiness to bounded real E2E; not approval to merge.** Exact reviewed PR #33 head: `2528b5686bcbb3630fb636cec12162803f921f8f`; prior failed head: `e6b93beccfb9209dbe640fb9ea1464f2568f3c74`. PR was OPEN/MERGEABLE at review; Netlify Preview SUCCESS at exact head; Vercel context FAILURE from build-rate limit. No source edits or PR push by H1. Latest `origin/main` at report preparation: `5e6f0cef9d1ad9047868076391fc514903b1ab51`.

## Three C1 findings

1. **AMR purpose — fixed.** `hasRecoveryContext()` now accepts only signed, fresh `recovery` or `invite` AMR entries. Password, generic `otp`, `magiclink` and other methods fail closed at render and submission; negative tests cover both. The Supabase [JWT claims reference](https://supabase.com/docs/guides/auth/jwt-fields) defines recovery/invite separately from OTP/magic-link. Actual production Auth AMR shape still requires a bounded real link test; if it differs, do not broaden to all OTP/magic-link sessions.
2. **15-minute freshness — fixed at source/UI boundary.** `reset-password/page.tsx` checks on render; `completePasswordReset()` calls the new `verifyRecoveryContext` Server Action after local validation and immediately before `updateUser`. The action uses `getClaims()` and server time; false/thrown checks fail closed without an update. A stale-open-form regression passes. This is an app flow gate, not a claim that the public Supabase Auth `updateUser` API enforces the same 15-minute rule for arbitrary custom clients.
3. **Sign-out failure — fixed.** `signOutConfirmed()` returns true only for a successful `signOut` response. Returned and thrown failures produce `updated_signout_unconfirmed`; the UI clears entered passwords, explains that the session may remain, and offers retry without redirecting to a confirmed-success login. Tests cover both failure types and the retry navigation boundary.

## Regression and safety checks

- Round-2 source diff is only six `apps/admin/src` files; no mobile reset file or other app area changed. Callback and forgot-password routing were unchanged from the prior reviewed head. Netlify Preview read-only probes returned `307 Location: /reset-password?from=email-link` for an external `next` and `307 Location: /forgot-password?reason=link_invalid` for unsupported `type=signup`. No open redirect or callback-type regression observed.
- Generic reset-request UI remains indistinguishable across account existence outcomes. New Server Action takes no password/token arguments, reads only signed session claims, uses no service-role key, and logs no credential. Targeted changed-source secret-value scan found no secret markers. No Auth response body is rendered.
- `(admin)/layout.tsx` still requires `getUser()` and an `admin_users` row before brand resolution. Non-admin entry denial and PR #15 multibrand isolation tests passed. This is source/test verification, not a real non-admin production E2E.
- Tests: all `apps/admin/src/lib/*.test.ts` **83/83 PASS** (recovery/invite, OTP/magic-link negatives, stale-open-form, sign-out returned/thrown errors, Admin/brand boundaries); `tsc --noEmit` PASS; ESLint PASS; production `next build` PASS with dummy public Supabase configuration; `git diff --check` PASS. Build-generated `next-env.d.ts` was restored, leaving the H1 review worktree clean. Dependencies were installed offline in this worktree only.
- Changed files by H1: `.agent/tasks/CODEX_TASK.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, `.agent/CODEX_REPORT.md` (control/report only). Source commit by H1: none; reviewed commit hash above. PR push: none; merge: none; deploy: none. Production Auth/config/user, DB/RLS/RPC/migration, Edge, X/OAuth, and other business-data mutation: **0**.

## Gate before merge

After C1 accepts this source review, run **one bounded real recovery flow and one invite flow** on an expressly approved/disposable account and Preview. Verify actual `amr.method` without logging token values, 15-minute clock semantics, PKCE/token-hash or implicit-fragment cookie establishment, password update, sign-out and non-admin Admin denial. No real email was sent in this review, and no production Auth/user/config mutation was authorized. Operator must separately verify Supabase Site/Redirect allowlist, email templates/SMTP and Netlify proxy/log handling of inbound link credentials. Do not merge or production-deploy PR #33 until these gates are satisfied and reported.

---

# H1 — Stage 3A universal X refresh rollout final security review (2026-09-26)

- task_id: `x-oauth-refresh-stage3a-final-security-review-20260926`; status: `review_required`; next_owner: `chatgpt`; finish code: C1.
- verdict: **PASS-WITH-FIX for source readiness to a separately authorized production-apply TASK**, not approval to apply, deploy or activate. Reviewed exact [PR #38](https://github.com/anohi-memories/kabumori/pull/38) head `050d62f57971c9d88420da993e9f839929d7197e`; fixed head `748deb1` was fast-forward pushed to its existing branch. PR remains unmerged. Fresh `origin/main` before report: `38a8e588b835ba78b7cf0e00aab354b4ca5e9bc7`. Independent H1 review/control worktrees were used; the dirty shared checkout and other slots were untouched.

## Finding and fix

- **P2 fixed — unexpected proactive refresh-start failure could still send an X write.** Original `VaultAccountXAuth.#refresh` silently returned on *every* `not_started` outcome during proactive refresh, including `X_REFRESH_UNAVAILABLE` and `X_CLAIM_ACCOUNT_MISMATCH`. With a near-expiry but still accepted access token, the same publish attempt could then issue a successful X create despite a database/authority failure. A new fake-X regression failed on original head (`Missing expected rejection`) and passed after the fix. Only the explicitly expected rollout refusals and `X_REFRESH_IN_PROGRESS` may retain the still-valid credential; all other start failures stop before the X request with a fixed code. The existing rollout-off/pilot and one-refresh/401 behavior still passes. Changed source: `supabase/functions/x-test-post/vault_account_auth.ts`, `vault_account_auth_test.ts`. No DB/migration change was needed.

## Boundary assessment

- **Per-account authority / modes:** no rollout row and `off` refuse refresh; `pilot` has a bounded expiry, generation ceiling and unresolved-error block; `enabled` permits only an otherwise healthy exact X account. The global Edge flag is only a kill switch, not an account grant. Both legacy and future Phase1I begin call the same predicate before reading Vault. The predicate checks verified identity, publish-enabled, client ref, present/distinct/unshared own Vault refs and refresh-state blocks; it selects the rollout row by exact `social_account_id`. Disposable tests counted Vault reads through a non-transactional sequence and proved zero reads for missing/off/disabled cases, plus A-enabled/B-off isolation.
- **ACL/owner:** the new rollout table has RLS, service_role SELECT only and no API-role write grant. SECURITY DEFINER functions have empty `search_path`; the setter and health RPC are service_role EXECUTE only; authority and stale-lease resolver have no API-role EXECUTE. The default PUBLIC grant window is closed before the single migration transaction commits. Disposable role-based ACL tests passed. Production read-only metadata confirmed the *existing* legacy begin is owned by `postgres`, is SECURITY DEFINER with empty search_path, and has service_role EXECUTE but not anon/authenticated EXECUTE. New function owner/ACL/read-back still require post-apply verification.
- **Grandfather / observability:** SQL enables only X accounts with `generation > 0`, idle state, no last refresh error and verified identity; disposable seed grandfathered only its proven account. A read-only production preflight found exactly one eligible account, the expected AI Lab account. This is a data-driven one-time insert, not a hardcoded identity; the operator must recheck that exact eligible set immediately before apply and stop if it changes. The health RPC exposes status, generation, timestamps, boolean credential-ref readiness and fixed errors, but no access/refresh token, secret UUID, lease token or provider body. Stale lease resolution is owner-only and sets `uncertain`, never `idle`.
- **Failure/race:** existing core and new stacked tests cover `invalid_grant` → exact-account `reauth_required`/failed connection, blocked publish until reconnect, one lease per account, and reconnect-versus-commit safety. The local race can resolve by aborting reconnect or blocking/marking the lease; it never demonstrates a cross-account secret write. An external token rotation cannot be rolled back by the DB: uncertain and stale cases still require operator reconciliation, never blind retry. Kabumori's legacy token store/path is unchanged and its account lacks the Stage 3A Vault-ref eligibility.
- **Live replacement / migration history:** a static test proves Stage 3A's `CREATE OR REPLACE begin_x_account_refresh_legacy_post` matches the source core body apart from the pre-Vault authority call. Production read-only metadata shows the core exists but Stage 3A does not; core migration version `20260925140000` and Stage 3A version `20260926032054` are not recorded in remote migration history. The Stage 3A file preflights the live core and refuses a second apply; it does not replay the core migration. Installed CLI v2.116.0 documents `supabase db query --linked --file` syntax, but execution and transaction behavior must be validated in a separately approved apply procedure. **No `db push`, `--include-all`, migration repair or historical batch apply.** Migration-history normalization is a distinct future approval, not a prerequisite mutation performed here.

## Verification and remaining gate

- Disposable fake-data PostgreSQL: Stage 3A behavior/ACL, grandfather, rollout isolation, pilot, stale-lease, one-lease and reconnect/commit race **PASS**; Phase1I stacked behavior/race **PASS**; both runners cleaned up their test databases. X `x-test-post` + `_shared` Deno suite after fix: **655 passed, 0 failed**. Targeted changed-TS `deno check --no-config --no-lock`, `deno lint`, runner `bash -n`, `git diff --check` and changed-diff secret-pattern scan: **PASS**. Repository-configured `deno check` cannot resolve missing local `npm:@types/node` in this isolated worktree; the same changed files type-check with `--no-config` and execute. No real X token request, post or media upload was made.
- Production read-only: core/Stage 3A object presence, current begin owner/ACL/hash, eligible grandfather count and migration list were checked. Security-advisor output has pre-existing project findings outside this candidate; it is a baseline, not a post-apply clean bill. No token values, secret identifiers or credentials were read or reported.
- changed_files by H1: `supabase/functions/x-test-post/vault_account_auth.ts`, `supabase/functions/x-test-post/vault_account_auth_test.ts`; control sync: `.agent/tasks/CODEX_TASK.md`, `.agent/ACTIVE_TASK.md` H1 only, `.agent/CURRENT_STATE.md` H1 summary only, `.agent/CODEX_REPORT.md` appended. Source commit/push: `748deb1` / done to PR #38. Report-sync commit/push: recorded separately after sync. Merge/deploy/migration apply/Edge/env/Vault/OAuth/Cron/X mutation: **none**; `production_mutation=0`.
- **Next recommendation:** C1 review the fixed PR #38 head and this report. Source is ready to *plan* a narrow production-apply TASK, not to execute it. That TASK must obtain separate explicit authorization, recheck live core definition/owner/grants and exact grandfather candidate set, apply only `20260926032054` transactionally, read back function definitions/EXECUTE/table grants and rollout rows, and stop on any unexpected delta. A later Edge deploy/refresh observation needs its own gate; do not enable another account through the global flag alone.

---

# H1 — Stage 3B second-account pilot final review (2026-09-27)

- task_id: `x-stage3b-second-account-pilot-final-review-20260927`; status: `review_required`; next_owner: `chatgpt`; finish code: C1.
- verdict: **FAIL — PR #41 is not ready for a production pilot or merge as reviewed.** Exact reviewed [PR #41](https://github.com/anohi-memories/kabumori/pull/41) head `cd7adf5d1eb5a91773f21c7d8959766e1dd38229` remained unchanged at the final fetch. The eight PR files were inspected in an independent H1 worktree. No source fix, commit or PR push was made: the primary finding requires G3/product policy design, per the H1 TASK's stop rule. The dirty shared checkout and other slots were untouched.

## Blocking findings

1. **P1, design-level — the proposed seven-day pilot is not a seven-day publishing gate.** Stage 3A `off`, pilot expiry, generation ceiling and unresolved-error checks gate **refresh begin**, not the initial access-token read or X create. Its existing disposable test explicitly proves that an `off` account can still read its token for posting, and the Edge test proves an `off` account with a still-valid token can receive X success without refreshing. The new `dispatchVaultAccountScheduledBrandPost` checks profile, brand/account, admin enablement and `approvalMode`, but never checks rollout state adjacent to `publishText`. Once the Stage 3B activation plan leaves brand/account live and consent enabled, a valid token can therefore publish after pilot expiry or after the refresh budget is exhausted. The rollback plan first sets rollout `off`; if subsequent brand/account disablement is delayed or fails, that step alone also does **not** stop posting. This conflicts with the plan's owner consent for a bounded pilot window. G3/owner must decide and implement an explicit **publish** authority/timebox (separate from Stage 3A's refresh authority) and define fail-closed revocation/rollback behavior before pilot approval. Do not reinterpret the existing Stage 3A refresh mode silently as a publish gate for AI Lab.
2. **P2 — the generic completion RPC admits AI Lab's own row.** `complete_vault_account_brand_post` excludes Kabumori but not `ai_salaryman_lab`. With an AI Lab running `brand_post` row and `ai_salaryman_lab_x`, the new service_role RPC marks that AI Lab row succeeded and writes a fingerprint/log, bypassing the intended AI Lab-specific completion RPC. The original disposable test checked only a **wrong** account on the AI Lab row, missing the matching-account case. A review-only regression requiring `VAULT_BRAND_POST_NOT_FOUND` for that exact matching pair failed on original PR head (`EXPECTED_ERROR_NOT_RAISED`); a local explicit AI Lab exclusion made the full disposable suite pass, then was reverted because finding 1 requires a G3 design return. G3 should retain the regression and exclude AI Lab in the migration; this was **not** pushed or applied.

## Verified boundaries and residual gates

- **Exact account / ACL:** In the intended new Edge route, the running post's brand context and Vault credential reader bind the post to the brand's X account before generation; wrong account/brand, missing refs, disabled brand/account and absent/manual-review content settings fail in the tested paths. The Stage 3B RPC is SECURITY DEFINER with empty search_path, qualified tables, service_role-only EXECUTE and an explicit transaction; disposable anon/authenticated ACL checks pass. Cross-account completion/lease/commit/release and Kabumori completion are refused. The missing AI Lab exclusion above is an exception to the intended routing boundary, not an anon privilege leak.
- **Refresh/race:** Stage 3A off/pilot/expiry/error/ceiling checks prevent Vault refresh reads, and the two-account disposable race shows one lease per account and one claim for one due row. `invalid_grant`/`uncertain` affect only the target account in the tested core path. These refresh protections do not resolve the publish-timebox finding. The claim-race proof uses a simplified copy of the live claim step, not a full live scheduler E2E.
- **Production baseline, read-only:** Stage 3A rollout exists; Stage 3B RPC and `social_mobile_content_settings` do not. The proposed second account remains `publish_enabled=false`, brand inactive/disabled, rollout `off`, no refresh state, no brand settings, windows or scheduled posts. AI Lab remains enabled; Kabumori remains on its legacy path. The completion target columns/index exist, but Stage 3B has not been applied. No secret value or secret identifier was read. The owner has not supplied pilot consent in this H1 review, and the content-settings candidate migration needs a separate product/security review and authorization.
- **Migration history / activation:** The live Stage 3A objects are not represented by their local migration version in remote history; Stage 3B and the content-settings candidate are also local-only/unapplied. An exact isolated apply/read-back plan can be prepared later, but no `db push`, blanket repair or historical replay is safe. The proposed pilot plan must be revised so expiry, revocation and partial rollback reliably stop **new X posts**, not just refreshes. Owner consent/product gate remains separate from technical readiness.

## Verification, changes and disposition

- Focused Deno tests: **41 passed**. Full `x-test-post` + `_shared` suite on untouched PR source: **668 passed, 0 failed** with `--no-check`; ordinary full type checking reports 18 pre-existing unrelated errors in brand/greeting/lane tests. Changed TS `deno check --no-config`, `deno lint`, runner `bash -n` and `git diff --check`: **PASS**. Disposable PostgreSQL Stage 3B behavior/ACL/races/cleanup and Stage 3A behavior/race/cleanup: **PASS**. The red matching-AI-Lab completion regression is separately documented above; review-only local edits were reverted, leaving the PR worktree clean. No real X call, refresh or post was made.
- changed_files by H1: `.agent/tasks/CODEX_TASK.md`, `.agent/ACTIVE_TASK.md` H1 line, `.agent/CURRENT_STATE.md` H1 summary, `.agent/CODEX_REPORT.md` only. Source commit/push: **none**. Merge/deploy/migration/rollout/brand/content-settings/Cron/Vault/OAuth/X mutation: **none**; `production_mutation=0`.
- **Next:** C1 should return PR #41 to G3. First settle the product contract for a bounded pilot (publish-timebox and consent revocation), then add an exact-account publish gate and negative tests for valid-token `off`/expired/ceiling paths, exclude AI Lab from the generic completion RPC, and re-run the disposable/live-source checks. Only after a corrected PR is reviewed should ChatGPT request owner consent and a separately authorized production pilot task. Do not apply the migration or deploy the Edge Function from this review.

---

# H1 — PR #41 Stage 3B publish-authority focused re-review (2026-09-27)

- task_id: `x-stage3b-publish-authority-focused-rereview-20260927`; status: `review_required`; next_owner: `chatgpt`; finish code: C1.
- verdict: **PASS-WITH-FIX for source readiness, not production activation**. Exact reviewed PR #41 head `6b25305e57bb1d6ad119c06c779042daba210547`; H1 fix commit `59f4f53` pushed to `claude/g3-stage3b-pilot-prep` (PR #41). Prior failed head `cd7adf5d1eb5a91773f21c7d8959766e1dd38229`. Fresh `origin/main` immediately before PR push: `d97cdcf`. The dirty shared checkout and other slots were untouched.

## Findings and fix

1. **P1 publish authority/timebox — resolved by G3's candidate.** `x_account_publish_authority` is separate from Stage 3A refresh rollout and defaults closed. Its exact-account, running-post predicate refuses absent/off/revoked/not-started/expired authority and missing/withdrawn `approvalMode` consent, disabled/non-live brand, disabled/unverified X account and disabled `brand_post`. It checks before generation and again before publish. A valid access token does not override a publish refusal; conversely Stage 3A's refresh generation ceiling remains refresh-only. The setter caps an enabled window at 30 days and excludes specialized brands.
2. **P2 AI Lab generic completion — resolved by G3's candidate.** Both AI Lab and Kabumori are rejected by the generic setter/check/dispatcher/completion paths. The disposable regression passes an exact matching running AI Lab row and `ai_salaryman_lab_x` to generic completion: `VAULT_BRAND_POST_NOT_FOUND`, with no post-status, fingerprint or success-log mutation. Existing AI Lab and Kabumori routes were not changed by H1.
3. **P2 found and fixed by H1 — a refresh could cross revocation.** The candidate's second authority check preceded `postToX`, but `VaultAccountXAuth.send` can perform a proactive refresh or a 401-triggered refresh/retry *inside* that call. Revocation committed during refresh could therefore still permit a later X create. H1 added the same fixed-code authority check inside the Vault request callback, immediately before **each** create (initial and retry), after any refresh. Generic Stage 3B passes that callback; specialized/legacy callers retain their prior behavior. Fake-X regressions cover proactive and reactive refresh crossing a revocation; neither sends a post afterward. The external request cannot be atomic with a DB commit: a create already in flight may still straddle a concurrent revoke, as the documented boundary states.

## Atomicity, ACL and migration assessment

- Setting publish authority to `revoked` alone blocks subsequent new creates at the next check; no Stage 3A refresh change is needed. The disposable commit race verifies a check during an uncommitted revoke can still allow, and the check after commit refuses. This is a per-request boundary, not a claim of atomic DB/X publication.
- New authority table: RLS on, service_role SELECT only, no direct API-role write. Check RPC is SECURITY INVOKER; setter is SECURITY DEFINER with empty search_path. Function search_path and PUBLIC/anon/authenticated denial versus service_role EXECUTE were checked in the disposable role fixture. The functions are created by its non-superuser fixture owner; actual production owner still needs post-apply read-back. Generic completion is service_role-only and exact-account bound; cross-account completion was refused.
- Candidate migration is a single explicit transaction with Stage 3A/completion preflights and refusal of re-apply. The disposable runner applied core, Stage 3A, Stage 3B completion and publish-authority **in that order**; no production migration-history repair or batch push was run. Production content-settings candidate is not yet applied; before any pilot, separately approve that product/consent contract and read back service_role SELECT on `social_mobile_content_settings` (its source migration grants authenticated explicitly and relies on environment default privileges for service_role). Missing store/row correctly fails closed, but a privilege mismatch would prevent an approved pilot from functioning.

## Verification, changed files and safety

- `deno test --no-check --allow-read supabase/functions/x-test-post supabase/functions/_shared/brand`: **619 passed, 0 failed**; focused three-file run **39 passed**. Changed test files `deno check --no-config` and `deno lint`: PASS. `index.ts` `deno check --no-config` has the **same six pre-existing unrelated errors** at original and fixed heads; no new type error. Index lint has the same three pre-existing unrelated warnings. Repository-configured Deno check cannot resolve absent local `npm:@types/node`. `git diff --check` and changed-line secret-pattern scan: PASS.
- Disposable PostgreSQL runner: publish-authority behavior/ACL and matching AI Lab negative **PASS**; account-local lease/single claim **PASS**; revoke-at-commit race **PASS**; cleanup **PASS**. Tests used fake data and local Postgres only. No real OAuth token, secret value, X create, media upload or production read/write was used in this re-review.
- H1 source changed only `supabase/functions/x-test-post/index.ts`, `vault_account_auth_test.ts`, `vault_account_brand_post_routing_test.ts`; commit/push `59f4f53` to PR #41. Control-only sync changed `.agent/tasks/CODEX_TASK.md`, `.agent/ACTIVE_TASK.md` H1 entry, `.agent/CURRENT_STATE.md` H1 summary, `.agent/CODEX_REPORT.md`. PR merge: no. Production migration/deploy/rollout/brand/account/content-settings/Vault/OAuth/Cron/X mutation: **none; production_mutation=0**.

## C1 recommendation

PR #41 is technically ready **at source level** for C1 review and planning a separately authorized Stage 3B pilot; it is **not** approval to merge/apply/deploy/enable/post. C1 should confirm the fixed PR head and this report. Before any production pilot, obtain explicit owner consent for the exact account/window and product consent UI/row, separately approve each required migration/Edge/config step, recheck live object definitions/grants and content-settings service_role SELECT, then read back each applied object. Do not use `db push`, `--include-all`, migration repair, or automatic rollout. No further H1 source work is pending unless C1 finds a discrepancy.

---

# H1 — Social-mobile Phase 1 consolidated integration review (2026-09-28)

- task_id: `x-social-mobile-phase1-consolidated-integration-review-20260928`; status: `review_required`; next_owner: `chatgpt`; finish code: C1; recommended model: Luna（高）.
- Verdict: **PASS-WITH-FIX for source integration only.** Latest `origin/main` reviewed: `94aa3eafed142576617f5c13480c2af3f9722e3b`. Remote heads verified read-only: PR #42 `c5e0157f867450047a5f79a204df45aaeefecfa6`; PR #44 `966d4123c13c4dcda1799772d262dde5be8cacb8` (updated after H1's P2 fix).
- Combined tree was built from latest main, merging PR #42 then PR #44. Both merges completed without conflicts; package.json overlap auto-resolved. No source changes were made to PR #42.

## Finding / fix

- **P2 fixed on PR #44:** the adapter mapped scheduler persistence states `pending/running/succeeded/failed` as if they were app display states, so `succeeded` fell through to `scheduled`; successful posts could appear as upcoming, and the History tab could include unpublished rows. Added a dedicated persisted-status mapper (`succeeded` → `published`, `running` → `publishing`, etc.) and filtered History to published/failed outcomes only. Regression tests cover both contracts. Fix commit pushed to PR #44: `966d4123c13c4dcda1799772d262dde5be8cacb8`.
- No other integration blocker found in the source review. Real-data mode stays fail-closed and does not reveal mock accounts/posts; loading, blocked, unavailable, ready and mock-preview remain distinct. Workspace/X-account ambiguity fails closed rather than selecting the first row. X-connect uses the signed-in session and in-memory OAuth state/PKCE verifier; client source contains no service-role key or X token secret. Consult saves retain existing settings and use the confirmed-proposal path when a persona exists; missing content-settings table/columns resolve to unavailable rather than silently switching to mock data.

## Verification

- Integrated social-mobile tests: **16 passed / 0 failed**.
- `src/domain/data-view.test.ts`: **14 passed / 0 failed**.
- `npm run typecheck`: PASS.
- `npm run lint`: PASS.
- Expo web export with dummy public Supabase config and `EXPO_PUBLIC_DATA_SOURCE=supabase`: PASS; no live data request/write was performed.
- `git diff --check origin/main...HEAD`: PASS. (Integration worktree only; no uncommitted source change.)
- Harmless Node `MODULE_TYPELESS_PACKAGE_JSON` warnings appeared in test output.

## Merge / production boundary

- Source-level merge order is PR #42 followed by PR #44. The exact combined source passed integration checks. A read-only GitHub status check confirmed both PRs are OPEN and `MERGEABLE` at the exact reviewed heads; the reported Vercel and Netlify deploy-preview statuses are SUCCESS for both. H1 did not merge either PR, deploy, inspect required branch-protection policy, or run an iOS simulator/build; native/iOS UX is not accepted by this source review.
- App Phase 1 can proceed at source level after the project owner completes the normal C1/merge gate. Real Supabase E2E is **not verified**: G3/G4 task records state `social_mobile_content_settings` is a source candidate and not production-applied, and the X OAuth redirect / real-data build configuration remain separate prerequisites. No production database read/write, OAuth, X post, deployment, migration, or other production mutation was performed (`production_mutation=0`). Do not treat this review as authorization for any of those actions.
- Changed files by H1: `.agent/tasks/CODEX_TASK.md`, `.agent/ACTIVE_TASK.md` (H1 entry), `.agent/CURRENT_STATE.md` (H1 entry), `.agent/CODEX_REPORT.md`; PR #44 source fix files: `apps/social-mobile/src/domain/post-status.ts`, `src/data/supabase-repository.ts`, `src/domain/data-view.ts`, `src/domain/data-view.test.ts`, `src/app/(tabs)/history.tsx`. No source commit in this report worktree; source fix is the separate PR #44 commit above. No PR merge/deploy.

## C1 recommendation

C1 should verify this report, the PR #44 updated head and remaining GitHub checks. If accepted, merge in the documented order (#42 then #44); keep production DB/config/OAuth and real-account E2E as a separate explicitly authorized gate. No additional H1 review loop is requested unless a concrete discrepancy is found.

---

# H1 — Multi-provider Auth focused review (2026-09-28)

- task_id: `x-social-mobile-multi-provider-auth-focused-review-20260928`
- result: **FAIL — PR #47 is not ready for merge or provider activation.**
- status: `review_required`; next_owner: `chatgpt`; finish code: C1.
- exact reviewed head / commit_hash: [PR #47](https://github.com/anohi-memories/kabumori/pull/47) `7bda196147a749431774fba915a86d41bf43dc5d`, unchanged at final read-only PR check. All 17 changed files are under `apps/social-mobile`.
- fresh `origin/main` at review/report preparation: `929808bb22d64baecf9eafa9a602bc4f362eb6a6`. Accepted Phase 1 merges `f0cac1505184a2abd9c9d504142012a1be999cf3` (#42), then `7870d10170d31e0a6b78ab245f4e9152a3628f00` (#44) are present.
- Pre-sync fetch found `19c00bf136591a733b9ceafce8a682776eef1e8f` (new G1 daily-topic assignment). H1 TASK/head remained unchanged; its disjoint G1 index/state additions must be preserved in the report-only fast-forward sync.
- Work was isolated in H1's own `/private/tmp/kabumori-h1-social-mobile-latest-20260928`; the dirty shared checkout and other slots were not changed. No source fix was made: identity/recovery/storage/callback contracts require a coordinated design correction, so H1 stopped under the TASK's design-level stop rule.

## Blocking source findings

Paths/line numbers below refer to the exact reviewed PR head. All reproduction users, codes, verifiers and credentials were synthetic; SDK fetches were replaced with local fixtures. No live Auth/token request was made.

1. **P2 — explicit provider linking rejects the URL returned by Supabase.** `apps/social-mobile/src/lib/auth-client-flows.ts:61`, `:85–90`. The shared browser helper permits only the project's own `/auth/v1/*` URLs, but authenticated `linkIdentity()` returns the external provider authorization URL. The installed auth-js `linkIdentityOAuth` reads `/user/identities/authorize` and passes its response URL through; [Supabase Auth's LinkIdentity implementation](https://github.com/supabase/auth/blob/master/internal/api/identity.go) obtains the external-provider redirect and returns it as `url`. An actual SDK + mocked authenticated response pointing to Google opened the browser **zero** times and returned generic failure. Thus enabling Manual linking does not make this screen work. Correction contract: distinguish sign-in and authenticated linking URL provenance, validate the intended provider/callback, and preserve exact-user ownership; do not simply remove all URL checks. See [identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking).

2. **P2 — duplicate callbacks report success before, or despite, a failed exchange.** `src/lib/auth-client-flows.ts:37–40`. A code is added to the process-wide Set before `exchangeCodeForSession` finishes; another delivery immediately returns `{ok:true}`. This is the normal overlap of the Linking listener and `openAuthSessionAsync` return, not just a fabricated replay. A delayed exchange returning `bad_code_verifier` produced first-result failure and duplicate-result success. The login-methods screen then has a path to display “added” without a successful exchange. Correction contract: share the actual in-flight/completed outcome, not a success sentinel; scope and clear lifecycle state safely. The token-hash branch also has no shared completion guard and should be covered in the bundled callback fix. This is false success, **not evidence that server-side code replay or PKCE validation is bypassed**.

3. **P2 — native PKCE callbacks discard their `sb_flow_id`.** `src/domain/auth-flows.ts:48`, `src/lib/auth-client-flows.ts:39`. Locked supabase-js/auth-js `2.115.0` creates per-flow verifier slots; email/recovery redirects can carry `sb_flow_id`. The parser retains only `code`, and the exchanger gets no flow option. Native execution has no browser location from which the SDK can recover that ID, so it falls back to the latest legacy verifier. A fixture with pending recovery flow A and a newer OAuth flow B sent verifier B for callback A and failed; a control using the same installed SDK with `{flowId:A}` succeeded. Correction contract: retain and strictly validate the callback's flow ID and pass it to the SDK; test concurrent, stale and malformed IDs. Current [exchangeCodeForSession reference](https://supabase.com/docs/reference/javascript/auth-exchangecodeforsession) explicitly demonstrates this option. The SDK fails closed; this finding does not assert token theft.

4. **P2 — signup UI reveals the obfuscated existing-account distinction.** `src/domain/auth-flows.ts:64–67`, `src/components/auth-screen.tsx:10–14`, `:45–47`. A new email response with identities and an existing-account response with an empty identities array produce two different, externally visible messages; only the existing-account path mentions an already registered account. A pure-source presentation probe proves the messages differ. The server's intentionally obfuscated response is therefore converted back into an enumeration signal by the app. Correction contract: use the same neutral successful next-step message for both no-session responses; align duplicate-address errors with that policy. Do not treat checking only for raw server-error strings as enumeration prevention. See current [signup reference](https://supabase.com/docs/reference/javascript/auth-signup) and [identity-linking behavior](https://supabase.com/docs/guides/auth/auth-identity-linking).

5. **P2 — provider credentials can be persisted implicitly by the SDK.** `src/lib/supabase.ts:30–37`, `src/providers/auth-provider.tsx:61`, `:66`. Plain AsyncStorage is passed to `persistSession:true`; there is no provider-field filtering at the storage/context boundary. Installed auth-js `_saveSession` copies the entire returned session. An actual SDK with a synthetic session containing provider access/refresh fields persisted both in the fixture storage. The G3 regex test proves that app source does not name/read those fields, **not that the SDK cannot save them**. No posting-token reuse or real secret leakage was found, and the necessary Supabase Auth session refresh token is not the prohibited posting/provider credential. Correction contract: decide and implement the intended no-provider-credential persistence/context policy while preserving Supabase session restoration and PKCE verifier storage; make the behavioral test, docs and security claim agree. No real provider token was acquired, logged or inspected in this review.

6. **P2 — password recovery remains valid after switching signed-in users.** `src/providers/auth-provider.tsx:65–70`, `:147–151`. Recovery is only a boolean set on `PASSWORD_RECOVERY` and cleared on `SIGNED_OUT`/completion. `SIGNED_IN` with a different user does not invalidate it, and the password update checks no recovery-user/session binding. Executing the exact provider source with a hook harness and events recovery(A) → sign-in(B), without an intervening sign-out, allowed `updateUser` for the current B session. Correction contract: bind recovery to the intended exact user/session, invalidate it on an incompatible transition and recheck immediately before update; cover restart, callback overlap and user changes. This is an app recovery-gate/wrong-context bug, **not a demonstrated Supabase cross-user authorization bypass**: the SDK still updates the currently authenticated user. See [password recovery](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail).

7. **P2 — “exact callback” parsing accepts malformed/ambiguous authorities and parameters.** `src/domain/auth-flows.ts:39–48`. Comparing `hostname` rather than the complete allowed authority ignores userinfo/ports; merging query/fragment parameters and taking the first `code` silently accepts duplicates/conflicts. Source accepts userinfo before `auth-callback`, an extra port, repeated query codes and conflicting query/fragment codes. The executable rejection probe fails on the first malformed authority; the remaining forms were inspected in the parser. Correction contract: reject credentials/ports and conflicting or duplicated credential-bearing parameters/types while preserving only documented callback fields. Posting callback, foreign scheme/host/path and implicit access-token-only returns are already rejected by existing tests. This hardens the promised input contract; it is not proof that an arbitrary code can become a valid session.

## Boundary assessment and remaining source decisions

- **X app-login versus posting-X: PASS at source separation level.** Auth uses Supabase `provider:'x'`; posting continues through existing `x-oauth-connect-user`/Vault. Separate `auth-callback` and `oauth-callback` constants/routes are retained; neither helper calls the other's API. No mobile publishing authority is added. Provider-session persistence finding 5 remains distinct from posting credential reuse.
- **Identity linking: FAIL operational readiness.** The UI is explicit and the SDK request authenticated; server linking/collision decisions are delegated to Supabase, not client name/handle/email heuristics. No `user_metadata` authorization/merge was found. Supabase's current automatic-linking policy is server-controlled (verified/unique email safeguards); do not add client merging. The URL bug, completion truthfulness and exact-user transition regressions must be fixed before enabling Manual linking.
- **Callback/PKCE/recovery: FAIL.** Fixed callback/scheme and PKCE configuration are present, but findings 2/3/6/7 prevent acceptance of the complete flow.
- **Apple native nonce: PASS by source/current contract.** Fresh 32-byte random nonce, SHA-256 value to Apple and raw nonce with Apple ID token to Supabase; cancellation has a fixed outcome. Native nonce generation is not a substitute for a signed development build/device test. Current [Supabase Apple guide](https://supabase.com/docs/guides/auth/social-login/auth-apple) and [Expo SDK 57 AppleAuthentication](https://docs.expo.dev/versions/v57.0.0/sdk/apple-authentication/) were checked. Official button/branding and standalone identifiers remain release QA gates.
- **Google/X browser cancel/error: conditional source support, not E2E PASS.** Cancel/dismiss and provider errors map to fixed messages; no raw provider response is rendered/logged. Successful completion is affected by findings 2/3, and manual linking by finding 1. Desktop Web authentication was not exercised merely by exporting Web assets.
- **Onboarding/workspace: not fully accepted.** Existing server-side first-workspace path is reused; local progress keys include user ID and ambiguous workspace state refuses automatic selection. No privileged workspace write was added. However, `shouldShowNewAccountNotice` (`src/domain/auth-flows.ts:151–154`) drops the notice after 30 minutes even if no workspace/acknowledgment exists; an interrupted first run can bypass the documented pre-workspace notice. The gate's loading effect (`src/features/onboarding/onboarding-gate.tsx:70–92`) also does not depend on the current session user, so a direct session switch requires an explicit stale-user/progress invalidation regression. G3 must define/test these continuations together with recovery/user binding; do not claim exact-user UI acceptance from storage-key regexes alone. Server RLS/ownership was not bypassed or live-tested here.
- **Session restore/logout/password sign-in: existing source and contract tests pass**, but real relaunch/device E2E remains pending; recovery and provider-credential lifecycle defects are explicit exceptions.
- **Provider availability: partial truthfulness only.** Social buttons disable on missing/disabled project settings; `external.*` says enabled, not that provider-console/redirect/native-build settings work. Email UI remains offered even when `providers.email` is false, and `signupDisabled` is only explanatory rather than disabling signup (`src/components/auth-screen.tsx`). Include fail-closed Email/sign-up availability behavior in the bundled correction; do not market an enabled-provider flag as verified readiness.

## Verification / evidence

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts` in independent H1 app directory | installed locked dependencies; no app secrets used |
| `npm test` | **32/32 PASS**, includes focused Auth + other mobile contract tests |
| `node --experimental-strip-types --test src/domain/data-view.test.ts` | **14/14 PASS** |
| `npm run typecheck` / `npm run lint` | **PASS / PASS** |
| `git diff --check 7bda196^ 7bda196` | **PASS** |
| Source/diff secret/token scan | no hardcoded service-role/provider secret or raw real token found; implicit SDK persistence is finding 5 |
| `npx expo export --platform web --output-dir dist-h1-web` | **PASS**, synthetic public env only |
| `npx expo export --platform ios --output-dir dist-h1-ios` | **PASS**, synthetic public env only; JS/Hermes export, **not** an iOS native build or simulator/device E2E |
| H1 source-executed negative probes | **0 PASS / 7 FAIL**: seven expected-safe assertions reproduced the findings above |
| GitHub PR #47 read-only check | OPEN, MERGEABLE at exact reviewed head; Vercel/Netlify Preview SUCCESS; this is not Auth acceptance |

- H1 local-only diagnostic evidence: `/private/tmp/kabumori-h1-social-mobile-latest-20260928/apps/social-mobile/review/h1-auth-boundary.test.mjs`, run with `node --test review/h1-auth-boundary.test.mjs` from that app directory. Tests are outside the product `tests/*.test.mjs` glob and are **not pushed to PR #47 or merged to main**. They execute transpiled exact-head Auth helpers/provider source and the locked real SDK with synthetic fetch/storage/hooks; no production calls. The fixtures/scenarios above are the durable reproduction contract for the next correction task. Generated export directories are H1-local outputs only.
- Current Supabase changelog was checked first; unrelated self-host/SAML/management changes were not treated as hosted mobile fixes. Current identity-linking, X/Google/Apple, PKCE/native deep-link and recovery docs and installed auth-js `2.115.0` implementation were checked before judging semantics. Native [deep-link guide](https://supabase.com/docs/guides/auth/native-mobile-deep-linking), [PKCE guide](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [X guide](https://supabase.com/docs/guides/auth/social-login/auth-twitter) and [Google guide](https://supabase.com/docs/guides/auth/social-login/auth-google) are reference gates, not proof of production console settings.

## Console/config gates and activation order — not executed

Source correction/retests and C1 must come **first**. Console changes alone cannot repair the defects above. Production provider settings were not inspected or modified; the following prerequisites remain unverified:

1. Auth callback allowlist and email confirmation/SMTP/template policy: allow the exact approved app Auth return for supported builds, keep posting return distinct, verify PKCE confirmation/recovery on the same intended device/build. Prefer narrowly scoped callbacks over enabling a wildcard solely because the source doc proposes one. Decide email-confirmation policy explicitly; do not disable it silently to make tests pass.
2. Email signup/confirmation/recovery/session-relaunch/logout E2E, including duplicate-address neutral responses and user-switch/restart recovery behavior. Existing profiles/workspace/backend readiness and RLS are separate prerequisites; do not create users/workspaces or migrations during this review.
3. X app-login provider/client: OAuth 2.0 `x`, Supabase `/auth/v1/callback` and email-request setting; verify it is separate from the posting OAuth client/consent/Vault path. Enabling app-login must not enable posting.
4. Apple: choose/set standalone `ios.bundleIdentifier`, Sign in with Apple capability/plugin and Supabase accepted native client ID; signed dev-build real-device test. Browser Apple, **also used by the current Apple linking helper even on iOS**, needs its own Services ID/secret config (Services ID first in client IDs when applicable) and six-month secret rotation. Do not claim native-only config covers that linking path; decide native linking versus browser linking in the source correction.
5. Google: correct OAuth client and Supabase callback; verify browser PKCE deep-link success/cancel/error on the signed native build. A later native Google integration is optional scope, not silently added here.
6. Manual linking only after the source URL/result/user-boundary fix and the provider paths are verified: same verified email automatic server linking, missing/private-relay email new account, authenticated explicit add, already-used identity collision, and no workspace before the approved new-account decision. No unlink is implemented in this phase.

## Changes, safety and C1 handoff

- changed_files (GitHub control/report sync only): `.agent/tasks/CODEX_TASK.md`, `.agent/ACTIVE_TASK.md` **H1 only**, `.agent/CURRENT_STATE.md` **H1 snapshot only**, `.agent/CODEX_REPORT.md` appended. Existing reports and other slot records retained.
- source fixes / source commit / PR #47 push: **none**. Reviewed head remains `7bda196147a749431774fba915a86d41bf43dc5d`; report-control commit is separately visible in Git history. H1-only diagnostic/export artifacts stay local and are not staged.
- remaining_issues: seven reproduced Auth findings, onboarding/session-switch/provider-readiness gaps, and the unverified configuration/device/backend gates listed above.
- push: no PR #47 source push; only these four report/control files are submitted for GitHub sync. deploy: none. safety_checks: isolated worktrees, exact-head recheck, synthetic fixtures, no real secrets, no production mutation, other-slot changes preserved.
- merge / deploy / provider enablement / redirect allowlist / SMTP / developer-console / DB / Vault / OAuth consent / Cron / X posting / Stage 3B activation: **none**. `production_mutation=0`; no service-role key or real user/provider credential was read.
- next_recommendation: C1 confirms **FAIL**, keeps PR #47 unmerged/provider activation gated, and decides one bundled G3 correction assignment covering the Auth findings plus onboarding/provider-readiness gaps. **推薦モデル：Opus5.5（高）** for that coordinated Auth correction. Do not overwrite the G3 TASK automatically or start another review loop under the completed H1. The fixed head should then receive one focused regression/acceptance pass (**推薦モデル：Sol（高）**) before any separately authorized activation.

---

# H1 — Auth Phase 2 final focused acceptance (2026-09-28)

- task_id: `x-social-mobile-auth-phase2-final-acceptance-review-20260928`
- result: **PASS-WITH-FIX — ready for the C1/source merge decision at the exact accepted head; not authorization for production provider activation.**
- status: `review_required`; next_owner: `chatgpt`; finish code: C1.
- initial reviewed correction: [PR #47](https://github.com/anohi-memories/kabumori/pull/47) `5fd483a5fc651da07d0791c68eaa557cdb201357`; previous failed head: `7bda196147a749431774fba915a86d41bf43dc5d`.
- exact accepted/fixed head / commit_hash: **`ed5f8b7890e538593dba369dd85cb99a12b27242`**, one H1 correction commit on top of `5fd483a`. Source push to `claude/g3-multi-provider-auth` confirmed; GitHub head read back matches.
- startup fresh main: `0d5c43cd0fea0b4dcfdebadef9406dfc797fcc63`; pre-push/report base: `fd1746fd4ca7d75729808a7226f72deeefea2082`. No concurrent main change to the mobile Auth files or this H1 assignment was found. Review and report used separate H1-owned independent worktrees; shared checkout, other slots and their work were preserved.
- Scope was limited to the `7bda196..5fd483a` correction and the TASK's listed Auth boundaries. No new broad feature/design review, production inspection or activation was performed. This final result supersedes the earlier FAIL for the old head, not its historical evidence.

## Prior seven findings — final status

| Prior finding | Final acceptance |
| --- | --- |
| 1. Linking URL rejected | **PASS-WITH-FIX**. Authenticated external-provider URLs now have separate provenance checks, provider-specific HTTPS host **and authorize path**, no credentials/unexpected port, and exactly one redirect to the project's Supabase Auth callback. Old H1 actual-SDK linking/browser probe now passes. Explicit owner comparison remains after linking. |
| 2. Duplicate false success | **PASS-WITH-FIX**. Code/token-hash duplicates share the real promise/result, including failed exchanges. H1 additionally binds remembered results to their original flow/OTP type and prevents eviction of an in-flight exchange under cache pressure; no success borrowed by a conflicting callback. |
| 3. Lost PKCE flow ID | **PASS-WITH-FIX**. Strict parsed flow ID, SDK `appendPkceFlowIdToRedirects`, and explicit `exchangeCodeForSession(code,{flowId})` select the correct verifier. Real locked-SDK tests prove A/B/C selection, mismatch refusal without consuming C, and stale/malformed rejection. H1 closes the cached-result bypass for a changed flow ID. |
| 4. Signup enumeration | **PASS**. New/obfuscated-existing no-session results and duplicate-address error variants use the same fixed outcome/message. Actual provider wrapper/UI wiring was inspected. Confirmation-on policy remains an explicit console/device gate, not silently disabled. |
| 5. Provider credential persistence | **PASS** for the defined app storage/context policy. Actual SDK storage payload excludes provider access/refresh fields; Supabase app access/refresh session and PKCE state remain restorable. Native AsyncStorage/Web localStorage use the sanitizer; exact provider-source harness confirms React context redaction. Required Supabase session refresh is distinct from prohibited provider/posting credentials. |
| 6. Recovery user/session binding | **PASS-WITH-FIX**. PASSWORD_RECOVERY creates a user/session-ID binding; incompatible user or new same-user session/sign-out invalidates it. H1 also pins each password action to its starting binding so a newer recovery event during `getSession()` cannot retarget the password update or erase the newer valid context. |
| 7. Malformed callback accepted | **PASS**. Credentials/port, foreign/posting authority/path, unknown fields/implicit tokens, duplicate/conflicting credential params and malformed/missing flow IDs fail closed. No client-name/handle/user_metadata merge or authorization introduced. |

## Additional three gaps — final status

1. **Onboarding/new-account continuation: PASS at source level.** The notice no longer expires after 30 minutes; a single non-email identity without workspace/explicit acknowledgment continues to see it after interruption. Loaded input/progress is user-tagged and a user change yields loading until the correct user's state is read; the effect depends on current user ID and acknowledgment cannot modify another user's loaded state. Per-user local storage and existing exact-user server workspace path are retained. Actual device/backend continuation remains E2E, not accepted from export alone.
2. **Provider/Email readiness: PASS under the documented policy.** Social readiness requires both project enablement and explicit build declaration; Apple native also requires bundle ID/API availability; E2E is never claimed by source (`e2eVerified:false`). Missing build config/disabled providers cannot initiate signup/social linking. Email signup/reset require known enabled settings, and signup must explicitly be open. Existing password sign-in deliberately remains callable while project settings are unknown (server still decides); it is disabled when email is known disabled or absent from build declaration. This compatibility exception is not a verified-ready claim for signup/providers. UI and wrapper checks both enforce capabilities.
3. **Apple linking path/config distinction: PASS at source/current SDK contract.** iOS explicitly uses authenticated `linkIdentity({provider:'apple',token,nonce})`; the installed SDK posts `link_identity:true` with the current user's app JWT. Non-iOS uses gated browser linking (`apple_web`, Services ID/secret). SHA-256 nonce to Apple/raw nonce to Supabase remains intact. Missing current `ios.bundleIdentifier` truthfully disables native Apple; no console/build setting was added by H1.

X app-login remains strictly separate from posting X: Supabase app-auth routes/helpers do not call posting connection/publish APIs; existing `x-oauth-connect-user` + Vault stays the posting path. No service-role/provider secret, provider-token log or `user_metadata` authorization was found. No source change to G4 Home/posting/history, Supabase functions/migrations, admin, Cron or publishing authority was made.

## Small H1 corrections within the permitted boundaries

At `5fd483a`, targeted source-executed probes found the following residual cases. The TASK explicitly permits small obvious defects in these boundaries, so H1 fixed/retested them directly rather than starting a new design/review loop:

- **Callback context / in-flight retention:** the cache indexed only a credential, so the same code under flow B could borrow cached success from flow A; likewise a token hash with another OTP type/flow. Its 32-entry FIFO could evict a still-pending first exchange, allowing a second exchange on duplicate delivery. Remembered entries now retain context and pending state, conflicting replays fail before an SDK call, and capacity only retires completed entries; all-pending capacity refuses a new distinct callback without losing duplicate sharing.
- **Recovery action race:** recovery A's save could await `getSession`, receive PASSWORD_RECOVERY(B), and then compare against the newly changed reference B, updating B with the password entered for A. The action now snapshots A's binding before awaiting, refuses a changed binding/session and preserves any newer valid B recovery. This is client recovery-context correctness, not a claimed server authorization bypass.
- **Authorize-path validation:** expected provider host/redirect checks still admitted an unrelated `/home` page on X/Google/Apple. Provider-specific authorize paths now supplement the existing host/redirect checks; current Google/Apple public OIDC authorization endpoints and Supabase X provider implementation were verified before choosing the paths. No arbitrary external host permission was added.

Durable `tests/auth-boundary-regression.test.mjs` has six tests for those cases, exact recovery success, sign-in-switch/fresh-context rejection and actual React-context credential stripping. Five negative assertions reproduced unsafe behavior before their fixes (including pending-cache pressure); all six pass on the accepted head. Tests use synthetic in-memory sessions/hooks and execute the exact provider source; no real Auth/DB/OAuth call. This does **not** claim device-relaunch E2E or that JWT decoding authorizes a user.

## Verification

| Check | Result on accepted source |
| --- | --- |
| Full mobile `npm test` | **43/43 PASS** (G3 baseline 37, H1 regressions 6) |
| `node --experimental-strip-types --test src/domain/data-view.test.ts` | **14/14 PASS** |
| `npm run typecheck` / `npm run lint` | **PASS / PASS** |
| `git diff --check`, staged diff check | **PASS** |
| Actual-SDK tests | provider-token-free storage + restored app session, concurrent flow/verifier selection, stale/mismatched flows, duplicate real failure/success and token-hash single completion **PASS** |
| Old H1 actual-SDK linking/browser rejection probe recreated | **1/1 PASS** on the correction |
| H1 in-memory mutation probes | **4/4 detected**: removed callback context guard, authorize-path guard, SDK flow-ID argument, callback userinfo guard. Unmutated controls pass; repository source was never rewritten for this mutation run. |
| Source/diff secret/token scan | **PASS**: provider field names only in the sanitizer; service-role text only in rejection logic; no real secret/provider log/user_metadata authorization found |
| Expo Web / iOS exports after H1 source fixes | **PASS / PASS**, synthetic public Supabase env; iOS is JS/Hermes export, **not** native signing/build/device E2E |
| Exact-head GitHub read-back | PR #47 OPEN, MERGEABLE, head `ed5f8b7890e538593dba369dd85cb99a12b27242`; Vercel + Netlify Preview SUCCESS, auxiliary Netlify checks NEUTRAL |

- H1 independently ran the four mutations above. G3's reported 11/11 mutation run was inspected in its Report but was **not** claimed as rerun by H1.
- Local-only mutation script: `/private/tmp/kabumori-h1-social-mobile-latest-20260928/apps/social-mobile/review/h1-final-mutations.mjs`; old probe: `review/h1-auth-boundary.test.mjs`. Neither local review folder nor generated `dist-h1-*` outputs is committed/pushed. The six new regressions **are** in PR #47.
- Supabase skill/changelog checked first; current [flow-ID exchange reference](https://supabase.com/docs/reference/javascript/auth-exchangecodeforsession), [identity-linking guide](https://supabase.com/docs/guides/auth/auth-identity-linking), installed auth-js 2.115.0 and [Expo SDK 57 Apple docs](https://docs.expo.dev/versions/v57.0.0/sdk/apple-authentication/) checked for the focused semantics. [Google OIDC configuration](https://accounts.google.com/.well-known/openid-configuration), [Apple OIDC configuration](https://appleid.apple.com/.well-known/openid-configuration) and [Supabase X provider](https://github.com/supabase/auth/blob/master/internal/api/provider/x.go) support the authorize-path restrictions. Unrelated database/self-host changelog changes were not applied.

## Remaining provider-console / real-device gates only

No open source blocker remains **within this focused assignment**. Source acceptance does not enable any provider or publication authority. Before separately authorized activation/E2E:

1. Approved Auth callback allowlist must accommodate the appended `sb_flow_id` on supported builds, separately from posting callback; email confirmation/SMTP/templates must support confirmation and recovery. Use the narrowest approved callback matching policy; H1 did not add a wildcard or alter confirmation settings.
2. Signed development build/device: Email signup/confirmation/recovery, two competing recovery contexts, relaunch/restoration/logout and first-workspace acknowledgment/user-switch E2E; X/Google PKCE success/cancel/error and concurrent callbacks. Existing backend/RLS readiness is checked in that E2E, not by mutating schemas during H1.
3. X app-login OAuth client and Supabase callback/email permission remain distinct from posting-X client/consent. App login must not activate posting.
4. Apple standalone bundle ID/capability and Supabase native accepted client ID; real-device native sign-in **and** identity linking, plus normal Apple button/branding release QA. Browser Apple on non-iOS separately needs Services ID/secret and its rotation plan; it is not implied by native config.
5. Google OAuth client/callback and Manual linking enablement/collision tests. Add each provider to the explicit build declaration only after its approved config/device gate; no fake E2E verification flag.

## Change/safety/C1 handoff

- changed_files by H1 on PR #47: `apps/social-mobile/src/domain/auth-flows.ts`, `src/providers/auth-provider.tsx`, `tests/auth-flows.test.mjs`, new `tests/auth-boundary-regression.test.mjs`, `docs/multi-provider-auth-phase2.md` (all under that app).
- Reporting files: `.agent/tasks/CODEX_TASK.md`, `.agent/ACTIVE_TASK.md` H1 only, `.agent/CURRENT_STATE.md` H1 snapshot only, `.agent/CODEX_REPORT.md` appended. Other slots/reports retained; report-control commit is separately visible in Git history.
- push: **source fix pushed and exact head verified**; only own report/control files submitted for main sync. merge: none. deploy: no production deploy. Preview CI is successful and separate from Auth/device acceptance.
- safety_checks: independent owned worktrees, fresh main/exact-head checks, explicit staging of own five app files, synthetic SDK/hooks, no real credentials, no changes to other slots, no publishing/backend authority change.
- `production_mutation=0`: no provider console, redirect/SMTP/template, Apple/Google/X console, DB/migration, Vault, OAuth consent, Cron, Stage 3B activation or real X post.
- remaining_issues: only the unexecuted console/device gates above; no further source design correction requested in this focused pass.
- next_recommendation: C1 confirm **PASS-WITH-FIX** and exact PR #47 `ed5f8b7890e538593dba369dd85cb99a12b27242`, then make the normal source merge decision/checks. Keep real-provider/device/production activation separately authorized. Do not start another review loop without a concrete discrepancy. **推薦モデル：Luna（中）** for the report/exact-head C1 confirmation; this H1 stops here.

---

# H1 — data-packet controlled production sync (2026-09-29 JST)

- task_id: `kabumori-data-packet-prod-sync-verification-rollout-20260929`
- result: **PASS** for the assigned controlled sync/read-back, not natural-cycle/consumer activation acceptance.
- status: `review_required`; next_owner: `chatgpt`; stop for C1.
- recommended_model: Sol（高） for this rollout; Luna（中） for C1 report confirmation.
- exact fresh main / deployed source commit_hash: `d79b0c8524af56cc56c5245f5037517fc689d917`.
- worktree: `/private/tmp/kabumori-h1-social-mobile-report-20260928`; own branch `codex/h1-data-packet-prod-sync-20260929`. Reused the clean completed H1 report worktree; no G1/G2/shared checkout used or altered.
- source changes / PR / source merge: **none**. Only H1 completion controls are committed for report sync.
- reporting base: main advanced to `f04d392aaf75f561975e9519281ecc62b06b4c02` after deploy; the intervening commit changes G2 agent state only. No target/dependency source changes. H1 TASK/Report unchanged; newer G2 state preserved.

## Startup and ownership

- Fresh-fetched main before starting and again immediately before deploy. Read PROJECT_RULES, HANDOFF, ORCHESTRATION, current H1/G1 task/report and data-packet deployable source.
- `aecfa60` is an ancestor. Diff from G1's `15a7ac72aba611f1eff734c38b3e6c517b4e691c` to deployed main contains **0 changes** under data-packet or `_shared`.
- All target runtime imports resolve within its own directory; no imported shared file or G2 analysis file enters this bundle.
- G1 rollout is stopped, handed off to H1; G2 owns analysis source only and is prohibited from data-packet/deploy/gate changes. G3/H2 account-deletion work is disjoint; its existing production state was captured before H1 rollout.
- Supabase skill, current changelog, current official CLI deploy/download docs and installed CLI help checked. CLI 2.116.0 / Deno 2.9.6. No version upgrade or unrelated platform change performed.

## Independent preflight and stale-source proof

- Production metadata before: id `6d8f284f-5567-4f7a-87dd-9801fb8f95b8`, ACTIVE, **version 11**, verify_jwt=false.
- created_at = updated_at = `1789623825492`; original entrypoint was the historical ios-push-e2e worktree path, not H1's deployment source.
- old bundle ezbr_sha256: `0508c3a8ae27ba5fca6e58bbf04608dc2652e2ff519fdcd12387f01bba952323`.
- Independently downloaded production source to `/private/tmp/kabumori-h1-data-packet-before-iFkaIi` using the explicit function/ref and `--use-api` (no execution). Kept this pre-deploy source for exact rollback if needed.
- `session_reuse.ts` absent in production. `handler.ts` lacks stored-packet lookup and input wiring; `packet_builder.ts` lacks reuse index/application; `packet_schema.ts` lacks provenance/provider/validation. The other four original runtime files are identical. Tests/fixtures are main-only and not deployed.
- Canonical gate location established from `20260920100000_market_report_packets_phase2.sql`: singleton `public.market_report_consumer_settings`, read by the shared-consumer RPC. Read only `id, app_enabled, x_enabled` at `id=true`; **false/false**.
- Cron read limited to relevant market-report rows and returned only job ids/names/schedules/active/target and a command digest, not the command text or credentials. Schedules match existing Phase 1 docs and G2's recorded shared schedule.
- No hidden credentials/service-key REST fallback. Supabase connector SELECTs succeeded in this H1 session.

## Tests/checks

| Check | Result |
| --- | --- |
| Full data-packet suite, `deno test --node-modules-dir=none --allow-read=supabase/functions/market-report-data-packet supabase/functions/market-report-data-packet/` | **42/42 PASS**, including 7 session-reuse cases, authorization/no-I/O rejection, idempotency, blocked quality and no-consumer I/O source guard |
| `deno check --node-modules-dir=none .../index.ts` | **PASS**, full transitive runtime closure |
| `deno lint` on all 8 deployable runtime files | **PASS** |
| Full-directory `deno lint` (14 files, including tests) | **One pre-existing test-only finding**: handler_test.ts:19 `require-await` on fetch mock. Last modification `e0d24ce3dc35267101ed3d569f694169f37d2430`; not a runtime/bundle defect, unchanged by reuse fix/H1. Not suppressed or patched. |
| `git diff --check`, unchanged tracked source | **PASS** |

Initial default Deno invocation could not resolve Node type references with no local node_modules; `--node-modules-dir=none` uses Deno's installed cache without installing project dependencies. The source-reading test also requires its documented filesystem permission; after scoping `--allow-read` to this function, the canonical full run passes. Those initial setup failures were not counted as passing runs or treated as source regressions. No test network/production invocation was made.

## Exact production mutation

After all production preconditions and applicable runtime checks passed, executed exactly once from the isolated, tracked-source-clean fresh-main worktree:

```text
supabase functions deploy market-report-data-packet --project-ref wsmznyzcvmuitkglfeuj --no-verify-jwt --use-api
```

- `--use-api` is the supported Docker-free bundling option verified via CLI help. No broad/no-name deploy or prune.
- Local untracked `supabase/config.toml` contains only explicit project_id and the target's verify_jwt=false. Did not reuse shared untracked config; this minimal non-secret config and CLI-generated `.temp/cli-latest` are **not committed**.
- CLI upload log lists exactly the 8 runtime files below and confirms only `market-report-data-packet` deployed, exit 0.
- Production after: **version 12**, ACTIVE, verify_jwt=false, updated_at `1790688198972` (**2026-09-29 22:23:18.972 JST**), created_at unchanged.
- current entrypoint: `file:///tmp/user_fn_wsmznyzcvmuitkglfeuj_6d8f284f-5567-4f7a-87dd-9801fb8f95b8_12/source/supabase/functions/market-report-data-packet/index.ts`, import_map=false.
- new bundle ezbr_sha256: `b7d08f4be6685a3baf2ab784a9c69c86fdee4d11eb577ba4d555480204c4b27e`.

## Read-back / byte identity

Immediately downloaded v12 with the same function/ref to `/private/tmp/kabumori-h1-data-packet-after-gNfDUQ`. Compared each file's raw bytes with `git show d79b0c8524af56cc56c5245f5037517fc689d917:<path>` (not an editable working-tree baseline). **8/8 MATCH**, no extra bundle files.

| Runtime file | SHA-256, equal to deployed main |
| --- | --- |
| index.ts | `2a5757c359df68b81fb36e6fa2ca59d71d581d747ae6fc31a6193dc42e503d7e` |
| handler.ts | `193de33fb30f8efdf9fdc138bd65bea4b1d73cf259d278607dbd7fc3e6835268` |
| packet_builder.ts | `bb2568eddf6ae4497057dd3b7051362e82ef1539c084113dcdc7ffe4a42932fc` |
| packet_schema.ts | `7bd340a5b0d093bb88c8c9a513a1825f472edcc3af6e43442cb21e1c11dd360c` |
| session_reuse.ts | `70368a4016073422c3d6977328ea38aad52b959143a3f60132f06b3a7d28916a` |
| session_logic.ts | `7403e7c62f5abb6768b76b1d6d45359ad97730d4cdd2ac3e7f1d146b7e246621` |
| yahoo_daily.ts | `76cb95e88192be999f90e397e7b225162a3e7c89b2ee046825fa5ec71ec3d094` |
| mic_metrics.ts | `5e2f54a9baa288514841f04bda1daa82d0488e5cc57053ca76e222ca15ca5abb` |

Identity covers the reuse module, handler's bounded stored-packet lookup/input, builder's `buildReuseIndex`/`applySessionReuse`, and schema's lineage/provider/quality consistency validation. Same-session-only/no-chain/current-value-preferred semantics are additionally covered by the passing tests. This is source identity, not a claim that a natural production cycle has yet used reuse.

## Cron / gates / other-function invariants

Repeated the **exact same** SELECTs after deploy. All six row values/digests unchanged; no cron secret text was read or published.

| jobid | jobname | schedule (UTC) | active before/after | command MD5 before = after |
| --- | --- | --- | --- | --- |
| 28 | market-report-data-packet-morning | `50 22 * * 0-4` | true / true | `69b29f53d08a7cfae536af0633bbb32f` |
| 29 | market-report-data-packet-close | `15 7 * * 1-5` | true / true | `fb80310ff7a6e824c181d5696d3a6bab` |
| 30 | market-report-analysis-morning | `55 22 * * 0-4` | true / true | `82f3090e7feb1a8c52376914d42053ad` |
| 31 | market-report-analysis-morning-retry | `5 23 * * 0-4` | true / true | `82f3090e7feb1a8c52376914d42053ad` |
| 32 | market-report-analysis-close | `20 7 * * 1-5` | true / true | `216cf5dae2503140793e4eb9f46ce0da` |
| 33 | market-report-analysis-close-retry | `35 7 * * 1-5` | true / true | `216cf5dae2503140793e4eb9f46ce0da` |

- Gate singleton before/after: `id=true`, **app_enabled=false / x_enabled=false**; exactly equal.
- All-functions metadata snapshots: 19 before / 19 after, no added/removed functions. Full returned metadata equality for **all other 18 functions**, including version/updated_at/verify_jwt/bundle identity. Only this target changed (v11 -> v12).
- H1 production mutations: **one target Function deployment**. Other Function/config/DB/schema/RPC/migration/Cron/Auth/Vault/secrets/gates changes **0**. No function/cycle/manual dry-run invocation, candidate injection, app activation or X post.
- rollback: **not required / not executed**, because source, authentication mode and invariants all passed. Pre-deploy downloaded source remains available; no improvised rollback.

## Delivery / remaining issues / next recommendation

- changed_files: `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md`, H1-only entry in `.agent/ACTIVE_TASK.md`, H1-only result section in `.agent/CURRENT_STATE.md`. Function/app source unchanged. All other slot TASKs/Reports retained.
- push: **PASS, verified**. Report-control commit `20d9e306c95b282bd2c91efcefe377b70ac130f3` pushed fast-forward to GitHub main; fresh fetch/read-back confirms the exact remote SHA, this Report and H1 `review_required` / `next_owner=chatgpt`. This acknowledgement adds no source/production change. Source commit_hash remains the deployed exact main above.
- deploy: **completed and independently read back**, single function only; merge/PR: none.
- remaining_issues: natural morning/close success/reuse observation not performed in this rollout task; G2's separate content-guard correction remains unmerged/undeployed. Pre-existing test-only lint finding remains. Consumer activation still unapproved.
- next_recommendation: C1 confirm this controlled-sync **PASS**, then arrange separately scoped natural-cycle observation with gates OFF. The existing packet schedules are 07:50 / 16:15 JST; do not invoke a real cycle manually. A source-sync PASS does not close G2 quality gates or authorize app/X cutover. **推薦モデル：Luna（中）** for C1 report confirmation. H1 stops here.


# H1 — PR #63 native data-source and Auth UX review (2026-09-30)

- task_id: `x-social-mobile-pr63-native-data-source-auth-ux-review-20260930`
- result: **PASS**; reviewed exact PR #63 head `5f2eae26bb1ee60c2bd7c7885c06816e86e8d852`. No source edits.
- GitHub re-check: PR open, unmerged, head unchanged, `mergeable=true`; Netlify deploy preview passed. Vercel check reports its 24-hour build rate limit; this is a native Expo app and current repository policy does not require Vercel for native PRs.
- Cross-platform data source: statically referenced Expo public env values bundle correctly; intended `supabase` mode selects the real repository, explicit unset/empty/`mock` remains preview, and invalid or incomplete settings stay blocked (never silently mock). Shared initial status and repository selection use the same decision. No service-role or production-only secret exposure found.
- Account-deletion UX: visible dismissible sign-in notice follows explicit server success; text distinguishes full login deletion from social-only deletion. Failure does not claim success; existing native Alert remains. Recent-auth/typed confirmation/session pinning/backend were unchanged.
- Signup UX: synchronous ref guard blocks same-tick duplicates; busy/sent feedback and 60-second cooldown are limited to successful signup. Accessibility status semantics are present. No Auth policy/provider behavior changed.
- Tests: app `npm test` **89/89 PASS**; data-view **14/14 PASS**; `npm run typecheck`, `npm run lint`, Expo Web export and iOS JS/Hermes export with synthetic public env, `git diff --check`, and focused secret/scope scan **PASS**.
- Scope: exactly 10 changed files under `apps/social-mobile`; no DB/RLS/RPC/migration/Edge/Vault/X/Apple/production setting changes and no overlap with other current-main source changes. Production mutation **0**.
- Limitations: no EAS/native binary build, Simulator/device interaction, live auth, real account deletion or provider operation was performed. These remain E3/runtime acceptance, not claims of this source review. Tests are deterministic/source-level for the changed boundaries.
- changed_files by H1: shared control files only (`.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md`, H1 entry in `.agent/ACTIVE_TASK.md`, H1 snapshot in `.agent/CURRENT_STATE.md`); app source unchanged.
- remaining_issues: none blocking source merge. Vercel rate-limit status is not a native-app merge gate under current policy.
- next_recommendation: C1 confirm this exact-head **PASS**, then continue the separately scoped native E3 acceptance. No production/auth/provider mutation is authorized by this review. **推薦モデル：Luna（中）** for C1 confirmation.

# H1 — PR #65 iOS X private authentication session (2026-10-01 JST)

- task_id: `x-social-mobile-pr65-ephemeral-x-auth-session-review-20261001`
- result: **PASS-WITH-FIX (tests only)**. No runtime/security defect found in the client change. Source is safe to merge **conditional on C1 and safe operator provider-side account-switch E2E**; merge remains on hold.
- original target: PR #65 head `e8a7785d5635096aa428899d28e629a95b7e3f31`.
- final reviewed head / commit_hash: `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`. H1 changed only `apps/social-mobile/tests/x-connect-auth-session.test.mjs`; all app/runtime source remains identical to the original target.
- isolation/startup: reused H1's clean independent checkout `/private/tmp/kabumori-h1-pr63-review-20260930`, own source/review and reporting branches. Fresh `git fetch origin` succeeded; main baseline `0e069e8e93358385d4f972d653d946aa4e459a27`. Shared dirty checkout and G3/G4 worktrees/Simulator were not altered. Read PROJECT_RULES/AGENTS/HANDOFF/ORCHESTRATION/current TASK/state/G4 Report. Current-main changes after the PR base do not overlap social-mobile source.

## Platform/API result

- Installed lock/package and module source are `expo-web-browser 57.0.3`. Its `AuthSessionOpenOptions` includes `preferEphemeralSession`; actual SDK JS forwards it to the native bridge. Swift `WebAuthSession` sets `ASWebAuthenticationSession.prefersEphemeralWebBrowserSession` after both custom-scheme and universal-link constructor paths. This app uses the existing custom scheme.
- The helper returns `{ preferEphemeralSession: true }` only for iOS. Other platforms receive an explicit **undefined third argument** (not literally a two-argument call); the SDK's default `{}` behavior is unchanged. A test verifies omitted versus undefined SDK arguments are equivalent.
- No dependency/plugin/config/native source changed. This JS change needs no new native option/config when the installed development binary already includes the locked native module. **The exact native module version inside that existing binary was not independently established**; confirm it or use a known matching build during operator E2E. No EAS/native build was performed.
- [Official Expo SDK 57 WebBrowser documentation](https://docs.expo.dev/versions/v57.0.0/sdk/webbrowser/#authsessionopenoptions) confirms iOS scope and that browser support determines whether this request is honored. The option avoids normal-browser cookie sharing when honored; it cannot guarantee an X account chooser. Current user hint states the browser caveat on both connect surfaces and is sufficient for this bounded change.

## OAuth/security invariants

- Parent-to-candidate diff changes only imports, the browser-call options and explanatory copy. HTTPS/X host validation, random 32-byte state/verifier generation, S256 challenge, fixed redirect validation, real callback parser/state checks, authenticated app-JWT headers and callback body remain unchanged. No ownership IDs or undocumented provider parameters were added.
- Executed mock success proves the exact request bodies, state/verifier/challenge and app-JWT header; negative probes reject wrong redirect/state/missing code and unsafe authorization host/protocol before callback/browser calls. Cancel/dismiss/provider denial, transient/terminal failures and non-success browser results cannot claim a connected handle. Single-flight and reconnect use fresh state/PKCE and the same iOS option.
- Server duplicate-account protection and all DB/RLS/RPC/migration/Edge/Vault/Auth/provider/posting paths are byte-unchanged in the PR. No global cookies/browser data are cleared. App-login provider flow remains separate. No secret leakage found in changed source/tests; only synthetic test values were used.
- Supabase skill security checklist was applied to credential separation and ownership boundaries. Its changelog index was attempted but returned an internal fetch error; no Supabase API/version/backend change is part of this PR. Expo package source and current official docs establish the changed API contract.

## Test correction and verification

The original tests mostly matched source strings. One purported server-protection test only searched the client hook, so it could not prove the server was untouched; an Android/Web label also overstated literal call arity. H1 narrowly replaced those claims with behavior checks, as explicitly allowed by the TASK. The actual hook is transpiled/executed with mocked React/Expo/Supabase dependencies and the real callback helpers; another check executes installed SDK JS through a captured native bridge. No live network/provider operation exists in this harness. Swift wiring is source-inspected, not a claim of device execution.

| Verification | Result |
| --- | --- |
| Focused X auth-session suite | 14/14 PASS |
| Full social-mobile `npm test` | 103/103 PASS |
| Data-view + post-interaction | 22/22 PASS |
| `npm run typecheck` / `npm run lint` | PASS / PASS |
| Expo Web / iOS export, fresh Metro cache, synthetic public env | PASS / PASS (895 / 1224 modules; iOS JS/Hermes export only) |
| PR scope / diff / secret checks | PASS; five intended client/test files, no forbidden paths |

## Delivery and remaining gate

- changed_files: H1 test file above plus H1-only completion controls (`.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md`, H1 entry in ACTIVE_TASK and H1 result section in CURRENT_STATE). Other slot TASKs/Reports preserved.
- push: test amendment **PASS**, fast-forward pushed to the existing PR #65 branch; exact new source head `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`. Report-control sync is performed separately; read-back must confirm review_required/next_owner before claiming delivery complete.
- deploy / merge: none. production_mutation=0; real X login/post/revoke, credential entry, account deletion, DB/Vault/Auth/provider settings changes=0. No overlap with G3's destructive operational E3.
- remaining_issues: safe operator E2E must confirm on a disposable account/device that prior normal-browser X identity is not silently reused and a different X account can authenticate, including cancel/retry/reconnect. The private-session request may be ignored by a browser/provider and requires truthful fallback expectations. Current copy acknowledges this; no success is inferred from source tests. Confirm the development binary's native module compatibility as above.
- next_recommendation: C1 accept the final source head, retain merge hold until the TASK's operator account-switch E2E passes, then perform the normal source merge decision. **推薦モデル：Luna（中）** for C1. H1 stops after report synchronization; no provider-side automation is authorized.

---

# H1 — PR #67 shared market report Presentation v2 review (2026-10-01 JST)

- task_id: `kabumori-pr67-shared-report-v2-hard-fact-review-20261001`
- result / verdict: **PASS-WITH-FIX (source/tests)**. C1 required; no merge, deploy, consumer activation or real X operation performed.
- original reviewed head: `5877045f7554cd4e089fb3b79091bf8e2bb38456`.
- final reviewed / pushed source head: `d6f9c9a0285920871d0ce86cc4559f9675c0ebb9`, fast-forward pushed to `g2-shared-report-v2-20261001` / PR #67.
- startup main: `7e28f338b61ebd3d9bb6f323d75f50cd4a10b4c9`; fresh main before source push / report preparation: `ea651356d91d93c636c3fe56402888e5e54d9d04`.
- isolated owned checkout: `/private/tmp/kabumori-h1-pr63-review-20260930`, source review branch `codex/h1-pr67-fact-review-20261001`, separate control branch `codex/h1-pr67-report-20261001`. Shared Developer checkout and other slot directories/branches were not changed. H2/PR #66 remained isolated.

## Findings — fixed within TASK's local-fix authority

Every correction was driven by an executed failing adversarial assertion, followed by focused and regression reruns. Initial additional suite: 1 passed / 10 failed; further negation/news-order/false-positive probes were added and fixed. Final additional suite: 13/13 PASS.

1. **P2 — safe draft lost on quality-request exception.** A first generation that passed local Hard checks and Fact was discarded if the quality generation or its Fact request exhausted 429 retries/threw. The handler then failed the cycle. Only after a safe draft exists, request failures now deliver that original; the first/no-safe-draft transport error still fails closed. `quality_rewrite_request_failed` is a boolean diagnostic, with no exception/body/credential logging.
2. **P2 — malformed nested output bypassed regeneration.** Null/non-object members of claims/news/themes threw TypeError while parsing. They now classify as invalid output, consume the existing generation budget and can regenerate to a safe second draft.
3. **P2 — factual association holes.** The guard accepted a metric's daily-change number as its absolute price (or vice versa), list subjects could borrow one member's session date, collectively wrong direction or signs. Separate value/change token sets, canonical numeric matching, referenced-member dates and member-specific signs now detect the tested cases. This also closes the mixed-session list variation of the 10/1 regression.
4. **P2 — stale data described as current despite a correct historical date.** A correct date previously excused a contradictory “latest/current” qualifier. The new qualifier check is bound to the metric clause; unrelated latest news and explicit unavailable-current-value wording remain safe.
5. **P2 — opposite emojis concealed in one mixed-direction line.** A line containing both chart emojis skipped the check. Japanese clause boundaries now let each chart emoji be compared with its own metric, without rejecting correctly paired down/up clauses.
6. **P2 — historical assertions in caution/watch escaped factual checks.** Forward fields could contain an asserted past move/cause. Past-tense factual prose now receives direction and causal checks; future conditional watch wording remains allowed.
7. **P2 — scoped absence false positive.** “この銘柄には材料がありません” / “日銀についてはニュースがありません” were classified as broad absence solely because は preceded the noun. Explicit local qualifiers now remain allowed; a later unscoped absence clause, “入力については…”, and original false broad-absence regressions still block when news exists. This does not claim a scoped statement is automatically true; existing holding-specific guards and the complete Fact check remain authoritative.
8. **P2 — negative direction statement false positive.** “NYダウは上昇していません” was read as a positive assertion of a rise. Direct Japanese negations now do not become direction inversions; actual inverse statements still block.
9. **P2 — actual model input contradicted broad-first ordering.** Although internal news was broad > sector > company, a second major-news sort promoted an emergency sector item ahead of a broad-market item. Model input now preserves the same deterministic reach ordering; importance remains explicitly marked without reordering the scope tiers.

No remaining demonstrated P1/P2 issue in the reviewed PR scope after these fixes. Deterministic prose checks cover explicit supported wording patterns, not all possible Japanese paraphrases; they are not a replacement for the unchanged full Fact check. No architecture/model-call/schema change was made.

## Hard vs WARN, mixed sessions, fallback and budgets

- Hard checks still include unsupported numbers/refs/news, TOPIX proxy mislabel, unsupported asserted cause, materially wrong metric/date/direction, false broad absence, malformed mandatory content and unsafe structured output. Fact must return literal `passed: true` before any draft is safe.
- Target prose/length, missing optional sections, emoji count and editorial weakness remain WARN. WARNs alone do not fail a locally/Fact-safe cycle. Unsupported themes are removed from the packet rather than delivered as facts.
- Exact 10/1 regression: 9/29 Nikkei 65,481.27 / −0.60% cannot be put under 9/30 with 9/30 ETF 1306 431.5 / +1.43%. Original screenshot variants, list variant, honestly dated values, omitted unknown values, reused original-session values and code-rendered per-date App lines pass the required assertions.
- Safe original + WARN -> rewrite Hard: original delivered; -> rewrite Fact failure: original delivered; -> generation/Fact exhausted 429: original delivered. No safe original -> persistent Hard or request failure: fail closed. Malformed nested first draft -> valid second draft: delivered.
- Bounds unchanged: at most 2 content generations and 2 Fact calls. Transport retry retains its shared per-run budget (3 extra HTTP requests) and per-call cap (2). Tests of exhausted rewrite-generation / rewrite-Fact 429 use fake fetch/sleep: 5 / 6 HTTP requests respectively, 2 retries, original generation 1 delivered. No real network, waiting or LLM cost.
- Content generations, local/Fact/invalid rejection, delivered generation, quality rewrite request failure and transport retries stay distinct. Existing handler test proves local rejection -> safe regeneration gives generation_attempts=2, content_regenerations=1, hard_rejections=local, transport_retries=0, one claim and one completion. Scheduled Cron retries remain outside this local loop.
- Successful-response usage/cost counters retain existing semantics; failed requester calls without a returned StepResult do not invent token usage. No cost-estimate accuracy claim is made from mocked responses.

## Compatibility, public output, App boundary and news

- Existing SQL was inspected read-only: table schema_version remains `market_report_packet.v1`, payload permits additive JSON members, identity checks remain unchanged. Optional presentation_version / app_story / session_views do not require a migration. No migration file or DB setting was edited/applied.
- Stored v1 fixtures still render the prior X format. App fallback copies existing summary/news/metrics and supplies dated fact lines; it does not invent a longer narrative. Report ID/data ID/hash contracts and canonical content-hash behavior are unchanged; generated_at remains excluded from content identity as before.
- v2 X section order, exactly three nonempty points, optional context/news/watch, URL/hashtag/internal-label rejection and warning-only short safe output were reviewed/tested. Consumers format the same packet without another market generation or web lookup. The fixed brand hashtags remain appended in the existing trusted posting path.
- App story and shared input have no holdings/user arguments; shared market facts remain verbatim while personalized information is separately added. Regression suites cover no cross-user/portfolio leakage, immutable shared identity and all-user shared-story equality. No native UI change was attempted.
- News priority remains broad > sector > company; isolated company critical disclosures are kept as company news rather than mandatory market-wide leads. Model input now follows the same scope order. Existing systemic-category exceptions and company-code/category inference were reviewed; no taxonomy/schema change was introduced.
- Genuine sparse input, unknown causes, scoped absence and future watch wording remain deliverable. False broad absence in shared and personalized paths remains a Hard code (`FALSE_BROAD_NO_MATERIAL_CLAIM` is in the existing block classification).

## Verification

Tests were run offline with mock provider/DB requests. `--no-config` isolates Deno from this clone's unrelated Node/mobile dependency resolution (the first unisolated attempt could not resolve local npm @types/node).

| Verification | Result |
| --- | --- |
| market-report-analysis, all tests including transport/handler/content/quality | 86/86 PASS |
| presentation_v2 (included above) / new H1 adversarial (included above) | 22/22 / 13/13 PASS |
| personalized-reports full suite, including shared story/absence/boundaries | 128/128 PASS |
| market-report-data-packet regressions | 42/42 PASS |
| X shared-market consumer suite | 8/8 PASS |
| Combined preceding full suites | 264 passed, 0 failed |
| _shared full runtime suite with --no-check | 329 passed, 0 failed |
| deno check, analysis + personalized runtime entries and X shared consumer | PASS |
| deno lint, affected runtime files + new adversarial test | PASS |
| git diff --check | PASS |

Whole `_shared` suite **with** typechecking is not clean under installed Deno 2.9.6 / TypeScript 6.0.3: five errors, three in unchanged `brand/brand_post_generator_test.ts`, one in unchanged `brand/dispatch_gate_test.ts`, one BufferSource/Uint8Array generic error in unchanged `x_oauth2_post.ts`. These paths are byte-unchanged from the pre-PR base; they were not repaired or hidden as a successful whole-repository typecheck. Relevant changed runtime entries and checked targeted tests pass.

G2's claimed eight production Fact-passed packet replays are accepted reported evidence, **not** eight new live DB replays performed by H1. H1 independently executed the committed stored-v1/date/session regression fixtures and safe-rich/unsafe/scoped/sparse probes. Actual model generation and natural production cycles were not invoked.

## Changed files, delivery, safety and rollout prerequisites

- source changed_files (H1 amendment only):
  - `supabase/functions/market-report-analysis/h1_adversarial_test.ts` (new)
  - `supabase/functions/market-report-analysis/hard_fact_guards.ts`
  - `supabase/functions/market-report-analysis/analysis_logic.ts`
  - `supabase/functions/market-report-analysis/analysis_input.ts`
  - `supabase/functions/market-report-analysis/presentation_v2_test.ts` (diagnostic expectation)
  - `supabase/functions/_shared/absence_claims.ts`
- control changed_files: `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md`, H1-only ACTIVE_TASK entry and a new H1 CURRENT_STATE section. Previous histories and other slot status/content retained.
- source commit_hash / push: `d6f9c9a0285920871d0ce86cc4559f9675c0ebb9` / confirmed fast-forward PR #67 branch push. Control files synchronized separately to main; completion requires read-back of the review_required/next_owner values.
- deploy: none; merge: none; production_mutation: **0**. No production DB/API calls, gate toggles, manual report cycle, Cron/Auth/Vault/OAuth/secret change, X post/media upload or other Function deploy. App/X activation remains forbidden. Supabase skill safety boundaries kept this a source/offline review; no Supabase API-version/schema implementation occurred.
- remaining_issues / rollout prerequisites:
  1. C1 must accept exact final head before a source merge decision. Production deploy and consumer activation require separate authority.
  2. Actual model-generated v2 completion rate, factual rejection rate, quality fallback frequency, prose quality and real token cost remain unobserved. Check natural cycles in a separately approved rollout; hand-written mocks are not live-model evidence.
  3. Approximately 500 Japanese characters plus fixed hashtags require verification of the actual target X account/API long-post entitlement and posting contract. Source's 80–900 character bounds are application structural limits, **not proof of provider acceptance**. Do not turn X on or treat WARN-length output as provider-valid until this gate is established.
  4. Native story rendering is a separate G1 scope; this PR only carries the structured story in market_detail. No native simulator/device story UI verification is claimed.
  5. Whole-_shared unrelated type errors remain outside this TASK; partial historical replay coverage is explicitly scoped above.
- merge recommendation: source-safe **after C1 accepts the amended head**; no merge/deploy/activation automatically follows this report. Keep production gates OFF until the separate prerequisites/approvals are satisfied.
- next_recommendation: C1 review of final head/report, **推薦モデル：Luna（中）**. H1 STOP after control read-back; do not continue into deployment or another task.

---

# H1 — Kabumori account deletion cross-service safety review (2026-10-01 JST)

- task_id: `common-account-kabumori-delete-cross-service-safety-review-20261001`
- result / verdict: **FAIL / CHANGES REQUIRED** for the existing account-deletion boundary. Review completed; no runtime correction claimed.
- exact reviewed main: `59108acab7c8445c169bbd05f24f10af4f120ce7` at startup; completion baseline `6e262b0b2f17386c55924f757c19abc7d48b89e8`. The intervening commit changes only G2's Report, not reviewed runtime or H1 controls.
- isolated checkout: `/private/tmp/kabumori-h1-pr63-review-20260930`, own branch `codex/h1-kabumori-delete-guard-20261001`. Shared Developer checkout, other slot worktrees/branches/dev servers and synced project sources were not changed.
- startup: fresh origin/main, PROJECT_RULES / AGENTS / HANDOFF / ORCHESTRATION / CURRENT_STATE / H1 TASK / G5 Final K5 and full Report checked. Open PR changed-file checks (#68, #65, #41, #33, #11, #10, #3) found no current Kabumori account-delete runtime overlap. Existing historical H1 control PRs were not merged or reused.

## Independent production / source verification

Read-only function metadata/source and catalog/aggregate SELECTs were performed through the available Supabase connector. No user ids, emails, handles, credential values or Vault data were read into this Report. G5's findings were not treated as proof without this independent check.

- production `account-delete`: **ACTIVE, version 8, verify_jwt=true**. Both retrieved files (`account-delete/index.ts`, `account-delete/delete_logic.ts`) are byte-equal to local main. Deployment bundle hash: `0f1cc97736e3e1add7e3f8068bcb83fec85dc421f83d7fe2a9276b6cb8f60c62`. Existing comments saying the introducing task did not deploy are historical, not current deployment evidence.
- current main UI exposes Settings -> account deletion. `src/app/settings.tsx:183` implements email retyping then deletion; `src/lib/account-deletion-client.ts:8` invokes the deployed function with the current session token and public key. There is no cross-service/admin feature gate on this entry. Device-installed app reachability was not independently exercised.
- `delete_logic.ts:89` resolves caller identity through `/auth/v1/user`; lines 93–104 then directly issue hard `DELETE /auth/v1/admin/users/{verified id}` using service role. It reads no ownership/other-service/tombstone state. Client ids cannot target a different user; caller JWT validation and non-success error reporting are intact. The service key remains server-only, fixed errors do not expose it, and no client metadata drives privileged authorization.
- aggregate at review time: Auth users **4**, Kabumori profiles **2**, admin memberships **1**, admins with a Kabumori profile **1**, users with an X membership **1**, Kabumori + user-facing X dual users **0**, active unconsumed user-initiated OAuth states **0**, social deletion tombstones **0**, ownerless user-facing workspaces **0**. No current cross-service corruption is inferred from this snapshot; zero dual users is not a server-side protection.

Production FK metadata confirms:

| Shared Auth deletion effect | Boundary |
| --- | --- |
| `profiles.id`, `admin_users.user_id`, `brand_memberships.user_id`, `social_account_oauth_states.initiated_by_user_id` | Auth-owned references use ON DELETE CASCADE |
| `tracked_stocks`, `alert_settings`, `alert_category_settings`, `notifications`, `device_push_tokens`, `personalized_reports` | User data cascades through profiles |
| `brands`, `social_accounts`, workspace posting rows | No direct Auth ownership cascade removes these workspaces/accounts; other brand/account FKs do not turn Auth deletion into full workspace cleanup |
| X authorization / Vault credentials | No revoke/cleanup in Kabumori function; potential remnants, not a claim that any token was inspected or an orphan currently exists |

Non-internal trigger metadata contains **no trigger on auth.users or admin_users** and no pre-delete cross-service guard on profiles. The relevant X guard triggers run BEFORE INSERT OR UPDATE on workspaces/memberships/OAuth state, not when Auth cascade deletes memberships. The deployed OAuth-start RPC remains executable by `authenticated`, creates a workspace/membership, and updates social accounts. Existing deletion acquisition uses a tombstone/advisory lock and updates posting/workspace state; those are not operations this Kabumori function performs.

## Findings by severity

1. **P1 — admin self-deletion has no authorization guard.** `supabase/functions/account-delete/delete_logic.ts:89–104` allows any verified caller to reach the privileged hard-delete request, including an admin. `admin_users` then cascades if the Auth deletion succeeds. The current population contains one admin with a Kabumori profile, so this is not only a future dual-service case. No live deletion was used to establish it; Storage/other unrelated constraints could still make a particular Auth deletion fail, but they do not implement an admin policy.
2. **P1 — one-service deletion can erase other-service ownership without ending its authorization.** The same path can remove X membership and user-initiated OAuth state, while workspace/social accounts and any associated credential/permission state are not cleaned up or revoked. The UI promises deletion of the login account without explaining that cross-service scope. Zero current dual users makes this a latent defect today, not safe behavior for common accounts.
3. **P2 — no server-enforced recent reauthentication.** `/auth/v1/user` verifies a token/current user, not an explicit recent password/provider proof. Email retyping is client-only and is bypassable by a direct function request; there is no last-authentication/session-age check. Source tests accept a mock user whose last_sign_in_at is years old. After success, the app signs out best-effort, but the function provides no strict immediate access-token invalidation guarantee. Supabase documents that user deletion does not by itself make already-issued JWTs expire immediately. This is a separate common-lifecycle requirement, not justification for an unapproved auth redesign here.

These are defects in existing source/production behavior, not introduced changes. The ordinary identity/secret/non-success boundaries covered by the 23 existing tests remain valid.

## Interim guard decision — no runtime patch within this authority

A fail-closed check should reject admin ownership, **any** relevant X membership/workspace, active/pending OAuth, existing deletion state, unknown/shared-service evidence and failed/malformed/incomplete reads. The user-facing response must be a non-success requiring a service-specific/common lifecycle path, without exposing ownership details. A caller who is unambiguously Kabumori-only should retain a lawful deletion path.

However, an Edge-only sequence of read checks followed by a separate GoTrue/Auth DELETE is not deterministic exclusion:

1. Kabumori checks read no X footprint.
2. Concurrent authenticated OAuth-start creates/commits workspace, membership and state.
3. Kabumori hard-deletes Auth; membership/state cascade, workspace/account can remain.

This is a source/catalog-supported race analysis, **not** a live race reproduction. Repeating a final SELECT does not remove the check/delete gap. Absence of a workspace also does not encode an explicit other-service registration/entitlement, which Phase 0 identified as missing.

The existing X `social_mobile_account_deletion_acquire` cannot be copied/called as a read-only Kabumori guard: it writes tombstone/audit state, disables posting/account authority, fails pending posts and chooses X-specific scope from profile presence. Its `social_only` scope intentionally preserves Auth when a Kabumori profile exists. The workspace advisory lock held by a read-only RPC transaction would expire before a later GoTrue request; it is not an across-request deletion lease. Reusing acquisition/finalization changes lifecycle/other-service semantics, while a new durable guard/serialization boundary requires separately authorized DB/orchestrator work.

Therefore the TASK's explicit **“if schema/new lifecycle orchestrator/broad cross-service semantics are required, do not implement”** stop condition applies. No partial preflight is advertised as safe, no blanket disable of legitimate Kabumori-only deletion was silently introduced, and no X/Vault cleanup was added. **No runtime/source candidate exists to merge or deploy from this H1.** Production behavior remains unchanged and requires a separately approved mitigation/correction; this Report does not itself disable the risky route.

## Verification / limits

| Check | Actual result |
| --- | --- |
| `deno test --no-config --allow-read supabase/functions/account-delete/ tests/app/account-deletion_test.ts` | **23 passed / 0 failed**, final rerun against completion baseline |
| Offline synthetic probes of current logic | **4/4** observed the mock hard-delete call for admin, X membership, pending OAuth and old last_sign_in_at; fake fetch only, no live network |
| `deno check --no-config` (runtime entry and three focused test files) | PASS |
| Runtime lint: index.ts / delete_logic.ts / src/lib/account-deletion.ts | PASS |
| Combined account-delete + client-test lint | **5 existing require-await errors** in unchanged test mocks: delete_logic_test.ts:16,143; tests/app/account-deletion_test.ts:36,50,62 |
| Source/caller/secret path, deployed byte read-back, FK/cascade/trigger/aggregate checks | Completed read-only |
| `git diff --check` / control-history preservation check | PASS; exactly four H1 controls changed, prior Report/TASK/state and non-H1 index content preserved |

The four probes establish **missing checks**, not the safety of a new guard; their footprint labels describe synthetic contexts the current function never queries. They were an in-memory Deno eval, not newly committed acceptance tests. No database race, real Auth deletion, X revoke, Vault mutation, iOS/device or provider E2E was run. No new source/type/lint error was introduced because runtime/tests are unchanged. Full-repository checks were not claimed.

## G5 Phase 1 / separately scoped acceptance gates

After C1 accepts the findings and G3/G4 overlap is reconciled, scope an explicit common/service lifecycle design rather than infer service membership solely from profile/workspace absence. It must distinguish Kabumori service withdrawal, X withdrawal and whole-login-account deletion, and serialize deletion intent with workspace/membership/OAuth provisioning. Admin/shared/unknown cases must fail closed; provider revoke, credential cleanup and Auth destruction need their own authorized ordering/consent/retry boundaries.

Required regression tests for that future correction: verified unambiguously Kabumori-only allowed; admin/X/other-owner/pending OAuth/derived workspace without membership/deletion in progress/unknown service denied; lookup permission/network/malformed-data failures denied before any destructive call; concurrent create-vs-delete outcomes safe in **both** commit orders; service-only withdrawal leaves the other service/Auth untouched; stale/revoked sessions and recent-authentication rules; truthful client non-success; no secrets in errors/logs. These are proposed requirements, **not implemented/passing tests in this H1**.

## Delivery / safety / next owner

- changed_files: `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md` (append only), H1 section only of `.agent/ACTIVE_TASK.md`, new H1 section only of `.agent/CURRENT_STATE.md`. Prior reports and other slot controls/runtime remain intact, including pre-existing malformed index text outside H1.
- commit_hash: runtime commit **none**; report/control commit is the Git commit containing this appended task_id section (exact hash to be supplied with confirmed publication/read-back in the completion reply).
- push: control-only synchronization to GitHub is attempted after this report is committed; no source branch/PR push, merge or deployment is part of the review. Publication is complete only after remote task/report read-back; do not infer it from this prepared text.
- deploy / Auth deletion / provider revoke / migration / production DB or Vault write / Cron or flags / real X operations: **none**. **production_mutation=0**. Read-only metadata/aggregate queries and function retrieval only; no credentials/PII exposed. Supabase skill security checklist drove independent Auth/cascade/key checks and the refusal to treat token validity or a preflight read as sufficient deletion safety. Official Auth deletion/current-user/managing-data docs were consulted; changelog index retrieval failed due unsupported markdown content type and was not repeatedly retried.
- source_safe_to_merge: no new runtime candidate; existing cross-service hard-delete is **not approved as common-account-safe**. Control/report publication is safe; deploy recommendation **HOLD**, no deploy approval requested by this review.
- remaining_issues: P1/P2 findings above; explicit service registration and lifecycle serialization; separate production mitigation authority; provider cleanup/recent-auth/session design; future behavior/concurrency E2E. No claim of already-corrupted users.
- next_recommendation: **C1, 推薦モデル：Sol（高）** to accept findings and independently decide/scoped-authorize the next G5 Phase 1 or interim mitigation. This TASK does not allocate another slot or grant production authority. H1 status `review_required`, next_owner `chatgpt`; STOP after safe control synchronization/read-back.

---

# H1 — PR #70 common-account lifecycle foundation review (2026-10-01 JST)

- task_id: `common-account-pr70-lifecycle-foundation-review-20261001`
- result / verdict: **FAIL / CHANGES REQUIRED**. Review completed; source merge, production apply/backfill and deploy **HOLD**.
- exact original / final source head: `89cf128bd9219897806b2b641cce4866f6e16c52` (unchanged), PR [#70](https://github.com/anohi-memories/kabumori/pull/70), base `26ea17942fb8900cd78a3c58959809aa86239ace`.
- reviewed main: initial `2930f75f2b4fce4418e4b243a7c3720e6e9dfccd`; fresh resumed / completion baseline `93021d6d270c0aeabb3f4cd75a6affaaf54fd00a`. Base-to-main changes touch only orchestration/G5/G2 controls and the AI Lab diary/snapshot, not the seven PR source/test/doc files. PR head unchanged. G4 PR #65/client files untouched.
- isolation: the reset removed the first `/private/tmp` checkout and cluster. Restored into a new H1-owned checkout `/private/tmp/kabumori-h1-resume.DHxA95/repo`, own review branch and separate control/report branch. Shared `/Users/yuya/Developer/kabumori` is dirty and was inspected read-only, never modified/staged/checked out. Synced `sources/`, other slots, servers and worktrees untouched.
- startup: fresh fetch; current TASK ready verified directly on origin/main; PROJECT_RULES/AGENTS/HANDOFF/ORCHESTRATION, CURRENT_STATE/ACTIVE, G5 Phase 1 TASK/Report and prior C1 consulted. Entire candidate SQL/tests/runner/rollback/design reviewed. No subagent.

## Independent findings — six reproduced counterexamples

All SQL counterexamples used fake identities in a dedicated local PostgreSQL database, as the non-superuser fixture owner with explicit authenticated/service_role calls where applicable. There was no live Auth deletion or production backfill. Paths/line numbers below refer to the exact PR head.

### 1. P1 — Auth DELETE reports completion while Storage-owned data remains

`supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql:785` directly deletes `auth.users`, catches FK violations, then returns `completed` (lines 795–799). The footprint/blocker helper checks Kabumori/X/admin data, not Storage ownership. The G5 Report's expectation that Storage ownership is blocked by an FK is not true for the independently inspected production schema.

Read-only production catalog evidence: `storage.objects` / `storage.buckets` have deprecated `owner uuid` and current `owner_id text`; the only FK on these two tables is `objects.bucket_id -> buckets.id`. Neither ownership field references Auth. Auth users/sessions/identities are owned by `supabase_auth_admin`; Storage tables by `supabase_storage_admin`. No Storage contents, user ids, emails, tokens or Vault values were read. Earlier privilege metadata showed postgres DELETE ability; that does not prove managed-service behavior.

Local reproduction: add minimal `storage.buckets(id,owner,owner_id)` and `storage.objects(id,bucket_id FK,owner,owner_id)` with that production ownership/FK shape. Give a fresh Auth-only fake user an object with `owner_id = user_id::text`; call begin(version 1), then finalize with its returned operation id as service_role. Actual outputs:

```text
STORAGE_OWNER_FINALIZE={"status":"completed"}
STORAGE_ORPHAN=true
```

This is a schema-shaped PostgreSQL proof, **not an actual Supabase Storage/S3/GoTrue E2E** and not evidence of a current live orphan. It demonstrates that the SQL path has no ownership blocker: the Auth row disappears while the object metadata owner remains. SQL Auth deletion is not rejected merely because Auth is managed; current docs permit direct deletion in some contexts. The defect is this candidate's unsupported completion/cleanup guarantee. [Supabase ownership docs](https://supabase.com/docs/guides/storage/security/ownership) identify `owner_id`; [Storage schema docs](https://supabase.com/docs/guides/storage/schema/design) require object deletion through the Storage API, not metadata DELETE; [Auth user-management docs](https://supabase.com/docs/guides/auth/managing-user-data) document deletion/session/Storage restrictions.

Required correction: explicitly enumerate/block managed-service and unknown ownership, establish provider cleanup ordering and reliable retry/failure behavior, and prove no concurrent producer can create new owned state between inventory/cleanup/Auth deletion. Merely adding a one-time Storage SELECT does not supply serialization (Storage ownership has no Auth FK). Do not delete Storage SQL metadata as a fix. Decide/document the supported final Auth destruction contract and demonstrate it on disposable real Supabase before claiming readiness. This is G5 lifecycle/managed-service architecture work, not a bounded H1 patch.

### 2. P2 — backfill adds a service without invalidating an empty deletion preview

Candidate lines 895–924 insert a new common account at default version 1 and its entitlements within one data-modifying CTE command. The `bumped` UPDATE cannot see the common row inserted by its sibling CTE; it increments pre-existing rows only. `common_account_deletion_eligibility` reports version 1 when the account row is absent; begin lines 639–658 treats that same 1 as valid.

Actual sequence: fresh Auth-only fake user -> eligibility shows `account_status=none`, `services=[]`, `blockers=[]`, version 1 -> insert a legacy profile -> backfill(true) -> common row plus active Kabumori entitlement remain version 1 -> begin with the old 1 returns `started` with `services_to_end=[kabumori]`. Outputs:

```text
POST_BACKFILL_VERSION=1
OLD_PREVIEW_ACCEPTED={"status":"started", "services_to_end":["kabumori"], ...}
```

No service cleanup/finalization was executed for this case. This violates the documented confirmation contract, not immediate deletion by begin alone. Require an unambiguous initial/absent-state epoch or equivalent consent binding and version invalidation for every entitlement-introducing path, including new-account backfill. Do not special-case the test by ignoring absent previews.

### 3. P2 — backfill grants active entitlement after a concurrent account lock commits

Candidate lines 891–928 materialize eligibility without acquiring the lifecycle auth/common locks, then insert entitlements and bump common state later. The snapshot's `account_status='active'` is stale by the time insertion occurs.

Two-session proof: existing fake active common account + legacy profile but no entitlement; test-only BEFORE INSERT trigger pauses its backfill for 3 seconds. Detect `pg_stat_activity.wait_event='PgSleep'` (not a guessed delay), then a second owner/operator transaction sets account status `locked` and commits. Backfill resumes successfully. Actual `BACKFILL_GRANTED_WHILE_LOCKED=true`: status locked with active Kabumori entitlement. The pause trigger was removed afterward.

This specifically reproduces concurrent operator hold/reserved-state transition; it does **not** claim that public begin can delete an unregistered legacy profile (that separate blocker correctly denies it). Require a consistent auth -> common lock order, post-lock eligibility/version revalidation and concurrency coverage for backfill, not only public start/finalize. The offline/quiescent-only assumption is not currently an enforced backfill contract.

### 4. P2 — an admin who also owns a self-service workspace is not excluded

Candidate `x_owner` lines 817–828 filters workspace/profile/sole-owner status but never checks `admin_users`. The `excluded_admin_users` field at line 882 merely counts admins and does not filter the insert.

Fake user in admin_users plus sole owner of its correctly derived self-service workspace -> `ADMIN_IS_X_CANDIDATE=true`, then backfill -> `ADMIN_GRANTED_X=true`, while the same report says excluded_admin_users=1. Internal/shared workspace exclusion passes for the original fixtures, but it does not prove admin exclusion for mixed-role users. Add actual admin exclusion and test the intersection; keep Kabumori legacy evidence semantics distinct from X consumer grants. No production admin was modified.

### 5. P2 — preflight accepts an unrelated-column Auth FK

Candidate lines 109–134 ask whether profiles/membership/OAuth tables have **any** FK to auth.users (profiles additionally CASCADE). They do not bind `conkey/confkey` to the required caller/owner columns. The finalization serialization argument relies specifically on `brand_memberships.user_id` and OAuth `initiated_by_user_id` referencing Auth id, not some other column.

Local drift proof, after rollback: remove `brand_memberships_user_id_fkey`; add nullable `unrelated_auth_id uuid REFERENCES auth.users(id) ON DELETE CASCADE`. Reapply the original unmodified candidate. It succeeds and produces `WRONG_COLUMN_FK_PREFLIGHT_ACCEPTED=true`, despite no Auth FK on membership.user_id. This is a hypothetical schema drift proof, **not a claim that production has that wrong FK**. Validate exact referencing/referenced columns, expected type and relevant timing/action/validation properties for every invariant-bearing dependency, plus required function signatures/columns; refuse mismatches atomically. Do not repair production schema under this TASK.

### 6. P2 — rollback disables effective enforcement when the settings row is absent

`supabase/tests/common_account_lifecycle_rollback.sql:16` rejects only if an existing row has mode other than shadow. Runtime guard (candidate lines 410–414) treats a missing row as enforce. Those contracts disagree.

Local sequence: resolve all fake in-progress operations to aborted; delete the sole settings row. A direct Auth delete is correctly blocked with `COMMON_ACCOUNT_DELETE_NOT_AUTHORIZED`. Immediately run the original rollback: it succeeds, dropping the guard/common objects; `MISSING_SETTINGS_ROLLBACK_REMOVED_GUARD=true`. Require affirmative valid shadow state, not absence of a non-shadow row, and cover missing/corrupt state before teardown. No production rollback occurred.

## Boundary verdicts / what passed

- **Lifecycle serialization: partial PASS, overall insufficient.** Original start/delete both commit orders, old profile and real X onboarding creator races, duplicate operations/start, decision window, READ COMMITTED rejection and standalone legacy-delete lock order pass. Finalize holds auth FOR UPDATE then common FOR UPDATE through blocker checking/SQL delete in one transaction. External provider steps remain a saga; no cross-request atomicity is proven. Backfill and the absent-account version hole above prevent an overall PASS.
- **SQL Auth deletion: CHANGES REQUIRED / production HOLD.** FK exception handling uses a subtransaction and leaves a retryable operation on 23503; unrelated unhandled errors roll back the call. This is not managed-service cleanup/session/identity equivalence. Real Supabase role boundaries, GoTrue behavior and JWT/session/Storage proof remain unexecuted. Do not claim deleted JWTs become instantly invalid; strict checks/recent reauthentication and future provider orchestration need separate integration gates.
- **Guard: expected shadow/enforce/cascade/23503 behavior PASS in the local model**, rollback missing-setting defect FAIL. Trigger is on common_accounts only: users without common rows are not protected. Shadow intentionally allows legacy Auth deletes, so this PR does not make current Kabumori deletion safe. Full enrollment plus all creator/deleter wiring must precede enforcement. Table owners/superusers can disable triggers/use replica mode; application ACL does not constrain privileged maintenance. Legacy X finalization's 23503 -> `operator_required/LOGIN_DELETE_BLOCKED` is confirmed in real candidate source and exercised by the behavior suite.
- **ACL/RLS/SECURITY DEFINER: PASS in tested model.** All four new tables have RLS. Public tables allow authenticated self SELECT on the intended columns only; no client write/TRUNCATE/REFERENCES/TRIGGER, no source/evidence SELECT, no service_role table grants. Client start is auth.uid()-bound, no arbitrary id argument. Private helpers/view denied to client roles; RPC EXECUTE limited to intended role after PUBLIC revoke in same transaction; empty search_path and schema-qualified targets; no user_metadata authorization. Service-role caller id verification is a future Edge obligation, not implemented by comments. No real PostgREST proof claimed.
- **Backfill: FAIL** for findings 2–4. Idempotent/no overwrite/no email merge/legacy-profile evidence/auth-only behavior passed normal fixtures; mixed-role and concurrent-state exceptions did not.
- **Preflight/rollback: FAIL** for findings 5–6. Additive one-transaction application, rejection of a missing known column/double apply, normal rollback byte-match and reapply passed. Added registered downstream view -> rollback refused with dependency error and transaction preserved common_accounts (`DEPENDENCY_ROLLBACK_PRESERVED=true`). This does not prove detection of untracked PL/pgSQL/dynamic/client dependencies; rollback is pre-integration only. Migration-history drift remains a separate exact production preflight/apply gate.
- **Service semantics: normal fixture PASS**, global readiness FAIL. Kabumori-only withdrawal preserves login/X; X service cleanup uses the real existing saga; whole deletion cannot finalize with non-ended entitlement; admin/shared/internal/unregistered known footprints/Apple checkpoint denied as designed. Existing X profiles-proxy and current Kabumori hard-delete are explicitly **not corrected** by this source-only PR. No provider revoke was performed.

## Independently executed verification (including reset recovery)

The reset removed scratch state; all baseline suites and the material counterexamples were independently rerun on a fresh owned PostgreSQL **17.11** cluster, Unix socket only (no TCP/remote URI). Application SQL ran as `kb_common_account_owner`, non-superuser. The superuser only creates/drops throwaway DBs/roles. Production metadata was SELECT-only.

| Check | Actual result |
| --- | --- |
| `common_account_lifecycle_run.sh` | **16 PASS checks**, including behavior/8 race scenarios/isolation/no deadlocks/schema-additive diff/normal rollback exact schema dump/reapply/cleanup |
| `social_mobile_account_deletion_run.sh` | **8 PASS checks**, including real existing X lifecycle concurrency regression and cleanup |
| `deno test --no-config --allow-read supabase/tests/migration_source_invariants_test.ts` | **10 passed / 0 failed** |
| `bash -n supabase/tests/common_account_lifecycle_run.sh` | PASS |
| `deno lint --no-config supabase/tests/migration_source_invariants_test.ts` | PASS |
| Scratch-only mutation: remove common_accounts `FOR UPDATE` in account_lifecycle_lock | Original suite **fails race 7**, begin decided `started` on stale state; defective-copy process exit 1 is the expected detection |
| Additional fake-DB cases | Six counterexamples above reproduced; registered dependency rollback preservation additionally PASS |
| `git diff --check` / scope & history preservation | Checked before publication; runtime/source delta 0; H1 control changes only |

The mutation proves that the race suite catches the decision-window defect; G5's claimed ten mutations were **not all independently repeated**. A scratch trigger/fixture setup initially failed on text-vs-jsonb output concatenation; fixed the harness casts, rebuilt the owned probe DB and reran successfully. An automatic local permission review timed out once; the allowed single retry succeeded. Neither incident was a candidate behavior result. The pre-interruption unfinished race was not assumed successful; it was rebuilt and measured after recovery.

For repeatability, counterexample setup uses exactly the runner's baseline sequence: social_mobile_account_deletion_fixture -> real onboarding migration 20260919120000 -> reconnect 20260922003101 -> deletion candidate 20260928160000 -> common_account_lifecycle_fixture -> candidate 20261001150000. Call fixture_login with fresh fake ids, then follow the explicit SQL sequences above; never use a production connection. In the race, pause the *missing-entitlement* user's insertion and confirm PgSleep before committing the second transaction. The adversarial harness stayed in H1's scratch directory, not the PR or main runtime; its relevant recipes/output are preserved in this Report.

Not performed: actual disposable Supabase GoTrue/PostgREST/Storage/S3 E2E, real supabase_auth_admin vs postgres actor proof, production version/collation/extension parity proof, provider/Apple revoke, native/device/client wiring, production apply/backfill/delete/deploy. Pure PostgreSQL stubs do not substitute for these. No SQL lint tool beyond actual PostgreSQL parse/apply/catalog tests and source/shell/Deno checks is claimed.

## Correction / pre-production gates

No runtime fix was made. Storage/Auth destruction and consistent preview/backfill lifecycle serialization require the contract/architecture work explicitly reserved for G5. Small admin/FK/rollback corrections alone would leave the destructive path unsafe; this Report is not a partial PASS-WITH-FIX. C1 should independently decide a bounded G5 corrective TASK (recommended **Opus5.5（極高）** for the managed-deletion/serialization contract), with each reproduced case made an executed regression. H1 has not allocated or overwritten G5.

Before any production apply: corrected exact source head + repeated focused review; **separate Sol（極高） pre-production review required**; disposable actual Supabase proof of managed Auth/Storage/session/provider behavior and role/API boundaries; exact schema/FK/function/version/migration-history parity and conflict checks; validated fail-closed unknown ownership/cleanup ordering; stale-consent/backfill locking regression; safe rollback with confirmed shadow/no in-flight operation/no downstream dependencies; full creator/deleter/RLS gate wiring before enforcement. Require explicit production approval after those gates; no bulk db push/backfill is authorized here.

Supabase security and PostgreSQL locking/privilege skills informed the managed-service, stale-JWT, exact-FK and serialized-state checks. Current official Auth/Storage docs were consulted; changelog Markdown retrieval had previously failed due unsupported content type, not repeatedly retried. A fixture passing under a single owner was not treated as full service proof.

## Delivery / safety / next owner

- changed_files: `.agent/CODEX_REPORT.md` (append only), current H1 header/completion in `.agent/tasks/CODEX_TASK.md`, H1 section only of `.agent/ACTIVE_TASK.md`, new H1 summary only in `.agent/CURRENT_STATE.md`. Prior histories/other-slot content preserved. PR's seven files unchanged; no candidate/source/test fix commit.
- commit_hash: report/control commit containing this section; exact hash and confirmed GitHub read-back supplied in completion reply. Publication is only complete after remote verification, not inferred from this prepared text.
- push: control-only GitHub synchronization; no push to PR #70 source branch, merge or deployment. Source head remains the exact original.
- production_mutation: **0**. No Auth create/update/delete, migration/apply/backfill, RLS/GRANT change, Edge deploy, Vault secret read/write, OAuth/provider operation, Cron/flag/secret mutation, manual invocation or real X operation. Production catalog SELECTs contain schema metadata only, no user contents/PII/credentials.
- cleanup: baseline/mutation runners dropped their own databases; the H1 probe database and cluster are disposed/stopped before handoff. Only owned fake data is removed; production data untouched. Scratch recipes/report checkout may remain for inspection.
- remaining_issues: six source/security findings above and actual managed-service/integration prerequisites; no current production corruption established.
- source_safe_to_merge: **NO** at `89cf128bd9219897806b2b641cce4866f6e16c52`; source merge/apply/deploy HOLD. Review/control publication is safe.
- next_recommendation: **C1, 推薦モデル：Sol（高）**. Status `review_required`, next_owner `chatgpt`; STOP after verified report publication. Do not automatically begin G5, deploy or another task.

---

# H1 Report — PR #70 corrective lifecycle rereview — 2026-10-01 JST

- task_id: `common-account-pr70-corrective-rereview-20261001`
- result: **FAIL / CHANGES REQUIRED**
- reviewed_original_head / final_head: `eebe9405d758e0c120f9e6f1a70cdb1e973a0855` (unchanged; no runtime/test/doc fix)
- previous_failed_head: `89cf128bd9219897806b2b641cce4866f6e16c52`
- recommendation: **source merge / production apply / backfill / deploy HOLD**. The six previous blockers are resolved, but four new findings invalidate the claimed readiness/guard/version guarantees.
- production_mutation=**0**; production reads in this rereview=**0**; real X operations=**0**. No current production corruption established.

## Scope / fresh source / ownership

Fresh origin/main was independently fetched, initially `170c6082858f2793493a2b6225eb46dc6cc9a786`, then `e68b9cfbbe0b879669f56fb4bb871b6eaff029d8` for the report checkout. GitHub independently confirmed PR #70 open/mergeable with the exact assigned head. Base `26ea17942fb8900cd78a3c58959809aa86239ace` to fresh main has no overlap with its eight runtime/test/doc files. G4 PR #65 is merged as `6b1f2f6229a1b75743b57900d869368c2c5e8693`; no G4/G1/G2/G3/G5/H2 source/control assignment was changed. Shared dirty Developer checkout was not used or modified.

Review used H1-owned independent checkout and Unix-socket-only PostgreSQL **17.11**. Application SQL ran under non-superuser `kb_common_account_owner`; local superuser was used only for disposable database/role setup and cleanup. Baseline application sequence: social deletion fixture -> real onboarding migration `20260919120000` -> reconnect migration `20260922003101` -> social deletion candidate `20260928160000` -> common lifecycle fixture -> assigned candidate `20261001150000`. All identities are fake local fixtures. No Auth Admin API call, real Storage request, real provider revoke, production migration or remote database connection was used.

## First gate and previous six findings

**Architecture responsibility correction: PASS.** Candidate contains no destructive writes to managed Auth/Storage/Vault schemas. `prepare_common_account_auth_delete` stops at `ready_for_managed_auth_delete`, returns `login_deleted:false` and future steps, retains Auth/common rows and leaves the account operation in progress. Account-deletion `completed` is prohibited; service-only completion remains permitted. Actual managed Auth deletion, Storage API cleanup, session/identity/provider handling and recent reauthentication belong to a future orchestrator/integration. Current Kabumori legacy hard-delete remains explicitly unsafe/unchanged in shadow, not falsely fixed by this PR. A clean Storage metadata probe is not evidence of physical object/provider cleanup.

| Previous blocker | Independent disposition at corrected head |
| --- | --- |
| SQL Auth deletion / false Storage completion | **Resolved**: no Phase 1 Auth delete; visible Storage ownership blocks readiness even after recorded checkpoint; ready retains login; return does not claim account destruction. |
| Absent preview stays valid after entitlement backfill | **Resolved**: absent preview version 0, any materialized common row >=1; entitlement insert/backfill bumps version; old empty confirmation refused. |
| Backfill grants after concurrent account lock | **Resolved**: ordered Auth KEY SHARE -> common FOR UPDATE, locked-plan/status reread; both commit orders exercised and denied as required. |
| Admin + self-service workspace gets X entitlement | **Resolved**: actual admin exclusion, intersection regression; Kabumori legacy semantics remain separate. |
| Unrelated-column Auth FK passes preflight | **Resolved**: exact conkey/confkey/type/delete-action/validation/deferrability and helper signature validation; drift fixtures fail atomically. |
| Missing settings permits unsafe rollback | **Resolved**: affirmative single valid shadow row + integration not_started + no in-flight/downstream usage; missing/enforce/started/dependency cases refused before teardown; valid rollback exact dump parity and reapply pass. |

These are verified corrections, not carried-forward unresolved findings. Mutation cases for the previous six match intended failure messages; standard suites passing does not cover the new counterexamples below.

## New findings — seven separately reproduced adverse cases

All source line numbers below refer to `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql` at the exact reviewed head. No source fix is claimed. Tests that directly delete a fake `auth.users` row model the separate future managed-deletion actor reaching the guard; they are not a new Phase 1 delete implementation or real GoTrue proof. Local settings are set to integration_started/enforce only in this disposable model. No trigger is disabled, no replica mode/RLS bypass trick is used to evade the candidate guard.

### F1 — P1: post-cascade guard can lose late admin / foreign-membership blockers

The guard checks footprint at lines **584–595**, but is a BEFORE DELETE trigger on **common_accounts** (613–615), reached only after Auth FK actions begin. Other valid CASCADE actions can remove `admin_users` and `brand_memberships` before this guard runs. A previously committed blocker is then invisible to the function that claims to recheck delete-instant state.

Local recipe, two independent fresh fake users: Auth-only -> `begin_common_account_deletion(user,0)` -> record `session_revocation` + `storage_cleanup` -> prepare and verify ready. After ready, insert either (A) an admin_users row or (B) a foreign/internal `kabumori` brand membership (not an owned self-service workspace). Confirm deletion_blockers returns the appropriate blocker. Then invoke one plain local Auth DELETE: the guard allows it, and the blocker row is removed by cascade.

Actual output:

```text
LATE_ADMIN_PRE_DELETE_BLOCKERS={ADMIN_ACCOUNT}
LATE_ADMIN_AUTH_DELETE_ALLOWED=true
LATE_FOREIGN_PRE_DELETE_BLOCKERS={X_WORKSPACE_NOT_SELF_SERVICE}
LATE_FOREIGN_AUTH_DELETE_ALLOWED=true
```

Separate trigger instrumentation in the disposable DB records the footprint immediately inside the common row cascade, before the candidate guard. It proves the timing, not merely an assumed race:

```text
ADMIN_VISIBLE_BEFORE_AUTH_STATEMENT=true
FOOTPRINT_INSIDE_CASCADE_BEFORE_GUARD={"admin":false,"kabumori":false,"x_foreign":false,"x_autopost":false}
```

The instrumentation trigger/table/function was removed after measurement. This is a **valid-schema ordering counterexample**, not a claim about production's exact trigger order (not read in this rereview). Candidate preflight accepts this shape; a safety guarantee cannot depend on unrelated FK action creation order. Re-running prepare before deletion can notice a blocker, but does not close the gap to the separate future Admin API request. The existing foreign brand itself remains; the evidence concerns missed membership authorization, not a claimed orphaned newly owned workspace.

**Required correction:** G5 must define a boundary/serialization that sees and refuses the pre-cascade blockers, or durably invalidates readiness for every relevant producer, including admin and foreign memberships. Preserve additive/no-managed-write responsibilities. Add both commit orders and a valid trigger-order variation as regressions. Do not simply query the same already-cascaded rows again, or silently add managed Auth triggers/orchestrator wiring under this review.

### F2 — P2: previously ready guard does not revalidate required checkpoint / identity changes

Lines **586–595** require the ready flag but do not check current required-checkpoint registry against recorded attestations. Three independent users reached ready with session/storage attestations; then, before the separate local Auth DELETE:

1. Remove built-in `storage_cleanup` registry row.
2. Add a new `requirement='always'` checkpoint without recording it.
3. Add an Apple identity without recording `apple_revocation`.

Each guard still permits deletion:

```text
MISSING_REGISTRY_AFTER_READY_AUTH_DELETE_ALLOWED=true
NEW_REQUIRED_CHECKPOINT_AFTER_READY_AUTH_DELETE_ALLOWED=true
LATE_APPLE_WITHOUT_CHECKPOINT_AUTH_DELETE_ALLOWED=true
```

Preparing again would detect these conditions, but the guard is documented to re-evaluate at delete instant. Apple identities can themselves cascade before the common trigger, so simply calling the helper there does not solve F1's timing problem. Require a coherent authorization/ready-revocation contract for already-ready operations when requirements or login identities change, with missing/added requirements failing closed. These are future-enforce correctness gaps, not currently deployed Auth attacks; registry maintenance is owner-only, not a client permission.

### F3 — P2: built-in registry names pass while required semantics are corrupted

`private.account_lifecycle_required_checkpoints`, lines **511–518**, validates only three key names. Both `session_revocation` and `storage_cleanup` can be changed by owner maintenance to `requirement='apple_identity'`, a schema-valid value. For a fresh non-Apple fake user, begin account deletion and record **no checkpoints**, then make those two mapping changes. Prepare returns `status:ready_for_managed_auth_delete`, `login_deleted:false`: mandatory session/storage attestations were skipped. Mappings were restored after the probe.

The stated built-in semantics are session/storage **always**, Apple conditional; a damaged registry is supposed to fail closed. Validate those exact mappings as well as key presence, and add semantic-corruption mutations. Rollback's built-in-count check likewise only tests names (rollback lines 31–33); that related source observation was inspected, but no extra rollback counterexample is claimed here.

This is a **schema-valid operator misconfiguration** case covered by the corruption/fail-closed contract. Clients and service_role have no direct registry grant; it is not evidence of client privilege escalation, and a malicious schema owner can of course disable arbitrary protections.

### F4 — P2: operator entitlement ownership transfer leaves the source account version stale

`account_lifecycle_touch_entitlement`, lines **385–388**, updates only `coalesce(new.user_id,old.user_id)`. A schema-valid owner UPDATE that transfers an entitlement between two active common accounts bumps only the destination, though the source account's services changed too.

Local recipe: create fake active common accounts A/B; introduce an X entitlement for A; capture A's lifecycle_version; `UPDATE public.service_entitlements SET user_id=B WHERE user_id=A`; compare versions. Actual output: `SOURCE_OWNER_VERSION_UNCHANGED_ON_TRANSFER=true`; destination incremented. No Auth deletion was attempted in this case.

I7 promises version invalidation for relevant entitlement changes, including operator SQL. Either reject ownership transfer or bump **both** affected accounts under consistent lock order; test stale confirmations on both sides. This is owner/operator-only (client/service_role cannot direct-write), not an arbitrary authenticated-user exploit.

## Boundary verdicts

- **Lifecycle/version/backfill: prior correction PASS, overall FAIL** due F4. Original creator/delete/ready/backfill locks and isolation cases pass, but the version promise does not cover a valid owner transfer.
- **Managed checkpoints: FAIL** due F2/F3. service_role RPC-only checkpoint attestation is intentionally trusted backend evidence, not independently verified provider cleanup. Future Edge must verify the caller's Auth id; this PR's comments do not implement that boundary. Client metadata is not used for authorization.
- **Storage read-only probe: local fail-closed PASS, actual Supabase integration unproven.** In addition to committed missing-shape/owned-object cases, revoke storage.objects SELECT from the local function owner -> prepare raises **42501**; change owner_id from text to uuid -> prepare raises **42883** rather than returning ready. Both local changes were rolled back. Exceptions must be handled truthfully by future Edge; these probes do not prove production ownership, physical cleanup, GoTrue or PostgREST behavior.
- **Exact preflight/rollback: corrected prior invariants PASS.** Eight drift apply failures and eight rollback refusals were executed by the runner; schema dump parity/reapply pass. Production catalog/migration history still needs a separate gate; this rereview did not inspect or repair it.
- **Guard: FAIL** due F1/F2; shadow intentionally allows legacy hard delete, missing settings fail closed, enforce-before-integration is refused, visible late Storage state blocks deletion in the normal fixture. Those passing cases do not validate blocker visibility after other cascades. A common-only trigger also does not cover users without common rows; enrollment plus all creator/deleter wiring must precede any enforcement.
- **ACL/RLS/SECURITY DEFINER: PASS in tested model.** Five new tables RLS; intended self SELECT columns only; no client write/source/evidence disclosure; no service_role table grants; RPC EXECUTE minimized after PUBLIC revoke; private objects denied to clients; all 21 functions schema-qualified with empty search_path. Client start RPCs use auth.uid(), not arbitrary user-id args. No user_metadata authorization. Actual Supabase managed-role/API proof remains separate.
- **Service responsibility: PASS within narrowed Phase 1**, not authorization to deploy/enforce or call account deletion. Login/provider/S3/session responsibilities and current Kabumori/X legacy integration gaps remain explicit.

Official [Auth user-management guidance](https://supabase.com/docs/guides/auth/managing-user-data) describes managed Auth deletion and JWT/session limitations; deletion is not instant invalidation of already issued JWTs. [Storage ownership guidance](https://supabase.com/docs/guides/storage/security/ownership) explains owner_id does not itself enforce access. Future actual Storage/API cleanup and provider handling must not be inferred from SQL metadata. Supabase/Postgres skills informed these boundaries, exact-FK/privilege checks and cascade/locking probes. Changelog Markdown retrieval was attempted once and returned unsupported content type; no repeated retrieval loop or unsupported changelog-based claim.

## Independent test evidence

All suites ran against the exact assigned source before switching to a fresh-main report-only branch. No G5 test count was treated as proof without execution.

| Executed check | Actual result |
| --- | --- |
| `common_account_lifecycle_run.sh` | **19 PASS markers**, including behavior, 12 race scenarios, drift preflight, exact additive schema/ACL, isolation/no deadlocks, affirmative rollback parity/reapply and cleanup |
| `common_account_lifecycle_mutations.sh` (`CAL_JOBS=4`) | **29/29 DETECTED**, each scratch mutation fails its copied runner and expected matcher; real source unchanged |
| `social_mobile_account_deletion_run.sh` | **8 PASS markers**, including behavior/concurrency/isolation/no deadlocks/cleanup |
| `deno test --no-config --allow-read supabase/tests/migration_source_invariants_test.ts` | **10 passed / 0 failed** |
| `bash -n` lifecycle runner and mutation runner | PASS |
| `deno lint --no-config supabase/tests/migration_source_invariants_test.ts` | PASS |
| Added scratch adverse probes | **7 counterexamples reproduced**, grouped F1–F4 above; these are defects, not application PASS results |
| Separate cascade timing instrumentation | Pre-statement admin present / pre-guard footprint gone, reproduced |
| Storage SELECT-denied and owner_id type-mismatch probes | **Fail closed PASS**, 42501 / 42883, changes rolled back |
| `git diff --check` / source ownership check | PASS; source branch clean; runtime/test/doc changes **0** |

Mutation matcher caveat: case 20 (Auth KEY SHARE removal) accepts generic `FAIL`, unlike more focused matchers. Do not interpret all 29 detections as independently pinpointed root causes. Previous-six-related mutations/fixtures were checked for the intended invariant's message. All runner-created databases were dropped by their cleanup. H1's remaining named fake probe DB was explicitly verified, dropped, no nonstandard databases remained, and the owned cluster was stopped.

Counterexample recipes above are durable reproduction instructions. Scratch SQL files were not committed or pushed; they use the same fixture/migration sequence, fake Auth-only users and ready preparation. The guard cases commit the late state before the local Auth statement. Registry mutations are restored per probe; entitlement transfer is separate. New regressions should be committed in the separately scoped corrective work, not only documented. No full-repository TypeScript/native test result is claimed; this review changes no Expo code.

## Correction authority / remaining gates

No source/runtime fix was attempted. F1's root correction changes the lifecycle delete-boundary/ready-invalidation contract, expressly reserved for G5; F2 must be resolved coherently with that boundary. Patching the name checks alone cannot justify PASS. C1 should decide a separate bounded corrective G5 task (recommended **Opus5.5（極高）** for the serialization/managed-boundary contract), preserving the newly accepted no-managed-delete Phase 1 responsibility. H1 has not allocated/overwritten/restarted G5 or amended PR #70.

Not performed: actual disposable Supabase GoTrue/PostgREST/Storage/S3 E2E; supabase_auth_admin vs postgres actor proof; real session/JWT/provider revoke or recent reauth proof; production catalog/history parity; creator/deleter Edge/client wiring; production apply/backfill/enforcement/deploy. Pure PostgreSQL is not a substitute. Before any production apply: corrected exact head plus focused rereview/C1 acceptance; **separate Sol（極高） pre-production review required**; actual disposable Supabase managed-service/role/API proof; exact production read-only preflight/history/ACL/FK conflict checks; backfill dry-run/parity; safe affirmative pre-integration rollback; explicit user approval. No bulk db push or production repair is authorized by this report.

## Delivery / safety / next owner

- changed_files: `.agent/CODEX_REPORT.md` append only; current H1 header/completion only in `.agent/tasks/CODEX_TASK.md`; H1 section only in `.agent/ACTIVE_TASK.md`; prepend H1 summary only in `.agent/CURRENT_STATE.md`. Old reports/history and all other slots preserved.
- source_fix_commit: **none**. PR source/runtime/tests/docs unchanged; no source-branch push or merge.
- commit_hash: the report/control commit containing this section; exact hash and verified remote state supplied in the completion reply. Prepared text does not itself prove publication.
- push: only report/control synchronization to GitHub; complete only after remote read-back.
- production_mutation: **0**; production_read in this rereview: **0**. No Auth/Storage/OAuth/Vault/DB/GRANT/Edge/Cron/secret/flag mutation; no real X operation/manual invocation. No tokens, secrets, real identities or user contents in this report.
- cleanup: H1-owned fake probe database removed; local cluster stopped; only disposable local fake data removed. Production data untouched. Scratch recipes and independent report checkout remain for inspection; removed probe data can be recreated from fixtures/recipes.
- source_safe_to_merge: **NO**, PR #70 exact head `eebe9405d758e0c120f9e6f1a70cdb1e973a0855`; HOLD. Review/control publication does not merge the candidate.
- remaining_issues: four findings F1–F4 plus actual managed-service/integration/pre-production prerequisites; current production corruption not established.
- next_recommendation: **C1, 推薦モデル：Sol（高）**. TASK `review_required`, next_owner `chatgpt`; STOP after verified synchronization. No automatic G5 reassignment, source merge or production action.

---

# H1 Report — PR #70 readiness authorization rereview — 2026-10-02 JST

- task_id: `common-account-pr70-readiness-authorization-rereview-20261002`
- result: **PASS-WITH-FIX** for the exact reviewed source plus the bounded H1 correction below.
- original_reviewed_PR_head: `47a2ed6a1635177ba82004eace4bddb42d9d53e3`
- final_verified_candidate / source_fix_commit: **`aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65`** (one commit atop the assigned head).
- source_fix_branch: `codex/h1-pr70-readiness-review-20261002`, independently published/read back. G5's PR #70 branch/head is **unchanged**.
- merge_recommendation: C1 may accept the verified fixed candidate, but **do not merge PR #70's unchanged original head**. C1 must arrange/verify incorporation of the exact bounded fix first. H1 did not merge, amend another slot's branch, create another PR, allocate G5 or authorize production.
- production_read / production_mutation / real_X_operations: **0 / 0 / 0**.

## Startup, scope and responsibility verdict

Read fresh H1 TASK, PROJECT_RULES/AGENTS/HANDOFF/ORCHESTRATION, ACTIVE/CURRENT, G5 current TASK+Report, prior H1 corrective report and Final C1. Fresh origin/main **`8ef716fc2eb118b9fc0d41bb3a551d9d9f58b4ed`** and GitHub independently agree on the assigned open/unmerged/mergeable PR head. Base `26ea17942fb8900cd78a3c58959809aa86239ace` -> fresh main has **no overlap** with the eight PR files. Independent H1 checkout reused; shared dirty Developer checkout and other slots untouched. Fix and control delivery use separate H1-owned branches.

**Responsibility boundary: PASS.** No candidate SQL deletes Auth or writes managed Storage/Vault/provider state; Phase 1 cannot record account-deletion `completed`. Readiness is not managed deletion. No enforcing Auth-delete mode exists; settings accept only shadow, regardless of integration state. Auth cascade observer neither reconstructs blockers nor authorizes the delete. It records `login_removed` as an unverified observation, with `LOGIN_REMOVED_WHILE_READY_UNVERIFIED` when appropriate. Missing/non-shadow settings refuse every applicable common-row cascade (23503); users without a common row are outside that observer, not secretly protected.

Current Kabumori hard-delete remains **unchanged and unsafe**, and Phase 1 still does not gate legacy creators/deleters. Future managed orchestrator obligations are explicit: recent reauth; session revocation/stale-token policy; Apple and X authorization revocation; Vault purge; Storage API cleanup/re-enumeration; final prepare/revalidation; Auth Admin API deletion; post-delete read-back/audit/retry. The gap between prepare and a separate managed API call is **not** claimed atomic. Unwired producers are the stated reason that Phase 1 cannot enforce deletion safety.

## Prior blocker dispositions — all verified resolved within the narrowed contract

| Old six | Disposition |
| --- | --- |
| SQL Auth delete / false Storage completion | PASS: no managed destructive SQL; no whole-account completed; visible Storage ownership blocks readiness despite attestation; login retained. |
| Absent preview stale after backfill | PASS: absent=0, materialized row>=1, entitlement writes move version, old confirmation rejected. |
| Backfill vs lock/state | PASS: Auth then common row locks, post-lock plan reread, no grant to non-active, both commit orders covered. |
| Admin X consumer backfill | PASS: mixed admin/self-service-owner actually excluded; Kabumori legacy evidence semantics separate. |
| Exact FK preflight | PASS: exact referencing/referenced columns/types/action/validation/deferrability/helper signatures; eight drift fixtures fail atomically. |
| Affirmative rollback | PASS: single shadow/not_started settings, exact built-in semantics, no operations/use/dependency; missing/corrupt/started/used states refused, exact schema restoration/reapply. |

| Latest seven adverse cases (prior F1–F4) | Disposition |
| --- | --- |
| Late admin after ready | PASS: read model stale ADMIN_ACCOUNT; prepare refuses/withdraws; both concurrency orders. Observer intentionally does not authorize. |
| Late foreign/internal membership | PASS: stale X_WORKSPACE_NOT_SELF_SERVICE; prepare refuses/withdraws; no post-cascade blocker reconstruction. |
| Missing built-in requirement | PASS: ordinary deletion refused; bypassed corruption makes prepare/read fail closed; rollback independently rejects. |
| New always-required checkpoint | PASS: epoch advances, all ready operations immediately cleanup/unbound, new attestation required; both concurrency orders. |
| Late Apple identity | PASS: required-set binding mismatch + missing apple_revocation; old readiness cannot be refreshed without it. Identity is evaluation-only, not auto-triggered. |
| Built-in names with weakened semantics | PASS: immutable normal maintenance; exact meaning check also detects bypassed corruption; prepare/read/rollback refuse. |
| Entitlement user_id/service_key transfer | PASS: direct UPDATE refused; both versions unchanged on refusal; end here/start there moves both. |

Cascade-order evidence: committed behavior tests have a conditional fallback if FK trigger names still sort the same way after recreation. H1 therefore additionally measured both orders in the disposable model, rather than assuming the fallback proves two orders. Initial scratch attempt yielded `{t,t}` because decimal-width trigger-name ordering did not flip; it was **not** counted as a two-order PASS. Recreating both local FKs in the same numeric-width range produced **`CASCADE_VISIBILITY_ORDERS={t,f}`**, and **`BOTH_OBSERVED_UNVERIFIED=true`**. All scratch changes rolled back. This demonstrates order-independent observation, not a production trigger-order claim or deletion authorization.

## New bounded finding and fix — P2 observation truthfulness

At the assigned head, deleting **only** a `public.common_accounts` row via owner maintenance fires the same observer even though its Auth parent remains. Local proof: fresh Auth-only user -> begin(0) -> session/storage checkpoints -> prepare ready -> direct common-row DELETE. Actual output:

```text
AUTH_STILL_PRESENT=true
OP_AFTER_DIRECT_COMMON_DELETE={"step":"ready_for_managed_auth_delete","error":"LOGIN_REMOVED_WHILE_READY_UNVERIFIED","status":"login_removed","user_id_cleared":true}
```

That incorrectly closes the operation and loses its raw subject link while login still exists. Clients/service_role cannot direct-delete this table; this is a supported-review **owner-maintenance/audit correctness** issue, not an authenticated-user exploit or actual production incident. It is small/deterministic, so the TASK's bounded-fix authority applies; no readiness/enforcing strategy or managed orchestration was redesigned.

**Failing regression:** fresh disposable runner with the added case fails exactly `FAIL H1-observer: direct common-row deletion must not falsely record login removal` (exit 1). An initial attempt reused the populated probe DB and failed its fixture-population assertion instead; it was discarded and repeated in a fresh DB to obtain the intended failure.

**Minimal fix:** observer checks whether `auth.users.id = old.user_id` still exists. If it does, refuse direct common-row deletion with **`COMMON_ACCOUNT_ROW_DELETE_REQUIRES_LOGIN_REMOVAL` / 23503**, preserving account, operation and valid readiness. During a real Auth cascade, the parent is already absent in that transaction, so shadow still permits **every** actual Auth deletion, including stale/admin cases, and records only unverified removal. No managed schema write, admin/membership/identity authorization or new enforcing mode was added.

Committed regression checks both the refused direct application-row removal and the subsequent actual shadow Auth cascade. Added mutation removes only the identity-existence check and must match the new specific regression failure. Test cleanup now removes fake Auth parents through their shadow cascade instead of impersonating it by directly deleting common rows; then clears fake operations. This is TEST-only, not production cleanup SQL. The old unverified-marker mutation's matcher now points to the earlier, equivalent actual-cascade assertion.

Fix delta: **5 files, +44/-5**, source commit `aa4d2d4`:

- candidate migration: seven-line observation-integrity check;
- behavior: direct-row false-removal regression + actual Auth-cascade success;
- mutations: one added mutation and precise unverified-marker matcher;
- runner: three test-cleanup sites aligned with actual fake Auth cascade;
- docs: direct-maintenance refusal and observation-vs-authorization distinction.

## Durable readiness / invalidation inventory verdict

**PASS within explicit Phase 1 limits.** Operation table has no Auth FK, so authorization evidence is durable across cascades. Ready binds lifecycle_version, requirement_epoch and exact sorted required-checkpoint set. `authorization_problems` requires an open ready account-deletion operation, deleting account, matching values and fresh blockers/checkpoints/ownership evaluation. Read model `none/valid/stale` is expressly unlocked **advice**, never a deletion safety decision. Prepare locks Auth FOR UPDATE -> common FOR UPDATE -> settings SHARE -> operation FOR UPDATE; stale conditions clear every ready binding and return to cleanup. External checkpoint entries are trusted backend attestations, not SQL verification of provider/Storage cleanup.

All inventory rows were read against source/tests, including the distinction between automatic invalidation and reevaluation:

| Producer/transition | Phase 1 handling |
| --- | --- |
| Entitlement insert/update/delete | owner/RPC/backfill writes trigger account-version bump and readiness cleanup. |
| Entitlement person/service transfer | immutable, refused; legitimate move end + start on separate accounts. |
| Account status/version | monotonic version + immediate readiness cleanup. |
| Lifecycle service start/provisioning | cannot start while deleting; otherwise entitlement trigger. |
| Backfill | lifecycle locks and active-only; inserted entitlement changes version. |
| Checkpoint requirement extension/change/removal | statement trigger advances epoch; settings trigger clears all readiness. Built-ins immutable. |
| Settings/integration row change/removal/recreation | epoch/invalidation; shadow-only; missing settings never ready. |
| Checkpoint clear | backend RPC removes attestation, unbinds and cleans up; must attest again. |
| Admin membership | existing writer/operator; **evaluation only**, no automatic version/epoch update. |
| X membership/workspace ownership/profile-key/social-account/OAuth/tombstone | existing writers; **evaluation only**. |
| Kabumori profile creation | old ensure_my_profile creator; **evaluation only**. |
| Apple identity | GoTrue managed writer; required-set reevaluation, **not** an installed managed-schema trigger. |
| Storage object/bucket ownership | Storage API/still-valid token; read-only probe, **evaluation only**. |
| Login deletion | shadow observer closes/scrubs operations; not account-completion verification. Direct common-row maintenance now cannot fake it. |

Evaluation-only changes may leave the saved ready step unchanged until evaluated; read model detects stale and prepare withdraws it. Those producers need future wiring/serialization/stale-token policy before **any** enforcing guard can be introduced. Version/epoch alone do not authorize future deletion while these gaps remain. No client/Edge/legacy-writer wiring was added here.

## Checkpoints / settings / observer / ACL / preflight / rollback

- **Checkpoint/settings PASS:** fixed meanings session_revocation=always, storage_cleanup=always, apple_revocation=apple_identity; maintenance guard prevents change/delete/rename/TRUNCATE; exact semantic validation catches bypassed corruption. Extensions invalidate epoch/readiness. Settings CHECK permits shadow only; missing/non-shadow blocks observation path, missing settings blocks readiness. Rollback uses its own explicit built-in contract rather than trusting the candidate helper.
- **Observer PASS after fix:** no blocker or identity reconstruction after other cascades; no authorization; unverified login_removed is truthful for real parent removal; raw user id scrubbed for related records, subject hash retained. Shadow does not protect old deletion routes. Owners can disable triggers; no owner-proof guarantee is claimed.
- **Storage probe PASS in tested model:** owned objects/buckets/deprecated owner and unknown shape block; type mismatch is caught as MANAGED_STORAGE_PROBE_FAILED. H1 additionally revoked SELECT from the local function owner in a rolled-back transaction: **MANAGED_STORAGE_PROBE_FAILED**, not clean. This is not physical cleanup or actual managed-role proof.
- **ACL/RLS/SECURITY DEFINER PASS:** five tables RLS; intended own-row/column-limited SELECT only; no client arbitrary writes or classification leak; no service_role direct table grants; RPC-only minimal EXECUTE after PUBLIC revoke; helpers private; all 33 functions empty search_path/schema qualification. No user_metadata authorization. Future Edge must verify p_user_id from caller's Auth, not client input. Real PostgREST/managed-role behavior remains untested.
- **Exact preflight/rollback PASS:** one transaction/additive, exact known dependency contracts and atomic drift refusal maintained. New candidate objects are created in the same transaction; collisions/errors cannot leave partial apply. Ten rollback refusal fixtures include missing/corrupt settings, semantics/extensions, finished/in-flight operations/use and tracked downstream dependency. Normal rollback restores exact schema dump and reapplies. Dynamic/client dependencies are not automatically discoverable.

## Independently executed tests

Local PostgreSQL **17.11**, Unix socket only, fake data, non-superuser application owner. No production Supabase connection. Full original and fixed suites were executed, not inferred from G5's report.

| Check | Original `47a2ed6` | Final `aa4d2d4` |
| --- | --- | --- |
| common_account_lifecycle_run.sh | **20 PASS markers** | **20 PASS markers**, 14 race scenarios, behavior/new regression, schema/ACL/preflight/rollback/reapply/cleanup |
| common_account_lifecycle_mutations.sh (CAL_JOBS=4) | **45/45 DETECTED** | **46/46 DETECTED**, specific intended matchers including added false-observation case |
| social_mobile_account_deletion_run.sh | **8 PASS markers** | **8 PASS markers**; unchanged source, rerun after fix |
| migration_source_invariants_test.ts | **10 passed / 0 failed** | **10 passed / 0 failed** |
| bash -n runners / relevant Deno lint / git diff --check | PASS | PASS |

Mutation source is scratch-only; no mutant modified the real candidate. Old-six and latest-seven matchers correspond to actual invariants, not generic FAIL. The former generic Auth KEY SHARE matcher now names race8 start; all final mutations were detected at their specified message.

Intermediate results are not hidden: first post-fix runner passed behavior/races but failed old direct-common-row **test cleanup**; adapted cleanup as above. First expanded mutation run had **5 WRONG_REASON results** (four affected cleanup and one earlier equivalent unverified-marker assertion), was counted as FAIL, not success. After cleanup/matcher alignment, a full fixed-tree rerun gave **46/46** and runner 20 PASS. One automatic permission-review timeout was retried once successfully; no action was assumed unsafe or successful from that timeout. A scratch cascade attempt did not flip order; final measured two-order proof is distinguished above.

No full Expo/native TypeScript check claimed: no app code changed. Not executed: real disposable Supabase GoTrue/PostgREST/Storage/S3/managed-role E2E, actual Auth API delete/provider/session cleanup, production catalog/history parity/backfill/apply/deploy. Local SQL fixtures are not substitutes.

Official current [Auth user management](https://supabase.com/docs/guides/auth/managing-user-data), [Storage ownership](https://supabase.com/docs/guides/storage/security/ownership) and [Storage deletion API guidance](https://supabase.com/docs/guides/storage/management/delete-objects) were consulted. Issued JWTs are not instantly invalidated by Auth deletion; Storage metadata deletion is not physical cleanup. Supabase/Postgres skills guided the managed-boundary/privilege/locking probes and conservative production hold. Changelog Markdown fetch once returned unsupported content type; no repeated retrieval loop or new changelog-based API claim.

## Delivery, remaining obligations, C1

- changed_files_source: the five files named above on **H1-only source branch**. No other slot branch/PR/main runtime write; no extra migration, existing-table policy/grant/trigger rewrite, managed Auth/Storage/Vault write or creator/deleter wiring.
- changed_files_control: append `.agent/CODEX_REPORT.md`; current H1 header/completion `.agent/tasks/CODEX_TASK.md`; H1 section only `.agent/ACTIVE_TASK.md`; prepend H1 summary `.agent/CURRENT_STATE.md`. Prior histories and other slots preserved.
- commit_hash_source: **`aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65`**, normal push to own branch; GitHub confirms five changed files. No force push or update to G5/PR70 branch.
- commit_hash_control: report/control commit containing this section; exact hash and verified remote state provided in completion reply. Publication considered complete only after read-back.
- merge/deploy: **none**. **Original PR #70 `47a2ed6` still needs the H1 fix before merge**; final fixed candidate has no remaining blocking source finding in this scope. C1 decides exact incorporation/read-back and any acceptance; H1 does not self-merge or reassign G5.
- production_read/mutation: **0/0**; real X/provider/manual operations **0**. No credentials/PII/user payloads in Report.
- cleanup: runner databases removed; H1-owned probe DB verified/dropped; no nonstandard DBs left; owned cluster stopped. Only fake local data removed; production untouched. Scratch recipes/source/report checkout remain; fixtures can reconstruct probe data.
- remaining_Phase2/3: wire every inventory producer/legacy creator/deleter; enroll all logins; explicit caller/recent-reauth and stale-session enforcement; service cleanup/provider revokes/Vault purge/Storage API convergence; Auth Admin delete + read-back/audit; only then separately design/enforce a reviewed boundary. These are honest incompleteness, not implemented by this review.
- preproduction_gate: **separate Sol（極高） review mandatory**, actual disposable Supabase project proof, exact production read-only catalog/ACL/FK/function/migration-history/version check, API exposure/managed-role behavior, backfill dry-run/parity, rollout/rollback proof and explicit approval. This source acceptance does not authorize applying even one migration or enabling enforcement.
- next_recommendation: **C1, 推薦モデル：Sol（高）**. TASK `review_required`, next_owner `chatgpt`; STOP after synchronization. C1 should accept/arrange the exact bounded fix, not merge the unchanged PR candidate or bypass production gates.

---

# H1 Report — PR #76 per-account publishing permission review (2026-10-02 JST)

- task_id: `x-social-mobile-pr76-publish-toggle-review-20261002`
- result / verdict: **FAIL / CHANGES REQUIRED**. Merge/deploy HOLD; no source fix attempted because the critical correction requires a transaction/authorization-boundary decision beyond this TASK's no-schema/no-RPC-change scope.
- reviewed_original_head / final_candidate_head: **`a59a89e9c585fb6e780e1af2ecc898c830f5524e`**, unchanged. GitHub PR #76 was read back open/unmerged with this exact head before delivery.
- isolated environment: H1-owned `/private/tmp/kabumori-h1-resume.DHxA95/repo`, clean single-worktree checkout, own review then report branch. Shared Developer checkout and all G1–G5/H2 branches/worktrees/dev servers untouched.
- startup origin/main: `a76cb12`; fresh report base: `85b40b464c29311eae7fba84e13a50cb41dd1a52`. PR parent/base `416de8fdac6a6f4c37740536759e0b09b96c81f4`. Independently compared all ten candidate files to base-to-fresh-main changes: **overlap 0**, including intervening G2/PR77 changes; no consultation/content-settings/common-account file edited.

## Findings / executed counterexamples

### P1 / R1 — membership authorization is not bound to the privileged write

- locations: `social-mobile-publish-setting/logic.ts:193–195,216–222`; `http.ts:153–177`.
- Auth identity is verified and the first membership read is correctly scoped. However, the resulting role is used as a snapshot while the subsequent PATCH runs with service-role authority and predicates only on account id/brand/state/readiness. No caller identity, current membership or role participates in the write transaction, and the existing deletion guard is not a membership-role guard.
- executed HTTP reproduction using actual `createHandler` and a fake backend that evaluates the emitted PostgREST predicates: read owner membership; remove it or demote to viewer/member before returning that snapshot; continue valid active/live account flow. **All three return 200 and set publish_enabled=true after authority is gone.** The problem applies to OFF as well because that privileged PATCH has the same independent membership lookup.
- runtime posting does not reauthorize this initiating user's membership; an active/live brand can therefore consume the persisted ON permission. Extra HTTP membership rereads or a post-write reread cannot make this atomic and cannot undo an already-observed permission.
- correction recommendation, not implementation: design a narrow transactional server/database boundary that binds verified caller + authoritative brand + current owner/admin membership + state CAS + ON prerequisites and serializes against relevant permission-changing writers. Existing authenticated role has no direct write policy/grant to substitute safely. Any new RPC/migration/ACL or writer coordination must be separately scoped/approved; do not weaken client grants or infer production approval.

### P1 / R2 — brand TOCTOU is NOT proven non-publishing by the real runtime guard

- locations: `logic.ts:210–222`; `http.ts:153–169`; `_shared/brand/brand_context.ts:89–136`; `x-test-post/index.ts:3945–3950,4075`; `x-test-post/vault_account_auth.ts:97–151`.
- ON's active/live check is a separate brands GET and is absent from the conditional UPDATE. The dispatcher loads brand and account in separate HTTP calls and `assertBrandPublishAllowed` evaluates that cached object, not the current database. AI Lab's later final content/length guard also uses that same context. VaultAccountXAuth loads the access credential before generation and ordinarily sends its cached token without a fresh brand/readiness lookup.
- concrete interleaving proved with actual `createHandler`, `loadBrandContext` and `assertBrandPublishAllowed`: (1) brand active/live, account OFF; (2) toggle reads eligible brand and pauses; (3) dispatcher independently reads active/live brand; (4) disable brand; (5) release stale toggle, which PATCHes ON; (6) dispatcher reads now-ON account and accepts its mixed cached context. **There was no state in this schedule where current brand was active/live AND account ON, yet the publish guard passes.** Thus the claimed downstream safeguard is not sufficient even for a consistently authorized snapshot, not merely an already-authorized post completing after OFF.
- existing running-post credential reader (`20260925140000...`, exact-account-authority helper) verifies account state/readiness but contains **no brand active/live recheck**; no secret was read to establish this. Separate executed fake VaultAccountXAuth proof: one credential read at load, one fake send callback, no final permission read. No real X API was invoked.
- minimum design recommendation: atomically bind ON authorization to brand state, and explicitly establish the downstream fresh pre-send permission contract/in-flight semantics, with adverse interleaving tests. Changing existing posting runtime/schema is outside this PR's allowed bounded review correction; no such change made. Do not claim absolute external-X atomicity from an additional HTTP read alone.

### P2 / R3 — no-match reread is no longer tenant-bound

- locations: `logic.ts:224–229`.
- after conditional PATCH matches zero rows, the service-role `readAccount(account.id)` result is used without checking that latest.brand_id is still the authorized brand or rechecking membership.
- executed schedule: membership read from brand A; move account to foreign brand B and set ON; old brand predicate prevents update (good), but latest read of B returns `409 STALE_STATE/current_enabled:true` to caller with no B membership (bad). Initial absent/foreign lookup is indistinguishable as designed; this retry path breaks that isolation under movement/revocation. No unauthorized UPDATE in this probe.
- correction: before returning latest state, verify current authorized account/brand/membership; when no longer in scope, use the same safe not-found shape. The transactional fix must also handle this path.

### P2 / R4 — ON readiness read and PATCH predicate have unequal semantics

- locations: `logic.ts:165–171`; `http.ts:165–168`.
- read phase rejects an empty platform_user_id; PATCH only requires not-null. Executed fake HTTP/CAS: eligible read, identity becomes empty before write, other fields still present -> **200/ON**. Existing runtime helper rejects `nullif(btrim(platform_user_id),'')`; whitespace-only identity is also stricter there than in the candidate's truthy-string read.
- candidate also only checks reference presence, while actual credential loader additionally rejects equal access/refresh refs and shared refs, plus refresh-state failures. Distinguish permission-setting eligibility from actual credential usability; do not claim this endpoint proves every runtime prerequisite. Presence-only is not a Vault plaintext read, and actual runtime can still refuse sending.
- correction: align the atomic readiness predicate and initial validation with the documented nonempty/exact-account contract; define which transient runtime states should merely prevent send vs prevent ON. No repair/schema change attempted.

### P2 / R5 — ON confirmation is not pinned to account/eligibility/preview

- locations: `publish-setting-card.tsx:16–20,30–35`; account-detail wires no per-account key; hook builds body from current account prop at submit.
- executed transpilation/React-stub harness of real hook+card: open ON confirmation on account A, replace props with eligible B, confirm -> request is for **B**, which was not the account originally confirmed. The branch also leaves the confirm button active after props.preview becomes true; confirm then sends a request in preview mode.
- static mount in mock_preview correctly exposes no switches, and normal cancel sends zero requests, but the state-transition guarantee is missing. These are component-level executable proofs; actual native router remount behavior and production preview-transition reachability were not claimed/verified.
- correction: bind confirmation to exact account/expected state (and auth context where appropriate), invalidate/reset it on context changes, and recheck current action eligibility/preview at confirmation/submit. Native/web navigation/props-transition regressions should cover it. No client runtime edit attempted while architectural gate is stopped.

## Remaining lower-risk observations

- Duplicate JSON keys: actual handler accepts duplicate desired_enabled and JSON.parse last-value wins; a duplicate false then true produces ON. No tenant/Auth bypass by itself, but “exactly three fields” is a parsed-object contract, not a strict raw-JSON uniqueness contract. Reject duplicates if strict unambiguous input is intended (P3 hardening).
- Body limit: method and content-type checks are real; empty/malformed/oversized (>1024 JS characters) inputs return bounded REQUEST_INVALID. However request.text buffers the entire body **before** the length check, and this is a character limit, not a streaming 1KB byte-allocation limit. Do not report resource-exhaustion protection that the code does not provide.
- Same-state success truthfully confirms its earlier account snapshot, not current state after arbitrary concurrency; returns no PATCH. Boolean CAS closes ordinary duplicate requests but is not a version/ABA guarantee. UI requests use boolean CAS exactly as specified.
- OFF copy says “いつでもONに戻せます”; actual active/live/connection prerequisites can prevent re-enabling. Prefer conditional wording. OFF does not cancel an already in-flight external send; explain this alongside the R2 runtime contract.

## Gate dispositions

- **Auth/tenant baseline:** missing/invalid JWT -> 401; Auth server supplies user id, no user_metadata authorization; caller brand_id extras -> 400; authoritative account brand and exact caller membership; viewer/member rejected for both directions; initial nonexistent and foreign return same bounded 404. Service key only server-side. **FAIL under R1/R3 races**, not blanket PASS.
- **ON:** initial platform/active/live/identity/verified timestamp/refs/error checks and same-row status/null refs/error CAS present; connection-status-failed race refuses. **FAIL R1/R2/R4**; reference presence is not full token/state readiness.
- **OFF:** owner/admin baseline may turn OFF with inactive brand/degraded connection/missing refs; no brand/Vault read needed, no revoke/delete/history/Auth changes. Deletion tombstone can intentionally return ACCOUNT_BUSY. **R1 current authorization race still applies.** No absolute in-flight cancellation claim accepted.
- **CAS/concurrency:** exact id + authoritative original brand + boolean expected state; mismatched read -> 409; zero rows never success; exact PATCH response id/value is checked; fake concurrent duplicate ON yielded one 200 update and one 409 stale refusal. **CAS is not cross-table authorization or isolation**, R1–R4 remain.
- **Exact mutation boundary:** five allowlisted HTTP endpoint classes; only PATCH social_accounts with body `{publish_enabled: desired}`; no explicit updated_at/other column, no other-table/RPC/X/Vault/plaintext/Auth/cron write. Source migrations show deletion guard before social_accounts update and refresh-reset AFTER UPDATE OF verified_at; publish-only update does not name verified_at, so it does not invoke that column trigger. Source inventory found no generic social_accounts updated_at trigger. Existing updated_at is a connection/refresh stamp; not explicitly touching it avoids that lease interference. **Production catalog parity unverified** (see limits below); no claim of verified deployed trigger set.
- **Edge/config:** no tracked supabase/config.toml or deploy override for this new function; repository invokes normal Deno entrypoint, no --no-verify-jwt override. Current official docs say verify_jwt defaults ON, and handler independently validates bearer through Auth /user; **default-on source expectation**, not proven deployed metadata. This new function is not deployed by H1. Future deployment must explicitly keep verify_jwt=true and read back metadata/bytes; unauth/invalid-JWT smoke checks require separately approved nonproduction environment. CORS wildcard with bearer auth/no cookies is not an authorization bypass. Safe bounded errors, no console/request/response-secret logging found.
- **Client:** normal ON confirm/cancel/loading/in-flight double-tap/stale-error reload/exact server response-id-and-value/unknown error sanitization, degraded-ON OFF and static preview refusal pass executed tests. No approvalMode/G3 settings coupling. **FAIL R5 context transitions**; neither simulator nor real backend/provider E2E executed.

## Independently executed verification

- candidate Edge tests: **37/37** (24 logic + 13 HTTP), with type checking, using `deno test --node-modules-dir=auto`; initial plain invocation failed dependency-type resolution before execution, then auto-resolution succeeded. Generated untracked deno.lock removed using apply_patch, never committed.
- `deno check` candidate index.ts: PASS; runtime `deno lint` index/logic/http: PASS; entire candidate directory lint: **FAIL with five require-await findings in pre-existing candidate test helpers** (logic_test lines59/64/69/74/78), not suppressed or falsely reported PASS.
- mobile full `npm test`: **134/134**; domain data-view/post-interaction: **22/22**; `npm run typecheck`: PASS; `npm run lint`: exit0. npm ci used the owned checkout's committed lock and ignore-scripts; no manifest/lockfile change. Existing Node module-type/deprecation warnings are not test failures.
- relevant X/publish guard/token-loader/Vault routing/dispatch/credential-reader regressions: **48/48 with --no-check**. Checked run **FAILS two existing errors outside PR76**: dispatch_gate_test.ts:57 optional BrandRecord.id and x_oauth2_post.ts:66 Uint8Array<ArrayBufferLike>/BufferSource. Candidate Edge checked test/check and mobile typecheck are clean; no repository-wide clean-typecheck claim.
- H1 scratch actual-code probes: **7 server/runtime tests + 2 client tests executed**. Six server tests confirm current adverse behavior (R1, R2 mixed snapshot, cached send, R4, duplicates, R3); seventh positively checks concurrent CAS. Client tests confirm both R5 adverse transitions. “Passed” here means **the bug/counterexample was reproduced**, not a correction/regression success. Scratch first run had an incomplete typed RPC fake and did not execute; supplied complete rejecting unused ports, then reran checked server proofs successfully.
- local scratch recipes (not Git source changes): `/private/tmp/kabumori-h1-resume.DHxA95/pr76_adversarial_test.ts` and `pr76_client_probe.mjs`. Ran against exact assigned source before switching report-only branch to fresh main; all fake domains/tokens/identities, no real backend/X calls. Recipes require the candidate checkout for reproducibility; report checkout is now main/control only. Reproduce on a clean exact-head checkout with the imports/paths adjusted, or the preserved H1 own review branch; never another slot's checkout.
- `git diff --check` candidate: PASS; secret-shape scan all10 changed files: **0 suspected matches** (private keys, secret API keys, JWT-shaped tokens); all test credentials inspected are synthetic fixture strings. This scan is supporting evidence, not absolute absence proof.

## Production/docs limits and safety

- official Supabase authorization-header/auth docs checked through search_docs: https://supabase.com/docs/guides/functions/auth-headers and https://supabase.com/docs/guides/functions/auth-legacy-jwt. Changelog.md fetch rejected unsupported markdown content type; not treated as successful changelog verification.
- authorized read-only production trigger-catalog query attempted, one permitted retry after permission-review timeout; **both returned approval-review deadline errors, no query results**. Successful production catalog reads: **0 confirmed**; execution completion cannot be established from those tool errors. No further retries or bypass; cannot attest production trigger/default-JWT metadata parity.
- production mutation/deploy/migration/RPC/ACL/flags/Cron/Vault/Auth = **0**; real X API/post/media/auth/revoke/refresh = **0**. Fake send callbacks are not X operations. No test production rows/users created; no cleanup of production data required. No DB server/dev server started for this task.
- source changed_files/fix commit: **none**. PR/G4 head unchanged; no merge, no source push to main or other slot, no new PR or G4 allocation. Only H1 control/report files change on delivery.
- changed_files_control: `.agent/tasks/CODEX_TASK.md`, append `.agent/CODEX_REPORT.md`, H1 section only `.agent/ACTIVE_TASK.md`, prepend `.agent/CURRENT_STATE.md`; preserve prior reports and all other slots byte-for-byte.
- commit_hash_control / push: report delivery commit; actual hash and remote read-back recorded in completion response. Do not infer push success without that verification.
- remaining_issues: R1/R2 blockers + R3/R4/R5; test-helper lint, current existing shared checked-type errors; native and real approved nonproduction Data API/JWT/trigger E2E unverified; production configuration/trigger metadata read-back absent.
- merge recommendation: **DO NOT MERGE unchanged PR #76**. C1 must decide corrective scope and route implementation without assuming this review authorizes schema or publishing-runtime changes. Corrective design should preserve OFF availability, exact one-setting mutation, tenant hiding and existing consumer/token/cron boundaries, then return a new exact candidate with adversarial tests for independent review.
- deployment/E2E recommendation: HOLD. After corrected-source review/C1, separately authorize exact single-function deploy (verify_jwt=true + byte/metadata read-back) and disposable-state native/API testing. No production live-enable/test post implied by a function-deploy approval.
- next_recommendation: **C1, 推薦モデル：Sol（高）**. For any separately authorized transactional auth/RPC correction, recommended implementation **Opus5.5（高）** and new **Sol（高）** review. TASK review_required / next_owner chatgpt; H1 STOP.

## Delivery conflict / main synchronization HOLD

- While completing the report, origin/main advanced to `9c8436c` and independently prepended a new K3/H2 review allocation to `.agent/CURRENT_STATE.md`. Replaying the H1-only report commit produced a conflict in that shared control file. Per ORCHESTRATION, stopped and aborted only the H1-owned rebase; did not overwrite/resolve another slot's control history or force-push main.
- Report plus H1 review_required state are published on own report branch `codex/h1-pr76-publish-toggle-report-20261002` only. **Canonical main H1 status is not updated by this delivery**; C1 must safely integrate the four control files preserving current K3/H2/G2 state. No claim of successful main synchronization. No source or PR76 mutation.

## H1 resume — dedicated TASK/REPORT canonical delivery (2026-10-02 JST)

- Fresh fetch confirms PR76 head and H1 assignment are unchanged; this resume performs delivery only, no new source tests or Supabase/X operation. Original review evidence above remains the basis for FAIL.
- Shared CURRENT_STATE/ACTIVE_TASK changed again during delivery. Per orchestration, do not overwrite or resolve those shared-file updates. Fresh main `6957a4f` has unchanged H1-dedicated TASK/REPORT; publish **only `.agent/tasks/CODEX_TASK.md` and `.agent/CODEX_REPORT.md`** from that base. Prior history is preserved exactly. Other-slot TASKs, CURRENT_STATE and ACTIVE_TASK are untouched.
- Earlier branch-only synchronization HOLD is historical and superseded only after the dedicated-file main push/read-back succeeds. **Shared index/summary may still say ready**; C1 should use the authoritative H1 TASK/REPORT and safely update only H1 index/summary as needed. This H1 does not change G4/H2 allocation or take over their files.
- No code fix, PR merge, deploy, production mutation or X operation. Next C1, 推薦モデル：Sol（高）. Exact canonical commit/push/read-back outcome reported in completion.

---

# H1 — PR #79 session-date Hard-boundary review (2026-10-03 JST)

- task_id: `kabumori-pr79-session-date-hard-guard-review-20261003`
- result / verdict: **CHANGES REQUIRED**. Do not merge or deploy the unchanged candidate.
- original reviewed head / final runtime head: **`9ce344b78f23f3bfc1cf033031f1c6ea6bf16fa3`** / same. H1 made no runtime fix.
- test-only evidence head: **`6140968378c44aecd2d40a1cc7d344f2e98e8b4e`**, normal push to H1-only branch `codex/h1-pr79-hard-guard-review-20261003`. The two failing tests intentionally assert the required behavior; this is NOT a green release candidate or a proposed runtime deployment commit.
- isolation: H1-owned checkout `/private/tmp/kabumori-h1-resume.DHxA95/repo`; no shared Developer checkout, G2/H2/G4 branch or uncommitted work touched.
- independently fetched fresh main `c1a9a11`, then `520e43e2bde5ca2c3d4efb41d1f6fe356c885392` for delivery. PR79 merge-base is `85b40b464c29311eae7fba84e13a50cb41dd1a52`, not head^; main-side intersection with the three PR files is **0**. GitHub read-back before delivery: PR open, exact head unchanged, 3 files, mergeable=true. Mergeability is not correctness approval.

## Findings / required corrections

### R1 — P1: hypothetical tail erases an already asserted wrong-date/direction fact

At reviewed PR head `9ce344b`, `hard_fact_guards.ts:180` returns null when `HYPOTHETICAL` matches anywhere in the metric clause. With no numeric token, the later `if (!statesValue && direction === null) return` at line 283 also skips date checking. The strengthened WATCH_RELATION is never reached.

Independently reproduced against the 10/2 morning fixture (US metrics all positive, session 10/1):

- `10月2日は、米国株高が強まり波及するかどうかを見ます。`
- `10月2日は、米国株高が鮮明となり波及するかどうかを見ます。`
- `10月2日は、米国株高が継続し波及するかどうかを見ます。`
- **`10月2日の米国株は下落しており次も続くかを見ます。`**

All four produce **no local Hard rejection**, in market_summary, X context, X closing, App summary, App japan, and an observation claim (24 checks). The last explicitly attaches the wrong date to US stocks and states a fall before asking whether it continues: both date and direction contradict the immutable input. It cannot be justified as a wholly hypothetical move. By contrast, `米国株高が強まるかどうか`, `米国株が上昇すれば`, and `米国株安が続くか` remain genuine uncertain/conditional controls and must not become factual assertions.

This global skip predates PR79 and is independently visible in merge-base source. It is nevertheless a **blocking pre-deploy defect under Gate D**, not waived as unrelated history. Do not shift these objective contradictions to the LLM Fact checker.

Required: distinguish a hypothesis governing the move from an earlier asserted move plus a hypothetical tail. Preserve the existing genuine conditional/negative controls and all Gate A positives. Do not merely blacklist the three reproduced verbs, remove hypothetical support wholesale, or accept another sentence-wide watch escape.

### R2 — P2: normal prior-session watch wording still causes delivery false rejects

Both following sentences produce the US 10/1-versus-10/2 date Hard error in all six factual placements (12 checks):

- `10月2日は、前夜の米国株高を受け、日本株の反応を見る。`
- `10月2日は、米国株高の流れをどう受け止めるかが焦点。`

These do not assert that the US session rose today. The first explicitly refers to the previous night; the second asks how a known move will be received. They are plausible routine morning phrasing, not a safe-to-reject objective contradiction. WATCH_RELATION (`:88-94`) accepts `を踏まえ` and `を受けた動き…`, but not the simple `を受け、…を見る`; it accepts `の影響` but not `の流れをどう…か`. The original broad a70dfdd watch pattern included these watch verbs; the corrective narrowing leaves a recurring delivery-churn risk. The third requested variant, `前日の米国株上昇を踏まえて…確認する`, passes.

Required: support these bounded reference relations while still rejecting assertion-before-watch, past confirmation, wrong-date numeric facts and R1. No blanket exemption for an explicit prior-night marker: a subsequent assertion may still describe today's move.

### R3 — P3: reported changed-file lint PASS is not reproducible

`directionIn` at `hard_fact_guards.ts:168` became unused after callers switched to `directionUse`. Running `deno lint` on the two PR TS files returns exit 1 / `no-unused-vars`; adding the H1 test file yields the same one finding. It was used in merge-base source. Remove the unused wrapper or otherwise resolve the actual lint finding; do not report the G2 lint evidence as independently accepted.

## Other gates / safeguards verified

- **Gate A PASS**: all mandated positive watch shapes and correctly dated prior-session values pass; summary/X/App/claims are covered by the candidate's checked tests, not watch-only fields.
- **Gate B specified examples PASS**: existing assertion-before-watch, no-comma, assertion-then-real-question, past-watch and date-attached forms remain Hard. R1 adds a separate real bypass that these tests missed.
- MOVE_LIST/NOUN/PLACE/REFERRED_MOVE/TOPIC inspected. MOVE_LIST can consume verbal material, e.g. bare `や上昇した半導体株高`; an undated relative past clause can itself refer to the prior session, so that alone is not proof of an objective lie. In added explicit-`今日` controls, `今日上昇した…` is rejected by the date guard; `今日反落した…` has no metricFactIssues rejection but localAnalysisCheck catches `反落` via the existing multi-day-word rule. The parallel-move regression therefore **passes**; this review does not falsely claim both are blocked by WATCH_RELATION or label a bare ambiguous past reference as a proved contradiction.
- **Gate C PASS** for required wrong-date numeric/change cases, 9/29 Nikkei + 9/30 1306 mixed-date regression, stale/current, 1306 naming, sign/direction/emoji, unsupported market causality and unknown refs. These correct ordinary paths do not repair R1's nonnumeric conditional-tail bypass.
- **Gate F PASS within source scope**: PR diff has no changes to `analysis_logic.ts`, `_shared`, or data-packet source. PR77 quality WARN/rewrite, safe-original fallback, packet contract and model-call ceiling remain unchanged; their tests pass. This does not authorize a production rollout.
- H1 deliberately returns correction to G2: safely closing the combined hypothesis/assertion classification and reference-relation gaps needs a coordinated guard-boundary correction with positive and negative semantics proved together. A wrapper cleanup or an ad-hoc one-verb regex patch would not resolve the review. No broader parsing framework, model/prompt/call-budget/contract or production-specific change was attempted.

## Independent test results

Original exact runtime candidate, before H1 test addition:

- full `market-report-analysis`: **123 PASS / 0 FAIL**, type-checked test run. Includes session-date 10, presentation_v2 22, causal_calibration 18, quality_calibration 9, h1_adversarial 13, content_guard 16, transport_retry 14.
- `personalized-reports`: **128 PASS**, X shared consumer **8 PASS**, `market-report-data-packet` **42 PASS**, `_shared` **361 PASS**. These four were run with `--no-check --allow-all`; no claim of full shared/consumer TypeScript validation. Test doubles/fixtures only, no production invoke or real model/provider call.
- `deno check --no-lock --node-modules-dir=auto` for analysis entrypoint plus session-date test: **PASS**. Additional check of analysis_input, analysis_logic, hard_fact_guards, handler, index, transport_retry and H1 boundary test: **PASS**, dependencies transitively checked.
- changed-file `deno lint`: **FAIL**, one R3 unused-wrapper issue; separately verified exit 1. An earlier chained shell command ended with successful diff-check, but its lint error was retained and NOT counted as PASS.
- `git diff --check`: **PASS**.

H1 evidence at `6140968` (same runtime, one extra test file):

- `h1_pr79_boundary_test.ts`: **2 PASS / 2 FAIL**. Failing: R1 hypothetical-tail assertion; R2 legitimate watch variants. Passing: explicitly current parallel-move controls; genuine hypotheses + original delivered packet.
- extended full analysis: **125 PASS / 2 FAIL**. Existing 123 remain passing; independent failures are intentionally not skipped or rewritten to bless current broken behavior.
- Initial scratch parallel-move test using ambiguous bare past modifiers had a third failure; refined it to explicit `今日` assertions to avoid equating legitimate prior-session relative clauses with a proven current-session claim. Final results above supersede that exploratory 1 PASS / 3 FAIL run.

## Delivery / remaining issues / next step

- changed_files_source: only `supabase/functions/market-report-analysis/h1_pr79_boundary_test.ts` on H1-owned evidence branch. Candidate runtime/docs and G2 PR branch unchanged; no fix commit is claimed.
- changed_files_control: only H1 `.agent/tasks/CODEX_TASK.md` and append `.agent/CODEX_REPORT.md`, based on fresh main. Preserve prior TASK history and the existing Report byte-for-byte; no CURRENT_STATE/ACTIVE_TASK or other-slot write.
- commit_hash_control / push: completion-report delivery commit; exact hash and remote verification in final response. Source evidence push returned success; remote SHA read-back is required before claiming final publication.
- merge / deploy: **none**. Production reads/mutations **0/0**; DB/Auth/Vault/secrets/OAuth/Cron/gates, real X and manual Edge/model operations **0**. Supabase skill safety procedures informed the local-only verification; no production boundary was expanded.
- remaining_issues: R1/R2/R3; no actual model run/native UI/production telemetry was requested or performed for this guard review.
- next_recommendation: **C1, 推薦モデル：Sol（高）**. C1 should accept CHANGES REQUIRED and route a focused G2 source correction (**推薦モデル：Opus5.5（高）**), carrying the evidence tests plus all mandated controls. Do not allocate or overwrite a slot from this H1 review.
- rollout prerequisites: corrected exact head + independent green positive/negative review; only afterward C1 may approve merge. Later PR77+accepted PR79 rollout remains one explicitly approved `market-report-analysis` deploy, app/x gates OFF, exact byte read-back, natural-cycle observation. No deployment/merge permission is implied by this report.
- authoritative H1 TASK now `review_required`, next_owner `chatgpt`; shared indexes may be stale until C1 safely synchronizes H1 only. H1 STOP after dedicated report publication/read-back.

---

# H1 — PR #79 corrected Hard-guard rereview (2026-10-03 JST)

- task_id: `kabumori-pr79-hard-guard-rereview-20261003`
- verdict / result: **PASS-WITH-FIX** for the exact corrected H1 candidate below. **Unchanged PR head f7083ba is not approved**: it still had the newly reproduced question-token bypass and causal-watch delivery false positive.
- original reviewed head: **`f7083ba6a810d5f9cdbe7090e4439f261e38bf0f`**.
- final verified head / fix commit: **`b6d2dce3cc45c73951e51d139fefeddad7e2906e`**. Direct descendant of the original head; one bounded correction commit on **H1-only** `codex/h1-pr79-rereview-20261003`. Normal push succeeded and `git ls-remote` independently returned this exact SHA.
- mandatory isolation: H1-owned checkout `/private/tmp/kabumori-h1-resume.DHxA95/repo`, own source/report branches. Shared checkout, G2 branch/PR, H2 and other worktrees untouched. Startup main `cde3a7d`; delivery base `8aab09ca3cdd7a12752602db4eeafadcaf159ea9`.
- original PR metadata independently read twice: open, exact f7083ba, four changed files; actual merge-base `85b40b464c29311eae7fba84e13a50cb41dd1a52`. Main-side intersection with PR files **0**, also **0** with the H1-added analysis_logic source file. Main's other-slot UI/news/diary changes are not adopted or overwritten by this review.

## Gate results / findings / bounded H1 fixes

**Prior P1/P2/P3:** G2's five required assertion-before-question sentences now produce a session-date Hard rejection in all six factual placements; the incorrect US fall also produces direction inversion. Original watch-reference examples, correct explicit prior-session dates and genuine conditions remain date-safe. The unused wrapper is gone and original three-file lint actually exits 0. Exact candidate's existing full analysis suite independently passes **131/131**.

**New R1 — P1, fixed:** `HYPOTHETICAL` and the relation's `続くか` alternative matched a prefix of the causal assertion **`続くから`** (also `するから/なるから`). Before the H1 patch, both `10月2日は、米国株安が続くから反応を見ます。` and `10月2日の米国株は下落するから、反応を見ます。` produced **no local Hard issue**, although the US packet is only 10/1 and is positive. Separately, the 6-kanji/3-hiragana prefix admitted an asserted copula such as `10月2日の米国株は下落が明白で続くかを見ます。`.

- Regression-first: added required date+direction checks across all six factual placements, not only `metricFactIssues` or a watch field. They failed against f7083ba.
- Minimal correction: question `か` must not continue as `から`, in both HYPOTHETICAL and the two watch-relation branches. GOVERNED_BY_QUESTION excludes a prefix ending in continuative `で/し/て/り`; this distinguishes an already asserted premise from the next question without a general parser or blacklisting three particular example verbs.
- Final checks include `明白で`, `確定し`, `明確となり`, punctuation/no-punctuation, particle forms and the case with **matching positive direction** (`米国株高が続くから`): that last still fails the date guard rather than relying on inversion. Genuine `強まるかどうか`, `上昇すれば`, `株安が続くか`, `強くなるか`, and past questions `上昇したかどうか/強まったかどうか` remain non-factual.

**New R2 — P2, fixed / bounded degree modifiers:** the known `一段と強まるかどうか` and independently tested `さらに強まるかどうか` were honest questions but falsely treated as dated facts by the old prefix pattern. Added only these two degree-modifier tokens before the same bounded predicate; a further asserted predicate still fails the classification. Six-kanji and three-hiragana positive controls also pass. This is not unrestricted text between the move and a question.

**Gate E / R3 — P2, fixed / causal interaction:** the date fix alone was insufficient: `前夜の米国株高を受け、日本株の反応を見る` still failed the causal Hard checker in all six factual placements. The existing original positive `米国市場の上昇を受けた動きが続くかを確認します` did too. These purely terminal plans/questions assert no effect that happened. Rejecting them is a real product-policy delivery false positive, not solved by moving text into watch fields or weakening a prompt.

- H1 authority explicitly allows one narrow causal-watch classification correction. Added two anchored **whole-effect** predicates inside `unsupportedCausalSentences`:
  - Only link `を受け、` or `を受けて`, followed by `日本株/東京市場` + `の反応/値動き/動き/受け止め方を` + terminal `見る/見ます/確認する/確認します`.
  - Only link `を受けた`, followed by a fixed result noun (`動き/流れ/買い/売り/反応/値動き/展開`) + `が/は/も続くかを` + the same terminal watch verbs.
- This removes no evidence requirement for an actual or speculative market effect, past confirmation, different causal links, or a watch followed by an assertion. It is per-link, with the entire effect span matched to the end; no sentence-wide watch shortcut. Cause-side metric/date/sign/ref checks still execute unchanged.
- Before fixing, four added tests yielded **5 PASS / 3 FAIL** (the three failures: lexical/copula bypass, degree-modifier false reject, full-delivery causal watch). After fixing, all three pass. Added a separate causal negative test and cause-side contradiction test; final H1 boundary suite **9/9 PASS**.
- Final pure-watch positives pass **all Hard guards** in all six factual placements. Negative cases retain unsupported-causality Hard: actual `日本株が上昇しました`, watch then assertion, watch-before-rise, watch-before-先行, `見ると上昇`, past confirmation, speculative `上昇が続く可能性`, `を受けた動きが続くから`, and `動きが強まり続くか`. Cause-side wrong-date NYダウ value, US direction inversion, incorrect change sign and unknown ref stay Hard.

**Gates C/D / remaining safeguards PASS:** G2's six negative P2 relations, explicit prior-night marker followed by current assertion, date-attached prior-night wording, wrong-date numeric/change, the exact 10/1 mixed 9/29 Nikkei + 9/30 1306 regression, stale/current, 1306 naming, sign/direction/emoji, unsupported causality and fabricated refs remain protected. MOVE_LIST's narrowed nominal-only list no longer swallows the verbal assertion control. No test's unrelated failure is substituted for the required date/direction/causality invariant.

**PR77 compatibility PASS:** H1 changes only Hard clause/question and terminal causal-watch classification, tests and the corresponding design notes. Quality WARN/rewrite code, safe-original fallback, prompt/model, MAX_GENERATIONS, transport/model call ceilings and packet schema are unchanged. Quality calibration, fallback and transport budget regressions pass.

## Final independent verification

At the corrected source tree (one source commit b6d2dce3):

- full `market-report-analysis`: **136 PASS / 0 FAIL**, checked run; session-date **14**, H1 boundary **9**, presentation_v2 **22**, causal_calibration **18**, quality_calibration **9**, h1_adversarial **13**, content_guard **16**, transport_retry **14** included.
- `personalized-reports`: **128 PASS**, X shared consumer **8 PASS**, data-packet **42 PASS**, all run **with type checking**. Rerun after the fix; no `--no-check` for these suites.
- `_shared`: checked run **FAIL before tests**, five pre-existing unrelated type errors: three `never` capturedBody accesses in brand_post_generator_test, optional brand id in dispatch_gate_test, and ArrayBufferLike/BufferSource in x_oauth2_post. Those files are unchanged by PR/H1. Then full runtime suite **361 PASS** with **`--no-check`**. This is runtime verification, NOT a claim that the shared checked suite is clean.
- explicit `deno check --no-lock --node-modules-dir=auto`: **PASS** for analysis index/guards/logic/two boundary tests, personalized index, X shared consumer test and data-packet index. Full analysis test run also checks all its test modules.
- `deno lint` on all four relevant TS files (including the newly touched analysis_logic): **PASS, exit 0**, no suppression.
- `git diff --check`: **PASS**; source diff from f7083ba only four files, 107 insertions / 6 deletions.
- No real model, Edge, database, Auth or X test call. All runtime tests use local fixtures/test doubles. Consulted official [Supabase Deno unit-test guidance](https://supabase.com/docs/guides/functions/unit-test); the skill kept verification local/no production mutation. Changelog Markdown fetched once, returned unsupported content type, not treated as successful API-version verification; no Supabase API/config change was made.

## Delivery / remaining obligations / C1

- changed_files_source (H1 fix only): `supabase/functions/market-report-analysis/hard_fact_guards.ts`, `analysis_logic.ts`, `h1_pr79_boundary_test.ts`, `docs/market-report-shared-platform/DESIGN.md`.
- commit_hash_source / push: **`b6d2dce3cc45c73951e51d139fefeddad7e2906e`**, H1-only branch normal push and remote SHA read-back confirmed. **G2 PR #79 head is still f7083ba**; no merge, source-main write, force-push or automatic PR incorporation by H1.
- changed_files_control: only H1 `.agent/tasks/CODEX_TASK.md` + append `.agent/CODEX_REPORT.md`, based on fresh main. Prior histories preserved byte-for-byte; shared CURRENT_STATE/ACTIVE_TASK and all other-slot control files untouched. Exact control commit/push/read-back recorded in completion reply.
- production reads / mutations: **0/0**; deploy, gate change, manual cycle/retry, DB/schema/RPC/migration, Cron/Auth/Vault/secrets, real X and real model/provider operations **0**. Supabase testing skill did not broaden authority.
- remaining_issues: no blocking finding in the tested exact scope after the fix; `_shared` checked-type debt remains unrelated/unfixed. Finite Japanese patterns are still conservative for arbitrary long/unknown modifiers; no claim of exhaustive NLP. Actual live-model phrasing, first-cycle completion/cost/hard_rejection telemetry remain unverified until a separately approved natural-cycle rollout.
- merge recommendation: **conditional source acceptance only for b6d2dce3 or verified equivalent incorporation**, not unchanged f7083ba. C1 should arrange exact bounded fix incorporation into the existing PR, confirm new PR head/source/read-back, fresh main overlap and required checks. Do not create or overwrite another slot TASK from this H1.
- rollout prerequisites: C1 acceptance and source merge first; then separate explicit approval for one `market-report-analysis` deployment containing PR77 + accepted PR79, app/x gates OFF, exact byte read-back, natural cycle only. No production authorization is inferred from review PASS.
- next_recommendation: **C1, 推薦モデル：Sol（高）**. TASK `review_required` / next_owner `chatgpt`; dedicated TASK/REPORT authoritative, shared indexes for C1 to align safely. H1 STOP after report publication/read-back.

## H1 — PR #82 event-level dedupe review — 2026-10-03 JST

- task_id: `ai-lab-pr82-event-dedupe-review-20261003`
- result / verdict: **CHANGES REQUIRED**. Do not merge/deploy unchanged PR #82. Passing sequential happy-path tests do not satisfy the explicit concurrency/usage-failure safety gate.
- reviewed exact head: `08a7346ccd63f2ff540bd48149f1f1e65e6dbe09`; GitHub independently read back open/head-matching/8 changed files at startup and before completion. No H1 update to that PR/head.
- actual merge-base: `95fcb391f47296ebf5a7d880a03b834e430b1c6a`. GitHub's live base SHA is not the merge-base. Fresh main `a633961056e5f8b628ae59c72163306c21c3f399`: zero path overlap with the eight PR files; main-side diary Markdown/snapshot updates noted, not overwritten.
- isolation: H1-owned `/private/tmp/kabumori-h1-resume.DHxA95/repo`; disposable detached baseline worktree + PostgreSQL 17 under H1-owned `/private/tmp/kabumori-h1-pr82-db.8K53G5`. No G3/G4/shared checkout, server, migration or uncommitted changes touched.
- changed_files_source: only `supabase/functions/_shared/brand/h1_pr82_event_boundary_test.ts` and `supabase/tests/h1_pr82_event_usage_review.sql`. No runtime/migration implementation change. Evidence-only commit **`100ab65f8142adc11916f467f68415d15cbc00b1`** pushed to `codex/h1-pr82-event-review-20261003`; remote SHA read-back confirmed. Intentionally RED safety tests, not a release candidate or replacement PR.
- changed_files_control: H1 TASK + append-only H1 REPORT on fresh-main-only report branch. Prior histories preserved; shared CURRENT_STATE/ACTIVE_TASK and all other-slot TASK/Report files intentionally untouched. Final control commit/read-back recorded in completion reply.

### Findings / reproduction

1. **P1 — no atomic event ownership before X** (`ai_lab_scheduled_brand_post.ts:139`, usage table PK `scheduled_post_id`). Two distinct schedules read the same empty usage/fingerprint snapshot, select the same diary event with different angles, pass every existing content/dispatch/fingerprint guard and both reach fake X. The barrier regression observes **two publishes**. Usage is only written after X; different scheduled UUIDs can both insert the same event, independently confirmed in PostgreSQL. A per-schedule claim/spacing does not serialize event ownership.
2. **P1 — successful X + failed usage write loses dedupe; crash windows are not closed** (`ai_lab_scheduled_brand_post.ts:143–161`, `x-test-post/index.ts:4085–4102`). Usage false/throw is absorbed; completion/fingerprint can succeed, then the next successful usage GET returns no record for this event. The next schedule selects it again and a different valid paraphrase reaches fake X: **two publishes**. Cross-brand hash logic deliberately excludes own-brand fingerprints and is not event protection. A confirmed-X/before-usage paused-hook regression likewise reaches two publishes; a hard process crash at that boundary has no earlier durable event claim to preserve. An accepted-X/lost-response regression also repeats on the next slot. After usage succeeds but completion fails, the positive control excludes the event and raises `AiLabConfirmedPostCompletionError`; current outer handler suppresses `fail_scheduled_post` for that handled error. This protects that handled same-schedule failure, not all crash/recovery interleavings. No claim that the same scheduled row automatically retries: production recovery/operator behavior was not invoked. Different next schedules already prove the event-level defect.
3. **P2 — ordinal event identity is mutable** (`ai_lab_dev_diary_context.ts:341–346`). Same-date insertion or reordering moves a consumed event from ordinal 1 to 2; prior usage of key 1 then incorrectly suppresses another event and revives the consumed one. Removing another entry's required `changed` field drops it before ordinal assignment and moves a consumed ordinal-2 event to ordinal 1. All three safety regressions fail. Sanitizing an unsafe field after assignment preserves ordinal in the unchanged order; that narrower positive case is not insertion/reordering stability. Comments requiring append-only same-date edits do not enforce durable identity.
4. **P2 — silent conflicting schedule ID acknowledged as new persistence** (`ai_lab_brand_post_store.ts:190–206`). `resolution=ignore-duplicates,return=minimal` plus `response.ok` cannot distinguish exact idempotent replay from an existing different event/unit/X ID. PostgreSQL `ON CONFLICT(scheduled_post_id) DO NOTHING` leaves the old event/X ID unchanged; mocked PostgREST success is reported true for the mismatched new event. Exact replay can be accepted only after identity equivalence; mismatches must be rejected/quarantined, not overwritten or reported as saved.
5. **P2 — migration reapply accepts unsafe drift** (`20261003090000_ai_lab_topic_event_usage.sql:16–30`). On a fresh table RLS/effective named-role ACL are correct. Reapply after deliberately removing PK/event CHECK/brand CHECK and replacing the same-named index with an X-ID index succeeds without rejection/repair. Wrong-brand/raw-event/duplicate-schedule insertion then succeeds. Existing permissive policies survive (named-role ACL still revoked, so policy presence alone does not prove anon access). Clean reapply is idempotent; unsafe drift acceptance is a separate failed requirement.
6. **P2 — advertised evergreen cooldown is not a hard boundary** (`ai_lab_dev_diary_context.ts:454–462`). Exhausting all seven seeds inside 72h selects least-recent anyway; regression with all seeds used 1–7 hours ago fails. Fallback can also bypass the generic-theme exclusion used to construct the allowed pool. Normal non-exhausted tests verify 72h seed/48h theme rules. Decide explicit safe-skip/product contract; do not claim unconditional cooldown with the present fallback. Usage read failure returns null and blocks diary selection but still publishes evergreen with no seed/theme history; that is diary-only fail-closed, not event-wide fail-closed.
7. **P3 — strict changed-file lint not clean**. New `ai_lab_event_dedupe_test.ts` adds 20 `require-await` warnings in async stubs. Remaining 29 checked-file warnings are reproduced unchanged on the merge-base (diary async loader 1, scheduled test 16, topic test 9, entrypoint 3). Three changed runtime modules typecheck; runtime lint still has the pre-existing loader/entrypoint debt. H1-owned async stubs have an explicitly scoped `require-await` exemption and otherwise lint clean. No unrelated lint/type refactor attempted.

### Old bug / other review gates

- Independently executed the selector from the detached actual merge-base against 9/30 fixture, rotations 100–105: `changed → angle1 → difficulty → angle2 → decided → changed`, all from the same real event. New implementation's focused 26 tests establish all five units share one event key, persisted usage excludes all angles, newest unused fresh event wins, then evergreen; rotation cannot override correctly loaded used keys.
- `loadAiLabTopicUsage`: AI-Lab brand equality, 14-day lower bound, descending publication time, limit 200, metadata-only select; HTTP/parse/malformed-row failure yields null. Nominal low-volume history fits the cap, but a saturated 200-row response has no pagination/completeness signal; omitted rows cannot be treated as proven unused. No production volume inspection or claim that saturation occurred.
- `recordAiLabTopicUsage`: event regex before network, metadata-only payload, never propagates read/write errors. Field-shape CHECKs are not durable identity validation, and calendar/ordinal ranges are only syntactic at this DB boundary. No raw body column or raw diary/post text write introduced; X ID check is length-only, so this is schema convention + trusted writer, not a general body-content sanitizer.
- Existing content retries (max 3), brand/account/type/live dispatch guards, adjacent final length/content gate and cross-brand fingerprint check are still wired. Tests cover rejection before X and no usage on known pre-X failures. AI Lab-specific hook only; no other brand, morning/close, OAuth, Cron/config/secret/gate/posting-window source change in PR82.
- Topic exclusions contain key-shaped candidates + machine codes, no diary/post body. New usage failure logs event key/schedule ID only. The schedule UUID is an existing operational ID, not a newly logged secret; no new internal diary prose leaked.

### PostgreSQL 17 proof / ACL / cleanup

- Exact candidate migration applied only through `psql` on an empty isolated local server with fake NOLOGIN anon/authenticated/service_role roles. Simulated broad default table grants before creation, then checked effective privileges including PostgreSQL 17 MAINTAIN.
- **16 observation probes + four invalid-input CHECK cases** executed successfully. These include observations of unsafe states, so this is reproduction success, NOT a migration safety PASS.
- Fresh: RLS enabled, zero policies; anon/authenticated have no SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN; service_role has SELECT/INSERT only and none of the other privileges. Four invalid brand/event/unit/X-empty inputs rejected. Owner/superuser/BYPASSRLS semantics are not claimed to protect privileged administrators.
- Fresh index matches `(brand_id,published_at DESC)`; forced-index EXPLAIN confirms it supports the bounded ordered read. This checks compatibility, not a realistic planner/performance benchmark on a two-row table.
- Clean second application retains data/ACL. Drift third application accepts missing constraints/wrong index/old policy; same event on two schedules and conflicting schedule id independently demonstrated.
- Transaction rolled back all fake data/schema/default ACL/roles; separate read-back returned table absent and fake roles absent (`t|t`). H1-only local server then stopped. No production migration ledger or project DB touched. Local disposable files retained for reproducibility; no user material deleted.

### Tests / exact verification limits

- Focused seven checked suites: **96 PASS / 0 FAIL**, including new candidate event suite **26 PASS**.
- Existing `_shared` + `x-test-post`, excluding H1 adverse file: **901 PASS / 0 FAIL**, `--no-check --allow-read --allow-env`. No live endpoints/model/X called by H1 probes; production credentials never loaded.
- H1 required-contract safety file, checked: **2 controls PASS / 9 required safety regressions FAIL**. This is deliberate RED evidence: concurrent schedules, usage failure/next publish, lost X response, confirmed-X/before-usage window, three identity edits, mismatched idempotency, exhausted cooldown. Earlier fixture-account mismatch was corrected before the definitive run; no false guard-failure counted as a vulnerability.
- Changed store/diary/dispatcher module `deno check` PASS. Full `x-test-post/index.ts` check FAIL on **six pre-existing errors**, independently reproduced on the actual merge-base: `_shared/x_oauth2_post.ts:66`, `index.ts:3047` Uint8Array/BufferSource; greeting image `:136/:221` Blob/fetch bytes; greeting logic `:316` missing retry_count; morning lane `:230` unknown timestamp precision. No new checked error introduced by reviewed event wiring. Do not describe the full entrypoint as typecheck PASS.
- Strict lint selected eight files: 49 candidate problems, 29 baseline + 20 new async-stub warnings; H1 own file 0. H1 test + changed store/dispatcher subset lint PASS. No blanket claim of candidate lint PASS.
- `git diff --check` PASS; exact PR scope checked; secret-shape scan of focused runtime/tests/SQL found no real-key-shaped matches (the candidate contains explicitly synthetic short `sk-abcdefghijklmnop` sanitizer fixture, not a real credential).
- Full 2474-Function suite reported by the implementer was not rerun; H1 independently ran the relevant scope above. No production runtime/source/config read-back, native UI or live provider integration attempted for this source-only gate.

### Correction contract / next owner / rollout

- Stable persisted diary event ID must survive insertion/reordering/optional-field sanitization; explicit non-sensitive immutable IDs preferred. Preserve already-used ordinal history through a reviewed compatibility mapping; do not reset usage or backfill arbitrary "unused" IDs and revive backlog.
- Before any X side effect, atomically acquire a **durable per-brand/per-event claim** and bind scheduled ID + attempt/fencing token. A/B on the same event cannot both own an active claim. Diary used-state and evergreen cooldown need explicit different lifecycle semantics; permanent unique usage on an evergreen seed would prevent legitimate reuse forever.
- Lease may expire/release only for a provably pre-X failure or fenced pre-provider state. Atomically record provider-started before calling X; after start, timeout/network error/crash is ambiguous and must remain blocked/quarantined until read-only reconciliation proves outcome. Expiry alone must never reopen a may-have-posted event. A short DB advisory lock/transaction ending before X is insufficient; do not hold a long database transaction across X.
- Confirmed X ID must settle the existing claim as published and persist event usage/completion consistently. If final persistence fails, retain the pre-X claim as blocked; never delete it/requeue X to "repair" the DB. Cross-system exactly-once cannot be promised without provider idempotency or verified reconciliation; ambiguous outcomes may safely lose a slot rather than duplicate X.
- Idempotency verifies exact scheduled/event/unit/X identity; conflicts yield explicit operator-safe errors. Read failure or incomplete capped history must not prove a seed unused. Exhausted cooldown pool should safely skip unless product explicitly authorizes weaker semantics.
- Migration must refuse incompatible pre-existing catalogs (columns/types/null/defaults/CHECK/PK/index/RLS/effective ACL/policies) or perform reviewed deterministic repair. A safe clean reapply remains supported; unexpected ownership/role inheritance/grants must not silently broaden service or tenant access.
- Add corrected positive A/B ownership + pre/post-X failure/recovery + stable-ID + drift refusal + evergreen re-entry tests. Preserve all existing content/cross-brand/final dispatch guards; do not solve it by changing frequency, X text, unrelated brands or Cron.
- merge recommendation: **HOLD / return for correction**. No large reservation/migration redesign improvised in H1. C1 should assign a non-conflicting correction owner/worktree, respecting active G3/G4 ownership. Suggested corrective implementation model **Opus5.5（高）**; rereview **Sol（高）**.
- rollout order only after corrected source acceptance: reviewed additive claim/schema migration first, deployment after compatibility verification, then authorized natural-cycle observation. Each production step needs separate explicit approval; no backlog/test candidate injection/manual X/Cron/frequency/content/gate/OAuth change inferred here.
- production read / write: **0 / 0**; real model/X/token operations, merge/deploy = **0**. Supabase/Postgres skills restricted verification to disposable local SQL and exposed ACL/drift/crash boundaries; did not grant production authority.
- next_recommendation: **C1, 推薦モデル：Sol（高）**. H1 TASK `review_required`, next_owner `chatgpt`; STOP after exact control-file push/read-back. Shared indexes may be aligned by C1, not overwritten by H1.

## H1 — PR #82 durable-claim rereview — 2026-10-04 JST

- task_id: `ai-lab-pr82-claim-rereview-20261004`
- result / verdict: **CHANGES REQUIRED**; HOLD merge/deploy. No runtime or migration fix improvised.
- exact reviewed head: `9f3b19a3cde490cf63735220ae191dcd4f11bdcb`; PR #82 open/unmerged, independently rechecked after tests.
- merge-base: `0e907cfcd2a3ca88764190fd25459aa021b0a7af`. Completion-side fresh main: `1a713f8c7fc48629262c6cdc7c11fed1fa316e8e`.
- independent checkout: `/private/tmp/kabumori-h1-20261004.ijIgLn/repo`; separate report worktree from fresh main. Shared Developer checkout and all other slot worktrees were not edited.
- changed_files: H1 evidence only `supabase/tests/h1_pr82_claim_boundary_test.mjs`, `supabase/tests/h1_pr82_workflow_boundary_test.mjs`; control sync only `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md`. Candidate's 13 source/config files unchanged by H1.
- commit_hash / evidence push: `0801619f4bcd882dadc71deab5cd07493a7ea80a`, H1-only branch `codex/h1-pr82-claims-20261004`, successfully pushed. **Intentionally RED safety evidence, not a release candidate.** No new PR created and PR #82 branch not mutated.
- deploy / merge / production read / production write / real model-X-Vault-token operations: **0 / 0 / 0 / 0 / 0**.

### Previous blockers and demonstrated improvements

- Ordinary same-diary concurrent dispatch is now protected: actual candidate SQL, actual topic port and actual dispatcher, two scheduled UUIDs, same candidate list, simultaneous calls => exactly one fake X and one published row. A second angle shares the same event identity. This closes the previously proven ordinary two-worker race, not all other boundaries below.
- Durable provider_started precedes X; the claim SQL transaction ends before generation/provider work. No DB transaction spans the fake X barrier. Lost response after committed start causes zero X and keeps diary blocked. X-confirmed + settle error + successful completion leaves provider_started, returns SETTLE_FAILED and prevents later diary claim.
- Expired **claimed** lease can be reclaimed with a new claim_id. Old worker cannot start, release the new row or settle its expired row. Exact idempotent settlement/conflicting X/event/unit, ambiguous-to-published, published no-release, same-schedule conflicts are covered by candidate SQL runner plus actual dispatch controls.
- Permanent diary active partial UNIQUE independently rejects a direct second active row. Removing only UNIQUE makes that independent control fail. Removing only advisory locking makes the runner's two-session race fail on duplicate-key insert; either weakened protection is detected. The one brand-wide xact advisory key is deterministic; collisions could over-serialize, not grant a second diary owner. Other RPCs are fenced state updates, not alternate claim acquisition; API direct inserts denied on clean install.
- Explicit event_id survives ordinary reordering/body changes and candidate cross-entry duplicate/missing/unsafe filtering. Same-date uniqueness in CI is an intentional documented one-entry-per-day constraint, not runtime multi-event support. All eight current IDs were inspected: date-bound public descriptions, no PR/commit/task/token/DB identifiers. However duplicate labels inside one entry remain a blocker.
- Old unconditional least-recent evergreen fallback is removed; normal canonical 72h/48h pool exhaustion returns no claim and prevents X. Released/expired rows do not consume cooldown. Re-entry for a confirmed settled seed after cooldown is intentionally allowed.

### Findings requiring correction

1. **P1 — duplicate event_id scalar silently revives a consumed diary event.** `ai_lab_dev_diary_context.ts:168–169` assigns each event_id label without counting/rejecting duplicate labels. Appending a second valid date-bound ID to the same entry overwrites the first ID and produces a fresh diary key. The actual workflow parser/validator also accepts it: runtime H1 required assertion fails (one diary candidate instead of zero), CI required assertion fails (no exception). Existing duplicate tests cover separate entries, not duplicate labels inside an entry. Reject ambiguous scalar identity before candidate construction and before snapshot generation; do not silently sanitize/select an ID. Preserve any previously published identity during correction.

2. **P2 security — ACL proof ignores owner identity and effective inherited grants.** Migration lines 422–444 exclude relowner/proowner from ACL checks without refusing API role ownership or unsafe inheritance. Local clean/reapply is safe under the expected migration owner, but reapply accepts table owner service_role and claim-function owner anon. Independently reversing the local fixture membership edge so service_role inherits the table owner makes `has_table_privilege(...,'TRUNCATE')` true **before and after successful reapply**. Named ACL revocation does not revoke inherited owner grants; ownership also carries DDL control even when explicit DML is revoked. Refuse unsafe table/function owners and effective named-role privileges/membership, including PG17 MAINTAIN; pin a reviewed owner policy rather than silently changing production role graphs. No claim that production actually has this drift: production roles were not read.

3. **P2 — real proven 401 rejection is permanently quarantined.** Dispatcher line 54 only recognizes exact X_REQUEST_FAILED:400/401/422/429. Actual AI Lab postToX uses VaultAccountXAuth: `.send()` converts a genuine 401 to X_ACCESS_TOKEN_UNAUTHORIZED when refresh is disabled/used, or X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH after a second 401 (vault_account_auth.ts:139–156). The supplied status fixture bypasses this contract. H1 executed the real wrapper with fixture credentials/no refresh and fake 401, through the actual dispatcher and SQL: row becomes ambiguous, not released. The diary then remains blocked despite no accepted write. Introduce a typed/proven pre-write rejection classification shared with the actual abstraction; never broadly match generic local/proxy failures or refresh/transport uncertainty. Preserve account/Vault/OAuth behavior; do not perform actual token refresh in a test.

4. **P1 safety contract — unresolved evergreen becomes eligible again solely by age.** Migration lines 231–245 require claimed_at inside 72h/48h even for provider_started/ambiguous. A still unresolved row aged 73h permits another claim on the same seed; no evergreen active UNIQUE prevents it. The old provider-started row remains independently settle-capable. Local wall-time simulation paused the actual dispatcher after start, aged only local timestamps, ran a replacement dispatcher and resumed the first: **two fake X calls** and independently valid settlements. This is a deliberate time-simulation probe, **not evidence an Edge isolate really runs for 73 hours**, and not a reproduction of the already-fixed ordinary diary race. Even without such a long-lived worker, an unresolved possibly-posted outcome automatically becomes reclaimable, contrary to Gate L's quarantine contract. Define evergreen unresolved-outcome semantics explicitly: permanently/operationally block unresolved starts, or require proven reconciliation before allowing a new generation; reuse only confirmed settled eligible seeds. Do not turn evergreen into a forever-unique published pool.

5. **P2 — cooldown is claim-time based, not publish-time based.** A seed claimed 72h1m ago but confirmed published 71h59m ago is already claimable. Both 72h seed and 48h theme clocks use claimed_at, and ignore settled_at; slow/late confirmed publish makes the gap materially shorter. Bind confirmed cooldown to an explicit publication/settlement timestamp, while unresolved starts remain quarantined. If the product intentionally means reservation-to-reservation spacing, amend the contract explicitly; it is not the previous usage-after-publish behavior or a proved publish-to-publish cooldown.

6. **P2 — strict DB payload/theme relationship is not enforced.** Extra JSON keys (e.g. body) are accepted and discarded, despite the comment at line 255 saying table CHECK rejects them. CHECK only sees extracted columns. Tags are an allowed-name subset but are not bound to canonical seed; supplying evergreen-5 with [] bypasses its overlap with recently published evergreen-0/unglamorous_work. Kind/event regex admits out-of-pool evergreen seeds and loose unit relationships. Actual RPC probes independently accept extra-key input and bypass the 48h theme guard. This is a service-only contract/defense-in-depth failure, not a public unauthenticated exploit; current canonical TS builder supplies honest mappings. Validate the entire JSON object and canonical kind/event/unit/theme mapping before selecting/claiming, not only the inserted row; reject malformed entries even if an earlier candidate could be selected. Never store post bodies.

7. **P3 — changed test-file lint has net-new debt.** Exact changed TS tests/snapshot: 65 require-await diagnostics vs 25 at merge-base, net +40 (event suite 30, scheduled suite 21 vs 16, topic suite 14 vs 9). Runtime lint's four diagnostics are unchanged baseline, not new runtime errors. Clean new fake async signatures with Promise.resolve/reject or a narrowly justified test-only rule policy; no broad production lint disable.

### Verification evidence and limits

- Candidate focused checked Deno suites: **97 PASS / 0 FAIL**, including rewritten event suite 32 plus diary, topic, scheduled and cross-brand suites. Command uses `--no-config --no-npm --no-lock --node-modules-dir=none`; no dependency/network install was needed.
- Existing `_shared` + `x-test-post` runtime tests: **907 PASS / 0 FAIL**, **--no-check** because baseline type debt is independently documented. This is relevant-scope runtime coverage, not all Functions typechecking or live provider acceptance.
- Supplied disposable SQL runner on H1-owned PostgreSQL **17.11**: **96 PASS**, clean apply/reapply under non-superuser migration owner, Supabase-style default grants, normal RLS/ACL, lease/idempotency/provider lifecycle, two-session claim race and its ten schema-drift cases. Those passes do not cover the additional owner/inheritance holes above.
- H1 actual-SQL/dispatcher/wrapper harness: **16 assertions: 6 control PASS / 10 required safety failures**. All failures are behavioral safety assertions after setup/cleanup correction, not missing permissions/test-fixture errors. Clean privileges independently include all 8 PG17 table privileges for anon/authenticated/service_role, including MAINTAIN.
- H1 actual workflow validator harness: **3 assertions: 2 controls PASS / 1 required failure**. Canonical eight entries pass; missing/date-invalid/repeated entries reject before generation; duplicate labels silently pass. Node workflow regression suites separately **49 PASS**.
- Advisory-lock-only mutation detected by candidate SQL runner; UNIQUE-only mutation detected by H1 independent direct insert. Mutation SQL lived outside the Git tree in H1-owned temporary files, not modified candidate migration.
- Three changed runtime helpers `deno check` PASS. Full x-test-post entrypoint has **six errors on both candidate and exact merge-base**: Uint8Array/BufferSource/Blob/BodyInit compatibility, missing morning retry_count, timestamp_precision unknown. Runtime lint has the **same four baseline diagnostics**. Changed test-file lint result is the separate net-new finding above; no blanket check/lint PASS.
- `git diff --check` PASS. Focused real-key/private-key-shape scan found no matches; credentials in harness are explicitly fake and fake X/model/Vault callbacks never call production. Internal-ID check of all eight canonical event IDs and snapshot passed. No production text/PII/token/secrets read.
- Gate E source and SQL agree: settle missing claim raises NOT_FOUND instead of reporting success; mismatch IDs reject; published exact repeat is IDEMPOTENT. TS RPC errors propagate into safe retained claims. Unknown successful settlement strings are not runtime-validated, but this alone did not reopen the row in demonstrated paths; strengthen return enums while correcting, without retrying X.
- Actual provider source uses fixed HTTPS X endpoint and manual redirects on the Vault request path; genuine non-2xx status is passed or converted by that wrapper. 403/5xx/network/timeouts/missing-ID remain conservative ambiguous; supplied event tests cover them. No real provider semantics/credentials/refresh requests were exercised. X official manage-post documentation and PostgreSQL explicit-locking documentation consulted; local executed source/SQL is the primary evidence for this verdict.
- Migration BEGIN/COMMIT clean apply and refusal/rollback proven with local psql. Repository workflows/scripts searched did not provide an explicit deployed SQL wrapper; **actual Supabase production apply-wrapper/nested-transaction behavior is not certified**. This remains a separate rollout prerequisite, not permission to execute db push or deploy.
- Other brand behavior: candidate entrypoint change is scoped to AI Lab brand-post topic port; Kabumori reports, OAuth/Vault modules, common account, Cron/scheduler source and PR #81/#76 are not edited. Relevant existing runtime/cross-brand tests pass. This does not attest current production byte identity.
- Fresh comparison now has **two PR-file overlaps**: canonical diary MD and snapshot changed on main with topic-detail-learning content. Initial no-overlap statement is no longer current. Exact candidate review was not silently rebased; correction must freshen and preserve both new main content and the stable IDs. No same timestamp/topic-claim migration found on fresh main; no production migration ledger query made.
- Cleanup: every H1 boundary/runner database was confirmed absent; H1-owned `/private/tmp/kabumori-h1-20261004.ijIgLn/pgdata` server stopped successfully. Local fake role/cluster files retained for reproducible evidence, no production residue. No other session database/server stopped.

### Correction / C1 / rollout recommendation

- C1 should accept **CHANGES REQUIRED**, assign a non-conflicting correction owner/worktree (do not overwrite occupied G3/G4), preserve fresh main diary updates, and return for focused rereview. Recommended corrective model **Opus5.5（高）**; recommended C1/rereview **Sol（高）**.
- First close duplicate-label identity and effective ACL/owner checks, use real-wrapper provider outcome codes, separate unresolved evergreen quarantine from confirmed cooldown and enforce canonical JSON mappings. Add executable adversarial tests, not just in-memory DB reimplementations. Retain durable diary protection and fencing; never repair a failed settle by resending X.
- No large migration/security redesign in H1 and no runtime fix to claim PASS-WITH-FIX. Evidence branch stays unmerged/RED until a corrected candidate explicitly passes the relevant gates.
- Future rollout only after source acceptance and separate production authority: inspect production catalog/owner/default ACL and old superseded-table presence read-only; certify exact SQL apply-wrapper/transaction behavior; apply only approved migration; verify catalog/ACL/function definitions; deploy only approved exact source; use authorized natural-cycle observation without manual X/backlog/candidate injection/Cron/token/gate changes. Cross-system exactly-once is not promised.
- safety_checks: other workstreams, synced sources, ACTIVE_TASK/CURRENT_STATE/H2 and shared user changes preserved; all tests disposable/fake; no external production mutation. Supabase/Postgres skills guided stricter drift, effective-privilege and crash-boundary checks; did not expand authority.
- next_recommendation: **C1, 推薦モデル：Sol（高）**. H1 TASK -> `review_required`, `next_owner: chatgpt`; STOP after exact H1 control-file sync/read-back. C1 owns shared index alignment.

---

# H1 — PR #82 final boundary rereview (2026-10-05)

- task_id: `ai-lab-pr82-final-boundary-rereview-20261005`
- result: **PASS-WITH-FIX**, only for the corrected source/evidence head below. Unchanged original PR head still has the two bounded findings; do not treat it as an unconditional PASS.
- status: `review_required`; next_owner: `chatgpt`; recommended_model: **Sol（高）**.
- reviewed exact PR head: `51457826ea6c29d9c94ac0066786df8927fa1274`; previous rejected head: `9f3b19a3cde490cf63735220ae191dcd4f11bdcb`.
- source commits: `cf6bf2cf1113ac1bc083609a86ca97668484e013` (two corrections + independent tests), `9d30a68317dd523a96e6ce96bf7a0f6de23235d5` (align the independent fixture's synchronous resolver contract).
- source push/read-back: final `9d30a68317dd523a96e6ce96bf7a0f6de23235d5` on `codex/h1-pr82-final-20261005`; PR #82 original branch was deliberately preserved. C1 must adopt these changes before accepting source.
- fresh main before control synchronization: `1c633e846c8d3ae49ca95aa13b6063f26f85e052` (24 commits ahead of PR base `12af08b80e6e1cef1246ff115cd157b97885e780`); overlap with the original 14 PR files: **0**. Main changed only control/project instructions in that interval. No same migration timestamp found on main; G4/PR76 `20261003090000`, G3/PR81 `20261003120000`, PR82 `20261004090000` are distinct. No production migration ledger was read.
- PR #82 read-back: OPEN, unmerged, mergeable=true, exact head unchanged, 14 files. No merge or check bypass.

## Findings and bounded corrections

1. **P3, fixed — new checked-test type error.** `realVaultAuth` returned `Promise.reject` from the synchronous `XOAuthClientResolver`, causing a new TS2739 diagnostic. It now throws synchronously. The analogous independent fixture also follows that contract. Runtime/OAuth behavior is unchanged.
2. **P2, fixed — incomplete index drift proof.** Comparing `pg_get_indexdef` alone admitted a same-DDL partial UNIQUE index whose catalog marked it invalid/not ready. A disposable PostgreSQL catalog probe reproduced acceptance on the original candidate. The shape guard now compares `indisvalid`, `indisready`, and `indislive`; the same probe rejects with SCHEMA_DRIFT. PostgreSQL documents that invalid indexes do not guarantee uniqueness and not-ready indexes are ignored by inserts/updates: [PG17 index catalog](https://www.postgresql.org/docs/17/catalog-pg-index.html). This is a migration-source guard correction, not a production schema change.

No remaining demonstrated P1/P2 finding in the corrected review scope. These fixes do not redesign the claim/provider protocol or expand production authority.

## Gates A–C: identity, provider proof, dispatcher

- Actual parser/sanitizer/candidate builder and extracted actual workflow validator reject missing/invalid/repeated event IDs and duplicate scalar labels before generation. The previous duplicate-label RED case now produces zero diary candidate and fails CI; no last-wins identity rewrite. Reordering/body/angle edits preserve an existing valid ID. All eight canonical public IDs were inspected for unsafe/internal identifiers; fresh-main topic-detail-learning prose is preserved, with intentional stable-ID metadata only. Canonical Markdown and generated snapshot match exact deterministic generator bytes.
- Actual `VaultAccountXAuth.send` + observed sender were exercised with fake credential, refresh and request callbacks, not a copied auth implementation. Authentic 400/401/422/429 yield typed no-post evidence. Refresh-disabled 401 retains the transformed X_ACCESS_TOKEN_UNAUTHORIZED message and releases safely; genuine 401/refresh/401 retains X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH; 401/refresh/success returns success. Mixed uncertainty, 403/408/3xx/5xx, transport/read errors and a local error merely mentioning 401 never become typed no-post. Failed proactive fake refresh is NOT_SENT only because no create-post callback ran.
- Source uses fixed HTTPS `POST /2/tweets` and manual redirects; full response-text read must succeed before a response is observed as a status. Official [X create-post endpoint](https://docs.x.com/x-api/posts/create-post) and [X response contract](https://docs.x.com/x-api/fundamentals/response-codes-and-errors) establish success/error semantics. 422 is interpreted under [RFC9110 unprocessable-content semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.21), not a claim that X advertises a live endpoint-specific 422 guarantee. Safety depends on the actual authenticated response and these contracts, not message text; provider bugs/cross-system exactly-once are not certified by local tests.
- Only `AiLabProviderNoPostError` releases after durable provider start. Generic errors remain ambiguous. Ambiguous-write or settle-write failure leaves provider_started blocked. Confirmed X completion failure never reopens the claim or retries X. Pre-X guards release only their own fenced claim; false/error/lost response from start-provider never reaches X. Real SQL-port/dispatcher integration and previous accepted concurrency/fencing controls pass.

## Gates D–F: quarantine, publish clock, canonical payload

- Real SQL (not an in-memory SQL substitute) blocks unresolved provider_started and ambiguous seeds and overlapping canonical themes after 73h, 7d and longer simulated age. Claimed rows block within lease and expire only pre-X. The previous 73h paused-sender/replacement case stays at **one fake X** with no replacement claim. No lease/age recovery of possible writes.
- Published seed/theme cooldown uses server-owned `published_at`, not `claimed_at`: 72h seed and 48h theme, including +/- one-minute edge probes. Earlier claims cannot shorten the clock; released/expired claims do not consume confirmed cooldown. Correctly aged published rows may re-enter if no unresolved blocker remains.
- RPC validates the entire bounded candidate array before expiring/inserting claims: exact four-key set/types, duplicate event keys, canonical seven evergreen seeds, unit equality, exact canonical theme arrays, diary syntax/unit relationship and empty diary themes. Extra/missing/wrong fields and malformed later candidates reject atomically with no earlier insertion. Executable SQL/TypeScript canonical-tag parity passes; caller-provided tags cannot bypass cooldown. No post body is stored.

## Gates G–H: effective privileges and migration drift

- Actual migration owner is a non-superuser/non-API local owner. Clean install/reapply succeeds; table and all five narrow functions retain that owner. Direct API table rights including PG17 MAINTAIN are false, column ACL absent; only service_role has narrow function EXECUTE. API/authenticator migration owners are refused.
- Direct service_role/authenticated and nested service-role-to-owner membership were built locally. Effective TRUNCATE became true, `pg_has_role(api, owner, 'MEMBER')` was true, and reapply refused without changing the role graph. The reverse owner-to-API membership used by the clean fixture does not spuriously fail. This verifies the correct argument direction/transitivity in [PostgreSQL role information](https://www.postgresql.org/docs/17/functions-info.html).
- API table/function owner drift (each named API role for function ownership), unexpected EXECUTE/table grantees, overloads, wrong PK/partial UNIQUE/index/check, RLS/policy/trigger and column-ACL drift are refused. Unknown-grant failures roll back rather than partially repairing the catalog. The additional invalid/not-ready index probe passes only after the H1 guard correction.
- Two-session actual SQL race permits one active diary claim. Removing only the advisory lock from an outside-Git mutation copy is detected by the runner; removing only the diary UNIQUE is detected by the independent direct-insert control. Neither weakened copy was committed. This rereview did **not** independently rerun all claimed 15 SQL + 15 TS mutation variants.

## Gate I / executed verification

- Focused checked Deno suites (event, diary, topic, scheduled dispatcher, cross-brand): **104 PASS / 0 FAIL** after the bounded fixes.
- Full relevant `_shared` + `x-test-post` runtime scope, with `--no-check`: **914 PASS / 0 FAIL**. No network permission granted.
- Supplied disposable SQL runner, local PostgreSQL 17.11: **132 PASS**, including clean/reapply, two-session race, lease/fencing, canonical payload, age/publish-clock, ACL and drift. Re-run after the index-guard fix.
- H1 independent real-SQL/dispatcher tests 20 + actual-workflow tests 3 + actual-Vault/provider matrix 18: **41 PASS / 0 FAIL** at final source head. Fake X/model/credential/refresh ports only.
- Actual workflow's Node regression suites: **49 PASS / 0 FAIL**; deterministic generated snapshot parity PASS. Counts overlap with Deno suites and must not be summed as unique coverage.
- Four changed runtime helpers: `deno check` PASS. Nine changed TypeScript helper/snapshot/test files: `deno lint` PASS; no broad disable introduced.
- Full entrypoint check is **not clean**: the same **six known errors** occur on candidate and fresh-main source (Uint8Array/BufferSource/Blob/BodyInit, missing morning retry_count, timestamp_precision unknown). Full entrypoint lint has the same **three known diagnostics** (unused xWeightedLength/decryptToken, prefer-const). Diagnostic text matches exactly after path/line normalization. Main advanced only control files after the baseline checkout, leaving this source baseline unchanged.
- `git diff --check` PASS; targeted secret/private-key/JWT-shape scan found no real-key matches; canonical event IDs contain no production UUID/token. Test credentials are explicit fixtures. Candidate claim of 2543 entire-Functions tests is not presented as independently run here.

## Changed files / isolation / safety

- `supabase/functions/_shared/brand/ai_lab_event_dedupe_test.ts`
- `supabase/migrations/20261004090000_ai_lab_topic_claims.sql`
- `supabase/tests/h1_pr82_claim_boundary_test.mjs`
- `supabase/tests/h1_pr82_provider_matrix_test.mjs`
- `supabase/tests/h1_pr82_workflow_boundary_test.mjs`
- H1 control only: `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md`.

- New-Mac rules followed: new isolated H1 source/base/report worktrees from `/Users/yuya/Developer/kabumori-fresh`; its primary checkout and all old/shared worktrees were preserved. Existing H1 report history is append-only; G1–G5/H2/ACTIVE_TASK/CURRENT_STATE were not edited. C1 owns shared-index alignment.
- Relevant content-diversity, fingerprint/cross-brand dedupe, attempt-budget, completion and other-brand regressions pass. Source change remains AI Lab-only; no new model call, common-account behavior, Kabumori/Mio/OAuth/Vault implementation, scheduler/Cron or other-workstream mutation.
- Production Supabase reads/writes, migration apply, deploy, real X/media/refresh/OAuth/Vault/token/Cron operations: **0**. No production credentials loaded. This review is not current production byte/catalog certification.
- Local test databases confirmed absent and H1-owned local cluster stopped; local fake evidence files retained for reproducibility. A final local restart initially omitted its socket options and caused connection-only harness failure; it was stopped, restarted with the original local-only socket configuration, and all 41 tests passed again. No other session's database/server was stopped and no production data was created.
- Supabase/Postgres skills guided effective-privilege, crash-boundary and index-state drift checks; they did not expand mutation authority.

## C1 / merge / rollout recommendation

- **C1, 推薦モデル：Sol（高）**: accept PASS-WITH-FIX only after adopting the two bounded corrections from final evidence head `9d30a68317dd523a96e6ce96bf7a0f6de23235d5` into PR #82 (normal owned workflow; no force push), verifying its updated exact head and required repository checks. Do not merge the uncorrected `51457826` as an unconditional PASS.
- No demonstrated residual source blocker after fixes. Production rollout remains separately gated: read-only owner/default ACL/membership/catalog and migration-ledger compatibility; certify the actual approved apply wrapper/BEGIN-COMMIT behavior; apply only the approved migration and read back ACL/definitions; then deploy separately approved exact Function source. Production apply-wrapper/nested-transaction behavior has not been certified here.
- No authorization for production apply/deploy, manual X, backlog/candidate injection, token/gate/Cron changes is inferred. Natural-cycle observation requires its own authorization. No exactly-once guarantee is claimed across PostgreSQL and X.
- H1 is stopped at `review_required` / `next_owner: chatgpt`; do not restart until C1 assigns the next step. Control-file synchronization is a separate control-only main commit; source remains the read-back evidence branch, not merged.

---

# H1 — PR #82 production read-only preflight (2026-10-05)

- task_id: `ai-lab-pr82-production-readonly-preflight-20261005`
- verdict: **PREFLIGHT COMPLETE / PRODUCTION ROLLOUT HOLD**. Current target catalog and owner prerequisites pass. A safe, exact single-file production apply mechanism and its history-failure policy still require a C1 decision; catalog PASS is not deployment authority.
- status: `review_required`; next_owner: `chatgpt`; recommended C1: **Sol（高）**, future high-risk mutation gate: **Sol（極高）**.
- fresh main at start: `3b3708eab5fc97190096ab66543bdc5fb1c48434`; refreshed pre-report base: `ed9404b91d96226b941d66540d5520bd17364b47`. Latest G1 control updates were fast-forwarded without changing that slot.
- accepted PR82 source `9d30a68317dd523a96e6ce96bf7a0f6de23235d5` is squash-merged at `80e11c9207d44599db26a25195f1ee0091484231`, verified ancestor of fresh main. Accepted Functions/target migration bytes match the merge. Later main news-discovery changes are outside the x-test-post import closure. No accepted source was corrected or rewritten.
- exact migration: `supabase/migrations/20261004090000_ai_lab_topic_claims.sql`; SHA256 `30d8504173160f1dc9c3d7d1cf323d9890129d1ff117c2448aa1b2516629c09c`.
- production project: `wsmznyzcvmuitkglfeuj`; read session/current role `postgres`; PostgreSQL **17.6**. No application credential/Vault plaintext loaded.

## A — actual production ledger / collisions

- Ledger has **72 rows**; no version `20261004090000` or name `ai_lab_topic_claims`. Superseded `20261003090000` / `ai_lab_topic_event_usage` also absent. PR76 version/name and PR81 version/name are absent too; no target collision found. Never repair a superseded/colliding entry if a later pre-apply check finds one: STOP.
- Fresh main has **103 migration files**. Only **45** production rows match both repository version and name; **11** additional rows have matching names under other versions; **16** are unmatched by that filename/name comparison. **58** source files lack an exact version+name ledger match. This is a metadata comparison, NOT proof that 58 schemas are unapplied or that unmatched effects are absent.
- Historical server-assigned timestamps and renamed/missing source history make the global chain unsuitable for an unreviewed bulk push. No reconciliation, include-all, migration repair, db pull/push, or unrelated schema inspection/repair was attempted. Existing history must be preserved.

## B — actual production catalog / owner / ACL preconditions

- Catalog query across schemas found **zero** `ai_lab_topic_*` relations/indexes and **zero** target/topic-named functions, including all five RPC names and possible overloads. Claim table and superseded table both absent; topic-named types/policies/user triggers absent. Therefore target owner/RLS/constraints/index state/function security/search_path/effective table/column/EXECUTE ACL are **not yet applicable**, not falsely reported as installed-and-safe.
- Intended apply owner `postgres`: non-superuser, BYPASSRLS, public schema USAGE/CREATE and database TEMP available; built-in `pg_catalog.gen_random_uuid()` exists. No API role (anon/authenticated/service_role) or authenticator is a MEMBER of postgres, directly or transitively. Reverse postgres-to-API membership is true and expected; it is not owner authority flowing to the APIs.
- Relevant postgres/public default ACL: table owner has `arwdDxtm`; anon/authenticated/service_role have `Dxtm` (including PG17 MAINTAIN); function schema default names postgres EXECUTE. The migration's exact REVOKE ALL, PUBLIC/function revokes and effective ACL postconditions address these defaults without globally rewriting them. No unexpected default grantee was found in that scope.
- Migration ledger owner is postgres; INSERT is permitted. Columns are version/statements/name/created_by/idempotency_key/rollback, with PK(version), UNIQUE(idempotency_key), zero user triggers. Present metadata shows no artificial failing constraint; it cannot rule out transport/commit uncertainty.
- PostgREST DDL/drop watch event triggers exist and are enabled. API schema-cache/readiness still requires post-apply verification; trigger presence alone is not an RPC smoke result.

## C — exact tooling / transaction proof and STOP boundaries

Used the installed **Supabase CLI 2.116.0** with a byte-identical copy of ONLY the merged migration in an H1-owned scratch directory, no linked project and an explicit H1 Unix-socket local DB URL. Local PostgreSQL 17.11, non-superuser owner named postgres, production-shaped API memberships/default grants. No production migration tool was invoked.

| Local proof | Target relation/functions | Target history row | Result |
|---|---|---|---|
| exact clean CLI apply | present / 5 | 1 | PASS |
| exact SQL reapply + CLI no-op | present / 5 | still 1 | PASS |
| unexpected default grantee causes final ACL failure before COMMIT | absent / 0 | 0 | complete target rollback |
| injected history CHECK refusal after the migration's COMMIT | present / 5 | 0 | demonstrated schema/history gap |
| one-file CLI directory + prior ledger version absent locally | not applied | prior row unchanged | rejects before apply |

- Exact SQL owns its BEGIN/COMMIT. All target DDL and ACL validation are atomic up to its authored COMMIT. Failure before that point leaves no target partial DDL/ACL. Temporary helper functions live only in pg_temp; clean read-back shows postgres owner, RLS true, zero policies/column ACL, zero invalid/not-ready/dead indexes, zero public helper copies.
- **Schema + migration-history are NOT one atomic commit through this CLI for this authored-transaction file.** The CLI executes authored controls sequentially, then inserts history only after every file statement succeeds; cleanup ROLLBACK cannot undo an already executed COMMIT. This is independently demonstrated, not inferred from generic per-file claims. Pinned [CLI apply implementation](https://github.com/supabase/cli/blob/v2.116.0/apps/cli/src/legacy/shared/legacy-migration-apply.ts) corroborates the order.
- **An isolated one-file `migration up` is not immediately production-compatible** with existing remote versions missing from that scratch directory. The local prior-history probe raises LegacyMigrationMissingLocalError without applying the target. [Pinned migration-up selector](https://github.com/supabase/cli/blob/v2.116.0/apps/cli/src/legacy/commands/migration/up/up.handler.ts) also verifies remote/local alignment and can upsert configured Vault secrets before applying files: a future runner must exclude Vault configuration, not use a shared full-project config opportunistically.
- Do not solve either boundary with --include-all, fake history stubs, repair/revert, broad db push, an outer `psql -1` around an inner COMMIT, or editing this accepted migration in place.
- The Supabase Management [apply-migration API](https://supabase.com/docs/reference/api/v1-apply-a-migration) exposes query/name and no client-specified version. Its server transaction/history wrapper for authored BEGIN/COMMIT is **not independently certified here**; previous tasks document generated history versions. Do not substitute that API and claim equivalent atomicity without reviewing the chosen path/version policy.
- C1 must choose a separately reviewed single-file runner/history policy. Options require explicit scope: accept a documented schema-first/history-second checkpoint and mandatory read-back on any failure, or prove a specifically approved atomic body+ledger wrapper without changing unrelated code/history. No production wrapper/source candidate was created in this read-only task.
- Failure/timeout safe stop: do not deploy; read catalog AND ledger. Neither target nor history => remain unapplied; fully safe target but missing history => STOP for narrowly authorized bookkeeping decision; history present but target wrong/missing => STOP; any unsafe/incompatible target => STOP. Never automatically drop/down-migrate, reopen claims, blindly rerun X, or relabel history. A missing response may mean commit happened.

## D–E — exact deploy target / current live baseline

- Static import-graph walk over all Function entrypoints finds the changed topic store/diary/snapshot/dispatcher/provider modules in **`x-test-post` only**. This is the only required Function deploy target. No migration dependency requires a scheduler/Cron/OAuth/other-Function change.
- Live read-back baseline: x-test-post **ACTIVE v133**, **verify_jwt=false**, package digest `bb2ae611653674269c63405ee57c778f892519c08c6e41718f6a965b9809716b`. The deployed topic store/diary/snapshot/dispatcher/entrypoint differ from accepted merged bytes; provider observer is absent. VaultAccountXAuth source is byte-equal to merged source. Production does not already contain the PR82 claim mechanism.
- Cron `dispatch-scheduled-posts` is active at `* * * * *`, invokes x-test-post. Only job metadata/boolean target tests read, never raw command/headers/body or secrets. No scheduling/frequency/authorization change is required by this PR.
- AI Lab brand active=true, publish_mode=live; its one X account publish_enabled=true; enabled_post_types=[brand_post]. Ten existing active JST windows were read (07:30–08:30 through 22:00–23:00); no setting changed. These are live gates, not a paused test environment.
- Final queue metadata snapshot **2026-10-05 14:05:30 JST**: running=0, overdue pending=0, future pending=5, next scheduled **16:11:08 JST**. Earlier aggregate queried an irrelevant `publishing` label; it was not used as safety proof. Source and final query use the actual `running`/`succeeded` status contract. Snapshot is point-in-time, not a future drain guarantee.
- Rollout order: accepted exact migration only -> ledger/catalog/ACL/definitions/API cache read-back -> separately approved exact x-test-post deploy, preserving verify_jwt=false -> downloaded source-byte/import-closure + version/status read-back -> permitted non-posting readiness checks -> separately authorized natural-cycle observation.
- Deploy-first is **AI-Lab send fail-closed** when claim RPC is missing: claim failure occurs before generation/start-provider/X. It can still claim/fail a schedule and load existing Vault credentials before that boundary, so it is not a read-only/no-side-effect smoke and is not an acceptable intentional ordering shortcut. Other brands do not use the topic RPC.
- Migration-first leaves old consumers publishing under old logic until cutover. Zero running at one instant does not prove old warm workers drained. Recheck no in-flight/overdue work immediately before any separately approved cutover, allow old invocations to finish without force retry, and verify new source afterward. If a safe cutover cannot be established without changing gates/Cron, STOP and request that additional authority; do not infer it.
- **Cold ledger limitation:** clean creation has no historical event claims. There is no historical post-to-event backfill in the approved SQL. Therefore already-posted diary topics from the old system may be selected again if still fresh; this task did not read old post text to guess mappings. C1 must accept forward-only dedupe at the cutover or separately scope a verified historical transition. No backfill/seed/injection was done, and no retrospective no-repeat guarantee is claimed.

## Pre/post read-back checklist (future authority required)

1. Freeze exact source SHA/hash and apply mechanism. Re-read project identity, current/session role, target/superseded version+name and object absence, default ACL/memberships, current Function digest, live gates/Cron and running/due queue counts. Any drift/collision => STOP.
2. Apply ONLY the approved target using that reviewed mechanism. On error/lost response use the catalog+ledger checkpoint above; no automatic repair or deploy.
3. Require target history version/name policy satisfied; table/index/constraint shape, valid+ready+live indexes, RLS/no unexpected policies/triggers, no column/API table rights including MAINTAIN, owner postgres, exactly five signatures, SECURITY DEFINER + empty search_path, only intended service EXECUTE, no public/private persistent helpers. Inspect definitions/digests, not mere function-name existence.
4. Confirm API schema-cache exposure/readiness without mutating production claims. Catalog checks and download/source comparison are safe. GET method-guard (expected 405) can confirm reachability without scheduler/credential/model/X behavior if explicitly included in smoke authority; it does not prove RPC behavior. Do not send POST/default/unknown/dry-run modes: existing dry runs can generate/write, and unknown POST can enter normal dispatch. Actual functional SQL/dispatcher probes remain disposable/fake, not production test rows.
5. Deploy only accepted exact x-test-post, verify_jwt=false unchanged; compare downloaded normalized-path files' UTF-8 bytes across the entire expected module graph, expected entrypoint/imports, new version/status/package digest. Existing digest must change; version alone is insufficient. No arbitrary other-Function redeploy to propagate shared modules.
6. Natural observation only if separately approved: future naturally scheduled AI Lab brand_post, no manual invoke/backlog/seed, no gate/Cron/token change; read minimal claim state/schedule status/outcome metadata, no text/PII/Vault plaintext. Retain provider_started/ambiguous on uncertainty, never reopen/resend to make the test pass. Include cold-ledger and old-worker limits in acceptance criteria.

## Safety / completion

- production reads: necessary migration-ledger metadata, PG catalog/roles/default ACL/ledger shape/PostgREST trigger metadata, one target Function source/metadata, Cron metadata, AI Lab gate/window metadata and aggregate schedule state. No user/post content, tokens, secret values or Vault plaintext read. The Function inventory tool returned all metadata; detailed source retrieval was restricted to x-test-post.
- production mutations **0**; production apply/deploy/repair/history rewrite/gate/Cron/OAuth/Vault/token/refresh/real X/media/model/manual scheduler operations **0**.
- changed_files: `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md` only. No source commit/merge/deploy. Control report is append-only; prior review history and all G/H2/index files preserved. H1 isolated from kabumori-fresh; old/shared worktrees untouched.
- local proof files retained outside Git at `/private/tmp/kabumori-h1-preflight-20261005.pdBLYW`; all **four** H1 throwaway DBs deleted after inspection and own cluster stopped. Their fake data can be recreated from the local proof script; no production residue. CLI-created own temporary metadata moved outside the worktree, not deleted/staged.
- `git diff --check`: PASS before control sync. No runtime/type-test rerun is claimed for this source-unchanged task; previous accepted 104/914/132/41/49 proof remains separate history. This turn's exact clean/reapply/rollback/history/selection experiments are the apply-path evidence.
- Supabase/Postgres skills guided least-privilege/default-ACL review and exact failure-boundary probes. Current changelog was checked (markdown fetch unsupported, HTML fallback); no unrelated upgrade/schema fix was performed.
- next_recommendation: **C1（Sol・高）** accepts the read-only findings, resolves the apply-path/history and cold-ledger/cutover decisions, and only then requests narrowly specified production mutation authority (**Sol・極高**). H1 stops at review_required; shared-index alignment belongs to C1.

---

# H1 — Common-account hosted Gate B final review (2026-10-05)

- task_id: `common-account-gateb-managed-auth-final-review-20261005`
- verdict: **PASS-WITH-CONDITIONS — Phase 1 foundation installation only**. No new blocking source defect found within the additive/shadow contract. Recorded hosted evidence is sufficient to advance to C1 and a separately authorized, fresh-preflighted single-migration mutation gate. This is NOT permission to apply now, backfill, activate deletion, enforce, or deploy.
- source reviewed: accepted fix `aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65`, merge `44121914b035e22380a4ca1bd8252a42713a2bbf`; review worktree main `86a15390ec17ca38a543a3ebf7ffca79d3e67292`. Merge ancestry verified. Migration, lifecycle docs/fixture/behavior/runner/mutations/rollback bytes remain equal to the accepted source. The shared migration-invariants test has one unrelated reserved-version addition, independently inspected and tested.
- exact target: `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql`; SHA256 `e632214b5602c12ee73d9a7475af36791138099a1a7fdba7e8fb521afc01cde3`.
- source implementation/fix/merge/deploy: **none**. Only H1 TASK/REPORT control synchronization. Dedicated new worktree `/private/tmp/kabumori-h1-gateb-20261005.tEjJuC/repo`; base checkout, previous worktrees, other slots and synced project references untouched.

## Evidence provenance / what was and was not independently repeated

Read the current TASK/CURRENT_STATE recorded hosted evidence, prior common-account H1 source/corrective/readiness reports and H2 preproduction report, complete accepted migration/design/rollback and relevant proof runner. The TASK explicitly records the user's fail-fast `GATE_B_PHASE_A_PASS`, `GATE_B_PHASE_B_PASS`, ChatGPT's direct-row refusal and post-delete DB observations. Those are **recorded operator/ChatGPT hosted evidence**, not scripts re-executed by H1. Raw hosted scripts/request transcripts or a hosted definition-byte dump are not included in the repository artifacts inspected; this review does not independently attest their exact assertion coverage beyond the recorded contract. C1 must retain that provenance, not relabel it as an H1 fresh hosted E2E. No destructive replay was needed/authorized.

The hosted proof covers a minimal production-shaped fixture, not every current production dependency. H2's previous 20 lifecycle PASS / 46 mutations detected / 8 deletion PASS already independently exercised the identical accepted local source, including rollback/reapply and race cases. Those are prior evidence, not this turn's fresh counts. Actual hosted application and managed actors address different unknowns than the local fixture does.

## Final gates — disposition

| Gate | Disposition and limit |
|---|---|
| 1. Previous Gate B unknowns | **PASS for installation scope using recorded evidence**: exact hosted apply, real own/cross-user RLS, denied writes/anon/service table access, service RPC, Storage blocker/API cleanup and real Auth Admin cascade address the principal missing managed boundaries. Not a production parity or complete deletion-orchestrator proof. |
| 2. Stale access JWT | **Foundation PASS; destructive orchestration HOLD**. Source never revokes/deletes managed sessions/login, requires session_revocation attestation, and disallows whole-account completed. Existing issued JWT remains a risk outside this foundation. Neither a checkpoint nor Auth deletion nor global sign-out proves immediate JWT invalidation. |
| 3. Observer truthfulness | **PASS**. Shadow only; no blocker reconstruction/authorization after cascades. Direct common-row deletion with live Auth parent refuses 23503; actual Auth cascade records unverified login_removed and clears raw subject linkage, never verified account completion. |
| 4. RLS/grants/Data API | **PASS in recorded hosted fixture; production read-back required**. All five tables RLS; public two only authenticated own-row column SELECT; no client writes or authorization by editable metadata. API acceptance alone is not cross-user data disclosure. |
| 5. Service role boundary | **PASS**. BYPASSRLS does not create SQL table privileges. Direct tables revoked; 10 public backend RPCs service-only, two no-argument client start RPCs authenticated-only/auth.uid-bound, 21 private functions owner-only after PUBLIC revoke. Server must derive p_user_id from verified caller; that future Edge obligation is not implemented here. |
| 6. Storage | **PASS for refusal/cleanup observation**, not race-free permanent emptiness. owner_id/deprecated owner probe blocks even with attested cleanup; unknown/unreadable shape refuses. Recorded object cleanup used Storage API, not SQL. Still-valid JWT can create new ownership later; future writer gate/re-enumeration remains mandatory. |
| 7. Managed Auth/cascade | **PASS using recorded read-back**: users/identities/sessions/refresh/common/entitlements absent; one durable login_removed operation preserves ready-step evidence. Non-FK operation survives; login_removed is not completion. Auth /user and refresh rejection do not prove old access JWT rejected by every other API. |
| 8. Hosted rollback/reapply/error mapping | **DEFER with conditions**, not falsely PASS. Local identical-source atomic refusal/affirmative rollback/reapply is prior evidence; real hosted clean apply and guard/cascade worked. No automatic rollback/reapply is needed for foundation-only install. Exact managed rollback/other RPC HTTP-error mappings may be deferred until separately approved rollback/destructive integration; no reliance on an untested mapping or automatic retry now. |
| 9. Production rollout | **Conditional next gate**, checklist below. Mandatory fresh target/dependency/owner/effective ACL/API/apply-history checks plus exact-file approval. This review's small catalog read is not the full rollout preflight. |
| 10. Backfill | **HOLD / separate approval** after installed-schema read-back, fresh dry-run/parity and operator review of uncertain population. Migration does not run backfill. |

## Stale-JWT security implication — mandatory correction to future acceptance criteria

Deleting Auth removes refresh capability but does not retroactively invalidate issued JWTs. **Revoking sessions/signing out before hard delete is necessary but alone is NOT sufficient** to prevent the stale access token from calling Data API/Storage before exp. Official [user-management guidance](https://supabase.com/docs/guides/auth/managing-user-data) and [sign-out guidance](https://supabase.com/docs/guides/auth/signout) explicitly preserve that distinction. [Session guidance](https://supabase.com/docs/guides/auth/sessions) describes live session_id validation for sensitive operations.

The hosted `old access JWT Data API: ALLOWED` means the gateway accepted that JWT; without response/endpoint assertions it does **not** establish that removed common rows or another user's data were readable. Common/entitlement rows cascade away, and the new client start helper requires a live locked Auth parent before recreating application state. However Storage has no ownership Auth FK and legacy writers are not lifecycle-gated, so the whole system is not protected by the foundation.

Before any future destructive orchestrator can attest session_revocation as operational safety: authenticate/re-authenticate server-side; stop new sign-in/refresh/writer paths for the deleting subject; revoke all applicable sessions/refresh capability; **also** deny old-JWT sensitive writers with current session/lifecycle authority at every relevant API/Storage path, or independently prove an explicit bounded-expiry plus writer/in-flight quiescence strategy; re-enumerate Storage through its API; refresh readiness immediately before managed deletion; then verify managed deletion/cleanup and audit. Ban alone, token signature checks, successful signOut, deleted auth.sessions, or a DB checkpoint are not that proof. No such gate or token change was implemented here.

Prepare's locks end when its request commits. Admin/membership/identity/Storage producers remain evaluation-only and are not serialized through the later separate Auth API call. Ready is bound lifecycle/requirement evidence, not an atomic external deletion permit. Future enrollment, producer/deleter integration and stale-token policy require their own design/review/hosted proof before enforcement. Existing Kabumori/X legacy deletion routes remain unchanged/unsafe.

## Minimal fresh read-only observations

- Production `wsmznyzcvmuitkglfeuj`: one SELECT of catalog/history/role/default-ACL metadata only; session role postgres, PG17.6. Target version/name history count **0**; exact public target/private lifecycle relations **0**; new RPC/private-function names/overloads **0**. No installation assumed.
- API roles anon/authenticated/service_role and authenticator are not members of postgres. service_role/anon are not members of authenticated; authenticator membership in authenticated is the normal role-switch machinery, not an end-user grant. Inspected postgres global/public/private defaults show only known owner/API grantees; public table Dxtm defaults are explicitly revoked by this migration. No default privilege rewrite or effective installed-ACL claim made.
- Full fresh source-derived 17-table/26-column/14-FK/helper and owner privilege/API configuration checks were **not repeated** by this limited review. H2's 2026-10-02 snapshot cannot certify today's entire schema. Require them immediately before the separately approved apply, including any later production changes from other slots.
- Disposable `wrmtvdgsxwmlzekvbmsa`: get-project metadata confirms **INACTIVE**. No DB/Auth/Storage query, resume, pause or restore attempted. Photo project untouched.
- No PII, tokens, Vault plaintext, user/post content or Auth session contents read; no functional production RPC invoked.

## Exact rollout / STOP checklist — future separate authority

1. C1 accepts the recorded evidence and this narrowed verdict; freeze the exact SQL hash above. Confirm fresh main ancestry and byte parity, production project identity, independent operator checkout and other active migration work. No source changes or borrowed/shared slot state.
2. Fresh read-only production preflight: exact target version/name and every created table/view/index/function/signature/trigger collision absent; expected owner and role memberships; global/schema defaults and effective existing dependency grants; source-derived 17 tables / 26 column types / 14 exact validated non-deferrable FK actions, profiles children CASCADE, two exact helper signatures/definitions/owner; managed Auth/Storage shapes; public/private API exposure configuration. Unexpected owner/grantee/overload/helper/drift => STOP, do not fix it in the apply.
3. Obtain approval for **only this exact migration plus explicitly specified history bookkeeping**. Choose and certify the actual single-file runner/owner/transaction/history policy before execution. No ordinary db push, include-all, history repair/relabel or unrelated migration. Hosted apply success does not itself prove schema+history atomicity for the future path. SQL owns BEGIN/COMMIT; any separate CLI history insertion is outside that COMMIT (previous H1 tooling proof). Do not wrap authored COMMIT in an outer transaction and call it atomic or assume Management API's generated version equals the filename.
4. Apply only the authorized bytes, with stop-on-error. Lost response/history failure => read catalog AND history before further action. Absent both => not applied; schema present/history absent => STOP for narrow bookkeeping authority; history present/schema wrong/partial/unsafe => STOP. **No blind reapply**: source intentionally refuses already-present target tables. No automatic rollback/drop/repair, and no deploy/backfill following an uncertain result.
5. Read back five tables + private view, exact columns/defaults/PK/FK/CHECKs, valid/ready/live indexes, ten expected triggers enabled, owners, all 33 function signatures/definitions/SECURITY DEFINER/empty search_path, no unexpected overloads. Effective role/table/column/EXECUTE rights (including MAINTAIN and inherited/default privileges): authenticated only intended columns and two own-row SELECT policies; anon/PUBLIC no entry; service only ten public backend RPCs; no API helper/view access. Require unchanged existing dependency definitions/grants. Wrong privilege/owner => STOP, no ad-hoc GRANT repair.
6. Require exactly one shadow/not_started/epoch1 settings row, exactly three fixed built-in checkpoint meanings (session/storage always, Apple conditional), empty common_accounts/entitlements/operations, expected explicit history version/name policy. Verify API schema-cache/exposure without production test users/deletion/readiness mutations. If actual API denial/error mapping must be probed with a login, obtain separate bounded authority; do not borrow credentials or introduce fixture rows.
7. After read-back PASS, run only installed private backfill(false) aggregate dry-run if included in read authority; compare with fresh legacy population, not frozen historical 5/2/1 counts. Profile-only/Auth-only/admin/internal/shared/unknown records require operator review. **Stop for separate backfill(true) approval**. No client registration/deletion/enforcing activation or runtime deploy follows automatically.
8. Recovery rollback is a distinct approved mutation, not a routine error handler. Affirm single shadow/not_started settings, exact built-in registry/no extensions, zero operations including finished, all accounts active, no self-service entitlements, no tracked or operator-confirmed dynamic/client dependencies; every DROP without CASCADE in one transaction. Missing state/use/dependency => STOP. Hosted rollback and exact error mapping must be proven before relying on that path; no project restart or destructive replay from this H1.

## Tests / safety / handoff

- This turn executed source invariants **10 passed / 0 failed**, lifecycle/mutation runner `bash -n` PASS, accepted-source byte/hash/ancestry comparison PASS, `git diff --check` PASS. Entire SQL/design/rollback responsibility/ACL/observer paths reviewed. No fresh local lifecycle/mutation/deletion DB run, no fresh hosted scripts, no Expo/native typecheck claimed; none were changed.
- production reads: one metadata SELECT; disposable reads: one project status lookup; photo reads: 0. Production/test/photo **mutations = 0**. DB apply/backfill/rollback/deploy/Auth/Storage/Vault/provider/OAuth/token/refresh/Cron/manual real-X operations = **0**. No local proof DB/cluster created and no test data requiring cleanup.
- changed_files: `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md` only. Prior report/task history preserved; CURRENT_STATE/ACTIVE_TASK/other slot controls and source untouched. Commit/push: control-only synchronization, actual SHA/read-back reported in final response; no source commit.
- Supabase/Postgres skills informed explicit grants/effective privilege, managed ownership and stale-token review. Current changelog consulted (Markdown unsupported; HTML fallback); no unrelated version upgrade or schema change inferred.
- remaining: exact future apply/history policy, full fresh production preflight/API parity, optional hosted rollback/other error mappings before reliance, backfill population approval, all future destructive/writer integration and stale-JWT enforcement proof. These are separated from foundation source acceptance, not falsely marked completed.
- next_recommendation: **C1 — Sol（極高）**, accept/resolve conditions and, only if preflight/apply mechanism is pinned, request narrowly specified production migration approval. Backfill/enforcement/destructive orchestration remain HOLD. H1 `review_required` / `next_owner: chatgpt`; STOP after verified GitHub sync.
