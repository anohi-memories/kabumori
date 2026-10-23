# G3｜削除済みの利用者の X 予約の残存と、worker の送信の境界の隔離監査（2026-10-23、Issue #318 TASK 26/50）

- task_id: `postona-g3-deleted-user-orphaned-x-reservation-offline-audit-20261023`
- 返却先: POSTONA G3担当ちゃ（Issue #318）／完了コード: K3
- 判定: **隔離 QA と docs だけ。**
  - 送信の境界（削除された人の行は claim されず、送信の直前の確認も通らない）は、今の候補で**成り立つ**ことを実測した。
  - 残ったデータと、消えたログインのトークンへの答えは**ずれとして記録**し、緑にしていない。
  - 製品 SQL・RPC・Auth・Edge・worker、PR #392・#466、G5・G4 のファイルは変えていない。本番は NO_GO。
- 変更したファイル（G3 の新しいパスだけ）:
  - `supabase/tests/g3_x_reservation_deleted_user_audit/run.sh`（ランナー。世界の作り方は PR #466 の QA と同じ）
  - `supabase/tests/g3_x_reservation_deleted_user_audit/orphan_matrix.sql`（場面）
  - `supabase/tests/g3_x_reservation_deleted_user_audit/boundary_selfcheck_weakened_guard.sql`（**テスト用の弱めたガード**。候補ではない。境界の確認の自己検査だけ）
  - この文書

## 1. ソースで追った境界（X の候補、PR #392 の head `f34aab97`）
| 段 | 何を見るか | 削除された人の行に対して | 根拠 |
|---|---|---|---|
| 予約の行 | `reservations.user_id` に auth.users への FK は**無い**。`brand_id`・`social_account_id` は brands・social_accounts への FK で on delete cascade | ログインを直接消しても行は残る（brand と social account が残るため） | `001:77-90` |
| worker の claim（`claim_due`） | まず期日の行の持ち主ごとに G5 の `g5_x_autopost_allowed`（→ `service_state_refusal`）。次に、行ごとに `row_publishable`（owner の membership・social account・G5・G4） | G5 は、ログインが無ければ `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND` を**返す**（例外にしない）ので、その人は飛ばされ、ほかの人の round は続く。membership は auth.users の削除で cascade して消えるので、`row_publishable` も false | `004:136-186`、`001:543-562`、G5 `20261012130000`・`20261001150000:364-390` |
| 送信の直前（`pre_publish_check`） | lease、G5、期限、`row_publishable` | `NOT_PUBLISHABLE` で `failed/NOT_PUBLISHABLE_AT_SEND`。送信しない | `004:96-134` |
| 期限切れ | 予定の行は `expires_at` を過ぎると `expired`。claim 済みで lease が切れた行は `uncertain/LEASE_EXPIRED`（二度と claim しない） | 同じ | `004:178-181` |
| 単発投稿（`post_now_preflight`） | lease と `single_post_fence`（G5 の P3b を含む） | `NOT_PUBLISHABLE`（`failed`） | `006:225-266` |
| 利用者の入口 | `caller()` ＋ `assert_account_access`（membership を見る）。readback は本人の行だけで、membership を見ない | list・get・cancel は `ACCOUNT_NOT_FOUND`。**readback は答える** | `001:184-209`、`006:286-304` |
| 本来の削除の順番 | X の停止（F3 001 の `postona_x_stop_publishing_for_user`、002 のサービス終了の saga）→ social-mobile の purge（依存の表 → social account → brand） | 停止で予定は取消、purge で行は消える（social account の cascade）。監査の行は saga が `user_id` で消す（002:210-211） | F3 001・002、main `20260928160000:568-579` |

- **孤立した行が生まれる道**: 本来の順番を通らずに、ログインだけが消えた場合（Auth の管理画面・admin API での削除、古い直接削除の Edge など）。
  - main の Kabumori の `account-delete` は、今は直接の削除を `ACTION_REQUIRED` で拒否する候補になっている（`supabase/functions/account-delete/index.ts:1-5`）。
  - social-mobile の文書は「Kabumori の account-delete が social の workspace を孤立させうる」と書く（`apps/social-mobile/docs/account-lifecycle-phase4.md:54`）。
  - **本番で今どの版が動いているかは [U]**。

### Threads（007）への横展開（ソースの読み取りだけ。実行していない）
- `postona_threads_resv.reservations.user_id` にも auth.users への FK は無い（`007:82`）。`social_account_id` は cascade（`007:84`）。
- worker の `claim_due` は、行ごとに G5 の W1（`g5_bound_state(brand, bound_owner_epoch, bound_lifecycle_version)`）を見て、`active` 以外なら `failed` にする（`007:290-322`）。
  - membership の削除は G5 の owner epoch を動かす（G5 #303 のトリガー）ので、W1 は `active` にならない見込み [E]。
  - `preflight` も W1 と fence を見直す。
- 取消・受領票は `caller()` だけ（P7）なので、消えたログインのトークンにも本人の行で答えうる [E]。
- Threads は G4・G5 の大きな土台が要るので、この TASK では実行していない（NOT_VERIFIED）。

## 2. 隔離試験（使い捨ての PG17.11、偽の人物・セッション・claims）
`run.sh` → `G3_X_DELETED_USER_AUDIT_PASS`（通常のモードで 3 回。最後の 1 回は、自己検査のフックを足した最終の版）。現行の 32 のセルを固定した。公開は 0。

| 場面 | 結果（実測） |
|---|---|
| O1 期日の予定の行。ログインを直接削除 → worker の round | 削除の後: membership 0・social account 1（残る）・セッション 0・common account 0。**行は planned のまま残る**。round で削除された人の行は claim されない。**同じ round で生きている人の行は claim される**。期限を過ぎると `expired` |
| O2 claim の後にログインを削除 → 送信の直前の確認 | `NOT_PUBLISHABLE`、行は `failed/NOT_PUBLISHABLE_AT_SEND` |
| O3 claim の後に削除、worker が止まり lease が切れる | 次の round で `uncertain/LEASE_EXPIRED`（再び claim しない） |
| O4 単発投稿の開始の後に削除 → 同じ要求の preflight（古い claims） | `NOT_PUBLISHABLE`、行は `failed/NOT_PUBLISHABLE_AT_SEND` |
| O5 削除の後、消えたログインのまだ有効な署名のトークンが DB に届いた場合 | list・get・cancel は `POSTONA_RESV_ACCOUNT_NOT_FOUND`（止まるが、コードは AUTH_REQUIRED ではない）。**readback は `pending` を答える**。**予約の行 2・本文 2・監査の行 2 が残る** |
| O6 本来の順番（X の停止 → ログインの削除） | 停止で予定の行は `cancelled`。ログインの削除の後も、行は `cancelled` のまま残る（purge までは消えない） |
| O7 purge の削除順の模型（依存の表 → social account → brand） | 予約の行は消える（social account の cascade）。**監査の行は 1 つ残る**（監査を消すのは 002 の saga） |

### 境界の確認（DESIRED。今、成り立つ）
- B1: 削除された人の行は claim されない。同じ round の生きている人の行は claim される（1 人の削除で round は止まらない）。
- B2: 削除の前に claim された行は、送信の直前の確認で OK にならない。
- B3: 削除の後に lease が切れた行は `uncertain` に固定される。
- B4: 途中で削除された単発投稿の preflight は OK にならない。

境界の自己検査: テスト用の弱めたガード（`row_publishable` から owner・アカウント・G5・G4 の確認を外し、G5 を常に true にする）を `OD_PATCH_SQL` で当てると、ランナーは「B1 a deleted person's row was claimed」で止まった。

### 記録したずれ（緑にしていない。8 個を名前で固定）
- O1: 直接の削除の後に、予約の行が残る。
- O5: list・get・cancel・readback が AUTH_REQUIRED ではない（readback は答える）。行・本文・監査の行が残る。

## 3. 何が保証され、何が残るか
- **保証される（実測。候補の範囲・PG17 の模型）**: ログインが消えた人の X の予約は、worker から送信されない。claim されず、送信の直前の確認で止まり、lease が切れたものは `uncertain` に固定される。単発投稿も止まる。1 人の削除で他の人の送信は止まらない。
- **残る（ずれ・未決定）**:
  1. 直接の削除では、予約の本文（利用者の文章）と監査の行が DB に残る。本来の順番（停止 → purge → saga の監査の削除）でも、purge の前は残る。**削除の後に本文・監査を消すべきかは、削除の方針（G5・G1・G2・ユーザー）の判断**（TODO）。
  2. 消えたログインのまだ有効なトークンには、readback が答える（DB の層）。上流の GoTrue の `/user` は、消えたログインを断る見込み [S]。直すのは P7 と同じ道（G5 の `session_verdict` の利用者の契約）。
  3. 本番で、直接の削除の道（管理画面・古い Edge）が使われうるかは [U]。

## 4. 担当ごとの修正の条件（案。どれも未着手。決めていない）
| 担当 | 内容 | 依存・関門 |
|---|---|---|
| G3 | X・Threads の利用者の入口に、G5 の `session_verdict()` を利用者の契約 C-1〜C-5 の形で入れる（P7 と同じ。消えたログインは AUTH_REQUIRED） | G5 の `003` の install → Codex Sol（高） |
| G3 | 予約の行の後片付けを、削除の saga のどこで行うかの案（停止の後の purge で消えることの確認、監査の削除の位置） | G5 の削除の手順・G1・G2 の判断 |
| G5 | ログインの削除の前に、social の削除（停止 → purge）が必ず走ることの保証（Kabumori の account-delete の手順・blocker） | ユーザー・G1・G2 |
| G1・G2 | Kabumori の `account-delete` の本番の版と、social の利用者の扱い（拒否か、先に social の削除） | 本番の確認はユーザーの承認 |
| ユーザー | 削除の後の本文・監査の保持の方針 | — |

- この QA の後の受入: B1〜B4 は合格のまま。8 個のずれは、修正（入口の判定・後片付け）に合わせて名前で減らす。

## 5. 再現
```bash
OD_PGHOST=/private/tmp/<socket> OD_PGPORT=<port> OD_PGSUPER=<local superuser> OD_G5_SOURCE_DIR=<git archive of G5 #371 7140e416> bash supabase/tests/g3_x_reservation_deleted_user_audit/run.sh
```
- 境界の自己検査は、`OD_PATCH_SQL=supabase/tests/g3_x_reservation_deleted_user_audit/boundary_selfcheck_weakened_guard.sql` を付ける。失敗するのが正しい。
- 役割はクラスタ全体なので、1 つずつ実行する。

## 6. 未確認と、別のトラック
- managed（GoTrue・PostgREST・本物の JWT・本番の削除の道）は確かめていない。
- Threads の実行による確認はしていない（§1 の読み取りだけ）。
- 実際の送信は 0（偽の世界だけ）。
- 別のトラック: P7（Threads・X の入口の 43 個のずれ）、PR #370 の P2 と A1・A2・B・C、U8・U9、G5 の L-1、G4 の CAS。どれも未解決。本番は NO_GO。
