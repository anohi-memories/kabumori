# Codex Task 2

- task_id: social-mobile-app-phase9-codex-handoff-integration-20260919
- owner: codex
- slot: codex-2
- status: in_progress
- next_owner: codex
- priority: high
- recommended_model: Sol High
- purpose: K2 PASS済みのgeneral-user X OAuth candidateをClaude slot 2から引き継ぎ、fresh mainへ安全に統合し、production rollout前の実行可能性証明とmobile onboarding UI実装まで進める。production apply/deployはC2承認前に行わない。

## Handoff basis

Claude Phase 9 reviewed branch:
- branch: `social-mobile-x-oauth-onboarding-phase9-20260919`
- reviewed commits: `db79f02` + blocker fix `a58c01d`
- final K2: PASS
- production mutation/deploy: 0

重要:
- branchはK2時点で main より **2 commits ahead / 10 commits behind**。
- blind merge/rebaseは禁止。
- fresh `origin/main` からisolated worktree/branchを作り、Phase 9の5ファイル差分だけを明示的に統合する。
- 他workstreamの変更を巻き戻さない。

## Reviewed architecture — do not regress

- App login boundary = Supabase Auth。
- X OAuth = signed-in userが自分の投稿用Xアカウントを接続する機能。Supabase Auth provider化しない。
- existing admin `x-oauth-connect` は触らない。
- general-user flow = new `x-oauth-connect-user` + new RPCs。
- DB ownershipは `auth.uid()` 正本。user_id/brand_idをclient値で信用しない。
- service_roleをExpo/mobileへ含めない。
- OAuth state contract:
  - client raw random state
  - start Function hashes once for DB storage
  - X receives raw state
  - callback receives raw state
  - server hashes once for lookup
- consume RPCはread-only。
- final complete RPCのみがstateをatomic consumeし、Vault/account writeと同じDB transaction内で確定。
- successful replay denied / concurrent duplicate completion one success。
- publish_enabled remains false after OAuth。
- duplicate X platform_user_id is DB-unique。
- token is never returned to mobile response。

## Scope A — safe integration to current main

Reviewed candidate files only:
- `supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql`
- `supabase/functions/x-oauth-connect-user/index.ts`
- `supabase/functions/x-oauth-connect-user/oauth_logic.ts`
- `supabase/functions/x-oauth-connect-user/oauth_logic_test.ts`
- `apps/social-mobile/docs/phase9-x-oauth-onboarding.md`

Requirements:
1. fresh origin/main
2. inspect drift since feature branch merge-base
3. integrate reviewed semantics without overwriting newer main changes
4. preserve migration-history warning: no blind db push / no repair/reconcile
5. commit/push to main only after tests pass

## Scope B — executable migration proof

Before any production apply:
- run migration against disposable/local PostgreSQL/Supabase only
- verify current main migration chain compatibility
- verify create/update/rollback behavior
- verify grants: anon/public denied, authenticated allowed only for new user RPCs
- verify auth.uid() ownership isolation with at least two test users/brands
- verify cross-user state consume/complete denied
- verify duplicate platform_user_id collision
- verify state retry after simulated completion failure via transaction rollback
- verify successful replay denied
- verify concurrent completion single-success semantics
- cleanup all local fixtures

No production DB mutation.

## Scope C — social-mobile UI / deep-link candidate

Implement the minimum app flow:
- Accounts screen: 「Xアカウントを接続」
- generate cryptographically random raw state + PKCE verifier/challenge locally
- call new start Function with user JWT
- open X authorization browser
- deep-link return handler
- verify returned state matches locally-held raw state before callback call
- send code/state/verifier/redirect_uri to callback endpoint
- connecting / connected / cancelled / retryable error / terminal error states
- show verified handle after success
- no token display/log/storage in app
- no service_role/client_secret in bundle
- preserve fail-closed data-source behavior
- reconnect may reuse begin flow
- revoke/disconnect remains out of scope unless required by existing UX

If deep-link scheme/app config requires a concrete value, use one consistent candidate and document exact X Developer Portal redirect URI needed. Do not change X Developer Portal yet.

## Tests

At minimum:
- OAuth function 18/18 or more
- full Deno regression
- migration disposable DB proof
- social-mobile typecheck
- lint
- Expo Web export / route resolution
- deep-link/state matching tests
- cancel/error/retry UI path tests where practical
- secret grep/static check: no X client secret/service_role/token persistence in app
- git diff --check

## Production boundary

C2前は禁止:
- migration production apply
- Edge Function production deploy
- X Developer Portal redirect URI mutation
- Vault production write/delete/rotate
- existing social_accounts/brands/memberships mutation
- existing admin x-oauth-connect mutation
- RLS/admin policy/grant変更 beyond reviewed candidate in source
- Cron
- X API real post
- Push/AI/Storage/billing
- production default data source switch
- blind db push / migration history repair

read-only production preflight metadata only allowed.

## Completion / C2

完了時:
- status -> `review_required`
- next_owner -> `chatgpt`
- `.agent/CODEX_REPORT_2.md` に:
  1. fresh-main integration result
  2. exact files/commit
  3. disposable migration proof
  4. mobile UI/deep-link implementation
  5. tests
  6. security checks
  7. production mutation = 0
  8. exact manual X Developer Portal step still pending
  9. recommended production rollout sequence after C2
- push前fresh origin/main確認
- STOPしてC2待ち
