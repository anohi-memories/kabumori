# Claude Task 2

- task_id: social-mobile-app-phase9-x-oauth-onboarding-20260919
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus 5
- purpose: Phase 8で確立した一般ユーザーAuth + tenant RLS境界を壊さず、social-mobileのX OAuth onboardingを設計・実装候補まで進める。既存のproduction X投稿基盤・Vault・multi-brand運用を再利用できる部分は再利用し、ユーザーごとのworkspace/account ownershipを安全に確立する。

## Approved basis

Phase 8 final K2 PASS:
- real non-admin social-mobile sign-in QA PASS。
- visible tenant = ai_salaryman_lab only / kabumori=0 / mio=0。
- social-mobileは public.profiles 不要。
- tenant source-of-truth = auth.users + brand_memberships。
- brand_memberships test fixtures cleanup完了。
- production default EXPO_PUBLIC_DATA_SOURCE=mock のまま。
- admin policy / RLS / schema / grantsは安定しており、このPhaseでは既存境界を弱めない。

User instruction:
- 2026-09-19「すすめて」。
- Codex slot 2は本日夜まで休止中。social-mobile workstreamはClaude slot 2で継続。
- G1はmarket-report自然shadow待ちでidle。H1 done。競合しない。

## Goal

一般ユーザーがsocial-mobileで以下のonboardingを安全に完了できるcandidateを作る。

1. social-mobileへ通常Authでsign-in
2. Xアカウント連携を開始
3. X OAuth callbackを安全に処理
4. X account identityを取得
5. user用workspace/brandを作成または既存membershipへ関連付け
6. brand_membershipsにowner membershipを確立
7. social_accountsをそのbrandに紐付け
8. refresh/access token等のsecretはVault/サーバー側のみ
9. mobile bundle/clientにはsecret/service_roleを渡さない
10. onboarding完了後、Accounts画面で接続状態を確認できる

## Critical architecture question — investigate first

「Xでアプリへログインする」と「ログイン済みユーザーがX投稿アカウントを接続する」は別物。

Phase Aで必ずcurrent codeをauditして、今回の正本を明確にする:
- social-mobile app authはSupabase Authを維持するか。
- X OAuthは「SNSアカウント接続」に限定するか。
- X OAuth identityをSupabase Auth identity providerとしても使う必要があるか。
- 既存 `x-oauth-connect` はどの用途・account model・callback state modelで実装されているか。
- existing production AI Lab / kabumori / mio account接続を壊さず一般ユーザーへ拡張可能か。

原則:
- 既存Phase 8のSupabase Auth + membership境界を優先。
- 特段の必然性が無ければ、X OAuthをSupabase Authそのものへ混ぜず「接続アカウント」として扱う案を第一候補にする。
- ただしcurrent implementation/requirementsを見て最適案をReportする。

## Mandatory startup

開始前に必ず:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/tasks/CODEX_TASK_2.md`
5. H1/G1 task
6. fresh `origin/main`
7. existing X OAuth/Vault/social_accounts schema + function audit

既存未コミット変更は他workstream所有。

## Phase A — read-only inventory

確認対象:
- `supabase/functions/x-oauth-connect/**`
- X OAuth callback/authorize URL generation
- PKCE/state/nonce handling
- redirect URI allowlist
- token exchange/refresh
- Vault secret storage/read path
- `social_accounts`
- `brands`
- `brand_memberships`
- account connection_status/publish_enabled
- existing admin/mobile account UI
- relevant migrations/RPCs
- existing production OAuth clients/config metadata where read-onlyで安全に見られる範囲
- apps/social-mobile Accounts list/detail/Settings/Auth code

Reportで:
- existing flow
- reusable pieces
- general-user gap
- ownership gap
- security gap
- migration/RPC/API/UI candidate

## Phase B — target onboarding design

最低要件:

### Auth / ownership
- authenticated userだけconnect開始可能。
- callbackでstateをuser/session/workspace intentへ安全にbinding。
- callback queryだけを信用してuser_id/brand_idを決めない。
- tenant ownershipはDB側で検証。
- userが他人のbrand/social_accountをconnect/updateできない。
- admin override既存経路は壊さない。

### Workspace creation
新規userにmembershipが無い場合のonboarding pathを明確化:
- user workspace/brandをいつ作るか。
- brand id/name/code_profile_key等のrequired columnsをどう生成するか。
- owner membershipをどのtrusted server-side pathでinsertするか。
- duplicate/retry/idempotency。
- partially completed OAuthのrollback/retry。

勝手なclient-side INSERTでRLSを緩めない。
必要ならSECURITY DEFINER RPC/Edge Function candidateを設計するが、最小権限・auth.uid() binding必須。

### X account connection
- X platform user id/handleをOAuth結果からserver-side取得。
- duplicate X accountを複数user/brandへ誤接続しない。
- existing production accountとの衝突時fail-closed。
- connection_status transitionを明示。
- publish_enabledはOAuth成功だけで勝手にONにしない案を優先。
- reconnect/revoke pathを設計。

### Secrets
- access token / refresh tokenはVault or equivalent trusted server store。
- client/DB public rows/log/Reportへtokenを書かない。
- token rotation/reconnectを考慮。
- service_roleをExpoへ含めない。

### Mobile UX
最小:
- Accounts → 「Xアカウントを接続」
- browser/deep-link OAuth
- callback後にapp復帰
- connecting / connected / error / reconnect
- handle表示
- workspace未作成の場合onboardingを連続して完了
- cancel時安全に戻れる

## Phase C — implementation candidate

Phase A/Bで安全性が確定したら、source candidateまで実装可。

許可:
- apps/social-mobile source
- 新規/更新Edge Function candidate
- migration/RPC candidate
- tests/docs
- OAuth callback routing candidate

ただし **production apply/deploy/config mutationは禁止**。
K2前に本番X OAuth client/Vault/token/social accountを書き換えない。

## Tests

最低限:
- unauthenticated connect denied
- state/PKCE mismatch denied
- state replay denied
- cross-user / cross-brand connect denied
- no membership onboarding path
- existing membership path
- duplicate X platform user collision
- callback retry idempotency
- token/secret never returned to client
- Vault write interface mocked/isolated
- connection_status transitions
- cancel/error paths
- social-mobile route/deep-link callback
- Phase8 tenant boundary regression
- production default mock unchanged
- typecheck
- lint
- Expo web export/route resolution
- git diff --check

既存x-oauth-connect testsがある場合はfull regression。

## Production safety

K2前に禁止:
- production X OAuth client settings変更
- redirect URI本番変更
- Vault secret write/delete/rotate
- existing social_accounts mutation
- existing brands/memberships mutation
- Edge Function production deploy
- migration production apply
- RLS/admin policy/grant変更
- Cron
- X API実投稿
- Push/AI/Storage/課金
- service_role exposure
- blind db push / migration history repair

read-only production inventoryは可。

## Completion / K2

完了時:
- TASK -> `review_required`
- next_owner -> `chatgpt`
- Reportに:
  1. current OAuth architecture
  2. chosen onboarding architecture and why
  3. changed files
  4. migration/RPC/function candidate
  5. security model
  6. workspace ownership lifecycle
  7. reconnect/revoke behavior
  8. tests/results
  9. production mutation = 0 confirmation
  10. exact commit/push/read-back
  11. K2後に必要なproduction rollout/manual X Developer Portal step

push前fresh origin/main。
完了後STOPしてK2待ち。
