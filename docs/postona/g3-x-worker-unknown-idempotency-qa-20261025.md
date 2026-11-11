# G3｜X 予約の worker：結果不明・冪等性の交差の隔離 QA（2026-10-25、Issue #318 TASK 30/50）

- task_id: `postona-g3-x-worker-unknown-idempotency-interleavings-offline-20261025`
- 返却先: POSTONA G3担当ちゃ（Issue #318）／完了コード: K3
- 判定: **G3 の新しい非製品テストと docs だけ。** 製品 SQL・migration・RPC・Auth・Edge・worker・アプリ、他の slot の PR・ファイルは変えていない。provider への送信・再送は一度もしていない。本番は NO_GO。セキュリティの PASS は主張しない。
- 照合した版（変えていない）: X の候補 001〜006・worker: PR #392 `f34aab9714f5d4f11388609262d5f64cdcce5ed9`、G3-29 PR #495 `6c50497ca11a6d6a585169268e50c0129ecf2251`、main `0c42933ca5030ab31a56267529430d0473d9b155`
- 分類: **CURRENT_OBSERVED**（実測した今の答え）／**INVARIANT**（守られていて、守り続けるべき性質。assert した）／**PROPOSED_GAP**（提案だけで決まっていない差。名前で固定）／**UNKNOWN**（確かめられない）／**PENDING_POLICY**（方針待ち。比べない）
- 重複させていないもの: G3-29 の E1〜E9、G3-25 の 43 個・G3-26 の 8 個・G3-28 の W4、PR #392 の `worker_test.ts` の 11 件（結果の対応、不正な id・例外、lease 喪失、記録できない結果、`lease_lost`、2 つの worker、ソースの検査、停止、RELEASED、停止の判定の例外）

## 1. 経路の整理（read-only、PR #392 の head）
| 段階 | 根拠 | 要点 |
|---|---|---|
| claim | `004_postona_x_resv_dispatch.sql:136-186` | 先に期限切れの lease を `uncertain/LEASE_EXPIRED` に掃く（`:162-164`）。`for update skip locked` で行を取り、`row_publishable` を確かめる。revision は変えない |
| 送信の直前 | `004:96-127` | lease の一致、G5 の BUSY なら RELEASED、行ロック、lease の期限（切れていれば RELEASED）、`row_publishable`。**残りの lease の長さは見ない** |
| 送信 | `_shared/postona_reservations/worker.ts:127-148`、`x_publisher.ts:45-83` | `OK` のときだけ 1 回送る。再送しない。publisher には account と本文だけを渡す（`worker.ts:51`・`:145`）。X の timeout は 20 秒（`x_publisher.ts:45`）で、timeout・通信の失敗・5xx は `unknown` |
| finish | `001_postona_x_reservations.sql:628-671`、`worker.ts:152-170` | id と lease で照合する。同じ成功の繰り返しだけを冪等に受ける（`:643-645`）。`claimed` 以外は `LEASE_LOST` を raise する（`:646-649`）。期限切れの lease は `uncertain` に固定し、報告を監査に残して `lease_lost` を返す（`:650-662`）。worker は記録された答え以外を uncertain と数える |
| 返却 | `004:73-87`（`release_claim`）、`004:189-196`（`release_unsent`）、`worker.ts:95-104` | `claimed` で lease が一致すれば `planned` に戻す。**時刻は見ない**。worker は、送っていない行にしか呼ばない（`worker.ts:122`・`:130-137`） |
| 取消 | `001:522-536`、`004:49-70`（`lock_own`） | `claimed` は `CANCEL_TOO_LATE`、`planned` 以外は `ALREADY_FINAL`。G5 の確認の後で行をロックする |
| Edge の構成 | `postona-x-reservation-worker/http.ts:26`・`:78-83` | 実行の予算は 45 秒。各送信の前に停止を確かめる。lease は worker の既定 120 秒（`worker.ts:111`） |

## 2. 隔離の QA（新しいパス）
- `supabase/tests/g3_x_worker_unknown_idempotency_qa/run.sh`（使い捨てのローカル PG17.11、偽のデータ。2 つのセッションの本当の同時実行を含む）
- `unknown_matrix.sql`（店側の答え）、`worker_mock_test.ts`（worker のモジュールを偽の store・publisher で動かす。worker.ts は PR #392 の head を `git show` で写す）
- 結果: 62 のセルを固定。INVARIANT 29 個を assert。PROPOSED_GAP 3 個を名前で固定。PENDING_POLICY 2 セルは記録だけ。worker の mock 4 件 PASS。2 回とも `G3_X_WORKER_UNKNOWN_IDEMPOTENCY_QA_PASS`。provider の呼び出し 0。

### 2.1 店（SQL）の交差
| 場面 | 順序 | 今の答え | 分類 |
|---|---|---|---|
| U1 | 送れたが応答が失われた（timeout）→ `uncertain` を記録 → 遅れて成功の報告 | `uncertain/X_TIMEOUT`、遅れた成功は `LEASE_LOST`、再 claim しない、取消は `ALREADY_FINAL` | INVARIANT |
| U1 | 同上の遅れた成功の post id は残るか | **0 件**（raise で巻き戻る） | **PROPOSED_GAP**（突き合わせの材料が無い） |
| U2 | 送信が lease を超え、finish が掃除より先 | `lease_lost`、`uncertain/LEASE_EXPIRED_AT_FINISH`、post id は監査に **1 件残る** | INVARIANT |
| U3 | 送信が lease を超え、別の回（再起動した worker）の掃除が先 | `uncertain/LEASE_EXPIRED`、finish は `LEASE_LOST`、post id は **0 件** | INVARIANT（成功にしない）／**PROPOSED_GAP**（U2 と順序だけで証拠の有無が変わる） |
| U4 | 同じ lease への finish の繰り返し | 同じ成功は `published`（冪等）。別の id・uncertain・failed・別の lease は `LEASE_LOST`。記録の行は 1 | INVARIANT |
| U5 | 同じ lease への 2 つの finish を同時に（成功が行を 3 秒持つ間に uncertain） | 2 つ目は**行ロックで待ち**、その後 `LEASE_LOST`。行は最初の成功だけ。記録の行は 1 | INVARIANT |
| U6 | 確認 `OK` の後、送る前に worker が落ちた | 掃除で `uncertain/LEASE_EXPIRED`（送っていないのに uncertain）。古い返却は `lease_lost`。取消は `ALREADY_FINAL` | INVARIANT（送らない側に倒れる）。利用者への見せ方は PENDING_POLICY |
| U7 | lease の期限の後、掃除の前に返却 | `released` → `planned` → 次の回でまた claim | CURRENT_OBSERVED（worker が送っていない行にしか返却を呼ばないことに依る。§3） |
| U8 | claim 中の取消 → worker が送らずに返却 → 同じ revision で取消 | `CANCEL_TOO_LATE` → `released` → `cancelled`。以後 claim しない。古い lease の確認は `LEASE_LOST` | INVARIANT |
| U8b | 取消が行を 3 秒ロックしている間に claim の回 | claim の回は**ロックで待ち**、その後 claim しない。行は `cancelled` | INVARIANT（取消が勝つ）。待った相手のロックの種類は確かめていない（UNKNOWN） |
| U9 | owner でない間に本人が取消 | `ACCOUNT_NOT_FOUND`、行は `planned` のまま | **PENDING_POLICY**（元の owner が自分の予約を取り消せるべきか。戻った後の再 claim は G3-29 E4） |
| U10 | 残り 5 秒の lease で送信の直前の確認 | `OK`（timeout の 20 秒より短い） | **PROPOSED_GAP**（成功しても `lease_lost` → uncertain になりうる。二重の送信ではない） |

### 2.2 worker のモジュール（mock）
| 件 | 順序 | 今の答え | 分類 |
|---|---|---|---|
| M1 | finish は記録されたが応答が失われた | 報告は uncertain 1・published 0。店は `published`。再起動しても送らない。返却しない | 報告のずれ: CURRENT_OBSERVED／再送しない: INVARIANT |
| M2 | 送信中に停止の要求（予算切れ・中断） | その送信は finish まで進み、返却しない。残りは返却 | INVARIANT |
| M3 | 送信が lease を超える（finish が先／掃除が先） | どちらも uncertain。報告に post id は無い。再起動しても送らない | INVARIANT／証拠は U2 の監査だけ（CURRENT_OBSERVED） |
| M4 | publisher に渡るもの | account と本文だけ。予約 id・冪等キーは渡らない | CURRENT_OBSERVED（キーは PROPOSED） |

### 2.3 ゲートの自己検査（テスト専用の変異）
- `gate_selfcheck_finish_accepts_late_success.sql`: `finish` の 1 行だけを変え、`uncertain` の行にも遅れた報告を受けさせる（雑な「突き合わせ」の模型）。
- 結果: `FAIL INVARIANT U1_success_lost_then_late_success late_published` で落ちた（期待どおり）。結果不明が確かめなしに成功へ変わると、ゲートが気づく。

## 3. 守っている性質（変えてはいけない）
1. **UNKNOWN のときは NO_SEND**: 確認が読めない・`OK` 以外・停止の要求 → 送らない（`worker.ts:127-143`、既存の試験 + M2）。
2. **結果不明は送り直さない**: `uncertain` は再 claim しない。取消もできない（U1・U3・U6・M1・M3）。
3. **finish の冪等性は id + lease + 同じ成功だけ**（U4・U5）。ほかの報告は全部 `LEASE_LOST`。
4. **返却は送っていない行だけ**: SQL は時刻を見ず、送ったかどうかも知らない（U7）。この性質は worker のコード（`worker.ts:95-104`・`:122`・`:130-137`）だけが守っている。返却を呼ぶ道を足すときは、この性質の試験を足すこと。

## 4. 最小のソース変更の候補（実施していない。全部 PROPOSED）
| # | 候補 | 閉じるもの | 注意 |
|---|---|---|---|
| C1 | `finish` で、lease が一致して行が掃除済みの `uncertain` のときは、raise せずに報告を監査に残して `lease_lost` を返す（`001:646-649` の分岐を `:650-662` と同じ扱いに） | U3（と、突き合わせの入力としての U1） | 状態は変えない。成功にするのは、X で確かめるレビュー済みの突き合わせだけ（`001:647`・`:650-655` の方針どおり） |
| C2 | `pre_publish_check` で、残りの lease が「provider の timeout + 余裕」より短ければ `RELEASED`（例: `LEASE_SHORT_BEFORE_SEND`） | U10 | 今の Edge の構成（予算 45 秒 + timeout 20 秒 < lease 120 秒）では起きにくいが、定数の組み合わせに頼っている。値と引数の形は G3 の TASK で決める |
| C3 | worker が `finish` の例外のとき、同じ引数で 1 回だけ読み直す | M1 の報告のずれ | 成功の再報告は冪等（U4）。uncertain は再報告しても `LEASE_LOST` で uncertain のまま |
| C4 | provider の呼び出しに予約 id を渡す（冪等キー・突き合わせのため） | M4 | X の API が冪等キーを受けるかは **UNKNOWN**（確かめていない）。受けないなら、ログ・突き合わせの材料に限る |
- `release_unsent` に時刻の確認を足すこと（U7）は勧めない。期限の後の返却を拒むと、送っていない行が掃除で `uncertain` になるだけで、安全は増えない。

## 5. 回帰の項目と、独立の Sol（高）レビューの条件
- 回帰: この `run.sh`（INVARIANT 29 個、C1 なら U3・U1 の `id_kept` が 1 に、C2 なら U10 が `RELEASED` に変わる）、PR #392 の `worker_test.ts`、G3-29 の `run.sh`、G3-25・G3-26・G3-28 の試験。
- Sol（高）の条件:
  1. finish・pre_publish_check・release の変更は、§3 の 4 つを壊さないことを U4・U5・U8・U8b・M1〜M3 で示す。
  2. 結果不明を成功に変える道は、X で確かめる突き合わせだけ（自己検査がその番人）。
  3. G5 の owner epoch・session verdict、G4 の connection・credential epoch の API は、合意の前に仮に決めない（G3-29 §4.2）。
  4. 製品の変更は別の G3 の TASK に限る。本番は NO_GO のまま。

## 6. UNKNOWN と PENDING_POLICY
- UNKNOWN: timeout した作成が X 側で投稿されたかどうか（本物の provider）、X の冪等キーの有無、Edge の実時間の上限、本物の G4 の述語、U8b で待ったロックの種類。
- PENDING_POLICY: 送っていないのに `uncertain` になった行（U6）の見せ方、owner でない間の取消（U9）、保持・削除・ログアウト・古い作業場所（#299、PR #475 の Q1〜Q6）。
- 別のトラック: PR #370 の P2、P7、U8・U9（G3-25 の分類）。本番は NO_GO。
