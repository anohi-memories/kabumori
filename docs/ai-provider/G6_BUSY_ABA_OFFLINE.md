# G6-18 busy の確認の ABA を、オフラインで再現する

- task_id: `common-ai-g6-busy-claim-held-aba-offline-counterexample-20261025`（Issue #321、G6-18）
- 作成: 2026-10-25。**文書とオフラインの試験だけ**。G6 の本体のコード・SQL・migration・RPC・ACL・課金は変えていない。`ai_calls_claim_held` の組み込みもしていない。本番・merge は **NO_GO**。
- 前提: G6-17 の穴 2（PR #492）。呼び出し口の送信の直前の確認は、2 回目の `ai_calls_claim` が「busy」かどうかだけを見る。
- 試験: `supabase/tests/common_ai_gateway_busy_aba_offline_test.ts`（11 件）
  - SAFE 6 件（保証）
  - KNOWN GAP 4 件（今の危ない、または止まる結果を、そのまま固定。保証ではない）
  - PROPOSAL CHECK 1 件（直し方の条件を、試験専用のモデルで確かめたもの）

## 1. 道具立て

- 本物の呼び出し口を、2〜3 つ同時に動かす（`createAiGateway` → 共通の `execute` → 本物の台帳の guard・call store の client）。共有するのは、call store と台帳の **SQL の決まりどおりのモデル**だけ。
  - 台帳（`20261010050613`）:
    - 予約は (request_id, attempt) ごとに 1 つ。
    - 未送信の予約をもう一度予約すると、**同じ予約を使い回す**（同じ id）。
    - mark_sent は reserved → sent を 1 回だけ許す。
    - 送信済み・確定・release 済みの予約は拒む（ATTEMPT_IN_FLIGHT / ATTEMPT_FINALIZED）。
    - release は reserved → released だけ。
  - call store（`20261017120000` / `20261020154536`）:
    - `ai_calls_claim` は、無い行を作り（acquired、新しい持ち主）、acquired の行には busy と答える。
    - complete は持ち主のトークンが要る。
    - 回復（abandon）は、開いている予約が無いときだけ行を閉じる（READ COMMITTED）。
    - forget は、閉じた行だけを消す。
- それぞれのプロセスを、任意の RPC の直前で止められる。だから、下の割り込みは毎回同じ順で起きる（決定的）。
- 全部の場面を 2 通りで流す:
  - **current**: 今の呼び出し口（送信の直前の確認 ＝ 2 回目の `ai_calls_claim`、busy なら持っているとみなす）
  - **candidate**: owner-held の契約（`ai_calls_claim_held`、#409〜#431）を、試験の中だけで真似たもの
    - 同じプロセスの 2 回目以降の確認に、claim_held の決まりで答える（**最初のトークン**＋ID＋acquired のときだけ「持っている」。無い行は作らない）。
    - 呼び出し口のコードは同じ。モデルの答えだけが違う。**製品の直しではない**。
- 外部の通信・DB・秘密・有料の AI は使わない。鍵は偽物。

## 2. 結果（current / candidate）

「stale A」: A が予約の直前で止まり、その間に回復が A の行を閉じて消し（まだ予約が無いので閉じられる）、B が同じキーを取り直す。

| 場面 | current | candidate | 判定 |
|---|---|---|---|
| S1 持ち主 1 つ | 1 回送る、OK | 同じ | SAFE |
| S4 B が終わってから A が戻る | A の予約は確定済み → `UNKNOWN`、送信 0 | 同じ | SAFE |
| S6 A が止まっている間に同じ操作を再試行 | `IN_PROGRESS`、2 回目の送信なし | 同じ | SAFE |
| S7 提供元の答えの喪失 | 上限で `UNKNOWN` を保存、再試行も `UNKNOWN`、再送なし | 同じ | SAFE |
| S8a 確認と再確認の後（mark_sent の直前）に回復 | 予約が開いているので閉じられない・消せない。持ち主が 1 回送る | 同じ | SAFE |
| 全部の割り込み | 1 つの操作は、多くても 1 回しか送られない（台帳の (request_id, attempt)） | 同じ | SAFE |
| **S2** A が戻るのが「B の予約の後、B の mark_sent の前」 | **A が B の予約を使い回し、busy を通って送る**（持ち主ではない A が送信）。B は `UNKNOWN`、A は記録できず `UNKNOWN` | A は止まる。しかし A の release が**共有の予約**を解放し、B も送れない（誰も送らず、B は `UNKNOWN`） | **KNOWN GAP** |
| **S3** A が戻るのが「B の予約の前」 | **A の新しい予約が busy を通って送る**。B は送信中の予約に当たり `UNKNOWN` | A は止まる。しかし A が release した予約は B にとっても確定済みで、B も送れない | **KNOWN GAP** |
| **S5** 行が消され、誰も取り直していない | A の busy の確認が、**消した行を作り直す**（誰も持っていない acquired の行が残る）。その後で止まる（送信 0） | 作り直さない（行は無いまま）、送信 0 | **KNOWN GAP**（current だけ） |
| **S8b** 回復が予約より古いスナップショットで動く（RR / SERIALIZABLE、G6-12） | A の確認の**後**に行が閉じられ、B が取り直す。A が送る | **同じ**（確認の後の変化は、どの確認にも見えない） | **KNOWN GAP**（両方） |

数字はすべて試験の実行結果（`sends`・予約の状態・答えのコード）から。

## 3. 直すときに必要な条件（PROPOSAL。製品の直しではない）

試験専用のモデルで、組み合わせを確かめた（PROPOSAL CHECK）:
- **予約を claim の持ち主に結び付ける ＋ claim_held**: S2・S3 で、B は 1 回送って OK、A は送信 0。
- **予約を持ち主に結び付けるだけ（今の busy の確認のまま）**: S2・S3 で **2 回送る**（A と B が別々の予約で送信）。**危ない**。

ここから、直しの最小の条件は次のとおり。どれも別 TASK で、別の承認（Opus5.5（高）＋ Codex Sol（高））が要る。

| # | 条件 | 閉じるもの | 触る所 |
|---|---|---|---|
| C1 | 送信の直前の確認を `ai_calls_claim_held` にする（最初のトークン＋完全な ID＋acquired、行を作らない）。「持っていない」・届かない・読めないは、すべて送らない | S2・S3 の持ち主でない送信、S5 の行の作り直し | `gateway.ts` の markSent、`ai_calls_store.ts`（新しい RPC の client） |
| C2 | 確認の位置は今のまま（予約の**後**、再確認と mark_sent の直前、その間に他の await を入れない）。回復（abandon / forget_user）は READ COMMITTED で動かす | S8a を保つ。S8b を閉じる（RC のガード） | migration の候補 #409（RC のガード）。未適用 |
| C3 | 台帳の予約の使い回しと release を、claim の持ち主に結び付ける（例: 予約の ID にトークンか claim の世代を含める。または、持ち主の違う使い回し・release を拒む） | candidate で残る、S2・S3 で B が送れなくなる問題 | 台帳の SQL（`ai_ledger_reserve` / `release`）と guard。**C1 と同時でないと二重送信になる** |
| C4 | complete は今どおり持ち主だけ | A の結果が B の行を上書きしない | 変更なし |
| C5 | B が `UNKNOWN` で止まったときは、回復が台帳から作った監査で閉じる | 止まったままにしない | 既存の回復（変更なし。確認だけ） |

直しの TASK で、この試験に起きる変化:
- C1 を入れると、S2・S3・S5 の current の KNOWN GAP の期待が変わる（S5 は作り直さない、S2・S3 は A が送らない）。
- C3 も入れると、S2・S3 の candidate の期待が「B が 1 回送って OK」に変わる。
- S8b は、RC のガードが無いと残る。

この試験の期待を書き換えるときは、それぞれの場面ごとに理由を残すこと。

## 4. 既存の契約との関係（回帰の確認）

- R1 v1 の答え・`UNKNOWN` / 拒否・`g5oe`・entitlement は、G6-17 の試験（`common_ai_gateway_r1_v1_consumer_contract_test.ts`）。この TASK でも一緒に流した。
- 台帳・冪等・回復の既存のオフラインの試験も、一緒に流した（REPORT に記載）。
- owner-held の SQL・RC のガードの PG17 の試験は、SQL を変えていないので流し直していない（G6-15 の結果のまま）。

## 5. 確かめていないこと

- 本物の PostgreSQL での同じ割り込み。PG17 の owner-held の契約の試験は、別に ABA と非持ち主の送信 0 を確かめている（`common_ai_gateway_owner_held_contract_pg_test.ts`）。ただし、C3（予約の共有）は、まだどの PG の試験にも無い。
- 本物の回復の時間・ロックの待ち・再試行の間隔。
- G5 の最終の IF・個人のワークスペース・R1 v2 は、前提にしていない。
