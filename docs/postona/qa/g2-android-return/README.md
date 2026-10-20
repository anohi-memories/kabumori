# G2 第6世代 — Android の戻り（Threads 接続・外部リンク）とアカウント境界の独立オフライン QA（QA専用）

- Issue #317 TASK `postona-g2-android-return-account-boundary-offline-qa-20261020`
- base: F4 の Draft PR #260 HEAD `8e1534f2fa1d39f8f1c321ed2cf69705fddf1421`（Threads 接続の Android App Link 契約。PR #251 の上）
- **Android 端末実測: NOT_VERIFIED** — この Mac には Android SDK・adb・emulator・Java が無い（`which adb emulator sdkmanager` 不在、`java -version` 失敗）。SDK の導入は環境変更になるため行っていない。以下はすべて source / 生成 manifest / オフライン mock の結果で、端末 PASS ではない。
- 実 OAuth・Meta・Supabase・SNS への接続なし。URL の値はダミー。

## 1. この版が Android で出荷する設定（`npx expo prebuild --platform android --no-install` でローカル生成、未コミット → `generated-manifest-excerpt.txt`）

- `MainActivity`: `launchMode="singleTask"`、`exported="true"`。
- intent-filter はカスタムスキーム1つだけ: `VIEW` + `DEFAULT` + `BROWSABLE` + `scheme="kabumori-social"`（host/path 指定なし＝このスキームの全リンクを受ける）。
- **HTTPS の App Link（`autoVerify`）は無い** → Threads 接続は Android で `CALLBACK_NOT_CONFIGURED` となり、何も始まらない（fail-closed、テストで確認）。
- `app.json` に `android` ブロックが無いため、prebuild がパッケージ名 `com.anohimemories.kabumorisocialmobile` を自動生成した（iOS のバンドル ID `com.anohi-memories.kabumori-social-mobile` と別表記）。App Link 検証（assetlinks.json）にはパッケージ名と署名が要るので、**正式なパッケージ名を app.json で固定するのが前提**（観察、owner 判断）。
- prebuild 警告: `userInterfaceStyle` を Android で効かせるには `expo-system-ui` が必要（Android のライト／ダーク追従は未設定）。

## 2. テスト `apps/social-mobile/tests/g2-android-return.test.mjs`（7件 PASS）

F4 自身のテスト（正常系、DEFAULT+BROWSABLE 必須、明示 port 不可、他リンク無視、1回だけ転送、セッション変更、期限切れ）は重複させていない。追加したのは:

| ケース | 結果 |
|---|---|
| 現在の app.json（android 無し）→ Threads 接続 | CALLBACK_NOT_CONFIGURED（開始しない） |
| http・ワイルドカード host・別 host・pathPattern のみ・違う path・autoVerify が文字列・action が配列・カテゴリが2フィルタに分散・data 空・空リスト・配列でない | すべて CALLBACK_NOT_CONFIGURED |
| 複数 data のうち本当に覆う1件だけで受理、port 付きは不可 | PASS |
| 観察: host 全体の `pathPrefix "/"` は受理（コールバックを覆うのは事実）。守りは host の App Link 検証 | 記録 |
| Android の `intent://…#Intent;scheme=…;end` 形式、fragment 無し intent、カスタムスキームでコールバックのパスを運ぶもの、似た host、`kabumori-social:auth-callback`（`//` 無し）、`kabumori-social:///…` | すべて戻りとして扱わない（交換・転送0） |
| 観察: スキーム・host の大文字は URL パーサが正規化（Android は登録した小文字スキームのみ配送）。Threads の戻りは受け取った文字列のまま転送するので、サーバー側の正規化比較が前提 | 記録 |
| 観察（設計どおり）: singleTask で前回の戻りが再配送され新しい接続中に届くと、アプリは state を読まない設計なので**1回だけ**サーバーへ転送し、サーバーの拒否（CALLBACK_REFUSED）を表示。再試行・2回目の転送なし、終了後の再配送は誰にも届かない | PASS |

- 負例コントロール（`negative-controls.log`、製品ソース一時改変・各回復元）: **5/5 検出**
- アプリ全体 `node --test tests/*.test.mjs`（#260 + G2）: 303件 PASS

## 3. 端末実測（NOT_VERIFIED）と、環境ができたときの手順

Android Emulator が使える独立環境で: ローカル偽データの rig（iOS と同じ Metro resolver）で起動 → `adb shell am start -W -a android.intent.action.VIEW -d "kabumori-social://auth-callback?…ダミー…" <package>` を cold / foreground / background→resume / 連続2回 / 破損 URL で実行 → iOS gen4 と同じ観測ログ（値なし）と画面（下書き消失 G2-U1、Unmatched G2-U2 の Android 版）を記録。

## 4. 既存指摘の状態

G2-U1・G2-U2（G1／アプリ共通）、G2-T1（G4, P2）・G2-T2（F4, P3）、iOS の scene 導入: 修正 HEAD なし → 未修正のまま保持（再実行・再投稿なし）。
