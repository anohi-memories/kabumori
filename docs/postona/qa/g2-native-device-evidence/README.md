# G2 第32世代 — アプリの識別名・iOS 27 標準ビルド・Android 実機の証拠の「誤った結び付け」を防ぐ NO_GO 判定（QA専用）

- Issue #317 TASK `postona-g2-native-identity-device-evidence-gate-offline-20261022`
- 土台: origin/main `0c42933ca5030ab31a56267529430d0473d9b155`（この PR の base）。`apps/social-mobile/app.json` は blob `c6a7e2a1fe33`。
- 2026-10-19 以後、`app.json`・`app.config.*`・`plugins/`・`eas.json`・`ios/`・`android/` を変えた枝も開いている PR も無い（修正候補なし）。G2-ID1・ID5、iOS 27 の標準ビルドが起動しない件、Android の App Links 未確認は OPEN のまま。
- 新規: `apps/social-mobile/tests/g2-native-device-evidence.test.mjs`（20件）と入力 `evidence.json`（G2 #401・#348・#376・#397・#362・#419 の記録の値を写したもの）。試験はこの作業場所の**追跡されている** `app.json` と `evidence.json` だけを読む。ネットワーク・端末・Simulator・EAS は使わない。
- G2 #444 の共通の判定（レビューの版・統合・判定の言葉）は重ねない。ここでは native 固有の**証拠の種類・環境・ビルドの種類・生成の順序**だけを扱う。

## 1. これまでの証拠（環境と生成の順序つき）

| 記録 | 関門 | どこで | ビルド | 条件 | 結果 |
|---|---|---|---|---|---|
| #401 R1 | 識別名 | prebuild（オフライン） | 生成 | 両方同時・ログインあり | iOS／Android とも `com.anohimemories.kabumorisocialmobile` |
| #401 R2 | 識別名 | 同上 | 生成 | 両方同時・ログインなし | `com.anonymous.kabumorisocialmobile` |
| #401 R3 | 識別名 | 同上 | 生成 | iOS 先・ログインあり | iOS `com.anohi-memories.kabumori-social-mobile`、Android `com.anohimemories.kabumorisocialmobile` |
| （R1〜R3 共通） | 識別名 | — | — | — | 生成のたびに追跡している `app.json`・`package.json` が書き換わる |
| #348 | iOS 27 | iOS 27 Simulator | **標準** | — | **起動直後にクラッシュ** |
| #348・#376 | iOS 27 | iOS 27 Simulator | 検証用に直したビルド | — | 起動（標準ビルドの合格ではない） |
| #348 | iOS 27 | iOS 27 Simulator | SDK 26 表記の書き換え | — | 起動（配布に使えない） |
| #397 | iOS 27 | ソース | なし | — | 受入条件を定義（ビルドなし） |
| #362・#419 | Android | ソース（オフライン） | なし | 独自 scheme の戻り | PASS（実機・HTTPS App Links ではない） |

- 特殊なビルドの合格 ≠ 標準ビルドの合格。Simulator ≠ 実機。オフラインのリンク試験・独自 scheme ≠ 実機の HTTPS App Links。
- 実機（iOS・Android）の記録は一つも無い。

## 2. 判定の規則（失敗側に倒す）
- **識別名**: 追跡されている `app.json` に `ios.bundleIdentifier` と `android.package` が固定されていること（生成で書き込まれた作業中の `app.json` は数えない）。今の版で、生成の順序（両方同時・iOS 先・Android 先）× ログイン（あり・なし）の **6 通りすべて**を流し、識別名がすべて同じで固定値と一致し、追跡しているファイルが変わらないこと。
- **iOS 27**: 今の版の**標準ビルド**（直したビルド・書き換えは不可）が、iOS 27 の Simulator **と実機**の両方で起動すること。今の版の標準ビルドにクラッシュの記録が残っていないこと。
- **Android の App Links**: `android.package` が固定され、`autoVerify` 付きの https の受け口があり、今の版で**実機**の HTTPS App Links が確認済みであること（エミュレーター・オフライン・独自 scheme は不可）。

## 3. 結果

| ID | 内容 | 判定 |
|---|---|---|
| G2-NV1 | 今の追跡されている `app.json` とこれまでの証拠で、3 つの関門すべてが NO_GO（識別名: 未固定・実行ごとに違う・生成で追跡ファイルが変わる、iOS 27: 標準ビルドが落ちる・Simulator も実機も標準の起動なし、Android: 未固定・実機の App Links なし・確認付きの https の受け口なし） | PASS |
| G2-NV2 | 入力の確認: 識別名は未固定で `android` の項目自体が無い、1 つのコミットから iOS の識別名が 3 通り（G2-ID1）、起動の合格は直したビルド 2 件と書き換え 1 件だけ | PASS |
| G2-NV3（正の対照） | 本当に満たした世界では 3 つとも外れる（判定が常に NO_GO ではない） | PASS |
| G2-NV4 M1〜M15 | 誤った結び付け 15 件: 生成の順序・ログインで識別名が違う、生成で書き込まれた作業中の設定を固定と見なす（G2-ID5）、生成が追跡ファイルを書き換える、一部の組み合わせだけ、古い版の実行、直したビルド・書き換えを標準と見なす、Simulator を実機と見なす、別の OS、古い版の標準の合格（今の版は落ちる）、オフライン・独自 scheme を App Links と見なす、エミュレーター、`autoVerify` なし、パッケージ名が未固定 | 15 件とも厳密な判定は NO_GO（素朴な「PASS がある」規則は外してしまう） |
| 負例 | 規則を弱めると対応する結び付けが通る: ビルドの種類を見ない → M7・M8、環境を区別しない → M9・M12・M13（ほかの環境の正しい記録が代わりになり M7・M8・M10 も）、版を見ない → M6・M11、一致を見ない → M1・M2 | PASS |
| G2-NV5 | 読み込みは node の標準だけ、読むのは手元のファイルだけ | PASS |

記録: `run.log`（20/20）。main + 本試験の全体: 297 件中 297 通過。

## 4. 分類と残り
- 新しい確定した問題は無い（新しい引き継ぎなし）。既知の G2-ID1・ID5、iOS 27 の標準ビルド（#397）、Android の実機・App Links（#362）は重複して報告しない。担当（native・Expo 設定）は未決のまま。
- この判定は、担当の修正版が出たときに、`app.json` が変わったことを自動で読み取る（追跡されているファイルを読むため）。そのときは `evidence.json` に、今の版での 6 通りの生成・標準ビルドの Simulator と実機の起動・Android の実機の App Links の記録を足して流し直す。
- 実機・標準ビルド・EAS・実 Apple ログイン・サーバー側の Apple の設定はどれも NOT_VERIFIED。本番 NO_GO。
- 保護したまま: Threads の G2-T1（P2）・T2・T1-X、G1/H1 の P2（#435 は CHANGES_REQUIRED）・G2-SN5・G2-RK3、G4 #426 の安全レビュー、SM 系、実 Auth／SNS。

## 5. 実行
```bash
cd apps/social-mobile && node --test tests/g2-native-device-evidence.test.mjs
```
