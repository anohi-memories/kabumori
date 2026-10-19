# F6 共通AI呼出し口 — GAP-1〜3 の修正（オフライン）

- 作成: 2026-10-19（F6 / 共通AI基盤）。**source-only・本番 NO_GO**。
- 指示: POSTONA総合指令室 Issue #269 comment 6260001714（G6/F6 分）、共通AI基盤のちゃの修正の指示。
- 正式な TASK は**未登録**。main への管理 commit が Vercel の本番デプロイを起こす問題（Issue #286）がまだ解消されていないため、main の F6 TASK・ACTIVE・archive は更新していない。結果はこのブランチと Draft PR だけに置いた。
- 前提: PR #289 の適合の確認（`F6_GATEWAY_PROVIDER_LEDGER_CALLSTORE_CONFORMANCE.md` の §4）。

## 0. まとめ

PR #289 で見つけた GAP-1〜3 を、**F6 が持つ参照の呼び出し口**（`supabase/tests/common_ai_cross_app_gateway_reference.ts`、deploy しない）の中だけで直した。

変えていないもの:
- 共有の provider、台帳、`ai_calls` の SQL、H5 bridge
- POSTONA の相談の本体、G5 の認可まわり

GAP-4（台帳が費用の正本）はそのまま守り、回帰のテストで確かめている。

| GAP | 前の動き | 直した後 | 送信・費用 |
| --- | --- | --- | --- |
| 1 | 2 回目以降の試みの前に取り消されると `QUOTA_EXCEEDED` | **`AUTH_REVOKED_BEFORE_SEND`**。保存は `POLICY_DENIED`、再送は `NOT_SENT` | 取り消しの後の送信は 0。予約を返す。それより前の試みの分だけ |
| 2 | 台帳の障害が確定の `QUOTA_EXCEEDED` | **`LEDGER_UNAVAILABLE`**。保存は `POLICY_DENIED`、再送は `NOT_SENT`。新しい番号なら復旧の後に通る | 送信 0 |
| 3 | 控え（8 項目）を `ai_calls` が拒否 → 送信 1 回の後に `UNKNOWN`、処理中のまま残る | 呼び出し口が**保存の場所の 9 項目**に変えて保存する。再送ではすべての項目を確かめてから戻す | 変わらない（1 回の送信が正しく記録される） |

## 1. 変えたこと（参照の呼び出し口）

1. **結果の分け方の順番**（GAP-1・GAP-2）
   1. 成功 → アプリの検査
   2. 費用が上限額（送ったかもしれない）→ `UNKNOWN`。何があっても最優先。
   3. 取り消された（`revoked`）→ 保存は `POLICY_DENIED`、最初の答えは `AUTH_REVOKED_BEFORE_SEND`。前の試みの費用の基準が「実額」でも同じ扱いにする（これが GAP-1 の原因だった）。
   4. 台帳が**枠**で断った（`CALL_LIMIT` / `COST_LIMIT` / `PER_CALL_LIMIT` / `NO_MATCHING_LIMIT`）→ `BUDGET_DENIED` / `QUOTA_EXCEEDED`。
   5. 台帳の**その他の拒否・障害**（`GUARD_UNAVAILABLE` / `SEND_NOT_CONFIRMED` / `ATTEMPT_FINALIZED` / `INVALID_AMOUNT` / 知らない理由）→ 保存は `POLICY_DENIED`、最初の答えは `LEDGER_UNAVAILABLE`。知らない理由も「枠」とは言わない（安全側）。
   6. JSON でない・形が違う → `OUTPUT_REJECTED`。送信なしのその他 → `POLICY_DENIED`。それ以外 → `PROVIDER_FAILED`。
   - 保存の場所が受け付けるコードは 7 種類だけで、SQL は変えない。そのため、取り消しと台帳の障害はどちらも「送っていない」の `POLICY_DENIED` で保存する。理由は最初の答えだけが知っていて、再送では `NOT_SENT`（何も送っていない）と答える。
   - 同じ番号で送り直さないので、二重の請求は起きない。台帳が直った後にやり直すときは、アプリが**新しい番号**を使う。
2. **保存の控え**（GAP-3）
   - `toStoreAudit` を追加: 8 項目の控えを、`callId`、`tenantTag`、`feature`＝`app:feature`、`role`＝`logicalRole`、`model`、`policyVersion`＝`revision`、`attempts`、`estimatedCostUsd`、`costBasis` の 9 項目に変える。
   - `fromStoreAudit` を追加: 保存の控えを戻すときに、次をすべて確かめる。
     - キーがちょうど 9 つあること
     - 番号・tenant・feature・role・model・版が、この呼び出しと今の決まりに合うこと
     - 試みの数が 0〜`maxAttempts` に収まり、「0 回」と「送信なし」が一致すること
     - 費用が 0 以上であること
     - 保存の形のキーが `ok`・`data`・`audit`、または `ok`・`code`・`audit` で、コードが保存用の 6 種類であること

     ひとつでも合わなければ `UNKNOWN`（送り直さない）。
   - claim には `storeFeature`（`app:feature`）を渡す。行の feature と控えの feature が同じ所から決まる。
   - `FeaturePolicy.revision` を追加した（必須、`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`）。`logicalRole` も保存の場所の形（`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$`）でなければ「決まりなし」として断る。
   - 版と role を操作の中身（fingerprint）に入れた。版が変わった後の同じ番号は `OPERATION_REUSED` になり、古い答えを返すことも送り直すこともしない。
3. 変えていないこと: 呼ぶ順番、送る直前の再確認、番号の作り方、主体とブランドの分け方、アプリへの答えの控え（8 項目）の形。

## 2. テスト（すべて偽の部品か、隔離した DB）

| ファイル | 数 | 主な確認 |
| --- | --- | --- |
| `common_ai_cross_app_gateway_contract_test.ts`（PR #284。決まりに `revision` を足しただけ） | 11 PASS | 前の契約が崩れていないこと |
| `common_ai_gateway_conformance_test.ts`（`--deny-net`） | 12 PASS | 両方の AI × 14 の場面。GAP-1（取り消し 3 通り × 両方の AI、上限額の優先、2 回目の枠）。GAP-2（台帳の障害 7 通り × 両方の AI、復旧の後、枠の理由 4 つ、2 回目の台帳の障害）。GAP-3（9 項目、書き換えられた控え 12 通り、版の変更、版や role の無い決まり）。GAP-4（精算の失敗） |
| `common_ai_gateway_callstore_pg_test.ts` ＋ `_run.sh`（隔離した PG17、本物の台帳と `ai_calls` の SQL） | 14 PASS | GAP-3（両方の AI で `ai_calls` がそのまま受け付ける、DB 上で書き換えた控え、版の変更）。GAP-1（台帳が「1: settled / 2: released」）。GAP-2（reserve・mark_sent に届かない → 予約なし・または返す、復旧の後）。mark_sent が台帳で確定したのに答えが失われた場合。同時・中身違い・別の人やブランド・日の上限・504・記録の喪失と復旧・コードの対応 |

- わざと壊した写し: **42/42 を検出**（作業用のフォルダだけ）。内訳は次のとおり。
  - 共有の provider: 8
  - 参照の呼び出し口: 6
  - GAP-1: 3、GAP-2: 6、GAP-3: 15
  - `ai_calls` の SQL: 4
- 意味が同じため除いた写しは 2 つ。
  - 保存のコードの確認を外す写し：知らないコードは、確認を外しても `publicCode` で `UNKNOWN` になる。
  - 取り消しを上限額より先に見る写し：上限額になった試みの後に、次の試みは起きない。

## 3. 新しく分かったこと（台帳が多めに数える側。GAP-4 と同じ扱い）

mark_sent が台帳では確定した（`sent`）のに、その答えが失われた場合:
- AI には何も送らない。答えは `LEDGER_UNAVAILABLE` で、保存は `POLICY_DENIED`（送信なし）。
- 台帳は `sent` のまま残る（release は台帳が受け付けない）。台帳の復旧が上限額で確定させるので、**台帳は実際より多く数えることはあっても、少なく数えることはない**。
- 控え（送信なし・0）と台帳（上限額）はずれる。費用は必ず台帳から読む（GAP-4 と同じ）。

隔離 PG のテストで、このとおりになることを確かめた。共有の台帳は変えない。

## 4. 未確認（NOT_VERIFIED）と残件

- 本物の Supabase / PostgREST / managed、本番の台帳と枠の行、`ai_calls` の本番への適用、本物の OpenAI / Anthropic、G5 の本物の `verdict` / `recheck`、台帳と `ai_calls` の復旧の Cron。
- main の正本の更新（前回の TASK の archive、新しい F6 TASK の登録、Report）は**していない**。Vercel のゲートが解除され、main への管理 commit が許可されたら、次の順で行う。
  1. 前の TASK の archive を作り、HISTORY_INDEX に追加する。
  2. 新しい F6 TASK を登録して読み戻す。
  3. この PR の内容を Report に書く。
- 共有のコードを変える必要は無かった。案 B（`ai_calls` に claim を消す RPC を足す・控えの形を 2 つ受け付ける）は採らない。
