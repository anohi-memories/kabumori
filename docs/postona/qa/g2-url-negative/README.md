# G2 第5世代 — 外部 URL 復帰・誤ルーティングの負例と受入基準（QA専用、製品コード変更なし）

- Issue #317 TASK `postona-g2-external-url-navigation-negative-qa-20261020`
- base: PR #346 HEAD `c71f2a1f59d3b1eb72447a73b602adf51639c691`（手入力 X 投稿画面を含むスタック）。G1／アプリ共通の修正 PR は未作成のため、**source-only の回帰基準と負例を固定**するのが今回の成果。
- 実 OAuth・Supabase・ネットワーク接続なし。URL の値はダミー。Simulator 実測は行っていない（前世代 PR #348 `docs/postona/qa/g2-ios27/gen4/` の G01–G07・H01–H02 を再利用）。

## テスト `apps/social-mobile/tests/g2-external-url-negative.test.mjs`（9件）

| 区分 | 内容 | 現状 |
|---|---|---|
| (a) **FINDING G2-U1**（P3, owner G1/app） | `oauth-callback.tsx`・`auth-callback.tsx` は `<Redirect href="/" />` で現在の画面をホームに置き換え、前の画面へ戻らない | 固定（実測 G02→G04 と一致） |
| (a) FINDING G2-U1 | 下書きは画面の状態だけにあり、再マウントで本文・投稿先が空に戻る（端末に保存しない） | 固定 |
| (a) 混線なし | 画面はルートのパラメータを読まない（URL で本文・投稿先を指定できない） | PASS |
| (a) 混線なし | アカウント／ワークスペース切替で一覧に無い投稿先は破棄、同意も破棄 | PASS |
| (b) **FINDING G2-U2**（P3, owner G1/app） | `src/app/+not-found.tsx` が無い | 固定 |
| (b) FINDING G2-U2 | Expo 既定の Unmatched 画面は英語、受信パスから組み立てた URL を表示、`/_sitemap` へのリンクあり | 固定（実測 G07 と一致） |
| (c) | `access_token`・`refresh_token`・`provider_token`・`id_token`・`user_id`・`email`・`redirect_to` 付きの戻りは拒否（交換0） | PASS |
| (c) | エンコードで2つ目の code や別 flow を作る試み、壊れたエスケープは拒否（交換0）。`co%64e` は通常のデコードで `code` と同じ扱い（重複なら拒否） | PASS |
| (c) | 自分が始めた flow の戻りは交換1回、重複は同じ結果を共有、別 flow は交換前に拒否 | PASS |

- 前世代の `g2-deeplink-return.test.mjs`（8件、PR #348）は対象モジュールが同一のため作り直さず、PR #346 上でも 8/8 PASS を再確認。

## 負例コントロール（`negative-controls.log`、製品ソースを一時改変して各回復元）: 6/6 検出

戻り画面がホームに置き換えない（=修正を模擬）／一覧に無い投稿先を保持／未知・トークン系フィールド受理／別 flow 受理／重複で2回交換／`+not-found.tsx` 追加（=修正を模擬）

## G1／アプリ共通 owner への受入基準（修正時にこのテストの FINDING を反転させる）

1. **G2-U1**: 入力中に `kabumori-social://oauth-callback` / `auth-callback` が届いても、手入力画面の本文と選択アカウントが残る（戻り画面は現在のスタックを置き換えない、または下書きを保持）。cold start での戻りは従来どおりホームでよい。
2. **G2-U2**: 未定義・不正なリンクでは日本語の案内画面を出し、受信 URL（パス・クエリ）を表示しない。`/_sitemap` への導線を出さない（本番ビルドで sitemap ルートを無効化）。
3. 修正 HEAD が出たら、G2 が同じ Simulator 手順（PR #348 gen4 §1・§3）で限定再QAする。iOS 27 の標準ビルドは UIScene 未対応で起動しないため、native の製品修正が入るまでは FIXTURE_ONLY。

## ファイル

- `g2-external-url-negative.test.log`、`app-suite-summary.log`、`negative-controls.log`
