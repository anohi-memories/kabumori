# G3｜X 予約の利用者 RPC：失効したセッションの負例 QA（2026-10-23、Issue #318 TASK 25/50）

- task_id: `postona-g3-x-reservation-revoked-session-offline-negative-qa-20261023`
- 返却先: POSTONA G3担当ちゃ（Issue #318）／完了コード: K3
- 判定: **隔離の負例 QA と docs だけ。直していない。**
  - 現行の挙動（誤って通るもの）をそのまま記録し、望ましい契約とのずれを名前で固定した。現行の失敗を PASS に書き換えていない。
  - 製品 SQL・RPC・Auth・Edge、PR #392・#463、G5・G4 のファイルは変えていない。本番は NO_GO。
- 変更したファイル（G3 の新しいパスだけ）:
  - `supabase/tests/g3_x_reservation_revoked_session_qa/qa_run.sh`（ランナー）
  - `supabase/tests/g3_x_reservation_revoked_session_qa/qa_matrix.sql`（場面と入口の行列）
  - `supabase/tests/g3_x_reservation_revoked_session_qa/gate_selfcheck_model_fix.sql`（**テスト用の模型の修正**。候補ではない。ゲートの自己検査だけに使う）
  - この文書

## 1. 対象の入口（関数のシグネチャと権限。実測）
- X の候補 001〜006 は、PR #392 の head `f34aab97` を `git show` で読んで使った（変えていない）。
- `postona_resv_api` が EXECUTE できる `postona_x_resv` の関数は、ちょうど次の 10 個。anon・authenticated・service_role は 0 個。

| 関数 | 呼ぶ人 | 本人の決め方 | DB でのセッションの確認 |
|---|---|---|---|
| `list_reservations(text)` | 利用者 | `caller()` = `auth.uid()` | 無し（サービスの状態だけ: G5 の `service_state_refusal(user_id)`） |
| `get_reservation(uuid)` | 利用者 | 同上 | 無し（同上） |
| `reschedule(uuid, integer, timestamptz)` | 利用者 | 同上（`lock_own`） | 無し（同上） |
| `reconfirm(uuid, integer, text)` | 利用者 | 同上 | 無し（同上） |
| `cancel(uuid, integer)` | 利用者 | 同上 | 無し（同上） |
| `create_batch(text, uuid, integer, text, jsonb, jsonb)` | 利用者 | 同上 | 無し（同上） |
| `post_now_begin(text, uuid, text, text)` | 利用者（単発投稿の開始） | 同上 | **有り**: `single_post_fence` → G5 の P3b `account_lifecycle_assert_active_service_write`（sub・session_id・role を見る）。**ただし `is_anonymous` を見ない** |
| `post_now_readback(uuid)` | 利用者 | 同上（本人の行だけ） | 無し（サービスの状態も見ない） |
| `post_now_preflight(uuid, uuid)`・`post_now_record(uuid, uuid, text, text, text, text)` | Edge の内部（同じ要求の続き。lease の token に縛られる） | — | この QA の対象外（lease を持つ同じ要求の中の段） |

- G5 の `session_verdict()`（PR #408 の `003`）は**未適用で、どこにもつながっていない**。

## 2. 場面（偽のデータだけ）
| 場面 | 作り方 |
|---|---|
| S00 live | 本人の生きているセッション |
| S01 signed_out | セッションの行を消す |
| S02 expired | `not_after` を過去にする |
| S03 foreign_session | `sub` は本人、`session_id` は他人（199）の生きているもの |
| S04 unknown_session | ランダムな `session_id` |
| S05 no_session_id | claims に `session_id` が無い |
| S06 anonymous | 生きているセッション ＋ `is_anonymous: true` |
| S07 refreshed | 更新したトークン（`sub`・`session_id` は同じなので、claims も同じ） |
| S08 new_session_after_signout | 古いセッションを消し、新しいセッションで呼ぶ |
| S09 no_claims | claims 無し |
| S10 service_ended | x_autopost を終了する（**TODO**: 期待はユーザー・G1 の判断待ち） |
| S11 user_switch | 他人（199）の生きているセッションで本人の行を呼ぶ。存在しない ID の答えと比べる |
| S12 user_deleted | `auth.users` の行を消す（記録だけ） |
| 対象外 | BAN 中（fixture に `banned_until` が無く、模型にしていない）、owner の交代（ユーザー・G1 の判断待ち） |

- 各場面は自分の人物を使う。セッションが生きているうちに、予約を 2 つと単発投稿を 1 つ作る。その後で場面の状態にして、8 つの入口を順に呼ぶ（読み取り → reconfirm → reschedule → cancel → create_batch → post_now_begin）。

## 3. 実測の結果（使い捨ての PG17.11。最終の版で 2 回）
- `qa_run.sh` → `G3_X_RESERVATION_REVOKED_SESSION_QA_PASS`
  - 関数の一覧: PASS
  - 現行の 95 のセルが、固定した答えと一致
  - 望ましい契約とのずれは 43 個で、名前で固定（下）
- 公開は 0（published・provider_post_id は 0 件）。

| 場面 | list・get・readback・reconfirm・reschedule・cancel・create_batch | post_now_begin |
|---|---|---|
| S00 live・S07 refreshed・S08 new session | 全部 ok | ok（claimed） |
| **S01 signed_out・S02 expired・S03 foreign・S04 unknown・S05 no session_id** | **全部 ok（誤って通る）**。予約の読み取り、日時の変更、取消、新しい予約の作成まで | `POSTONA_RESV_AUTH_REQUIRED`（止まる） |
| **S06 anonymous** | **全部 ok（誤って通る）** | **ok（誤って通る）**: G5 の P3b が `is_anonymous` を読まない |
| S09 no claims | 全部 `POSTONA_RESV_AUTH_REQUIRED` | 同左 |
| S10 service_ended（TODO） | `POSTONA_RESV_SERVICE_NOT_ACTIVE`（readback だけは ok） | `POSTONA_RESV_SERVICE_NOT_ACTIVE` |
| S11 user_switch | get・cancel とも `POSTONA_RESV_NOT_FOUND`。存在しない ID と同じ答え | — |
| S12 user_deleted | `auth.users` の削除は通り、**予約の行は 3 件残る**（`reservations.user_id` は auth.users を参照していない）。list は `POSTONA_RESV_ACCOUNT_NOT_FOUND` | — |

### 望ましい契約とのずれ（43 個。後の修正で 0 にする目標）
- S01〜S06 の各場面で、list・get・readback・reconfirm・reschedule・cancel・create_batch の 7 つ（6 × 7 = 42 個）
- S06 の post_now_begin（1 個）

望ましい契約は G5-11 の C-3 で、死んだ・他人の・不明な・欠けた・匿名のセッション（と、claims 無し）は、行に触る前に `POSTONA_RESV_AUTH_REQUIRED` で止める。
- 生きているセッション（S00・S07・S08）は通り続けること。
- 他人の行は、存在しない ID と同じ答えであること（S11）。

ランナーはこの 43 個を**名前で**確かめる。ずれが消えても（直った）、増えても失敗する。

### ゲートの自己検査
- テスト用の模型の修正（`gate_selfcheck_model_fix.sql`: `caller()` が、生きている本人の、匿名でないセッションだけを通す）を `QA_PATCH_SQL` で 006 の後に当てた。
- 43 個のずれが**全部消え**（新しいずれは 0）、ランナーは「gaps changed」で止まった。修正が入れば、このランナーが気付く。
- この模型の修正は G5 の契約（C-1〜C-4）ではなく、候補でもない。

### 回帰
- Threads の P7（PR #392 の `postona_threads_p7_session_run.sh`）を再実行した。現行 11 passed、望ましいモードは D1〜D5 の 5 件だけ失敗（`POSTONA_THREADS_P7_GATE_PASS`）。変わっていない。

## 4. 新しく分かったこと（G3-24 への追加）
1. X の `post_now_begin` だけは、G5 の P3b を通して、サインアウト・期限切れ・他人・不明・`session_id` 無しを止める。ほかの 7 つの入口は止めない。
2. G5 の P3b（`account_lifecycle_assert_active_service_write`、G5 の `20261010051938`）は `is_anonymous` を読まない。そのため、匿名のサインインでも単発投稿を開始できる（S06）。
   - G5 の R1・`session_verdict()` は匿名を断る（G5-09・G5-11）。
   - P3b を直すか、利用者の側で `session_verdict()` を併せて呼ぶかは、G5 の判断。この TASK では G5 のファイルを変えていない。
3. 利用者を削除しても、X の予約の行が残る（`reservations.user_id` に auth.users への FK が無い）。
   - 削除の saga・サービス終了の saga（G5・F3 の系列）が先に片付ける前提かは、この TASK では確かめていない。
   - 残った行は、本人の claims が無くなるので読めないが、worker の側の扱いは [U]。

## 5. 将来の契約と、現行の混同を避けるために
- 現行の答え（95 のセル）と、望ましい答え（C-3）を、別々の確認にした。
- 未決定（S10 サービス終了後、BAN 中、owner の交代）は TODO として記録だけし、望ましい答えに照らして判定しない。
- 後続の修正（G3）の受入の条件は、G3-24 の AC-1〜AC-9 と同じ。この QA の追加分は次のとおり。
  - AC-2'（X）: このランナーで、ずれ 43 個 → 0 個。S00・S07・S08 は ok のまま、S11 は同じ答えのまま。現行の固定の答えは、直した後の答えに更新する。
  - 匿名（S06 の post_now_begin）は、P3b を直すか、`session_verdict()` を利用者で呼ぶかで閉じる（G5 と決める）。
- 依存の順番: G5 の `003` の install（Sol・ユーザーの承認）→ G3 の X の利用者の修正（C-1〜C-5）→ Edge の `session_id` の受け渡し → Codex Sol（高）のレビュー。

## 6. 再現
```bash
QA_PGHOST=/private/tmp/<socket> QA_PGPORT=<port> QA_PGSUPER=<local superuser> QA_G5_SOURCE_DIR=<git archive of G5 #371 7140e416> bash supabase/tests/g3_x_reservation_revoked_session_qa/qa_run.sh
```
- ゲートの自己検査は、`QA_PATCH_SQL=supabase/tests/g3_x_reservation_revoked_session_qa/gate_selfcheck_model_fix.sql` を付ける。失敗するのが正しい。
- 役割はクラスタ全体なので、1 つずつ実行する。

## 7. 未確認と、別のトラック
- managed（GoTrue・PostgREST・本物の JWT）は確かめていない。本物の Edge の `/user` の動きは [U]。
- BAN 中の利用者は模型にしていない（fixture に列が無い）。
- 別のトラック: PR #370 の P2（システム列）と A1・A2・B・C、P7（Threads）、U8・U9、G5 の L-1、G4 の CAS。どれも未解決。本番は NO_GO。
