# G6-12 owner-held の契約の isolation の前提と、それを強制する 2 つの案（source-only・試験用の fixture だけ）

- task_id: `common-ai-g6-owner-held-rr-isolation-contract-correction-20261020`（Issue #321、G6-12）
- 作成: 2026-10-20。**本番 NO_GO**。共有の SQL・migration・RPC は作っていない。案はすべて、実行の道具の使い捨ての DB の中でだけ作る fixture。
- 元の指摘: H3 #330（PR #384 への CHANGES_REQUIRED_P2_CONTRACT_ISOLATION）。

## 0. 証明・提案・未検証

| 区分 | 中身 |
| --- | --- |
| **反例（今の SQL）** | 予約より前の `REPEATABLE READ` / `SERIALIZABLE` のスナップショットで動く復旧が、予約が開いている A の行を閉じる。`forget_user` と B の取り直しが続き、A の送信の確定が許される。別プロセスでは、**持ち主でなくなった A が偽の AI へ 1 回送った**（§2） |
| **試験の fixture で証明** | 案 1（`READ COMMITTED` のガード）と案 2（held が自分の行に印を書く）は、どちらも同じ場面で安全の条件を満たした（§3・§4） |
| **提案（存在しない）** | どちらの案も migration ではない。本番への適用には、明示の承認と Codex Sol（高）が要る（§5） |
| **未検証** | 本物の Supabase と PostgREST のトランザクションの isolation（既定・ロールごとの設定）、本物の G5、呼び出し口への組み込み |

## 1. 前提の訂正（G6-11 の §2 を狭める）

G6-11 は「予約が開いている間は abandon も `forget_user` もできないので、held の後は送信の確定まで持ち主のまま」と説明した。これは、次の 2 つが成り立つときだけ正しい。

- `ai_calls_abandon` と `ai_calls_forget_user` を含むトランザクションが **`READ COMMITTED`** で動く。
- 文ごとに新しいスナップショットを取る。

理由は次のとおり。

- held のロック（advisory と `FOR SHARE`）は、held の RPC のトランザクションが終わると外れる。G5 の再確認や送信の確定までは続かない。
- `ai_calls_abandon` は台帳を普通の SELECT で数える。予約を作っても `ai_calls` の行は書き換わらない。
- そのため、予約より前のスナップショットを持つトランザクションは、予約を見ないまま行を `FOR UPDATE` で閉じられる。直列化のエラーにもならない。

この cluster の既定は `read committed` だったが（試験で確認）、呼び出し元がすべてそうだとは仮定できない。たとえば次の場合がある。

- ロールの `default_transaction_isolation`
- 直接接続の保守の仕事
- 1 つのトランザクションで「候補を読む → 閉じる」と続ける復旧の実装

## 2. 反例（`common_ai_gateway_owner_held_isolation_baseline_pg_test.ts`）

**2 PASS / 3 FAIL**。FAIL は見込みどおりで、安全の条件を緩めていない。3 回中 3 回とも同じだった。

| 試験 | 結果 | 観測 |
| --- | --- | --- |
| 準備 | PASS | この DB の既定は `read committed` |
| `READ COMMITTED` の復旧（比べるため） | PASS | `LEDGER_NOT_FINAL`、forget は拒否、取り直しなし、A の送信の確定は A のもの |
| **`REPEATABLE READ`** の復旧（予約より前のスナップショット） | **FAIL** | held = true → abandon = **abandoned** → state = abandoned → forget = **forgotten** → B が取り直す → A の元の予約で mark_sent が **may_send: true** |
| **`SERIALIZABLE`** の復旧 | **FAIL** | 同じ（予約と held は `READ COMMITTED` なので、SSI は危険な形を見つけない） |
| **別プロセス**（owner-held の呼び出し口、`REPEATABLE READ` の復旧） | **FAIL** | 閉じられ、取り直され、**持ち主でなくなった A の送信 1**（偽の AI が要求を受け取った） |

## 3. 案 1: `READ COMMITTED` のガード（`common_ai_gateway_owner_held_isolation_guard_pg_test.ts`、6 PASS）

- 中身: `ai_calls_abandon`・`ai_calls_forget_user`・held の冒頭で、`current_setting('transaction_isolation') <> 'read committed'` なら `AI_CALLS_REQUIRES_READ_COMMITTED`（P0001）で止める。
  - 既存の `ai_calls_forget_system_brand` と同じ形。
  - 本番では、各関数の本体の先頭に 3 行を足す。
  - fixture では、既存の関数の名前を変えて包んだ（共有の本体は写していない）。包まれた元の関数は `service_role` も直接は呼べない（試験で確認）。
- 結果:
  - `REPEATABLE READ` / `SERIALIZABLE` の復旧は P0001 で止まり、A の行は acquired のまま。forget は `CALLS_IN_FLIGHT`、取り直しは無い。
  - 別プロセスでは、A（持ち主のまま）が 1 回だけ送る。持ち主でないプロセスの送信は 0。
  - `READ COMMITTED` は変わらない。開いた試みの無い古い行は、これまでどおり閉じられる。
- **関数にできること・できないこと**（実測）:
  - 呼び出し元の isolation は**読める**（`current_setting`）ので、拒むことはできる。
  - **変えることはできない**。
    - 関数の定義に `SET transaction_isolation` を書くと、作る時点で "cannot be set locally in functions" で拒否される。
    - 本体の `SET LOCAL transaction_isolation` は、すでに文を動かしたトランザクションでは 25001。
  - したがって「関数の中で `READ COMMITTED` にする」は不可能で、**拒むしかない**。
  - PostgREST や直接の接続でも、関数の中の `current_setting` は実際のトランザクションの isolation を返す（本物の PostgREST では未検証）。
- 範囲: 送信の不変条件が頼る書き手は abandon と forget_user（行を閉じる・消す）。
  - `ai_calls_complete`・`ai_calls_claim`・`ai_ledger_mark_sent` は行の `FOR UPDATE` / 一意の制約を使うので、古いスナップショットでは直列化のエラーか一意の違反になる（安全側）。
  - `ai_calls_forget_system_brand` は既にガードを持つ。
  - 本番の前に、ほかの書き手（今後の保守の RPC を含む）にも同じガードが要るかを確かめること。
- 失うもの: `READ COMMITTED` 以外で動く復旧や保守の仕事は、止まる（fail closed）。

## 4. 案 2: isolation に依らない書き込みの衝突（`common_ai_gateway_owner_held_isolation_fence_pg_test.ts`、6 PASS）

- 中身:
  - `ai_calls.consumer_calls` に `fence_seq` を足す。
  - 行の変化の決まり（トリガー）は、acquired → acquired のときに `fence_seq` が 1 増えるだけの書き換えを許す。ほかは拒む。
  - held は「自分の acquired の行（元のトークン・完全な ID）を `fence_seq + 1` に UPDATE できたら held」にする。INSERT はしない。
  - `ai_calls_abandon` は**変えない**。既存の行の `FOR UPDATE` が、印と衝突する。
- 理由:
  - abandon のスナップショットが印より前なら、`FOR UPDATE` の時点で行は印の後に書き換わっている。`REPEATABLE READ` / `SERIALIZABLE` では 40001 になる。
  - スナップショットが印より後なら、印より前に commit された予約が見える（`LEDGER_NOT_FINAL`）。
  - abandon が先に行を持っていれば、held の UPDATE は待ち、閉じた行を見て held にならない（実測で 1 秒以上待った）。
  - `READ COMMITTED` の abandon は、印の後の新しい版を読み、台帳の文で予約を見る。
- 結果:
  - `REPEATABLE READ` / `SERIALIZABLE` の復旧は **40001**（serialization_failure）。A の行はそのまま、forget は拒否、取り直しは無い。
  - 別プロセスでは A（持ち主）が 1 回だけ送る。`READ COMMITTED` は変わらない。
  - 印は自分の行の `fence_seq + 1` だけ（`xmin` は変わり、ほかの列は同じ）。拒んだ確認は何も書かない。行を作らない。
  - トリガーは `+2` や、ほかの列と一緒の変更を拒む。閉じた行には印を付けられない。
- 失うもの:
  - held が書き込みになる（「書き込みなし」の契約が「自分の印だけ」に変わる）。試みごとに WAL が増え、行の衝突が起きうる。
  - 表とトリガーの変更が要る（`call_transition` は共有の SQL）。
  - 40001 は呼び出し元がやり直す必要がある（復旧の仕事は次の回に任せればよい）。

## 5. どちらを選ぶか（推奨と持ち主）

| | 案 1（ガード） | 案 2（印） |
| --- | --- | --- |
| isolation への依存 | `READ COMMITTED` 以外を拒む（強制） | 依存しない |
| 変える共有 SQL | abandon・forget_user・held の先頭に 3 行ずつ | 列 1 つ、トリガー、held（abandon は不変） |
| held の性質 | 読み取りだけ | 自分の行に書く |
| 漏れの危険 | ガードの無い新しい書き手が増えると、また穴になる | 行を閉じる書き手が `FOR UPDATE` を使う限り安全 |
| 既存の前例 | `ai_calls_forget_system_brand` と同じ | 無い |

**推奨**: まず **案 1**。

- 変更が小さい。
- 前例と同じ形。
- `READ COMMITTED` 以外の呼び出しを止めるので、偽の安全は生まれない。
- そのうえで、行を閉じる・消す新しい書き手を作るときは、ガードを必須にする（レビューの決まり）。
- isolation に依らない保証がほしいなら、案 2 を足す（両方は両立する）。

選ぶのは Codex Sol（高）のレビューと共有 SQL の持ち主。

| もの | 持ち主 | 要るもの |
| --- | --- | --- |
| abandon・forget_user のガード（案 1）、または列・トリガー・held（案 2）の migration | G6（`ai_calls` の作成者）。共有の DB | 明示の承認と Codex Sol（高）。この 3 つの試験の再実行。本物の Supabase と PostgREST の isolation の確認（読み取りだけ） |
| `ai_calls_claim_held` の migration と、呼び出し口への組み込み | G6 | 上の後の別の TASK |
| 消去の順番（権限の取り消し → 待ち切る → 復旧 → forget）と、再び認める場合 | G5 と運用 | G5 との合意 |
| 復旧の仕事の作り（1 つのトランザクションで「候補を読む → 閉じる」と続けない、`READ COMMITTED` で動かす） | G6 と運用 | 案 1 ならガードが強制する。案 2 なら 40001 のやり直し |

## 6. わざと壊した fixture（作業用の写しだけ）: 7/7 を検出

| 壊し方 | 検出した試験 |
| --- | --- |
| ガード: abandon を素通し | `REPEATABLE READ`・`SERIALIZABLE`・別プロセス |
| ガード: forget_user を素通し | 関数にできることの試験 |
| ガード: held を素通し | 同上 |
| ガード: `repeatable read` も通す | `REPEATABLE READ`・別プロセス |
| 印: 印を付けない（今の held と同じ） | `REPEATABLE READ`・`SERIALIZABLE`・別プロセス・印の範囲 |
| 印: トークンを見ずに印を付ける | 印の範囲 |
| 印: トリガーがどんな変更も許す | 印の範囲 |

## 7. Sol（高）に見てほしいこと

1. §1 の前提の訂正と、§2 の反例の範囲（信頼された `service_role` の復旧が古いスナップショットで動く場合。`forget_user` の前提を破る ABA を含む）。
2. 案 1 と案 2 のどちらか（または両方）。案 1 なら、ガードが要る書き手の一覧（今は abandon・forget_user。ほかの書き手は §3 の理由で安全側と判断）。
3. 本物の Supabase と PostgREST の isolation をどう確かめるか（読み取りだけのゲート）。
4. 案 2 の 40001 のやり直しと、held が書き込みになることの負荷。
