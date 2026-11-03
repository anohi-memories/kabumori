# G4-07：Threads の公開の直前の確認 hook を G4 の送信の口につなぐ（offline）（2026-10-20 JST）

- task_id: `postona-g4-threads-send-beforepublish-hook-offline-20261020`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY（G4 の TS と偽物だけ）**。本物の Threads／Meta・トークン・DB・本番は NOT_VERIFIED、PRODUCTION_NO_GO。
- 土台: PR #347（head `573c48a34ee84be730f7900686f259988eda3a94`）の上。
- G3 の契約:
  - Issue #319 コメント 6279580056
  - G3 PR #356（head `12fcba7e076e467595ae58d93af05cb09e354c6a`、`threads_dispatch.ts` は変更していない）

## 1. 変えたこと
### `supabase/functions/_shared/social/threads_send_port.ts`（G4-02 の送信の口）
- `send(credential, text, hooks?)`: 型は G3 の `ThreadsSendHooks = { beforePublish(): Promise<boolean> }` と同じ形。
- **hook は必須**:
  - `hooks.beforePublish` が関数でなければ、何も作る前に `not_written container THREADS_PREPUBLISH_HOOK_REQUIRED` を返す。
  - この送信の口を使うのは G3 の予約と G4-04 の縦断だけ。手動の投稿は別のモジュールで、段階ごとに DB で再判断している。そのため、hook を省いて公開に進む道は無い。
- **hook の位置と回数**:
  - コンテナが FINISHED になった後、`publishThreadsContainer` の前に、**ちょうど1回 await** する。
  - 公開するのは `true` のときだけ。
  - false・例外・`true` 以外の値（`"true"`・1・オブジェクト・undefined）は、公開の要求0回で `not_written publish THREADS_PREPUBLISH_REFUSED`。
- **hook を呼ばない場合**: コンテナの拒否・不明・ERROR・EXPIRED・準備できない・状態が読めない・すでに PUBLISHED（公開へ進まない場合はすべて）。
- **時間の上限は G3 の持ち物**（既定5秒、最大30秒）。G4 は独自の上限を足していない（遅い hook でも、答えを待つ）。
- send が戻った後に hook を持ち続けない。2回呼ばない。

### `supabase/functions/_shared/social/threads_connect_to_send.ts`（G4-04 の縦断）
- `postOnce` は、送信の口に hook を渡す。hook は、コンテナの準備の後に G5 の worker 判定をもう一度尋ね、`'active'` のときだけ true を返す。失敗は false。
- これで、縦断でも「最後の確認」から公開までの待ちの間が閉じる。

## 2. テスト（実測）
| 実行したもの | 結果 |
|---|---|
| 送信の口・縦断・結び付けのテスト（`--allow-read=.` だけ） | 45 passed／0 failed |
| Threads の TS 全体（`--no-check --allow-read=.`、entry_composition を除く） | **288 passed／0 failed**（前回の 280＋新しい 8） |
| H5 の config | 17 passed |
| check・lint | エラー0 |
| hook のミューテーション | **14/14 を検出** |
| G4-02 の送信の口のミューテーション | 25/25 を検出 |
| G4-04 の縦断のミューテーション | 24/24 を検出（再送の変異のパターンだけ、send の新しい形に合わせた） |
| G4-03 の結び付けのミューテーション | 31/31 を検出 |
| G3 PR #356 `threads_dispatch.ts`（変更なし、SHA-256 `0f801b47…`）× G4 の送信の口の重ね合わせ（作業用フォルダだけ、コミットなし、型チェックあり、1回） | 2 passed |

- 新しいテスト:
  - hook の欠落（5形）で、要求0回
  - false・例外・同期の例外・`true` 以外で、公開0回、hook は1回
  - 遅い hook を待ってから公開する。順は「コンテナ → 状態 → hook の開始 → hook の true → 公開 → 読み戻し」
  - 公開へ進まない6つの場面で hook 0回
  - 待ちのあいだの7つの変化（所有者の変更・削除の開始・サービスの終了・終了と再開・世代の変化・G4 の確認の取り消し・投稿のスイッチ OFF）で、公開0回
  - 閉じた hook での二重の送信・再送で、公開0回
  - send が戻った後に hook は呼ばれない
  - 縦断で、最初の worker 判定の後に変わった場合（`OWNER_EPOCH_CHANGED` など6種）は公開0回
- hook のミューテーションの例:
  - hook の省略を許す
  - await しない
  - 結果を無視する
  - 真らしい値で許す
  - 例外で許す
  - コンテナの前や公開の後に呼ぶ
  - 2回呼ぶ
  - G4 の独自の時間の上限
  - 拒否を unknown にする
  - 縦断が hook を渡さない・真らしさで判定する・例外で許す
- G3 との重ね合わせ:
  - G3 の2回目の preflight は、コンテナの準備の後・公開の前に1回だけ行われる。
  - NOT_PUBLISHABLE・RELEASED・LEASE_LOST・世代の変化で、公開の要求0回。
- 偽の送信だけで、本物の外への通信は0回。
- NOT_VERIFIED: 本物の Threads／Meta・トークン・DB、管理環境、本番。

## 3. 記録だけにした依存（今回は変えていない）
- **G5 の W1／W2 の IF の変更**（G5 PR #358 `4f4ece89`、Issue #319 コメント 6279934094）:
  - 引数が `p_bound_at timestamptz` から `p_expected_lifecycle_version bigint` に変わる。
  - コードの名前が変わる: `SERVICE_REACTIVATED_SINCE_BIND` → `SERVICE_GENERATION_CHANGED`、`BOUND_AT_REQUIRED` → `EXPECTED_LIFECYCLE_VERSION_REQUIRED`。
  - G4-04 の `ThreadsWorkerVerdictPort` は、まだ `boundAtMs` を受け取る形で、G5 のコードの一覧も古い名前のまま。
  - 合わせるには、結び付けと予約に R1 の allow の `g5oe:<epoch>:<lifecycle>` の2つの数を保存し、そのまま渡す変更が要る（G3 の予約と G4 の結び付けの両方。別の TASK）。
- G5 の答え: R1 の `owner_epoch` は文字列 `g5oe:<10進>:<10進>` に固定。G4 の「文字列だけを受け付け、JS の数値にしない」扱いは正しい。
- X の OAuth の PR #353／#355 は、引き続きマージ・配備しない。

## 4. 行っていないこと
- 本物の Threads／Meta／X・トークン・Vault・SNS への書き込み
- 管理環境の Auth／DB／RLS／RPC／Edge／SQL／GRANT、Cron、ゲートを開くこと
- main への push、マージ、デプロイ
- G3 のブランチと worktree の操作、`threads_dispatch.ts` の変更
