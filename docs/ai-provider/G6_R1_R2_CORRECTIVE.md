# G6-09 R1 の誤った「未送信」の答えの安全側への直しと、R2 の窓の縮小（source-only）

- task_id: `common-ai-g6-r1-conservative-response-r2-order-source-fix-20261020`（Issue #321、G6-09）
- 作成: 2026-10-20。**本番 NO_GO**。共有の SQL・provider・Edge・Auth・相談機能は変えていない。
- 元の指摘: H2 #329 の REPORT（PR #357 / #363 への CHANGES_REQUIRED_P2）。
- これは**誤った答えを和らげる暫定の直し**で、持ち主を証明できない SQL の根本の解決ではない（§5）。
- 直した後は、Codex Sol（高）の限定の再レビューが必要。

## 1. 直したこと（`supabase/ai_gateway/gateway.ts` だけ）

### R1: 「他の誰かが送ったかもしれない」台帳の拒否を「未送信」と言わない

台帳が試みを拒んだとき、これまでは「送っていない」（`POLICY_DENIED`・`attempts: 0`・`no_request`・0 USD）と記録していた。その人には `LEDGER_UNAVAILABLE`、頼み直すと `NOT_SENT` と答えていた。

H2 の再現では、別のプロセスが同じ番号で送り、実額が台帳にあるのに、そう答えていた。

これからは、拒否の理由が次のどちらかなら、**何も記録せずに UNKNOWN**（控えなし）を返す。行は acquired のまま残り、復旧が**台帳から**控えを作って閉じる。

| 台帳の理由（呼び出し口が受け取るもの） | 中身 | 送った可能性 |
| --- | --- | --- |
| `ATTEMPT_FINALIZED` | その試みは既に送られた・確定した・戻された | ある（別のプロセスが送り、確定した） |
| `SEND_NOT_CONFIRMED` | 共有の guard が、次の 3 つを**1 つにまとめた**もの | ある |

`SEND_NOT_CONFIRMED` にまとめられている 3 つ（`supabase/functions/_shared/ai_provider/ledger_guard.ts` の 66〜68 行）:

- 予約での `ATTEMPT_IN_FLIGHT`（別のプロセスが今送っている）
- 送信の確定の失敗・答えの喪失（`sent` で commit 済みのことがある）
- 送信の確定の拒否

呼び出し口では、この 3 つを区別できない。共有の guard は変えられないので、全部を安全側（送った可能性あり）に扱う。

次の場合は、これまでどおり。

- 自分の権限の再確認で止めた場合: `AUTH_REVOKED_BEFORE_SEND`。
- 予約の RPC に届かない・知らない理由の場合（許可が一度も出ていない）: `LEDGER_UNAVAILABLE` / `NOT_SENT`。**G6-10 で変更**: 予約の答えの喪失がこれと区別できない（H3 の指摘）ため、UNKNOWN・記録なしにした。`G6_LOST_RESERVE_UNKNOWN.md` を参照。

| 台帳の答え | 直す前 | 直した後 |
| --- | --- | --- |
| 予約に届かない（`GUARD_UNAVAILABLE`） | LEDGER_UNAVAILABLE・記録 POLICY_DENIED・頼み直すと NOT_SENT | G6-09 では同じ。**G6-10 で UNKNOWN・記録なし**（答えの喪失を含むため） |
| 予約: `ATTEMPT_FINALIZED` | LEDGER_UNAVAILABLE・記録 POLICY_DENIED / `no_request` | **UNKNOWN・記録なし・頼み直すと IN_PROGRESS → 復旧の後 UNKNOWN** |
| 予約: `ATTEMPT_IN_FLIGHT` | 同上 | 同上 |
| 送信の確定: 届かない・答えの喪失（commit 済みもある）・拒否 | LEDGER_UNAVAILABLE・記録 POLICY_DENIED / `no_request`（台帳が `sent` でも） | 同上（台帳の `sent` は、復旧が上限額の不明として控えに書く） |

相談機能での見え方: `CONSULT_NOT_SENT`（503、新しい Key でやり直せる）だったものが `CONSULT_AI_UNKNOWN`（502、その Key では再送しない）になる。新しい Key でやり直すことは、これまでどおりできる。

失うもの: 該当する操作は、復旧が閉じるまで `IN_PROGRESS` になる（決まりの最長の実行時間か SQL の決まり（300〜1800 秒）の長い方まで）。

### R2: 権限の再確認を、送信の確定の直前に置く

順番は、予約 → claim の確認 → **権限の再確認** → 送信の確定 → 送信。

- claim の確認は、これまでどおり予約の後（PR #357 の隙間の無さはそのまま。G6-08 の資料 §1）。
- 再確認と送信の確定の間に、ほかの await は無い。
- 再確認より前の変化（持ち主の世代・ブランドの譲渡・セッションの取り消し）は、送信 0 で止まる。
- 再確認の後の変化は見えない（窓は送信の確定と送信）。**取り消しの完全な保証は主張しない**。厳密に原子的にするには、G5 と台帳の別の設計と承認が要る。

## 2. R2 のトレードオフ（実測）

順番を入れ替えたので、claim の確認が権限の再確認より先に動く。

`forget_user` の前提（先に権限を取り消す）を守った場合でも、止まっていたプロセスが再開すると、次のようになる。

- 確認が**消えた行を作り直す**（`ai_calls_claim` は行が無いと作る）。送信は 0。
- 削除した人の `user_id` を持つ acquired の行が残る。
- 復旧が NOT_SENT_PROVEN で閉じ、`forget_user` をもう一度動かすと消える（試験で確認）。

台帳の予約の行（`user_id` を持つ）は、直す前の順番でも再確認より前に作られていた。なので、これは今回の入れ替えで新しく出たものではない。

入れ替えを選ぶか戻すかは、レビューで決めてほしい。

- 代わりの案: 「再確認 → 確認 → 再確認 → 送信の確定」。G5 への問い合わせが試みごとに 1 回増える。
- 根本の解決: §5 の、行を作らない持ち主の確認の RPC。

## 3. system の行について（H2 の補正を反映）

今の呼び出し口は、system の呼び出しにブランドを持たせない（`brand_ref` は null）。そのため `ai_calls_forget_system_brand` は今の呼び出し口の行に届かない（試験で、削除 0 件を確認）。

G6-08 の資料にあった「system の行でも同じことが起きうる」は、一般の SQL の仮説としてのみ残す。ブランドを付けて system の行を作る別のプロデューサーがあるかどうかは、NOT_VERIFIED。

## 4. 確かめたこと

| 試験 | 結果 |
| --- | --- |
| `common_ai_gateway_r1_r2_corrective_pg_test.ts`（隔離 PG17、別プロセス） | **5 PASS**（うち 1 は準備）。詳細は下の表 |
| `common_ai_gateway_fence_review_pg_test.ts`（G6-08） | 8 PASS。変わった 3 件はこのファイルへ移した。「busy は持ち主の証明ではない」は、両方が UNKNOWN、復旧が NOT_SENT_PROVEN で閉じる形に更新 |
| `common_ai_gateway_restart_race_pg_test.ts`（G6-07） | 7 PASS |
| オフライン（`--deny-net`） | 8 ファイル 73 PASS（直す前は 71）。`common_ai_gateway_runtime_test.ts` に 2 件を追加: R1（`ATTEMPT_FINALIZED` / `ATTEMPT_IN_FLIGHT`・2 回目の試み）と R2（再確認は確認の後・送信の確定の前） |
| 既存の隔離 PG | 実行用コード 6・保存の場所 14・相談 4・権限 5・復旧 6・相談の seam、すべて PASS |

`common_ai_gateway_r1_r2_corrective_pg_test.ts` の中身:

| 試験 | 確かめたこと |
| --- | --- |
| R1（H2 の再現） | 新しい行の claim のトークンは A のものと違う。A は 1 回送る（ROOT は未解決）。B は UNKNOWN・控えなし・行は acquired・頼み直すと IN_PROGRESS。復旧は RESULT_LOST、控えは 1 回・measured・実額で台帳と一致。頼み直すと UNKNOWN。どの時点でも NOT_SENT にならない |
| system の行 | ブランドは null、`forget_system_brand` は 0 件 |
| R2 の境界 | 確認の後・再確認の前に譲渡すると AUTH_REVOKED_BEFORE_SEND・送信 0。再確認の後だと OK・送信 1（残る窓） |
| R2 のトレードオフ | 上の §2 |

変えた既存の期待（どれも今回の直しのとおり）:

- 再確認での取り消しの RPC の順番（`claim, reserve, claim, release, complete`）: 2 か所
- GAP-2: 予約の `ATTEMPT_FINALIZED` / `ATTEMPT_IN_FLIGHT`、送信の確定の失敗・拒否 → UNKNOWN・記録なし（オフライン 2、PG 3 か所）

わざと壊した写し（作業用の写しだけ）: **5/5 を検出**。

- R1 の分岐を消す
- `ATTEMPT_FINALIZED` だけにする
- 権限の取り消しも UNKNOWN にする
- 控えを付けて答える
- R2 の順番を戻す

## 5. 根本の解決（提案だけ。SQL・migration・RPC・権限は作っていない）

`ai_calls_claim` を呼び直して `busy` を持ち主の証明とみなすことが、R1 の根本。代わりに、**読み取りだけで行を作らない** RPC の契約を提案する。

- 名前の例: `public.ai_calls_claim_held(p jsonb)`。既にある RPC ではない。
- 入力: `call_key`、`tenant_tag`、`fingerprint`、`owner`（最初の claim が返したトークン）。
- 答え: `{held: true}` を返すのは、次の 3 つがすべて成り立つときだけ。
  - 行がある。
  - `state = 'acquired'`。
  - ID（tenant / fingerprint / application / feature / subject / user）が同じで、`claim_token = owner`。
- それ以外は `{held: false, reason: NOT_FOUND | NOT_ACQUIRED | IDENTITY | OWNER}`。**行は決して作らない**。
- ロック: `ai_calls_claim` / `ai_calls_abandon` と同じ呼び出しの番号の advisory lock を取り、abandon と並ぶ（今の隙間の無さを保つ）。書き込みは無い。
- 形: `security definer`、`search_path = ''`、実行の権限は `service_role` だけ。anon / authenticated / public には付けない。
- 呼び出し口の使い方: 確認を `claim_held(owner)` に替え、`held: true` のときだけ続ける。
  - R1 の根本（止まっていたプロセスの送信）が止まる。
  - §2 の行の作り直しも無くなる。
- 要るもの: 明示の承認、Codex Sol（高）のレビュー、隔離 PG での ACL と並行の証明。持ち主は G6（`ai_calls` の作成者）だが、共有の SQL。

運用でできること（G5 / 運用者）: 権限の取り消し → 送信中のものを待ち切る（不明の確定と復旧）→ `forget_user`、の順を守る。ただし、止まったプロセスや同じ ID の再利用まで、運用の順番だけで解決したとは言えない。既に AI へ送った中身は取り消せない。

## 6. NOT_VERIFIED

- 本物の G5 の RPC
- Edge
- 本物の PostgREST と Supabase（確認の RPC の時間と負荷。再確認の窓の長さもここで決まる）
- 本物の AI
- ブランドを付けた system の行を作る別のプロデューサー

## 7. 再レビューで見てほしいこと

1. `SEND_NOT_CONFIRMED` を全部「送った可能性あり」にする判断（共有の guard が理由をまとめているため）と、その代わりに失うもの（IN_PROGRESS の時間、相談の答えの変化）。
2. 何も記録しないで復旧に任せること。復旧が台帳から控えを作る（RESULT_LOST / POSSIBLY_SENT / NOT_SENT_PROVEN）ことで、控えと台帳のずれが無くなるか。
3. R2 の入れ替えと §2 のトレードオフ。入れ替えを残すか、戻すか、再確認を 2 回にするか。
4. §5 の SQL の契約の案。
