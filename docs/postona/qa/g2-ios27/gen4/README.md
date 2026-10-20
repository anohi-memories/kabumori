# G2 第4世代 — iOS 27 scene 対応フィクスチャでの `kabumori-social://` 復帰 QA と戻り後の画面回帰（QA専用・FIXTURE_ONLY）

- Issue #317 TASK `postona-g2-ios27-scene-deeplink-offline-regression-20261020`
- 実施: 2026-10-20 13:14–13:20 JST。専用 Simulator iPhone 18 Pro（iOS 27.0、QA後削除）、Xcode 27.1、SDK 27.1、`expo` 57.0.23、RN 0.86.3。
- アプリ JS: PR #346 HEAD `c71f2a1f59d3b1eb72447a73b602adf51639c691`。ネイティブ: 追跡外 `ios/` に PR #348 と同じ scene 対応フィクスチャ（`../scene-fixture.diff`）を当てたローカル Debug ビルド。**G1／アプリ共通 owner の製品修正は未着手のため FIXTURE_ONLY**。配布ビルドの正常起動は確認していない。
- 実 OAuth・トークン取得・Meta・SNS・Supabase への接続なし。URL の値はダミー（`QA_FAKE_*`）で、観測ログには値を一切書かない（`url-observer-rig.tsx.txt`、`metro-url-log.txt`）。

## 1. ネイティブ転送（SceneDelegate → JS）: `simctl openurl` で実測

| 条件 | URL | 結果 | 証拠 |
|---|---|---|---|
| cold start（アプリ終了状態） | `oauth-callback?code&state` | **PASS** `Linking.getInitialURL()` に届く | G01・ログ 13:15:35 |
| foreground（手入力画面で入力中） | `oauth-callback?code&state` | **PASS** `url` イベントで届く | G03・ログ 13:16:23 |
| background → resume（HOME 後） | `auth-callback?code&sb_flow_id` | **PASS** `url` イベントで届く | G05・ログ 13:16:51 |
| 同じ URL の重複 | 同上 | **PASS** 2回目も届く（JS 側で1回の処理に集約、§2） | G06・ログ 13:17:33 |
| 不正な URL `kabumori-social://%%%` | — | router は Unmatched Route を表示。観測ログには出ず **NOT_VERIFIED** | G07-malformed |

- 初回だけ iOS の「"Social Operations" で開きますか？」確認が出る（Simulator の `openurl` 仕様）。
- クラッシュなし（全手順中、診断レポート新規作成なし）。

## 2. 戻り URL の安全境界（オフライン、`apps/social-mobile/tests/g2-deeplink-return.test.mjs` 8件 PASS）

| ケース | 結果 |
|---|---|
| cold start の initialURL と url イベントで同じ戻りが2回 | 交換は1回、両方に同じ実結果 |
| background 後の遅れた重複（初回は失敗） | 初回の失敗を共有。新たな「成功」にならない |
| 同じ code を別 flow id で再送 | 交換せず拒否、初回結果を流用しない |
| この端末が始めた flow と違う flow の戻り | 交換前に拒否 |
| 投稿用 X 接続の戻り・他画面・余分なパス・flow 無し code・重複 code・`access_token`・`user_id` 付き・空・不正 | 無視（交換0） |
| ログインユーザー | 交換したセッションのユーザーのみ。URL から差し替え不可 |
| X 投稿接続の戻り（`parseOAuthReturn`） | 現在の state のみ受理。古い state・別スキーム／別パス・state 無しは拒否 |
| 観察 | `state` が2回ある URL は最初の値が使われる（`URLSearchParams.get`）。サーバー側の state 照合が最終判定。指摘ではない |

## 3. 画面ルーティング（expo-router）: 実測

| 項目 | 判定 | 証拠 |
|---|---|---|
| `oauth-callback` / `auth-callback` はホームへ戻るだけで値を表示・保存しない | **PASS** | G01/G03/G06 |
| `manual-publish?text=…&accountId=…` で開いても本文・投稿先に注入されない | **PASS** | G07-manual-publish-with-params |
| 存在しないアカウント id の `accounts/<id>` | **PASS（fail-closed）** 「アカウントが見つかりません」。ただしヘッダー・戻るボタンが無く行き止まり | G07-accounts-unknown-id |
| 外部リンクから `account-deletion` に直接遷移できる | 観察: 削除は「準備中」で操作不可。実装後は再認証必須か要確認 | G07-account-deletion |
| 未定義ルート | **FAIL（P3）** Expo 既定の英語「Unmatched Route」画面（暗色）に、受け取った URL 全体と「Sitemap」リンクが表示される | G07-unknown-route / malformed |
| **入力中に戻り URL が届くと下書きが消える** | **FAIL（P3）** `oauth-callback`/`auth-callback` の `<Redirect href="/">` で手入力画面ごとホームへ置き換わり、開き直すと本文は空 | G02→G04 |
| ディープリンクで直接開いた手入力画面 | 観察: スタックの根になり戻るボタンが無い | H01/H02 |

## 4. 戻り後の画面回帰（PR #346、scene フィクスチャ）

| 項目 | 判定 | 証拠 |
|---|---|---|
| S1 レッドボックス無し（ディープリンクで開いた後） | PASS | G03 以降 |
| P3 ダーク・キーボード表示中のステータスバー（戻り後） | PASS | H01 |
| P2 キーボード表示中にスクロールして最下部「内容を確認する」 | PASS | H01 |
| P2 **落ち着いた状態での最初のタップ**で確認画面へ | **PASS** — 前回の「1回目はキーボードが閉じるだけ」はスクロール直後のレイアウト移動中のタップが原因で、待ってからの1回目で遷移した | H02 |
| Threads ゲートOFF（戻り後） | NOT_VERIFIED（このビルドの JS は PR #346、Threads 画面は含まない。ゲートOFF表示は PR #348 F01 で確認済み） | — |

## 5. 担当への引継ぎ（G2 は製品を変更しない）

- **G1 / アプリ共通（P3）**: 下書き消失（戻り URL の `Redirect` が入力中の画面を置き換える）。`+not-found.tsx` を用意して英語既定画面と URL 表示・Sitemap を出さない。`accounts/[id]` と、ディープリンクで直接開いた画面の戻り導線。
- **G1 / アプリ共通 native owner**: scene 対応の製品導入（PR #348 §5）。導入後は本書 §1 の4条件を通常ビルドで再実測。
- G4（G2-T1 P2）・F4（G2-T2 P3）・G1（G2-S2）: 修正 PR なし → 修正待ち（同件の再報告はしない）。

## ファイル

- `evidence/`: G01–G07, H01–H02（900px、mock データ、値はダミー）
- `metro-url-log.txt`: URL 受信ログ（値なし）
- `url-observer-rig.tsx.txt`: 観測に使った QA 専用 rig（製品には入れない）
- テスト: `apps/social-mobile/tests/g2-deeplink-return.test.mjs`
