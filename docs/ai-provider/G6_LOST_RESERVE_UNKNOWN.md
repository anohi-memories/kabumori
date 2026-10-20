# G6-10 予約の答えが失われたときの、誤った「未送信」の防止（source-only）

- task_id: `common-ai-g6-lost-reserve-response-conservative-unknown-fix-20261020`（Issue #321、G6-10）
- 作成: 2026-10-20。**本番 NO_GO**。共有の SQL・provider の guard と `execute.ts`・Edge・Auth・相談機能は変えていない。
- 元の指摘: H3 #330 の REPORT（PR #372 への CHANGES_REQUIRED_P2）。
- これは**誤った答えを和らげる暫定の直し**。持ち主を証明する SQL の根本の解決（R1 root）ではない。
- 直した後は、Codex Sol（高）の限定の再レビューが必要。

## 1. 指摘（H3 の再現）

1. A が claim の後で止まる。
2. 復旧が閉じ、`forget_user` が行を消し、B が同じ操作を新しく claim する。
3. A が再開し、B の行に対して確認が `busy` を返す → A が送る（台帳は settled）。
4. B の予約は SQL の中で `ATTEMPT_FINALIZED` を返すが、**その答えが失われる**。
5. 共有の `execute.ts`（204〜211 行）は、予約の失敗をすべて `GUARD_UNAVAILABLE` にまとめる。そのため G6-09 の分岐を通らない。
6. B は「送っていない」（POLICY_DENIED・attempts 0・no_request・0 USD）を記録し、`LEDGER_UNAVAILABLE` と答える。頼み直すと `NOT_SENT`。
7. 行は complete になるので、復旧の候補（acquired だけ）からも外れ、控えは直らない。

## 2. 直したこと（`supabase/ai_gateway/gateway.ts` だけ）

台帳の拒否のうち「未送信」を証明しないものの一覧に、`GUARD_UNAVAILABLE` を加えた。

| 理由 | どこから | 扱い |
| --- | --- | --- |
| `ATTEMPT_FINALIZED` | 台帳（その試みは送られた・確定した・戻された） | UNKNOWN・記録なし（G6-09） |
| `SEND_NOT_CONFIRMED` | guard（`ATTEMPT_IN_FLIGHT`、送信の確定の失敗・拒否） | UNKNOWN・記録なし（G6-09） |
| **`GUARD_UNAVAILABLE`** | `execute.ts`（予約の RPC の失敗すべて: 届かない・5xx・時間切れ・commit 後の答えの喪失）と、guard（台帳の知らない理由） | **UNKNOWN・記録なし（G6-10）** |
| `CALL_LIMIT` / `COST_LIMIT` / `PER_CALL_LIMIT` / `NO_MATCHING_LIMIT` | 台帳が答えた（SQL は先に同じ試みの番号を調べ、無いときだけ予算を見る） | これまでどおり `QUOTA_EXCEEDED`（記録 `BUDGET_DENIED`） |
| `INVALID_AMOUNT` | 手元（台帳を呼ぶ前） | これまでどおり `LEDGER_UNAVAILABLE` |
| 自分の権限の再確認での取り消し | 自分 | これまでどおり `AUTH_REVOKED_BEFORE_SEND` |

UNKNOWN・記録なしの行は acquired のまま残り、復旧が**台帳から**控えを作って閉じる。

- 別のプロセスが送っていたなら RESULT_LOST / POSSIBLY_SENT。
- 予約が commit されていただけなら、期限切れで戻されて NOT_SENT_PROVEN。

台帳の費用と、別のプロセスが書いた控えは書き換えない。complete の行を閉じることもしない。

## 3. 失うもの（可用性）

台帳に**本当に届かなかった**場合（何も送っていない）も、これからは次のようになる。

- 答えは UNKNOWN（直す前は `LEDGER_UNAVAILABLE`）。
- 同じ操作を頼み直すと、復旧が閉じるまで IN_PROGRESS（直す前は `NOT_SENT`）。
- 相談機能では `CONSULT_NOT_SENT`（503）だったものが `CONSULT_AI_UNKNOWN`（502）になる。
- **新しい操作 ID なら、すぐに通る**（試験で確認）。
- 復旧が閉じると NOT_SENT_PROVEN として UNKNOWN の墓石になる（「送っていない」で閉じる RPC は無い。G6-06 から変わらない）。

予約の RPC の失敗を、呼び出し口では区別できない。届かなかったのか、commit 後に答えを失ったのかが分からないため。ここを細かく分けるには、共有の `execute.ts` と guard の変更（別の承認）が要る。

## 4. 確かめたこと

`common_ai_gateway_lost_reserve_pg_test.ts`（隔離 PG17、別プロセス）: **4 PASS**（うち 1 は準備）。**直す前は 3 件とも失敗**した。

| 試験 | 結果 |
| --- | --- |
| H3 の再現 | B の予約は SQL で動いた（記録で確認）。答えが失われても、B は UNKNOWN・控えなし・行は acquired。頼み直すと IN_PROGRESS。復旧は RESULT_LOST で閉じ、控えは 1 回・measured・実額で台帳と一致。使用の記録は 1 件のまま（A のもの）。その後は UNKNOWN。どの時点でも NOT_SENT にならない。**A の送信 1 は残る（root）** |
| 1 つのプロセス、予約は commit・答えは喪失 | UNKNOWN。台帳は reserved → 期限切れで released → NOT_SENT_PROVEN。送信 0 |
| 台帳に本当に届かない | UNKNOWN・行は acquired・台帳は空。同じ操作は IN_PROGRESS、新しい ID は OK。復旧は NOT_SENT_PROVEN。送信 0 |

ほかの試験:

- オフライン（`--deny-net`、8 ファイル）: **74 PASS**。G6-10 の回帰を 1 件足した。予約の失敗 4 通り（答えの喪失・届かない・500・知らない理由）は UNKNOWN、`COST_LIMIT` は QUOTA_EXCEEDED のまま。
- 答えが変わった既存の期待を更新した（すべて「予約に届かない → UNKNOWN」）。
  - オフライン 5 件: runtime・conformance 2・app-authority e2e・相談
  - PG 3 件: runtime・保存の場所・権限
- G6-07 / 08 / 09 の別プロセスの試験（7 / 8 / 5）、既存の隔離 PG はすべて PASS。G6-09 の試験は、R1 root（A の送信 1）と R2 のトレードオフ（行の作り直し）を引き続き確かめている。
- わざと壊した写し: **4/4 を検出**。
  - `GUARD_UNAVAILABLE` を外す
  - 予算の上限まで UNKNOWN にする（広げすぎ）
  - 控えを付けて答える
  - 自分の取り消しも UNKNOWN にする

## 5. 解決していないもの

1. **R1 root**: `busy` は持ち主の証明ではない。止まっていたプロセスの送信は、G6 のソースだけでは止められない。行を作らない持ち主の確認の RPC（`G6_R1_R2_CORRECTIVE.md` §5 の提案）が要る。
2. **R2**: 再確認の後の窓。確認が行を作ることによる、消去の後の行の作り直し。
3. 「未送信」を記録するほかの道（G6 のソースでは証明できないもの）。
   - 予約より前の手元の失敗（鍵が無いなど）
   - 予算の上限
   - 自分の取り消し

   ABA（行が消されて作り直された場合）では、別のプロセスが後から同じ番号で送れば、記録と台帳が食い違いうる。直すには root の RPC が要る。
4. NOT_VERIFIED:
   - 本物の G5 の RPC
   - Edge
   - 本物の PostgREST と Supabase（予約の失敗が実際にどれくらい起きるか、復旧までの時間）
   - 本物の AI
