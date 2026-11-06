# G2-02 第9 TASK：G1 PR #646 承認・お知らせの iOS Simulator 実タップ QA

- task_id: postona-g2-gen2-09-g1-pr646-approvals-notifications-native-simulator-tap-qa-20261106
- 実施: 2026-11-06 JST、iOS 27 Simulator（G2-AP9-20261106、iPhone 17 Pro）の実タップ、手元の実 GoTrue／Kong／Edge の双子／PG17（G3 018、G5 #645 の trigger 入り）（env.txt）
- 対象: G1 PR #646 `22b21fc7`（base #640 `203e9e2c`）。使い捨てのコピーだけで承認と予約の flag を true（throwaway-flags.diff）
- 実操作（この作業の記録から数えた）: tap 80、swipe 14、text 19、press_key 12、screenshot 54。承認の HTTP の答え 20 件（http-log.txt）
- 外部 SNS・Push への送信 0、本物の OAuth なし

## 結果

| 項目 | 結果 | 根拠 |
|---|---|---|
| 設定 → 投稿の承認・お知らせの入口 | PASS | A01 |
| 承認に回す → 承認待ち、予約 0 件 | PASS | A02・A03（表 pending_approval:1、予約 0） |
| お知らせの未読 1 件、Push はまだ送られない旨 | PASS | A04（outbox 1 行あり、画面は「送った」と言わない） |
| お知らせを開く → 既読 → 元の候補へ | PASS | A05（markRead 200、表の既読 1:1） |
| 承認 → 予約 1 件 → 予約の管理 | PASS | A06・A07（表 approved、予約 0→1、「現在の接続で確認できた予約です」） |
| 却下の 2 回押し | PASS | A08（1 回目は「本当に却下する」だけで表は pending のまま）、A09（rejected、予約は 1 のまま） |
| 再接続後の旧候補 → 409 → 「修正して承認に回し直す」→ 承認 | PASS | A10（approve 409 `POSTONA_RESV_APPROVAL_GENERATION_CHANGED`、予約は増えない、get で読み戻し）、A11（revise 200 → approve 200、予約 1→2） |
| 他人・token なし・壊れた JWT | PASS（HTTP） | http-probe.txt：他人の get/approve/reject 404、他人の list 0 件、token なし 401、壊れた JWT 401 |
| A → ログアウト → B | PASS | 開いた直後の 1 枚目から B のお知らせ 0 件・候補 0 件（A13a/b、A14a/b） |
| JWT 失効（B の session を削除） | PASS | A15：list 401、「ログインを確認できませんでした…表示していた内容は閉じました」 |
| B → A に戻す | PASS | A16a/b：A の自分のお知らせだけ（未読 6 件） |
| 通信エラー | PASS（文言は P3） | A17：前の一覧を消し、「二重には作られません」と再試行を案内 |
| サービス終了 | 観察 | A18：サーバーは終了後も list・notifications を 200 で返す（http-probe.txt）。画面はその答えどおり表示 |
| 素材BOX・予約の管理との回帰 | PASS（導線のみ） | A01 の入口が並ぶ、A07 の予約の管理へ移動・戻るで重複なし |
| フラグ OFF の製品コピーで HTTP が 0 | NOT_RUN | 別の build が要る。G1 の node 試験（1017/1017、外への接続を止めた実行を含む）のみ |
| reconfirm（版・hash の食い違い）の画面 | NOT_RUN | 外から hash を変える方法がない |
| 実機・Android・hosted・実 X・Push の実配信 | NOT_VERIFIED | 対象外 |

## 気づいた点（P3）
- **G1**：通信エラーの文言が「結果を確認できませんでした。最新の内容を読み込みました。」と読み込みに成功したように読めるが、同じ画面の下には「お知らせを読み込めませんでした」（A17）。
- **G1**：通信が戻って読み直しに成功した後も、上の黄色い「結果を確認できませんでした…」が残る（A18）。
- **G3（契約の判断）**：サービス終了の後も承認の list と notifications は読める（予約と同じ扱い）。画面は答えどおりで、G1 の不具合ではない。
- **G3**：修正して回し直すと「承認待ちになりました」のお知らせがもう 1 件増える（同じ候補で 2 件）。重複ではなく、回し直しのたびの通知（server-final.txt）。
- **G1 の試験の手順**：G1 の REPORT にない `G1T39_G3_629=1` を付けないと、G1 の既存の試験が 1 件落ちて環境が止まる（env.txt）。

## 片付け
G2 の Simulator・Metro・手元の環境（コンテナ）・DerivedData（WorkspacePath で G2 の物と確認）・使い捨ての作業場所・試験の人の記録を削除。終わりにパネルを閉じた時、他の担当の端末（iPhone 17、G8-TSUNAPIC）の表示の接続も外れた。端末は起動したまま、操作・停止はしていない。
