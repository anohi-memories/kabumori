# POSTONA Threads Phase 2b × 共通アカウント G5 — T9/T10/T13 共通I/F決定

- 決定日: 2026-10-10 JST
- 文書区分: **設計・担当境界の合意のみ。実装／レビュー／本番適用の完了を示さない。**
- 依頼元: POSTONA G4 (Threads Phase 2b) → 共通アカウント G5
- 推薦モデル: **Opus5.5（高）**
- 既存G5 TASK: `common-account-phase3b-identity-writer-fence-source-20261010` **変更・上書き禁止**
- 正本参照: `docs/postona/threads-connection-phase2b.md` §0.8, §8, §9, §11; `docs/common-account/phase1-lifecycle-foundation.md`, `phase2-service-enrollment.md`, `phase3a-deletion-orchestrator.md`; `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql`; `20261006230000_common_account_service_start_intent.sql`.
- 事実: PR #118 は共通化前提の**無配線プロバイダ契約**として main に統合済み。Phase 2a-2 の migration は source merge 済みだが **本番未適用**。Threads の静的接続ゲート `THREADS_CONNECT_PREREQUISITES_MET=false` は変更しない。共通アカウント Phase 3a PR #112 も source merge 済み、管理 Auth 削除は DB `blocked` release gate で無効。
- **「決定」**はインターフェース・責務・fail-closed方針の合意。「実現可能性実証」は後続G5 Stage A／G4実装・ローカルDB／使い捨て実Supabase検証を要する。新しいRPC、provider revoke API、Auth identity fenceの存在を主張しない。

## 共通の前提（T9/T10/T13に優先）

1. 共通 Supabase Auth ID は一つ。POSTONA は現行の `service_key='x_autopost'` を **Threads/将来Instagramを含むPOSTONA全体の利用権**として用いる。サービス名の文字列変更や `threads` の新規 entitlement はしない。
2. Threads の begin/complete は利用権の作成・終了・再開をしない。`common_accounts` と `service_entitlements` を変更しない。利用登録はG5の既存 `start_x_autopost_service()`／明示 `reactivate_x_autopost_service(bigint)` だけが扱う。終了済み利用権をサインインやOAuth callbackで暗黙に再開しない。
3. モバイル AuthGate はUIの入口制御に過ぎない。DBで**その都度**現在のライフサイクルと利用権を決める。JWTがまだ有効でも、利用終了・共通削除中なら拒否。
4. 新規接続直後は `publish_enabled=false`。Threads 投稿・スケジューラ・投稿許可は今回の範囲外。
5. G5は**共通アカウント・利用権・削除・書き込みfence**の契約と安全性を所有する。G4は**POSTONAのworkspace生成・Threads OAuth RPC/Adapter・provider別credential清掃**を所有する。G3のAI相談・投稿境界を勝手に変更しない。変更範囲が重なる場合は別TASKで調整し、既存スロットは上書きしない。

## T13 決定：同一トランザクション内の書き込みfence（G5-owned）

**設計インターフェース名（新設候補／現時点では実在しない）**
`private.account_lifecycle_assert_active_service_write(p_user_id uuid, p_service_key text) RETURNS void`

- G5が関数本体、所有者、GRANT/REVOKE、migration、前提条件・契約テストを所有。原則 G4 が使う値は `p_user_id=(select auth.uid())`、`p_service_key='x_autopost'` に固定。関数は**サーバー検証済みJWTからの `auth.uid()` と p_user_id の完全一致**を再確認する（サービスロールや利用者入力の任意 user_id を信頼しない）。`auth.uid()` 不明、未検証、ロール／権限の想定外は拒否。
- `SECURITY DEFINER SET search_path=''` を使う場合は関数所有者・実効ACL・ロール継承・SET ROLE・PUBLIC default EXECUTE・呼出し先と呼出し元の権限をG5が正確に固定する。**一般クライアント・service_roleがこの内部判定だけを直接実行できない**ようにする。呼べるのはG5に許可されたreview済みowner-controlled SQL writer（G4のThreads/X関連RPC）だけ。既存Phase1/2のowner権限に不整合があるなら STOP、別の明示的な安全設計を提示。
- `READ COMMITTED` が必須。既存 `private.account_lifecycle_lock(p_user_id,false)` と同じ**ロック順**を採用: `auth.users` 対象者行 `FOR KEY SHARE` → `common_accounts` 行 `FOR UPDATE` → `service_entitlements` の `x_autopost` 行 `FOR UPDATE` → その後に workspace / membership → OAuth state → social_accounts / Vault 等の接続資産。既存の全削除・POSTONA退会ともこの順で直列化し、別順序のG4ロックを先に取らない。
- 認可判定: ログイン実在、`common_accounts.status='active'`、開いている共通アカウント削除 operation が無い、`service_entitlements('x_autopost').status='active'`、要求主体と本人/対象service一致、writerおよび依存オブジェクトの健全なowner/ACL。missing/unknown/deleting/ended/suspended/locked は拒否。状態未整合・検査不能もfail-closed。存在しない共通アカウントや利用権を作成しない。
- **同じSQLトランザクションの冒頭**で判定し、判定で取得したロックをcommit/rollbackまで保持してからブランド／state／secret参照を変更する。RPC呼出しの前にアプリ側で判定するだけでは不十分。G4の `begin_social_mobile_threads_oauth_connection` と `complete_social_mobile_threads_oauth_connection` の**両方**で必須（OAuthをまたいでロック保持できないため）。完了までの外部token交換が済んでから現在の利用権が無効と判明したら、Vault/Threads行は書かず、使い捨てcodeは再送せず新規接続フローが必要。
- エラーコード（提案される公開固定コード契約、最終SQL例外／HTTP対応はG5がレビューして決定）:
  - `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`, `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND`;
  - `ACCOUNT_DELETION_IN_PROGRESS`, `ACCOUNT_LOCKED`;
  - `SERVICE_NOT_REGISTERED`, `SERVICE_DELETION_IN_PROGRESS`, `SERVICE_NOT_ACTIVE` (ended/suspended/unknown);
  - `ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE` (schema/ACL/version/guard missing or inconsistency).
  固定コードのみ返し、JWT/secret/token/code/provider body/所有者IDをレスポンス・ログに出さない。新しいコード名は**実装時の最終定義前の契約候補**であり、既存RPCが返す理由コードと一対一で整合させる。成功を疑似生成しない。
- `authenticated` から見えるG4のRPCがこの内部G5判定を呼べるだけでは不十分。権限変化/例外/owner mismatch時に**書き込みまで進まない**こと、APIロールのhelper直接実行が不可であること、旧X接続や退会と並行した場合も原子的に順序が決まることを使い捨てPostgreSQLで証明する。Supabase Authの新規identity link raceは別のG5 Phase3b blockerのまま。本契約だけでは共通Auth削除の解禁にならない。
- provider tokenの配送／OAuth codeの消費はHTTPで発生し、DBロック外である。G4はclaim/state再利用防止・期限と後続writeの再チェックを守り、失敗したcodeを自動再試行しない。
- **本番fence実装・レビューが揃うまでThreads接続ゲートはfalse**。既存X onboarding/writersにも同種fenceが必要であるが、G4/G5境界を越えて勝手に変更しない。

## T9 決定：POSTONAのpersonal workspaceは単一の共通作成口（G4-owned）

- **作成責任者はG4（POSTONA側）のprovider中立workspace provisioner**。G5の `start_x_autopost_service` にworkspace生成を混ぜない。共通ID・利用権を作るのはG5、`brands` / owner membership の生成はG4と役割分離する。
- 新設インターフェース候補: **`private.social_mobile_ensure_personal_workspace(p_user_id uuid)`**（G4管理、テーブル所有者のSECURITY DEFINER下で、T13の成功後に同一DBトランザクションで呼ぶ内部処理）。必要であればauthenticated onboardingの公開wrapper `public.ensure_social_mobile_personal_workspace()` を設ける。名前は実装の予約案であり現存を主張しない。
- `auth.uid()` に紐づく既存の**決定論的 self-service workspace**を使う。あればowner membership / `code_profile_key='social_mobile_user_v1'` と第三者不在を検証し、なければownerとmembershipを原子的・冪等に生成する。foreign/shared/admin workspaceを自動的に引き取らない／変更しない。G5の `private.account_lifecycle_footprint` と整合させる。
- Threadsだけを使う人もPOSTONA利用登録を先に行い、この**同じ provisioner**でworkspaceを用意できる。Threads begin自身にはprovider固有のworkspace直接INSERTを置かず、同トランザクションで共通 provisionerを呼べる（ただしT13先行）。OAuthのX実接続をワークスペース作成のために偽装実行しない。
- 既存の `begin_social_mobile_x_oauth_connection` にあるworkspace作成は**Threads一般公開前**に共通 provisionerへ委譲し、XとThreadsで二種類のbrand作成SQLを持たない。Xが旧経路を使う移行期間は新Threads開始をfalseのままにする。G4所有の既存X RPCの変更はG4の別TASKで行い、G5が勝手に改変しない。
- 何度呼んでも1 workspace/ownerだけ、削除開始との競合はT13で決定、未知の既存所有構造・FK・membership conflictはfail-closed。workspace作成は`service_entitlements`を変更しない。

## T10 決定：provider-aware cleanupをThreads公開の**前提**にする

1. **2種類の退会を分ける**:
   - **POSTONAのみ利用終了**: `x_autopost` entitlementとPOSTONAの作成物・認証情報だけを終了し、共通 Auth IDとかぶモリを維持。XとThreads両方の接続があれば**双方**を後始末する。Threads接続があるから常に`operator_required`とする暫定X専用状態から移行する。
   - **共通アカウント全削除**: 全サービス、session、provider、Storage、最終Auth管理削除を伴う。Phase3a `managed_auth_delete` のスキーマ封鎖を解除しない。G5のidentity/writer fence・使い捨て実Supabaseテストと別の承認が揃うまで **BLOCKED**。
2. **cleanupはplatformでdispatch**。XはX用の既存revoke/credential削除を使用し、Threads tokenをX revokeへ渡さない。Threadsは投稿停止→自動処理停止・未処理oauth state拒否→Vaultの長期access secret削除とDB参照クリア→provider local row/ownership footprint清掃・readback。X・Threads・将来Instagramで資格情報形状を混同しない。Vault失敗や再一覧不明は**成功ではなく保留/運営確認**にする。provider間でsecret id共有は拒否。
3. **Threads remote revoke APIは未検証**。公式に確認できる方法がない間、**ローカル資格情報削除を「Meta側連携解除済み」と偽らない**。利用者にはThreads側でアプリ連携解除が必要な可能性を明示し、遠隔状態を `remote_unverified` と別管理する。remote revokeが未実装でも、ローカルのトークンと投稿権限が消え再確認できた場合、**POSTONA単独利用終了**は完了可能とするプロダクト仕様（残るremote grantの説明は必須）。一方、**共通Auth全削除の安全完了**やremote revocationの監査はこの状態だけで満たしたとしない。失敗したローカル削除・不明な実行結果はfail-closedでreconciliation。
4. G5は削除state-machineと entitlement確定を所有。G4はprovider cleanup adapter/DB state/secret処理を所有。契約上、G4 adapter結果は少なくとも `confirmed_remote_revoked`, `local_removed_remote_unverified`, `reconciliation_required`, `blocked` を区別し、G5のstate-machineへ固定コード・永続証拠で渡す（名称は設計契約。実装未確定）。ローカル清掃と利用権終了の途中失敗に偽の成功を返さず、永続step/冪等再開・クロスプロバイダ漏れなしの検証を追加する。
5. 既存X sagaにある`x_revoked`等のX固有の状態名をThreadsに流用して意味を偽らない。provider-cleanupの明示段階／集計層はG5が設計し、G4のadapter境界とレビューしてから移行する。未完了providerがあれば利用権終了を確定しない（前項の限定的local-only完了例外を明示したときだけ除く）。
6. Threadsユーザーに接続ボタンを出す前に、**provider-aware service-only cleanupと全削除のfail-closed相互作用を実装・統合テストし、独立セキュリティレビューする**。全削除自体の公開は別gate。

## 並行性と最低限の証明（後続実装担当へ）

- 競合: Threads begin vs 共通account削除、Threads complete vs POSTONAのみ利用終了、Threads-only workspace ensure vs 削除、XとThreads同時connect、callback遅着 vs 終了済み entitlement、2つのcompleteによるstate二重消費、期限切れstate、他人/他workspaceのstate、X stateの混入、reconnect identity mismatch。
- 権限: service_role/anon/authenticatedの直接テーブルINSERTや内部T13関数EXECUTE拒否、ownerのみ通るSECURITY DEFINER、意図しないrole inheritance / SET ROLE / PUBLIC/trigger injection拒否。G4の2a-2 preflight T11・T12は**未確認**、本番ACLと未管理の特権関数を読み取りで照合するまで有効化禁止。
- 後始末: X+Threads混在、Threadsのみ、Xのみ、非対応provider、Vault delete障害、遠隔revoke応答喪失、operator reconciliation、重複イベントを含む。退会後にstale JWTで再作成不可、local secretを消したこととMeta側解除確認を混同しない。
- テストはローカルの使い捨てDBとfake providerから始める。実際のGoTrue identity-link race、Meta callback/revoke、production grantsはここでは**未証明**。
- 1回の統合セキュリティレビューは**G5のwriter-fence実装とG4の本番接続RPC/credential/cleanup境界が揃った時点**で実施する。PR118無配線moduleやG5調整メモに個別のCodexレビューを重ねない。

## オーナー別次工程（本メモ自体はTASK割当ではない）

- **G5**: 現行Phase3b `common-account-phase3b-identity-writer-fence-source-20261010` をそのまま優先。Stage Aで本T13 contractの実効所有者/ロック/ACL実現性を検討し、可否と改訂が必要なI/Fを`K5`で報告。後続の別のsource-only taskで共有guardを実装・証明するのは安全性に応じて決める。T10 lifecycle集計はG5所有。
- **G4**: 現行G4 TASKはdone。新規G4 taskを別途割り当てるまでは開始しない。次はG5との契約一致を前提にprovider中立workspace provisioner、Threads begin/complete、provider-aware cleanupの候補をG4専用branchで設計し、実際のG5 guardが用意されるまでruntime接続を無効にする。X beginリファクタは同時変更競合を確認して段階実装。2a-2本番未適用とMeta app構成待ちは解消しない。
- **G3**: AI相談の本番作業中。POSTONA DB DDL / provider機密 / Edge / migration write windowsは独立に管理。G5/G4と重なる本番writeを同時に実行しない。
- **K5 / K4**: 次の実装TASK完了時に、本文の決定・未証明点・Changed Files/SQL/RPC境界を参照して調整。既存G5 TASK/Report・H1/H2・G1〜G4所有TASKは本メモのために変更しない。

## 今回の変更境界

**このファイルの新規作成だけ**。既存のG5 TASK、G4 TASK、`.agent/ACTIVE_TASK.md`、Supabase DB/migration/RPC、Auth、Edge、Vault、Meta、X、production、接続ゲートには一切変更を加えない。
