# G4-10：Threads の投稿に G5 の共通の POSTONA の利用権のキーを採用（offline）（2026-10-20 JST）

- task_id: `postona-g4-threads-common-service-key-offline-adoption-20261020`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY（G4 の TS と偽物だけ）**。本物の Auth／管理環境／Threads／本番は NOT_VERIFIED／NO_GO。
- 土台: PR #364（head `6fe75405196baa52f1b71936f87569b070904e77`）の上。
  - PR #367（G4-09 の SQL、H2 #329 がレビュー中）は**含めず、触っていない**。PR #367 が足したのは SQL の5ファイルだけで、TS は PR #364 と同じ。

## 1. G5 の契約と、G4 の採用
- **G5 の契約**（Issue #319 コメント 6267736897、G5-02 PR #344）:
  - POSTONA は X と Threads で1つのサービスで、投稿の利用権は**共通のキー `x_autopost`** で判断する。
  - `service_entitlements.service_key` は `kabumori` と `x_autopost` だけ。
  - G5 の R1／W1／W2 もこのキーで判断する（W1 は `x_autopost` 以外を `ACCOUNT_LIFECYCLE_SERVICE_INVALID`）。
- **G4 の今までの扱い**（G4-02〜04・08）:
  - `THREADS_POSTING_SERVICE_KEY = null`（未決定）。
  - `x_autopost` を「X のキーの流用」として拒否し、テストでは架空のキーを使っていた。
- **今回（G4-10）**:

  | 変えたこと | 内容 |
  |---|---|
  | キー | `POSTONA_POSTING_SERVICE_KEY = "x_autopost"`、`THREADS_POSTING_SERVICE_KEY` は同じ値 |
  | 受け付けるキー | `acceptableServiceKey(key)` は **ちょうど `x_autopost` だけ** を受け付ける。`kabumori`（アプリ）・ほかのキー・大文字・前後の空白・改行・null は拒否 |
  | 拒否のコード | 意味が「未決定」から「共通のキーではない」に変わったので、`SERVICE_KEY_UNDECIDED` を `SERVICE_KEY_INVALID` に改めた（結び付け G4-03・縦断 G4-04） |

- **キーを採用しても、何も開かない**:
  - 4つのゲート（資格情報・送信・結び付け・縦断）は false のまま。
  - 資格情報の1文の SQL は無いまま。
  - 本番用の口は、どれも閉じたまま（テストで固定）。
  - 人が投稿してよいかは、引き続き呼ぶたびに G5 の R1／W1／W2 が、保存した owner epoch と lifecycle_version で判断する。
  - 共通のキーは「どの利用権の下で判断するか」を決めるだけで、認可そのものではない。

## 2. 変えていないこと（維持）
- G4-08 の `g5oe:<epoch>:<lifecycle_version>` の2つの整数の厳密な比較（10進の文字列、JS の数値にしない）。
- G4-07 の `await beforePublish()`（公開の直前の再確認）。
- null・別の本人・別のブランド、所有者 A→B→A、サービスの終了と再開の拒否。
- 初めての接続の begin の前の R1（ブランドなし）が未決定であることによる拒否（G4-06、X の側）。
- PR #124 の今の行は、結び付けの数を持たないので `BIND_EPOCH_UNRECORDED`。PR #124 の guard の `x_autopost` は、G5 の契約どおりの共通のキーになった（流用ではない）。

## 3. テスト（実測）
| 実行したもの | 結果 |
|---|---|
| 送信の口・結び付け・縦断・符号のテスト（`--allow-read=.` だけ） | 52 passed／0 failed |
| Threads の TS 全体（`--no-check --allow-read=.`、entry_composition を除く） | **295 passed／0 failed** |
| H5 の config | 17 passed |
| check・lint | エラー0 |
| G4-10 のミューテーション（キーの判定） | **11/11 を検出** |
| G4-08 のミューテーション | 19/19 |
| hook のミューテーション | 14/14 |
| 以前の送信の口・結び付け・縦断のミューテーション | 実行できた 23・26・19 件をすべて検出。取り除いた旧いキー・数値の epoch・時刻が対象の 2・5・5 件は対象なし |

- G4-10 のミューテーション:
  - どんなキーでも許す
  - アプリのキーも許す
  - 大文字・空白を無視する
  - 旧い「形が合えば許す」に戻す
  - キーを null に戻す
  - キーでゲートを開く
  - 結び付け・縦断でキーの確認を外す
  - 旧いコード名に戻す
  - 縦断で結び付けのキーを比べない
  - キーで縦断を開く
- 負例:
  - `kabumori`・架空のキー・`X_AUTOPOST`・前後の空白・改行・null は、口・結び付け・縦断のどれでも、口に触れずに拒否する。
  - 本番用の口は、キーがあっても閉じている。
- 公開の要求は、すべての拒否で0回。本物の外への書き込みは0回（ネットの権限なし）。成功の流れは偽の Threads だけ。
- NOT_VERIFIED: 本物の Auth・管理環境・Threads・本番。

## 4. 行っていないこと
- G3 の予約・worker、G5 の RPC・Auth・利用権、H5 のトークン・Vault、PR #124 の共有の SQL の変更
- PR #367 の SQL とそのレビューのブランチへの変更
- 本物の接続、ゲートを開くこと、資格情報の RPC の追加
- main への push、マージ、デプロイ
- X の OAuth の PR #353／#355（マージ不可のまま）
