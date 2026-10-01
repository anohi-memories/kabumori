# Claude Task 5 — CURRENT TASK

- task_id: common-account-v1-phase1-additive-lifecycle-foundation-20261001
- owner: claude
- slot: claude-5
- status: in_progress
- next_owner: chatgpt
- priority: highest
- start_code: G5
- finish_code: K5
- recommended_model: Opus5.5（極高）
- type: architecture + additive schema/lifecycle foundation source candidate
- production_mutation_allowed: false

## Purpose

共通アカウントv1 Phase 1として、Phase 0 inventoryとH1/C1の削除境界レビューを踏まえ、**additiveでrollback可能な共通アカウント / service entitlement / lifecycle serialization基盤のsource候補**を作る。

このTASKはsource・migration candidate・disposable testまで。
**production migration apply / backfill / deploy / RLS enforcement / real Auth deletionは禁止。**

中心設計：

```text
auth.users.id
= 共通本人ID

common_accounts
= 共通アカウントapplication state

service_entitlements
= service利用登録

public.profiles
= Kabumori固有rootのまま

brand_memberships
= X workspace authorization / roleのまま
```

各アプリの新規登録は将来：

```text
共通アカウント作成 / 既存共通アカウント認証
+
そのアプリのservice entitlement作成
```

Kabumoriから初回登録 → common account + kabumori entitlement。
X自動投稿から初回登録 → common account + x_autopost entitlement。
既存common accountが別serviceへ来た場合 → 本人認証後、そのservice entitlementだけ作る。

## H1/C1 accepted safety constraint

既存Kabumori account-deleteは、事前readだけを追加しても安全にならない。

理由：

1. Kabumori側が「X footprintなし」をread
2. 並行してauthenticated userがX workspace/membership/OAuth stateを作成
3. Kabumoriが別requestでAuth hard delete
4. membership/stateだけcascadeし、workspace/social account/authorization/Vault等が残り得る

したがってPhase 1では、削除/利用開始を直列化できる**明示的なlifecycle state / lock / durable deletion intent**を設計対象に含める。

「最後にもう一度SELECTする」だけの修正は禁止。
既存X deletion acquisitionをKabumoriへそのまま流用するのも禁止。

## Mandatory startup / isolation

開始前に必ず確認：

- PROJECT_RULES.md
- HANDOFF.md
- .agent/ORCHESTRATION.md
- .agent/CURRENT_STATE.md
- .agent/ACTIVE_TASK.md
- このG5 TASK
- G1〜G4 / H1 / H2 TASK + Report
- git status
- git worktree list
- fresh origin/main
- open PR changed files

G5専用の独立worktree / checkoutを使用。

### Competition state at assignment

- G3: account deletion UI fixはFinal K3 PASS・PR #68 merge済み。runtime deletion backendは変更していない。
- G4: PR #65 X posting OAuth account-switch。source/securityはaccepted済みだが、provider-side operator E2E待ち。G4の5ファイルは触らない。
- H1: deletion safety reviewはC1で閉じる。runtime candidateなし。
- G1/G2: Kabumori Home / report系。Auth/lifecycle scopeと競合しないことをfresh確認する。
- H2: fresh statusを確認。

競合/ownership不明ならSTOP。

## Phase 1 scope

### A. Additive schema candidate

新規migration candidateとして最低限：

1. `common_accounts`
2. `service_entitlements`
3. lifecycle / deletion serialization primitive

候補例：

```text
common_accounts
  user_id PK/FK auth.users
  status active/deleting/locked
  lifecycle_version
  timestamps

service_entitlements
  user_id
  service_key
  status provisioning/active/suspended/deleting/ended
  source
  activated_at
  ended_at
  timestamps
  PK(user_id, service_key)

account_lifecycle_operations
  id
  user_id
  operation_type
  status
  current_step
  started_at
  updated_at
  last_error_code
```

名前・列はレビューの上で調整してよい。

重要：

- additiveのみ
- existing table rename/drop禁止
- profiles / brand_memberships置換禁止
- migration historyの不整合を前提に、単一migration candidate + exact preflightを設計
- production db push禁止

### B. Lifecycle serialization contract

次を同時に満たす設計を作る：

- service利用開始中はcommon account whole-deleteと競合しても片方がfail closed
- common account deleting中は新規service entitlement/provisioningを開始できない
- service-only deletionは他service/Authを残す
- common account deletionは全active service cleanup完了後のみAuth hard delete可
- admin/shared/unknown状態はfail closed
- stale/retry/idempotencyを考慮
- external OAuth revoke/Vault purge等はSaga stepとして扱い、DB transactionで全外部処理を原子的に扱ったふりをしない

必要なら advisory lock / row lock / lifecycle_version / durable operation row を組み合わせる。
**Auth hard delete直前までのserialization guaranteeを明文化**する。

### C. Service start / stop RPC contract candidate

少なくともsource candidateまたはSQL contractとして：

- start_kabumori_service
- start_x_autopost_service
- begin/mark service deleting
- finish service deletion
- begin common account deletion
- common account deletion eligibility/read model

を検討する。

ただし既存client wiringはこのTASKでは最小限または0でよい。
G4 filesは触らない。

### D. RLS / grants design

新tableについて：

- exposed schemaならRLS必須
- authenticated userは自分のcommon account / entitlementをreadできる
- clientから任意status/user_idを書き換えられない
- writeは限定RPC/backend境界
- TRUNCATE / REFERENCES / TRIGGER等の不要grantを明示revoke
- SECURITY DEFINERが必要ならpublic exposure/EXECUTE PUBLICを避ける
- fixed search_path
- auth.uid ownership check
- service_role依存を必要最小限

既存Kabumori/X RLS enforcementはまだ変更しない。
新しいhelperを既存policyへ差し込むのはPhase 2以降。

### E. Shadow backfill candidate

Phase 0のproduction aggregateを前提に、**productionでは実行しない**backfill SQL candidateを作る。

ルール：

- common_accounts: existing auth.usersごとに1
- kabumori entitlement: legacy profilesをactive候補。source='legacy_profile'等、実利用証拠の弱いrowを区別可能にする
- x_autopost entitlement: user-facing social_mobile_user_v1 self-service workspace ownerだけ
- internal workspace/adminはconsumer x_autopost entitlementにしない
- Auth-only userはcommon accountのみ
- email一致でuser mergeしない

backfillはidempotent / dry-run count可能にする。

### F. Deletion safety future adapter contract

既存Kabumori account-deleteをこのTASKでproduction-safeと宣言しない。

source候補として必要なら：

- legacy Kabumori hard-delete routeをcommon lifecycleへ委譲するadapter設計
- service-only Kabumori withdrawal
- whole common account deletion orchestrator

の境界を明文化/テストする。

ただしX revoke/Vault purge/Apple revokeの実処理を重複実装しない。
既存social-mobile deletion adapterを将来どう呼ぶかはcontract化まで。

### G. Registration/login future contract

設計・tests/docsレベルで：

- appから新規登録 → common account作成/確認 + service entitlement
- existing common ID → login後、対象serviceのみ利用登録
- login前のemailで既存account存在を断定しない
- identity linkingは同一Auth userのみ
- email一致だけで別Auth userをmergeしない
- X login identity ≠ X posting authorization
- Apple loginを共通account削除する際のrevoke step

を固定する。

## Do not touch in Phase 1

- G4 PR #65 files:
  - apps/social-mobile/src/features/x-connect/use-x-connect.ts
  - related auth-session option/test
  - accounts/onboarding copy owned by G4
- production DB
- production Auth users
- production Vault secret
- production OAuth
- provider settings
- real X accounts
- current cron
- existing Kabumori/X service data
- profiles/brand_memberships rename/drop
- existing RLS enforcement
- account deletion production deploy
- existing user backfill
- identity link/unlink

## Required testing

Use disposable/local PostgreSQL or equivalent safe test environment.

最低限：

1. migration applies cleanly to representative schema
2. re-apply/idempotency strategy is explicit
3. RLS/grants least-privilege checks
4. common account active -> service start allowed
5. common account deleting -> service start denied
6. service provisioning vs common delete concurrency both commit orders are safe
7. service-only deletion leaves other entitlement/Auth intact
8. whole-account deletion cannot finalize while active/provisioning service remains
9. admin/shared/unknown fail closed where contract applies
10. backfill dry-run counts/classifications
11. no email-based merge
12. no client arbitrary entitlement creation/status change
13. git diff --check / SQL static checks / relevant unit tests

Race safetyは単なる逐次mockだけでなく、可能なら2セッションPostgreSQL testで証明する。

## Deliverables

- versioned migration candidate
- focused tests
- design note / comments sufficient for lifecycle invariants
- production rollout plan（未実行）
- rollback plan
- exact list of Phase 2 client/backend integration points
- Report

## Completion / K5

Reportに：

- task_id
- result PASS / PARTIAL / BLOCKED
- checked_main
- worktree/isolation
- schema candidate
- lifecycle serialization invariant
- RLS/grant model
- backfill candidate + dry-run proof
- concurrency/race proof
- changed_files
- tests
- commit/PR
- production mutation = 0
- pending conflicts
- remaining unknowns
- rollout/rollback plan
- next recommendation

完了時 status -> review_required / next_owner -> chatgpt / STOP for K5。

Auth/RLS/migration/lifecycleを横断する高リスクsource candidateなので、K5後は原則Sol（高）以上のCodexレビューを入れる。

## Report

- task_id: common-account-v1-phase1-additive-lifecycle-foundation-20261001
- result: pending
- changed_files: pending
- tests: pending
- commit_hash: pending
- push: pending
- deploy: prohibited
- production_mutation: 0 expected
- remaining_issues: pending
- safety_checks: pending
- next_recommendation: G5 Phase 1を開始する。

---

## Previous completed G5 task history — preserved below

# Claude Task 5 — CURRENT TASK

- task_id: common-account-v1-phase0-prod-readonly-inventory-20261001
- owner: claude
- slot: claude-5
- status: done
- next_owner: none
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

- task_id: common-account-v1-phase0-prod-readonly-inventory-20261001
- result: **PASS**（Phase 0 の A〜H を repository + production で確認。未確認事項は `remaining_issues` に明記）
- checked_main: 開始時 `5414791`。Report push 直前に fresh `origin/main` を再確認。
- worktree / isolation: G5専用 worktree（`.claude/worktrees/g5-f7a405`）、branch `claude/g5-common-account-phase0-20261001`（`origin/main` 基点）。他slotの worktree / branch / PR / TASK は未変更。用意されていた worktree branch は `origin/main` と分岐した古い基点（2096 commit 遅れ）だったため、`origin/main` から branch を切り直した（旧branchは未変更で残置）。
- production_mutation: **0**。
- production read の実行者: **ユーザー本人**。Claude セッションの auto mode が production read を拒否したため、G5 は単一SELECTのクエリ10本と runner を用意し、ユーザーが自分の端末で実行した。G5 は出力ファイル（件数・schema metadata・関数定義のみ）を読んだ。回避操作はしていない。
- changed_files: `.agent/tasks/CLAUDE_TASK_5.md` のみ。クエリ一式と出力は worktree 内の未追跡ディレクトリ `.g5-phase0/` にあり、commit していない。
- tests: クエリ10本を使い捨てローカルPostgreSQL（偽データのみ）で事前に全件実行成功。production では 9本が初回成功、`03_x_workspace` は production に存在しないテーブルを参照して失敗 → 該当 read-only SQL だけ修正して再実行し成功。runner は実行前に各ファイルが「単一SELECT・書き込み語なし・`decrypted_secrets` 不使用」であることを検査する。
- commit_hash: 本 Report の commit（push 後の `origin/main` HEAD）。
- push: `origin/main` へ fast-forward。
- deploy: none（prohibited）。

### 最重要 finding（K5 で判断を推奨。修正はしていない）

1. **Kabumori `account-delete` は production に deploy 済みで ACTIVE**（`verify_jwt = true`、最終更新 2026-09-24）。処理は service role による Auth hard delete 1回だけで、X側（workspace / social account / Vault / X authorization revoke）を一切扱わない。再認証なし、server 側 feature flag なし、audit なし、admin guard なし。
   - 現在「Kabumori と X の両方を持つ user」は 0人のため、孤児 workspace / 未revoke の X authorization は発生していない。経路は稼働中。
   - 現在 `admin_users` の 1人は Kabumori の `profiles` と実利用データを持つ。その account が Kabumori アプリの退会を実行すると `admin_users` 行も cascade で消える（X側削除は同じ状況を `ADMIN_ACCOUNT` で block している）。
2. **X削除の scope 判定は production でも `profiles` 行の有無**（`social_mobile_account_deletion_scope` と `finalize` を production の関数定義で確認）。`profiles` は Kabumori アプリが受け入れた全 session で自動生成されるため、利用登録の証拠として弱い。
3. **`device_push_tokens` は production でも service_role に SELECT しか grant されていない。** `send-push-notifications` の無効 token DELETE は権限上成立しない（RLS は迂回しても table grant は必要）。今回の範囲外。

### Auth / identity aggregate（production）

| 項目 | 件数 |
| --- | --- |
| Auth user 総数 | 4 |
| identity 総数 | 4 |
| provider 別 identity | email 4 / google 0 / apple 0 / x 0 / その他 0 |
| 複数 identity を持つ user | 0 |
| provider 組み合わせ | email のみ 4 |
| identity なし user | 0 |
| soft-deleted / anonymous / SSO / banned | 0 / 0 / 0 / 0 |
| email 未確認 / email なし | 0 / 0 |
| 最終 sign-in | 4人とも直近30日以内 |
| 同一 email を持つ別 user の組 | 0 |
| identity email が user email と異なる identity | 0 |

- 異常状態は検出されず。自動 merge 候補の判定は行っていない。
- `auth.users` への trigger（非internal）は production に存在しない。
- Auth provider の enabled / callback 設定は未確認（設定読み出しは secret 露出の可能性があるため実施せず）。identity の実績としては email のみ。

source から:
- Kabumori アプリの login は email + password のみ。
- social-mobile は email / Google / Apple / X。X・Google は browser OAuth（PKCE）、Apple は iOS native（`signInWithIdToken`）＋他platformは browser。`app.json` に `ios.bundleIdentifier` がなく native Apple は build 未設定。provider は `GET /auth/v1/settings` で有効 かつ `EXPO_PUBLIC_AUTH_PROVIDERS` に宣言されたものだけ表示（default は email のみ）。
- `unlinkIdentity` は social-mobile のどこからも呼ばれない。`linkIdentity` は login-methods 画面のみ。

### A/B/C/D population aggregate（production、4 user）

「あり」の定義を3通りで集計した。

| 定義 | A: Kabumoriのみ | B: Xのみ | C: 両方 | D: どちらもなし |
| --- | --- | --- | --- | --- |
| 1. `profiles` 行あり × user-facing workspace の owner | 2 | 1 | 0 | 1 |
| 2. `profiles` 行あり × `brand_memberships` 任意 | 2 | 1 | 0 | 1 |
| 3. Kabumori 実利用あり × user-facing workspace の owner | 1 | 1 | 0 | 2 |

- 定義1と3の差は「`profiles` だけあって実利用の証拠がない user」1人。
- D（定義1）の 1人は `profiles` も membership も `admin_users` も持たない Auth-only user。

### Kabumori legacy classification（production）

| 分類 | user 数 |
| --- | --- |
| `profiles` あり | 2 |
| profile のみ（実利用の証拠なし） | 1 |
| `tracked_stocks` あり（うち active） | 1（1） |
| `alert_settings` 行あり | 1 |
| `alert_category_settings` あり | 1 |
| `notifications` あり | 1 |
| `device_push_tokens` あり | 1 |
| `personalized_reports` あり | 1 |
| `profiles` なしで Kabumori データあり | 0 |

- 実利用の証拠がある 1人が上記すべてを持つ。この user は `admin_users` にも属する。
- `profiles` 作成時期: sign-up から10分以内 1、それ以降 1。
- `profiles` は利用登録の証拠として弱い: Kabumori アプリが受け入れた全 session で `prepareSession -> ensureProfile -> ensure_my_profile` が走り `profiles(id)` を無条件に作る（cold start、全 `onAuthStateChange`、sign-in、password recovery link 経由を含む）。「Kabumoriを始める」明示ステップは存在しない。`ensure_my_profile` は production に存在（SECURITY INVOKER、authenticated のみ実行可、本体は repo と一致）。
- `ensure_my_profile` が作るのは `profiles` だけ。`alert_settings` 等は後続の client 操作で作られる。
- 注: `alert_settings` の「default から変更済み」判定は初期9列だけを見た（結果 0）。production には `market_critical_news` / `notification_preset` / `emergency_alerts` の3列が追加されており、この3列は判定に含めていない。

### X legacy classification（production）

workspace（`brands`）4件:

| `code_profile_key` | 種別 | 件数 | `is_active` / `publish_mode` |
| --- | --- | --- | --- |
| `social_mobile_user_v1` | 一般ユーザー workspace（id は `u_` + 24桁hex） | 1 | false / disabled |
| `kabumori_v1` | internal | 1 | true / live |
| `ai_salaryman_lab_v1` | internal | 1 | true / live |
| `mio_v1` | internal | 1 | false / disabled |

| 項目 | 件数 |
| --- | --- |
| user-facing workspace | 1 |
| user-facing owner membership / distinct user | 1 / 1 |
| `brand_memberships` 総数 | 1（internal workspace の membership は 0） |
| social account 総数 | 3（user-facing 1、internal 2） |
| `identity_verified` | 3 |
| `publish_enabled = true` | 2（internal のみ。user-facing は false） |
| Vault 参照あり（access / refresh） | 2 / 2（user-facing 1、internal 1） |
| user-facing workspace で予約投稿あり | 0 |
| `(platform, platform_user_id)` 重複 | 0 |

- `x_autopost` entitlement backfill 候補の定義: `code_profile_key = 'social_mobile_user_v1'` かつ id が本人の derived id（`'u_' || substr(md5(user_id), 1, 24)`）と一致する workspace の owner。該当 1人（`identity_verified`）。
- internal 3 workspace は membership を持たず、`admin_users` と service role で運用されている。consumer entitlement の対象外。
- workspace は login 時ではなく初回の「Xを連携」開始時に `begin_social_mobile_x_oauth_connection` が作る。social-mobile に sign-in しただけの user は X側に行がない。
- production の `begin_social_mobile_x_oauth_connection` は repo の最新定義と一致（rollout runbook 記載の md5 と同じ値）。

### ownership findings

production の catalog で確認（source と一致）:

- `auth.users` への FK（public schema）: `profiles.id`、`admin_users.user_id`、`brand_memberships.user_id`、`social_account_oauth_states.initiated_by_user_id`。すべて ON DELETE CASCADE。
- `profiles` への FK: `tracked_stocks` / `alert_settings` / `alert_category_settings` / `notifications` / `device_push_tokens` / `personalized_reports`。すべて `user_id -> profiles(id)` ON DELETE CASCADE。`profiles` 行の削除だけで Kabumori データは全 cascade し、Auth user は残せる。
- `brands` への FK: `brand_memberships` と `daily_content_plans` だけ CASCADE。`social_accounts` / `scheduled_posts` / `post_execution_logs` / `posting_windows` / `publish_claims` / `published_content_fingerprints` / `social_account_oauth_states` / 各 report settings・runs は NO ACTION。
- `social_accounts` への FK: `social_account_oauth_states` / `x_account_refresh_state_v2` / `x_account_refresh_rollout` / `published_content_fingerprints`。すべて NO ACTION。
- `brands` / `social_accounts` / Vault secret は `auth.users` を参照しない。X の ownership chain は `auth.users.id -> brand_memberships(user_id, role='owner') -> brands.id -> social_accounts.brand_id -> vault_*_secret_id -> vault.secrets`。`social_accounts` に user 列はない。
- unique: `social_accounts (brand_id, platform)`、partial unique `(platform, platform_user_id) where platform_user_id is not null`、`brand_memberships (brand_id, user_id)`。1つのXアカウントは全体で1行にしか結び付かない。
- X login identity の subject と `social_accounts.platform_user_id` を突き合わせる処理は存在しない（login identity と posting authorization は分離済み）。

孤児候補（production）:

| 検査 | 件数 |
| --- | --- |
| brand のない membership | 0 |
| brand のない social account | 0 |
| member のいない user-facing workspace | 0 |
| owner のいない user-facing workspace / その social account | 0 / 0 |
| social account のない user-facing workspace | 0 |
| owner が複数 / member が複数の user-facing workspace | 0 / 0 |
| 複数の user-facing workspace を持つ user | 0 |
| id pattern と `code_profile_key` の不一致 | 0 |

schema 再現性:
- `brands` / `social_accounts` / `brand_settings` / `social_account_oauth_states` の `create table` は main の migrations に存在しない（未マージ branch `feature/multibrand-foundation` と test fixture のみ）。
- production の migration history は 58 version。repo の migration file は 99。一致は 31（最後の一致は `20260905140638`）。repo にあって history にない 68 件の中には、production に object が存在するもの（`ensure_my_profile`、`brand_memberships`、X OAuth onboarding、削除 candidate など）が含まれる。history にあって repo に file がない version が 27 件。**migration history は適用状態の指標として使えない。**
- production に未適用と確認できたもの: `social_mobile_content_settings`（table なし）、`scheduled_posts.social_account_id`（列なし = v2 account-bound queue 未適用）。
- deploy 済みだが main に source directory がない Edge Function: `x-oauth-connect`、`brand-post-dry-run`、`stocks-master-sync`、`stocks-new-listing-sync`。

### deletion / cascade findings

Kabumori（`account-delete`、production deploy 済み）:
- bearer を `/auth/v1/user` で検証し、その user id に対して `DELETE /auth/v1/admin/users/{id}`（hard delete）を1回。request body は読まない。
- Kabumori データは `profiles` 経由の cascade で消える。
- 同時に `brand_memberships`、OAuth state、`admin_users` も cascade で消える。`brands` / `social_accounts` / Vault secret は残り、X authorization は revoke されない。
- 再認証なし（email 再入力は client 側のみ）、feature flag なし、audit なし、admin guard なし、session revoke なし。再試行は「404 を成功扱い」のみ。

X（`social-mobile-account-delete`、production deploy 済み、`verify_jwt = true`）:
- scope: `profiles` あり → `social_only`、なし → `social_and_login`。`finalize` でも同じ判定で `auth.users` を削除。
- 順序: bearer 検証 → 確認文字列 → 直近認証（JWT `amr` 600秒以内）→ scope 検証 → tombstone + lease 取得（同時に posting 停止）→ credential 取得 → X revoke（refresh → access）→ fingerprint 照合 → （該当時）Apple revoke → purge（refresh state → OAuth state → posts → `social_accounts` → `vault.secrets` → `brands`）→ finalize。
- state: `started -> x_revoked -> purged`、異常時 `operator_required`。lease と state で再試行は冪等。
- blocker: `ADMIN_ACCOUNT` / `OWNS_OTHER_WORKSPACE` / `WORKSPACE_NOT_SELF_SERVICE` / `SHARED_WORKSPACE` / `WORKSPACE_ROLE_MISMATCH` / `POSTING_IN_PROGRESS` / `CREDENTIAL_REFRESH_IN_PROGRESS` / `CREDENTIAL_OWNERSHIP_AMBIGUOUS`。
- feature flag は client 側のみ（`EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED`）。server 側は deploy されていること自体が gate。
- session pinning は client 側のみ。server は bearer `sub` + lease。
- `social_mobile_account_deletions.user_id` は `auth.users` への FK を持たない。

production の削除実績（audit、件数のみ）:
- 進行中 tombstone: 0。
- audit 20 行、distinct subject 2。`requested` 4 / `started` 4 / `x_revoked` 4 / `purged` 4 / `completed_social_only` 3 / `completed`（login も削除）1。`blocked` / `failed` / `operator_required` は 0。

現行の危険な境界:
1. Kabumori 側の hard delete が X を知らない（上記「最重要 finding 1」）。
2. `profiles` proxy（「最重要 finding 2」）。境界ケース:
   - X専用 user が Kabumori アプリに一度 sign-in すると `profiles` が自動生成され、以後 X削除は `social_only`（login が残る）。現在の X専用 user 1人は `profiles` を持たないため、今は `social_and_login` と判定される。
   - Kabumori user が social-mobile に sign-in しただけ（workspace なし）だと `social_only` で消すものがない。
   - social-mobile のみ・workspace なしの user は login ごと削除される。
3. 2つの削除経路が同じ Auth user を別々の条件で hard delete できる。共通の orchestrator がない。

### RLS / service_role findings

production の policy は source と一致。対象 22 table はすべて RLS enabled（forced ではない）。

client RLS（Kabumori）: `profiles` は `auth.uid() = id`、他 6 table は `auth.uid() = user_id`（`personalized_reports` は加えて `status = 'completed'` と `fact_status = 'passed'`）。共有 Auth project の authenticated user なら誰でも通る。service 利用登録の検査はない。

client RLS（X）: `brand_memberships` は self-select のみ。`brands` / `social_accounts` / `scheduled_posts` / `post_execution_logs` / `posting_windows` は membership（任意 role）で select。admin 用 policy（`private.is_admin()`）が `scheduled_posts` / `post_execution_logs` / `posting_windows` に並存。書き込みは SECURITY DEFINER RPC 経由。

`auth.uid()` を使う production 関数（8件）: `private.is_admin`、`begin_` / `consume_` / `complete_social_mobile_x_oauth_connection`（DEFINER、authenticated のみ）、`ensure_my_profile`（INVOKER）、`set_my_important_news_alert_preferences`（INVOKER）、`get_my_important_stock_news`（DEFINER）、`get_my_important_stock_news_phase5_base`（DEFINER、どの role にも実行権なし）。

`social_mobile_account_deletion_*` は production で service_role のみ実行可（内部 helper はどの role にも実行権なし）。authenticated / anon からは実行不可。

将来「ownership 条件 + entitlement active」が必要になる候補:

- Kabumori client path: 上記 7 table の全 policy、`ensure_my_profile`、`set_my_important_news_alert_preferences`、`get_my_important_stock_news`、`get_daily_kabumori_tip`（user 検査のない SECURITY DEFINER）。
- Kabumori service_role producer（RLS 迂回）: `claim_pending_push_notifications`、`enqueue_important_news_notifications`（wrapper と base）、`enqueue_personalized_report_notification`、`personalized_report_news_inputs`、`important_news_app_copy_targets`、`personalized-reports` function の `tracked_stocks` cohort query。どの producer も `profiles` を列挙しない。population の鍵は `tracked_stocks` / `alert_settings` / pending `notifications` / `device_push_tokens`。production の cron に `send-push-notifications-dispatch`（毎分）、`personalized-reports-morning` / `-close`（平日）が存在。
- X client path: `begin_social_mobile_x_oauth_connection`（authenticated なら誰でも workspace を作れる）、`consume_` / `complete_`、membership select policy 群。
- X service_role path: `x-test-post` dispatcher（repo 定義の `claim_due_post` は brand filter なしで最古の pending を取る。production の本体は未照合）、Vault credential / refresh RPC、`read_social_mobile_history_access_token`（user + owner membership を見る唯一の service-role path）。production の cron に `dispatch-scheduled-posts`（毎分）が存在（job 名からの推定。command 列は読んでいない）。一般ユーザー `u_` workspace は現状 publish できない（inactive / disabled、予約投稿 0）。この経路を開ける時点が entitlement 検査の挿入点。

付随的な気付き（範囲外、未修正）:
- `device_push_tokens`: service_role は SELECT のみ（「最重要 finding 3」）。
- `social_accounts` の SELECT grant は table 全体。member は Vault secret id 列（参照値）を読める。client は非secret 列だけ select している。
- `TRUNCATE` / `REFERENCES` / `TRIGGER` が `authenticated` に残っている table が多い（`profiles`、`tracked_stocks`、`alert_settings`、`brand_memberships` など）。`anon` にも `admin_users` / `scheduled_posts` / `post_execution_logs` / `posting_windows` / `daily_content_plans` で残っている。Data API には TRUNCATE を発行する手段がないため直ちに悪用可能とは考えにくいが、検証はしていない。entitlement 用の新 table では明示的に revoke することを推奨。

### OAuth / Vault findings（secret なし）

- posting token 本体は `vault.secrets`。`social_accounts.vault_access_token_secret_id` / `vault_refresh_token_secret_id` は参照のみ。
- `x-oauth-connect-user` は service role を使わず user JWT で RPC を呼ぶ。refresh は dispatcher 側のみ。
- legacy Kabumori 投稿は `oauth_token_store`（暗号化済み列、production に 1 行）+ env token で、Vault ではない。internal social account 1件は `identity_verified` だが Vault 参照を持たない（この legacy 経路）。

production 集計（`vault.secrets` は `id` 列のみ比較。secret 本体・name・復号 view は読んでいない）:

| 項目 | 件数 |
| --- | --- |
| `vault.secrets` 総数 | 20 |
| access 参照 / うち orphan | 2 / 0 |
| refresh 参照 / うち orphan | 2 / 0 |
| 複数 account が共有する参照 | 0 |
| OAuth state の verifier 参照 / うち orphan | 10 / 0 |
| consume 済みまたは期限切れなのに Vault に残る verifier | 10 |
| 上記3列から参照されない secret | 6（用途未調査） |
| `x_account_refresh_state_v2` 行 | 1 |

OAuth transient state（22 行）:

| 所有 | 状態 | 件数 | initiator | verifier 参照 |
| --- | --- | --- | --- | --- |
| user-facing workspace | consumed | 6 | あり | なし |
| user-facing workspace | 期限切れ・未consume | 6 | あり | なし |
| internal workspace | consumed | 6 | なし | あり |
| internal workspace | 期限切れ・未consume | 4 | なし | あり |

- user-facing の state は `initiated_by_user_id` を持ち、PKCE verifier を server に保存しない（source と一致）。
- internal の 10 行は admin 用 connect（`x-oauth-connect`、main に source なし）由来とみられ、verifier を Vault に保存し、完了・期限切れ後も 10 件すべて残っている。
- state 行は consume / 期限切れ後も削除されない。消すのは X削除の purge だけ。定期 cleanup は存在しない。

### Apple revoke readiness

- 実装は `social-mobile-account-delete` のみ（`apple_revoke.ts`）。authorization code を token endpoint で交換 → `id_token` の subject が本人の Apple identity であることを確認 → revoke endpoint。
- 適用条件は `scope === 'social_and_login'` かつ provider に apple を含む場合だけ。`social_only` では revoke しない。
- 必要 env がなければ `APPLE_REVOCATION_UNAVAILABLE` で fail closed。production の env 設定有無は未確認（secret 一覧は読んでいない）。
- sign-in 時の authorization code は破棄、Apple refresh token は保存していない。削除時に native iOS で再認証して code を取り直す前提。
- native Apple は build 未設定（`ios.bundleIdentifier` なし）。
- production の Apple identity は **0 件**。現時点で Apple revoke が必要な user はいない。
- Kabumori `account-delete` に Apple revoke はない（Kabumori アプリに Apple login がないため現状は不要）。
- 共通アカウントの完全削除では、この revoke を service 単位ではなく共通アカウント層へ移す必要がある。Apple login を公開する前に実装・検証が必要。

### ambiguous migration population（production）

| 集団 | 件数 |
| --- | --- |
| `profiles` のみで実利用の証拠がない user | 1 |
| `profiles` と user-facing workspace の両方を持つ user | 0 |
| Auth-only（どちらもなし） | 1 |
| `admin_users` に属する user（Kabumori 実利用あり） | 1 |
| internal workspace の membership を持つ user | 0 |
| 同一 email の別 user / identity email の不一致 | 0 / 0 |

manual review 対象は 4人中 2人（profile のみ 1、Auth-only 1）。Auth-only の 1人が social-mobile の sign-up なのか Kabumori の sign-up なのかは DB から区別できない。

### recommended backfill rules（案。backfill は未実行）

| 規則 | 現時点の該当数（dry-run） |
| --- | --- |
| `common_accounts`: `auth.users` 1行につき1行。merge しない | 4 |
| `kabumori` entitlement: `profiles` 行を持つ user を `active` で backfill。`source = 'legacy_profile'` と実利用の証拠有無を併記 | 2（証拠あり 1、profile のみ 1） |
| `x_autopost` entitlement: user-facing workspace（`social_mobile_user_v1` かつ derived id 一致）の owner。`identity_verified` / `authorization_pending` を区別 | 1（`identity_verified`） |
| entitlement なし（`common_accounts` のみ）。次回その app で認証した時の利用登録で作る | 1 |
| manual review | 2 |

- internal workspace の membership と `admin_users` は entitlement の対象外。admin が Kabumori を使っている場合は通常の `kabumori` entitlement を別途持つ（現状 1人）。
- email 一致での統合はしない。
- rollback: 新規 table の追加のみで既存列・既存 policy を変えないため、shadow 段階は drop で戻せる。
- 導入順: shadow table + backfill（誰も読まない）→ dual-write（`ensure_my_profile` と `begin_social_mobile_x_oauth_connection` で entitlement を同時作成）→ parity 監視 → 削除 scope 判定を entitlement に切替 → RLS / producer の enforcement を flag 付きで最後に。
- population が 4人と小さいため、backfill は件数照合を全数で行える。

### proposed implementation phases

1. schema 追加（`common_accounts` / `service_entitlements`、self-select RLS、client 書き込み不可、`TRUNCATE` 等を明示 revoke、service 利用登録 RPC）。production は migration history が source とずれているため、単一ファイルを preflight 付きで適用（`db push` 不可）。
2. shadow backfill + dual-write + parity query。
3. 削除境界: X削除 scope の `profiles` proxy を entitlement に置換。Kabumori 退会を「`profiles` 削除（cascade）+ kabumori entitlement 終了」に変更し、Auth hard delete は「active entitlement が他にない」場合だけ共通の orchestrator 経由（X revoke / Vault purge / Apple revoke / admin guard / 再認証 / audit を含む）で行う。Kabumori `account-delete` は deploy 済みのため、この Phase を待たずに admin guard と X workspace 保有時の fail-closed だけ先行する選択肢がある。
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

Report 時点の fresh `origin/main` と open PR で確認。

- PR #65（G4、open、merge 保留）: `use-x-connect.ts`、`onboarding-gate.tsx`、`accounts/index.tsx`。X posting OAuth start / provisioning の候補と重なる。
- PR #68（G3 の削除 UI 仕上げ、open）: `login-methods.tsx`、`(tabs)/settings.tsx`。login methods / 削除導線の候補と重なる。
- PR #41（Stage 3B prep、open）: `x-test-post/index.ts` と X account publish authority の新 migration。X service_role path の候補と重なる。
- PR #33（admin password recovery、open）: `apps/admin` の auth 経路。
- PR #66 / #67 は調査中に merge 済み。merge 後の main でも、Auth / 削除 / X OAuth / social-mobile / migrations の候補ファイルに変更はない。#66 が触れた `x-test-post/index.ts` は X service_role path の候補。
- 実装 Phase は #65 と #68 の決着後に着手するのが安全。G5 はいずれも変更していない。

### tests / checks / read-only queries used（secret / PII なし）

- source 調査: Kabumori 側・X 側を read-only で棚卸し（path:line 付き）。削除 scope 判定、finalize、`account-delete`、`ensure_my_profile`、AuthProvider、workspace 作成 RPC、Apple revoke 条件、unique index、再認証窓は G5 が直接再読して確認。
- production クエリ（ユーザー実行、すべて単一 SELECT）:
  - `00_schema_catalog`: table / 列 / FK / unique / policy / grant / 関数の属性 / `auth.users` trigger（catalog のみ）
  - `01_auth_identity`: user・identity の件数集計
  - `02_population`: A/B/C/D と Kabumori / X の flag 別件数
  - `03_x_workspace`: workspace / membership / social account / OAuth state の件数と孤児検査
  - `04_vault_reference_integrity`: 参照の件数と orphan（`vault.secrets.id` のみ）
  - `05_deletion_state`: tombstone と audit の件数
  - `06_migration_history`: 適用済み version 一覧
  - `07_cron_jobs`: job 名・schedule・active（command 列は取得しない）
  - `08_key_function_definitions`: 境界関数 12 件の定義
  - `09_legacy_token_store`: 行数のみ
  - `supabase functions list`: Edge Function の name / version / status / `verify_jwt` / 更新時刻
- GitHub: open PR の変更ファイル一覧を read-only で確認。

- remaining_issues:
  - Auth provider の enabled / redirect 設定は未確認（identity 実績は email のみ）。
  - Apple revoke 用 env、その他 function secret の設定有無は未確認。
  - `x-test-post` を起動する cron の command 本体、production の `claim_due_post` 本体は未照合。
  - Vault の「参照されない 6 secret」と、残存する verifier 10 件の用途・要否は未調査（値は読んでいない）。
  - deploy 済み function の code が main と一致するかは未照合（version と更新時刻のみ）。
  - `alert_settings` の追加3列は「変更済み」判定に含めていない。
  - Auth-only の 1人がどの app 由来かは DB から判別不能。
- safety_checks: production mutation 0。G5 による production 接続 0（read はユーザーが実行）。Vault secret 値の読み取り 0。Auth / identity / OAuth / deploy / merge / flag / Cron 変更 0。backfill 0。他slotの TASK / branch / PR / 作業ファイル変更 0。source / runtime code 変更 0。Report に email / user UUID / X handle / platform user id / token / JWT / secret / Vault 参照の生値を含めていない。
- next_recommendation:
  1. K5 で、deploy 済み `account-delete` の扱い（admin guard と X workspace 保有時の fail-closed を先行するか、共通 orchestrator まで待つか）を判断。Auth 削除境界のため H1/H2 review 対象を推奨。
  2. 共通アカウント v1 Phase 1（additive schema + shadow backfill 設計）を別 TASK で起票。#65 と G3 の決着後に着手。
  3. `device_push_tokens` の service_role grant、残存 verifier secret と OAuth state の cleanup は別件として起票を検討。


## Final K5 — 2026-10-01 JST

- verdict: **PASS — Phase 0 complete**.
- accepted_scope: repository + production read-only inventory only; source/runtime implementation changes = 0.
- production_mutation: **0**.
- key decision: common-account v1 may proceed to additive/shadow design later, but Phase 1 implementation is held until pending social-mobile Auth/deletion work is reconciled.
- security follow-up: production Kabumori account deletion currently hard-deletes the shared Auth user without X-service/admin-aware protection. This is an existing cross-service lifecycle risk and is assigned separately to H1 for source/security review and minimal fail-closed correction candidate. No production deploy is authorized by K5.
- Codex review of Phase 0 itself: not required because G5 changed no runtime code and only performed read-only inventory. The newly discovered deletion boundary receives its own H1 review.
- AI Lab diary: 記録不要 — 同日既存エントリが「共通部分とサービス固有部分を分け、サービス単位で安全に利用終了する」という今回の公開可能な要点をすでに含んでおり、重複追記はしない。
