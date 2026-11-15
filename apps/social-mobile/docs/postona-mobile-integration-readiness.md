# POSTONA モバイル結合の準備状況（F4・2026-10-16 JST）

TASK: `postona-f4-mobile-auth-entitlement-x-threads-integration-readiness-20261016`。対象は `apps/social-mobile`（POSTONA アプリ）。ソースだけの調査で、本番・管理環境・実 SNS には触れていない。本番は NO_GO。

## 1. 結合の確かめ方

POSTONA のモバイルは、3つの Draft スタックに分かれている（どれも未マージ）。

| 範囲 | 担当 | スタック（先頭） |
|---|---|---|
| Threads（接続・手動投稿・連携解除） | G4／F4 | PR140 → 144 → 154 → 167 → 169 `fd15430ddcd640c5c7389582f37f1b478fc7204c`（サーバー側 PR180 はモバイル無変更） |
| X 予約 | G3／F3 | PR145 → 151 → 163 → 168 `4b491668d030d1e9ecefacf0448fdd06d5ce57fc`（F3 PR224 `2a9d6473eb15d1356e3b13e24e5f9ed1f6afaa08` は 168 の子孫で、モバイル・予約 API は 168 と同一） |
| POSTONA 利用終了 | J5／F4 | PR197 → 211 → 217 → 221 `dcae62c6f61dc67372ea502a1cf5e7d1d598d852` |
| 共通ログイン・利用登録 | G5／F5 | アプリ側は main（#95）。サーバー側の新しい部分は PR121 → … → 223 `28695586f63a30c739a44b829e79a7950932b5e7`（`apps/` は無変更） |

- origin/main `ca6c5af7c450f83fa9fd4e63161c3dc131af99e4` に3つのスタックの先頭を、ローカルだけで順にマージした（push していない）。**衝突なし**。
- その結合で `node --test tests/*.test.mjs` **442/442**、`tsc --noEmit` と `expo lint` は合格。下の修正（§3）を足すと **450/450**。
- これは「ソース同士が組み合わさる」ことの確認で、サーバーの配備や実機での確認ではない。

## 2. 結合マトリクス

| 範囲 | 画面・モジュール | サーバーの約束（担当・出典） | スイッチ／配備 | 足りないもの |
|---|---|---|---|---|
| ログイン・セッション | `providers/auth-provider.tsx`（メール・X・Google・Apple、PKCE、自動更新）、`lib/supabase.ts` | Supabase Auth を直接使う。F5 はここにサーバーコードを足さない（F5 Phase 9 文書） | Auth は本番で動作中 | トークン更新のたびに画面のデータを読み直し、一覧が一瞬空になる → **§3 で修正** |
| 利用登録（POSTONA を使える状態か） | `features/service-enrollment/service-enrollment-gate.tsx` がアプリ全体を包む。`start_x_autopost_service` ／ `reactivate_x_autopost_service` | main の migration `20261006230000`（本番適用済み）。セッションの柵 `20261015090000`（F5 PR206）は**未適用** | 動作中（モック表示では素通り） | G1・G2（§4） |
| X 予約 | `app/(tabs)/schedule.tsx`、`features/schedule/*`、`domain/reservation-flow.ts` → Edge `postona-x-reservations`（`{action, payload}`：create／list／get／reschedule／reconfirm／cancel） | 状態7種・同意3種・冪等キーはモバイルと一致（F3 の e2e が本物のモバイル store を使う） | モバイル `POSTONA_RESERVATION_PERSISTENCE_ENABLED=false`、サーバー `POSTONA_RESERVATION_API_ENABLED=false`、ワーカー `false`、権限ポートは常に拒否。**未配備** | X1〜X5（G3／F3 のモバイル修正）、F3 側 N1〜N3 |
| Threads | `app/accounts/index.tsx`、`app/accounts/[id].tsx`、`features/threads-*` → `threads-oauth-connect-user`、`social-mobile-threads-publish`、`social-mobile-threads-disconnect` | G4／F4 の候補 SQL（writer guard を呼ぶ）。`PREREQUISITES_MET=false` | `THREADS_CONNECT_UI_ENABLED`／`THREADS_MANUAL_PUBLISH_UI_ENABLED`／`THREADS_DISCONNECT_UI_ENABLED` はすべて `false`。`app.json` に `threadsConnectCallbackUrl` が無い。**未配備** | T1〜T3 |
| POSTONA 利用終了 | `app/account-deletion.tsx`、`lib/postona-service-end-client.ts` → `account-delete` の `withdraw_postona` | F5 PR193 以降の候補（未配備） | `POSTONA_END_SOURCE_ENABLED=false`。旧削除経路はアプリでは閉じている | G1・G2・E1・E2 |
| 画面のつながり | `(tabs)/index.tsx` → `/accounts`・予定・履歴・設定、`login-methods` → `/accounts`・`/account-deletion` | — | — | V1・V2 |

## 3. この PR で直したもの（モバイルのみ・F4 の範囲）

**データの読み直しを「人」に結び付けた（`src/providers/data-provider.tsx`）**

- 以前は、セッションのオブジェクトが変わるたびに読み直していた。Supabase はトークン更新（TOKEN_REFRESHED）のたびに新しいオブジェクトを渡す。そのため、だいたい1時間ごとと、アプリが前面に戻ったときに、状態が `loading` になっていた。
- `loading` の間はアカウント一覧が空になる。開いているアカウント詳細は「アカウントが見つかりません」になり、自動投稿の切り替えや Threads 投稿の確認の途中状態が消えていた。
- 今は、同じ人のトークン更新では読み直さない。別の人に変わったときやサインアウトしたときは、必ず読み直す。
- 読んだ結果に「誰の分か」の印を付け、今の人の分だけを見せる。別の人・サインアウトに変わった最初の描画から、前の人のデータは1回も出ない（以前は1回分、`ready` のまま前の人の snapshot が見えていた）。前の人の分として遅れて届いた答えも出ない。
- 同じ人の `reload()` は今までどおり読み直し、読み込み中も手元のデータを保つ。
- 本番データでは、ログインが変わると利用登録の関門がアプリ全体を作り直すので、これまでも別の人にデータが見えることは無かった。今回の印は、その外側でも守るための二重の守り。
- 検証: 新規 `tests/data-provider-session.test.mjs`（8件）は、**修正前（origin/main `0be25ee275629c5e8358f8b56de0b827045d1431` のコード）で4件失敗・4件合格、修正後は8件すべて合格**。ミューテーション4種（セッションのオブジェクトで読み直す・描画で印を見ない・別の人が読み込み中に前の人の分を引き継ぐ・取り消した遅い答えを反映する）はすべて検出。アプリ全体は main 上で 285/285。`tests/data-source.test.mjs` は初期状態の書き方の検査を1行だけ合わせた。

## 4. 結合の妨げ（担当別）

**G5／F5（共通ログイン）と J5／F4（利用終了）の設計判断が必要**

- **G2（利用終了を有効にする前の妨げ）**: 利用終了の本人確認はサインインし直しなので、新しいログイン（新しい `session_id`）ができる。
  - 利用登録の関門は「新しいログインは何も引き継がない」設計なので、アプリ全体を作り直す。その結果、`/account-deletion` 画面の本人確認済みの状態とプレビューが消え、利用終了を送れない。
  - 消えないのは、関門の未完了画面に埋め込まれた削除画面だけ。
  - 直し方は、関門の設計、本人確認の方法（H5）、画面の置き場所のどれかを変えることになる。どれも F4 だけでは決められない。
- **G1**: 利用終了が `ended`／`already_ended` で成功しても、関門は手元の `ready` のままになる。次のログインか作り直しまで、POSTONA の画面が出続ける（サーバーの書き込みは F5 の guard を適用すれば拒否される）。関門（`service-enrollment-gate.tsx`）に再確認の入口を足す必要がある。関門は F5 の範囲なので、F5 に回す。

**G3／F3（X 予約）— モバイルだけで直せる。担当の別タスクとして回す**

- X1: 次の拒否コードに日本語の文言が無く、どれも「保存・変更できませんでした」になる。
  - `POSTONA_RESV_SERVICE_BUSY`、`POSTONA_RESV_AUTH_REQUIRED`、`POSTONA_RESV_REQUEST_INVALID`、`POSTONA_RESV_ITEM_INVALID`、`POSTONA_RESV_BAND_REQUIRED`、`POSTONA_RESV_AI_TEXT_NOT_ALLOWED`
  - `NOT_CONFIGURED`、`AUTH_UNAVAILABLE`、`PERMISSION_UNAVAILABLE`、`STORE_UNAVAILABLE`、`REQUEST_INVALID`、`REQUEST_TOO_LARGE`、`METHOD_NOT_ALLOWED`、`INTERNAL`
- X2: `POSTONA_RESV_SERVICE_BUSY` は 503 で返るので、「結果不明・読み戻し」として扱われる。「しばらくして再試行」と出すべき。
- X3: `server-reservation-card.tsx:44` の「X への投稿はまだ行われません」は、PR224 で実際に投稿されるようになった後は、`published` の行にも出て誤りになる。
- X4: `uncertain` の表示「結果を確認中」は、F3 の意味（自動で再試行しない・X で確かめてほしい）と合わない。
- X5: 時間帯の重なりの事前確認を、モバイルは `planned`／`claimed` だけで行っている。サーバー（001:299）は `published`／`uncertain` も数えるので、避けられる `POSTONA_RESV_SLOT_CONFLICT` が起きる。
- F3 側が必要なもの:
  - N1: 失敗理由（`outcome_code`）と投稿 ID が予約の表示用データに無い。
  - N2: 利用終了・凍結・未登録が同じコードで返る。
  - N3: 本番の権限ポートが常に拒否。
  - U1: ゲートウェイが JWT を拒否したときの応答の形が未確認。

**G4／F4（Threads）— 有効にする前の課題（今回は直していない）**

- T1: 接続・連携解除のカードが、最初の Threads アカウントにしか出ない。
- T2: Threads 接続の戻り先 URL（`threadsConnectCallbackUrl`）が `app.json` に無いので、スイッチを入れても `CALLBACK_NOT_CONFIGURED` になる（運用側の設定）。
- T3: 連携解除の「Meta 側の許可が残る」文言と、利用終了の同意の文言が別々に書かれている（揃えるかは文言の判断）。

**J5／F4（利用終了の画面）— 有効にする前の課題**

- E1: `login-methods.tsx` の「準備中」は、常に `setup_pending` を返す `deletionAvailability` を見ている。利用終了のスイッチは見ていない。
- E2: 利用終了の画面は「SNS アカウント画面で連携を解除して」と案内するが、その画面へのリンクが無い。X の連携解除はモバイルに無い。

**画面のつながり（全体）**

- V1: `/media` へはどこからも移動できず、モックだけを表示する。
- V2: ルートの `Stack.Screen` 名 `accounts`／`media` が、ファイルのルート（`accounts/index`・`accounts/[id]`・`media/index`）と一致しない（main でも同じ）。見出しの設定が効くかは実機で確かめる必要がある。

**配備・承認（ソースの外）**

- F5 PR121〜223 のマージと、セッションの柵の migration の適用。
- `account-delete` の配備。旧 `social-mobile-account-delete` の封じ込めの読み戻し。
- F3 PR182／予約 003、F4 Threads の候補 SQL の適用。G3 の X 接続 RPC の T13 対応。
- 共通 ID の完全削除の D1 同意。
- どのスイッチを入れるにもリリースの審査が要る。

## 5. 管理された使い捨て環境で確かめる必要があるもの（未実施・別承認）

1. F5 の M1〜M12（共通ログイン・利用登録・セッションの柵）。
2. 実機でのトークン更新: §3 の修正で、更新のときに画面が空にならないこと。アカウント詳細の確認が続くこと。
3. `postona-x-reservations` をゲートウェイ経由で呼んだときの 401 の形（U1）。ワーカーを含む予約の作成から投稿・`uncertain` までの一連の流れ。
4. Threads の OAuth の戻り（戻り先 URL の設定後）、手動投稿、連携解除（Meta 側の許可は残る前提）。
5. 利用終了: 本人確認の後に関門がアプリを作り直す動き（G2）を、実機で確かめてから設計を決める。

## 6. 別の人に見えないか（確認結果）

- 本番データでは、ログインが変わると関門がアプリ全体を作り直す。人ごとの状態は一緒に消える。端末に保存されるのは、人ごとのキーの付いた初回案内の印と、プロバイダのトークンを除いたセッションだけ。
- データ層（`DataProvider`）は、今回の修正で関門の外でも人ごとになった。
- X 予約の画面の状態は X アカウントごとで、人には結び付いていない。直接の切り替えのときは、サーバーの所有者確認が唯一の守り（U2）。本番データでは関門が作り直すので、問題は出ない。
