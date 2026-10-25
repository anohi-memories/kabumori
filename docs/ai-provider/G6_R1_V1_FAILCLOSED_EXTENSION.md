# G6-19 R1 v1 の fail closed を増やす（オフライン）

- task_id: `common-ai-g6-r1-v1-failclosed-offline-regression-extension-20261025`（Issue #321、G6-19）
- 作成: 2026-10-25。**文書とオフラインの試験だけ**。G6 の本体のコード・SQL・migration・RPC・ACL・課金は変えていない。本番・接続・merge は **NO_GO**。
- 前提:
  - G6-17 の表（`G6_R1_V1_CONSUMER_CONTRACT.md`）と試験
  - G6-18 の ABA の試験（`G6_BUSY_ABA_OFFLINE.md`）
  - G5 の最終の IF（匿名の claim D1・個人のワークスペース・session verdict・v2）は、決まっていないので固定しない。
- 試験: `supabase/tests/common_ai_gateway_r1_v1_failclosed_extension_test.ts`（7 件、すべて保証の確認）

## 1. 新しく確かめたこと

| # | 場面 | 期待（実測） |
|---|---|---|
| 1 | 拒否の理由の形: 空白入り・空・65 文字・数値・空の理由付きの allow | G5 の答えではない → `AUTH_UNKNOWN`。理由が null なら、G5 の decision のまま（deny → `AUTH_DENIED`、pending → `AUTH_PENDING`、unknown → `AUTH_UNKNOWN`）。副作用 0 |
| 2 | 時計: Edge の時計が 61 秒遅れる（allow がもう期限切れ）／31 秒進む（未来の発行） | 遅れ → 拒否（`AUTH_DENIED`、EXPIRED）、進み → `AUTH_UNKNOWN`。副作用 0。許容の範囲（25 秒進み、30 秒遅れ）なら 1 回送る |
| 3 | 再確認での owner epoch: 巻き戻り（`g5oe:7:3`、`g5oe:6:4`）・飛び（`g5oe:70:4`）・同じ epoch で別のワークスペースの答え | `AUTH_REVOKED_BEFORE_SEND`、予約は release、送信 0。同じ epoch なら 1 回送る |
| 4 | 再試行のある呼び出し（maxAttempts 2）: 1 回目が 503、2 回目の前に G5 が entitlement を外す | **試行ごとに再確認する**: 2 回目の予約は release され、送らない（G5 への問い合わせ: 判定 1 回＋試行ごとの再確認 2 回）。G5 が変わらなければ、2 回目は別の予約で、試行ごとに 1 回ずつ課金。終わった操作の再実行は、何も足さない |
| 5 | 同じ人・同じ操作 ID を、別のワークスペースで | 別の呼び出し（別の claim・予約・送信）。それぞれ自分の答えだけを返す |
| 6 | 拒否と喪失の下での重複 | 再確認で失効する同時の 2 件 → 送信 0（予約 1 つが release、もう 1 件は `IN_PROGRESS` か `NOT_SENT` の再生）。G5 が落ちている間の重複 → claim も 0。G5 が 2 件の片方だけに答える → 1 回だけ送る |
| 7 | 終わった操作をもう一度（クライアントでの答えの喪失） | 再生だけ。予約・mark_sent・settle・送信は増えない |

台帳のモデルは G6-18 と同じく、SQL の文書どおりにした（(request_id, attempt) ごとに 1 つ、未送信は使い回し、mark_sent は 1 回、release は reserved だけ）。

わざと壊した写し（製品のコード 4 か所）: **4/4 を検出**。
- 対象: 理由の形を見ない、未来の発行の許容を 60 秒広げる、期限を 120 秒遅れて見る、再確認の世代を比べない
- 型の通る書き換えで確かめた。

## 2. 分類（G6-17・G6-18・G6-19 を合わせて）

| 分類 | 内容 | 試験 |
|---|---|---|
| PASS（保証） | R1 v1 の答えの形・理由・`g5oe`・entitlement・時刻・401 / 403・届かない G5・再確認・再試行・重複で、確保・送信・課金が二重にならない | G6-17 の 6 件、G6-19 の 7 件 |
| PASS（保証） | ABA の下でも、1 つの操作は多くても 1 回しか送られない。READ COMMITTED の回復は、開いた予約がある行を閉じない | G6-18 の SAFE 6 件 |
| **KNOWN GAP 1** | 匿名の主体への allow を、G6 は見分けられない（v1 に項目が無い） | G6-17 の 7 件目。直すのは G5 の D1 |
| **KNOWN GAP 2** | 送信の直前の確認が busy を見る: 持ち主でない送信、消した行の作り直し、古いスナップショットの回復 | G6-17 の 8 件目、G6-18 の S2・S3・S5・S8b。直すのは C1（claim_held）＋C2（RC のガード） |
| **KNOWN GAP 3** | 台帳の予約が claim の持ち主に結び付いていない: claim_held だけでは、古いプロセスの release が新しい持ち主を止める。結び付けるだけ（busy のまま）だと 2 回送る | G6-18 の S2・S3（candidate）と PROPOSAL CHECK。直すのは C3（C1 と同時に） |
| NOT_VERIFIED | 本物の G5 の RPC・JWT・PostgREST、本物の DB のロック・時間 | — |

KNOWN GAP は、その試験の中で今の動きのまま固定している。保証ではなく、PASS には数えない。この TASK の 7 件は、どれも KNOWN GAP を含まない。

## 3. 残るもの

- C1〜C3 の実装（`ai_calls_claim_held` の組み込み、RC のガードの適用、台帳の予約を持ち主に結び付ける）は、別 TASK・別の承認（Opus5.5（高）＋ Codex Sol（高））。
- G5 の正式な IF が決まるまで、それとの連携の QA は起票しない（TASK の指示どおり）。
