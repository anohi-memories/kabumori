# G2 — iOS 27 通常ビルドの起動クラッシュ診断と、PR #346 の限定再QA（QA専用、製品コード変更なし）

- Issue #317 TASK `postona-g2-ios27-normal-build-launch-diagnostic-offline-20261019`（G2 第3世代）
- 実施: 2026-10-19 22:00–22:15 JST。専用 Simulator `iPhone 18 Pro`（iOS 27.0 / 24A434、QA後削除）、Xcode 27.1（27A9275）、iOS Simulator SDK 27.1、Expo SDK 57（`expo` 57.0.23）、React Native 0.86.3。
- 対象: PR #346 HEAD `c71f2a1f59d3b1eb72447a73b602adf51639c691`（base PR #325 `400616ea…`）。Threads 表示は PR #342 HEAD `48427b80…`（製品コードは PR #167 `02fd1989…` と同一）。
- 実 SNS / Meta / Supabase への接続なし、EAS なし、feature gate は OFF。

## 1. 再現（標準ビルドのまま）

```bash
cd apps/social-mobile
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npx expo prebuild --platform ios --no-install
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npx expo run:ios --device <新規作成した QA 専用 Simulator> --no-bundler
xcrun simctl launch <device> com.anohi-memories.kabumori-social-mobile
```

- ビルドは成功（`Build Succeeded`、0 error / 0 warning）。バイナリの SDK 表記は `sdk 27.1`、`minos 16.4`。
- 起動直後にクラッシュ（22:08:12 JST）: `EXC_BREAKPOINT (SIGTRAP)`、先頭フレーム `UIKitCore ___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption_block_invoke` ← `-[UIApplication workspace:didCreateScene:…]`。全フレームは `crash-summary-standard-build.txt`。
- アプリのJSコードに到達する前（シーン生成時）に落ちるため、**source（JS）の問題ではない**。

## 2. 原因の分類: native 設定（UIScene ライフサイクル未採用）× iOS 27 SDK

| 候補 | 判定 | 根拠 |
|---|---|---|
| JS / 製品 source | **否** | JS 読み込み前にクラッシュ。同じ JS で下の native 修正だけで起動する |
| Simulator・環境固有の不具合 | **否** | 同じ端末・同じ Xcode で、native 設定だけ変えると起動する（§3） |
| **native 設定: UIScene 未採用** | **該当** | prebuild が生成する `ios/SocialOperations/AppDelegate.swift` は `UIWindow(frame:)` を自前で作る旧方式、`Info.plist` に `UIApplicationSceneManifest` が無い。iOS 27 SDK でリンクしたアプリは、シーン方式を採用していないと起動時に assert する |

- Expo 側の対応状況:
  - 使用中の `expo` 57.0.23 には `ios/AppDelegates/ExpoAppSceneDelegate.swift` が**既に入っている**（コメントに「iOS 27 SDK が scene ライフサイクル未採用を起動時に assert するため必要」と明記）。
  - しかし **SDK 57 のテンプレート（`expo-template-bare-minimum@57.0.32`、sdk-57 の最新）は AppDelegate を旧方式のまま生成**し、`UIApplicationSceneManifest` も `SceneDelegate.swift` も無い。
  - **SDK 58 のテンプレート（`expo-template-bare-minimum@58.0.23`）は対応済み**: `AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider` が window を作らず、`SceneDelegate: ExpoAppSceneDelegate` と `Info.plist` の `UIApplicationSceneManifest`（`UISceneDelegateClassName = $(PRODUCT_MODULE_NAME).SceneDelegate`）を持つ。
- 過去の回避策「ビルドのコピーを `vtool` で SDK 26.0 表記に書き換え＋ad-hoc 再署名」は、**OS にこのアプリを iOS 26 SDK 製と誤認させて assert を避けているだけ**の非推奨手段。配布ビルドには使えない。

## 3. 安全な代替（G2 の検証用フィクスチャ。製品にはコミットしていない）

prebuild が生成する **追跡外の `ios/`** だけに、SDK 58 テンプレートと同じ変更を手で当てた（`scene-fixture.diff`）:

1. `AppDelegate` に `ExpoReactNativeFactoryProvider` を付け、`application(_:didFinishLaunchingWithOptions:)` での `UIWindow` 生成と `startReactNative` を削除（factory 作成は残す）。
2. `class SceneDelegate: ExpoAppSceneDelegate {}`（`@objc(SceneDelegate)`）を追加。
3. `Info.plist` に `UIApplicationSceneManifest`（複数シーン不可、`Default Configuration`、`$(PRODUCT_MODULE_NAME).SceneDelegate`）を追加。

結果: **SDK 27.1 表記・通常の ad-hoc 署名のまま起動成功**（バイナリ書き換えなし）。D01 は Metro 未準備による「No script URL」（初回起動で bundle がまだ無かった）、Metro 準備後の再起動 D02 でホーム表示。以降の確認はすべてこのビルド。

## 4. 限定再QA（PR #346、scene 対応フィクスチャのビルド）

| 項目 | 判定 | 証拠 |
|---|---|---|
| S1 手入力画面を開いてもレッドボックスが出ない | **PASS** | E01（#325 では C02 で発生） |
| P2 キーボードを表示したままスクロールし、最下部「内容を確認する」が見える | **PASS** | E02（候補バー表示中も、キーボード上端の上にボタン） |
| P2 キーボードを閉じずにタップ → 確認画面へ | **PASS（注記あり）** | E04。1回目のタップ（E03）はスクロール直後でレイアウトが動いており、キーボードが閉じただけで遷移せず。落ち着いてからの2回目は1タップで遷移 |
| P2 キーボード上で下方向ドラッグ → キーボードが閉じる（interactive） | **PASS** | E06→E07 |
| P3 ライト／ダークのステータスバー・ヘッダー（確認画面・キーボード表示中） | **PASS** | E04（ライト）、E05（ダーク・確認画面）、E06（ダークのキーボード表示中）。注: E05 は E04 とバイト一致（画面は固定ライト配色、ステータスバーも濃色固定のため見た目が変わらない）。端末がダークだった証拠は E06（ダークのキーボード） |
| Threads ゲートOFF（投稿カード「準備中」、入力欄なし） | **PASS** | F01 |
| 日本語入力（ローマ字→かな候補→確定） | PASS | E02 |

- **標準（未修正）ビルド**: 起動不可のため上記すべて **NOT_VERIFIED**。上記 PASS は「scene 対応した native 設定」での結果であり、旧 SDK26 表記書き換えでの過去の PASS とは別物。
- G2-S2（ホーム・アカウント詳細のダーク時ステータスバー、アカウント詳細のヘッダー欠落）は PR #346 の対象外のため今回は再確認していない。

## 5. 担当への最小変更提案（製品・共有 native 設定は G2 からは変更しない）

アプリの native 設定の所有者（G1 またはアプリ共通担当）が判断する:

- **案A（推奨・最小）**: Expo の config plugin で prebuild 時に §3 と同じ3点を生成する（`withAppDelegate` で AppDelegate を差し替え、`withInfoPlist` で `UIApplicationSceneManifest` を追加、SceneDelegate.swift を追加）。`expo` 57.0.23 に `ExpoAppSceneDelegate` があるので依存追加は不要。
- **案B**: Expo SDK 58 へ上げる（テンプレートが対応済み）。影響範囲が大きく、別タスク・別承認。
- **案C（非推奨）**: SDK 26 表記の書き換え。QA 専用の暫定手段に限り、配布ビルドの合格根拠にしない。
- 受入条件: 標準の `expo run:ios`（書き換えなし）で iOS 27 Simulator が起動し、ディープリンク（`kabumori-social://`）と OAuth の戻りが scene 経由でも届くこと（`ExpoAppSceneDelegate` は URL・user activity を転送する実装だが、本アプリでの実測は未実施）。

## ファイル

- `crash-summary-standard-build.txt`: 標準ビルドのクラッシュレポート要約（端末名・ユーザー名なし）
- `scene-fixture.diff`: §3 のフィクスチャ差分（追跡外 `ios/` に当てたもの）
- `evidence/`: D01–D02（起動）、E01–E07（PR #346）、F01（Threads）。900px に縮小、mock データのみ
