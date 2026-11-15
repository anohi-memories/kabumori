# G2 第16世代 — iOS 27 の UIScene 未採用による起動クラッシュ: 統合前のネイティブ起動ゲート（QA専用）

- Issue #317 TASK `postona-g2-ios27-scene-native-launch-gate-qa-20261020`
- 対象: アプリの設定は main・#366・#369・#381 のどれでも同じ（`app.json` blob `c6a7e2a1fe33`、`expo` 57.0.23、独自の plugins なし）。この Draft PR は main から独立。
- **担当の修正版は無い**（ネイティブ設定・Expo 設定・plugins の変更は 2026-10-19 以降どの origin の枝にも無い）。よって TASK の指示どおり、**Simulator での標準ビルドの起動は行っていない**。標準ビルドは今も起動しない（OPEN、release blocker）。
- 新規: `apps/social-mobile/tests/g2-ios27-scene-gate.test.mjs`（4件、設定を読むだけ）、この文書と記録。製品・共有ネイティブ設定・SDK は変更していない。

## 1. 標準ビルドと検証用フィクスチャの区別

| ビルド | 中身 | iOS 27 Simulator | 根拠 |
|---|---|---|---|
| **標準**（`expo prebuild` → `expo run:ios`、手を加えない） | AppDelegate が自前で UIWindow を作る。`UIApplicationSceneManifest` も SceneDelegate も無い | **起動直後にクラッシュ**（`_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`）| #348 `crash-summary-standard-build.txt`（2026-10-19）。今回、#366 の版で生成物が同じであることを再確認（`prebuild-standard-sdk57.txt`） |
| G2 の検証用フィクスチャ（追跡外の `ios/` に3点を手で当てたもの） | シーン方式 | 起動・コールバックの戻り（冷えた状態・起動中とも）・画面確認を通過 | #348（D01–D02、E01–E07）、#376（K00–K25） |
| SDK 26 表記の書き換え | OS に古い SDK 製と誤認させる | 起動するが**配布に使えない** | #348 §2 |

**検証用フィクスチャでの通過は、標準ビルドの通過ではない。** 標準ビルドに関する確認項目はすべて NOT_VERIFIED のまま。

## 2. 原因の再確認（今回、ソースと公開配布物で）

| 確認 | 結果 | 記録 |
|---|---|---|
| SDK 57 の雛形の最新版 | `expo-template-bare-minimum` 57.0.32（#348 で確認した版から増えていない。公開済みの版の中身は変わらない）→ 未対応のまま | `sdk-versions.txt` |
| Expo 本体を SDK 57 の最新（57.0.30）に上げると直るか | 直らない。起動部分（`ios/AppDelegates`）は 57.0.23 と完全に同じ | 同上 |
| 設定用の部品（`@expo/config-plugins` 57.0.9、`@expo/prebuild-config` 57.0.16、`expo-router` 57.0.21、`expo` 57.0.30）にシーン設定があるか | どれも `UIApplicationSceneManifest` を扱わない | 同上 |
| 今の版での標準の生成物 | AppDelegate は旧方式（自前の UIWindow、`ExpoReactNativeFactoryProvider` なし）、Info.plist にシーン設定なし、配備ターゲット 16.4 | `prebuild-standard-sdk57.txt`、`standard-prebuild-AppDelegate.swift.txt` |
| 直すのに新しい依存が要るか | 要らない。今の `expo` に `ExpoAppSceneDelegate`・`ExpoReactNativeFactoryProvider` が入っている | 試験「G2 check」 |

## 3. 最小の修正案（担当への提案。G2 は製品に入れていない）

**案A（推奨）: アプリを作るときに自動で当てる設定部品（config plugin）**。下書きは `with-ios27-scene.plugin.js.txt`（どこにも配線していない）。
- 中身は #348 のフィクスチャと同じ3点: ① AppDelegate に `ExpoReactNativeFactoryProvider` を付ける ② 自前の UIWindow 作成と `startReactNative` を消す ③ `@objc(SceneDelegate) class SceneDelegate: ExpoAppSceneDelegate {}` と、Info.plist の `UIApplicationSceneManifest` を足す。
- 想定外の雛形（Objective-C、別の形の AppDelegate）では止まる（`sketch-guard-check.log`: 想定外の形 → 止まる、Objective-C → 止まる、当て済み → そのまま）。
- 使い捨ての作業場所で、`app.config.js` からこの下書きを当てて生成し直すと、生成物はフィクスチャと同じ形になった（`sketch-vs-standard-AppDelegate.diff`、Info.plist の形式チェック OK）。**ビルドと起動は行っていない**（担当の修正版が出た後の確認項目）。
- 配線は担当が決める: `plugins/with-ios27-scene.js` を置いて `app.json` の `plugins` に `"./plugins/with-ios27-scene"` を足す、など。

**案B**: Expo SDK 58 に上げる（雛形がシーン方式に対応済み）。影響が大きいので別の仕事・別の承認。
**案C（不可）**: SDK 26 表記の書き換え。QA の一時しのぎに限る。

## 4. 修正の受入条件（担当の修正版が出たら G2 が実行する）
1. `apps/social-mobile` で `git status` がきれいな状態から、`npx expo prebuild --platform ios --clean --no-install` → 生成物に3点が入っている（本試験の FINDING が反転する）。
2. 同じく `npx expo run:ios --configuration Debug`（**書き換えも手作業の修正もなし**）で、新しく作った専用の iOS 27 Simulator に入れて、冷えた状態から起動 → ホームが出る。
3. 画面を裏に回す → 戻す、アプリを終了 → 再起動。
4. `kabumori-social://oauth-callback?...`・`auth-callback?...` を、起動中と冷えた状態の両方で開く → 正しくホームへ戻る（`ExpoAppSceneDelegate` が URL を転送すること）。手入力投稿の下書き保持（#366）も同じ手順で戻る。
5. 既存の画面確認（#346 のレッドボックス無し・キーボード・ステータスバー、Threads のゲート OFF 表示）を標準ビルドでやり直す。
6. 全体の試験が通る。記録には OS / Xcode / SDK / Expo の版、コマンド、クラッシュ報告の有無を残す。
7. 観察 G2-IOS27-B（下記）の扱いを担当が決める。

## 5. 新しく見つかったこと
- **OBSERVATION G2-IOS27-B（担当: ネイティブ設定、未決）**: 標準の生成で、追跡しているファイルが書き換わる。`app.json` に `ios.bundleIdentifier` が無いため `com.anohi-memories.kabumori-social-mobile` が書き込まれ、`package.json` の `ios` スクリプトが `expo start --ios` から `expo run:ios` に変わる（`prebuild-standard-sdk57.txt` の後半）。CI などで、修正版を手を加えずにきれいに作る妨げになる。Android 側のパッケージ名が固定されていない件（#362 の観察）と同じ種類。
- 新しい P1/P2 は無い。

## 6. 担当について
ネイティブ設定の担当は未決（#348・#387 でも記載）。G2 からは変更しない。**統括（G1 担当ちゃ）に担当の決定を依頼する**（REPORT に記載）。

## 7. 保護したまま（重ねて報告しない）
G2-T1（P2、#391）、G2-T2（P3、#393）、G2-T1-X、SM1〜SM4・SM4-D、G2-X1（#394）。どれも修正版は出ていない。

## 8. 実行
```bash
cd apps/social-mobile && node --test tests/g2-ios27-scene-gate.test.mjs
```
`run.log`（4件、全体 281 件すべて通過）。
