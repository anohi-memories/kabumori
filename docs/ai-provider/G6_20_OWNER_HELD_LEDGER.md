# G6-20 持ち主の確認つきの台帳（C1＋C3 を一緒に入れる）

- task_id: `common-ai-g6-postona-mvp-text-hashtag-gateway-aba-ledger-source-batch-20261028`（Issue #321、G6-20）
- 作成: 2026-10-28。**ソースの候補**。SQL は未適用の候補（`supabase/candidates/common_ai_g6/001_ai_calls_owner_held_ledger.sql`）。本番・managed への適用、merge、deploy は **NO_GO**。
- 前提: G6-17 の穴 2・G6-18 の C1〜C5・G6-19 の分類。`ai_calls_claim_held` と RC のガード（`20261020154536`、#409〜#431、未適用）。

## 1. 何を直したか

G6-18 で再現した危険は、次の 3 つ。
- 持ち主でなくなったプロセスが送る（S2・S3）
- 消した行を作り直す（S5）
- 古いスナップショットの回復が、確認の後に行を閉じる（S8b）

加えて、「C1（claim_held）だけ」では古いプロセスの release が新しい持ち主を止め、「C3（予約を持ち主に結び付ける）だけ」では 2 回送ってしまう、と分かっていた。

今回は、**予約・送信の許可・release そのものに、持ち主の確認を同じトランザクションで組み込んだ**。
- `public.ai_calls_reserve_held(p {held, ledger})`: 持ち主の確認（最初のトークン＋完全な ID＋acquired。行は作らない）が通ったときだけ、台帳の予約に進む。
  - 持ち主でないプロセスは、**台帳に一度も触れない**。だから、ほかの持ち主の予約を使い回すことも、解放することも、試行番号を使い切ることもできない。
  - 予約をした claim のトークンを `ai_calls.attempt_owners` に記録する。ほかのトークンの予約を使い回すことになる場合は拒み（`ATTEMPT_OWNER_MISMATCH`）、その ID は返さない。
- `public.ai_calls_mark_sent_held(p {held, reservation_id})`: 送信の許可の**その瞬間に**、持ち主と予約の持ち主の両方を確かめる。確認と許可の間に隙間は無い。
- `public.ai_calls_release_held(p {held, reservation_id})`: 自分の予約だけを解放する。
- settle は今までどおり `ai_ledger_settle`（許可を受けた試行の確定だけ）。
- ロックの順番は、ほかの G6 の RPC と同じ（本人 → 呼び出しキー → 行 FOR SHARE → 台帳）。READ COMMITTED 以外は P0001 で拒む。EXECUTE は service_role だけ。
- 前の確認と後の確認で、失敗すれば全体が巻き戻る。2 回目の適用も拒む。何も修復しない。

TypeScript の側:
- `SupabaseLedgerBudgetGuard` に `held` を足した。これがあると reserve・markSent・release が上の 3 つの RPC を通る。持ち主でないと分かったときは、`LedgerOwnerNotHeldError` を投げる。
- `gatewayExecute` は 2 つの道だけを持つ。
  - **owner-held**: `heldBudget` で、呼び出しごとに上の guard を作る。2 回目の `ai_calls_claim`（busy の確認）は、もう呼ばない。
  - **legacy**: `legacyBusyHeldCheck: true` ＋ `budget` のときだけ。古い試験のためだけに残した。**危ない**。
  - どちらでもなければ、G5 に尋ねる前に `LEDGER_UNAVAILABLE` で止まる。
  - 再確認（G5）は、送信の許可の直前のまま（R2）。
- `createAiGateway` の既定は **owner_held**。`legacy_busy_check_unsafe` は、古い試験だけが明示して使う。それ以外の値は設定の誤り。
  - 本番で RPC がまだ無い間は、`ai_calls_reserve_held` が 404 → 何も送らない（`UNKNOWN`）。

C1 だけ、C3 だけの道は、作っていない（どちらも、1 つの guard と 1 つの SQL にまとめた）。

## 2. 確かめたこと

- 実際の SQL（隔離 PG17、`common_ai_gateway_owner_held_ledger_pg_test.ts`）: REPORT に件数。
  - 準備と 2 回目の適用の拒否、カタログと ACL、SQL の契約、持ち主の道（別プロセス）、ABA（別プロセス）、許可の直前の回復と答えの喪失
  - **ABA**: A が claim の後で止まる → 回復＋forget_user → B が取り直す。
    - A の `reserve_held` は拒まれ、台帳には何も無い。送信 0。
    - B は 1 回だけ送って OK。
    - G6-11 の同じ場面では、「B が試行 1 を使い切られて UNKNOWN」だった。
- オフライン（`common_ai_gateway_owner_held_offline_test.ts`、G6-18 と同じ割り込み）: S2・S3・S5・S8b は **SAFE** になった。S1・S4・S6・S7・S8a も SAFE のまま。RPC が無い（404）・答えの喪失・失敗は、送信 0。設定の誤りは止まる。
- G6-18 の試験（legacy を明示）は、今の危ない動きを固定したまま残した。比較のため。

## 3. 残るもの

- 実の Supabase への適用（`20261017120000` → `20261017150000` → `20261020154536` → この候補）は、ユーザーの承認と Codex Sol（高）のレビューが要る。
- legacy の道は、古い PG / オフラインの試験が使っている。持ち主の確認つきの道に試験を移し終えたら、消すのが良い（別 TASK）。
- 混ぜた運用（legacy と owner-held の両方のプロセスが同時に動く）は、想定していない。
  - legacy が作った持ち主の無い予約は、owner-held の持ち主が使い回せる（そして自分の物として記録する）。
  - それでも、送信は 1 回だけ（台帳の鍵）。
- 本物の Supabase のロール・既定の権限・適用の道は NOT_VERIFIED（G6-15・G6-16 と同じ）。
