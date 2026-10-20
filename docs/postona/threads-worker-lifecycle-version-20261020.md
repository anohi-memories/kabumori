# G4-08：Threads の W1／W2 の「世代の版」の IF への追従（offline）（2026-10-20 JST）

- task_id: `postona-g4-threads-worker-lifecycle-version-port-offline-20261020`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY（G4 の TS と偽物だけ）**。本物の Auth／DB／Threads・本番は NOT_VERIFIED、PRODUCTION_NO_GO。
- 土台: PR #359（head `4ddc0b1d1ea880eabddd5ae7ca58cfd1b0894e2a`）の上。
- G5 の契約:
  - G5-04 PR #358 `4f4ece89af51a345c0e71cb3876278789a4f3896`（候補）
  - Issue #319 コメント 6279934094
  - H1 の再レビュー（Issue #306）は CHANGES_REQUIRED P2×1（導入時の trigger の真正さの検査）で、W1／W2 の形は変わらない。G5 の最終受理の前なので、**候補として扱う**。

## 1. G5 の新しい契約（PR #358 の SQL から）
- W1 `private.account_lifecycle_worker_brand_verdict(p_brand_id, p_service_key, p_expected_owner_epoch bigint, p_expected_lifecycle_version bigint) → text`、W2 は同じ形で service_role 専用。
- 時刻の引数と比較は無くなった。答えは `'active'` か、次のコード:
  - サービスの状態: `WORKSPACE_OWNER_UNKNOWN`／`ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND`／`ACCOUNT_DELETION_IN_PROGRESS`／`ACCOUNT_LOCKED`／`SERVICE_NOT_REGISTERED`／`SERVICE_DELETION_IN_PROGRESS`／`SERVICE_NOT_ACTIVE`／`ACCOUNT_LIFECYCLE_SERVICE_INVALID`
  - `SERVICE_STATE_UNKNOWN`
  - `EXPECTED_OWNER_EPOCH_REQUIRED`／`EXPECTED_LIFECYCLE_VERSION_REQUIRED`
  - `OWNER_EPOCH_UNAVAILABLE`／`OWNER_EPOCH_CHANGED`／`SERVICE_GENERATION_CHANGED`
- 結び付けと予約が保存するのは、R1 の allow の `owner_epoch` の符号 `g5oe:<owner_epoch>:<lifecycle_version>` の **2つの数**。送信のときに読み直して更新しない。

## 2. 変えたこと（G4 のファイルだけ）
| ファイル | 内容 |
|---|---|
| `_shared/social/g5_owner_epoch_token.ts`（新しい） | 符号を厳しく解読する。2つの数は10進の文字列のまま（1 以上、符号・先頭の0なし、BigInt で bigint の上限以下）。JS の数値・0・桁あふれ・形の違いは null。`g5Decimal` は保存された数の確認 |
| `_shared/social/threads_account_binding.ts`（G4-03） | G5 の本人の判定の口は R1 の符号（`ownerEpochToken`）を受ける。行は `bindOwnerEpoch` と `bindLifecycleVersion` を10進の文字列で持つ。epoch が違えば `OWNER_EPOCH_CHANGED`、**世代の版が違えば `SERVICE_GENERATION_CHANGED`（新しい）**。結び付けは `ownerEpoch`／`lifecycleVersion` を10進の文字列で持つ |
| `_shared/social/threads_connect_to_send.ts`（G4-04） | worker の口を `(brand, service_key, expectedOwnerEpoch, expectedLifecycleVersion)`（10進の文字列）に変えた。**`boundAtMs`・`BOUND_AT_REQUIRED` を削除**。G5 のコードの一覧を PR #358 の W1 と同じにした。旧い `SERVICE_REACTIVATED_SINCE_BIND`・`BOUND_AT_REQUIRED`・`FACTS_UNAVAILABLE` は `WORKER_VERDICT_UNKNOWN`。結び付けの2つの数は、最初の確認と公開の直前の hook（G4-07、維持）の両方に、そのまま渡す。送信のときに G5 の本人の判定を読み直さない |
| テスト | 上の3つの G4 のテストと、新しい `g5_owner_epoch_token_test.ts` |

- **今の PR #124 の行は、2つの数をどちらも記録していない**ので、本物の結び付けは引き続き `BIND_EPOCH_UNRECORDED`（安全側）。
- SQL への本当の変換（bigint への受け渡し）は、本物の W2 の transport を作るときの作業（未実装）。

## 3. テスト（実測）
| 実行したもの | 結果 |
|---|---|
| 符号・結び付け・縦断・送信の口のテスト（`--allow-read=.` だけ） | 52 passed／0 failed |
| Threads の TS 全体（`--no-check --allow-read=.`、entry_composition を除く） | **295 passed／0 failed**（前回の 288＋新しい 7） |
| H5 の config | 17 passed |
| check・lint | エラー0 |
| G4-08 のミューテーション | **19/19 を検出** |
| G4-03 の結び付けの以前のミューテーション | 実行できた 27 件すべてを検出（4件は、取り除いた数値の epoch の比較が対象で、対象なし） |
| G4-04 の縦断の以前のミューテーション | 実行できた 20 件すべてを検出（4件は、取り除いた時刻・数値の epoch が対象で、対象なし） |
| G4-07 の hook のミューテーション | 14/14 |
| G4-02 の送信の口のミューテーション | 25/25 |
| G3 PR #356 `threads_dispatch.ts`（変更なし、head `12fcba7e`）× G4 の送信の口の重ね合わせ（作業用フォルダだけ、コミットなし、型チェックあり） | 2 passed |

- G4-08 のミューテーションの例:
  - 符号の bigint の上限の確認の削除
  - 先頭の0・JS の数値を許す
  - 世代の版を捨てる、符号の位置を固定しない
  - 結び付けで世代の版・epoch を比べない
  - 行の数値を許す
  - 数値で返す
  - 縦断で世代の版の確認を外す
  - 旧いコードを受ける、新しいコードが無い
  - worker に違う世代の版・入れ替えた引数・数値を渡す
- 負例:
  - 0・符号・先頭の0・桁あふれ・JS の数値・形の違い
  - 結び付けのときの owner の切り替え（A→B→A）
  - サービスの終了と再開（世代の版の変化）を、結び付けのとき・最初の確認・公開の直前の hook のそれぞれで
  - 旧いコード
  - 2^53 を超える数の正確な受け渡し
  - 送信のときに読み直さない
- 公開の要求は、すべての拒否で0回。本物の Meta／Threads／SNS／DB／Auth の利用は0回。
- NOT_VERIFIED: 本物の W1／W2（SQL・bigint の受け渡し）、本物の Threads、管理環境、本番。

## 4. 依存（未接続）
- **G3**: 予約の行に、R1 の allow の2つの数（10進の文字列か bigint）を保存し、W1 に渡す変更（G3 の予約の SQL。G3 に1回連絡）。
- **G4**: PR #124 の SQL に、結び付けの2つの数を記録する変更（別の TASK）。
- **G5**: Threads の key `x_autopost` は契約で決まっているが、G4 の採用と実接続はこの TASK の対象外。PR #358 の最終受理。
- X の OAuth の PR #353／#355 は、引き続きマージ・配備しない。

## 5. 行っていないこと
- G3 の投稿・予約・dispatcher、G5 の Auth・RLS・schema・RPC・trigger、H5 のトークン・store の変更
- 本物の Meta／OAuth／Vault・SNS への書き込み・DB／Auth／Edge／Cron
- ゲートを開くこと、main への push、マージ、デプロイ
