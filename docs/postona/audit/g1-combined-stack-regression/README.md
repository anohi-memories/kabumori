# X手入力投稿UIスタック × 安全 not-found 画面 — 統合前ソース回帰（G1・offline）

- 作成: 2026-10-21（JST）。Issue [#316](https://github.com/anohi-memories/kabumori/issues/316) TASK `postona-g1-manual-publish-source-stack-combined-regression-20261021`（第9TASK、K1）
- 性格: **使い捨てのローカル統合ツリーでの検証記録**。製品 PR の merge・main 書込・既存 PR の rebase／base 変更はしていない。実 SNS・実 Auth・Simulator は使っていない。本番は NO_GO のまま。
- 根拠の版: origin/main `0c42933ca5030ab31a56267529430d0473d9b155`。各 PR の head は同じディレクトリの `heads.txt`（`gh pr view`／`gh api compare` の出力を無編集で保存）。README の SHA は `heads.txt` から機械的に転記した。**どれかの head か main が動いたら、この回帰は再実行が必要。**

## 1. 対象の版と、直列スタックの先祖証明

| 対象 | head | base | 変更 |
|---|---|---|---|
| #400（スタック先頭） | `39b9818b40fc7d10a8b9e70cd68fd02692874585` | #398 の枝 | 4 |
| #398 | `2919d2b2c18bcb656a97b9d827b825b641aa05f5` | #366 の枝 | 6 |
| #366 | `44ab2e6bb812f3484c85f847574de103757e3dfc` | #346 の枝 | 8 |
| #346 | `c71f2a1f59d3b1eb72447a73b602adf51639c691` | #325 の枝 | 3 |
| #325 | `400616ea2efe0504624b9da3e593d9e3d7520a2f` | #288 の枝 | 3 |
| #288 | `c41e20ce508530328570d22c4a0cbc0a43fb2a2e` | #283 の枝 | 13 |
| #283 | `b4b761c4dd43cc4c8c1ee1533413b46f088ba21f` | #277 の枝 | 11 |
| #277 | `abd18fc34b5c61b0178187a455a5ade8fc105dc0` | #274 の枝 | 14 |
| #274 | `007dc3d68bdb6c57e2cfb6831090f6544704a3c3` | `main`（古い base） | 10 |
| #369（独立） | `6c363afeec63327deeedeec4ee37ae8f3206fa96` | `main` | 2 |
| 参照: #396（監査）／G2 #380／#385／#376／#361 | `b386c8475feb0385f3a1124c481ada8ac6768594`／`825fc837227af9b81c7d6e9db3c0744d9b8f01ed`／`fb11542fb2febc592337e83361f2c9462d553c65`／`66cce840924820bbd223e70071efbb4eb125ebcc`／`44a04fc0e9604f02fff2e1a77a452be870c9ecd9` | — | — |

- **先祖の証明**（`heads.txt`）: #277〜#400 の各 head は直前の枝の head を含む（GitHub compare が `ahead=1 behind=0`）。さらにローカルで `#274・#277・#283・#288・#325・#346・#366・#398` の各 head が **#400 の head の先祖である**ことを `git merge-base --is-ancestor` で確認（すべて yes）。#369 は #400 の先祖ではない（独立）。よって「#400 の head 一つで #274〜#400 の全差分が入る」。
- **main の動き**: stack と main の merge-base `74b6b7ceafe6b3683ee985616b3a4e2ddb04763d` 以降、main に `apps/social-mobile` を変更するコミットは **0 件**。したがって合成は main 側の変更と衝突し得ない（main が動いたら再検証）。

## 2. 合成の手順と結果（ローカルの使い捨て branch。push しない）

1. `origin/main` から使い捨て branch を作り、**#400 の head をマージ**（#274〜#400 の 22 ファイル）→ **競合なし**。
2. その上に **#369 の head をマージ**（`+not-found.tsx` とそのテスト、2 ファイル）→ **競合なし**。
3. 両側の変更ファイルの**重複は 0 件**（#400 側 22、#369 側 2、`comm` で共通 0）。合成後の main との差は **24 ファイル（追加のみ。`(tabs)/index.tsx` はホームの入口カードの追加行のみ）**。
4. 合成ツリーの各ファイルは、それぞれの PR の head のファイルと**バイト単位で一致**（blob の比較で不一致 0）。

## 3. 合成ツリーでの実測（独立 clean checkout、オフライン）

`combined-run.txt` に集計をそのまま保存。

| 項目 | 結果 |
|---|---|
| `tsc --noEmit` | exit 0 |
| `expo lint` | exit 0 |
| `node --test tests/*.test.mjs`（全体） | **518 件: 517 PASS／0 FAIL／1 skipped**（skipped は F3 契約ファイルとの parity。F3 #278 のファイルを指定すると 7/7 PASS）。内訳: スタック 507（main 277 を含む）＋ #369 の 6 ＋ 本 PR の統合契約テスト 5 |
| 回帰の系統（テスト名ごとの PASS 数） | SM1 5／SM3 2／N1 2／N2 7／U1（下書き）13／afterFreeze 8／uncertain 25／hash-only 18／not-found 4 |
| 統合契約テスト（本 PR の新規 5 件） | 5/5 PASS。ネットワーク呼び出し 0（`fetch／XMLHttpRequest／WebSocket` をトラップ） |
| negative controls（統合契約テスト） | **7/7 検出**: 接続済みに見える送信口、投稿画面がリンクを読む、not-found が下書きストアを import、機能ファイルが `fetch`、2つ目のファイルが端末ストレージに触れる、not-found が `console` でログ、デモデータがゲートを通る |
| 単独の tree では SKIP | 手入力スタックだけ／not-found だけの tree では 5 件とも「統合ツリーが必要」で skip（無いものを確認したふりをしない） |

統合契約テスト（`apps/social-mobile/tests/g1-combined-stack-contract.test.mjs`）が固定すること:
1. expo-router 自身の `getRoutes` を本物の `src/app` に当て、`manual-publish` ルートと **#369 の `+not-found.tsx`**（生成された英語の既定画面ではない）が両方解決され、既存ルート（`(tabs)`・`oauth-callback`・`auth-callback`・`login-methods`・`account-deletion`）が損なわれていない。
2. この build の送信口は `UNCONNECTED_MANUAL_PUBLISH_PORT`。readiness は `not_connected`、`send` は `refused PORT_NOT_CONNECTED`。同意まで進めた確認画面でも、データ状態が `ready`／`mock_preview`／`loading`／`blocked`／`unavailable` のどれでも**ゲートは開かない**（実データの `ready` は `port_not_connected`、デモは `demo_data`）。
3. 二つの機能は互いを知らない（not-found は manual-publish・ストレージ・認証を import しない。投稿画面は not-found を import せず、**リンクを読む hook を一切使わない**＝ディープリンクで本文・投稿先を指定できない）。not-found は下書き／未解決の記録のキーに触れない。
4. どちらの機能のソースにも、ネットワーク・Supabase・Edge Function・資格情報・`console`・タイマーが無い（アダプターが人自身のセッション token を注入された transport へ渡すことだけが例外で、その他のファイルは token に言及しない）。
5. 端末ストレージ（AsyncStorage）に触れるのは `manual-publish-storage.ts` の 1 ファイルだけ。

### G2 の FINDING テストとの区別
G2 の #361／#380／#385 のテストは、G1 の修正前の挙動（FINDING）を固定している。G1 の修正が入った tree では SM1・SM3・U1・U2 などの FINDING が**意図どおり FAIL に反転**する（G2 が反転させる設計）。これは製品の失敗ではない。本回帰では G2 のファイルを編集も実行もしていない（#398 の時点の確認結果は #316 の REPORT に記載済み）。

## 4. 合成後に生じた新しい問題

**新規の P1／P2／P3 は無し**（競合なし、重複 path なし、バイト一致、全回帰 PASS、統合契約 5/5）。観察だけ:
- 合成ツリーでも `/_sitemap` ルートは生成されたまま（共有 `app.json` の設定が無いため。#369 は not-found 画面から導線を消すだけ）。**既知のゲート**で、新しい問題ではない。
- 上記のとおり main に app の変更が無いため、本合成は「main が動いていない」前提の結果。

## 5. NO_GO の別ゲート（本回帰では変更も解消もしていない）

| ゲート | 状態 | owner |
|---|---|---|
| iOS 27 標準ビルドの起動（UIScene 未採用） | 未修正。G2 の Simulator PASS は検証用ビルド（FIXTURE_ONLY）であって**通常ビルドの PASS ではない** | native／アプリ共通（G2 #397 の依頼先） |
| `/_sitemap` の本番無効化（`app.json` の expo-router `sitemap: false`） | 未修正 | 共有アプリ設定の担当 |
| 共有のダーク時ステータスバー（`_layout.tsx`、ホーム・アカウント詳細・Threads） | 未修正 | 共有 `_layout.tsx` の担当（未決） |
| SM2（`last_sign_in_at` は人ごとの値・別端末ログインで消しすぎ） | BLOCKED_AUTH_IF | G5／Auth |
| SM4／SM4-D（ログアウト・退会時の下書き削除、平文保存、起動時の期限掃除） | 未修正 | G5／Auth（共有 Provider）＋G1（画面・文言） |
| 実 Auth の `last_sign_in_at` の挙動 | NOT_VERIFIED | G5 |
| X 送信口の接続（F3 #272／#278、G4 の資格情報口、F5 の利用権・T13） | 未接続・Draft。接続は別の明示承認が必要 | F3／G4／F5 |
| G4 Threads 二重公開（G2-T1、P2） | 未修正（X 手入力とは別機能） | G4 |

## 6. NOT_VERIFIED
標準ビルドの Simulator、実機、実 Auth、実 X・実 OAuth、managed Supabase、本番。ハーネスと隔離したオフラインの確認であって、**製品動作の PASS ではない**。ChatGPT の独立再実行もない。

## 7. 変更範囲
本 PR は `docs/postona/audit/g1-combined-stack-regression/`（README・`heads.txt`・`combined-run.txt`）と、新規の統合契約テスト 1 本（`apps/social-mobile/tests/g1-combined-stack-contract.test.mjs`。main 単独では SKIP）のみ。製品コード・既存テスト・`app.json`・`_layout.tsx`・native・Auth／OAuth／DB／RLS／RPC／Edge・G2／G3／G4／G5 のコード・テスト・Issue 本文は変更していない。
