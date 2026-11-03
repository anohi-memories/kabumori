# Threads の長期トークンの延長：設計とオフラインのテスト（F4・2026-10-17 JST）

TASK: `postona-f4-threads-token-refresh-source-design-20261017`。設計と、手元だけで動くテストの候補。

- 延長の実行、スケジュール、Meta への問い合わせ、トークンや secrets の取得はしていない。
- 本番と試験運用は NO_GO。PR251 head `3163928d5fa3b8e6984f6350ce5a8faf31d23ffc` の上に積み、PR251 自体は変えていない。

## 0. 結論

- いまのコードには **延長がどこにも無い**（「2c」に先送りで、T7・T8 は未解決）。長期トークンは発行から60日で切れ、Meta の文書では、60日のうちに延長しないともう延長できない。延長が無いと、つないだアカウントは約60日で必ず「要再接続」になる。
- 今回は、延長の **方針・Meta との約束・1件ずつ確実に行う調整役** を、純粋なモジュール `supabase/functions/_shared/social/threads_token_refresh.ts` として置いた。
  - どこからも読み込まれず、スイッチ `THREADS_TOKEN_REFRESH_ENABLED = false`。
  - 保存（Vault の入れ替え・アカウントのリース・F5 のライフサイクルの柵）は **store port** という差し込み口で外に出し、ここでは作っていない。
  - 15件のテストを、ネットワークなしで用意した。

## 1. 事実と仮定

| 種類 | 内容 | 出典 |
|---|---|---|
| 文書の事実 | 延長は `GET /refresh_access_token`、`grant_type=th_refresh_token`、`access_token=<長期トークン>`。延長できるのは「発行から24時間以上」かつ「期限前」で、`threads_basic` の許可が要る | Meta「Long-Lived Access Tokens」（developers.facebook.com/docs/threads/get-started/long-lived-tokens、2026-10-17 に確認） |
| 文書の事実 | 応答は `access_token`・`token_type`・`expires_in`。延長したトークンは、延長した日から60日有効。60日延長しないと失効し、もう延長できない | 同上 |
| 文書の事実 | 長期トークンへの交換は `GET /access_token?grant_type=th_exchange_token`（app secret を使うので、サーバー側だけ） | 同上、`docs/postona/threads-connection-phase2b.md` |
| 文書に無い | 延長でトークンの文字列が変わるか、古い文字列が使えなくなるか（T7）。エラーのコードや回数の上限 | 同上（記載なし） |
| リポジトリでの固定 | ホストは `graph.threads.net`（公式でもホスト名が混在するため、文書どおりに固定。T3） | `threads-connection-phase2b.md` |
| 設計の仮定 | 期限の14日前から延長する（1日1回の実行を数回逃しても間に合う幅） | このモジュール `REFRESH_WINDOW_MS` |
| 設計の仮定 | Graph API の `OAuthException` code 190 を「トークンが無効」とみなす。それ以外の 4xx は今回の拒否、429・5xx・通信の失敗・形の崩れた 200 は「不確か」 | このモジュール |

## 2. いまの流れ（PR251 の時点）

1. **発行**: H5 のランタイムが、コードを短期トークンに、短期トークンを長期トークンに交換する。期限は `expires_in` から、要求の前の時刻を基準に控えめに計算する（`candidates/postona_threads_auth_runtime/runtime.ts`）。
2. **保存**: PR124 の `complete_social_mobile_threads_oauth_connection` が、トークンを Vault に保存する（`vault.create_secret(<token>, <account>_access_token, …)`）。`social_accounts` は `identity_verified` になる。
3. **期限の記録**: G4 の候補 `threads_credential_custody_candidate.sql`。
   - 書き込み口 `record_threads_credential_custody` が、アカウントごとの期限を記録する。受け付けるのは **接続を完了したその取引の中だけ**で、期限は (now, now+61日]。
   - 読み出し口 `threads_account_credential_expires_at` は、同じ Vault の secret で、最新の確認より後の記録のときだけ期限を返す。それ以外は NULL で、NULL は期限切れとして扱う。
4. **使うとき**: 投稿の候補（`threads_manual_publish_candidate.sql`）は、送る前に読み出し口で期限を確かめる。
5. **抽象**: `provider_domain.ts` の `CredentialAdapter.ensureUsable()` は `usable / refreshed / reauth_required / uncertain` を返す型。Threads は `long_lived_access`（refresh 用の参照なし）。
6. **延長**: **実装なし**。X は別の仕組み（`x-test-post` の、回転する refresh token の処理。F3／G3）で、ここでは変えない。

## 3. 担当の境界

| 担当 | 受け持つこと | 今回 |
|---|---|---|
| F4（G4 の範囲） | 延長の方針・Meta との約束・調整役（このモジュール）。期限の記録の候補 SQL（G4 のファイル）の「入れ替え用の書き込み口」。アプリの「要再接続」の表示（`connected` 以外は既に要確認の表示） | モジュールとテストを追加。SQL は提案だけ |
| H5 | owner の取引で、Vault の secret を入れ替え、期限の記録を同じ取引で書く。アカウントのリース（投稿・後片付け・延長で共有）。サーバーで延長を実行する | 変えていない（store port の実装を依頼） |
| F5 | ライフサイクルの柵。サービス終了・削除中・別の作業場所に移ったアカウントには延長させない。後片付けのリースを延長より優先する | 変えていない（store の `claim` の条件として依頼） |
| F3 | 定期実行の仕組み（X の予約のワーカーとは別の、延長用の定期実行） | 変えていない（提案だけ。cron は動かさない） |

## 4. 状態の流れ（1アカウント・1回）

```
スイッチ OFF ─────────────────────────────→ disabled（何も触らない）
claim（排他のリース）
 ├ null（切断・削除・サービス終了・別の作業場所）→ gone
 ├ busy（投稿・削除・連携解除・後片付け・別の延長が進行中）→ busy
 └ 取得 → 判定
     ├ 期限切れ／期限か発行時刻が不明 → 要再接続の印 → reauth_required（通信なし）
     ├ 発行から24時間未満 → too_young（通信なし）
     ├ 期限まで14日より先 → not_due（通信なし）
     └ 延長する → Meta へ GET（リダイレクト禁止、10秒で打ち切り）
          ├ 正しい 200 → store.commit（同じ資格情報のときだけの比較交換）
          │     ├ committed → refreshed
          │     └ conflict（途中で再接続・付け替え・削除）→ 新しいトークンは捨て、何も書かない → conflict
          ├ 190 → 要再接続の印（保存した資格情報は差し替えない）→ reauth_required
          ├ その他の 4xx → rejected（資格情報はそのまま。次の期間にまた試す）
          └ 429・5xx・通信の失敗・形の崩れた 200 → uncertain（古い資格情報を保ち、何も結論しない）
必ずリースを返す（finally）
```

- 結果は決まった語だけで、トークンは結果にもエラーにも出ない。トークンが外に出るのは `store.commit` に渡すときだけ。
- 呼び手は利用者ではなくサーバー（利用者の ID もセッションも入力に無い）ので、別の人のアカウントに触れる経路が無い。アカウントごとに、そのアカウントの資格情報だけを使う。
- 二重の実行は store のリースで止める。延長と投稿・削除の同時進行も、同じリースで止める。

## 5. 失敗の扱い

| 状況 | 結果 | 資格情報 | 次の動き |
|---|---|---|---|
| 応答が失われた・タイムアウト（Meta 側では延長済みかもしれない） | uncertain | 古いものを保つ | 次の実行でもう一度試す。古い文字列が無効になっていれば、投稿で 190 になり、要再接続 |
| 形の崩れた 200 | uncertain | 古いものを保つ | 同上（新しい値かどうか分からないので保存しない） |
| 190（無効・取り消し） | reauth_required | 差し替えない | 本人の再接続が要る（Meta 側の許可を消されたなど） |
| 途中で再接続・削除・付け替え | conflict | 新しいトークンを捨てる | 何もしない（別の資格情報を上書きしない） |
| 24時間未満 | too_young | — | 通信しない |

## 6. 定期実行の提案（今回は何も動かさない）

- 1日1回、`threads_account_credential_expires_at` が「14日以内」のアカウントを数件ずつ選び、`refresh(accountId)` を順に呼ぶ専用の関数を作る（F3／H5 と決める）。
- X の予約のワーカーとは分ける。連続した失敗を数えて、運用に知らせる。

## 7. テスト

**今回実行したもの**（`deno test --no-config --no-check --allow-read`、ネットワークの権限なし）

- `threads_token_refresh_test.ts`: **15件合格**。
  - スイッチが OFF であること、どこからも読み込まれないこと、外部の読み込み・環境変数・ログが無いこと。
  - 判定の表、要求の形（文書どおり。おかしな形のトークンは送らず、出さない）、応答の判定。
  - 調整役: OFF なら何もしない、正常な延長、二重の実行（通信1回・もう一方は busy）、投稿などの進行中は busy、切断・削除・別の作業場所は gone、途中の付け替えは conflict で書かない、190 は要再接続を1回だけ、期限切れ・不明は通信なしで要再接続、通信の失敗・429・5xx・形の崩れた 200 は uncertain で古いものを保つ、期限前・若すぎは通信なし、ほかのアカウントには触れない。
  - 結果と store の呼び出しにトークンが出ないこと。
- ミューテーション8種をすべて検出した。8種は、比較交換の無視、リースを返さない、190 を見落とす、busy を無視、崩れた 200 を受け入れる、期限切れを延長する、スイッチの無視、5xx を拒否として扱う、の8つ。

**今後**（別の承認・別の担当）

- 期限の記録の「入れ替え用の書き込み口」の候補 SQL を、使い捨ての PostgreSQL で確かめる（同じ secret の比較交換、取り消し・削除との競合、F5 の柵）。
- H5 の owner の取引での Vault の入れ替え、本番ではない project での実際の Meta の応答（T7: 文字列が変わるか）。

## 8. 次の実装 TASK（PR251 のレビューの後に始められる、狭い範囲）

**F4**: 「Threads の資格情報の入れ替えの候補 SQL と、store port の約束のテスト」

1. G4 の `threads_credential_custody_candidate.sql` に、owner だけが使う `rotate_threads_credential_custody(account, expected_secret_id, expected_recorded_at, new_expires_at)` を足す。比較交換で、F5 の柵と後片付けのリースを尊重し、期限は (now, now+61日]。読み出し口は新しい記録を正しく読む。
2. 使い捨ての PostgreSQL で、store port の約束（claim の条件・commit の比較交換・要再接続の印）を確かめる。
3. H5 への依頼文: owner の取引で Vault を入れ替え、1 を同じ取引で呼ぶこと。

スイッチ・定期実行・配備は、引き続き OFF のまま。
