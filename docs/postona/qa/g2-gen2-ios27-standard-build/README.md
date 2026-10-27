# G2-02 第2世代 — iOS 27 の標準ビルド（診断用の直しなし）の起動ゲート（QA専用）

- Issue #532 TASK `postona-g2-gen2-ios27-unpatched-standard-build-launch-gate-20261028`
- 対象（この PR の base）: G1 PR #535 HEAD `216fe795caebd7793a8aaf0ed3d75b5a2c5de28e`（アプリの製品コード・ネイティブの設定は変えていない）
- 環境（`env.txt`）: macOS 27.0.1、Xcode 27.1、iOS 27.0 Simulator（G2 専用に新しく作った端末 `G2-STD-20261028` / iPhone 18 Pro、終了後に削除）、expo 57.0.23、react-native 0.86.3。**EAS なし、実機向けの署名なし、Simulator の Debug ビルドだけ**。外部への書き込み・実ユーザーの資格情報なし。
- 手順（標準）: 使い捨ての作業場所で `npx expo prebuild -p ios --no-install`（`EXPO_OFFLINE=1`・空の Expo の設定場所）→ `npx expo run:ios --device <G2 専用端末> --no-bundler`。**診断用の直し（#348 の scene-fixture・Info.plist の手作業）は当てていない**。

## 1. 結果: 標準ビルドは iOS 27 で起動しない（FAIL、3回とも同じ）
| 段階 | 結果 | 証拠 |
|---|---|---|
| prebuild（標準） | 成功。ただし生成物に場面（UIScene）の仕組みが無い: Info.plist に `UIApplicationSceneManifest` が無い／AppDelegate が自分で `UIWindow(frame:)` を作って React Native を始める | `prebuild-facts.txt` |
| Xcode のビルド | 成功（0 error / 0 warning） | `native-build-standard.txt` |
| 起動（Metro なし） | **FAIL**: 起動直後に落ちてホーム画面に戻る | T01、`crash-summary.txt` 1件目 |
| 起動（Metro あり、2回） | **FAIL**: 同じ。JS は1度も読み込まれない（Metro に組み立ての記録が無い）＝ JS の前のネイティブの段階で落ちる | T02、`crash-summary.txt` 2・3件目 |
- 落ちる理由（3件とも同じ）: `EXC_BREAKPOINT / SIGTRAP`、落ちた場所は UIKit の `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`（場面の仕組みを採用していないアプリを iOS 27 の SDK が止める）。
- **利用者ができた操作: 0**（アプリが開かない）。ホーム・手動投稿の画面・入力欄は、標準ビルドでは NOT_RUN（届かない）。

## 2. 最小の直し方の候補を、使い捨ての場所だけで確かめた（標準ビルドの PASS ではない）
- 中身: G2 #397（`a0f66c77`）の Expo の設定の追加（config plugin）の見本 `with-ios27-scene.plugin.js`（写しを `with-ios27-scene.plugin.js.txt` に保存）を、使い捨ての場所の `app.json` の `plugins` に足して、`prebuild --clean` から作り直した。手作業の書き換えは無し（prebuild がそのまま生成）。
- 生成物: Info.plist に場面の設定、AppDelegate が `ExpoReactNativeFactoryProvider` を採用し、`SceneDelegate: ExpoAppSceneDelegate` を持つ（`prebuild-facts.txt`）。ビルドは 0 error / 0 warning（`native-build-plugin-candidate.txt`）。
- 起動: **落ちない**（新しいクラッシュの記録なし）。JS が読み込まれ、ホーム（T03）→「投稿を作成する」→手動投稿の画面→本文の欄に触れるとキーボードが出て、入力欄がキーボードの上に上がる（T04）。戻るボタンは「ホーム」。
- データ・ログインは #512 と同じ JS の仕掛け（偽のログイン・偽データ・偽の送信の口）で、ネットワークは使っていない。
- これは**製品に入っていない候補**の確認であり、「標準ビルドが動いた」ではない。

## 3. 持ち主と解除の条件（BLOCKED_PRODUCT_NATIVE_FIX）
- 直す場所: `apps/social-mobile/app.json`（`plugins` に1行）と、新しい設定ファイル1つ（`with-ios27-scene.plugin.js`、#397 の見本と同じ中身）。送信・Auth・データには触れない。別の道は Expo SDK 58 への更新（SDK 58 のひな形は場面の仕組みを持つ。変更が大きい）。
- **持ち主は決まっていない**: `PROJECT_RULES.md` にネイティブの設定（app.json・Expo の設定）の持ち主の決まりは無く、CODEOWNERS も無い。`app.json` は 2026-09 の土台づくり（Phase 1 / Phase 9 / Phase 2 のサインイン）で変わったきりで、今の G1〜G6 のどの TASK の持ち物にもなっていない。G2 は持ち主を推測で決めない → **総合指令が持ち主を決める必要がある**（G2 の提案: 画面とアプリの設定を持つ G1 が最も近い）。
- 解除の条件:
  1. 持ち主が決まり、上の直し（または SDK 58 への更新）を製品の PR として出し、受け入れること。
  2. その版で、**直しを当てない標準の手順**で prebuild と起動をし直し、起動・ホーム・手動投稿の画面・入力欄まで届くこと（G2 が確認する）。
  3. 実機の iPhone（iOS 27）での起動は、EAS かローカルの実機ビルドの判断が要る（EAS は別承認）。
- 既知のまま: 実機（iPhone・Android）、実 Auth、実 X、VoiceOver は NOT_VERIFIED。本番 NO_GO。

## 4. 片付け
- G2 専用の Simulator 端末・DerivedData・使い捨ての作業場所（prebuild が書き換えた app.json・package.json と設定の候補を含む）・Metro の一時フォルダ・JS の仕掛けを削除した。他の担当の端末・開発サーバーには触れていない（開始時、起動中の端末も 8081 番の Metro も無かった）。
- Mac のクラッシュの記録（`~/Library/Logs/DiagnosticReports/SocialOperations-2026-10-28-0836*.ips` の3件）は、Mac が自動で作ったもので残っている（要約を `crash-summary.txt` に保存した）。
