# G2-02 第3世代 — G1 #551 の iOS 27 標準ビルドの実際の画面での受け入れ（QA専用）

- Issue #532 TASK `postona-g2-gen2-pr551-ios27-standard-product-screen-simulator-qa-20261028`
- 対象（この PR の base）: G1 PR #551 HEAD `c94c0268d849557d5cdce4d7db64dd85919b43e3`（積み重ね #535 → #544 → #546 → #551。#544 で `app.json` の `plugins` に `./plugins/with-ios27-scene.plugin.js` を追加）
- 環境（`env.txt`）: macOS 27.0.1、Xcode 27.1、iOS 27.0 Simulator（G2 専用に新しく作った端末 `G2-PR551-20261028` / iPhone 18 Pro、終了後に削除）、expo 57.0.23、react-native 0.86.3（package.json は main と同じ）。Simulator の Debug ビルド。EAS なし、実機向けの署名なし。
- 手順（標準、**診断用の直し・手作業の Info.plist の書き換えなし**）: 使い捨ての作業場所で `npx expo prebuild -p ios --no-install` → `npx expo run:ios --device <G2 専用端末> --no-bundler`。
- 製品のコード・ネイティブの設定は変えていない。

## 1. 結果（G2 #540 の FAIL 3/3 と比べて）
| # | 段階・操作 | #535（G2 #540） | #551 | 証拠 |
|---|---|---|---|---|
| 1 | 標準の prebuild | 場面の仕組みが生成されない | **PASS**: Info.plist に場面の設定、AppDelegate に `SceneDelegate: ExpoAppSceneDelegate` が**自動で生成**（手作業なし） | `prebuild-facts.txt` |
| 2 | Xcode のビルド | 0 error | **PASS**: 0 error / 0 warning | `native-build-summary.txt` |
| 3 | 起動（Metro なし） | 起動直後に落ちる | **PASS**: 落ちない（Debug ビルドなので「画面のもとが無い」の赤い表示。予想どおり） | U01 |
| 4 | 起動 → JS → 最初の画面（**仕掛けなし**、ローカルのデモ用データ） | 届かない | **PASS**: ログイン画面（「Supabase 接続設定がありません…」でサインインはできない＝実 Auth は無い） | U02 |
| 5 | ホーム（**G2 の JS の仕掛け**: 偽のログイン・偽データ） | — | **PASS** | U03 |
| 6 | 手動投稿の画面 → 本文で5行（日本語のかなキーボード、変換の候補の帯あり） | — | **PASS**: 5行目とカーソルがキーボードの上に見える（保存された本文 `one\ntwo\nthree\nfour\nfive`） | U04 |
| 7 | 戻るボタン「ホーム」→ ホーム | — | **PASS** | U04・U05 |
| 8 | クラッシュの記録 | 3件 | **0件**（19 時以降の新しい記録なし） | `crash-check.txt` |
- **標準ビルドの起動は PASS**。ログイン画面までは仕掛けなしの本物の画面。ホームから先は、実 Auth が無いので G2 の JS の仕掛け（偽のログイン・偽データ・偽の送信の口、#512 と同じ。ネイティブには触れない）で確認した。**実 Auth との統合の PASS ではない**。
- 前回までの8操作のくり返しはしていない（キーボードは5行目だけ確認）。

## 2. 次の製品統合の障害（NOT_VERIFIED のまま）
- 実 Auth（Supabase の接続設定と本物のログイン）: 標準ビルドではログイン画面で止まる。ホーム以降の本物の流れは、Supabase の接続設定のある環境が要る。
- 実機の iPhone（iOS 27）と Android: EAS か実機ビルドの判断が要る（EAS は別承認）。
- 本物の X への投稿、OAuth、本番公開: NO_GO のまま。
- iOS 27 の起動のゲート（G2 #540 の BLOCKED_PRODUCT_NATIVE_FIX）は、#551 の版では解消（製品に入るのは G1 の PR の統合のとき）。

## 3. 片付け
- G2 専用の Simulator 端末・DerivedData・使い捨ての作業場所・Metro の一時フォルダ・JS の仕掛け・node_modules のつなぎを削除した。他の担当の端末・開発サーバーには触れていない（開始時、起動中の端末も 8081 番の Metro も無かった）。
