# G6-17 R1 v1 の受け取り側の契約（オフライン）

- task_id: `common-ai-g6-r1-v1-authority-adapter-offline-compatibility-contract-20261025`（Issue #321、G6-17）
- 作成: 2026-10-25。**文書とオフラインの試験だけ**。G6 の本体のコード・migration・RPC・ACL は変えていない。本番・接続・merge は **NO_GO**。
- 対象: G5 の R1 v1（判定の RPC の 8 キーの答え）を、G6 の呼び出し口が今どう受け取るか。G5 の最終の IF（個人のワークスペース・session verdict・v2）は、まだ決まっていないので**ここでは固定しない**。
- 試験: `supabase/tests/common_ai_gateway_r1_v1_consumer_contract_test.ts`（8 件。うち 2 件は「分かっている穴」を今の動きのまま固定したもの）

根拠の印:
- **[確定]**: G6 の今のソースと、G5 の v1 の見本（`supabase/tests/fixtures/g5_verdict_v1_rpc_samples.json`。G5 PR #340 `80b90bd9` の `decide()` の出力）
- **[G5 提案]**: G5 の連絡（#321 6368141121、PR #485）
- **[未決]**: G5 の最終の IF の待ち
- **[NOT_VERIFIED]**: 本物の環境

## 1. R1 v1 の答え（G5 の RPC → G6 の transport → port）

| キー | v1 の決まり | G6 の扱い（ソース） | 印 |
|---|---|---|---|
| （全体） | 200 の本文は**ちょうど 8 キー**、時刻なし | 8 キーでない・時刻付き・JSON でない → 届かない扱い（`AUTH_UNAVAILABLE`）。`g5_rpc_transport.ts:78` | 確定 |
| `v` | `1` | 1 以外 → `AUTH_UNKNOWN`。`authority_port.ts:100` | 確定 |
| `decision` | allow / deny / pending / unknown | それ以外 → `AUTH_UNKNOWN`。deny → `AUTH_DENIED`、pending → `AUTH_PENDING`、unknown → `AUTH_UNKNOWN`。`authority_port.ts:102-104`、`gateway.ts:184-188` | 確定 |
| `reason` | 拒否のときの理由。allow は null | allow に理由が付いていれば、G5 の allow ではない → `AUTH_UNKNOWN`。`authority_port.ts:103,106` | 確定 |
| `scope` | `{app, feature, brand_slug}`（尋ねたものと同じ） | 1 つでも違えば `AUTH_UNKNOWN`（ワークスペースの不一致を含む）。`authority_port.ts:108-109` | 確定 |
| `subject` | `{kind:"user", user_id:<uuid>}`（G5 は system の答えを出さない） | uuid でない・余分なキー・system → `AUTH_UNKNOWN`。`authority_port.ts:124-140` | 確定 |
| `session` | `{state, ref}`。user には必須 | 形が違えば `AUTH_UNKNOWN`。`state` が active でなければ拒否（`AUTH_DENIED`）。`authority_port.ts:130-131` | 確定 |
| `owner_epoch` | ブランドがあるときは `g5oe:<owner epoch>:<lifecycle_version>`（どちらも 1 以上） | 無い・形が違う → `AUTH_UNKNOWN`。ブランドが無いのに付いている → `AUTH_UNKNOWN`。`authority_port.ts:132-134` | 確定 |
| `entitlements` | 有効なものだけ。`"<app>:<service>"` | 配列でない・重複・形が違う → `AUTH_UNKNOWN`。機能を開くもの（POSTONA の相談なら `postona:x_autopost`）が 1 つも無い → 拒否。`authority_port.ts:115-119,136` | 確定 |
| 時刻（transport が付ける） | allow は 60 秒、拒否はその場で失効 | 期限切れは拒否。60 秒を超える寿命は `AUTH_UNKNOWN`。`g5_rpc_transport.ts:79`、`authority_port.ts:110-114` | 確定 |
| 401 / 403 | JWT が受け付けられない | 拒否の答えを transport が作る（`AUTH_REQUIRED` → `AUTH_DENIED`）。`g5_rpc_transport.ts:69-75` | 確定 |
| 404・5xx・通信の失敗・3 秒を超える遅れ | — | 届かない → `AUTH_UNAVAILABLE`（何も確保・送信しない）。`gateway.ts:247-251` | 確定 |
| 再確認（送信の直前） | 同じ RPC に同じ JWT で | 世代（本人・session ref・owner epoch・すべての entitlement）か本人が違う、拒否、届かない → `AUTH_REVOKED_BEFORE_SEND`。確保は release し、送らない。`gateway.ts:341-352` | 確定 |
| 匿名（`is_anonymous`） | v1 の答えには無い | G6 は見分けられない（下の穴 1） | G5 提案（D1、PR #486 / #488） |
| 個人のワークスペース、session verdict、v2 | — | 固定しない | 未決 |
| 本物の RPC・本物の JWT・PostgREST | — | — | NOT_VERIFIED（RPC はまだ無い） |

## 2. G5 の理由と G6 の答え（G5 の v1 の見本 20 件）

| G5 | 例 | G6 の答え | 確保・送信・課金 |
|---|---|---|---|
| allow | allow consult / post_generation | 送る（1 回） | reserve・mark_sent・settle が 1 回ずつ |
| deny | SESSION_REVOKED、SESSION_EXPIRED、ACCOUNT_DELETION_IN_PROGRESS、ACCOUNT_LOCKED、ACCOUNT_NOT_FOUND、SERVICE_NOT_REGISTERED、SERVICE_SUSPENDED、SERVICE_NOT_ACTIVE、BRAND_ACCESS_DENIED、ROLE_NOT_ALLOWED、AUTH_REQUIRED | `AUTH_DENIED` | 0 |
| pending | SERVICE_PROVISIONING | `AUTH_PENDING` | 0 |
| unknown | WORKSPACE_OWNER_UNKNOWN、OWNER_EPOCH_UNAVAILABLE、FACTS_UNAVAILABLE | `AUTH_UNKNOWN` | 0 |
| deny（機能） | FEATURE_NOT_ENABLED | `AUTH_DENIED`（G5 に尋ねる前に止まる） | 0（G5 への問い合わせも 0） |

## 3. 場面ごとの結果（試験）

| 場面 | 期待 | 試験 | 結果 |
|---|---|---|---|
| G5 の見本 20 件 | 上の表のとおり。拒否は副作用 0 | 1 件目 | PASS |
| 壊れた・欠けた・知らない・改ざんされた答え（27 通り） | 読めない → `AUTH_UNAVAILABLE`、読めるが G5 の allow ではない → `AUTH_UNKNOWN`。副作用 0 | 2 件目 | PASS |
| 匿名（主体なし）・401・403・削除中・ロック・アカウントなし・session が active でない・entitlement なし / 別のサービス・member でない・admin・owner 不明（19 通り） | 拒否。副作用 0。JWT の形でない資格情報は G5 に送らない | 3 件目 | PASS |
| G5 に届かない・遅い（通信、404、500、502、遅延） | `AUTH_UNAVAILABLE`、副作用 0。同じ操作をもう一度送ると 1 回だけ送る | 4 件目 | PASS |
| 再確認で変わる（session の失効・期限、古い / 別の owner epoch、entitlement の削除、別の session ref、同じ JWT で別の人、401、500、通信、遅延、読めない、別のワークスペース。13 通り） | `AUTH_REVOKED_BEFORE_SEND`。確保は release、mark_sent・settle・送信は 0。再確認も同じ JWT。同じ操作の再試行は `NOT_SENT` を返し、2 回目の確保は無い | 5 件目 | PASS |
| 同じ操作の再試行、同時の重複、提供元の答えの喪失、別の人の同じ操作 ID | 二重に送らない・二重に課金しない。喪失は上限で `UNKNOWN` のまま保存し、再試行も `UNKNOWN`（再送しない）。別の人は別の呼び出し | 6 件目 | PASS |
| **穴 1**: 匿名の主体に G5 が allow を出した場合 | v1 には匿名の項目が無いので、G6 は送ってしまう（今の動きを固定）。匿名を「言おうとする」余分なキー付きの答えは、v1 ではないので拒否 | 7 件目 | **KNOWN GAP**（保証ではない。直すのは G5 の D1） |
| **穴 2**: 確保と送信の間に、行が消されて別のプロセスが同じキーを取った場合 | 呼び出し口の確認は今も `ai_calls_claim` の「busy」を見るので、気付かずに送る（今の動きを固定） | 8 件目 | **KNOWN GAP**（直すのは `ai_calls_claim_held` の組み込み。#409〜#431 の SQL はあるが、組み込みは NO_GO） |

わざと壊した写し（作業用の写しだけ）: G6 の本体の 8 か所を 1 つずつ弱めた写しで、この試験が 8 種類とも落ちることを確かめた。
- 対象: owner epoch の形、allow の理由、session の state、機能を開く entitlement、再確認の世代、401 / 403、ワークスペース、再確認の失敗
- 型の検査で落ちる書き方にならないように、型の通る書き換えで確かめた。

## 4. 既存の契約との照合（この TASK では新しく試験していないもの）

| 項目 | 今の保証 | どこで確かめているか |
|---|---|---|
| 同じ操作の冪等（call store の claim / complete） | 同じ鍵・同じ内容は 1 回。内容が違えば `OPERATION_REUSED` | `common_ai_gateway_app_authority_e2e_test.ts`、call store の PG の試験 |
| 台帳の reserve → mark_sent → settle / release、喪失・曖昧な答え | 曖昧な答えは `UNKNOWN` で何も記録しない（G6-10）。1 回の試行の鍵で 1 回だけ送る | `common_ai_gateway_lost_reserve_pg_test.ts`、`…_r1_r2_corrective_pg_test.ts` |
| owner-held（元のトークン＋完全な ID＋acquired）、ABA | SQL の候補では成り立つ。呼び出し口には未組み込み（穴 2） | `common_ai_gateway_owner_held_contract_pg_test.ts`（source=migration） |
| READ COMMITTED の前提 | RR / SERIALIZABLE の回復は P0001 で止まる（migration の候補） | `common_ai_gateway_owner_held_rc_guard_migration_pg_test.ts` |
| 回復・消去 | 台帳から作った監査で閉じる。消去の後に行を作り直さない | `common_ai_gateway_recovery_test.ts`、台帳の消去の PG の試験 |

この TASK では SQL を変えていないので、PG17 の試験は流し直していない（G6-15 の結果のまま）。

## 5. 残るもの（別の TASK）

- 穴 1: 匿名の扱いは G5 の D1（厳格な claim）で閉じる。v1 の形は変えない、と G5 は提案している。G6 は v1 の形を変えない（余分なキーは今どおり拒否）。
- 穴 2: `ai_calls_claim_held` の呼び出し口への組み込みは、別 TASK・別の承認（Opus5.5（高）＋ Codex Sol（高））。
- G5 の最終の IF（個人のワークスペース、session verdict、v2）が決まったら、この表と試験を、その IF に合わせて別 TASK で見直す。
- 本物の RPC・JWT・PostgREST は NOT_VERIFIED。
