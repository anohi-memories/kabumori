# G2 第9世代 — G1 PR #366（手入力X投稿の下書き保持）Simulator 限定再QA（QA専用）

- Issue #317 TASK `postona-g2-pr366-draft-session-isolation-simulator-qa-20261020`
- 対象: G1 PR #366 HEAD `44ab2e6bb812f3484c85f847574de103757e3dfc`（base = PR #346 HEAD `c71f2a1f59d3b1eb72447a73b602adf51639c691`）。G1 のソースは読み取りのみ。
- 実施: 2026-10-20 18:30 JST までに、iOS 27 Simulator（自分専用の端末を新規作成し、実施後に削除）。
- **FIXTURE_ONLY**: iOS 27 では標準ビルドが UIScene 未対応で起動しないため、prebuild 後の未追跡 `ios/` にだけ scene 対応の検証用パッチを当てて起動した（AppDelegate を `ExpoReactNativeFactoryProvider` に、`SceneDelegate: ExpoAppSceneDelegate` を追加、Info.plist に `UIApplicationSceneManifest`）。**標準ビルド・本番ビルドでの挙動は NOT_VERIFIED**。`ios/`・prebuild が書き換えた app.json / package.json / .gitignore は実施後に元へ戻した（`git diff --quiet HEAD -- apps/social-mobile` 一致）。
- 実 Auth / 実 OAuth / 実 X なし。ログイン状態・アカウント一覧・送信先は、Metro の解決先を差し替えた**テストダブル**（`rig/` に参照用コピー。どこにも配線していない `.txt`）。送信は外部へ出ない模擬ポート。

## 下書きの保存形式（端末の AsyncStorage を直接読んで確認）

キー `postona.manual-publish.draft.v1:<ユーザーID>`、中身は `{v, accountId, text, sessionMark, savedAt}` のみ（`sessionMark` = `last_sign_in_at`）。確認画面・同意・送信可否（readiness）は保存されない。

## 結果

| ID | 手順 | 期待 | 結果 | 証拠 |
|---|---|---|---|---|
| U1-a | 2つ目のXアカウント（検証用サブ）を選び入力 → 模擬 oauth-callback（warm）→ 開き直す | 本文・アカウントだけ復元 | PASS | K01–K03 |
| U1-b | 確認画面で同意まで進める → 模擬 auth-callback（warm）→ 開き直す | 本文・アカウントは復元、確認画面・同意・readiness は復元しない、X投稿ボタンは押せない | PASS（入力画面に戻る） | K04–K06 |
| U1-c | アプリ終了中に模擬 auth-callback で起動（cold）→ 開き直す | 同上 | PASS | K07 |
| C1 | 下書きを消す → アプリ再起動 → 開き直す | 何も復元しない | PASS（保存領域 `{}`） | K08–K09 |
| S1 | トークン更新（同じ人・同じ `last_sign_in_at`・新しい access token） | 復元する | PASS | K10 |
| S2 | 再ログイン（同じ人・新しい `last_sign_in_at`） | 復元しない | PASS（読み込み時に記録も削除） | K11 |
| S3 | 別の人（B）でログイン | 復元しない | PASS（A の記録は A のキーに残り、B からは読まれない） | K12 |
| X1 | 保存したアカウントが未接続になった | 復元しない | PASS（記録削除） | K13 |
| X2 | 保存したアカウントが一覧から消えた | 復元しない | PASS（記録削除） | K14 |
| SEND | 送信開始 → 応答待ちの間に保存領域を読む → 完了 → 再起動 | 送信開始で消える | PASS（応答待ち中は本文を含まない送信中記録だけ、完了後 `{}`、再起動後も空） | K17–K19 |
| AC1 | キーボード表示中に下へスクロール → 止まってから1秒以上待つ → 「内容を確認する」を1回だけタップ | 1回目のタップで確認画面へ | PASS 2/2 | K15–K16 |
| NOTE | 24時間の注記（表示・レイアウト） | 読める・重ならない | PASS | K09, K22 |
| DARK | 端末をダークモードに | 崩れない | PASS（アプリは `useColorScheme` 未使用で常にライト配色。キーボードだけダーク） | K20–K22, K25 |
| IME | 日本語かな入力（変換中 → 漢字に確定）→ 再起動 | 変換中も確定後も保存、復元できる | PASS（変換中「かた」4/280 → 確定「肩」2/280 → 再起動で「肩」復元） | K23–K25 |

S2 のときの `[G2QA] session variant=A2 user=2a1 last_sign_in_at=2026-10-20T09:30:00.000000Z` のように、Metro ログで各回のセッション種別を確認してから開いた。

### トークン更新と再ログインの違い（TASK の仮定について）

- テストダブル上では「`last_sign_in_at` が同じなら同じセッション、変われば別セッション」というアプリ側の判定どおりに動くことを実測した（S1 復元 / S2 非復元）。
- **実 Supabase Auth がトークン更新で `last_sign_in_at` を変えないこと、再ログインで必ず変えることは NOT_VERIFIED**（実 Auth の利用は禁止のため未実施）。この仮定が崩れると、更新のたびに下書きが消える（安全側）か、再ログイン後も残る（S2 が成り立たない）。
- S3 の観察: ログアウトしても A の記録は端末に残る（A のキーの下）。B からは読めない。A が再ログインすると `last_sign_in_at` の違いで読み込み時に消える。

## PR #361 の G2-U1 基準テストの再実行（#361 の commit は重複させていない）

- `pr361-findings-on-pr346.log`: base #346 で 9/9 PASS（修正前なので FINDING が成立）
- `pr361-findings-on-pr366.log`: #366 で 8 PASS / 1 FAIL。FAIL は「G2-U1: 下書きが画面の状態にしかない」という **FINDING が成り立たなくなった = 修正を検出した意図どおりの FAIL**で、製品スイートの失敗ではない。
- 同じファイルの「戻りのルートは Home へ置き換える」FINDING は #366 でも PASS のまま（ルートは変わっておらず、下書きは保存領域から戻る設計）。

## 観察（#366 の範囲外・未分類）

- 送信中（初回の送信でも）の確認カードに「前回と同じ内容・同じ送信IDで確認します。…」が出る（K19）。表示条件は `state.unresolved !== null` で、初回送信の送信中記録でも成り立つ。#366 の差分ではなく、それより前からある文言。
- 「新しい投稿を作る」の後も、直前に選んだアカウントが選択されたまま（メモリ上の状態。保存領域は空）。

## 証拠

`evidence/K00–K25`（900px に縮小）。写っているのはテストダブルのアカウント名と模擬の投稿ID だけで、トークン・実ユーザー・実投稿は含まない。送信中記録の requestId（乱数）は本文に載せていない。

## 再現

`rig/` の4ファイルを `apps/social-mobile/.g2-qa-rig/`・`apps/social-mobile/metro.config.js` に置き（`.txt` を外す）、`EXPO_PUBLIC_G2_SESSION=A1|A1R|A2|B`、`EXPO_PUBLIC_G2_XSUB=on|off|gone`、`G2_QA_PORT=0|1` を指定して `npx expo start --clear`。iOS 27 では上記の scene パッチを当てた開発ビルドが必要。終わったらこれらを消すこと（コミットしない）。
