# F6 共通AI呼出し口 × 既存の共有部品 — 適合の確認と差分（オフライン）

- task_id: `common-ai-f6-gateway-provider-ledger-callstore-conformance-gap-offline-20261019`
- 作成: 2026-10-19（F6 / 共通AI基盤）。**source-only・本番 NO_GO**。
- 前提: PR #284 の契約（`docs/ai-provider/F6_CROSS_APP_GATEWAY_OFFLINE_CONTRACT.md`）と参照の呼び出し口 `gatewayExecute`（`supabase/tests/common_ai_cross_app_gateway_reference.ts`）。**どちらもこの工程では変えていない**。
- 新しく追加したのは、この文書とテスト 3 ファイルだけ。共有の provider、台帳、`ai_calls`、H5 bridge、アプリのコードは変えていない。

## 0. まとめ

PR #284 のテストは、偽の AI・偽の台帳・偽の保存の場所だけで通していた。今回は**同じ参照の呼び出し口を本物の共有部品の上で動かした**。使った本物の部品は次のとおり。

- OpenAI と Anthropic の本物の adapter（`executeAiRequest` 経由。fetch は偽物）
- 本物の `SupabaseLedgerBudgetGuard`（偽の PostgREST と、隔離した PostgreSQL の本物の台帳 SQL）
- 本物の `ai_calls` の SQL（PR #249 の migration。隔離した PostgreSQL）

**守られていたこと（安全側）**

- どちらの AI でも、14 の場面すべてで同じ答え・同じ送信回数・同じ費用の基準・同じ台帳の手順になった。同じ番号で送り直しても再送しない。
- 送る直前の再確認は、本物の台帳でも「予約 → 再確認 → 送信の確定 → 送信 1 回 → 精算」の順に入る。取り消されたときは送信の確定に進まず、予約を返す（送信 0・使用量の行 0）。
- 台帳に届かない・台帳が送信を許さない場合は、送信 0 になる。
- 二重実行の防止、同時の依頼、中身違い、別の人・別のブランド、記録の喪失、復旧が、本物の SQL でも契約どおりに動いた。ただし後述の GAP-3 の変換を入れた場合に限る。

**足りない所（差分）: 4 件**

- GAP-1、GAP-2：送らない点は守られているが、答えのコードが違う。
- GAP-3：**このままではつなげない**。呼び出し口の控えの形を、保存の場所が受け付けない。
- GAP-4：記録の正本の扱いについての注意。

どれも、共有のコードを変えずに呼び出し口の側（F6 の所有）で直せる。共有の SQL を変える案は**提案だけ**にした（§4）。

## 1. 確かめたこと（テスト）

| ファイル | 中身 | 結果 |
| --- | --- | --- |
| `supabase/tests/common_ai_gateway_conformance_test.ts` | 両方の AI × 14 の場面、AI が断ったときの再送と再確認、本物の台帳 guard × 偽の PostgREST（順番・取り消し・台帳の障害・精算の失敗・送る中身） | 8 tests PASS（`--deny-net`） |
| `supabase/tests/common_ai_gateway_callstore_pg_test.ts` ＋ `common_ai_gateway_callstore_pg_run.sh` | 本物の台帳 SQL ＋ `ai_calls` SQL を隔離した PostgreSQL に入れ、本物の guard ＋両方の AI の adapter で動かす | 10 tests PASS（socket だけ・`listen_addresses=''`） |

- わざと壊した写し: 18 通りを作業用のフォルダだけで作り、18/18 を検出した（共有の provider 8、参照の呼び出し口 6、`ai_calls` の SQL 4）。最初は 4 通り見逃した。2 通りは意味が同じ写しだったので別の壊し方に替え、2 通りはテストを足して検出できるようにした。
- **すべて偽の部品か、隔離した DB での PASS**。本物の Supabase と PostgREST、本番の台帳と枠、本物の OpenAI / Anthropic、G5 の本物の判定は NOT_VERIFIED。

## 2. 両方の AI の答え（呼び出し口から見た表）

再送の上限 1 回、場面によっては 2 回で試した。OpenAI と Anthropic のどちらでも、**すべての列が同じ**になった。

| 場面 | 答え | 送信 | 費用の基準 | 台帳 | 同じ番号の再送 |
| --- | --- | --- | --- | --- | --- |
| 成功 | OK | 1 | 実額 | 予約 → 確定 → 精算（成功） | OK・送信 0 |
| 429（再送の上限 1） | PROVIDER_FAILED | 1 | 実額（0） | 精算（失敗） | 同じ・送信 0 |
| 混雑（OpenAI 503 / Anthropic 529） | PROVIDER_FAILED | 1 | 実額（0） | 精算（失敗） | 同じ |
| 400 / 401 | PROVIDER_FAILED | 1 | 実額（0） | 精算（失敗） | 同じ |
| 500・504・切断（再送の上限 2） | UNKNOWN | **1**（再送しない） | 上限額 | 精算（不明・上限額） | 同じ |
| こちらの時間切れ | UNKNOWN | 1 | 上限額 | 精算（不明・上限額） | 同じ |
| JSON でない・形が違う | OUTPUT_REJECTED | 1 | 実額 | 精算（失敗） | 同じ |
| アプリが弾く出力 | OUTPUT_REJECTED | 1 | 実額 | 精算（成功） | 同じ |
| AI が断る（refusal） | PROVIDER_FAILED | 1 | 実額 | 精算（失敗） | 同じ |
| 出力が途中で切れる | PROVIDER_FAILED | 1 | 実額 | 精算（失敗） | 同じ |

- 送り直すのは、429 と混雑のように「処理していない」と分かっているものだけ。そのときは試みごとに予約し直し、再確認もし直す（両方の AI で確認）。
- AI ごとの違いは、混雑を表す HTTP の数字（503 と 529）だけだった。これは共有の `errors.ts` が同じ意味にそろえている。

## 3. 契約の項目ごとに、どこで守られているか

| 契約の項目（PR #284） | 守っている場所 | 確認 | 足りない所 |
| --- | --- | --- | --- |
| 要求はモデル・AI の会社・上限を選べない | 呼び出し口（参照だけ） | PR #284 | 本物の呼び出し口はまだ無い |
| 認可は G5 の判定を受け取り、送る直前に再確認 | 呼び出し口（`markSent` を包む）＋本物の guard の順番 | 今回 | G5 の本物の `verdict` / `recheck` は無い（G5 / F5） |
| 再確認での取り消し → 送信 0・予約を返す | 共有の `executeAiRequest`（確定に失敗したら release）＋台帳の SQL（reserved → released） | 今回（本物の SQL） | 2 回目以降の取り消しは答えが違う（**GAP-1**） |
| 機能の決まりが無ければ断る | 呼び出し口だけ | PR #284 | アプリの決まりの登録は未定 |
| 1 回の操作の最大額 | 呼び出し口（`upperBoundAttemptCostUsd` × 試みの数） | PR #284 | ― |
| 台帳の枠（日・月・人ごと） | 台帳の SQL（`ai_ledger_reserve`） | 今回（本物の SQL：上限 1 回 → 2 回目は送信 0・予約 0） | 本番の枠の行は NOT_VERIFIED |
| 台帳に届かない → 送らない | 共有の `executeAiRequest`（GUARD_UNAVAILABLE / SEND_NOT_CONFIRMED） | 今回 | 答えと保存のコードが違う（**GAP-2**） |
| 費用の正本は台帳 | 台帳の SQL（予約 → 確定 → 精算、復旧） | 今回 | 精算に失敗すると控えと台帳がずれる（**GAP-4**） |
| 再送しない・二重に請求しない | 共有の retry（処理していないと分かったものだけ）＋ `ai_calls`（acquired は busy） | 今回（両方の AI・本物の SQL） | ― |
| 同じ番号・中身違い・同時 | `ai_calls`（claim の同じ識別と busy） | 今回（本物の SQL） | ― |
| アプリ・人・ブランドで分ける | 呼び出し口の番号（アプリ＋判定の主体＋機能）＋ `ai_calls` の行 | 今回（同じ番号で 3 行・台帳の key も 3 つ） | bridge と呼び出し口で番号の作り方が違う（§5） |
| ブランドの slug を台帳に入れない | 呼び出し口（人だけを渡す）＋ guard（`brand_id` は uuid のときだけ） | 今回（本物の guard の送信内容） | slug は `ai_calls.brand_ref`（表示用）にだけ入る |
| 結果を記録してから答える | 呼び出し口 → `ai_calls_complete` | 今回 | **控えの形が合わない（GAP-3）** |
| 記録の喪失 → 処理中 → 復旧で UNKNOWN | `ai_calls`（abandon が台帳と控えを照合） | 今回（本物の SQL・台帳より少ない費用の控えは拒否） | 復旧の Cron は無い（別の承認） |

## 4. 差分（GAP）と直し方の提案

> 2026-10-19 追記：GAP-1・GAP-2（案 A）・GAP-3（案 A）は、参照の呼び出し口の中で修正候補にした（`docs/ai-provider/F6_GATEWAY_GAP_FIXES.md`）。共有のコードは変えていない。以下は見つけた時点の記録。

**どれも実装していない。** 直す場合の owner と、レビューが要るかどうかも書いた。

### GAP-1　2 回目以降の試みの前に取り消されると「枠の超過」と答える
- **今の動き**：1 回目が 429 などで送り直すときに、2 回目の前の再確認で取り消されたとする。送信は 1 回だけで、2 回目の予約は返される。ここまでは正しい。しかし 1 回目の費用の基準が「実額」になるため、呼び出し口の分岐「取り消し、かつ送信なし」に当たらない。その結果 `BUDGET_DENIED` として保存され、`QUOTA_EXCEEDED` と答える。
- **影響**：アプリは、使えなくなった人に「枠を使い切りました」と表示してしまう。送信と費用に問題はない。
- **直し方**：呼び出し口の結果の分け方で、`revoked` を `BUDGET_DENIED` より先に見る。上限額の場合は除き、`POLICY_DENIED` として保存し、最初の答えは `AUTH_REVOKED_BEFORE_SEND` にする。owner は F6（呼び出し口）。共有のコードは変えない。**レビューは不要**（送らない・費用の扱いは同じ）。

### GAP-2　台帳の障害で、その操作が「枠の超過」として確定してしまう
- **今の動き**：台帳に届かない、台帳が 5xx を返す、台帳が送信を許さない、のどれでも送信は 0 で正しい。しかし `executeAiRequest` は `BUDGET_DENIED` を返す（detail は `GUARD_UNAVAILABLE` / `SEND_NOT_CONFIRMED`）。呼び出し口はこれを確定の `BUDGET_DENIED` として保存する。そのため、台帳が直った後も、同じ番号では `QUOTA_EXCEEDED` が返り続ける。
- **影響**：一時的な障害が、利用者には「枠の超過」に見える。アプリは新しい番号で依頼し直すしかない。
- **直し方（案 A・推奨）**：呼び出し口で `result.detail` を見て、`GUARD_UNAVAILABLE` / `SEND_NOT_CONFIRMED` / `INVALID_AMOUNT` を新しい公開コード `LEDGER_UNAVAILABLE` にする。保存は送信なしの `POLICY_DENIED` にし、再送の答えは `NOT_SENT` にする。アプリには「新しい番号でやり直してよい」と伝える。owner は F6。共有のコードは変えない。**レビューは不要**。
- **直し方（案 B・提案だけ）**：送らずに終わった claim を消せる RPC を `ai_calls` に足し、同じ番号でやり直せるようにする。共有の SQL・RPC を変えるので、**限定のセキュリティレビューが要る**。今は不要と判断した。

### GAP-3　呼び出し口の控えの形を `ai_calls` が受け付けない（このままではつなげない）
- **今の動き**：
  - 呼び出し口の控えは 8 項目（`callKey, tenantTag, app, feature, model, attempts, estimatedCostUsd, costBasis`）。
  - `ai_calls` は H5 bridge の 9 項目（`callId, tenantTag, feature, role, model, policyVersion, attempts, estimatedCostUsd, costBasis`）ちょうどだけを受け付ける。
  - そのまま保存すると `ai_calls_complete` が拒否する。呼び出し口は**送信 1 回・課金済みのまま `UNKNOWN`** と答え、行は acquired のまま残る。同じ番号の依頼は IN_PROGRESS になり、復旧の abandon を待つことになる。
  - 確認した内容：控えをそのまま渡す、名前だけ変える、9 項目に `app` を足す、のどれも拒否された。9 項目ちょうどなら受け付けた。
- **直し方（案 A・推奨）**：呼び出し口と保存の場所の間に変換を置く。今回のテストの `MappedSqlStore` がこの変換の雛形で、本物の SQL で 10 tests を通した。
  - `callKey` を `callId` にする。
  - `feature` には `ai_calls` の行と同じ `app:feature` を入れる。
  - `role` には決まりの `logicalRole` を入れる。
  - `policyVersion` には決まりの版を入れる。**今の `FeaturePolicy` には版が無い**ので、`revision` を足す必要がある。
  - 戻すときは `app` / `feature` を claim の文脈から補う。

  owner は F6（呼び出し口の型と変換）。共有の SQL は変えない。**レビューは不要**。
- **直し方（案 B・提案だけ）**：`ai_calls` が呼び出し口の控えの形も受け付けるようにする。共有の migration と検証の関数を変えるので、**限定のレビューが要る**。案 A で足りるので、採らないことを勧める。

### GAP-4　精算に失敗すると、控えと台帳が一時的にずれる（注意）
- **今の動き**：送信は成功したが精算の RPC が失敗した場合、答えは OK で、控えは実額のまま。台帳の試みは `sent` のまま残り、台帳の復旧が上限額で確定させる。
- **扱い**：契約どおり「台帳が正本、控えは写し」。費用の報告や上限の判断は**必ず台帳から読む**。控えの合計を請求額として使わない。ここはテストに残して固定した。

## 5. H5 bridge と呼び出し口が両方あるときの注意

- bridge は Claude だけで、番号は `[tenantTag(application, subject), feature id, operationId]` から作る。
- 呼び出し口は両方の AI に対応し、番号は `[tenantTag(app, 判定の主体＋ブランド), "app:feature", operationId]` から作る。
- そのため、**同じ機能・同じ操作でも、bridge と呼び出し口では番号が変わる**。同じ機能を両方の道から呼ぶと、二重実行の防止が道をまたいで効かない。
- **決まり（提案）**：1 つの機能は、どちらか 1 つの道だけから呼ぶ。道を移すときは機能の名前を変えるか、古い道を閉じてから移す。

## 6. 保存のコードの対応

- 呼び出し口が保存する失敗のコードは 6 種類（`POLICY_DENIED, COST_DENIED, BUDGET_DENIED, OUTPUT_REJECTED, PROVIDER_FAILED, UNKNOWN`）。すべて `ai_calls` が受け付けた。
- `ai_calls` が受け付ける 7 種類のうち、`MODEL_UNAVAILABLE` は呼び出し口からは出ない。
- 公開のコード（`QUOTA_EXCEEDED, NOT_SENT, AUTH_REVOKED_BEFORE_SEND, IN_PROGRESS, OPERATION_REUSED, AUTH_DENIED`）は保存できない（拒否されることを確認した）。保存と答えのコードは、必ず `publicCode` を通して分ける。

## 7. 未確認（NOT_VERIFIED）と残件

- 本物の Supabase / PostgREST / managed のロールと権限、本番の台帳と枠の行、`ai_calls` の本番への適用（未適用）、本物の OpenAI / Anthropic、G5 の本物の `verdict` / `recheck`、復旧の Cron。
- `_shared` 全体の既知の型エラー 5 件と、権限で止まる 1 件はこれまでどおり（今回は触れていない）。
- 次の小さな工程の候補（どれも F6 の所有。共有のコードは変えない）。推奨モデルは Opus5.5（高）。
  1. GAP-1・GAP-2（案 A）・GAP-3（案 A）を呼び出し口の参照に入れ、今回の GAP テストを「直った後の期待」に書き換える。
  2. `FeaturePolicy.revision` を足す。

  案 B は、どちらも共有 SQL の変更なので、別の承認と限定のレビューを経てから。
