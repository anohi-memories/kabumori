# G6-11 行を作らない持ち主の確認（owner-held）RPC の安全な契約と、隔離 PG での事前検証

- task_id: `common-ai-g6-claim-owner-held-noncreating-rpc-contract-preflight-20261020`（Issue #321、G6-11）
- 作成: 2026-10-20。**本番 NO_GO。共有の SQL・migration・RPC は作っていない**。
- 対象: R1 の根本。`ai_calls_claim` の `busy` は「元の持ち主のまま」の証明ではない（H2 #329、H3 #330）。
  - 復旧で閉じられ、`forget_user` で消され、別のプロセスが取り直すと、止まっていたプロセスの確認が通って送ってしまう。
  - 確認が行を作るので、消去の後に行が作り直される（R2 のトレードオフ）。

## 0. 証明したこと／提案だけのこと

| 区分 | 中身 |
| --- | --- |
| **提案（存在しない）** | `public.ai_calls_claim_held(p jsonb)` の SQL と契約（§1）。migration も、どの Supabase にも無い。`gateway.ts` も呼んでいない |
| **試験で証明（隔離 PG17 の使い捨ての DB で、試験だけが作った候補）** | §3 の 8 件。行を作らない、持ち主・ID・状態の完全一致、ロックの順番（実測）、ACL、別プロセスでの ABA で送信 0、消去の後に行を作り直さない、失敗は送信 0、4 者の同時実行 |
| **証明していない（NOT_VERIFIED）** | §5。本物の Supabase での所有者と既定の権限、PostgREST での公開、呼び出し口への組み込み（`gateway.ts` の変更）、本物の G5、可用性の実際 |

候補の SQL は `supabase/tests/common_ai_gateway_owner_held_contract_pg_test.ts` の `OWNER_HELD_CANDIDATE_SQL` に**試験専用として**置いた。試験の setup が、使い捨ての DB に作る（作る前に「無いこと」を確かめる）。

呼び出し口は変えていない。試験のプロセスの中だけで、送る直前の確認をこの候補に替えた組み立て（`ownerHeld` モード）を使った。

## 1. 契約（提案）

- 名前の例: `public.ai_calls_claim_held(p jsonb) returns jsonb`。既にある RPC ではない。
- 入力（すべて `ai_calls_claim` と同じ検査）:
  - `call_key`・`tenant_tag`・`fingerprint`・`application`・`feature`・`subject_kind`・`user_id`（人のとき）・`brand_ref`（あるとき）
  - `owner`: **最初の claim が返した claim_token**
- 答え:
  - `{held: true}` は、次の 3 つがすべて成り立つときだけ。
    - 行がある。
    - ID（tenant・fingerprint・application・feature・subject・user・brand）が完全に同じ。
    - `state = 'acquired'` で、`claim_token = owner`。
  - それ以外は `{held: false, reason}`。
    - `NOT_FOUND`: 無い。**作らない**
    - `IDENTITY_MISMATCH`: 別の ID の行
    - `NOT_ACQUIRED`: complete か abandoned
    - `OWNER_MISMATCH`: 別の持ち主
  - 入力が不正なら `AI_CALLS_INVALID_INPUT`（22023）。何も作らない。
- **書き込みは無い**（INSERT も UPDATE も無い）。試験で、行の `xmin` と中身が変わらないこと、行の数が増えないことを確かめた。
- ロック（`ai_calls_claim` と同じ順番）:
  1. 人の advisory lock を共有で（`forget_user` は排他で取る）。
  2. 呼び出しの番号の advisory lock（`ai_calls_claim` と `ai_calls_abandon` が取る）。
  3. 行を `FOR SHARE`（`ai_calls_complete` は `FOR UPDATE`）。
- 形:
  - `security definer`、`set search_path = ''`、`volatile`（advisory lock を取るため）。
  - 所有者は既存の `ai_calls_*` の RPC と同じ。
  - `revoke all ... from public, anon, authenticated, service_role` の後、`grant execute ... to service_role` だけ。
- 呼び出し口の使い方（未実装。次の工程）:
  - 最初の claim のトークンをメモリにだけ持つ。
  - 送る直前の確認を、`ai_calls_claim` の呼び直しから `ai_calls_claim_held(owner)` に替える。
  - `held: true` のときだけ続ける。それ以外・エラー・時間切れ・答えの喪失は、送らない（UNKNOWN、行は復旧へ）。
  - 試験のプロセスの `OwnerHeldStore` が、その形の見本。

### owner トークンの秘匿

- トークンは最初の claim の答えでだけ、取ったプロセスに返る。呼び出し口はメモリにだけ持ち、記録・ログ・控え・答えに入れない。
- 確認の RPC はトークンを返さない。
- 実行できるのは `service_role` だけ。`service_role` も表を直接は読めない（試験で確認）。
- `reason` は、行があること・別の持ち主であることを `service_role` に教える。気になるなら、全部を `NOT_HELD` 1 つにまとめてもよい（レビューで決める）。

## 2. 送る直前の確認が「持ち主のまま」を保つ理由

順番は、予約 → **held の確認** → 権限の再確認 → 送信の確定（G6-09 の順番のまま）。

- 確認の時点で、この試みの予約は台帳で開いている。そのため次の 2 つはできない。
  - `ai_calls_abandon`: 開いた試みがあれば `LEDGER_NOT_FINAL`。
  - `ai_calls_forget_user`: acquired の行があれば `CALLS_IN_FLIGHT`。
- よって `held: true` の後、送信の確定までの間に、行が閉じられたり、消されて取り直されたりすることは無い。
- 予約が期限切れで戻された場合は、送信の確定が `may_send: false` を返し、送らない。
- 閉じる操作・消す操作・持ち主の complete と同時に動いた場合、確認は相手の commit を待ち、その結果を読む（§3 で実測）。

## 3. 試験（`common_ai_gateway_owner_held_contract_pg_test.ts`、隔離 PG17、別プロセス）

**8 PASS**（うち 1 は準備）。3 回続けて実行し、毎回 PASS。

| 試験 | 確かめたこと |
| --- | --- |
| 準備 | 作る前に関数が無いこと。試験用の候補を作る |
| ACL と definer | 所有者 = `ai_calls_claim` と同じ。`security definer`・`search_path=""`・volatile。実行できるのは `service_role:EXECUTE` だけ（カタログで確認）。anon・authenticated は不可（anon は本体が動く前に拒否）。`service_role` は表を直接読めない。`authenticated` の仲間のロールは不可、`service_role` の仲間のロールは可（運用の決まり: `service_role` を他に付けない）。**既定の権限の罠**: revoke しないと anon が実行できる（この DB も Supabase と同じく、public の新しい関数を anon / authenticated に付ける）。後の migration が authenticated に付けると、同じカタログの確認で見つかる |
| 契約 | 完全一致のときだけ held。別の持ち主・tenant・fingerprint・app・feature・人・ブランド・ブランドなし・system・無い（10 通り）はそれぞれの理由で false。無い行は作らない。行は書き換えない（同じ `xmin`）。不正な入力 4 通りは拒否。持ち主が complete した行は `NOT_ACQUIRED` |
| ロックの順番（実測） | 進行中の abandon・`forget_user`・持ち主の complete が 2 秒ロックを持つ間、確認は 1,000 ms 以上待つ。その後は `NOT_ACQUIRED` / `NOT_FOUND`（作り直さない）/ `NOT_ACQUIRED` を返す |
| **R1 root（別プロセス）** | A が止まる → 復旧 → `forget_user`（前提を破った場合）→ B が取り直す（トークンが違う）→ A が再開。A の確認は `OWNER_MISMATCH` で、**送信 0**（今の作る確認では送信 1。G6-09 の試験）。B は試み 1 が使用済みで UNKNOWN（可用性）。復旧は NOT_SENT_PROVEN で、控えは台帳と一致 |
| 持ち主の通り道 | 1 回で送信 1。RPC の順番は `ai_calls_claim#1 → ai_calls_claim_held#1 → ai_calls_complete#1`（claim の呼び直しは無い）。確認の答えの喪失、行のロックで時間切れ（1.5 秒）→ どちらも送信 0・予約を戻す・行は acquired |
| **R2 の消去（別プロセス）** | 前提を守った場合（権限を取り消してから `forget_user`）。止まっていたプロセスの確認は `NOT_FOUND` で、送信 0。**消した人の行を作り直さない**（今の作る確認では作り直す）。台帳の予約（`user_id` 付き、released）は、どちらの順番でも残る（台帳の消去は別） |
| 4 者の同時実行（8 回） | 止まっていた元・再起動・2 つの復旧。送信は 1 以下、開いたままの行は 0、「送信 1 ⇔ 元が OK」、控えは台帳と一致。結果は 3〜4 通り |

わざと壊した候補（作業用の写しだけ）: **9 種類中 8 種類を検出**。

- 行を作る
- 持ち主を比べない
- 状態を見ない
- ID を比べない
- ロックを全部外す
- revoke を消す
- `security invoker` にする
- `search_path` を外す

検出しなかった 1 種類（人のロックを外す）は、実質同じ動き。

- `forget_user` の削除は行のロックを取るので、確認の `FOR SHARE` がそこで待ち、commit の後に行が無いことを読む。
- 行を作らない確認では、人のロックは正しさに必要ない。
- `ai_calls_claim` と同じ順番に揃えるために残すか、`forget_user` との待ち合いを減らすために外すかは、レビューで決める。

## 4. 持ち主・承認・順番

| もの | 持ち主 | 要るもの |
| --- | --- | --- |
| `ai_calls_claim_held` の migration（§1） | G6（`ai_calls` の作成者）。ただし共有の DB | 明示の承認と Codex Sol（高）の限定レビュー。隔離 PG でのこの試験の再実行、本物の Supabase での所有者と既定の権限の確認（§5） |
| 呼び出し口への組み込み（確認を held に替える） | G6（`gateway.ts`・`ai_calls_store.ts`） | migration の後の別の TASK。Sol の再レビュー |
| 消去の順番: 権限の取り消し → 送信中のものを待ち切る（不明の確定と復旧）→ `forget_user`。再び認める場合や、同じ ID の再利用の決まり | G5（アカウント・lifecycle）と運用 | G5 との合意。held は「止まっていたプロセスの送信」と「行の作り直し」を止めるが、台帳の予約に残る `user_id` は台帳の消去（`ai_ledger_erase_user`）の仕事 |
| 予約の失敗の細かい区別（G6-10 の可用性） | 共有の `execute.ts` と guard | 別の承認 |

## 5. 証明していないこと（NOT_VERIFIED）と、残るもの

- 本物の Supabase:
  - 関数の所有者（postgres か supabase_admin か）
  - 既定の権限の実際
  - PostgREST の公開（public の関数は RPC として出る。`service_role` だけに絞ることは、この試験の DB でだけ確認した）
  - 後の migration での権限の戻り
- 呼び出し口への組み込み。今回は試験の中の見本の `OwnerHeldStore` だけで、`gateway.ts` は変えていない。
- 可用性:
  - ABA の後、正しい新しい持ち主（B）も、試み 1 が使用済みのため送れない（UNKNOWN → 復旧）。
  - 試みごとの RPC の数は今と同じ（claim の呼び直しが held に替わるだけ）。本物の時間は未測定。
- 残る窓: 権限の再確認の後の窓（R2）は変わらない。
- G6-06〜10 から変わらないもの:
  - NOT_SENT_PROVEN でも「不明」でしか閉じられない
  - 呼んだときの決まりの版が残らない
  - 記録できた行の控えと台帳のずれを読めない
  - 予約より前の手元の失敗・予算の上限・自分の取り消しでの「未送信」の記録
    - held を入れれば、ABA の後に止まっていたプロセスが送れなくなるので、このずれも起きにくくなる（未検証）。

## 6. Sol（高）に見てほしいこと（実装の前）

1. §1 の契約と §2 の理由（予約が開いている間は閉じも消しもできない）。READ COMMITTED と `FOR SHARE` で見落としは無いか。
2. 人のロックを残すか（§3 の実質同じ動き）。
3. `reason` を細かく返すか、`NOT_HELD` 1 つにまとめるか（§1 の秘匿）。
4. ACL（`service_role` だけ、`service_role` を他のロールに付けない運用）と、本物の Supabase での所有者・既定の権限の確かめ方。
5. 可用性（ABA の後に B も送れない）を受け入れるか。
