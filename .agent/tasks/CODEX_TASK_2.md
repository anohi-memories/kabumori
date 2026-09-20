# Codex Task 2

- task_id: social-mobile-app-phase11-x-portal-and-real-oauth-qa-20260920
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: Phase 10でproduction backend rollout済みのgeneral-user X OAuthを、X Developer Portal設定の確認・手動反映準備から、専用non-admin QA Auth user + dedicated test X accountによる1回のreal OAuth round-trip QAまで安全に進める。real X postはまだ行わない。

## Approved basis

Phase 10 Final C2: PASS。

production確認済み:
- migration `social_mobile_x_oauth_onboarding` applied
- production history version `20260919222101`
- `x-oauth-connect-user` v1 ACTIVE
- `verify_jwt=false` with custom in-function Supabase Auth validation
- runtime source byte-equal to `origin/main`
- unauthenticated POST -> 401
- invalid method -> 405
- existing admin `x-oauth-connect` v20 unchanged
- existing production data rows unchanged
- general-user OAuth state rows = 0
- X Developer Portal unchanged
- real X OAuth / Vault token write / X API post = 0

## Model policy

- Start and proceed with **Luna**.
- Do not escalate to Sol merely because this is production.
- Escalate only if a concrete blocker appears involving OAuth protocol semantics, X permission mismatch, unexpected production DB/Vault behavior, or a security-sensitive discrepancy that Luna cannot resolve confidently.
- If escalation is needed, stop and report the exact blocker first.

## Scope A — fresh preflight

Before any user-impacting action:
1. read `.agent/ORCHESTRATION.md`
2. read `.agent/CURRENT_STATE.md`
3. read this TASK and `.agent/CODEX_REPORT_2.md`
4. inspect other 3 slots for conflicts
5. fresh `origin/main`
6. production read-only:
   - `x-oauth-connect-user` v1 ACTIVE
   - 3 general-user OAuth RPCs present
   - brand_memberships current count
   - user OAuth states current count
   - existing admin X accounts unchanged
7. verify mobile deep-link candidate remains exactly `kabumori-social://oauth-callback`
8. verify requested scopes remain exactly:
   - `tweet.read`
   - `users.read`
   - `tweet.write`
   - `media.write`
   - `offline.access`

STOP if source or production drift is found.

## Scope B — X Developer Portal manual gate

Do not claim browser automation.

Determine and document the exact manual settings required in the X Developer Portal for the current client:
- OAuth 2.0 enabled
- callback / redirect URI exactly:
  `kabumori-social://oauth-callback`
- app type / OAuth mode compatible with Authorization Code + PKCE
- app permissions sufficient for read + write + media upload + offline refresh
- website/app metadata only if X requires it to save settings

Do not expose or request client secret in chat/report.

If Portal cannot be changed by an approved connected tool:
- STOP at a concise user action checklist.
- Do not invent that it was changed.
- After the user confirms the exact Portal settings, resume this same H2.

## Scope C — dedicated QA identity setup

Real OAuth QA must NOT use the existing admin Auth identity or the production AI Lab/kabumori X accounts.

Required:
- one dedicated non-admin Supabase Auth QA user through normal Auth lifecycle
- confirm absent from `public.admin_users`
- no pre-existing owner membership required; begin RPC should create the user workspace/owner membership
- one dedicated test X account that is safe to bind for QA

Do not create Auth users by direct SQL.
Do not reuse the existing admin X accounts.

If a dedicated test X account is not available, STOP and tell the user exactly what is needed.

## Scope D — one real OAuth round-trip

Only after B and C are satisfied.

Run exactly one real general-user OAuth connection through the production mobile flow or equivalent approved client path:
1. sign in as the dedicated non-admin QA Auth user
2. tap/start X account connection
3. confirm X consent shows the expected permissions
4. complete redirect back to `kabumori-social://oauth-callback`
5. callback completes successfully
6. verify UI reports connected/verified handle

Expected production writes for this one QA only:
- one deterministic general-user brand/workspace if first connection
- one owner brand_membership for QA user
- one X social_account
- one consumed OAuth state
- Vault access/refresh token secret(s)
- `publish_enabled=false`

Forbidden:
- real X post
- media upload
- setting `publish_enabled=true`
- touching existing AI Lab/kabumori/mio accounts
- altering existing admin OAuth
- Cron
- app-wide production data source switch
- content-generation enablement

## Scope E — postflight read-only proof

Verify:
- QA user is non-admin
- QA user owns only its deterministic workspace
- bound X handle/platform_user_id match the dedicated test X account
- connection_status = identity_verified
- publish_enabled = false
- OAuth state consumed exactly once
- token values are never selected/logged/reported
- Vault secret IDs may be counted/presence-checked only; never reveal secret contents
- existing brands/social_accounts/admin OAuth rows unchanged
- cross-tenant visibility remains denied for the QA user
- replay attempt is not performed unless a safe non-token-changing method exists; rely on prior tested replay proof otherwise

## Cleanup decision

Do NOT automatically delete the QA Auth user/workspace/X binding/Vault secrets after a successful real round-trip.

At completion, report two choices:
- retain as dedicated QA fixture for future regression testing
- clean up in a separately authorized rollback task

No automatic cleanup in this Phase.

## Tests/checks

Before/after QA:
- relevant OAuth unit tests
- onboarding/deep-link tests
- typecheck/lint
- git diff --check
- no source changes unless a real defect is discovered

If a real defect is discovered:
- do not patch production ad hoc
- stop, create a source fix on fresh main, test it, and return for C2 before redeploying.

Latest continuation update (2026-09-20): the iOS app failed closed because Expo did not inline Supabase public configuration read through generic `process.env` indexing. The one-file fix passed typecheck, lint, focused OAuth tests, iOS export/bundle verification, Release build/install, and `git diff --check`. Source plus H2 TASK/REPORT were pushed to `origin/main` in commit `56506847613b47ea882ad48211649b587a016fbd`; no deployment followed. The real OAuth round-trip stopped before QA login, consent, OAuth-state creation, or production writes. C2 must review this source fix before QA resumes. Keep `status: review_required`, `next_owner: chatgpt`.

## Completion / C2

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- update `.agent/CODEX_REPORT_2.md` with:
  1. Portal configuration status
  2. QA Auth setup status
  3. dedicated test X account readiness
  4. real OAuth round-trip result
  5. exact expected production writes observed
  6. Vault/token handling proof without secret values
  7. tenant isolation postflight
  8. existing admin OAuth/accounts unchanged
  9. no X post/media upload
  10. retain-vs-cleanup recommendation
- push control/report changes only if needed
- STOP for C2


## C2 review — 2026-09-20 (mobile Supabase env inlining fix)

**PASS for the one-file client fix; Phase 11 overall remains incomplete and must resume.**

Accepted:
- Root cause is credible and matches Expo's static \`EXPO_PUBLIC_*\` inlining requirement: dynamic/default \`process.env\` object access was not preserved into the native bundle, while direct property references are.
- Change is limited to \`apps/social-mobile/src/lib/supabase.ts\`.
- The default runtime path now reads:
  - \`process.env.EXPO_PUBLIC_SUPABASE_URL\`
  - \`process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY\`
  through direct static references.
- Injected test environments remain supported because \`getSupabaseConfig(env)\` and \`createSupabaseClient(env)\` still accept explicit env objects.
- No service-role/client secret path was introduced; existing publishable-key guard remains.
- Auth/RLS/OAuth semantics are unchanged by this fix.
- Verification accepted:
  - typecheck PASS
  - lint PASS
  - OAuth/onboarding focused tests 27/27 PASS
  - iOS export PASS
  - bundle verification confirmed configured public values were embedded
  - Release iOS build/install PASS
  - login screen rendered without the missing-config banner
  - git diff --check PASS
- Commit \`56506847613b47ea882ad48211649b587a016fbd\` contains only the expected source + H2 control/report changes.
- No production DB/Vault/X/API/deploy mutation occurred during this fix.

Decision:
- source fix is approved.
- Resume the same Phase 11 H2 from the QA login / real OAuth gate.
- Keep using **Luna**.
- User must enter QA credentials directly; do not request/store passwords in chat/report.
- Immediately before X consent, confirm the dedicated test X account is the intended account.
- Run exactly one real OAuth round-trip, then perform the required read-only DB/Vault/tenant-isolation postflight.
- Still forbidden: real X post, media upload, \`publish_enabled=true\`, changes to existing production X accounts/admin OAuth, Cron, or app-wide data-source switch.
- On completion return \`review_required / next_owner: chatgpt\` for final C2.
