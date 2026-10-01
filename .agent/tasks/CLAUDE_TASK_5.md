# Claude Task 5 — CURRENT TASK

- task_id: common-account-pr70-corrective-lifecycle-foundation-20261001
- owner: claude
- slot: claude-5
- status: review_required
- next_owner: chatgpt
- priority: highest
- start_code: G5
- finish_code: K5
- recommended_model: Opus5.5（極高）
- type: corrective architecture / migration / lifecycle security
- target_pr: #70
- target_original_head: 89cf128bd9219897806b2b641cce4866f6e16c52
- production_mutation_allowed: false

## Purpose

H1/C1でFAILとなったPR #70を、**共通アカウントv1 Phase 1の安全なadditive foundation**へ修正する。

重要な方針変更：

**Phase 1ではSupabase Auth userの実削除を完了させない。**

このPhaseの責任は、
- common account state
- service entitlement
- service start/stop serialization
- whole-account deletion intent / durable Saga state
- shadow backfill
- least-privilege ACL/RLS
- future common orchestratorが安全に使うためのDB contract

まで。

実際のmanaged Auth destruction（GoTrue/Admin API、Storage、sessions/identities、Apple/provider revoke等）は、後続の共通account deletion orchestrator Phaseで実装・検証する。

PR #70を同じbranch/PR上で修正してよいが、fresh head/ownership/競合確認必須。

## Mandatory startup / isolation

- PROJECT_RULES / HANDOFF / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK
- G5 prior Phase 1 Report
- H1 PR #70 review full Report + Final C1
- G1〜G4 / H1 / H2 fresh status
- open PR changed files
- git status / worktree list / fresh origin/main
- G5独立worktree

G4 PR #65 filesは触らない。
他slot/branch未コミット変更は触らない。

## Required corrections

### 1. Remove managed Auth destruction from Phase 1

Current candidateの `finalize_common_account_deletion` が直接 `DELETE FROM auth.users` して「completed」を返す設計は廃止する。

Phase 1では例えば：

```text
started
→ service cleanup checkpoints
→ ready_for_managed_auth_delete
```

まで。

DB側finalize/prepareは：
- lifecycle stateをlock下で再検証
- entitlement/service footprintを検査
- managed cleanupが未完ならfail closed
- **auth.usersを削除しない**
- 「外部orchestratorが次に何をすべきか」を非secretな状態で返す

とする。

名前は設計に合わせて変更可。
「finalize」という名前が実削除完了を誤解させるならrenameする。

Phase 1 Report/docs/testsから「Auth削除完了」「Storage FKで止まる」等の過剰な保証を削除する。

### 2. Managed ownership / Storage boundary

H1 finding:
- Storage ownershipはauth.users FKで守られていない。
- SQL Auth DELETEだけではowned object metadata/実体のcleanupを保証できない。

Phase 1では：
- StorageをSQL DELETEしない
- Storage cleanupを実装しない
- actual managed Auth deleteをしない
- future orchestrator prerequisiteとして、Storage/API cleanup + revalidation + retry/idempotencyをcontractへ明記
- unknown managed-service ownershipはwhole-account delete readinessでfail closedに扱える拡張点を設計

将来のorchestratorが必要なチェックポイントをoperation stateへ持たせる場合、Phase 1で安全なschemaだけ追加可。

### 3. Fix stale preview / absent-account lifecycle version

H1 findingをregression test化。

必須：
- account rowが存在しないpreviewと、その後のbackfill/service introductionで同じversionが有効のままにならない
- absent stateにも明確なepoch/nonce/version semantics
- entitlementを導入する全pathでconfirmation bindingがinvalidになる
- old preview/versionでbegin deletionできない

### 4. Serialize backfill against lifecycle state

backfillはsnapshotだけでactive判定しない。

必須：
- auth.users → common_accounts の既定lock orderを守る
- lock取得後にstatus/version/eligibility再検証
- locked/deleting等へentitlementを付与しない
- concurrent state transitionとの2-session race test
- backfillによるentitlement追加時にlifecycle/preview versionを確実にinvalidate

offline/quiescent前提に依存するならDB contractで強制し、単なる運用メモにしない。

### 5. Exclude admin from X consumer backfill

`admin_users` とself-service workspace ownerの交差ケースを明示除外。

- adminはconsumer x_autopost entitlement対象外
- Kabumori entitlementは別ルール
- mixed-role regression testを追加

### 6. Exact FK preflight

tableに「何かAuth FKがある」だけでは不可。

最低限、invariantに使うFKごとに：
- referencing table
- exact referencing column(s)
- referenced schema/table
- exact referenced column(s)
- type compatibility
- delete action
- constraint validity
- 必要ならdeferrability/timing

を照合。

H1のwrong-column FK counterexampleをcommitted regressionにする。

### 7. Rollback requires affirmative safe shadow state

settings row absenceを「rollback可」にしない。

rollback前提：
- settings rowが存在
- modeがvalid shadow
- in-flight lifecycle operationなし
- downstream dependencyなし
- integration/enforcement未開始

missing / corrupt / enforce はfail closed。

H1のmissing-settings counterexampleをregression test化。

### 8. Guard semantics

Phase 1 guardは、current production hard-deleteを安全化済みと主張しない。

shadow defaultで既存挙動不変でもよいが、docsで明示する。

enforce modeは後続integrationが揃うまで有効化禁止。

実Auth deleteをPhase 1から削除することで、guardは：
- legacy/direct hard delete protection
- future orchestrator authorization boundary
のfoundationとして再設計してよい。

ただし「authorized」判定だけでStorage/provider cleanupまで保証したと扱わない。

### 9. Session / recent-auth / provider cleanup

H1 prior findingsのP2 recent reauthenticationはPhase 1 DB-onlyでは解決しない。

明確にfuture orchestrator/client integration prerequisiteとして残す：
- recent reauth
- session revoke / stale JWT policy
- Apple revoke
- X posting authorization revoke
- Vault purge
- Storage API cleanup
- managed Auth Admin API delete
- post-delete read-back/audit/retry

### 10. Preserve accepted good properties

壊さない：
- additive schema
- profilesはKabumori root
- brand_membershipsはX role/ownership
- emailでaccount mergeしない
- client arbitrary user/status write不可
- public table RLS
- least privilege grants
- fixed search_path / schema qualification
- service start vs deletion serialization
- service-only deletion leaves other service/Auth untouched
- external provider work is Saga, not fake transaction
- G4 files untouched

## Required tests

H1の6 counterexampleを**全てcommitted regression test**にする。

最低限：
1. no SQL Auth DELETE / no false completed state
2. Storage-owned-state scenario cannot be reported as account deletion completed by Phase 1
3. absent preview -> backfill adds entitlement -> old confirmation rejected
4. concurrent locked transition vs backfill -> entitlement not granted
5. admin + self-service workspace -> x entitlement not granted
6. wrong-column FK -> preflight rejects
7. missing settings row -> rollback rejects
8. original two-session provisioning/delete races remain safe
9. rollback/reapply on valid shadow remains safe
10. ACL/RLS/SECURITY DEFINER invariants
11. mutation/defect-detection tests updated for new contract
12. existing social-mobile deletion regression
13. git diff --check / source invariants

可能ならPostgreSQL 2-session race proofを継続。

実Supabaseへのwrite/deleteはしない。

## PR / delivery

PR #70を更新する。
- old headを勝手にmergeしない
- new exact headをReport
- changed filesを明記
- architecture deltaを明記
- PR remains merge HOLD until K5 + Codex rereview

## Production safety

禁止：
- production migration/apply/backfill
- auth.users delete
- Auth Admin API delete
- Storage delete
- OAuth revoke
- Vault mutation
- identity link/unlink
- deploy
- RLS enforcement production change
- feature flag/Cron/provider setting
- real X operation

production readも原則不要。必要ならK5で別途判断。

## Completion / K5

Report：
- result
- exact old/new PR head
- architectural correction summary
- no-Auth-delete proof
- lifecycle/version/backfill serialization
- exact preflight
- rollback fail-closed
- ACL/RLS
- six H1 regression results
- full test evidence
- changed_files
- production mutation=0
- remaining managed-service/orchestrator prerequisites
- rollout/rollback implications
- next recommendation

完了時 status -> review_required / next_owner -> chatgpt / STOP。

K5後は、同じPRの再レビューをH1/H2の空き枠へ入れる。
推薦レビュー：**Sol（高）**。
production適用前：**Sol（極高）**。

## Report

- task_id: common-account-pr70-corrective-lifecycle-foundation-20261001
- result: **PASS**（是正 source 候補・regression・mutation 証明まで完了。production 未適用。再レビュー待ち）
- old_pr_head: `89cf128bd9219897806b2b641cce4866f6e16c52`
- new_pr_head: `eebe9405d758e0c120f9e6f1a70cdb1e973a0855`（旧 head の上に 1 commit。rebase / force-push なし）
- PR: [#70](https://github.com/anohi-memories/kabumori/pull/70)（open、MERGEABLE、**merge HOLD**）。Report 時点の checks: passing 2 / pending 3 / failing 0。
- checked_main: 開始時 `8ca101e`。Report push 直前に fresh `origin/main` を再確認。
- worktree / isolation: G5 専用 worktree。source は PR branch `claude/g5-common-account-phase1-20261001`、Report は main 基点の control commit。push 前に remote PR head が `89cf128` のままであることを確認。他slotの worktree / branch / PR / TASK は未変更。G4 PR #65 のファイルは未変更。
- push: source は PR branch へ fast-forward。この Report は `origin/main` へ fast-forward。
- deploy: none（prohibited）。
- production_mutation: **0**。production への接続（read 含む）も 0。

### architectural correction summary

**Phase 1 は Supabase Auth user を削除しない。**

- 旧: `finalize_common_account_deletion` が SQL で `auth.users` を削除し `completed` を返す。
- 新: `prepare_common_account_auth_delete` が lock 下で再検証し、operation を `ready_for_managed_auth_delete` へ進めるだけ。`login_deleted: false` と、orchestrator が次にすべきこと（`next_steps`、非secret）を返す。再呼び出しで再評価し、状態が崩れていれば `cleanup` へ戻す。
- Phase 1 の責任範囲: account state / service entitlement / start・stop の直列化 / 全体削除の durable intent と saga checkpoint / shadow backfill / 最小権限 ACL・RLS / 将来の orchestrator 向け DB contract。
- 実削除（Auth Admin API、Storage API cleanup、session・identity、Apple / X revoke、read-back）は後続 orchestrator の責務として設計ノートに明記。
- 前回 Report の「Storage 等の FK で阻まれた場合は停止する」という記述は誤りだった（Storage 所有は Auth への FK で守られていない）。当該の保証は Report / docs / tests から削除した。

### no-Auth-delete proof

- candidate に `auth` / `storage` / `vault` schema への `delete` / `update` / `insert` / `truncate` は 1文もない。runner の静的チェック（`COMMON_ACCOUNT_STATIC_NO_MANAGED_DELETE_PASS`）が強制する。candidate が削除する既存 table は Kabumori 自身の退会で消す `public.profiles` の1行だけ。
- account deletion に `completed` という状態が schema に存在しない（CHECK 制約。直接 UPDATE しても違反になることをテスト）。
- 挙動テスト: ready 到達後も login・account 行は存在し、operation は `in_progress` のまま。
- mutation「prepare が login を削除する」「account deletion を completed にできる」はどちらも検出される。
- テスト中の `delete from auth.users` は、login を消す主体（今の legacy 経路、将来の orchestrator）の**代役としてテストが実行**しているもの。candidate のコードではない。

### managed ownership / Storage boundary

- Storage を SQL で削除しない。Storage cleanup を実装しない。
- `private.account_lifecycle_managed_checkpoints`（registry）を追加。`storage_cleanup` / `session_revocation` は常に必須、`apple_revocation` は Apple identity がある場合に必須。`prepare` は全て記録されるまで ready にしない。checkpoint は orchestrator の申告であり、DB が検証したものではない。
- 加えて `storage.objects` / `storage.buckets` を read-only で probe する。DB から所有が見える間は、checkpoint 記録済みでも `MANAGED_OWNERSHIP_REMAINS`。これは拒否の理由であり、不在の証明ではない（直後に upload され得る）。
- Storage の shape が想定と違えば `MANAGED_STORAGE_SHAPE_UNKNOWN`（fail closed）。
- 拡張点: 新しい managed ownership は registry に1行足す。以後、orchestrator が申告するまで全削除が fail closed。built-in 行が欠けた registry も not ready。

### lifecycle / version / backfill serialization

- `lifecycle_version` は **trigger** で動く（account の state 変更、entitlement の insert / update / delete）。RPC・backfill・operator の SQL のどれが書いても動く。減少は拒否。
- `0` = account 行なし。どの行にも一致しない。version `1` = 「entitlement も state 変更も一度もない行」。
- `begin(0)` は行が存在しない時だけ有効。作成した行が「fresh（version 1・active・entitlement なし）」でなければ `lifecycle_changed`。
- backfill（apply）は login ごとに id 順で lifecycle lock（`auth.users` → `common_accounts`）を取り、**lock 取得後に** その login の plan 行を読み直してから insert する。`active` でない account には付与しない。READ COMMITTED 以外では例外。
- 既存の直列化（start と削除、判断途中、hard delete との lock order）は維持。

### exact preflight

1 transaction。次を照合し、不一致なら何も作らず中断する。

- 必要 schema / role / table（`storage.objects` / `storage.buckets` を含む 17 table）
- invariant が読む列 26 個の存在と**型**
- invariant が依存する FK 14 本それぞれについて: 参照元 table と**列**、参照先 table と**列**、列の型一致、delete action、validated、非 deferrable
- `profiles` を参照する FK に CASCADE でないものがない
- 再利用する helper 2関数の signature と戻り型
- 二重適用でない

### rollback fail-closed

rollback は「肯定的に確認できた shadow 状態」からのみ実行される。

- settings 行がちょうど 1 行、guard `shadow`、integration `not_started`（**行が無い場合は拒否**）
- built-in checkpoint 3 行が揃っている
- in-flight operation なし、`active` でない account なし
- self-service で登録された entitlement なし（client が start RPC を使い始めている）
- 依存 object なし（全 DROP が CASCADE なし）

### guard semantics

- `shadow`（導入時の既定）: 全 delete を許可。既存経路の挙動は不変。**安全化はしていない。**
- `enforce`: account が `deleting`、ready operation あり、全 entitlement `ended`、blocker なし、managed ownership probe が clean、の全てを delete の瞬間（`auth.users` 行を保持した削除 transaction 内）に再評価して満たす場合だけ許可。
- `enforce` は `integration_state = 'not_started'` の間は設定できない（table 制約）。
- 許可は「DB から見える状態が clean」という意味だけ。Storage / provider cleanup の保証ではない。
- 許可された削除でも記録するのは `login_removed`（観測）であり、`completed` ではない。

### ACL / RLS

- 新 table 5 つすべて RLS enabled。`public` の 2 table は self-SELECT policy 1 本ずつ。
- table 権限は全 role から revoke。authenticated は列限定 SELECT のみ。service_role は table 権限なし。
- 関数 21 個すべて SECURITY DEFINER / `search_path = ''` / PUBLIC・anon の EXECUTE なし。RPC ごとに 1 role へ grant。
- client は任意の user / status を書けない。start RPC は引数なし。

### six H1 regression results

| # | H1 counterexample | committed regression | 結果 |
| --- | --- | --- | --- |
| 1 | Auth DELETE が Storage 所有を残して completed | 静的チェック（managed schema への書き込みなし）＋ `completed` 不可の制約 ＋ Storage 所有が見える間は ready にならない（checkpoint 記録済みでも）＋ ready 後も login が存在 | PASS |
| 2 | absent preview が backfill 後も有効 | absent preview（0）→ profile 追加 → backfill → `begin(0)` と `begin(1)` がどちらも `lifecycle_changed`、operation なし | PASS |
| 3 | 同時の lock 遷移後に backfill が付与 | race 9: hold 未commit → backfill は待ち、付与しない。race 10: backfill が一時停止中 → hold が lock 待ちになることを `pg_stat_activity` で確認 | PASS |
| 4 | admin + self-service workspace に X entitlement | admin かつ self-service workspace 単独 owner かつ Kabumori 利用者 → X なし、Kabumori あり、`x_autopost_excluded_admin = 1` | PASS |
| 5 | 無関係な列の FK を preflight が受理 | `brand_memberships.user_id` の FK を外し、別列に Auth FK を付ける → `COMMON_ACCOUNT_PREFLIGHT_FK_MISMATCH` で拒否、何も作られない | PASS |
| 6 | settings 行なしで rollback が guard を外す | settings 行を削除 → rollback は `…SETTINGS_NOT_AFFIRMED` で拒否、guard は残る | PASS |

### full test evidence

すべて使い捨てローカル PostgreSQL 17.11（Unix socket、偽データのみ、非 superuser owner）。commit 済みの tree で実行。

`supabase/tests/common_account_lifecycle_run.sh` — **19 項目 PASS**

1. exact preflight（8 種の不一致を拒否: 列なし / 型違い / 別列の FK / delete action 違い / deferrable / 未 validate / cascade しない子 table / helper の signature 違い）
2. 追加のみの適用（適用前の schema dump の全行が残る）＋ 再適用の拒否
3. 静的チェック（managed schema への書き込みなし、email を読まない、既存 object の変更なし、既存 object への grant / revoke なし）
4. 挙動（backfill、ACL / RLS、start、ready までの全体削除、service-only 削除、fail closed、managed ownership、guard 2 モード）
5. 2 セッション競合 12 種: start→delete（account 不在の preview を含む）/ delete→start / ready→creator（legacy creator は Phase 1 では止まらないが、次の prepare で `cleanup` に戻る）/ creator→ready / 二重 delete / 二重 start / 判断途中 / hard delete との lock order / lock→backfill / backfill→lock / guard 境界の両順（orphans=0）
6. isolation guard（RPC と backfill）、deadlock なし
7. rollback: 拒否 8 種の後、適用前と byte 一致で復元、再適用可

`supabase/tests/common_account_lifecycle_mutations.sh` — **29/29 検出**

- candidate または rollback の copy に欠陥を 1 つ入れ、runner が**想定したチェックで**失敗することを要求する。実ファイルは変更しない（実行後に tree clean を確認）。
- H1 の指摘で「10 種が独立に再現されていない」とされたため、script として commit した。
- 初回は 4 種が「想定と別のチェック」で検出された。想定を実際の検出箇所に合わせ、rollback の mutation は H1 が示した元の欠陥そのものに差し替えた。

既存スイート: `social_mobile_account_deletion_run.sh` 8 項目 PASS、`migration_source_invariants_test.ts` 10 passed、`bash -n` OK、`git diff --check` clean。

未実施: 実 Supabase（GoTrue / PostgREST / Storage / `supabase_auth_admin`）での検証。ローカル PostgreSQL はその証明にならない。

### changed_files（旧 head → 新 head、7 files、+1535 / −582）

- `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql` — 是正の本体
- `supabase/tests/common_account_lifecycle_behavior.sql` — 新 contract と H1 regression
- `supabase/tests/common_account_lifecycle_run.sh` — exact preflight / 静的チェック / race 追加 / rollback 拒否
- `supabase/tests/common_account_lifecycle_mutations.sh` — **新規**。mutation 証明
- `supabase/tests/common_account_lifecycle_rollback.sql` — 肯定的 shadow 状態の要求
- `supabase/tests/common_account_lifecycle_fixture.sql` — production 形の Storage stub を追加
- `docs/common-account/phase1-lifecycle-foundation.md` — 全面改訂

client / Edge Function / 既存 migration / 既存 RLS の変更は 0。

### remaining managed-service / orchestrator prerequisites（Phase 1 では未解決）

- 直近再認証（server 側で強制）
- session revoke と stale JWT の方針（login を消しても発行済み token は失効しない）
- Apple revoke
- X posting authorization の revoke と Vault purge（既存 X saga を begin / finish で包む）
- Storage API による cleanup、空になるまでの再列挙、retry / 冪等性
- 削除直前の再検証（`prepare` の再呼び出しと Storage の再列挙）
- managed Auth Admin API による削除（SQL ではなく）
- 削除後の read-back / audit / retry。account deletion を「完了」と記録できるのはこの step だけで、そのための schema 追加が別途必要
- 実 Supabase の使い捨て project での Auth / Storage / session / role 境界の証明

### remaining unknowns

- production で function owner が `storage.objects` / `storage.buckets` を SELECT できるか（できなければ `prepare` は例外で fail closed）。
- production schema が exact preflight を通るか（read-only の catalog 照合が必要。今回 production read は行っていない）。
- shadow 期間中、既存 creator は lifecycle を通らない。ready 後にサービスデータが作られ得る。次の `prepare` は拒否するが、shadow では login 削除自体は止まらない。
- backfill（apply）は訪問した login の lock を commit まで保持する。現状の人数では問題ないが、人数が多い場合は静かな時間帯に実行する必要がある。

### rollout / rollback implications

- 適用前: この是正版の再レビュー、production 適用前の別レビュー、実 Supabase での証明、exact preflight が依存する catalog の read-only 照合。
- 適用順は変わらず: 単一ファイル適用（`db push` 不可）→ backfill dry-run 照合 → backfill → integration（`integration_state = 'started'`）→ 削除経路の移行と orchestrator → その後に `enforce`。
- rollback は integration 開始前だけ。開始後は拒否する。
- **既存 Kabumori `account-delete` はこの候補では安全にならない。** shadow では経路・挙動とも不変。

- remaining_issues: 上記 prerequisites と unknowns。
- safety_checks: production mutation 0、production 接続 0。`auth.users` 削除 / Auth Admin API / Storage 削除 / OAuth revoke / Vault 操作 / identity 変更 / deploy / flag・Cron 変更 0。既存 table / policy / grant / function の変更 0（schema dump 比較で証明）。旧 PR head は merge していない。G4 ファイル未変更。他slotの TASK / branch / PR 未変更。secret / PII を source・test・Report に含めていない。
- next_recommendation: K5 の後、同じ PR #70（head `eebe940`）の再レビューを H1 / H2 の空き枠へ。推薦 Sol（高）。重点: no-Auth-delete の境界、version trigger と absent preview、backfill の lock、exact preflight、rollback の肯定条件、guard の enforce 条件。production 適用前は Sol（極高）。

---

## Previous completed G5 task history — preserved below

# Claude Task 5 — CURRENT TASK

- task_id: common-account-v1-phase1-additive-lifecycle-foundation-20261001
- owner: claude
- slot: claude-5
- status: done
- next_owner: none
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
- result: **PASS**（source候補・disposable test・設計ノートまで完了。production は未適用。レビュー待ち）
- checked_main: 開始時 `204ba32`。PR head は `26ea179` 基点。Report push 直前に fresh `origin/main` を再確認。
- worktree / isolation: G5専用 worktree（`.claude/worktrees/g5-f7a405`）。source は branch `claude/g5-common-account-phase1-20261001`、Report は main 基点の control commit。他slotの worktree / branch / PR / TASK / dev server は未変更。G4 PR #65 のファイルには触れていない。
- commit / PR: source commit `89cf128`、[PR #70](https://github.com/anohi-memories/kabumori/pull/70)（open、MERGEABLE、**merge HOLD**）。Report 時点の checks: Vercel / Netlify preview SUCCESS、失敗 0。
- push: source は PR branch へ。この Report は `origin/main` へ fast-forward。
- deploy: none（prohibited）。
- production_mutation: **0**。production への接続（read 含む）も 0。migration apply / backfill / Auth 削除 / identity 変更 / Vault・OAuth 操作 / Cron・flag 変更はいずれも未実施。

### changed_files（PR #70、7 files、+2340）

- `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql` — migration 候補（単一ファイル、1 transaction）
- `supabase/tests/common_account_lifecycle_fixture.sql` — 既存 fixture への追加（Kabumori 側 table、`auth.identities` など）
- `supabase/tests/common_account_lifecycle_behavior.sql` — 挙動テスト
- `supabase/tests/common_account_lifecycle_run.sh` — runner（適用・競合・rollback の証明）
- `supabase/tests/common_account_lifecycle_rollback.sql` — rollback
- `supabase/tests/migration_source_invariants_test.ts` — 予約 version に `20261001150000` を1行追加
- `docs/common-account/phase1-lifecycle-foundation.md` — 設計ノート / rollout・rollback 計画 / Phase 2 接続点

client / Edge Function / 既存 migration / 既存 RLS の変更は 0。

### schema candidate

追加のみ。既存 object の rename / drop / 再定義 / grant 変更なし。

| object | 内容 |
| --- | --- |
| `public.common_accounts` | `user_id` PK → `auth.users` ON DELETE CASCADE、`status`（active / deleting / locked）、`lifecycle_version`、timestamps |
| `public.service_entitlements` | PK `(user_id, service_key)` → `common_accounts` CASCADE、`service_key`（kabumori / x_autopost）、`status`（provisioning / active / suspended / deleting / ended）、`source`、`legacy_evidence`、`activated_at`、`ended_at` |
| `private.account_lifecycle_operations` | durable deletion intent。`operation_type`（service_deletion / account_deletion）、`status`、`current_step`、Apple revoke checkpoint、`last_error_code`。in-progress は person × 種別 × service で1件（partial unique index）。raw user id は login 消滅時に消し、subject hash だけ残す |
| `private.account_lifecycle_settings` | 1行。Auth削除ガードの mode（`shadow` 既定 / `enforce`） |
| `private.account_lifecycle_backfill_plan`（view）＋ `private.account_lifecycle_backfill(p_apply)` | shadow backfill 候補（未実行） |

- `provisioning` / `suspended` / `locked` は予約状態。この候補のどの RPC も作らない。全 gate が「サービスあり」として fail closed に扱う。
- preflight（exact）: 二重適用、`private` schema、3 role、必要 table 15、必要列 9、既存 helper 関数 2、`profiles` と子 table の CASCADE、X 側行の `auth.users` 参照を検査。不足時は何も作らず中断。
- 再適用戦略: 再実行不可（`COMMON_ACCOUNT_FOUNDATION_ALREADY_APPLIED`）。ファイル全体が 1 transaction なので部分適用は起きない。
- `profiles` は Kabumori root のまま、`brand_memberships` は X の認可のまま。

RPC（すべて SECURITY DEFINER、`search_path = ''`）:

- client（authenticated、引数なし、本人は `auth.uid()` のみ）: `start_kabumori_service`、`start_x_autopost_service`
- backend（service_role、`p_user_id` は検証済み JWT 由来）: `common_account_deletion_eligibility`、`begin_service_deletion`、`finish_service_deletion`、`abort_service_deletion`、`withdraw_kabumori_service`、`begin_common_account_deletion`、`mark_common_account_apple_revoked`、`abort_common_account_deletion`、`finalize_common_account_deletion`

### lifecycle serialization invariant

- I1: 全 lifecycle RPC は、本人の `auth.users` 行（KEY SHARE。finalize は FOR UPDATE）→ `common_accounts` 行（FOR UPDATE）の順にロックしてから状態を読む。
- I2: サービス開始は account が `active` の時だけ。`begin_common_account_deletion` の commit 以降、全 start は `ACCOUNT_DELETION_IN_PROGRESS` で fail closed。
- I3: service-only deletion は login・他 entitlement・他サービスの行に触れない。
- I4: login 削除は `finalize` だけ。排他ロックを保持した同一 transaction 内で、全 entitlement が `ended`、サービス行なし、admin でない、foreign workspace なし、（Apple identity があれば）revoke checkpoint 済み、を再検証してから `auth.users` を削除する。
- I5: admin / 共有・内部 workspace / entitlement のないサービスデータ / 予約状態は fail closed。
- I6: READ COMMITTED 以外では例外。

**Auth hard delete 直前までの guarantee**: `finalize` は `auth.users` 行を FOR UPDATE で取ってから検証する。サービスデータを作る処理は必ず `auth.users` を参照する行（profile / membership / OAuth state / common account）を insert するため、(a) ロック前に commit 済みなら検証で見えて拒否、(b) ロック中なら待たされ、自分の FK で失敗して transaction ごと rollback（先に insert した workspace 行も消える）。これは **既存・未変更の** `ensure_my_profile` と `begin_social_mobile_x_oauth_connection` に対しても成立する（実物で両方の commit 順を証明）。

- 「最後にもう一度 SELECT する」方式ではない。read と delete の間に隙間がない（同一 transaction・行ロック下）。
- 既存 X deletion acquisition を Kabumori へ流用していない。
- 外部処理（X revoke / Vault purge / Apple revoke）は saga step。DB は checkpoint を記録するだけで、原子的に扱ったふりをしない。
- lock order は login 削除の cascade と同じ向き（`auth.users` → `common_accounts` → …）。lifecycle 呼び出しと legacy hard delete が同時でも待ち合わせになり、deadlock しない。
- `lifecycle_version`: backend は本人が確認画面で見た version を渡す。確認後にサービスが増えていれば `lifecycle_changed` を返し、確認していないものは消さない。
- stale / retry: 各 step は lock 下の状態遷移なので再実行は現在状態を返す。進まない削除は `abort_common_account_deletion` で `active` に戻せる。

**Auth削除ガード**: `common_accounts` の BEFORE DELETE trigger（`auth.users` からの cascade で発火）。`shadow`（導入時の既定）は全て許可し、既存経路の挙動は不変。`enforce` は finalize が同一 transaction で許可した削除以外を拒否する（SQLSTATE 23503。既存 X saga はこれを自身の `operator_required / LOGIN_DELETE_BLOCKED` に落とす）。設定行がなければ `enforce` 扱い。

### RLS / grant model

- 新 table 4つすべて RLS enabled。`public` の2 table は policy 1本ずつ（authenticated、`auth.uid() = user_id` の SELECT のみ）。
- table 権限は `PUBLIC` / anon / authenticated / service_role から全 revoke（default の TRUNCATE / REFERENCES / TRIGGER も消える）。authenticated には列限定 SELECT のみ（`source` / `legacy_evidence` は不可）。**service_role には table 権限なし**（RPC 経由のみ）。
- 関数は全て `PUBLIC` と全 role から EXECUTE を revoke し、RPC ごとに1 role へ grant。`private` の helper は owner 以外実行不可。create と revoke は同一 transaction。
- client は任意の `user_id` / `status` を書けない（INSERT / UPDATE / DELETE / TRUNCATE すべて権限なし。start RPC は引数なし）。
- 既存 Kabumori / X の RLS は未変更。

### backfill candidate + dry-run proof

`private.account_lifecycle_backfill(false)` が件数のみ、`(true)` が不足行を insert。冪等。既存 entitlement は書き換えない。`active` でない account には付与しない。email は一切読まない。

Phase 0 の production 集計と同じ形の fixture（4 login）での dry-run:

| 項目 | 結果 |
| --- | --- |
| auth_users / common_accounts_to_create | 4 / 4 |
| kabumori 候補（activity あり / profile のみ） | 2（1 / 1） |
| x_autopost 候補（identity_verified / pending） | 1（1 / 0） |
| auth_only | 1 |
| excluded_admin_users | 1 |

追加ケース（計 11 login）: 共有 workspace・内部 workspace・self-service でない workspace は X entitlement 対象外、admin に consumer X entitlement なし、同一 email の2 login は2 account のまま（entitlement も共有されない）。apply 後の件数は計画どおり、2回目 apply は 0 件、self-service 済み entitlement と `locked` account は不変。

**production では未実行。** 上表は disposable DB の fixture に対する結果であり、production の dry-run ではない。

### concurrency / race proof（2 session、実 PostgreSQL）

| # | シナリオ | 結果 |
| --- | --- | --- |
| 1 | start 未commit → deletion begin | begin は待ち、`lifecycle_changed`。再 begin は新サービスを含み、finalize は `SERVICES_REMAIN` |
| 2 | deletion begin 未commit → start | start は待ち、`ACCOUNT_DELETION_IN_PROGRESS`。行は作られない |
| 3 | finalize 未commit → lifecycle start + 既存 profile bootstrap + 実物 X onboarding | 3つとも待って失敗。orphans=0 |
| 4 | 既存 creator 未commit → finalize（X onboarding / profile の2通り） | finalize は待ち、拒否。login と所有データは残る |
| 5 | deletion begin ×2 | 1件 `started`、1件 `in_progress`。operation 1件 |
| 6 | 初回 start ×2 | account 1、entitlement 1 |
| 7 | 判断の途中（test用 trigger で start を RPC 内で一時停止）→ deletion begin | begin は待ち、`lifecycle_changed` |
| 8 | lifecycle start（一時停止中）→ legacy hard delete | deadlock なし。delete は待ってから cascade、残存行 0 |

加えて isolation guard（REPEATABLE READ は拒否）、全 race 出力に deadlock なし。

### tests

- `supabase/tests/common_account_lifecycle_run.sh`: **16 項目 PASS**（preflight 拒否 / 追加のみ適用 + 再適用拒否 / 静的チェック / 挙動 / race 8種 / isolation / no-deadlock / rollback / cleanup）。local PostgreSQL 17.11、偽データのみ。
- 追加のみの証明: 適用前後の `pg_dump --schema-only` を比較し、適用前の全行が適用後も存在。rollback 後は適用前と byte 一致、その後の再適用も成功。
- 挙動テストの対象: backfill、ACL / RLS、start、whole-account deletion、service-only deletion（Kabumori 単独、X 単独は**実物の social-mobile 削除 saga** と組み合わせ）、両サービス利用者の全体削除、admin / shared / internal / unregistered / 予約状態 / locked の fail closed、Apple checkpoint、ガード2モード。
- **ミューテーション確認**: candidate に欠陥を10種入れ（login 行ロックを外す、account 行ロックを外す、deleting 判定を外す、ガードを無効化、finalize の blocker 再検証を外す、PUBLIC の EXECUTE を残す、version 検査を外す、既存 grant を変更、など）、**10種すべてテストが検出**。初版の race テストは account 行ロックの欠落を検出できなかったため、race 7 を追加して検出できるようにした。
- 既存スイート: `social_mobile_account_deletion_run.sh` 8 項目 PASS（変更なし）、`migration_source_invariants_test.ts` 10 passed、`git diff --check` clean。
- 未実施: 実 Supabase（GoTrue admin delete、PostgREST 経由、`supabase_auth_admin` role）での確認。production の PostgreSQL version との差の確認。

### pending conflicts

- PR #65（G4、open）: この PR とファイルの重なりなし。Phase 2 の X 側接続点（`onboarding-gate.tsx` など）は #65 決着後に着手。
- PR #41（open）: `x-test-post` と X publish authority の migration。重なりなし。予約 version 一覧（invariants test）は同じファイルを触る可能性があるが、#41 の変更ファイルに含まれていない。
- PR #33（open）: admin auth。重なりなし。
- G1 / G2: Kabumori Home / report 系。Auth / lifecycle との重なりなし。

### remaining unknowns / レビューで見てほしい点

1. `finalize` は GoTrue admin API ではなく SQL で `auth.users` を削除する（既存 X finalize と同じ方式。直列化のため同一 transaction が必要）。Storage 等の FK で阻まれた場合は `AUTH_DELETE_BLOCKED` で停止する。実 Supabase での挙動は未確認。
2. ガードが返す SQLSTATE を 23503 にしたのは、既存 X saga の handler に合わせるため。妥当性の判断。
3. `start_kabumori_service` は entitlement と同時に `profiles` 行を作る。Phase 2 で `ensure_my_profile` を置き換える前提。
4. lifecycle 呼び出しごとに `auth.users` 行を KEY SHARE でロックする。`finalize` を他の lifecycle RPC と同一 transaction で呼ぶとロック昇格で deadlock し得る（PostgreSQL が片方を中断。破損はしない）。finalize は単独 transaction を前提とする。
5. X 側 helper 2関数（workspace id 導出、subject hash）を再利用している。X 削除 candidate が適用済みであることが前提（production は適用済み）。
6. Kabumori 側の test fixture は手書きの最小形。production dump 由来ではない。
7. shadow 期間中、既存 creator は entitlement を登録しないため「entitlement のないサービスデータ」が生じ得る。lifecycle はこれを `UNREGISTERED_SERVICE_FOOTPRINT` で拒否する（推測で消さない）。
8. 直近再認証（H1 の P2）は未対応。Edge Function 側の Phase 3 で扱う。
9. **既存 Kabumori `account-delete` はこの候補では安全にならない。** 経路・挙動とも未変更。

### rollout / rollback plan（未実行。各 step は個別に承認）

1. この候補のレビュー（Auth / RLS / lifecycle）。preflight が依存する catalog を read-only で再確認。
2. 単一ファイルで適用（`db push` 不可）。read-back: table / policy / grant / 関数 ACL / ガード mode `shadow`。
3. backfill dry-run を Phase 0 集計と照合 → backfill 適用 → 件数 read-back。
4. Phase 2 dual-write（既存 creator 2つが entitlement も登録）。parity: backfill dry-run の to_create が 0 のまま。
5. Phase 3: 削除経路を lifecycle へ（Kabumori は `withdraw_kabumori_service`、X は saga を begin / finish で包み scope 判定と自前の Auth 削除を除去、全体削除は orchestrator）。X の scope 規則が残る間は X → Kabumori の順。
6. その後にガードを `enforce` へ。
7. 最後に既存 RLS / producer へ entitlement 条件（flag 付き）。

rollback: `common_account_lifecycle_rollback.sql` が候補の作成物だけを drop。ガードが `enforce`、または削除が進行中なら拒否。step 4 より前は何も依存していないため、失うのは shadow 行のみ。

### Phase 2 の接続点（列挙のみ。未編集）

- Kabumori: `src/lib/auth.ts`、`src/providers/auth-provider.tsx`、`src/app/_layout.tsx`、`public.ensure_my_profile()`、`src/app/settings.tsx`、`src/lib/account-deletion.ts`、`src/lib/account-deletion-client.ts`、`supabase/functions/account-delete/*`、`apps/kabumori-web/pages/account-deletion.html`
- X（#65 決着後）: `apps/social-mobile/src/features/onboarding/onboarding-gate.tsx`、`apps/social-mobile/src/data/onboarding-repository.ts`、`public.begin_social_mobile_x_oauth_connection`、`supabase/functions/social-mobile-account-delete/*`、`social_mobile_account_deletion_scope` / `_finalize`
- producer（最終 phase）: `claim_pending_push_notifications`、`enqueue_important_news_notifications`、`enqueue_personalized_report_notification`、`personalized_report_news_inputs`、`important_news_app_copy_targets`、`personalized-reports/index.ts`、`x-test-post/index.ts`

詳細は `docs/common-account/phase1-lifecycle-foundation.md`（PR #70）。

- remaining_issues: 上記「remaining unknowns」。production 未適用・未 backfill。
- safety_checks: production mutation 0、production 接続 0。既存 table / policy / grant / function の変更 0（schema dump 比較で証明）。G4 ファイル未変更。他slotの TASK / branch / PR 未変更。secret / PII を source・test・Report に含めていない（test は偽 UUID と `example.test` のみ）。merge / deploy なし。
- next_recommendation: K5 の後、PR #70 を Sol（高）以上の Codex レビューへ（重点: I4 の直列化と SQL による Auth 削除、ガード trigger、ACL、backfill 規則、preflight の exactness）。merge / 適用はレビューと別途承認の後。

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


## Final K5 — Phase 1 lifecycle foundation

- verdict: **PASS to focused Codex review; merge/deploy/apply HOLD**.
- accepted source candidate: PR #70 exact head `89cf128bd9219897806b2b641cce4866f6e16c52`, 7 files, additive schema/tests/docs only.
- scope quality: no client/Edge/runtime wiring, no existing table/policy/grant/function rewrite, no G4 PR #65 file overlap.
- concurrency evidence accepted as candidate evidence: real PostgreSQL two-session race coverage, both provisioning-vs-delete commit orders, existing profile/X onboarding creators, no-deadlock case, rollback/reapply, mutation checks.
- production mutation: **0**; production read: 0; migration/backfill/deploy/Auth/OAuth/Vault/Cron changes: 0.
- merge decision: **HOLD** pending H1 review of SQL Auth deletion semantics, lifecycle serialization, guard trigger, ACL/SECURITY DEFINER/search_path, preflight exactness, shadow backfill rules, rollback safety, and Supabase compatibility.
- source candidate is not approval to apply migration or change production deletion behavior.
- next reviewer: H1 `common-account-pr70-lifecycle-foundation-review-20261001`, recommended model **Sol（高）**.
- pre-production migration/apply decision, if reached later, requires a separate **Sol（極高）** gate.
- AI Lab diary: 候補あり — 共通ログインとサービスごとの利用登録を分ける土台を作り、利用開始と全体削除が同時に走るケースまで競合テストした内容を公開安全な表現で2026-10-01エントリへ反映。
