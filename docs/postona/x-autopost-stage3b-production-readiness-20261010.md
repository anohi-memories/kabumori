# POSTONA X自動投稿（Stage 3B）本番接続の準備 — 2026-10-10（G3）

- 判定: **PREPARED_BLOCKED_ON_G5**
  - ソースとローカルの検証は準備できた。
  - 本番で利用者の自動投稿を有効にする前に、G5 の利用権の確認、G4 の X 接続（アカウント本人の証明）、予約の作り方の 3 つが必要。
- この文書は準備のためだけのもの。本番への書き込み・適用・配備・X への投稿・権限の変更は、どれもしていない。
- 本番の確認は、カタログの読み取り（読み取り専用のトランザクション）と、Edge 関数のダウンロードによる照合だけ。

## 1. 本番の現状（2026-10-10 JST、読み取りのみ）

| 項目 | 本番 | 補足 |
|---|---|---|
| Stage 3B の migration 3 本（`20261006160000` / `160100` / `160200`） | **未適用**（関数・表・履歴なし） | `x_account_publish_authority` も無い |
| AI 相談 V1 の設定テーブル（PR81 の 2 本） | 適用済み（履歴 2 行） | 10/10 の S0〜S5 で確認。設定の行は 1 行で、`auto_post_preference` は 0 |
| Stage 3A（トークン更新の許可） | 関数・表あり（`x_account_refresh_rollout` は 1 行） | 履歴 `20260926032054` は無い（本番の履歴は repo と 1 対 1 ではない） |
| G5 の利用権の土台 | `public.service_entitlements`、`public.common_accounts`、`private.account_lifecycle_*`、`start/reactivate_x_autopost_service` がある | G5 の書き込みガード（PR #121 の `20261010051938`）は**未適用** |
| 前提の表の owner | `scheduled_posts` / `social_accounts` / `brands` / `brand_settings` / `social_mobile_content_settings` は、どれも postgres（superuser ではない） | 3 本の migration の owner の前提を満たす |
| 投稿済み記録の一意インデックス | `(social_account_id, x_post_id) WHERE x_post_id IS NOT NULL` がある | 完了処理の `ON CONFLICT` の前提を満たす |
| `brand_settings.enabled_post_types` | jsonb | 権限確認の `?` 演算子の前提を満たす |
| API ロールの継承 | anon / authenticated から postgres や service_role へ届く経路は無い | 3 本の前提検査が通る想定 |
| 既定の権限（postgres） | 表は anon / authenticated / service_role、関数は owner だけ | 各ファイルの事後条件が、想定外の付与先を拒否する |
| x-test-post（v141、10/08 07:11 JST に配備） | **POSTONA 向けの投稿経路は入っていない** | main とは 4 ファイル違う（下記 §6） |
| POSTONA のワークスペース | 2 件。live 0、X 接続 2（本人確認済み 1）、`publish_enabled` 0、`brand_post` 有効 0、予約 0 | 今の状態では、どの経路からも投稿されない |
| brand_post の予約を作る DB 関数 | **無い** | Cron（`dispatch-scheduled-posts` は毎分）は、既存の予約を取って実行するだけ |
| Edge の秘密情報（名前のみ） | `OPENAI_API_KEY`、`X_CLIENT_ID/SECRET`、`X_VAULT_ACCOUNT_REFRESH` などがある | 値は読んでいない |

## 2. 投稿までの実行順と、今ある止めどころ（ソース上）

x-test-post（`dispatch-scheduled-posts` から毎分）の流れ:

1. `claim_due_post()`: 期限の来た `pending` の予約を 1 行だけ `running` にする（`for update skip locked`）。
2. ブランドの文脈を解決し、`assertBrandPublishAllowed` で確認する（brand が live、`brand_post` が有効、アカウントの `publish_enabled`）。
3. かぶモリ以外は、Vault にあるそのアカウントの認証情報を読む（`VaultAccountXAuth.load`）。
   - この読み込みは、予約に結びついていて生成より前に行う。
   - トークンの更新は、Stage 3A の `x_account_refresh_rollout` と `X_VAULT_ACCOUNT_REFRESH` で別に制御されている。
   - **注意:** この認証情報の読み込みは、手順 4 の投稿権限の確認より前に走る。
4. `dispatchVaultAccountScheduledBrandPost`（ai_salaryman_lab 以外の brand_post）:
   1. ブランド ID の除外（kabumori / ai_salaryman_lab）
   2. コードプロフィールが `social_mobile_user_v1` か
   3. アカウントの完全一致
   4. 投稿種別
   5. **`check_x_account_publish_authority`（1 回目、生成の前）**
   6. `read_social_mobile_publish_settings` で、`approvalMode = auto_post_preference` か
   7. 生成（140 文字の上限、NG 語、ほかのブランドとの重複）
   8. **`check_x_account_publish_authority`（2 回目、X への投稿の直前）**
   9. X に 1 回だけ投稿 → `complete_vault_account_brand_post`
5. `check_x_account_publish_authority` が見るもの:
   - 予約が running の brand_post か、ブランドと X アカウントが 1 対 1 か、アカウントが一致するか
   - brand が active かつ live か、アカウントが `identity_verified` かつ `publish_enabled` か
   - `brand_settings` で brand_post が有効か
   - 投稿権限の行が `enabled` で、期間内（最長 30 日）か（`off` / `revoked` / 開始前 / 期限切れは拒否）
   - 同意（`auto_post_preference`）があるか
   - **G5 の利用権（`x_autopost`）は見ていない。**

## 3. 3 本の migration（本番に入れるときの前提）

| 版 | 中身 | 前提 | 権限 |
|---|---|---|---|
| `20261006160000` | `complete_vault_account_brand_post`（SECURITY DEFINER、`search_path=""`） | Stage 3A の表、投稿済み記録、実行ログ。`scheduled_posts` と `social_accounts` の owner が適用ロールで、superuser でない。API ロールの継承が無い | EXECUTE は owner + service_role だけ（それ以外の付与先があればファイル全体を取り消す） |
| `20261006160100` | `read_social_mobile_publish_settings`（DEFINER、owner は設定テーブルの owner） | 設定テーブルと検証関数、`complete_...`、`brands.code_profile_key`。service_role が設定テーブルに一切届かない | service_role だけ |
| `20261006160200` | `x_account_publish_authority` の表（RLS あり、service_role は SELECT だけ）、`check_...`（INVOKER）、`set_...`（DEFINER） | 上の 2 本と `brand_settings`、`social_accounts` の owner | 関数は service_role だけ、表は owner + service_role の SELECT だけ |

- 3 本とも、ファイルの中に `BEGIN` / `COMMIT` を持っている。前提が足りない、再適用、想定外の付与先のどれかがあれば、ファイル全体が取り消される。
  - → `db push` は使わない。1 本ずつ「スキーマを適用 → カタログの読み戻し → 履歴を 1 行」の順の runner で行う（`ai_lab_topic_claims_rollout.sh` と同じ形）。
- 順番は **160000 → 160100 → 160200** だけ。逆順は前提の検査で拒否される（ローカルで確認済み）。
- 版の重なり: G5 の `20261010051938`（PR #121、未適用）、AI 予算の `20261010050613`（PR #119、未適用）とは、名前も対象も重ならない。
  - 本番の履歴の最大値は `20261007214402` なので、3 本は「古い版を後から入れる」形になる（`db push` を使わない理由がもう 1 つ増える）。

## 4. AI 相談の記憶と、自動投稿の同意は別のもの

- AI 相談 V1 が保存できるのは、トーン・テーマ・目的・頻度・NG 語・メモと、ペルソナの 8 項目だけ。
  - `approvalMode` は、相談の差分の許可リスト（アプリ側とサーバー側の両方）に入っていない。
  - 会話からは**自動投稿の同意も投稿権限も作られない**（PR #78 / #114 のテストと、今回の R1）。
- 正しい同意（opt-in）: 本人が設定画面で `approvalMode = auto_post_preference` を選ぶ（本人の RLS の範囲で書き込む）。
- 取り消し（opt-out）: `manual_review` に戻すと、次の権限確認で `SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED` になる。生成中に取り消しても、X への投稿直前の 2 回目の確認で止まる。
- 運用側の許可:
  - `set_x_account_publish_authority('enabled', 開始, 終了)` で、最長 30 日の期間を作る（service_role だけが実行できる）。
  - `off` / `revoked` で、すぐに止まる（commit した時点から有効。PR #41 の競合テストで確認済み）。
- ブランド・アカウントの完全一致: 1 ブランドに X アカウント 1 つ。予約・ブランド・アカウントの ID がすべて一致する場合だけ。かぶモリと AI ラボは常に除外される。

## 5. 見つかった抜け（担当別）

### G5（共通アカウント・利用権）— 本番で有効にする前に必須
1. **`check_x_account_publish_authority` に、利用権（`x_autopost` が active）の確認が無い。**
   - ローカルの R3（MOCK_ONLY）で、利用権が「終了」でも `allowed` を返すことを確認した。
2. **`set_x_account_publish_authority('enabled')` にも同じ確認が無い。** 終了したサービスでも、もう一度有効にできてしまう（R3）。
3. **予約の取得（`claim_due_post`）にも確認が無い。** 終了したサービスの予約が取られ、Vault の読み込みまで進む（その後、1 と 2 が入っていれば止まる）。
4. **退会・サービス終了の削除順**:
   - `x_account_publish_authority.social_account_id` の外部キーは NO ACTION。権限の行があると、`revoked` の状態でも X アカウントを削除できない（R4）。
   - service_role はこの行を削除できない（RLS と権限のため）。
   - 本番では、ほかにも `published_content_fingerprints`、`social_account_oauth_states`、`x_account_refresh_rollout`、`x_account_refresh_state_v2` が、同じく NO ACTION で `social_accounts` を参照している。
   - → G5 の削除処理（PR #112 系）は、「権限を `revoked` にする → 権限の行を削除（owner の経路）→ アカウントを削除」の順を契約に入れる必要がある。
   - または、G3 が外部キーを ON DELETE CASCADE にする migration を別に出す（G5 との合意が必要）。
5. 古い JWT やサービス終了後の書き込み: G5 の T13 書き込みガード（`private.account_lifecycle_assert_active_service_write`、PR #121）は下書きで、**未適用**。これを前提に安全とはみなさない。

G5 への引き継ぎ（1 つにまとめた契約案）:
- 入口: `check_x_account_publish_authority`、`set_x_account_publish_authority('enabled')`、ユーザーの brand_post の取得。
  - 3 か所とも「そのブランドの owner の `x_autopost` 利用権が active で、アカウントが削除中でない」ことを、同じトランザクションの中で確認する。
  - G5 が提供する `private.*` の確認関数を、G3 の 3 か所が呼ぶ形を提案する。
- 削除: 上の削除順か、カスケードのどちらにするかを G5 が決める。

### G4（X / Threads の接続）— 本番で有効にする前に必須
- 接続した X アカウントが本人のものであることの証明（`platform_user_id` と OAuth の由来）と、ワークスペースの作り方（T9）は、G4 の X OAuth 強化 TASK と PR #124 の担当。G3 は実装しない。
- 今の権限確認は `connection_status = 'identity_verified'` を信頼しているので、その状態を誰がどう付けるかは G4 の証明に依存する。

### G3（自分の担当、今回は文書化のみ）
- **POSTONA の予約を作る仕組みが無い**（本番にもリポジトリにも、brand_post の予約を作る関数が無い。AI ラボの予約は運用側で入れている）。
  - 利用者の頻度（`frequencyTargetPerWeek`）から予約を作る仕組みは、別の TASK で設計する（scheduler の変更は今回の禁止範囲）。
- 投稿権限の確認の前に、Vault の読み込みとトークン更新が走る（§2-3）。
  - 費用は無く、Stage 3A の許可で制御されているが、権限確認を先にする順番に変えるかは、配備のときに検討する。
- x-test-post の配備: 本番の v141 と main は 4 ファイル違う（`x-test-post/index.ts`、`_shared/brand/brand_post_generator.ts`、`_shared/brand/social_mobile_content_settings.ts`、`_shared/brand/ai_lab_dev_diary_context.snapshot.ts`）。
  - Stage 3B のために x-test-post を配備すると、ほかの merge 済み・未配備の変更（AI ラボの文字数上限の撤廃など）も一緒に出る。
  - → 配備の前に、配備済みのバイト列との差分を、変更の持ち主ごとに確認する。

## 6. ローカルでの検証（使い捨ての PostgreSQL 17.11、本番には接続していない）

`supabase/tests/postona_x_autopost_readiness/run.sh`（本番の形の Stage 3A + PR81 のフィクスチャの上で実行）:

| 項目 | 結果 |
|---|---|
| O1 逆順（160100 を先、160200 を単独）は前提の検査で拒否され、何も残らない | PASS |
| A1〜A3 3 本それぞれに COMMIT 直前で失敗を入れると、そのファイルの物は何も残らない | PASS |
| R1 AI 相談の記憶（確認済みのペルソナ + `manual_review`）は同意にならない | PASS |
| R2 今あるゲートをすべて満たせば `allowed` になる（基準） | PASS |
| R3 G5 の利用権が無い（MOCK_ONLY: 利用権が「終了」でも確認と再有効化が通る。セキュリティの証拠には数えない） | 抜けを確認 |
| R4 権限の行（`revoked` でも）が X アカウントの削除を止める | 抜けを確認 |

既存の PR #41 の検証も再実行した:
- `x_account_refresh_pilot_run.sh`: 動作・権限・設定の読み取り・競合・後片付けの 6 項目 PASS。
- `x_account_stage3b_acl_adverse_run.sh`: STAGE3B_ACL_ADVERSE_PASS。
- Deno（`_shared/brand`、x-test-post、相談、プレビュー、migration の不変条件）: 808/808。

## 7. 判定表（go / no-go）

| ゲート | 状態 | 担当 |
|---|---|---|
| 3 本の migration のソース・順番・取り消し・権限 | ✅ ローカルで確認済み | G3 |
| 本番の前提（owner・インデックス・列の型・ロール） | ✅ 読み取りで一致 | G3 |
| 適用用の runner（スキーマ → 読み戻し → 履歴） | ⏳ 未作成（次の TASK） | G3 |
| G5 の利用権の確認（確認・設定・取得の 3 か所） | ❌ 無い | **G5** |
| 退会時の削除順 / 外部キー | ❌ 未決定 | **G5**（+ G3） |
| G5 の T13 書き込みガード | ❌ 下書き・未適用 | **G5** |
| X アカウントの本人証明・ワークスペースの作り方 | ❌ 実装中 | **G4** |
| POSTONA の予約の作り方 | ❌ 無い | G3（別の TASK） |
| x-test-post の配備のまとめ方（4 ファイルの差） | ⏳ 確認が必要 | G3 + 各変更の持ち主 |
| 独立したセキュリティレビュー（Sol 高） | ⏳ G4 と G5 の実装がそろってから | ChatGPT |
| 限定パイロット | ⛔ 上のすべての後 | ユーザーの承認 |

## 8. 今後の手順（案）

1. **G5**: 利用権の確認関数と削除順の契約を実装する（§5 の引き継ぎ）。
2. **G4**: X の本人証明と、ワークスペースの作り方の候補を作る。
3. **G3**: 次の 2 つを作る。
   - 3 本の migration に G5 の確認を足す（新しい migration で `check` / `set` を置き換える形）。必要なら外部キーの方針も反映する。
   - 適用用の runner。
4. **独立レビュー（Sol 高）**: G3・G4・G5 をまとめたものを、一度だけ。
5. **本番への適用**（別の承認）:
   - 読み取りでの事前確認
   - 160000 → 読み戻し → 履歴
   - 160100 → 読み戻し → 履歴
   - 160200 → 読み戻し → 履歴
   - G5 の確認（新しい migration）→ 読み戻し
   - x-test-post の配備（差分の持ち主の承認を得て）→ バイト照合
6. **限定パイロット（提案のみ。実行は別の承認）**:
   - 専用のテスト用アカウント 1 件、本人の明示の同意（`auto_post_preference`）
   - 投稿権限は最長 24 時間の期間で 1 件。予約 1〜2 件を運用側で手入れ
   - 想定: X への投稿 1〜2 件、AI の生成 1〜2 回（相談の 3 回と同じくらいの費用）
   - 予定外の投稿 0 を前後比較で確認する（予約・実行ログ・投稿済み記録・`publish_enabled` の指紋）
   - すぐ止める手順: `set_x_account_publish_authority('revoked')` → `publish_enabled=false` → 同意を `manual_review` に
   - X のレート制限: 1 アカウント 1 日 1〜2 件なので余裕がある
   - パイロットの前に、独立したセキュリティレビューを済ませる

## 9. プレビューと実際の投稿の違い

- プレビュー（`social-mobile-brand-dry-run` v17）:
  - 確認済みの設定とペルソナの指示で下書きを作るが、**文字数の上限は無い**（10/10 の確認では 184 文字）。
  - 投稿・予約・権限は変えない。
- 実際の投稿（Stage 3B の経路）:
  - 同じ設定とペルソナを、公開時の読み取り（`read_social_mobile_publish_settings`）から使う。
  - ただし **140 文字の上限**、NG 語、ほかのブランドとの重複の確認があり、同意・権限が無ければ生成もしない。
  - → プレビューは「方向性の確認」で、同じ文章が投稿されるわけではない。今は投稿の経路自体が本番に無いので、覚えた設定から自動で投稿が始まることはない。
