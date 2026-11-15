# G2 第17世代 — Expo の生成設定・アプリ識別名のずれ（iOS / Android をまたぐ再現性、QA専用）

- Issue #317 TASK `postona-g2-expo-generated-identifiers-reproducibility-qa-20261020`
- 対象: origin/main `0c42933ca5030ab31a56267529430d0473d9b155`（`apps/social-mobile/app.json` は main・#366・#369・#381 で同じ中身）。この Draft PR は main から独立。
- ネイティブ / Expo 設定の担当は**未決**（G1 統括に依頼済み: Issue #316 コメント 6293451995。G1 の現在の TASK でも「共有の担当は未確定」）。**識別名の修正版は無い**。
- 新規: `apps/social-mobile/tests/g2-expo-identifiers.test.mjs`（6件、設定とソースを読むだけ）、この文書と記録。製品・ネイティブ設定は変更していない。

## 1. やったこと（使い捨ての作業場所、オフライン）
main から使い捨ての作業場所を作り、`EXPO_OFFLINE=1 CI=1 npx expo prebuild --no-install` を条件を変えて実行した。識別名を取り出す手順は `extract.sh.txt`。実行のたびに `app.json`・`package.json` を元に戻し、生成した `ios/`・`android/` を消した。最後は作業場所ごと削除した（削除前の状態は追跡ファイルの変更なし）。

- Expo CLI 57.0.25（ロックファイルで固定）
- `EXPO_OFFLINE=1` を付けた: 識別名がすでに使われていないかを App Store / Google Play に問い合わせる処理が働かない
- 「ログイン無し」は、Expo の設定置き場を一時的な空の場所に向けて再現した。ユーザーの実際のログイン状態には触れていない
- Android SDK・実機・Simulator は使っていない（ネイティブのビルドはしていない）

| 実行 | 条件 | iOS の識別名 | Android の識別名 | 記録 |
|---|---|---|---|---|
| R1 | このパソコンのログインのまま、両方同時（Android が先） | `com.anohimemories.kabumorisocialmobile` | `com.anohimemories.kabumorisocialmobile` | `R1.txt` |
| R2 | ログイン無し、両方同時 | `com.anonymous.kabumorisocialmobile` | `com.anonymous.kabumorisocialmobile` | `R2.txt` |
| R3 | このパソコンのログインのまま、iOS → Android の順 | `com.anohi-memories.kabumori-social-mobile` | `com.anohimemories.kabumorisocialmobile` | `R3.txt` |
| R4 | R3 の後で生成し直す（そのまま／`--clean`） | 変わらない | 変わらない | `R4.txt` |

どの場合も、生成すると追跡している `app.json` に識別名が、`package.json` の `ios` / `android` スクリプトに `expo run:*` が書き込まれる（#397 の観察と同じ。重ねて報告しない）。

ほかの生成値（R1）:
- iOS: 表示名 `Social Operations`、版 `0.1.0` / `1`、URL scheme `kabumori-social` と識別名そのもの（Expo が追加）、権限は Apple でのログインのみ、シーン設定なし（#397 の既知）
- Android: `versionCode 1` / `versionName "0.1.0"`、表示名 `Social Operations`、受け取る scheme は `kabumori-social` だけ（`https` はブラウザを開くための問い合わせ先の宣言で、リンクの受け取りではない）、`singleTask`

## 2. 識別名の決め方（Expo CLI 57.0.25 のソース）
`expo/node_modules/@expo/cli/build/src/utils/getOrPromptApplicationId.js`:
1. iOS は Android の識別名があればそれを使う。Android は iOS の識別名があればそれを使う。**先に生成した方が両方を決める。**
2. 無ければ `com.<このパソコンで Expo にログインしている名前>.<slug>`（キャッシュされたログイン名）
3. それも無ければ（EAS のプロジェクト ID も無いので）`com.anonymous.<slug>`

その値を `app.json` に書き込む（追跡ファイルが変わる）。

## 3. 結果

| ID | 内容 | 区分 | 判定 |
|---|---|---|---|
| **G2-ID1** | 識別名が設定で固定されておらず、作るパソコンのログイン状態と、生成の順番で変わる。同じコミットから iOS の識別名が3通りできた | 生成・ソース | **FINDING（新しい条件）** |
| **G2-ID5** | アプリ自身の公開前チェックは iOS の識別名を `app.json` から読む。追跡されている設定では「識別名が無いので公開を止める」が出るが、**手元で一度生成するだけで（登録されていない変更でも）その指摘が消え**、そのパソコンで決まった識別名で通ってしまう | 生成・アプリのソース（`R5-readiness-test.txt`） | **FINDING（新しい条件）** |
| G2-ID2 | 生成されうるどの識別名も、かぶモリ本体の `com.anohimemories.kabumori` とは重ならない。表示名・slug も別 | 静的 | PASS |
| G2-ID3 | 2つのアプリの URL scheme は別（`kabumori-social` / `kabumori`）。それぞれのソースは自分の scheme だけを使う。どちらも https リンクを受け取る設定（associated domains・確認済みの App Link）を持たない | 静的 | PASS |
| G2-ID4 | ログインの戻り（`kabumori-social://auth-callback`）と X 接続の戻り（scheme を明示して作る）は識別名に依存しない。識別名に依存するのは Apple のネイティブのログイン | ソース | PASS |
| 負例 | 識別名を固定した設定・scheme が重なる設定・本体の scheme をソースに混ぜた場合に、それぞれの判定が変わる | 静的 | PASS |
| 実機 | iOS / Android 端末でのインストール・Apple ログイン・リンクの受け取り | — | NOT_VERIFIED（ビルドも端末も使っていない） |

### 影響（G2-ID1・G2-ID5）
- iOS の識別名は、Apple でのログイン（ネイティブ）・端末の保存領域・配布登録の単位。パソコンや手順で値が変わると、作ったアプリが別のアプリとして扱われる。保存した下書きや送信途中の記録も引き継がれない。Apple のログインも、サーバー側（Supabase の Apple の設定。リポジトリの外にあり NOT_VERIFIED）が受け付ける識別名と食い違うおそれがある。
- 生成で書き込まれた識別名がそのまま登録されると、そのパソコンの個人のログイン名（例: `anohi-memories`）や `anonymous` が製品の識別名になる。本体アプリはチーム名（`anohi-memoriess-team`）が持ち主で、識別名は `com.anohimemories.kabumori`。
- G2-ID5 により、アプリ側の公開前チェックも、このずれを止められない。

## 4. 受入条件（担当の修正版が出たら G2 が実行）
1. `apps/social-mobile/app.json` に `ios.bundleIdentifier` と `android.package` を、担当が決めた値で固定する（本試験の G2-ID1・G2-ID5 が反転する）。
2. きれいな状態から、ログイン有り・無し、iOS 先・Android 先・両方同時のどれで `expo prebuild` しても、識別名が同じで、追跡ファイル（`app.json`・`package.json`）が変わらない（`extract.sh.txt` の手順）。
3. 公開前チェックが、固定した識別名で「識別名が無い」を出さない。Apple ログインの設定（サーバー側）と識別名が一致していることを担当が確認する。
4. G2-ID2〜ID4 が通り続ける。iOS の端末確認は #397 の受入条件（シーン方式）とまとめて行う。Android の端末確認は #362 の手順。
5. （任意）`package.json` の `ios` / `android` スクリプトを、生成後の形に合わせておく。

## 5. 既知のもの（重ねて報告しない）
- 追跡ファイルの書き換え・iOS の識別名が無いこと（#397 の観察 G2-IOS27-B）、Android のパッケージ名が無いこと（#362 の観察）
- iOS 27 の標準ビルドが起動しない（#397、OPEN）
- Android 端末での確認（#362、NOT_VERIFIED）

## 6. 範囲外の観察
- かぶモリ本体（リポジトリ直下の `app.json`）も `android.package` を固定していない。本体アプリの担当の範囲で、POSTONA との衝突は無い（G2-ID2）。

## 7. 実行
```bash
cd apps/social-mobile && node --test tests/g2-expo-identifiers.test.mjs
```
`run.log`（6件、全体 283 件すべて通過）。
