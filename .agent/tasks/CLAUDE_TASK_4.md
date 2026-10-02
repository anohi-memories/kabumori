# Claude Task 4 — CURRENT TASK

- task_id: x-social-mobile-publish-toggle-transactional-corrective-20261003
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- priority: highest
- recommended_model: Opus5.5（極高）
- type: corrective implementation / authorization transaction / posting safety / concurrency
- continues_from: x-social-mobile-publish-toggle-v1-20261002
- blocked_pr: 76
- reviewed_bad_head: a59a89e9c585fb6e780e1af2ecc898c830f5524e
- production_mutation_allowed: false

## C1 verdict / why this exists

H1 independently reviewed PR #76 and returned **FAIL / CHANGES REQUIRED**. Do not merge or deploy the current PR head.

The critical findings were reproduced against the real candidate code:

1. **R1 P1 — membership authorization is a stale snapshot**
   - caller can be owner/admin when read, lose/demote membership before the service-role PATCH, and the write still succeeds.
   - applies to ON and OFF.
   - this must be fixed by binding current authorization to the privileged state change atomically; another HTTP membership reread is not sufficient.

2. **R2 P1 — brand active/live TOCTOU can still reach a publishable mixed snapshot**
   - toggle can read active/live, brand can then become disabled, and stale toggle can still write ON.
   - the current posting pipeline reuses cached brand context and does not prove a fresh active/live check immediately before the external X send.
   - therefore the previous claim that downstream runtime guard makes this race harmless is false.

3. **R3 P2 — zero-row/no-match reread can leak foreign-tenant state**
   - after account movement/revocation, a service-role reread can return current_enabled from a brand the caller no longer owns.
   - failure must collapse to the same safe not-found/unauthorized shape.

4. **R4 P2 — initial ON readiness and write predicate differ**
   - e.g. platform_user_id empty/whitespace can pass the write-side predicate after an eligible read.
   - current runtime exact-account authority/credential loader has stricter semantics than PR #76.

5. **R5 P2 — UI ON confirmation is not pinned to the account/context shown**
   - confirmation opened for account A can submit for account B if props change.
   - preview/context transitions can leave the confirm action live.

Current PR #76 exact head remains open/unmerged. No production mutation or real X operation was performed.

## Mandatory startup / isolation

1. Read PROJECT_RULES, CLAUDE.md, ORCHESTRATION, CURRENT_STATE, this TASK.
2. Read the full H1 report for `x-social-mobile-pr76-publish-toggle-review-20261002`.
3. Independent G4 worktree/checkout only.
4. Fresh origin/main and PR #76 branch/head.
5. Preserve the original bad-head evidence. Do not force-push away review history without recording exact old/new heads.
6. H2 is reviewing the separate `social_mobile_content_settings` schema prerequisite for PR #78. Do not touch that migration/table/RLS/function or G3 AI-consult files.
7. Existing uncommitted files/worktrees/dev servers from other slots are off-limits.
8. Read the Supabase skill before DB/RPC work.

## Required architecture outcome

The correction must create a **single authoritative server/database transaction boundary** for changing `social_accounts.publish_enabled`.

Do not try to fix R1/R2 with a sequence of extra client/Edge GETs.

Preferred direction:
- Edge verifies bearer/request shape, then invokes a narrowly scoped DB function/RPC under the caller's authenticated JWT where `auth.uid()` is available.
- the DB function locks/reads the exact account + authoritative brand + current membership in one transaction and performs the state transition only if all conditions are still true.
- if repository conventions prove a safer equivalent design, use it, but the same atomic guarantees must be demonstrated.

Do not grant general direct UPDATE rights on `social_accounts`.
Do not use client-supplied user_id/brand_id as authority.
Do not create a generic admin/service-role mutation surface.

A new migration/RPC is allowed in this corrective task **only for this publish-toggle boundary** and must be reviewed independently before any production apply.

## Atomic authorization requirements

For every ON/OFF state change, inside the same transactional authority boundary:

- identify caller from `auth.uid()` / verified JWT context
- locate exact social account
- derive its authoritative brand_id
- prove a current membership for that exact caller+brand
- role must be owner/admin
- bind expected_current_enabled CAS
- prevent account movement/brand movement/role demotion from succeeding on stale authority
- return no foreign account/brand state after authority loss
- safe not-found/forbidden responses must not become tenant existence/state oracles.

Define lock order deliberately and test deadlock/concurrency behavior. Reuse existing lock order conventions where relevant.

## ON requirements

ON is high-risk and must atomically bind at minimum:

- exact account/platform X
- exact current brand
- current brand active
- current brand publish_mode live
- current owner/admin membership
- current publish_enabled = expected
- connection_status exact usable state
- platform_user_id nonempty after trim
- verified_at present
- required credential references present
- references satisfy any non-plaintext structural constraints already enforced by the exact-account runtime helper (e.g. not equal/shared where source can prove this without exposing secrets)
- no current connection error
- any relevant account deletion/busy lifecycle guard.

Do not claim token validity merely from references; actual credential loader/runtime may still fail safely.

The read-side and mutation-side ON semantics must be the same authoritative transaction, not two divergent predicates.

## OFF requirements

OFF remains fail-safe:
- current owner/admin + exact account + expected state required
- must work even if connection degraded, credential refs missing, brand inactive/disabled
- must not revoke OAuth, delete Vault material, delete posts/history, change Auth/common-account state
- must not promise already in-flight external sends are cancelled unless a separately proven mechanism actually guarantees that.

Update UX wording accordingly.

## Runtime pre-send safety / R2 closure

The actual X publishing path must have a **fresh authoritative permission check close enough to the external X send** to make stale cached brand/account context unable to authorize a new send.

Inspect all actual X send paths for social-mobile/account-scoped publishing, including the scheduler/dispatcher and Vault-backed send adapter.

Required invariant before starting a new external X write:
- current brand still active/live
- current social account still publish_enabled
- current account is still the exact authorized/verified account with valid structural readiness
- deletion/busy/reconnect-invalid state cannot pass.

Prefer one reusable server-side exact-account publish-authority read/RPC rather than ad-hoc duplicated HTTP reads.

Be explicit about in-flight semantics:
- define the point after which a post is considered already in-flight
- do not claim OFF can recall an X request already sent
- ensure a new send cannot begin after OFF/brand disable has become authoritative.

Add adverse interleaving tests that reproduce H1's R2 mixed-snapshot schedule and prove it now fails closed.

Do not broaden into a scheduler redesign unrelated to this permission invariant.

## R3 safe reread/error semantics

Any conflict/no-match/after-write verification path must:
- remain bound to the same caller/account/brand authority
- not service-role reread foreign current_enabled or other state and return it
- collapse moved/revoked/foreign rows to the safe not-found/unauthorized result.

Test account brand transfer/deletion/membership revocation between stages.

## R4 readiness semantic alignment

Align all ON checks with the real runtime exact-account authority contract where applicable:
- trim/nonempty platform_user_id
- exact connection state
- verified_at
- credential ref structure
- last connection error
- any existing refresh/authority state that is required to safely claim the account is eligible.

Do not overclaim what can only be checked when loading credentials.
Document what ON means: "permission enabled and structurally eligible", not "future X send guaranteed".

## R5 client confirmation pinning

Fix the client so an ON confirmation is bound to the exact context the user saw:
- account id
- expected current enabled value
- eligibility/preview context
- auth/workspace context if relevant.

If any of those change before confirm:
- invalidate/close the confirmation
- do not send a request.

At submit, recheck preview/action eligibility.
Add executed regressions for:
- A confirmation then props switch to B
- preview becomes true
- account/current state changes
- cancel
- double tap/in-flight.

Do not spend time on visual redesign.

## Lower-risk hardening from H1

Address when bounded and sensible:
- clarify raw JSON "exact keys" claim; if duplicate raw-key rejection is not implemented, do not claim it
- bound request allocation safely if practical; do not falsely describe char check as a streaming byte cap
- revise OFF copy from 「いつでもONに戻せます」 to conditional wording
- explain OFF does not revoke/delete and cannot recall an already-sent X request
- clean the five `require-await` test lint findings if they are in the amended PR scope.

These are secondary; do not let them distract from R1/R2.

## Migration / RPC safety

If a new migration/RPC is introduced:
- unique timestamped migration file; do not edit unrelated historical migrations
- narrow function signature
- fixed `search_path`
- explicit SECURITY DEFINER/INVOKER reasoning
- least privilege grants
- revoke from anon/public as appropriate
- authenticated caller only if auth.uid semantics are required
- no service_role-only hidden user identity argument
- tenant/role/CAS/state validation inside transaction
- deterministic bounded return shape/error codes
- no secrets/tokens in return/logs
- migration must be locally apply/reapply tested where safe
- no production apply in G4.

Check compatibility with current production schema read-only if possible; do not mutate production.

## Tests

Must include regressions that fail on original PR #76 behavior and pass on corrective candidate:

### Authorization/concurrency
- owner -> membership removed before write: rejected, no mutation
- owner -> demoted viewer/member before write: rejected
- account moves A->B: no state leak/no mutation
- expected state changes concurrently: stale/no mutation
- brand active/live -> disabled before ON: no ON
- adverse mixed snapshot from H1 R2: no external-send authorization
- concurrent ON/OFF races deterministic/fail-safe
- account deletion/busy interaction
- lock ordering / deadlock-safe bounded behavior.

### ON readiness
- blank/whitespace platform_user_id rejected atomically
- null/missing verification fields rejected
- invalid/missing/equal/shared credential references handled consistently with structural runtime authority contract
- reconnect/error state rejected
- valid owner/admin eligible path succeeds.

### OFF
- authorized owner/admin can disable with broken credentials/inactive brand
- no revoke/delete/token/history/Auth side effect
- new sends after authoritative OFF cannot begin
- already in-flight semantics are truthful/tested as far as local harness permits.

### Runtime publish guard
- stale cached brand context cannot authorize a new X send after disable
- stale cached account ON cannot authorize after OFF
- exact account mismatch fails
- no real X API call in tests.

### Client
- confirmation pinned to A; props B -> zero request
- preview transition -> zero request
- expected state transition -> reconfirm
- normal ON confirmation/cancel/loading
- OFF path remains usable.

Run:
- corrective focused tests
- PR #76 existing tests
- relevant publish guard/token loader/dispatch tests
- full social-mobile tests
- Deno check/lint for changed runtime/tests
- typecheck/lint
- diff check
- secret/scope scan.

## Explicit non-scope

- G3 AI consultation/content settings/persona
- H2 content-settings schema prerequisite migration
- past-post learning
- account deletion/common-account lifecycle
- broad scheduler redesign
- provider OAuth reconnect
- UI redesign
- production deploy/apply/toggle
- real X operation.

## Production safety

Source/tests/PR amendment only.

Forbidden:
- production migration/RPC apply
- Edge deploy
- production publish toggle
- DB row mutation
- real X post/auth/revoke
- Vault/Auth mutation
- Cron mutation.

## Completion / K4

Report:
- task_id/result
- architecture chosen
- original H1 findings R1–R5 disposition
- transaction/lock/authorization model
- runtime fresh pre-send guard and exact in-flight semantics
- ON/OFF semantics
- tenant-safe error behavior
- migration/RPC changed files
- client confirmation pinning
- tests/adversarial interleavings
- production read/mutation
- real X operations
- old PR head and new exact head
- commit/push/PR state
- remaining risks
- safety checks
- next recommendation.

Then status -> review_required, next_owner -> chatgpt, STOP for K4.

Because this task changes migration/RPC/auth/concurrency/X pre-send safety, K4 must allocate a fresh independent Codex rereview before merge.

Recommended rereview model: **Sol（極高）**.

---

# Claude Task 4 — CURRENT TASK

- task_id: x-social-mobile-publish-toggle-v1-20261002
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: codex
- priority: high
- recommended_model: Opus5.5（高）
- type: feature implementation / posting-permission boundary / authenticated Edge Function
- production_mutation_allowed: false

## Product goal

X自動投稿アプリで、現在は表示だけしている「自動投稿 ON / OFF」を、ユーザーが安全に切り替えられる実機能にする。

This task runs in parallel with G3 `x-social-mobile-ai-consult-v1-20261002`.

G3 owns:
- AI consultation
- content settings/persona
- consultation Edge/API boundary

G4 MUST NOT touch those areas.

G4 owns only the posting-permission toggle for an exact connected social account.

## Why this is a good parallel task

Fresh production/read-only inspection confirms:
- `public.social_accounts.publish_enabled boolean not null` already exists and is the current runtime truth for posting enabled/disabled.
- authenticated clients currently have SELECT only; there is no direct UPDATE policy/grant.
- app already maps `publish_enabled=false` -> paused and true -> active.
- current account/home UI can display ON/OFF but cannot change it.
- no new DB column/table is required.
- common-account PR #70 migration work remains separate.

Therefore implement a narrow authenticated server-side write boundary using the existing schema, with **no migration**.

## Mandatory startup / isolation

1. Read `PROJECT_RULES.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use an independent G4 worktree/checkout.
3. Fresh `origin/main`.
4. Confirm G3 current task is `x-social-mobile-ai-consult-v1-20261002`; do not edit:
   - `apps/social-mobile/src/app/(tabs)/consult.tsx`
   - `apps/social-mobile/src/domain/content-settings*`
   - `apps/social-mobile/src/data/content-settings-repository.ts`
   - G3's consultation Edge Function/tests.
5. Confirm G5/H1 common-account PR #70 files do not overlap intended G4 files.
6. Do not reuse another slot's .env, simulator, Metro, untracked files, worktree or branch.
7. Read the Supabase skill and inspect existing social-mobile Edge Function Auth/membership patterns before implementation.
8. **No DB migration / RLS / grant change in this TASK.**

## Current production facts to preserve

Read-only inspection showed:
- social account connection states include `authorization_pending` and `identity_verified`.
- existing live accounts may have `publish_enabled=true/false`.
- `brand_memberships.role` supports `owner/admin/member/viewer`.
- current user-facing memberships observed are owners, but implementation must define role handling safely.
- `brands` has `is_active` and `publish_mode` including live/disabled.
- authenticated role has SELECT on social_accounts, not UPDATE.

Do not weaken RLS or add direct client write access just to make the toggle easy.

## Required architecture

Implement a dedicated authenticated server-side action for the exact account, preferably a narrowly scoped Edge Function such as:

`social-mobile-publish-setting`

or follow the repository's existing naming convention if a better one exists.

Client request conceptually:
- `social_account_id`
- `desired_enabled: boolean`
- `expected_current_enabled: boolean`

Do NOT trust a client-supplied brand id as authorization.

Server derives/validates:
1. valid caller JWT/user
2. exact social account row by id
3. account's actual `brand_id`
4. caller membership for that exact brand
5. permitted role
6. account/platform/connection readiness
7. current publish state
8. stale-state conflict protection.

## Authorization

Fail closed.

Minimum policy:
- unauthenticated: reject
- no membership: reject
- `viewer`: reject
- `member`: reject for v1 unless existing product policy clearly documents publish-control permission; default to owner/admin only
- `owner` / `admin`: eligible subject to readiness checks

Do not use unmerged common-account/service-entitlement semantics from PR #70.

Do not allow one user's membership to toggle an account in another brand.

Do not expose service-role credentials to the app.

## ON behavior — strict enable gate

Turning **ON** creates permission for future scheduled work to actually publish, so it must be stricter than OFF.

Enable only if all source-of-truth checks pass:

- exact social account exists
- platform is X for this v1
- account's brand exists
- brand `is_active = true`
- brand `publish_mode = 'live'`
- connection status is the exact verified/usable state used by the current posting pipeline (production currently uses `identity_verified`; inspect runtime contract and do not guess)
- `verified_at` is present if runtime uses it as verification evidence
- required Vault credential **references** exist for the account
- do not read/log/return Vault plaintext
- no known connection state says reconnect/authorization pending
- caller is allowed owner/admin
- request's expected current value matches the current row

If any prerequisite fails:
- do not toggle
- return a bounded user-safe error code/message
- advise reconnect where appropriate
- do not attempt X auth/post/revoke.

Do not “repair” credentials in this endpoint.

## OFF behavior — safety first

Turning **OFF** should be easy and fail safe.

An authorized owner/admin should be able to set `publish_enabled=false` even if:
- X connection is degraded
- tokens are missing
- brand is inactive

because disabling future publishing is the safer direction.

Still require:
- valid caller
- exact account/brand membership
- stale-state protection.

OFF must NOT:
- revoke X OAuth
- delete credentials
- delete scheduled posts
- delete drafts/history
- sign the user out
- alter common-account state.

It only disables the permission gate.

## Concurrency / stale UI

Use compare-and-set semantics.

The client sends the state it believes is current.

The server must not silently overwrite a state that changed after the screen loaded.

Expected behavior:
- expected matches -> perform/no-op safely
- expected mismatches -> return conflict/stale result
- client reloads current snapshot and asks user again if needed.

Avoid double-tap races:
- disable control while request is in flight
- server side conditional update on exact id + expected current value
- zero-row update after authorization/read => treat as stale/conflict, not success.

## Exact mutation boundary

The action may mutate only:

`public.social_accounts.publish_enabled`

(and an existing generic `updated_at` only if the repository's established update mechanism/trigger naturally does so).

It must NOT mutate:
- connection_status
- verified_at
- platform_user_id
- oauth_client_ref
- Vault refs
- Vault contents
- brands
- brand_memberships
- scheduled_posts
- post_execution_logs
- Auth
- common-account/service-entitlement tables
- content settings/persona
- scheduler/Cron state.

No X API call.

## Client UX — functional only

UI is going to be redesigned later. Do not polish.

Place the control where account-specific operational settings already belong, preferably:
- `apps/social-mobile/src/app/accounts/[id].tsx`

Functional minimum:
- clearly show current status
- button/control to turn ON or OFF
- ON requires an explicit confirmation explaining:
  「ONにすると、条件を満たした投稿予定は自動でXへ投稿される可能性があります」
  or equivalent truthful wording
- OFF should clearly say future automatic publishing is stopped; do not claim queued data is deleted
- loading state
- success state
- safe error state
- stale conflict -> reload/reconfirm
- disconnected/not-verified state -> ON disabled/explained; OFF remains available if currently ON
- after success, reload shared data so Home/Accounts reflect source-of-truth state.

Do not spend time on visual redesign, header polish, animations, spacing, icons, etc.

## Relationship to approvalMode

Keep these two concepts separate:

- `social_accounts.publish_enabled` = whether this exact account is allowed to publish automatically
- `content settings.approvalMode` = whether content requires human review

This G4 task changes **only publish_enabled**.

Do not edit content settings or AI consultation.

Do not treat `auto_post_preference` as permission to toggle publish_enabled.

## Tests

### Edge/server

At minimum:
- unauthenticated -> rejected
- account not found -> safe 404/blocked
- no membership -> rejected
- viewer/member -> rejected by v1 policy
- owner/admin exact brand -> allowed
- cross-brand account id -> rejected
- ON blocked for authorization_pending/not verified
- ON blocked if brand inactive
- ON blocked if brand publish_mode disabled
- ON blocked if required credential references absent
- ON never reads/returns Vault plaintext
- OFF allowed despite degraded connection for authorized owner/admin
- stale expected state -> conflict/no mutation
- duplicate/same-state request is deterministic/no harmful extra mutation
- only publish_enabled changes
- no scheduled_posts/post logs/Auth/Vault/content settings/common-account mutation
- no X API/network call
- secrets/JWT not logged or returned
- method/content-type/input validation
- bounded safe error codes.

### Client/domain

- current ON/OFF renders truthfully
- ON confirmation is required
- cancel confirmation -> no request
- OFF wording does not imply deletion/revoke
- request in flight prevents duplicate taps
- success reloads snapshot
- stale conflict reloads and does not pretend success
- disconnected account cannot be enabled
- currently-ON degraded account can still be disabled
- account id passed is exact selected account
- no G3 content-settings/consultation code imported or altered.

Run:
- focused new tests
- full social-mobile tests
- relevant Edge/shared tests
- typecheck/lint/runtime checks per repo
- `git diff --check`
- secret scan
- scope diff.

## Local verification

Use G4-owned mock/local environment.

Verify functionally:
1. OFF account -> press ON -> confirmation appears
2. cancel -> no state change
3. confirm against mocked eligible account -> UI becomes ON after reload
4. ON -> OFF -> state becomes OFF
5. authorization_pending account cannot be enabled
6. stale-state response is shown safely
7. no post is created/sent
8. no X auth/revoke occurs.

No real X post or production toggle is needed for this source task.

## DB / migration rule

**No migration, RLS change or grant change.**

If implementation cannot safely provide the write boundary without schema/RPC changes:
- STOP
- report exact blocker
- do not modify PR #70 or create a migration.

## Explicit non-scope

- AI consultation / persona
- past-post learning
- AI post generation
- edit/regenerate/approve post content
- retry failed scheduled post
- scheduler/Cron changes
- X OAuth connect/reconnect
- token refresh logic
- account deletion
- common account/service entitlement
- new DB schema
- major UI redesign
- production deploy.

## Production / safety

Source + tests + PR only.

Forbidden:
- production Edge deploy
- production publish toggle
- real X post
- real X auth/revoke
- Vault mutation
- Auth mutation
- DB migration/apply
- Cron/scheduler mutation.

Production mutation = 0.

## Completion / K4

Report:
- task_id
- result
- endpoint/architecture
- exact authorization policy
- enable prerequisites
- disable semantics
- stale/CAS behavior
- exact mutation boundary
- changed_files
- tests
- local verification
- proof G3 consultation files untouched
- DB migration = none
- production mutation = 0
- real X operations = 0
- commit / push / PR
- remaining issues
- safety checks
- next recommendation.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.

### Expected review

This is a posting-permission/security boundary. K4 should normally allocate a focused Codex review before merge.

Recommended Codex model: **Sol（高）**.

Do not merge/deploy solely from Claude's self-review.

---

# Claude Task 4

- task_id: x-social-mobile-x-account-switch-auth-session-20261001
- owner: claude
- slot: claude-4
- status: done
- next_owner: none
- priority: high
- recommended_model: Sonnet5（高）
- purpose: iOSのX OAuth接続時に前回ログインしたXアカウントが再利用され、複数Xアカウント利用者が接続先を切り替えにくい問題を、本番向けに安全に修正する。

## Why this should be fixed

The issue was reproduced during E3 preparation:
- the X login sheet remembered the previously authenticated X account.
- the operator could not reliably switch to a different X account.
- a local-only temporary change that opened a clean login session allowed the intended disposable account to be selected.
- this can affect real users who own multiple X accounts and can lead them to authorize the wrong account.

Current source uses:
`WebBrowser.openAuthSessionAsync(authorizationUrl, redirectUri)`
inside:
`apps/social-mobile/src/features/x-connect/use-x-connect.ts`

The installed app uses Expo 57 / `expo-web-browser ~57.0.3`.

Expo's current WebBrowser API supports an iOS auth-session option `preferEphemeralSession` that requests a private authentication session so normal browser cookies are not shared. Verify the installed type/API before implementation; do not add undocumented X query parameters.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use an independent G4 worktree/checkout; never use G3's worktree or simulator session.
3. Fresh `origin/main`.
4. Confirm G3 is operational E3 verification only and is not editing `apps/social-mobile/src/features/x-connect/use-x-connect.ts` or related tests.
5. Inspect the installed `expo-web-browser` type/API for Expo 57 before editing.
6. Do not use or mutate the disposable E3 account, protected production accounts, Vault, DB, Auth data, or X provider settings.

## Scope

Primary allowed scope:
- `apps/social-mobile/src/features/x-connect/use-x-connect.ts`
- narrowly related social-mobile tests
- onboarding copy only if needed to explain account choice

Do not change:
- server-side X OAuth contract
- PKCE/state validation
- callback ownership binding
- Supabase Edge Functions
- DB/RLS/RPC/migrations
- Vault/token storage
- account deletion
- scheduler/posting paths
- production feature flags

## Required behavior

Goal: when a user chooses to connect or reconnect an X account on iOS, the auth session should not silently inherit a previously logged-in X identity in a way that prevents account choice.

Preferred implementation candidate:
- request an ephemeral/private auth session for the X connect flow on iOS using the supported Expo WebBrowser option.
- keep Android/Web behavior unchanged unless the installed API provides an equally documented and safe equivalent.

Requirements:
1. Preserve current PKCE, state, redirect URI and callback validation exactly.
2. Do not clear global Safari/browser cookies.
3. Do not sign the user out of unrelated web sessions.
4. Do not add undocumented X authorization parameters.
5. Do not weaken the server-side duplicate-X-account protection.
6. Cancel/dismiss/retry behavior must remain truthful.
7. Reconnect flow must use the same safe account-selection behavior.
8. No real X post or production credential mutation.

## UX

If needed, add a short truthful hint near the X connect button such as:
- the user will be asked to sign in/select the X account they want to connect.
Do not promise that every browser/platform will always show an account chooser if the platform cannot guarantee that.

## Tests

Add/adjust focused tests to prove at minimum:
- iOS X connect requests the supported private/ephemeral auth-session behavior.
- Android/Web do not receive an unsupported iOS-only behavioral change.
- redirect URI, state, PKCE challenge/verifier and callback parser remain unchanged.
- cancel/dismiss/success/error state behavior remains unchanged.
- duplicate-X-account server protection remains untouched.
- no global cookie clearing/browser data deletion is introduced.

Run:
- social-mobile tests
- typecheck
- lint
- relevant Expo export/config check if available
- diff/secret checks

No EAS build unless a native rebuild is actually required to test the API behavior. Prefer local iOS Simulator verification.

## Local visual/E2E verification

Use a local simulator/test environment only:
- confirm the X auth sheet no longer auto-reuses the prior X login in the problematic way.
- confirm the user can intentionally authenticate a different X account.
- do not use protected production posting accounts for this test.
- do not perform a real X post.

If reliable provider-side testing would require touching production credentials/accounts, STOP and report rather than doing so.

## Completion / K4

Report:
- task_id
- result
- root cause
- exact source behavior changed
- changed_files
- tests
- local simulator result
- commit_hash
- push/PR
- production mutation = 0
- remaining issues / platform caveats
- safety checks
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for K4.

Because this changes an OAuth/authentication boundary, ChatGPT will decide at K4 whether focused Codex review is required before merge.


## Report

- task_id: x-social-mobile-x-account-switch-auth-session-20261001
- result: **PASS（source・自動テスト）／実機でのXアカウント切替確認は未実施（操作者の確認が必要）**。PR #65（未merge）。
- model_used: Sonnet 5.5
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`（G3のworktree・Simulatorは使っていない。G3はE3の運用確認のみで、`use-x-connect.ts`と関連テストは編集していないことを確認）

### root cause

`use-x-connect.ts`が`WebBrowser.openAuthSessionAsync(authorizationUrl, redirectUri)`をオプションなしで呼んでいた。iOSではこれが`ASWebAuthenticationSession`で、Safariのcookieを共有するため、直前にログインしたXアカウントがそのまま再利用され、別のアカウントを選べなかった。

### exact source behavior changed

- インストール済み`expo-web-browser 57.0.3`の型定義で、`AuthSessionOpenOptions.preferEphemeralSession`（`@platform ios`、既定`false`、「ブラウザが対応するかは利用者の既定ブラウザ次第」と明記）を確認。ネイティブ側も`ASWebAuthenticationSession.prefersEphemeralWebBrowserSession`へ配線済み（カスタムスキームのcallbackでも設定される）。未文書のXパラメータは追加していない。
- **iOSだけ**、この第3引数`{ preferEphemeralSession: true }`を渡す。Android/Webは従来どおり2引数のまま（オプションなし）。再接続も同じhookなので同じ挙動になる。
- 接続画面（アカウント画面・オンボーディングの接続ステップ）に、真実に沿った案内を1行追加: 「接続時に、Xのログイン画面で接続したいアカウントを選んで（またはログインして）ください。ブラウザの状態によっては、以前ログインしたアカウントが表示される場合があります。」（アカウント選択画面が必ず出るとは約束していない）。
- 変更していないもの: state・PKCE・redirect URI検証・`x.com`ホスト許可・callback解析・リクエスト本文・cancel/dismiss/success/errorの状態処理、サーバー側のX重複アカウント保護、Edge Function、DB、Vault、アプリログイン用のprovider認証（`auth-client-flows.ts`）。cookie・ブラウザデータの削除は行っていない。

### changed_files

新規: `apps/social-mobile/src/features/x-connect/auth-session-options.ts`、`apps/social-mobile/tests/x-connect-auth-session.test.mjs`
変更: `apps/social-mobile/src/features/x-connect/use-x-connect.ts`（3引数化、+5/-1）、`apps/social-mobile/src/app/accounts/index.tsx`（案内1行）、`apps/social-mobile/src/features/onboarding/onboarding-gate.tsx`（案内1行）
サーバー・DB・Edge Function・G3のテストファイルの変更なし。onboardingの既存テストはモジュールのimportを厳密に検査するため、新規モジュールをimportせず案内文はリテラルにした。

### tests

- 新規`x-connect-auth-session.test.mjs`: **10/10 pass**（iOSは指定あり／Android・Web・その他は指定なし／型定義にiOS専用オプションが存在／hookがそのオプションだけを渡す／OAuth契約の各行が不変／状態処理が不変／cookie削除・追加パラメータなし／アプリログイン側が不変／案内文が両画面にあり「選べる」と約束していない）。変異検査: hookからオプションを外すとテストが失敗することを確認し、元に戻した。
- `npm test`（social-mobile全体）: **99/99 pass**。data-view＋post-interaction: 22/22 pass。
- `tsc --noEmit`: PASS。`expo lint`: PASS。Expo web export: 成功（895 modules）。Expo iOS export: 成功（1224 modules）。
- `git diff --check`: PASS。secret scan: 該当なし。
- EAS buildなし。ネイティブ側にオプションが既にあるため、この変更でネイティブ再ビルドは不要と判断（実機の開発ビルドが同じ`expo-web-browser`から作られている前提）。

### local simulator result

**未実施**。理由: (1) 起動中のSimulator（iPhone 17 Pro）はG3のE3検証の環境で、使わない指示のため使っていない。(2) 「別のXアカウントを実際に選べるか」の確認は、実際のXログイン画面へXアカウントの認証情報を入力する必要があり、エージェントは認証情報を入力しない（TASKも本番・保護アカウントの使用を禁止）。したがって、プロバイダ側の実際の挙動（ログイン画面が既ログインを引き継がないこと）は**未確認**。
- 操作者の確認手順（案）: このブランチのJSを実機/Simulatorの開発ビルドに読み込み、Safariで複数のXアカウントのうち1つにログインした状態でアカウント画面の「Xアカウントを再接続」を押し、認証シートが既存のログインを引き継がずログイン画面から始まる（別のアカウントで認証できる）ことを確認する。使用するのは使い捨てアカウントのみ、投稿はしない。

### commit_hash

`e8a7785`（PR #65、ブランチ`g4/x-connect-ephemeral-auth-session-20261001`）。このReportのcommitはmainに別途push。

### push/PR

ブランチをpush済み。PR #65（OPEN、MERGEABLE）: https://github.com/anohi-memories/kabumori/pull/65 。未merge。

### production mutation

**0件**。deploy・DB/RLS/RPC/migration・Auth/Vault変更・X投稿・本番アカウント操作はいずれも無し。

### remaining issues / platform caveats

1. 実機でのプロバイダ側の挙動が未確認（上記）。`preferEphemeralSession`は「要求」で、ユーザーの既定ブラウザによっては尊重されない可能性がある（公式ドキュメントに明記）。案内文はそれに合わせて約束をしていない。
2. 副作用: 非共有セッションのため、接続のたびにXへログインし直しになる（Safariのログイン状態・SSOは使われない）。パスワードマネージャーの自動入力の使い勝手は端末設定によって変わる可能性がある。
3. Android/Webは今回のスコープ外（同等の文書化された手段がないため従来どおり）。Android側で同じ問題が出る場合は別TASKが必要。
4. アプリログイン用のX認証（G3所有）は別の信頼ステップで、同様のアカウント再利用が起こりうるが、TASKの範囲外のため変更していない。

### safety checks

- OAuth/PKCE/state/redirect/callback検証・サーバー側の重複アカウント保護・秘密情報の取り扱いは変更なし（テストで固定）。
- 未文書のX認可パラメータ、cookie・ブラウザデータ削除、他サービスからのサインアウトは導入していない。
- 本番資格情報・保護アカウント・使い捨てE3アカウントに触れていない。実際のX投稿なし。

### next recommendation

1. OAuth/認証境界の変更なので、K4でCodexの焦点レビューの要否を判断（変更は約6行で、境界の検証ロジックは不変）。
2. 操作者が実機（または自分のSimulator）で、上記の手順どおり使い捨てアカウント同士の切替を確認する。確認後にmerge。
3. 問題がなければ、E3の再開・以降のXアカウント接続の手順に「毎回Xへログインし直しになる」旨を反映する。

## Completion

- status -> review_required
- next_owner -> chatgpt


## K4 follow-up — operator provider-side E2E only

- K4 verdict: **HOLD — source/review PASS, provider-side operator E2E remains**.
- PR #65 exact head remains `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`, open and mergeable.
- Prior C1/source-security review already accepted this exact head; no additional Codex review is required unless runtime source changes.
- Fresh main has advanced since the PR base, but none of the five PR #65 source/test files overlap main-side changes.
- Do not change source unless the E2E exposes a real defect.

### Goal

Prepare and guide a safe operator-side iOS test proving:
1. a previously logged-in X identity is not silently forced on the posting-account connect flow,
2. the operator can authenticate a different disposable X account,
3. cancel -> retry remains usable,
4. reconnect uses the same behavior,
5. no real X post occurs.

### Environment isolation

- Use the dedicated G4 worktree/checkout only.
- Do not use G3's worktree, branch, or active simulator process.
- If no separate simulator/device is safely available, STOP and report instead of sharing G3's environment.
- Load PR #65 JS/source into a compatible existing development build. Do not rebuild unless actually necessary.
- Do not use protected production posting accounts.
- Use only disposable/test X identities controlled by the operator.

### Operator interaction boundary

Claude may:
- prepare the app/simulator to the point immediately before X login/account selection,
- tell the operator exactly what to tap,
- observe app-side state after the operator action,
- inspect non-secret logs/results.

Claude must NOT:
- type X passwords, passkeys, 2FA codes, recovery codes, or other credentials,
- approve X authorization on the operator's behalf,
- clear global browser cookies,
- modify provider settings,
- post to X.

### PASS criteria

PASS only if the operator confirms/observes:
- starting from a normal browser state with X account A signed in, the posting-account connect/reconnect flow does not silently complete as A without an opportunity to authenticate,
- account B can be authenticated intentionally in the auth session,
- cancellation returns safely and retry works,
- reconnect follows the same path,
- no real post is created.

Because `preferEphemeralSession` is a best-effort platform/browser request, it is acceptable if the UI is a fresh login screen rather than a literal account chooser. The required result is that the previous normal-browser session is not silently reused in a way that prevents choosing/authenticating another account.

### After PASS

- Do not merge PR #65 in G4.
- Record exact operator-observed behavior, device/simulator context, cancel/retry/reconnect result, and real X posts = 0.
- Set status -> review_required, next_owner -> chatgpt and STOP for another K4.
- ChatGPT will perform the final merge/no-race decision.

### If FAIL

- Preserve evidence and STOP.
- Do not improvise new OAuth parameters or cookie clearing.
- If a source correction is required, report the smallest proposed change first; runtime-source change will require another focused review.

Recommended model: **Sonnet5（高）**.


## Report — operator E2E follow-up (2026-10-01)

- task_id: x-social-mobile-x-account-switch-auth-session-20261001
- result: **STOP — 安全に使える独立した検証環境がなく、操作者のE2Eを開始できない**。PR #65のsourceは変更していない。
- model_used: Sonnet 5.5
- PR #65: exact head `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`（OPEN、MERGEABLE、2 commits、変更は同じ5ファイルのみ）。mergeしていない（TASKの指示どおり）。

### 確認したこと（読み取りのみ）

- 利用可能なSimulatorは `iPhone 17 Pro`（Booted）が1台＝G3のE3検証の環境のため使っていない。他の機種は Shutdown で、アプリが入っていない。
- このMacにある `SocialOperations.app` のビルド（DerivedData）は実機向け（`iphoneos`）で、9/20のもの。**Simulatorで起動できる開発ビルドは存在しない**。Simulator用にするにはネイティブビルドが必要で、TASKは「実際に必要でない限り再ビルドしない」としている。
- このworktreeにも共有checkoutにも `apps/social-mobile/.env` が無く、アプリを実データ接続（Supabaseのログイン・接続画面）まで進める公開設定値（`EXPO_PUBLIC_SUPABASE_URL`/publishable key/`EXPO_PUBLIC_DATA_SOURCE`）がこの環境に無い。G3のworktreeや環境から流用することは、環境分離のルール上しない。
- 接続ボタンまで到達するには、アプリへのログイン（メール/パスワード等）と、Xのログイン（アカウントA・Bの認証情報）が必要で、いずれもエージェントは入力しない。

### 選択肢（操作者の判断が必要）

- **A. 実機iPhone＋既存の開発ビルド（推奨・最短）**: 実機の開発クライアントに、PR #65 head のJSを読み込む。必要なのは、操作者が実機の開発ビルドで使っている公開設定値（`.env`相当、秘密ではないpublishable keyのみ）をこのworktreeに置くことの許可と、他のMetro（G1・実機で使用中のもの）を止めるタイミングの調整。Metroは自分のworktree（独立したnode_modules）から1つだけ起動する。
- **B. 新しいSimulatorにネイティブ開発ビルドを作る**: `iPhone 17e`などの未使用機種に開発ビルドを入れる。時間がかかり、TASKが避けている再ビルドに当たる。
- **C. 操作者がローカルで自分で確認**: このPRのブランチのJSを、操作者の普段の開発環境で読み込んで、下の手順で確認する。結果（PASS/FAIL）だけをChatGPT/私に共有する。

### 操作者の確認手順（A/Cで共通、使い捨てのXアカウントA・Bのみ）

1. 端末のSafariで、使い捨てXアカウントAにログインしておく（通常のブラウザの状態）。
2. アプリのアカウント画面（またはオンボーディング）で「Xアカウントを再接続」を押す。
3. 認証シートが、Aで自動的に進まず、ログイン画面から始まるか（Aを引き継がず、別のアカウントBで認証できるか）を確認する。操作者がBで認証する。
4. 別回で、認証シートを閉じて（キャンセル）→ もう一度押して再試行できるか確認する。
5. 再接続（接続済みの状態から再度押す）でも、2〜3と同じ挙動か確認する。
6. 実際のXへの投稿が作成されていないことを確認する（投稿を行う操作はしない）。

### production mutation / X posts

production mutation 0 / 実X投稿 0（今回は読み取りと文書更新のみ）。

### 次の推奨

操作者が A / B / C のどれかを選ぶ。Aの場合は、公開設定値の置き場所（このworktreeの`apps/social-mobile/.env`、未追跡）の許可と、Metroを使う順番の調整を教えてもらえれば、私がPR #65 head のJSを用意して、操作を1手ずつ案内する。

## Completion

- status -> review_required
- next_owner -> chatgpt


## K4 follow-up 2 — isolated simulator provider proof

- K4 verdict: **HOLD — source/review still PASS; prior follow-up stopped only because no isolated runnable native environment existed**.
- PR #65 exact head remains `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`, open / mergeable.
- GitHub checks are green and fresh main has no overlap with PR #65's five source/test files.
- G3 is now Final K3 done and its temporary simulator harness/app was removed. Do not reuse G3 files/worktree.
- A native Simulator build is now considered **actually necessary** for the remaining provider proof and is authorized in this G4 follow-up.
- Recommended model: **Sonnet5（高）**.

### Environment plan

1. Use the dedicated G4 worktree only.
2. Boot a currently unused Simulator device (prefer a Shutdown device such as iPhone 17e rather than reusing another slot's active simulator).
3. Build/install a Simulator-compatible development or Release-like build from PR #65 head.
4. Do not use EAS unless local native build genuinely cannot perform the check.
5. Use only public client configuration needed to reach the app login/X authorization flow. Do not copy secrets, service-role keys, Vault values, or untracked files owned by another slot.
6. If the required public Supabase URL/publishable key cannot be obtained from a safe canonical/user-provided location, STOP and ask the operator for those public values rather than borrowing another slot's .env.

### Non-mutating provider proof

The goal of this follow-up is specifically to prove the iOS auth-session behavior **without creating a new production X connection**.

Operator actions only:
1. Sign in to the disposable/test app login as needed.
2. In normal Safari, sign in to disposable X account A.
3. Start the app's posting-X connect flow.
4. Verify the auth session does **not** silently continue as A and instead presents a fresh login/authentication opportunity.
5. The operator may enter disposable X account B credentials far enough to prove B can be authenticated/identified in the isolated auth session.
6. **Do not press the final X authorization/consent action that would complete callback/linking or persist credentials.** Cancel/close before the app connection is created.
7. Retry once and verify the flow is still usable and again does not silently reuse Safari A.
8. Confirm no real X post occurred.

This provider proof is sufficient for the native behavior because:
- the actual source and Codex review already prove connect/reconnect share the same X-connect hook/auth-session option,
- focused tests cover reconnect/cancel/retry and OAuth contract,
- the only unverified platform fact was whether iOS/browser honors the ephemeral-session request enough to prevent silent reuse of the normal Safari identity.

A production disposable X connection/reconnect is therefore **not required** for this K4 and must not be created merely for verification.

### PASS criteria

PASS if all are true:
- isolated G4 Simulator/native build runs PR #65 head,
- Safari account A is not silently forced through the app auth session,
- operator can reach authentication as a different disposable account B,
- cancel returns safely,
- retry works,
- no final provider authorization/linking is completed,
- production DB/Vault/Auth/OAuth application state mutation = 0,
- real X posts = 0,
- runtime source remains unchanged.

### After PASS

- Record simulator/device/build context and operator-observed behavior.
- Re-run/fresh-confirm PR head, mergeability/checks and no main overlap.
- Do not modify runtime source.
- Set status -> review_required, next_owner -> chatgpt and STOP for K4.
- ChatGPT will make the final merge decision.

### If FAIL

- STOP with evidence.
- Do not clear Safari cookies, add undocumented X params, or improvise provider workarounds.
- Any runtime source change reopens focused review.


## Report — K4 follow-up 2: isolated provider proof (2026-10-01)

- task_id: x-social-mobile-x-account-switch-auth-session-20261001
- result: **PASS（操作者が実機で確認）**。PR #65 head のネイティブビルドで、X接続の認証セッションがSafariのログイン中アカウントAを引き継がず、別の使い捨てアカウントBで認証画面（最終の許可の手前）まで進めること、キャンセル後の再試行が同様に動くことを、操作者が観察した。runtime sourceは変更していない。
- model_used: Sonnet 5.5
- PR #65: exact head `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`（OPEN、MERGEABLE、CLEAN、GitHub checks green）。**mergeしていない**（最終のmerge判断はChatGPT）。fresh mainにPR #65の5つのsource/testファイルとの重なりなし。

### 環境（G3の環境・設定は不使用）

- 実施はG4専用の一時フォルダのみ（PR #65 headを`git archive`で取り出し、`npm ci`、`expo prebuild`、`pod install`、`xcodebuild`）。G3・他slotのworktree/.env/Simulator/Metroには触れていない。リポジトリのsource・app.jsonは変更していない（検証用の変更は一時フォルダ内のみ）。
- 公開クライアント設定（Supabase URL・publishable key）は操作者が提供。秘密鍵・service_role・Vaultは不使用。設定値は一時フォルダ内の未追跡`.env`のみ（コミットなし、このReportにも値を記載しない）。
- **Simulator**（iPhone 17e、未使用機）: Debugビルドを作成・インストールし、アプリがログイン画面（実データ接続）まで起動することを確認。ただしClaude内の操作パネルにホームボタンがなく、SafariとアプリをSimulator上で行き来する検証が不便だったため、操作者の依頼で実機に切り替えた。このMacには`Simulator.app`本体が無い。
- **実機**（操作者のiPhone 17 Pro、iOS 26系）: 一時フォルダでDebugビルド（ローカル署名、操作者の既存の開発用証明書、自動プロビジョニング）→ `devicectl`でインストール → 私のMetro（LAN、port 8081、一時フォルダのnode_modules）からJSを読み込み。EAS不使用。
  - 検証用の一時変更（一時フォルダ内のみ）: bundle identifierを既存の開発用アプリと別の値（`…g4proof`）にして、操作者の既存アプリを上書きしない。署名可能にするため、Appleログインのentitlement（`usesAppleSignIn`と`expo-apple-authentication` plugin）を一時的に外した（今回の確認対象外）。
  - アプリのJS（PR #65 headのsource）は、Metroが1386 modulesをbundleして実機に配信したことをログで確認。

### 操作者が観察した結果（使い捨てアカウントのみ）

操作者の報告（原文要旨）:
1. SafariでXアカウントAにログインした状態で、アプリのXアカウント接続を開始 → **「ログイン画面から始まった（Aを引き継がなかった）」**。
2. 別の使い捨てアカウントBで、**「許可の手前まで進めた」**（最終のX認可・consentは押していない）。
3. 認証シートを閉じる → **アプリの「Xで認証」画面に戻った**（キャンセルで安全に戻る）。
4. もう一度接続を開始 → **「ログインになった」**（再試行でも、Aを自動で引き継がずログイン画面から始まった）。

### PASS criteria

- isolated G4 native build runs PR #65 head: **満たす**（Simulator・実機の両方でPR #65 headのJSを実行。実機で操作者が確認）。
- Safari account A is not silently forced through the app auth session: **満たす（操作者の観察）**。
- operator can reach authentication as a different disposable account B: **満たす**（許可の手前まで）。
- cancel returns safely / retry works: **満たす**（操作者の観察。3と4）。
- no final provider authorization/linking completed: **満たす**（操作者は最終の許可を押していない）。
- production DB/Vault/Auth/OAuth application state mutation = 0: **Claudeは0**。操作者はアプリに使い捨てのアプリアカウントでログイン（またはその登録）をした可能性があり、その場合は使い捨てのAuthユーザーが本番Authに1件作られている。このReportでは操作者の行為の内訳は確認していない。X側の接続（連携の保存・Vault）は作られていない（最終の許可を押していないため）。
- real X posts = 0: 満たす。
- runtime source remains unchanged: 満たす（PR #65 headのまま。変更・追加commitなし）。

### 注意・補足

- 未確認: 「再接続」ボタン（接続済みアカウントがある状態）での操作は今回は行っていない。TASKの判断どおり、接続と再接続は同じhook・同じ認証セッション設定を共有する（sourceとテストで確認済み）。
- 操作者の観察は「ログイン画面から始まった」で、「アカウント選択画面」ではない。`preferEphemeralSession`はベストエフォートの要求であり、TASKのPASS基準（前のブラウザセッションの黙った再利用がない）を満たす挙動。
- 副作用の再確認: 非共有セッションのため、接続のたびにXへログインし直しになる。
- 後片付けのお願い（操作者）: iPhoneに検証用アプリ「Social Operations」（別のbundle id）が追加されている。不要なら削除してよい。使い捨てのアプリアカウント・Xアカウントも不要なら操作者側で整理する。Simulator（iPhone 17e）にも検証用アプリが残っている。
- 私が起動した開発サーバー（port 8083、8081）は両方停止済み。他のslotの開発サーバーは停止していない。一時フォルダはMacの再起動等で消える。

### production mutation / X posts

Claudeによるproduction mutation 0。実X投稿 0。最終のX認可（接続の作成）は押されていない。

### 次の推奨

- ChatGPTがK4でPR #65の最終merge判断（head `e5a66f5`、checks green、main重なりなし、操作者の実機確認PASS）。
- merge後、X接続の手順（E3など）に「接続のたびにXへログインし直し」の旨を反映する。

## Completion

- status -> review_required
- next_owner -> chatgpt


## Final K4 — X account-switch auth session

- verdict: **PASS**.
- accepted PR #65 exact head: `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`.
- squash merged as `6b1f2f6229a1b75743b57900d869368c2c5e8693`.
- source/security review had already accepted this exact head; no runtime-source changes were made after review.
- operator/native proof passed on an isolated G4 build: normal Safari X account A was not silently reused; a different disposable account B reached the final-consent boundary; cancel returned safely; retry again started at login.
- final X authorization/consent was not completed; no social-account linking was created for this proof; real X posts = 0.
- independent production read-only verification for the test window found 0 new Auth users, brand memberships, social accounts, OAuth states, token-store updates, or Vault secret creates/updates.
- fresh merge gate: PR open/mergeable, head unchanged, checks green, no overlap with the five PR files despite main advancement.
- no additional Codex review required because exact reviewed runtime source remained unchanged.
- platform caveat: iOS private/ephemeral auth session is best-effort; the verified behavior was a fresh login screen rather than a guaranteed account chooser.
- Android/Web behavior remains unchanged.
- app binary/TestFlight was not released by this K4; the merge will be included in the next native build.
- remaining separate UI follow-up: the accounts screen still has a Link-asChild styling issue identified by G3; not part of the OAuth fix.
- G4 closed and reusable only after fresh allocation.


## Report — x-social-mobile-publish-toggle-v1-20261002 (2026-10-02)

- task_id: x-social-mobile-publish-toggle-v1-20261002
- result: **PASS（source・自動テスト）／deploy・実機確認は未実施**。PR [#76](https://github.com/anohi-memories/kabumori/pull/76)（未merge、source candidate）。
- model_used: Sonnet 5.5（TASKの推奨は Opus5.5（高）。セッション内で自分のモデルは切り替えられなかったため、権限境界のレビューは Codex Sol で必ず行うこと）。

### endpoint / architecture
- 新規 Edge Function `social-mobile-publish-setting`（`logic.ts` 方針／`http.ts` PostgREST依存／`index.ts` 入口）。verify_jwt は ON のまま。POST のみ、`application/json` のみ、本文1KB以内。
- 本文は厳密に3項目 `{social_account_id, desired_enabled, expected_current_enabled}`。`brand_id` などの余計な項目は無視せず 400。
- 呼び出し元は Auth `/auth/v1/user` で検証。アカウントの本当の `brand_id` はサーバーが service key で読む。membership は呼び出し元JWT＋anon key（RLS適用）で読む。Vault の参照列は「有無」の真偽値にだけ変換し、返却・ログしない。Vault 平文は読まない。
- クライアント: `apps/social-mobile/src/app/accounts/[id].tsx` に自動投稿カード（`features/publish-setting/*`、`domain/publish-setting.ts`）。

### exact authorization policy
- owner / admin のみ（対象アカウントの brand の membership）。viewer / member は 403 `PUBLISH_CONTROL_FORBIDDEN`（OFFも不可）。
- 未認証 401。アカウント不存在／membership なし／他brand は区別できない同一の 404 `ACCOUNT_NOT_FOUND`（id の存在を漏らさない）。

### enable prerequisites（ON）
platform=x、brand `is_active`、`publish_mode='live'`、`connection_status='identity_verified'`、`platform_user_id`・`verified_at` あり、Vault参照（access/refresh）あり、`last_connection_error_code` なし、expected一致。接続系の失敗は `reconnect_recommended:true`。これらの接続条件は書き込みのWHEREにも含めており、読み取り後に接続が壊れても ON にならない（brand条件のみ書き込み前の読み取りで確認）。

### disable semantics（OFF）
owner/admin なら、接続劣化・資格情報欠落・brand無効でも常に可能。OAuth失効、資格情報・投稿・下書き・履歴の削除は一切しない。UI文言も「削除されない」と明記。

### stale / CAS behavior
- 期待値と実値が違えば 409 `STALE_STATE`（`current_enabled` 付き）。同一状態要求は書き込みなしの 200 `unchanged`。
- 書き込みは条件付きPATCH1回。0行更新は成功扱いにせず再読込し、不存在→404／状態変化→STALE_STATE／ON時は接続条件不成立→CONNECTION_NOT_VERIFIED／OFF時の原因不明→503。アカウント削除中のガードトリガは 409 `ACCOUNT_BUSY`。二重送信は2回目が STALE_STATE。

### exact mutation boundary
- 変更するのは `social_accounts.publish_enabled` のみ（`id`・`brand_id`・期待値で絞った条件付き PATCH、ボディは `{publish_enabled}` のみ）。`updated_at` は意図的に変更しない（接続状態のリース用スタンプのため）。
- 呼ぶ先は Auth user / social_accounts GET / brands GET / brand_memberships GET / social_accounts PATCH の5つだけ（テストで URL を網羅検証）。X API・Vault・RPC・他テーブル・Cron・Auth変更なし。

### changed_files（PR #76、10ファイル）
- `supabase/functions/social-mobile-publish-setting/{index,logic,http,logic_test,http_test}.ts`
- `apps/social-mobile/src/domain/publish-setting.ts`
- `apps/social-mobile/src/features/publish-setting/{use-publish-setting.ts,publish-setting-card.tsx}`
- `apps/social-mobile/src/app/accounts/[id].tsx`（カード1行追加）
- `apps/social-mobile/tests/publish-setting.test.mjs`

### tests
- Edge: `deno test` 37件 pass（logic 24 / http 13）、`deno check` pass。未認証、不存在、membershipなし、viewer/member、owner/admin、cross-brand、ON阻害13パターン、Vault平文なし・レスポンスに秘密なし、劣化時もOFF可、stale、読み取り〜書き込み間の競合、同一状態・二重送信、変更が publish_enabled のみ・他の呼び出しなし、X通信なし、ログに秘密なし、method/content-type/入力検証、エラーコードが有限集合。
- social-mobile: `npm test` 134件 pass（新規21）、`src/domain/*.test.ts` pass、`tsc --noEmit` pass、`expo lint` exit 0。UI: 状態の正直な表示、ON確認必須、キャンセルで送信なし、OFF文言に削除表現なし、実行中の二重送信なし、成功で再読込、staleで再読込、未接続はON不可（説明表示）、劣化中のONでもOFF可、正確なaccount id、G3ファイルをimportしない。
- `git diff --check` 問題なし、秘密スキャン問題なし。

### local verification
- TASK の確認項目 1〜8（ON押下→確認表示／キャンセルで変化なし／確認→再読込でON／ON→OFF／authorization_pending はON不可／staleの安全表示／投稿作成なし／X認証・失効なし）は、実コードのhook・カードをtranspileしたハーネス＋偽Supabaseで再現。
- **Simulator・実機での確認は未実施**: 関数が未deployで、mockプレビューは仕様上スイッチを出さない（`mock_preview` では ON/OFF ともに不可）ため、起動しても実動作を確認できない。deploy後に、G4専用の使い捨てアカウントでの確認が必要。

### proof G3 consultation files untouched
PR #76 の変更10ファイルに `consult.tsx`、`content-settings*`、`content-settings-repository.ts`、G3の相談Edge Function/テストは含まれない（`git diff origin/main HEAD --name-only` を consult／content-settings／migrations／.agent で絞って該当なし）。クライアントのコードは `approvalMode`・`consult`・`content-settings` を参照しないことをテストで固定。PR #70・共通アカウント作業にも触れていない。

### 固定項目
- DB migration = **none**（RLS・grant 変更もなし）
- production mutation = **0**（deploy・本番トグル・Vault/Auth/Cron変更・DB適用いずれもなし）
- real X operations = **0**（X投稿・認証・失効なし）

### commit / push / PR
- branch `g4/social-mobile-publish-toggle-v1-20261002`、commit `a59a89e9`（origin/main 直上の1コミット）、push済み、PR #76 作成済み（CI は作成時点で pending 5・failing 0）。merge・deploy はしていない。

### remaining issues
1. **ON は brand の `publish_mode='live'` が前提**。多くの一般ワークスペースでは当面 ON できない（UIは理由を安全な文言で表示）。`live` にする運用手順は本TASK外。
2. brand の `is_active`／`publish_mode` は書き込み前の読み取りで確認（接続条件のみ書き込みWHEREに含む）。わずかな TOCTOU があるが、実行時のパイプラインが brand を再確認するため、誤投稿には直結しない。Codex に判断してほしい点。
3. クライアントは自分の role を知らない。viewer/member は押した後に 403 の説明が出る（事前に非表示にしていない）。
4. 実機・Simulator 確認は deploy 後。
5. モデルは Sonnet 5.5（推奨は Opus5.5（高））。

### safety checks
上記 mutation boundary のとおり。秘密（JWT・publishable key・service key・Vault参照）はコード・テスト・ログ・レポートに含めていない。`supabase/.temp/` は既存の未追跡で、コミットしていない。

### next recommendation
K4 で Codex **Sol（高）** による集中レビュー（認可境界、条件付きPATCHの網羅、brand条件のTOCTOU、`publish_mode` の運用前提）を割り当て。Codex 承認後に操作者が deploy（verify_jwt ON、byte確認）し、使い捨てアカウントで実機確認。merge/deploy は Claude の自己レビューだけでは行わない。


## K4 decision — PR #76 source candidate

- verdict: **PASS to focused Codex review; merge/deploy HOLD**.
- accepted review target: PR #76 exact head `a59a89e9c585fb6e780e1af2ecc898c830f5524e`.
- PR is open/mergeable; Netlify and Vercel checks green.
- fresh main is 5 commits ahead of the PR base with no overlap across the 10 PR files.
- source/tests remain within posting-toggle boundary; no G3 consultation files, migration/RLS/grant, X API, scheduler or common-account changes.
- production mutation 0 / real X operations 0.
- because this is a posting-permission/security boundary, K4 does not merge.
- H1 assigned focused review `x-social-mobile-pr76-publish-toggle-review-20261002`, recommended **Sol（高）**.
- next_owner: codex; wait for C1.


## Report — x-social-mobile-publish-toggle-transactional-corrective-20261003 (2026-10-03)

- task_id: x-social-mobile-publish-toggle-transactional-corrective-20261003
- result: **PASS（source・自動テスト・使い捨てDBでの実証）／本番適用・deploy・実機確認は未実施**。PR [#76](https://github.com/anohi-memories/kabumori/pull/76) を是正（未merge、source candidate）。
- model_used: Opus 5.5（TASK推奨は Opus5.5（極高）。セッションのモデルは Opus 5.5。推論強度の設定値は自分では確認できない）
- old PR head（H1がFAILとした head、履歴に保持）: `a59a89e9c585fb6e780e1af2ecc898c830f5524e`
- new exact head: `fe1e846e59c69b591d29c6d21fc23c7b702d19cd`（通常push。force-pushなし）

### architecture chosen
TASKの「Preferred direction」どおり。判断と書き込みを**DBの1トランザクション**へ移した。

- 新migration `supabase/migrations/20261003090000_social_mobile_publish_permission_boundary.sql`（関数2つのみ。テーブル・policy・trigger・テーブル権限の変更なし。既存関数の `create or replace` なし）
  - `public.set_social_account_publish_enabled(p_social_account_id text, p_desired_enabled boolean, p_expected_current_enabled boolean) returns jsonb` — 呼び出し元本人のJWTで実行。`auth.uid()` が本人。`authenticated` のみ実行可（`service_role`・`anon`・PUBLIC は不可）。user id／brand id の引数なし。
  - `public.assert_x_publish_permission_for_legacy_post(uuid, text, text) returns text` — X送信直前の権限確認。`service_role` のみ。読み取り専用。
- Edge `social-mobile-publish-setting`: **service role key を持たない**（環境変数からも読まない）。Auth確認（`/auth/v1/user`）＋上記RPCを呼び出し元JWTで1回呼ぶだけ。テーブルへのアクセス・判断後の再読込なし。
- x-test-post `vault_account_auth.ts`: Vault連携アカウントのX送信（初回・401後の再送1回）の**直前に毎回**、権限確認RPCを呼ぶ。
- 詳細・図・ロールアウト順・本番preflight用クエリ: `supabase/tests/social_mobile_publish_permission.md`

SECURITY DEFINER の理由: `authenticated` は `social_accounts` に UPDATE 権限がなく、付与してはいけない（TASK指示）。この関数は1行の1列だけを書き、権限の入力はすべて `auth.uid()` とロックした行から得る。`search_path = ''`、全リレーションをスキーマ修飾。公式ドキュメント（Supabase「Database Functions」）で、definer関数は search_path 固定が必須・空が推奨、関数は既定で誰でも実行可能なので明示revokeが必要、を確認した。

### original H1 findings R1–R5 disposition
- **R1（membershipが古いスナップショット）: 解消**。呼び出し元のmembership行を、書き込みと同じトランザクション内で `FOR SHARE` ロックして読む。削除・降格は「先にcommit済みで見える」か「このトランザクションのcommitまで待つ」のどちらか。ON・OFF両方。Edgeには特権の書き込みが無いので、古い認可を使い回す経路そのものが無い。
- **R2（brandのTOCTOU／実行時ガード）: 解消（対象経路を限定して明示）**。(a) brand行を `FOR SHARE` でロックしてONを判断・書き込み（brandが無効化済みならON不可、無効化は切替のcommitを待つ）。(b) Vault連携アカウントのX送信直前に、単一SQL文（＝単一スナップショット）でbrand active/live・アカウントON・verified・削除中でない等を確認。dispatcherが生成前に読んだ古いcontextでは送信できない。「実行時ガードがあるので無害」という前回の私の主張は誤りだった。
- **R3（再読込で他テナント状態が漏れる）: 解消**。再読込を廃止。移動・削除・権限喪失はすべて同じ `not_found`（状態を含まない）。`stale`（現在値つき）と `blocked`（理由つき）は、ロック下で現在のowner/adminと確認できた相手にだけ返す。
- **R4（ON判定の不一致）: 解消**。ロックした行に対する1つの判定に統一。`nullif(btrim(platform_user_id),'')`、`identity_verified`、`verified_at`、参照2つが存在・相違・他アカウントと非共有（実行時の `x_legacy_post_account` と同じ規則）、`last_connection_error_code` なし、refresh状態が `uncertain`/`reauth_required` でない。各ケースで「ONが拒否する状態は実行時も拒否する」ことをテスト。ONの意味は「許可が有効で構造的に適格」であり「次のX送信の成功保証ではない」（Vaultの中身は読まない）と文書・UI文言に明記。
- **R5（確認が固定されていない）: 解消**。アクションを依頼時点の「アカウントid・期待状態・ログインユーザー」に固定。画面が一致しなくなったら確認を破棄（元に戻っても復活しない）。送信時にも最新の確定描画と照合するため、古い描画のボタンを押しても0リクエスト。画面側も `key={account.id}`。

低リスク指摘: 重複JSONキー・エスケープを拒否（last-winsにしない）／本文は**読み取り中にバイト数**（512）で打ち切り／OFF文言から「いつでもONに戻せます」を削除し条件付きに、「送信が始まっている投稿は取り消せない」を明記／テストのlint指摘（require-await 5件）解消。

### transaction / lock / authorization model
- 順序（アカウント削除の関数と同じ向き: brand → memberships → accounts）:
  1. `LOCK TABLE social_accounts IN ROW EXCLUSIVE MODE`（行ロックより先）
  2. brand行 `FOR SHARE`
  3. 呼び出し元のmembership行 `FOR SHARE`
  4. アカウント行 `FOR UPDATE`
- 1を先に取る理由: refreshのcommit関数は `SHARE ROW EXCLUSIVE`（テーブル）→ アカウント行の順。行ロック後にUPDATEでテーブルロックを取る（逆順）と、単回使用トークンを既に回転させたcommitとdeadlockし得る。変異テストで、この行を外すと実際にdeadlockが起きることを確認。
- brandのメンバーでない呼び出し元は、ロックを取る前の確認で `not_found`。他テナントの行のロックを待たない・取らない（テストあり）。owner/adminでないメンバーは書き込みロックを取らない。
- 待ちは有界（`lock_timeout = 3s`）。timeout・deadlock・削除ガードは `busy`（書き込みなし）。
- `READ COMMITTED` 必須（Data APIの既定）。それ以外は拒否。

### runtime fresh pre-send guard and exact in-flight semantics
- 対象: `VaultAccountXAuth.send`（現在配線されている唯一のアカウント単位の送信経路＝AI Lab `brand_post`。将来のVault連携アカウントも同じ経路）。`request()` の直前の文が必ず権限確認であることをソース固定テストで担保。
- **in-flightの定義**: 権限確認が `authorized` を返した時点から「送信中」。確認のスナップショットより前にcommitされたOFF／brand無効化は送信を止める。後にcommitされたものは、すでにXへ向かったリクエストを取り消さない。同じdispatch内の次のリクエスト（401後の再送、2件目）は新しい確認なしには始まらない。
- fail closed: 確認に到達できない・関数が無い（migration未適用）・想定外の応答は `X_PUBLISH_PERMISSION_UNAVAILABLE` で送信しない。
- `refreshing` は権限の拒否にしない（「他のrefresh進行中で拒否されたproactive refreshは現在のトークンを使い続ける」という既存の設計を維持）。
- **対象外（主張しない）**: かぶモリの従来経路（env／`oauth_token_store`）、`important-news-monitor`（`publish_enabled` を見ていないことをgrepで確認）、未配線のv2 dispatcher、未mergeのPR #41。いずれも未変更。

### ON / OFF semantics
- ON: 上記R4の条件＋現在のowner/admin＋期待状態一致＋brand active/live＋削除中でない。refresh lease保持中は `busy`。
- OFF: 現在のowner/admin・正確なアカウント・期待状態のみ必要。接続失敗・参照欠落・brand無効・refresh状態ブロックでも可能。`publish_enabled` 以外は何も変えない（失効・Vault・投稿・ログ・履歴・Authに副作用なし。全テーブルのハッシュ比較でテスト）。`updated_at` は変更しない。
- アカウント削除中は ON・OFF とも `busy`（削除側が投稿中でないことを要求し、全writerをガードが拒否するため）。

### tenant-safe error behavior
存在しないid／非メンバー／移動済み／削除済み → 同一の `404 ACCOUNT_NOT_FOUND`（状態なし）。member/viewer → `403`（どの要求でも同一、状態なし）。`current_enabled` は現在のowner/adminにのみ。DB・バックエンドの文言は一切返さない（未知の応答は `503 PUBLISH_SETTING_UNAVAILABLE`）。

### migration / RPC changed files
- 追加: `supabase/migrations/20261003090000_social_mobile_publish_permission_boundary.sql`
- 変更: `supabase/functions/social-mobile-publish-setting/{index,logic,http,logic_test,http_test}.ts`、追加 `migration_test.ts`
- 変更: `supabase/functions/x-test-post/vault_account_auth.ts`、`vault_account_auth_test.ts`
- 追加: `supabase/tests/social_mobile_publish_permission{.md,_fixture.sql,_behavior.sql,_run.sh,_mutations.sh,_postgrest_shim.ts,_e2e_test.ts}`
- 変更: `supabase/tests/migration_source_invariants_test.ts`（予約versionに1行追加）
- 変更: `apps/social-mobile/src/domain/publish-setting.ts`、`src/features/publish-setting/{use-publish-setting.ts,publish-setting-card.tsx}`、`src/app/accounts/[id].tsx`（`key`追加のみ）、`tests/publish-setting.test.mjs`
- 計22ファイル（PR全体）。`x-test-post/index.ts` は未変更。G3の相談・content-settings、H2のcontent-settings schema、共通アカウント、`.agent/` は差分に含まれない（`git diff --name-only origin/main...HEAD` をgrepして該当なし）。

### client confirmation pinning
上記R5のとおり。回帰テスト: A確認→Bへ切替（0リクエスト、Aへ戻しても確認は復活しない）／再描画前に古いボタンを押す／preview化／状態変化（すでにON）／適格性喪失／別ユーザー・サインアウト／キャンセル／確認ボタン連打／OFFボタンの古い描画／結果が別アカウントのカードに表示されない。フック側・カード側の防御をそれぞれ外す変異で、対応するテストが落ちることを確認。

### tests / adversarial interleavings
すべてローカル・偽データ。実X API呼び出しなし。

- **使い捨てPostgreSQL 17**（本物のmigration＝onboarding／reconnect／refresh core／rollout／アカウント削除 を積んだ上に候補を適用、非superuser所有者）: `social_mobile_publish_permission_run.sh` → APPLY / BEHAVIOR / RACE / E2E / CLEANUP すべてPASS。
  - 並行: membership削除・降格が書き込み前に起きる（ON・OFF）／切替が判断を保持中は membership削除・降格・brand無効化・publish_mode変更・アカウント移動がすべてブロックされる／brand無効化→ON拒否／**H1のR2スケジュール**（ON未commit→dispatcherがbrand読取→brand無効化は待たされる→ONcommit→dispatcherがアカウント読取→送信前確認が `BRAND_DISABLED`）／他brandへの移動・自分の別brandへの移動・アカウント削除／同一ON二重・ON対OFF／未commitのOFFは送信確認に影響せずcommit後は拒否／アカウント削除と前後どちらの順でも／refresh commit型トランザクションとのロック順（deadlockなし）／有界待ち／非メンバーは他テナントのロックを待たない。
  - E2E（`PUB_E2E=1`）: **実際のEdgeハンドラ・実際の `loadBrandContext`＋`assertBrandPublishAllowed`・実際の送信アダプタ**をHTTP経由で本物のSQLへ接続（Xのみ偽）。H1のR2スケジュールで「キャッシュ済みガードは通るが送信前確認が拒否し送信0件」を確認。5シナリオPASS。
- **変異テスト** `social_mobile_publish_permission_mutations.sh`: 候補SQLを1か所ずつ壊した30件を**30/30検出**（membershipロックなし、brandロックなし、brand再確認なし、trimなし、CAS なし、テーブルロック順、権限付与の緩和、search_path など）。
- Edge（型チェックあり）: publish-setting 39件（logic 15／http 14／migration契約 10）、`vault_account_auth_test` 29件（新規9件。送信前確認を外すと既存1件＋新規8件が落ちることを確認）。x-test-post＋_shared＋publish-setting 全体 925件PASS（`--no-check`）。変更ファイルの `deno check`・`deno lint` PASS。`x-test-post/index.ts` の型エラー6件は既存のまま（私の変更ファイルには無い）。
- 既存テストの変更1件: 「2回目の401後は再認可」テストで、同一attempt内の後続リクエストが**Xへ送られなくなった**（`X_ACCOUNT_NOT_VERIFIED` で事前拒否）ため期待値を更新。
- アプリ: `npm test` 145件（publish-setting 32件）、domain 22件、`tsc --noEmit`、`expo lint` すべてPASS。
- `git diff --check`・秘密情報スキャン: 問題なし。

### production read / mutation
- production mutation = **0**（migration適用・RPC作成・Edge deploy・トグル・行変更・Vault/Auth/Cronなし）
- production read = **0**。このworktreeはSupabase CLIが未link（共有checkoutには触れない）で、本番カタログの読み取りはしていない。**本番のトリガー一覧・権限は未確認**。適用前に操作者が流す読み取り専用クエリ4本をdocに記載（特に `social_accounts` に汎用の `updated_at` トリガーが無いこと）。
- real X operations = **0**

### commit / push / PR state
- branch `g4/social-mobile-publish-toggle-v1-20261002`、commit `fe1e846e`（`a59a89e9` の上に1コミット）、push済み、PR #76 のタイトル・説明を更新。作成時点でCIは passing 2／failing 0／pending 1。mergeable。merge・deployはしていない。

### remaining risks
1. **適用順**: migrationを先に適用してからx-test-postをdeployすること。逆順だとAI Lab（Vault連携）の投稿がすべて `X_PUBLISH_PERMISSION_UNAVAILABLE` で失敗する（安全側）。かぶモリ本体の投稿経路は影響なし。AI Labの投稿は1件につきRPCが1回増える。
2. **かぶモリ型アカウント（Vault参照なし）**: brandのowner/adminがこのスイッチでOFFにでき、ONには戻せない（`CREDENTIALS_MISSING`）。従来経路ではOFFは次回dispatchのcontext読込で効く。本番にkabumori brandのmembershipがあるかは未確認。スイッチの対象をVault連携アカウントに限定すべきかはK4/Codexの判断を仰ぎたい。
3. **OFFとrefreshの競合**（既存仕様）: refreshの `begin`〜`commit` の間（約1秒）にOFFが入ると、commitがアカウント変更とみなし `uncertain`（再接続まで停止）になる。OFFをrefresh待ちにすると古いleaseでOFF不能になるため、OFF優先とした。
4. 確認とXリクエストの間（ミリ秒）のOFFは取り消せない（上記in-flight定義のとおり）。DBロックをHTTP越しに保持できないため。
5. PostgREST経由の実挙動はローカルのshimで代用。本番Data API・JWT・verify_jwtでの確認、実機確認は未実施（deploy後）。
6. 共有参照チェックは他アカウント行をロックせずに読む（構造チェック。実行時に再確認される）。

### safety checks / 作業中の出来事
- 他slotのworktree・branch・dev server・未コミット変更には触れていない。H2のcontent-settings migration、G3のファイルも未変更。
- 「Supabase skillを読む」: このセッションに該当skillが無かった（検索しても0件）。代わりに公式ドキュメントを確認した。
- 既存migration 3ファイルの一部を読むBashコマンドが自動モードに1回拒否された。再試行・回避はせず、すでに読んだ内容と、ローカルDBへ実ファイルを適用した結果で進めた。
- **ディスク満杯**: 最終の変異テスト再実行中にMacのディスクが100%になり、テスト用PostgreSQLが停止した。私のセッション用一時フォルダにあった PR #65 検証用のiOSビルド一式（`g4-sim-e2e`、4.0GB、使用中プロセスなしを確認）を削除して復旧し、全実証を再実行してPASSを確認した。**ディスクは現在も96%使用（空き約9GB）**なので、操作者側での整理を推奨。テスト用PostgreSQLと一時DBは停止・削除済み。

### next recommendation
K4でCodex **Sol（極高）** の独立再レビューを割り当て。重点: ロック順と待ち、SECURITY DEFINER関数のACL、`not_found` の一様性、送信前確認の対象範囲（かぶモリ従来経路を含めるか）、かぶモリ型アカウントのOFF可否、適用順。承認後に、操作者が preflight → migration単独適用 → read-back → x-test-post deploy → publish-setting deploy（verify_jwt ON）の順で実施。merge・適用・deployはClaudeの自己レビューだけでは行わない。
