# POSTONA X 予約の保存と実行 — オフライン候補 V1（2026-10-11、G3）

- 判定: **PASS_SOURCE_CANDIDATE_WITH_G5_G4_HOLD**
  - 保存・一覧・日時変更・再確認・取り消しと、取得・リース・完了の仕組みは、ソースと手元の検証まで完成した。
  - 本番では無効: 本番に適用せず、API の入口も無く、アプリの保存フラグも OFF。
- **予約はまだ本当には保存されない。** アプリを閉じると予定は消え、X には投稿されない。そうなるのは §6 の条件がすべてそろい、別に承認された適用と読み戻しを終えたあと。

## 1. 置き場所（すべて G3 の新しいパス）

| 層 | ファイル | 中身 |
|---|---|---|
| DB 候補 | `supabase/candidates/postona_x_reservations/001_postona_x_reservations.sql` | 専用スキーマ `postona_x_resv`（PostgREST の公開スキーマではない）、表、関数、事後条件。`supabase/migrations/` には入れていない |
| DB 検証 | 同じフォルダの `test_fixture.sql` / `test_behavior.sql` / `run.sh` | 使い捨てのローカル PostgreSQL だけで動く（`/tmp` のソケット以外は拒否） |
| 実行の境界 | `supabase/functions/_shared/postona_reservations/worker.ts`（+ `_test.ts`） | どの Edge・Cron・既存の待ち行列にもつないでいない |
| アプリ | `apps/social-mobile/src/domain/reservation-flow.ts`、`src/features/schedule/reservation-store.ts`、`src/app/(tabs)/schedule.tsx` | 保存の流れ（純粋な関数）、保存のフラグ OFF の保存先、「予約として保存（準備中）」の無効なボタン |

既存の `scheduled_posts`（ブランド単位）、`claim_due_post`、AI ラボやかぶモリの待ち行列は使わないし、変更もしていない。

## 2. サーバーの約束（SQL 候補）

### 表
- `batches`: 所有者・ブランド・X アカウント・`client_batch_id`・`revision`・モード・由来・`Asia/Tokyo`・期間と時間帯（band）・内容のハッシュ。`(user, account, client_batch_id, revision)` で一意。
- `reservations`:
  - 1 投稿 1 行。状態は `planned → claimed → published | failed | uncertain`、または `planned → cancelled | expired`。
  - 版数、同意（本文のハッシュ・日時・版数に結びつく）、リース、X の投稿 ID を持つ。
  - 手動は本文とハッシュが必須。AI は本文なし。
- `audit`: 操作・版数・時刻だけを記録する（本文は残さない）。
- RLS は有効で、ポリシーは無し。anon・authenticated・service_role・PUBLIC には、スキーマ・表・シーケンス・関数のどれの権限も無い（ファイルの事後条件が、違反があれば全体を取り消す）。
- ブランド・X アカウントの削除で、予約も一緒に消える（G5 の削除を止めない）。

### 所有者の操作（SECURITY DEFINER、`search_path=''`、API ロールには実行権限なし）
- `create_batch(account, client_batch_id, revision, mode, band, items)`
  - 全件か 0 件か（途中までの保存は無い）。
  - 同じ鍵・同じ内容の再送は、同じ行を返す。同じ鍵で内容が違えば `IDEMPOTENCY_CONFLICT`。
  - 時刻: 5 分以上先、90 日以内、ランダムと AI は期間・時間帯の内側だけ。
  - 本文: X の重み付き 280 以内。手動は投稿ごとの同意（本文のハッシュが一致すること）が必須。
  - アカウントごとに、最小間隔 60 分、1 日 10 件、1 か月 300 件。既存の予約と重なれば `SLOT_CONFLICT` で、勝手にはずらさない。
  - AI の枠は、ブランド自身の `auto_post_preference` をサーバー側で読む。本文は受け付けない。
- `list_reservations`、`reschedule`（明示の操作。手動は同意が `needs_reconfirm` になる）、`reconfirm`（今の本文のハッシュが必須）、`cancel`（`planned` だけ。取り消しは最終で戻らない。`claimed` は `CANCEL_TOO_LATE`）。

### 呼び出し元の確認（毎回、その時点の状態で）
- 呼び出し元は `auth.uid()`（検証済みの JWT の主体）だけ。
- X アカウントは本物の `x` で、呼び出し元がそのブランドの **owner**。他人のアカウント・Threads・member は区別なく `ACCOUNT_NOT_FOUND` にする（存在を推測させない）。
- プロフィールは `social_mobile_user_v1` のみ。
- G5 の判定 `g5_x_autopost_allowed(user)` と、G4 の判定 `g4_x_account_verified(user, account)` を通る必要がある。どちらも **常に false のスタブ**（下記）。

### 実行（将来のワーカー用。今は誰にも実行権限なし）
- `claim_due(worker, lease_seconds, limit)`:
  - 先に整理する: 期限切れの `planned` は `expired` に、リースが切れた `claimed` は `uncertain` にする（**再取得しない**）。
  - 期限が来て、同意が今の本文・日時・版数と一致し、所有・G5・G4 を満たす手動の行だけを、`for update skip locked` で取得する。
  - V1 では AI の枠は取得しない。
- `pre_publish_check`: 投稿の直前に、リースが自分のものか、まだ投稿してよいかを確認する。だめなら `failed`（`NOT_PUBLISHABLE_AT_SEND`）にして送らない。
- `finish`:
  - `published` は投稿 ID が必須。同じ報告の再送は冪等。
  - `failed_before_send` は、送っていないことが確かな場合。`uncertain` は結果が分からない場合。
  - リースを失っていれば `LEASE_LOST`。

## 3. 実行の境界（TypeScript）

- `runReservationDelivery`:
  - 投稿処理が使えない場合は **何も取得しない**。本番用は `PRODUCTION_PUBLISHER_NOT_AVAILABLE` しか無い。
  - 1 リースにつき送信は 1 回だけで、再試行はしない。
  - 投稿 ID が不正・例外・応答不明・記録の失敗は、すべて `uncertain` にする。成功にはしない。
- 手動の本文は、保存されたものをそのまま送る（AI の生成は通らない）。AI の本文生成は V1 には無い。

## 4. アプリ（保存のフラグ OFF）

- `POSTONA_RESERVATION_PERSISTENCE_ENABLED = false`（そのままの値）。`createReservationStore()` は、フラグに関係なく無効な保存先を返し、通信しない。
- 流れ（`reservation-flow.ts`）:
  - 手動は、投稿ごとに「本文・日時・アカウント」を確認する。時刻・本文・アカウントが変われば確認は無効。
  - 確認済みの、取り消していない投稿だけで保存の依頼を作る。
  - 読み戻しで、全件が `planned` かつ時刻が一致し、同意も一致したときだけ「予約済み」にする。
  - AI は、選択中のアカウントのブランドで実際に読めた `auto_post_preference` のときだけ。初期値や AI 相談からは作れない。
- 画面:
  - 「予約として保存（準備中）」は無効なボタン。押しても何も送らないことを表示する。
  - 「プレビュー／未予約・投稿されません」はそのまま。
  - PR #138 で直した点（R1・R2・R2b・R3）はそのまま。

## 5. 手元での検証（本番には接続していない）

- DB（PostgreSQL 17.11、使い捨て、既定の権限は最悪のケース）: `run.sh` → `POSTONA_RESV_CANDIDATE_ALL_PASS`
  - 適用の拒否・失敗時の全取り消し・再適用の拒否、API ロールからは一切届かない
  - スタブのままだと全部拒否される
  - バッチの不可分性と冪等性、テナントの分離（他人・Threads・別ブランド・member）、検査で途中保存が無いこと
  - AI の同意をサーバーで読む、日時変更での同意の無効化・再確認・取り消し
  - 取得・リース・完了・リース切れ・不明、取得後に権限が無くなった場合、削除による連鎖
  - 2 つの接続からの同時実行（同じ鍵での二重予約なし、重なる時刻は 1 つだけ、2 ワーカーで各行 1 回だけ）
- 変異テスト: 9 種類（G5 が常に許可・owner の確認なし・同意の確認なし・アカウントのロックなし・リースの整理なし・skip locked なし・実行権限の付与・取得後の取り消しを許す・同意を見ない）をすべて検出した。
- **MOCK_ONLY の注意**: 許可が必要な検証は、使い捨ての DB の中で G5 / G4 の判定を **偽物に置き換えて** 行った。本物の G5 / G4 の境界が安全だという証拠ではない。

## 6. 公開までの条件（どれも未完了 → HOLD）

| 条件 | 担当 | 状態 |
|---|---|---|
| `x_autopost` 利用権 + アカウントのライフサイクル（削除中・ロック）+ T13 の書き込みフェンスを、`g5_x_autopost_allowed` の本物として、同じトランザクションの中で提供 | **G5** | 未（PR #121 は下書き） |
| X アカウントの本人証明と公開の許可（Issue #131）を、`g4_x_account_verified` の本物として提供 | **G4** | 未 |
| 本番への入口（Edge か RPC か）。JWT の検証と、PostgREST への公開の方法 | G3（G5 / G4 の後） | 未。今は API に公開しない |
| 独立のセキュリティレビュー（Sol 高）を、G3 + G4 + G5 をまとめて 1 回 | ChatGPT | 未 |
| 本番への適用（スキーマ → 読み戻し → 履歴）と、限定パイロット | ユーザーの承認 | 未 |

- 旧 PR #127（Stage 3B の 3 本）との関係:
  - この予約の仕組みは、Stage 3B の `x_account_publish_authority` や `brand_post` の経路を **使わない**（別の待ち行列）。
  - 本番に出す順番は「G5 の本物 → G4 の本物 → この候補を migration にする → 入口 → ワーカー」。
  - Stage 3B（AI ブランド投稿の経路）は、AI の本文生成が必要になった段階で、別に判断する。

## 7. 巻き戻し

- 適用は 1 ファイル 1 トランザクション（失敗すれば何も残らない）。
- 適用後の巻き戻しは、`postona_x_resv` スキーマをまるごと消すだけ（他の表を参照されないので、既存のデータに影響しない）。別の承認のもとで行う。
- 保存のフラグは、ソース上の定数。戻すときはアプリの更新になる。

## 8. 承認後に 1 回だけ行う X のテスト投稿（計画のみ）

1. ユーザーが用意した専用のテスト用アカウント 1 件（G4 の本人証明済み、G5 の利用権が有効）。
2. 手動の「指定日時」で 1 件だけ、本文と日時をユーザーが確認して保存 → 読み戻しで「予約済み」。
3. ワーカーを 1 回だけ手で動かす（Cron にはつながない）→ `published` と X の投稿 ID を読み戻す。
4. 前後比較: 他の予約・既存の予定・かぶモリ / AI ラボの投稿に変化が無いこと。
5. 片付け: 投稿の削除は、ユーザーが X 上で判断する。予約の行はそのまま残す（監査）。
