# POSTONA 利用終了（G1／G2）実機確認の手順と、リリース前のチェック表（F4・2026-10-17 JST）

TASK: `postona-f4-service-end-device-readiness-release-gate-inventory-20261017`。ソースの文書だけで、製品のコードは変えていない。対象は PR240 head `5e462ba73be691c80f75198d57782626f1d241cc`（F5 による J2 V2 P2×2 の修正）。

PR の積み重ねは次のとおり: PR197 `2171ee4c` → PR211 → PR217 → PR221 `dcae62c6` → PR230 `e6725a16` → [PR236 `605d8776` ＋ PR235 `9480f24b`] → PR238 `b8e91ea8` → PR240。

## 0. 判定

**BLOCKED_PRECONDITION**（実機・シミュレータでの確認に必要な前提が揃っていない）。ソースだけでの確認は合格（§3）。どちらの判定も本番の承認ではない。本番は NO_GO。

- この app の Supabase の設定（`EXPO_PUBLIC_SUPABASE_URL`）は本番の project を指している。そのため、サインインしただけで本番の Auth と、利用登録の RPC `start_x_autopost_service`（本番に適用済み・書き込みあり）に触れる。
  - モック表示（`EXPO_PUBLIC_DATA_SOURCE=mock`）では利用登録の関門を通らないので、G1／G2 は確かめられない。
- 利用終了の Edge `account-delete` と、セッションの柵の migration（F5）は、どの環境にも配備されていない。
- `POSTONA_END_SOURCE_ENABLED` はソースの定数で `false`。どのビルドでも利用終了は「準備中」になる。
- 起動中のシミュレータ（iPhone 18 Pro／iOS 27）はあるが、上の理由で起動しなかった（本番に副作用が出るため）。

## 1. 確認の種類と前提

| 種類 | 状態 | 前提 |
|---|---|---|
| A. オフライン（合成の Auth・通信、本物のソースを transpile） | **実施済み・合格**（§3） | なし |
| B. シミュレータ | 未実施（前提が無い） | B1〜B5 を満たすこと（下記） |
| C. iPhone 実機 | 未実施（前提が無い） | B の前提に加えて C1〜C3 |
| D. 管理環境の Auth／PostgREST／Edge | 未実施（別承認・F5 担当） | D1〜D4 |

**B の前提**

- B1. 本番ではない Supabase の project を用意する（使い捨て・別承認・F5 担当）。
- B2. B1 に F5 の migration（セッションの柵を含む）と `account-delete` を配備する。
- B3. ローカルだけのビルドで `POSTONA_END_SOURCE_ENABLED = true`、Supabase の向き先を B1 にする（**コミットしない**）。
- B4. iOS 27 で動く dev client（ローカルのビルド。EAS は使わない）、Metro は 8081。
- B5. B1 に、サインインの方法ごとのテスト用利用者を用意する。

**C の前提**

- C1. 端末へのビルドの方法を決める（EAS を使うなら費用がかかるので承認が要る）。
- C2. X・Google・Apple の OAuth の戻り先を B1 に向ける設定。
- C3. 本人が端末を操作すること。

**D の前提**

- D1. F5 の M1〜M12。
- D2. 実際の GoTrue の動き: `signInWithPassword` で新しい `session_id` になり、トークン更新では変わらないこと。
- D3. PostgREST の 401／403／503 の返り方。
- D4. `account-delete` の `preview`／`withdraw_postona` の実際の答え。

## 2. 端末で確かめる表

- サインインの方法はメール・X・Google・Apple。本人確認に使える方法は、つながっている ID と使える方法に限られる（`reauthMethods`）。
- 各行は B／C で確かめる。「オフラインの根拠」は §3 で合格したテスト。

| # | 場面（方法ごと） | 期待する結果 | オフラインの根拠 |
|---|---|---|---|
| 1 | 同じ人が本人確認でログインし直す（メール・X・Google・Apple） | 利用終了の画面（surface）は残る。確認文と同意は消え、プレビューは新しいログインで取り直す。送る相手は新しいログイン。関門は新しいログインで聞き直す | integration「G2 assembled: re-authentication…」、lifecycle「G2: while the screen stays mounted…」 |
| 2 | 手続き中のサインアウト | surface は閉じて、ログイン画面になる。もう一度ログインしても surface は開かない | integration「another person or sign-out…」、lifecycle「provider: the surface opens only…」 |
| 3 | A→B→A の切り替え | B に変わった時点で閉じる。B の関門は B として聞く。A の遅れた合図は拒む。A に戻っても開き直さない | integration「another person or sign-out…」、lifecycle「late bump…refused」 |
| 4 | 利用終了に成功（`ended`） | 結果（Threads 側の許可が残る行、X の結果不明の件数）が surface に見える。後ろの関門は閉じ、聞き直した後は「退会済み」の画面。自動では再登録しない | integration「G1 assembled: ended…」 |
| 5 | `already_ended` | 4 と同じ（合図は1回） | integration「already_ended also bumps once…」 |
| 6 | 関門の答えが active／エラー／ended | active ならアプリが開く。エラーなら「再読み込み」が出る。ended なら「利用登録する」が出る。どの画面からも「利用終了・共通IDの管理」が surface を開く | j2-v2「P2-1…」、enrollment の各テスト |
| 7 | 聞き直しが 500 またはオフライン | 閉じたまま「再読み込み」が出る。押しても再開（reactivate）は送らない | integration「a failed re-ask…」 |
| 8 | 古いボタンの操作（切り替えや合図の後に、古い画面のボタンが押される） | 何も送らない（reactivate は0件） | j2-v2「P2-2…」（端末で古いイベントを起こすのは難しいので、ここはオフラインを主な根拠にする） |
| 9 | 二重タップ（利用終了・利用登録） | 送るのは1回だけ | lifecycle「double tap」、j2-v2「P2-2 positive」 |
| 10 | 古いプレビュー・同意 | ログインが変わると消え、使い回せない（`LIFECYCLE_CHANGED`） | r2c・fence・lifecycle の各テスト |
| 11 | 「ブロック」「エラー」「退会済み」からの移動 | 「利用終了・共通IDの管理」で surface が開く。「閉じる」で関門の画面に戻る | j2-v2「P2-1…」、onboarding-deletion-entry |
| 12 | 共通ID が残る | POSTONA を終えた後も同じ ID でサインインでき、かぶモリにもログインできる | サーバーは F5（D）。アプリ側は、全 ID 削除のボタンが常に無効であること（postona-end-screen） |
| 13 | ほかのサービスの利用登録 | かぶモリの利用登録は変わらない（プレビューの `kabumori` が `active` のまま）。関門は x_autopost の RPC しか呼ばない | integration「ended…」（RPC の種類と本文 `{}`）、サーバーは D |
| 14 | X の予約投稿 | 利用中の人の予約は、この変更の影響を受けない（予約の機能はスイッチが OFF）。終了後に予約と自動投稿が止まるのは、F3／F5 のサーバー側（D） | 既存の予約のテスト。サーバーは D |

## 3. この TASK で実際に実行したもの（PR240 の正確な head、ローカル、ネットワークなし）

| コマンド | 結果 |
|---|---|
| `node --test tests/*.test.mjs` | **396/396** |
| `node --test tests/service-enrollment-gate-j2-v2.test.mjs` | **20/20** |
| `node --test tests/service-end-g1-g2-integration.test.mjs` | **9/9** |
| `node --test tests/service-lifecycle.test.mjs` | **12/12** |
| `node --test tests/service-enrollment-lifecycle.test.mjs` | **19/19** |
| `node --test tests/pending/service-end-gate.pending.mjs` | **1/1**（任意の残りだった「関門の中の写し」は、PR240 で無くなった） |
| `npm run typecheck`・`CI=1 npm run lint` | 終了コード 0 |
| 修正前の照合: j2-v2 の 20件を PR238 `b8e91ea8` のソースで実行（F5 の方法: 新しいテストと `support/assembled-app.mjs` だけを入れる） | **18件失敗・2件合格**（合格は対照の2件）。F5 の Report と一致 |
| （参考）同じ照合で、PR240 の `support/enrollment-harness.mjs` も入れた場合 | 19件失敗・1件合格（ハーネスの違いによる。結論は同じ） |

- `POSTONA_END_SOURCE_ENABLED = false`。
- app のソースは旧エンドポイント `social-mobile-account-delete` を呼ばない。利用終了の通信先は `functions/v1/account-delete` だけ（`preview`／`withdraw_postona`）。関門の RPC は `start_x_autopost_service`／`reactivate_x_autopost_service` だけ。

## 4. 止め方・戻し方

- **ソースのスイッチ**: `POSTONA_END_SOURCE_ENABLED` はソースの定数。`expo-updates`（OTA）は設定されていないので、入れるにも切るにも新しいビルドの配布が要る。切った状態（`false`）では、利用終了の画面は「準備中」になり、通信しない。
- **サーバー側で止める**: POSTONA の利用終了が通るのは `account-delete` だけなので、これを配備しない・外せば止まる。止まっている間、アプリはプレビューや終了の失敗を表示し、完了とは言わない（終了クライアントの約束）。全 ID 削除は、これとは別に F5 の release gate（`managed_auth_delete` は BLOCKED、`IDP_PREPAUSE_BLOCKED` も BLOCKED）で止まっている。
- **利用登録の関門**: サーバーが失敗したら閉じたまま（再試行は手動）。自動では再登録しない。
- **触れる先は限られている**: 利用終了は `account-delete` だけ、関門は x_autopost の2つの RPC だけ。全 ID 削除はアプリでは常に無効。

## 5. チェック表

**端末での確認を始めてよいか**（すべて YES で GO）

- [ ] B1 本番ではない project がある（承認済み）
- [ ] B2 F5 の migration と `account-delete` を B1 に配備した（F5）
- [ ] B3 スイッチを ON にしたローカルのビルド（コミットしない）が B1 を向いている
- [ ] B4 iOS 27 で動く dev client と Metro（ローカルのビルド・EAS なし）
- [ ] B5 方法ごとのテスト用利用者（メール・X・Google・Apple）
- [ ] C1〜C3（実機の場合）
- [ ] 本番の URL・キーがビルドに入っていないことを確認した

**リリースしてよいか**（すべて YES で GO。今は NO_GO）

- [ ] §2 の表を B／C ですべて確かめた（結果を記録した）
- [ ] D1〜D4（F5 の管理環境での確認）
- [ ] PR の積み重ね（PR197 から PR240 まで）と、F5 のサーバーの PR（PR121〜PR223 と柵の migration）のマージ順が決まり、審査を通った
- [ ] 旧 `social-mobile-account-delete` の封じ込めを読み戻した
- [ ] F3 の X の終了処理、F4 の Threads の後片付けの管理環境での確認
- [ ] 全 ID 削除の D1 同意の判断（全 ID 削除は今も無効）
- [ ] `POSTONA_END_SOURCE_ENABLED` を入れる審査と、切る手順（新しいビルド、またはサーバー側で止める）の確認

## 6. G5／F5 に答えてほしいこと

1. 本番ではない Supabase の project（B1）を用意できるか。誰が承認し、誰が作るか。
2. B1 への F5 の migration（セッションの柵を含む）と `account-delete` の配備を、F5 が担当してよいか。
3. B1 で、`withdraw_postona` の後に `start_x_autopost_service` が `reenroll_required` を返すか（F5 の文書どおりか）。
4. Apple のネイティブの本人確認と、X・Google の OAuth の戻り先を B1 で使えるようにする方法（設定の担当）。
5. 方法ごとのテスト用利用者を、誰がどう作るか（本番の利用者は使わない）。
