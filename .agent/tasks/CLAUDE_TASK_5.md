# Claude Task 5 — CURRENT TASK

- task_id: common-account-v1-phase0-prod-readonly-inventory-20261001
- owner: claude
- slot: claude-5
- status: in_progress
- next_owner: chatgpt
- priority: highest
- start_code: G5
- finish_code: K5
- recommended_model: Opus5.5（極高）
- type: read-only architecture / production inventory / migration preflight
- production_mutation_allowed: false

## Purpose

会社共通アカウントv1の実装前Phase 0として、現行repository + productionのAuth / account / service ownership実態を**read-only**で確認し、既存ユーザーを壊さずにservice entitlementへ移行するための事実ベースのinventoryを作る。

このTASKでは**実装しない**。migration / RLS / Auth / OAuth / Vault / production data / account deletion behaviorを変更しない。

共通アカウントv1の中心方針：

```text
auth.users.id
= 共通本人ID

common_accounts
= 共通アカウントapplication state

service_entitlements
= 各serviceの利用登録

public.profiles
= v1ではKabumori固有rootのまま

brand_memberships
= X workspace authorization / roleのまま
```

各アプリの新規登録は将来、

```text
共通アカウント作成 / 既存共通アカウント認証
+
そのアプリのservice利用登録
```

として扱う。

- Kabumoriから初回登録 → common account + kabumori entitlement
- X自動投稿から初回登録 → common account + x_autopost entitlement
- 既存common accountが別serviceへ来た場合 → 本人認証後、そのservice entitlementだけ作成
- login前のemail入力だけで「既存アカウントあり」と断定表示しない（account enumeration回避）
- login identityとX posting authorizationは別レイヤー
- 異なるAuth userをemail一致だけで自動mergeしない

## Mandatory startup / isolation

開始前に必ず確認する。

1. `PROJECT_RULES.md`
2. `HANDOFF.md`
3. `.agent/ORCHESTRATION.md`
4. `.agent/CURRENT_STATE.md`
5. `.agent/ACTIVE_TASK.md`
6. このG5 TASK
7. G1〜G4 / H1 / H2の現在TASK・Report
8. `git status`
9. `git worktree list`
10. fresh `origin/main`

G5専用の独立worktree / checkoutを使用する。他slotのworktreeを共有しない。

### Competition / ownership rule

このTASKはread-only調査なので他slotと並行可能だが、開始時にfresh状態を再確認する。

割当時点では、G1/G2/G3/G4およびH1/H2に別workstreamが存在する。特に：

- G3はsocial-mobile account deletion UI release cleanupを担当中。共通account/service-entitlement設計は実装しない方針。
- G4はsocial-mobile X posting OAuthのiOS account-switch/auth-session境界を担当中。
- G1/G2はKabumori UI / market-report系。
- H1/H2は別PRレビュー。

G5はこれらのbranch / files / pending PRを変更・merge・rebase・resetしない。

競合またはownership不明が見つかったら作業開始せずSTOPし、具体的な理由をReportする。

## Existing assumptions to verify read-only

### Kabumori

- Supabase Auth user.idを本人IDとして使用
- session成立時の `prepareSession -> ensureProfile -> ensure_my_profile` によりprofileが自動生成される現行構造
- `public.profiles` がKabumori固有データのcascade root
- 現行Kabumori account deletionはAuth hard delete前提
- client RLSは主に `auth.uid() = user_id`
- service_role producerはRLSを迂回する

### X social-mobile

- 同じSupabase Auth user.idを本人IDとして使用
- login methods: email / Google / Apple / X
- X login identityとX posting OAuthは分離済み
- workspace ownershipは `brand_memberships.user_id`
- posting token本体はVault、social_accountsはsecret reference
- social-only deletionは存在し、Auth / Kabumoriを残してX固有データを削除できる
- 現行delete scopeは `public.profiles` 存在有無をproxyとして使う箇所がある
- X service entitlementはまだ明示テーブル化されていない

## Phase 0 — required read-only inventory

### A. Supabase Auth / identity

productionでaggregateのみ確認。

最低限：

- Auth user総数
- provider identity総数
- provider別identity数: email / google / apple / x / その他
- 1 userが複数identityを持つ件数
- provider組み合わせのaggregate
- identityなし等の異常状態が存在するか
- 同一personと推測して自動mergeすべきuserは判定しない

**email、user UUID、provider token、raw identity payload等のPII/secretをReportへ出さない。**

Auth provider設定について、秘密値を表示せずread-only確認可能ならenabled/disabledやcallback/redirect構成の存在だけ確認する。
secret露出が必要なら「未確認」とする。

### B. Common-account migration population

既存production userを、PIIなしのaggregateで以下に分類するdry-runを作る。

```text
A. Kabumoriあり / Xなし
B. Kabumoriなし / Xあり
C. Kabumoriあり / Xあり
D. Auth userのみ / どちらもなし
```

「あり」の定義を明記する。

Kabumori候補はprofile有無だけでなく、少なくとも：

- profileのみ
- tracked_stocksあり
- alert/settingsあり
- notificationsあり
- device_push_tokensあり
- personalized_reportsあり

をaggregate分類する。

X候補は全brand_membershipsを利用者扱いしない。
一般ユーザー用workspace/profile（例: `social_mobile_user_v1`）とadmin/internal/legacy workspaceを区別し、x_autopost entitlement backfill候補の定義を提案する。

### C. Kabumori ownership / deletion surface

production schema + main sourceをread-onlyで照合。

確認：

- `profiles -> auth.users` FK
- `tracked_stocks`
- `alert_settings`
- `alert_category_settings`
- `notifications`
- `device_push_tokens`
- `personalized_reports`
- FK delete action
- current RLS predicates
- current RPC/functions using `auth.uid()`
- service_role producerがuserを列挙する経路
- current account-delete source + production deploy metadata/version（read-onlyで確認可能な範囲）
- Auth hard deleteが他serviceへcascadeし得る参照

変更しない。

### D. X workspace / membership / social account ownership

productionでaggregate + schema/sourceを確認。

最低限：

- user-facing workspace数
- user-facing owner membership数
- distinct user数
- social account数
- X identity_verified接続数
- publish_enabled状態のaggregate
- platform + platform_user_id uniqueness実態
- orphan membership / orphan social account等が存在しないか
- internal/admin/legacy workspaceとの区別
- workspace ownership chain

raw handle / platform user id / user idはReportへ出さない。

### E. OAuth / Vault boundary

確認：

- social_accountsが保持するcredential referenceの種類
- access / refresh credential reference件数のaggregate
- orphan referenceの有無（安全に判定できる場合）
- OAuth transient stateのaggregate / ownership
- X deletion時のrevoke -> fingerprint check -> Vault purge順序
- Sign in with Appleの共通アカウント完全削除時に必要となるtoken revokeを、現状どこまで実装済みか / 未実装か

**Vault secret valueは絶対に読む・表示・復号しない。**
`vault.decrypted_secrets` 等からsecret値を取得しない。

### F. Current deletion boundaries

Kabumori / Xの両方についてread-onlyで整理。

- service-only deletion
- common Auth deletion相当
- current scope判定
- cascade
- external OAuth revoke
- deletion audit
- feature flag
- reauthentication
- session/user pinning
- retry/idempotency

現行の危険なproxy / hard-delete境界を具体的に特定する。

### G. RLS / backend producer boundary

client RLSとservice_role処理を分けて一覧化する。

将来entitlement導入時に、

```text
auth.uid()/ownership条件
+
service entitlement active
```

が必要になる場所を候補として列挙する。

このTASKではRLSを書き換えない。

### H. New registration / login impact inventory

新仕様を導入する場合に変更対象になり得るsourceをread-onlyで列挙する。

Kabumori：

- signup / sign-in UI
- AuthProvider / AuthGate
- session restore
- ensure profile
- password recovery
- settings/account deletion
- service start UI

X social-mobile：

- signup / sign-in UI
- Google / Apple / X login
- linkIdentity
- workspace provisioning
- X posting OAuth start
- deletion preview/scope
- login methods/settings

共通：

- service entitlement
- common account lifecycle
- account deletion orchestrator
- Apple revoke
- account enumeration-safe UX

**変更ファイル候補を列挙するだけ。編集しない。**

## Migration dry-run recommendation

inventory結果を使い、次のPhaseで安全なshadow backfillを作るための判定ルール案をReportする。

最低限：

- common_accounts候補
- kabumori entitlement candidate rule
- x_autopost entitlement candidate rule
- ambiguous / manual-review population count
- 既存Auth-only userの扱い
- rollback可能性
- feature flag / shadow導入順

**backfill自体は実行しない。**

## Production read-only safety

許可：

- SELECT
- schema / policy / function definition read
- source review
- production metadata/version read
- aggregate count
- dry-run computation that does not write

禁止：

- INSERT / UPDATE / DELETE
- migration apply
- mutation RPC/Edge Function invocation
- Auth user create/update/delete
- identity link/unlink
- OAuth authorize/revoke
- X provider-side mutation
- Vault create/update/delete/reveal
- secret read/decrypt
- account deletion実行
- feature flag change
- deploy
- merge
- production config change
- Cron invocation/change
- real X post
- existing user backfill

read-onlyであることを保証できない操作が必要なら実行せず、未確認事項としてReportする。

## Privacy / report constraints

Reportへ以下を絶対に書かない。

- email address
- auth user UUID
- X handle
- X platform user id
- access token / refresh token
- OAuth code/verifier/state raw value
- JWT
- session id
- secret
- Vault secret value/referenceの生値
- その他個人を識別できるraw data

aggregate count、table/function名、safe schema metadataは可。

## Required output

実装コードは変更しない。

このTASK末尾 `## Report` を更新し、最低限以下を記録する。

- task_id
- result: PASS / PARTIAL / BLOCKED
- checked_main
- worktree / isolation result
- production_mutation = 0
- Auth/identity aggregate
- A/B/C/D population aggregate
- Kabumori legacy classification
- X legacy classification
- ownership findings
- deletion/cascade findings
- RLS/service_role findings
- OAuth/Vault findings（secretなし）
- Apple revoke readiness
- ambiguous migration population
- recommended backfill rules
- proposed implementation phases
- candidate files/components to change later
- conflicts/pending PRs affecting implementation
- tests/checks/read-only queries used（secret/PIIなし）
- remaining unknowns
- safety_checks
- next_recommendation

raw production recordsは貼らない。

## Completion / K5

調査完了後：

- status -> review_required
- next_owner -> chatgpt
- Report更新
- G5自身のTASK以外のsource/runtime codeを変更しない
- production mutation 0を明記
- K5でChatGPTが確認するためSTOP

このPhase 0はread-only調査なので、通常は独立Codexレビューをまだ要求しない。
ただし重大なAuth/RLS/cascade/security defectを発見した場合は修正せずReportし、K5でChatGPTがH1/H2 review/fixの要否を判断する。

## Report

> **中間報告（2026-10-01 JST）。status は `in_progress` のまま。K5対象ではない。**
> repository / source inventory は完了。production read-only 集計は**未取得**（下記 `result` 参照）。

- task_id: common-account-v1-phase0-prod-readonly-inventory-20261001
- result: **PARTIAL（in progress）**。source側（C/D/E/F/G/H の repository 部分）は完了。production側（A/B の集計、C〜G の production 照合）は未実施。理由: このClaudeセッションの auto mode が production read（`supabase db query --linked`）を拒否した。回避は行っていない。ユーザーの許可、またはユーザー自身による実行待ち。
- checked_main: `5414791`（開始時の fresh `origin/main`）。
- worktree / isolation: G5専用 worktree（`.claude/worktrees/g5-f7a405`）、branch `claude/g5-common-account-phase0-20261001`（`origin/main` 基点）。他slotの worktree / branch / PR は未変更。用意されていた worktree branch は `origin/main` と分岐した古い基点（2096 commit 遅れ）だったため、`origin/main` から branch を切り直した（旧branchは未変更で残置）。
- production_mutation: **0**。production read も 0（試行した `select` 1件は実行前に拒否された）。
- changed_files: `.agent/tasks/CLAUDE_TASK_5.md` のみ。read-only クエリ一式は worktree 内の未追跡ディレクトリ `.g5-phase0/` にあり、commit していない。
- tests: クエリ10本を、使い捨てのローカルPostgreSQL（偽データのみ、production非接続）で全件実行成功。runner は各ファイルが「単一SELECT・書き込み語なし・`decrypted_secrets` 不使用」であることを実行前に検査する。
- commit_hash: `ea65135`（in_progress 記録）。本中間報告の commit は push 後に確定。
- push: `origin/main` へ fast-forward。
- deploy: none（prohibited）。

### Auth / identity aggregate

未取得（production read 待ち）。クエリ `01_auth_identity` を用意済み。出力は件数のみ（user総数、provider別identity数、複数identity保有数、provider組み合わせ、identityなし、email重複グループ数など）。

source から分かること:
- Kabumori アプリの login は **email + password のみ**（OAuth / Apple / Google / magic link なし）。
- social-mobile は email / Google / Apple / X。X・Google は browser OAuth（PKCE）、Apple は iOS native（`signInWithIdToken`）＋他platformは browser。ただし `app.json` に `ios.bundleIdentifier` がなく native Apple は build 未設定。
- provider は `GET /auth/v1/settings` で有効 かつ `EXPO_PUBLIC_AUTH_PROVIDERS` に宣言されたものだけ表示（default は email のみ）。production の provider enabled 状態は未確認。
- `unlinkIdentity` は social-mobile のどこからも呼ばれない。`linkIdentity` は login-methods 画面のみ。

### A/B/C/D population aggregate

未取得（production read 待ち）。クエリ `02_population` を用意済み。3通りの定義で A/B/C/D を出す。

- 定義1: `profiles` 行あり × user-facing workspace の owner membership あり
- 定義2: `profiles` 行あり × `brand_memberships` 任意
- 定義3: Kabumori 実利用（下記）あり × user-facing workspace の owner membership あり

### Kabumori legacy classification

件数は未取得。分類ルールは確定:

- `profiles` 行は **利用登録の証拠として弱い**。Kabumori アプリが受け入れた全 session で `prepareSession -> ensureProfile -> ensure_my_profile` が走り、`profiles(id)` を無条件に作る（cold start、全 `onAuthStateChange`、sign-in、password recovery link 経由の session を含む）。「Kabumoriを始める」明示ステップは存在しない。
- `ensure_my_profile` が作るのは `profiles` だけ。`alert_settings` / `alert_category_settings` / `device_push_tokens` / `tracked_stocks` は後続の client 操作で作られる。
- よって実利用の証拠は: `tracked_stocks`、`alert_settings` が default から変更済み、`alert_category_settings`、`notifications`、`device_push_tokens`、`personalized_reports`。`device_push_tokens` は login ごとに登録されるので「実機でログインした」証拠。
- email confirmation 前で session がない sign-up は `profiles` を持たない（Auth-only に見える）。

### X legacy classification

件数は未取得。分類ルールは確定:

- 一般ユーザー workspace = `brands.code_profile_key = 'social_mobile_user_v1'` かつ id が `u_` + 24桁hex（`'u_' || substr(md5(user_id), 1, 24)`）、owner membership 1件。
- internal / legacy = それ以外の `code_profile_key`（`kabumori_v1`、`ai_salaryman_lab_v1` など）。これらの membership と `admin_users` は operator 権限であり、consumer entitlement の backfill 候補に含めない。
- workspace は login 時ではなく **初回の「Xを連携」開始時**に `begin_social_mobile_x_oauth_connection` が作る。social-mobile に sign-in しただけで連携を押していない user は X側に行が一切ない。
- sub分類: `connection_status = 'identity_verified'`（連携完了） / `authorization_pending`（開始のみ）。

### ownership findings

Kabumori:
- `profiles.id -> auth.users(id)` ON DELETE CASCADE。
- `tracked_stocks` / `alert_settings` / `alert_category_settings` / `notifications` / `device_push_tokens` / `personalized_reports` はすべて `user_id -> profiles(id)` ON DELETE CASCADE。`auth.users` を直接参照しない。
- つまり `profiles` 行の削除だけで Kabumori データは全 cascade し、Auth user は残せる構造。

X:
- chain: `auth.users.id -> brand_memberships(user_id, role='owner') -> brands.id -> social_accounts.brand_id -> vault_*_secret_id -> vault.secrets`。`social_accounts` に user 列はない。
- `auth.users` への FK（すべて CASCADE）: `profiles.id`、`admin_users.user_id`、`brand_memberships.user_id`、`social_account_oauth_states.initiated_by_user_id`。
- `brands` / `social_accounts` / Vault secret / refresh state / `scheduled_posts` は `auth.users` を参照しない。
- `social_accounts` に partial unique index `(platform, platform_user_id) where platform_user_id is not null`。1つのXアカウントは全体で1行にしか結び付かない。
- X login identity の subject と `social_accounts.platform_user_id` を突き合わせる処理は存在しない（login identity と posting authorization は分離済み）。

schema再現性:
- `brands` / `social_accounts` / `brand_settings` / `social_account_oauth_states` の `create table` は **main の migrations に存在しない**。定義は未マージ branch `feature/multibrand-foundation` と test fixture にしかない。main の migration だけでは production schema を再構築できない。
- production の実 schema / FK / unique は未照合（クエリ `00_schema_catalog` 待ち）。

### deletion / cascade findings

重要度順。

1. **Kabumori `account-delete` は Auth hard delete で、X側を知らない。** `DELETE /auth/v1/admin/users/{id}` を service role で1回呼ぶだけ。`brand_memberships` と OAuth state は cascade で消えるが、`brands` / `social_accounts` / Vault secret は孤児として残り、X authorization は revoke されない。再認証なし（email 再入力は client 側のみ）、feature flag なし、audit なし、admin guard なし（`admin_users` も cascade）。production の deploy 状態は未確認（source header は "not deployed by the task that introduced it"）。deploy 済みなら、両サービス利用者が Kabumori から退会した時点で発生する実害。**修正はしていない。**
2. **X削除の scope は `profiles` 行の有無が proxy。** `social_mobile_account_deletion_scope`: `profiles` あり → `social_only`、なし → `social_and_login`。`finalize` でも同じ判定で `auth.users` を削除。1 と組み合わせると `profiles` 行が事実上の「Kabumori entitlement」になっている。
3. proxy が生む境界ケース:
   - X専用 user が Kabumori アプリに一度 sign-in すると `profiles` が自動生成され、以後 X削除は永久に `social_only`（login が残る）。
   - Kabumori user が social-mobile に sign-in しただけ（workspaceなし）だと `social_only` で消すものがない。
   - social-mobile のみ・workspaceなしの user は login ごと削除される。
4. X削除の順序（source）: bearer検証 → 確認文字列 → 直近認証（JWT `amr` 600秒以内）→ scope検証 → tombstone + lease 取得（同時に posting 停止）→ credential 取得 → X revoke（refresh → access）→ fingerprint 照合 → （該当時）Apple revoke → purge（refresh state → OAuth state → posts → `social_accounts` → `vault.secrets` → `brands`）→ finalize。state は `started -> x_revoked -> purged`、`operator_required` で停止。再試行は lease と state で冪等。
5. X削除の blocker: `ADMIN_ACCOUNT` / `OWNS_OTHER_WORKSPACE` / `WORKSPACE_NOT_SELF_SERVICE` / `SHARED_WORKSPACE` / `WORKSPACE_ROLE_MISMATCH` / `POSTING_IN_PROGRESS` / `CREDENTIAL_REFRESH_IN_PROGRESS` / `CREDENTIAL_OWNERSHIP_AMBIGUOUS`。
6. feature flag は client 側のみ（`EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED`）。server 側 flag はなく、function が deploy されていること自体が gate。
7. session pinning は client 側のみ（`userId` + `sessionId` を再認証時に固定）。server は bearer `sub` + lease。
8. `social_mobile_account_deletions.user_id` は `auth.users` への FK を持たない。進行中 tombstone は Auth user 削除後も残り得る。

### RLS / service_role findings

client RLS（Kabumori）: 全 policy が `auth.uid() = user_id`（`profiles` は `= id`）のみ。共有 Auth project の authenticated user なら誰でも通る。service 利用登録の検査はどこにもない。

client RLS（X）: `brand_memberships` は self-select のみ。`brands` / `social_accounts` / `scheduled_posts` / `post_execution_logs` / `posting_windows` は membership（任意role）で select。`social_mobile_content_settings` は owner のみ。書き込みは SECURITY DEFINER RPC 経由。

将来「ownership条件 + entitlement active」が必要になる候補:

- Kabumori client path: 上記7テーブルの全 policy、`ensure_my_profile`、`set_my_important_news_alert_preferences`、`get_my_important_stock_news`、`get_daily_kabumori_tip`（user検査が一切ない SECURITY DEFINER）。
- Kabumori service_role producer（RLS迂回）: `claim_pending_push_notifications`、`enqueue_important_news_notifications`（wrapper と base）、`enqueue_personalized_report_notification`、`personalized_report_news_inputs`、`important_news_app_copy_targets`、`personalized-reports` function の `tracked_stocks` cohort query。**どの producer も `profiles` を列挙しない。** population の鍵は `tracked_stocks` / `alert_settings` / pending `notifications` / `device_push_tokens`。
- X client path: `begin_social_mobile_x_oauth_connection`（authenticated なら誰でも workspace を作れる）、`consume_` / `complete_social_mobile_x_oauth_connection`、membership select policy 群。
- X service_role path: `x-test-post` dispatcher（repo 定義の `claim_due_post` は brand filter なしで最古の pending を取る。production の本体は異なる可能性があり未照合）、Vault credential / refresh RPC、v2 queue（source のみ、未配線）、`read_social_mobile_history_access_token`（user + owner membership を見る唯一の service-role path）。一般ユーザー `u_` workspace は現状 publish できない（inactive/disabled で作成され、dispatch branch が特定 brand を要求する）。この経路を開ける時点が entitlement 検査の挿入点。

付随的な気付き（今回の範囲外、未修正）:
- `device_push_tokens` は service_role に SELECT しか grant していないが、`send-push-notifications` は無効 token を DELETE し結果を検査していない。production grant が source と同じなら cleanup が黙って失敗している可能性。production 照合待ち。
- `social_accounts` の SELECT grant は table 全体。member は Vault secret id 列（参照値であり secret 本体ではない）を読める。client は非secret列だけ select している。

### OAuth / Vault findings（secretなし）

- posting token 本体は `vault.secrets`。`social_accounts.vault_access_token_secret_id` / `vault_refresh_token_secret_id` は参照のみ。
- transient state は `social_account_oauth_states`（`state_hash`、`redirect_uri`、`expires_at`、`initiated_by_user_id`）。PKCE verifier は server に保存しない（`code_verifier_vault_secret_id` は null で insert）。consume / complete は `initiated_by_user_id = auth.uid()` を検査。行は `consumed_at` を付けるだけで削除されず、消すのは削除 purge のみ。
- `x-oauth-connect-user` は service role を使わない（user JWT で RPC）。
- refresh は dispatcher 側のみ（env gate + account 単位 rollout）。connect function では refresh しない。
- legacy Kabumori 投稿は `oauth_token_store`（暗号化済み列）+ env token で、Vault ではない。
- reference 件数、orphan reference、transient state の集計は未取得（クエリ `03` / `04` 待ち）。`04` は `vault.secrets` の `id` 列だけを比較し、secret 本体・name・復号 view には触れない。

### Apple revoke readiness

- 実装は social-mobile の削除 function のみ（`apple_revoke.ts`）。authorization code を token endpoint で交換 → `id_token` の subject が本人の Apple identity であることを確認 → revoke endpoint。
- 適用条件は `scope === 'social_and_login'` かつ provider に apple を含む場合のみ。`social_only` では revoke しない。
- 必要 env（`APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_CLIENT_ID` / `APPLE_PRIVATE_KEY`）がなければ `APPLE_REVOCATION_UNAVAILABLE` で fail closed。production の設定有無は未確認。
- sign-in 時の authorization code は破棄、Apple refresh token は保存していない。削除時に native iOS で再認証して code を取り直す前提（他platformは「iPhoneアプリで」と案内）。
- native Apple は build 未設定（`ios.bundleIdentifier` なし）。
- Kabumori `account-delete` に Apple revoke はない（Kabumori アプリに Apple login がないため現状は不要）。
- 共通アカウントの完全削除では、この revoke を service 単位ではなく共通アカウント層へ移す必要がある。

### ambiguous migration population

件数は未取得。曖昧になる集団の定義は確定:

- `profiles` のみで実利用の証拠がない user（自動生成か実利用か判別不能）。
- `profiles` あり かつ user-facing workspace owner で、`profiles` の作成が membership より後（X user が Kabumori アプリを開いただけの可能性）。
- Auth-only（D）。X側に行がない social-mobile sign-up、email未確認の Kabumori sign-up、admin 専用 account が混在し、DBからは区別できない。
- internal workspace の membership / `admin_users` を持つ account。
- 同一 email を持つ別 Auth user、identity email が user email と異なる identity（件数のみ取得予定。自動 merge はしない）。

### recommended backfill rules（案。backfill は未実行）

- `common_accounts`: `auth.users` 1行につき1行。merge しない。email 一致での統合はしない。
- `kabumori` entitlement: `profiles` 行を持つ全 user を `active` で backfill（既存アクセスを壊さない側に倒す）。`source = 'legacy_profile'` と、実利用の証拠有無（`evidence`）を併記し、後から弱い候補だけ見直せるようにする。
- `x_autopost` entitlement: user-facing workspace（`social_mobile_user_v1` かつ id が本人の derived id と一致）の owner を backfill。`identity_verified` と `authorization_pending` を区別して記録。internal workspace の membership と `admin_users` は対象外。
- Auth-only: `common_accounts` のみ。entitlement は作らず、次回その app で認証した時の service 利用登録で作る。
- manual review: 上記 ambiguous 集団。件数が出てから閾値を決める。
- rollback: 新規テーブルの追加のみで既存列・既存 policy を変えないため、shadow 段階は drop で戻せる。
- 導入順: shadow table + backfill（誰も読まない）→ dual-write（`ensure_my_profile` と `begin_social_mobile_x_oauth_connection` で entitlement を同時作成）→ parity 監視 → 削除 scope 判定を entitlement に切替 → RLS / producer の enforcement を flag 付きで最後に。

### proposed implementation phases

1. schema 追加（`common_accounts` / `service_entitlements`、self-select RLS、client 書き込み不可、service 利用登録 RPC）。production は migration history が source とずれているため、単一ファイルを preflight 付きで適用（`db push` 不可）。
2. shadow backfill + dual-write + parity query。
3. 削除境界: X削除 scope の `profiles` proxy を entitlement に置換。Kabumori 退会を「`profiles` 削除（cascade）+ kabumori entitlement 終了」に変更し、Auth hard delete は「active entitlement が他にない」場合だけ共通の orchestrator 経由（X revoke / Vault purge / Apple revoke を含む）で行う。
4. 登録 / login UX: 各 app に service 利用登録ステップ、enumeration-safe な文言、Kabumori の `profiles` 自動生成を明示登録へ。
5. enforcement: RLS と service_role producer に entitlement active 条件を flag 付きで追加。

### candidate files / components to change later（列挙のみ。未編集）

Kabumori:
- signup / sign-in: `src/components/auth-screen.tsx`、`src/lib/auth.ts`
- AuthProvider / AuthGate / session restore: `src/providers/auth-provider.tsx`、`src/app/_layout.tsx`、`src/components/profile-recovery-screen.tsx`、`src/lib/supabase.ts`、`src/hooks/use-register-push-token.ts`
- ensure profile: `src/lib/auth.ts`、`ensure_my_profile`（新 migration で置換）
- password recovery: `src/lib/password-recovery.ts`、`src/hooks/use-recovery-link.ts`、`src/components/password-reset-screen.tsx`、`src/app/+native-intent.tsx`
- settings / 削除: `src/app/settings.tsx`、`src/lib/settings-menu.ts`、`src/lib/account-deletion.ts`、`src/lib/account-deletion-client.ts`、`supabase/functions/account-delete/*`、`apps/kabumori-web/pages/account-deletion.html`、`docs/mobile-release/ACCOUNT_LIFECYCLE.md`
- service start UI: `src/components/onboarding-screens.tsx`、`src/hooks/use-onboarding.ts`（現状は端末ローカルの紹介画面のみ。server 側の利用登録画面は存在しない）
- producer: `supabase/functions/send-push-notifications/index.ts`、`personalized-reports/index.ts`、`important-news-monitor/index.ts` と対応 RPC

X social-mobile:
- signup / sign-in: `apps/social-mobile/src/components/auth-screen.tsx`、`src/app/_layout.tsx`、`src/providers/auth-provider.tsx`、`src/domain/auth-flows.ts`
- Google / Apple / X login: `src/lib/auth-client-flows.ts`、`src/lib/supabase.ts`、`src/lib/session-storage.ts`、`app.json`
- linkIdentity / login methods: `src/app/login-methods.tsx`、`src/domain/account-security.ts`
- workspace provisioning: `src/features/onboarding/onboarding-gate.tsx`、`src/data/onboarding-repository.ts`、`src/domain/onboarding.ts`、`begin_social_mobile_x_oauth_connection`
- X posting OAuth start: `src/features/x-connect/use-x-connect.ts`、`src/app/accounts/index.tsx`、`supabase/functions/x-oauth-connect-user/*`
- 削除 preview / scope: `src/app/account-deletion.tsx`、`src/domain/account-deletion.ts`、`supabase/functions/social-mobile-account-delete/*`、`20260928160000_social_mobile_account_deletion_candidate.sql`
- backend: `supabase/functions/x-test-post/index.ts`、`_shared/brand/brand_context.ts`、`publish_guard.ts`、`social_mobile_history_access_reader.ts`

共通（新規）: service entitlement、common account lifecycle、account deletion orchestrator、Apple revoke の共通化、enumeration-safe UX。

admin: `apps/admin` は同じ Auth + `admin_users`。`profiles` を参照しない。admin を common account に含めるかは別判断。

### conflicts / pending PRs affecting implementation

- PR #65（G4、merge 保留）: `use-x-connect.ts`、`onboarding-gate.tsx`、`accounts/index.tsx` を変更。X posting OAuth start / provisioning の候補ファイルと重なる。
- G3 branch `claude/g3-deletion-ui-finish-20261001`（in_progress）: `login-methods.tsx`、`(tabs)/settings.tsx` を変更。login methods / 削除導線の候補と重なる。
- PR #41（Stage 3B prep）: `x-test-post/index.ts` と X account publish authority の新 migration。X service_role path の候補と重なる。
- PR #66（H2 review中）: `x-test-post/index.ts`。
- PR #33（admin password recovery）: `apps/admin` の auth 経路。
- PR #67（G2）: 候補ファイルとの重なりは検出されず。
- 実装 Phase は #65 と G3 の決着後に着手するのが安全。G5 はいずれも変更していない。

### tests / checks / read-only queries used（secret / PIIなし）

- source 調査: Kabumori 側・X 側を別々に read-only で棚卸し（path:line 付き）。削除 scope 判定、finalize、`account-delete`、`ensure_my_profile`、AuthProvider、workspace 作成 RPC、Apple revoke 条件、unique index は G5 が直接再読して確認。
- production クエリ（未実行）: `00_schema_catalog`（catalog のみ）、`01_auth_identity`、`02_population`、`03_x_workspace`、`04_vault_reference_integrity`、`05_deletion_state`、`06_migration_history`、`07_cron_jobs`（command 列は取得しない）、`08_key_function_definitions`、`09_legacy_token_store`、および `supabase functions list`。出力は件数・schema metadata・関数定義のみ。
- GitHub: open PR の変更ファイル一覧を read-only で確認。

- remaining_issues:
  - production 集計と production 照合がすべて未取得（上記の「未取得」項目）。
  - production の function deploy 状態（特に `account-delete`）、migration 適用履歴、Auth provider 設定、Apple revoke env の有無。
  - `x-test-post` の起動元 cron は repo 外で設定されている可能性（source に `cron.schedule` なし）。
- safety_checks: production mutation 0。production read 0。Vault secret 読み取り 0。Auth / identity / OAuth / deploy / merge / flag 変更 0。他slotの TASK / branch / PR 変更 0。source / runtime code 変更 0。Report に email / UUID / handle / platform user id / token / secret を含めていない。
- next_recommendation: production read の扱いをユーザーが決める（G5 に read を許可する、またはユーザーが `.g5-phase0/run.sh` を実行して出力を G5 に渡す）。出力が揃い次第、G5 が件数を埋めて `review_required` にする。`account-delete` の deploy 状態が「deploy 済み」と確認できた場合は、K5 で H1/H2 review 要否の判断を推奨（上記 deletion finding 1）。
