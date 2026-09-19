# Claude Task 2

- task_id: social-mobile-app-phase9-x-oauth-onboarding-20260919
- owner: claude
- slot: claude-2
- status: done
- next_owner: chatgpt
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

## Report

- result: Phase A（read-only inventory）・Phase B（設計）・Phase C（実装候補、範囲を限定）を完了。実装候補はレビュー用ブランチへpush済みで、production適用・デプロイは一切していない。mobile UI（Accounts画面・接続ボタン・deep-link処理）は意図的に次フェーズへ持ち越し（理由はdocs参照）。

### 1. current OAuth architecture

`x-oauth-connect`（本番デプロイ済み、実体はfeature branchのみに存在しmainには無い。ダウンロードで実体を確認）は、`AI_LAB`/`KABUMORI`の**2アカウント固定のハードコードallowlist**。POST(start)経路は`resolveAdminAuthorization`でadmin_users所属者のみ許可。PKCE state/verifierはサーバー側生成でVaultに保存。callbackは`GET .../callback`でXブラウザから直接叩かれるweb/admin向けフロー。全RPC（`begin/consume/complete_*`）はSQL内に`brand_id`/`social_account_id`をリテラル文字列でハードコードしており、**`auth.uid()`への参照が一切ない**（service_roleでのみ呼ばれる前提のため）。`verifyReadOnlyXIdentity`は事前登録済みhandleとの一致を必須とする設計で、初回接続時に「まだ何も登録されていない一般ユーザー」には使えない。

### 2. chosen onboarding architecture and why

既存`x-oauth-connect`を拡張せず、**新規・独立したEdge Function（`x-oauth-connect-user`）+ 新規RPC 3本**を追加する方式を選択。理由: (1) 既存2アカウントはproduction稼働中で、共有コードへの変更はリグレッションリスクが高い、(2) 既存の account model（固定allowlist・auth.uid()非依存）は一般ユーザー向けに根本的に作り替えが必要で、1ファイルに両方の信頼境界を混在させるとレビューが困難になる、(3) このプロジェクトで既に確立されている「信頼境界が異なる新機能は既存を拡張せず新規に切り出す」パターン（`brand-post-dry-run`等）を踏襲。

設計の核: 新Function/新RPCへのPostgREST呼び出しは**すべて接続しようとしているユーザー自身のJWTを転送**し、service_roleキーは一切使わない。これにより各`SECURITY DEFINER` RPC内の`auth.uid()`が本物の呼び出し元を指すことがDB側で保証される。PKCEのcode_verifier/stateは**モバイルクライアント自身が生成・保持**し、DBには一切送らない・保存しない（既存admin flowはブラウザ⇔サーバーが別プロセスのためVault保存が必要だったが、モバイルアプリは同一プロセス内でdeep-link往復するため不要）。初回接続時はhandle事前照合を行わず、検証できたX identityをそのまま紐付ける（bindモード）。

### 3. changed files

- `supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql`（新規、未適用）
- `supabase/functions/x-oauth-connect-user/index.ts`（新規、未デプロイ）
- `supabase/functions/x-oauth-connect-user/oauth_logic.ts`（新規、未デプロイ）
- `supabase/functions/x-oauth-connect-user/oauth_logic_test.ts`（新規、12テスト）
- `apps/social-mobile/docs/phase9-x-oauth-onboarding.md`（新規、設計文書）

`apps/social-mobile`のソースコード（UI/route）は今回変更していない（意図的にPhase 3へ持ち越し）。`x-oauth-connect`・既存RPC・既存`social_accounts`/`brands`/`brand_memberships`行はいずれも一切変更していない。

### 4. migration/RPC/function candidate

- migration: `social_accounts(platform, platform_user_id)`への部分UNIQUE index追加（platform_user_idが非nullの場合のみ）+ `social_account_oauth_states.initiated_by_user_id`列追加（nullable、既存フローは無変更）+ 新規RPC3本（`begin_social_mobile_x_oauth_connection`, `consume_social_mobile_x_oauth_state`, `complete_social_mobile_x_oauth_connection`）。全てSECURITY DEFINERだが`authenticated`ロールへEXECUTE付与（既存admin flowのRPCとは異なりservice_roleには一切付与していない）。
- read-onlyでcurrent production schemaに対しpreflight済み（`brands`/`social_accounts`/`brand_memberships`/`social_account_oauth_states`の実カラム・制約・既存RPCシグネチャを確認した上で設計）。**未適用**。
- function: `x-oauth-connect-user`。**未デプロイ**。

### 5. security model

- 認証: `Authorization: Bearer <user JWT>`を`GET {SUPABASE_URL}/auth/v1/user`で検証（admin_usersチェックなし、実在の非匿名ユーザーなら誰でも可）。
- 全DB呼び出しは呼び出し元ユーザー自身のJWTを転送。service_roleは一切使用しない設計（誤ってservice_roleに切り替えると`auth.uid()`がnullになり全RPCが`SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED`でfail-closedする、fail-openではなくfail-closedな壊れ方になる設計）。
- callbackの`code`/`state`はクライアント値をそのまま信用せず、`auth.uid()`に紐づく`social_account_oauth_states`行の照合を経て初めて`brand_id`/`social_account_id`が確定する。
- 同一X `platform_user_id`の重複接続は部分UNIQUE indexによりDB層でatomicにブロック（check-then-actレースに強い）。
- token値はEdge Functionのレスポンスに一切含まれない（テストで実際のシリアライズ結果を検証済み）。

### 6. workspace ownership lifecycle

初回: `begin_social_mobile_x_oauth_connection`が対象ユーザーのbrand（`u_<uid先頭24桁>`形式、決定的なので冪等）+ owner membership + `social_accounts`行（`connection_status=authorization_pending`, handle='pending'仮値）を作成。再試行: 既存ownerの1件を再利用（`connection_status`をリセット）。想定外に複数brandをownerとして持つ場合は推測せずfail-closed。`code_profile_key`は未登録のplaceholder値とし、コンテンツ生成パイプラインからは`BRAND_CODE_PROFILE_NOT_FOUND`で意図的に到達不能（所有権確立と生成配線を明確に別フェーズとして分離）。

### 7. reconnect/revoke behavior

reconnect: `begin_*`の再呼び出しで同じ行を再利用し安全にやり直し可能（重複行は作られない）。revoke（接続解除）: **本フェーズのスコープ外**。remaining_issuesに明記。

### 8. tests/results

- `deno test --no-check --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions/x-oauth-connect-user`: 12/12 pass（未認証拒否、cross-user/no-membership相当のRPCエラー伝播、redirect_uri不一致・使用済/不整合stateがトークン交換前に拒否、happy pathでtoken非返却、重複アカウント衝突エラー伝播、非2xxトークン交換のfail-closed）。
- `deno test`全体（既存供給分含む）: **1234/1234 pass**、リグレッションなし。
- `deno check supabase/functions/x-oauth-connect-user/oauth_logic.ts`: エラーなし。
- `git diff --check`: 問題なし。
- `apps/social-mobile`側のtypecheck/lint/Expo export/route resolutionは、このタスクで同アプリのソースを一切変更していないため再実行不要（前回Phase 8完了時点のPASS状態から不変）。

### 9. production mutation = 0 confirmation

0件。read-onlyのSQL/Edge Functionダウンロードのみ実施。migrationは未適用、Edge Functionは未デプロイ、既存`x-oauth-connect`・既存brand/social_accounts/membership行は一切変更していない。

### 10. exact commit/push/read-back

- ブランチ`social-mobile-x-oauth-onboarding-phase9-20260919`、コミット`db79f02`をpush済み（mainへは未マージ、レビュー待ち）。
- `.agent/tasks/CLAUDE_TASK.md`の本Reportをorigin/mainへpushする。

### 11. K2後に必要なproduction rollout/manual step

1. 本Reportのmigration/Edge Functionをコードレビュー（K2）
2. K2承認後、migrationをread-onlyでの再preflight → `supabase db query --linked`での適用 → read-back検証（既存の安全手順を踏襲）
3. Edge Function `x-oauth-connect-user`をデプロイ（`--no-verify-jwt`、既存関数群と同様の運用に合わせるか要判断）
4. **X Developer Portalでの手動作業**: 新しいredirect URI（`{SUPABASE_URL}/functions/v1/x-oauth-connect-user/callback`は使わない設計だが、モバイルのdeep-link redirect_uri自体はアプリ側の任意のURIになるため、Xアプリの設定でredirect URI allowlistにモバイルのdeep-linkスキーム（例: `kabumori-social-mobile://oauth-callback`）を追加登録する必要がある）
5. `apps/social-mobile`側のAccounts画面・接続ボタン・deep-link route・connecting/connected/error状態のUI実装（次フェーズ、本Reportで意図的に未着手と明記）
6. `_shared/brand/brand_profiles.ts`への`social_mobile_user_v1`プロファイル追加（一般ユーザーのコンテンツ生成を有効化する場合のみ、さらに別フェーズ）

### remaining_issues

1. mobile UI未実装（次フェーズ）
2. revoke/disconnect flow未設計
3. 一般ユーザーのposting_windows/publish有効化設計は完全にスコープ外（OAuth/所有権確立のみ）
4. X Developer Portalでのdeep-link redirect URI登録が本番投入前に必要


## K2 review — 2026-09-19

**NOT PASS — candidate architecture is directionally good, but the current implementation has a blocking OAuth state bug and retry/idempotency gap. Production rollout is not approved.**

### Accepted

- Keeping Supabase Auth as the app login boundary and treating X OAuth as an attached publishing account is the correct direction for this Phase.
- Splitting general-user OAuth into a new `x-oauth-connect-user` flow instead of mutating the existing hardcoded admin `x-oauth-connect` significantly reduces regression risk.
- DB ownership checks derive from `auth.uid()`; caller-supplied user_id/brand_id are not trusted.
- Existing production X accounts / Vault / RLS / policies were not mutated.
- Token values are not returned to the mobile client response.
- `publish_enabled` remains false after identity verification.
- duplicate `platform_user_id` protection at DB level is a good requirement.
- production mutation/deploy = 0.

### Blocker 1 — OAuth state is double-hashed and happy-path cannot work as written

Current candidate behavior:
1. mobile sends `state_hash = SHA256(raw_state)` to the start endpoint.
2. `begin_social_mobile_x_oauth_connection` stores that hash.
3. `startConnection()` sends **that hash itself** to X as the OAuth `state` parameter.
4. X returns the same hash to the app.
5. callback calls `hashState(request.state)`, producing `SHA256(SHA256(raw_state))`.
6. consume RPC looks for the originally stored single hash and therefore cannot match.

This contradicts the source comment saying the returned X state is compared with the locally held raw state.

**Required fix:** make one coherent state contract and test it end-to-end. Preferred:
- client generates raw random state;
- client sends raw state to the start Function over authenticated TLS;
- server hashes raw state before storing it;
- X receives raw state as `state`;
- callback receives raw state from X;
- server hashes callback raw state once and consumes the stored hash.

Alternative designs are acceptable only if they preserve equivalent CSRF binding and do not expose a reusable DB state identifier as the OAuth state without a clear threat model.

Add a regression proving:
`raw state -> start -> authorization URL state -> callback -> consume`
matches exactly once.

### Blocker 2 — state is consumed before redirect/token/identity/DB completion, so transient failure destroys retryability

`completeConnection()` currently calls `consume_social_mobile_x_oauth_state` first, which sets `consumed_at = now()`, then:
- validates redirect URI in application code,
- exchanges the authorization code,
- reads X identity,
- writes Vault/account state.

Any failure after consume (redirect mismatch, X token endpoint transient error, identity fetch failure, Vault/RPC failure) leaves the state permanently consumed. That violates this TASK's required **callback retry idempotency / safe partial OAuth retry** behavior.

**Required fix:** redesign state lifecycle so a callback is not irreversibly consumed until the connection is successfully finalized, or add an explicit bounded claim/finalize model:
- validate owner + expiry + redirect without final consume;
- claim atomically with a short-lived attempt token / in-progress state;
- finalize consumed only after token + identity + Vault/account completion succeeds;
- failed/transient attempt can safely retry while preventing concurrent/replayed success.

A simpler transactional DB design is also acceptable if it gives the same guarantees. Do not weaken replay protection.

Add tests for:
- token exchange failure then retry with same callback succeeds when safe;
- identity read failure then retry succeeds;
- completion/Vault failure then retry succeeds;
- successful completion then replay is denied;
- concurrent duplicate callback cannot create two successful bindings.

### Required follow-up

1. Fix the two blockers above on the Phase 9 branch only.
2. Re-run the 12 new tests and add the missing end-to-end state + retry tests.
3. Re-run existing regression suite.
4. Run `git diff --check`.
5. No production migration/deploy/OAuth Portal/Vault mutation.
6. Update this Report with exact changed files/commit and return `review_required / next_owner: chatgpt`.

The mobile UI may remain intentionally deferred; that is not the blocker for this K2.

## Report (K2 follow-up — blocker fixes)

- result: K2で指摘された2つのblockerを両方修正した。migration・Edge Functionともに**同じ未適用・未デプロイのcandidate**の上での修正であり、いずれのバグも本番へは一切到達していない。

### Blocker 1（state二重ハッシュ）の修正

原因: `startConnection()`がクライアントから受け取った`state_hash`（ハッシュ済み値）をそのままXの`state`パラメータとして送信していた。Xはこの値を無変更でcallbackへ返すため、`completeConnection()`側の`hashState(request.state)`が「ハッシュのハッシュ」を計算してしまい、`begin`が保存した値と一致せずhappy pathが原理的に成立しなかった。

修正: クライアントは**生のstate値**を送るよう変更し、`startConnection()`内でDB保存用に一度だけハッシュ計算（`p_state_hash`）し、Xには生のstateをそのまま渡す。`completeConnection()`側の既存の1回のハッシュ計算は変更不要（入力が正しい生の値になったことで整合する）。

回帰テスト: `startConnection`が生成する`p_state_hash`（RPCへ送る値）とXへ送る`state`パラメータが別物であることを検証するテスト、および「start→authorization URLのstate→callback→consume」を1本のテストで繋いで、保存されたhashと問い合わせ時のhashが完全一致することを直接証明するend-to-endテストを追加。

### Blocker 2（consume早すぎ問題）の修正

原因: `consume_social_mobile_x_oauth_state`がlookup時点で`consumed_at`を確定させていたため、その後のトークン交換・identity取得・Vault書き込みのいずれかで失敗すると、そのstateは永久に再利用不能になりretryができなかった。

修正: `consume_social_mobile_x_oauth_state`を**read-only**（`consumed_at`を一切変更しない、何度呼んでも安全）に変更。唯一の不可逆な「消費」ポイントを`complete_social_mobile_x_oauth_connection`内の1つのatomicな`UPDATE ... WHERE consumed_at IS NULL`に移動し、成功時にのみ`consumed_at`が確定するようにした。`complete_*`のパラメータも、クライアントが独立して指定できてしまう`p_social_account_id`ではなく、`consume_*`が返す`oauth_state_id`（state行自身の主キー）を受け取る形に変更し、なりすまし可能なパラメータを削減。

回帰テスト: トークン交換失敗後のretry成功、identity取得失敗後のretry成功、completion RPC失敗後のretry成功、成功済みcallbackのreplayが拒否されること、同一stateへの2つの同時callbackのうち1つだけが成功すること、の計5テストを新規追加（+ end-to-endテスト1件、合計6件純増）。

### tests

- `deno test --no-check --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions/x-oauth-connect-user`: **18/18 pass**（既存12 + 新規6）。
- `deno test`全体: **1240/1240 pass**（既存1234 + 新規6）、リグレッションなし。
- `deno check supabase/functions/x-oauth-connect-user/oauth_logic.ts`: エラーなし。
- `git diff --check`: 問題なし。

### changed files

- `supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql`（同ファイルを修正。まだ本番未適用のcandidateなので新規migrationファイルは作成せず、この場で修正）
- `supabase/functions/x-oauth-connect-user/index.ts`（body fieldを`state_hash`→`state`(raw)に変更）
- `supabase/functions/x-oauth-connect-user/oauth_logic.ts`（`StartRequest.stateHash`→`rawState`、`startConnection`内でハッシュ計算、`consume`/`complete`のRPC呼び出し形状変更）
- `supabase/functions/x-oauth-connect-user/oauth_logic_test.ts`（既存テストのフィールド名修正+新規6テスト）
- `apps/social-mobile/docs/phase9-x-oauth-onboarding.md`（K2フォローアップの修正内容を追記）

### commit/push

- ブランチ`social-mobile-x-oauth-onboarding-phase9-20260919`、コミット`a58c01d`をpush済み（前回commit `db79f02`の後続。mainへは未マージ）。

### production mutation = 0 confirmation

0件。migrationは未適用のまま、Edge Functionは未デプロイのまま。既存`x-oauth-connect`・既存brand/social_accounts/membership行への変更もなし。

前回Reportの1〜11節（architecture/design/security model等）は変更なし。今回はK2指摘の2blockerの修正のみ。


## Final K2 review — 2026-09-19

**PASS — Phase 9 OAuth candidate approved for handoff.**

Accepted:
- K2 blocker 1 fixed: raw OAuth state is now passed to X; only the server-side DB lookup value is SHA-256 hashed once. End-to-end regression proves start -> authorization URL -> callback -> consume consistency.
- K2 blocker 2 fixed: consume lookup is read-only; irreversible consumption occurs only inside `complete_social_mobile_x_oauth_connection`.
- Because PostgreSQL function execution is transactional, failures raised after the state claim roll back the claim and Vault/account writes together, preserving safe retry behavior.
- completion derives the target account from `oauth_state_id` + `auth.uid()` ownership, rather than trusting a caller-supplied social_account_id.
- successful replay is rejected and concurrent duplicate completion is constrained to one success.
- 18/18 new OAuth tests PASS; full suite 1240/1240 PASS; deno check and git diff --check PASS.
- production mutation/deploy remains 0.
- existing production admin X OAuth flow remains untouched.

Review note:
- feature branch is currently 2 commits ahead and 10 commits behind main, so it must not be merged blindly. The next owner must fresh-check origin/main and integrate only the reviewed Phase 9 changes, resolving drift explicitly.

Decision:
- Claude slot 2 Phase 9 candidate work is complete.
- status = done.
- Per user instruction, all subsequent Phase 9 work moves to Codex slot 2.
