# POSTONA 承認・お知らせの非本番ローカル統合（G1 第44TASK）出典 manifest

- TASK: Issue #316 `postona-g1-44-approval-notification-local-screen-integration-g3-g5-reviewed-candidates-20261106`
- 用途: 非本番・ローカル検証専用。merge・deploy・フラグ ON・Push の承認ではない。本番は NO_GO
- branch: `claude/g1-postona-approval-notification-ui-20261106`（G1 #640 の固定 HEAD から作成）
- 基準の main: `92884b331043a4ff1e289ac8139a64fd46b6337f`（作業時の fresh origin/main）

## 取り込んだ source

| 順 | 担当 | PR | 固定 HEAD | merge commit | 衝突 |
|---|---|---|---|---|---|
| 0 | G1 | #640（起点、素材BOX） | `203e9e2c70e69f657f5e4829a99dfc51563f3a0a` | branch の起点 | — |
| 1 | G5 | #645（#638 の上、membership 所有権ロック） | `a4d6c0eb56441abaf00717128720e5bf6209a329` | `762d3c3d6b9008bcef6a2c5dc75f3bcb50b795d7` | なし |
| 2 | G3 | #644（#643 → #642 → #629 の上、承認・お知らせ） | `737074b2ba89bf893c9360504af3b7acf931cb34` | `08de3b6639162d8ba13cdf792aad0c9779990795` | なし |

- 方法: `git merge --no-ff`。rebase・書き換えなし。G5 #645 で増えるのは 6 ファイル、G3 #644 で増えるのは 18 ファイル（#642・#643・#644 の分）。どれも各固定 HEAD と内容が一致した
- #640・#644・#645 の HEAD・branch と main は変更していない
- G5 #645 の trigger（`public.brand_memberships` の共有 trigger）は source を取り込んだだけで、G1 のソースにコピーも独自実装もしていない。適用したのは、ローカルの使い捨て環境のテストの中だけ（`tests/local-stack/approvals.e2e.mjs`）

## G1 の変更（`apps/social-mobile/` と、この manifest だけ）

| path | 内容 |
|---|---|
| `src/features/approvals/approval-client.ts` | G3 の承認 API（`POST /functions/v1/postona-x-approvals`）の client。https のみ（テストのときだけ loopback の http）、公開キーのみ、token なしなら送らない、redirect なし、時間切れあり。信頼できない答え（5xx・通信失敗・時間切れ・契約外の本文）は UNCERTAIN |
| `src/features/approvals/approval-gate.ts` | `POSTONA_APPROVAL_UI_ENABLED = false`（製品ソースは OFF）と、API の関数名 |
| `src/features/approvals/approval-view.ts` | 状態・失敗の分類と文言、お知らせの文言、未読件数、Push を送っていない旨 |
| `src/features/approvals/use-approval-env.ts` | 使えるかの判定（フラグ、サンプル表示、設定、ログイン、本人 workspace、選択中の X アカウントが本人 workspace のものか）と、保持の範囲（利用者・workspace・アカウント） |
| `src/features/approvals/use-approvals.ts` | 投稿候補の一覧・承認に回す・修正・承認・却下 |
| `src/features/approvals/use-approval-notifications.ts` | お知らせの一覧と既読 |
| `src/app/approvals/index.tsx`、`src/app/notifications/index.tsx` | 「投稿の承認」と「お知らせ」の画面 |
| `src/app/_layout.tsx`、`src/app/(tabs)/settings.tsx` | 2 つの画面のルート登録と、設定タブからの入口 |
| `tests/approvals.test.mjs`、`tests/approvals-harness.mjs` | 画面・hook・client を G3 API の代役の上で確かめるテスト |
| `tests/local-stack/approvals.e2e.mjs`、`tests/local-stack/run-x-disconnected.sh` | 実ローカル環境のテスト。G1 の既存ランナー（G3 のランナーを元にしたもの）に 1 行を足して実行する |

## 何が実物で、何が代役か

| 部分 | 状態 |
|---|---|
| 承認・お知らせの画面、hook、client | 実物（G1 のソース） |
| 承認 API | 製品ソースではフラグ OFF で何も送らない。ローカルの実環境では、G3 の試験用複製 `postona-x-approvals-localtest`（静的なゲートと通信部分だけが製品のエントリと違う）を、実 JWT → Kong → Edge → PG で使った |
| G3 の SQL 018 | ローカルの使い捨て環境だけで、G3 の rollout が install した。managed・本番には適用していない |
| G5 の ownership lock trigger | ローカルの使い捨て環境だけで、テストが install した（`postgres` として） |
| X の接続 | G4 の SQL と偽の token（ローカルのみ） |
| Push | 送っていない。`push_outbox` の行はあるが、画面は「送った」とは表示しない |
| 投稿 | worker は動かしていない。X には何も届かない |

## 採用の前に必要なこと（この branch では解除していない）

1. G3 018 と承認 API のゲート、G5 の共有 trigger を hosted で使う前の、環境の所有者・権限の確認、ユーザーの承認、別のデプロイゲート（G3・G5・H1 の ACCEPT の条件）
2. G2 による Simulator の実タップ QA
3. Push の送信は別の担当と別のレビュー（G3 契約 §6）
4. フラグ ON と merge の順序は中央が決める
