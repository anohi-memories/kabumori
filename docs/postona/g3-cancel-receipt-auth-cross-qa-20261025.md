# G3｜予約の取消・受領票の認可の交差 QA（X・Threads、2026-10-25、Issue #318 TASK 31/50）

- task_id: `postona-g3-cancel-receipt-auth-contract-offline-cross-qa-20261025`
- 返却先: POSTONA G3担当ちゃ（Issue #318）／完了コード: K3
- 判定: **G3 の新しい非製品テストと docs だけ。** 製品 SQL・migration・RPC・Auth・RLS・ACL・Edge・worker・アプリ、他の slot の PR・ファイルは変えていない。本番は NO_GO。セキュリティの PASS は主張しない。保持の期間・取消の可否などの方針は決めていない。
- 照合した版（変えていない）: X 001〜006・Threads 007・Threads のテスト用の代役と人物: PR #392 `f34aab9714f5d4f11388609262d5f64cdcce5ed9`。main `0c42933ca5030ab31a56267529430d0473d9b155`。
- 分類: **CURRENT_OBSERVED**／**INVARIANT**（assert した）／**PROPOSED_GAP**（名前で固定）／**UNKNOWN**／**PENDING_POLICY**（記録だけで、比べない）
- 重複させていないもの:
  - G3-25（X の入口 × session の 13 状態。S11 は planned の行だけ）
  - G3-26（X の削除済みの利用者 O1〜O7）
  - G3-30 の U8・U8b・U9
  - PR #392 の P7（Threads の D1〜D5・I2・Q1）
- G5 の session verdict・作業場所の述語、G4 の connection epoch は、**実装済みとは仮定していない**（Threads は PR #392 のテスト用の代役で動かした）。

## 1. 今の経路（read-only、PR #392 の head）
| 入口 | 根拠 | 本人の判定 | 他人・存在しない ID | 状態による答え |
|---|---|---|---|---|
| X `get_reservation` | `002_postona_x_resv_api_role.sql:35-47` | `caller()` = `auth.uid()` のあと、`assert_account_access`（owner・種類・G5） | 行が無い・他人 → `NOT_FOUND`（作業場所の確認より先） | どの状態でも `status` を返す |
| X `list_reservations` | `001_postona_x_reservations.sql:440-451` | `assert_account_access` のあと、`user_id = caller()` の行だけ | — | — |
| X `cancel` | `001:522-536`、`004_postona_x_resv_dispatch.sql:49-70`（`lock_own`） | 行の持ち主 → G5・作業場所 → 行ロック → revision | 他人 → `NOT_FOUND` | `claimed` は `CANCEL_TOO_LATE`、ほかは `ALREADY_FINAL`。監査の行を 1 つ書く |
| X `post_now_readback` | `006_postona_x_single_post_live_fence.sql:286-305` | `own_single_post` | 他人 → `NOT_FOUND` | `claimed` は **lease の期限を見ずに** `pending`（`:297-298`） |
| X 受領票の列 | `001:324-326`（`reservation_view`） | — | — | lease の token・worker・provider id・結果のコードは**含まない** |
| Threads `cancel_reservation` | `007_postona_threads_reservations.sql:254-265` | `caller()` だけ（session・匿名は見ない＝P7） | 他人 → `NOT_FOUND` | `planned` 以外は `NOT_CANCELLABLE`。**監査の行は書かない** |
| Threads `receipt` | `007:267-286` | `caller()` だけ（同上） | (アカウント, 要求 ID, 本人) が一致しなければ `NOT_FOUND` | `claimed` は lease の期限で `pending`／`uncertain` を分ける（`:280`） |
| Threads の行 | `007:82` | `user_id` に auth.users への外部キーは無い | — | — |

## 2. 隔離の QA（新しいパス）
- `supabase/tests/g3_cancel_receipt_auth_cross_qa/run.sh`: 使い捨てのローカル PG17.11、偽のデータ。X の行列 → Threads の代役・人物・007 → Threads の行列 → 2 つのセッションの本当の同時実行（T6）の順に動かす。
- `x_matrix.sql`・`threads_matrix.sql`
- `gate_selfcheck_threads_cancel_oracle.sql`（テスト専用）
- 結果:
  - 78 のセルを固定した。INVARIANT を assert した（他人の行と存在しない ID の答えが同じかを 1 つずつ比べた）。PROPOSED_GAP 4 個を名前で固定した。PENDING_POLICY 4 セルは記録だけ。
  - 2 回とも `G3_CANCEL_RECEIPT_AUTH_CROSS_QA_PASS`。provider の呼び出しは 0（Threads の記録は `simulated`）。

### 2.1 X
| 場面 | 中身 | 今の答え | 分類 |
|---|---|---|---|
| X1 | 他人（生きている session）が、5 つの状態（claimed・uncertain・published・failed・cancelled）の行を取得・取消 | 全部 `NOT_FOUND`。存在しない ID と同じ。行は変わらない | INVARIANT（存在を漏らさない） |
| X2 | 本人が 5 つの状態の行を取得・取消 | 取得は状態を返す。取消は claimed → `CANCEL_TOO_LATE`、ほか → `ALREADY_FINAL`。取消の監査の行は 1 | INVARIANT |
| X3 | 受領票の列 | lease の token・worker は無い。予定の投稿の受領票には、結果のコードと provider id も無い | 無いこと: INVARIANT／結果の理由を見せるか: PENDING_POLICY |
| X4 | owner が A→B に移った後の、新しい owner B | B は A の行を取得・取消できない（存在しない ID と同じ答え）。B の一覧に A の行は出ない | INVARIANT |
| X4 | 同、元の owner A が自分の行を取得・取消・一覧 | 全部 `ACCOUNT_NOT_FOUND`。**Threads（P7 の Q1）では A が取り消せる**。X と Threads で答えが違う | **PENDING_POLICY**（元の owner に取消を許すか） |
| X5 | 単発投稿の lease が切れ、まだ掃除されていない | readback は `pending`（Threads は同じ場面で `uncertain`）。掃除の後は `uncertain`。他人は存在しない ID と同じ答え | **PROPOSED_GAP**（`pending` と表示される）／他人: INVARIANT |

### 2.2 Threads
| 場面 | 中身 | 今の答え | 分類 |
|---|---|---|---|
| T1 | 他人（生きている session）が、4 つの状態（claimed・lease 切れ・published・cancelled）の行を取消・受領票。自分のアカウントに他人の要求 ID を入れた場合も | 全部 `NOT_FOUND`。存在しない ID・要求と同じ。行は変わらない | INVARIANT |
| T2 | 本人が 4 つの状態の行 | 取消は全部 `NOT_CANCELLABLE`。lease が切れた claimed は、掃除の前でも `uncertain/-/LEASE_EXPIRED`。published は `sent/<id>/PUBLISHED` | INVARIANT |
| T3 | owner が A→B に移った後の、新しい owner B | B は A の行を取消・受領票できない（存在しない ID と同じ）。worker は送らず、行を `failed/OWNER_EPOCH_CHANGED` にする | INVARIANT（理由の文字列は G5 の代役による） |
| T4 | owner の auth.users の行を消した（session は 0 件になる）。古いトークンで | **受領票は `pending` を返し、取消は `cancelled` になる** | **PROPOSED_GAP**（P7 の修正の方向: session が死んでいれば拒否） |
| T4 | 同、worker | 送らず、行を `failed/WORKSPACE_OWNER_UNKNOWN` にする | INVARIANT（理由の文字列は代役による。本物の G5 では UNKNOWN） |
| T4 | 同、本文は残る（2 行） | 記録だけ | **PENDING_POLICY**（保持。PR #475 の Q1） |
| T5 | Threads の取消の監査 | `postona_threads_resv` に監査の表が無い。取消は跡を残さない（X は 1 行残す） | **PROPOSED_GAP** |
| T6 | dispatcher の claim が行を 3 秒持っている間に、本人の取消（2 つのセッションの本当の同時実行） | 取消は**ロックで待ち**、その後 `NOT_CANCELLABLE`。行は claimed | INVARIANT（取消が claim を追い越して送信に割り込むことはない） |

### 2.3 ゲートの自己検査（テスト専用の変異）
- `gate_selfcheck_threads_cancel_oracle.sql`: 007 の取消の 1 行だけを変え、他人の行が「ある」ときに `NOT_CANCELLABLE` を返すようにした（存在の漏れ）。
- 結果: `FAIL INVARIANT T1_other_person_by_state cancel_claimed == cancel_unknown_id` で落ちた（期待どおり）。

## 3. 守る契約（変えてはいけない）
1. **存在を漏らさない**: 他人の行・存在しない ID・他のアカウントの要求 ID には、同じ答え（`NOT_FOUND`）を返す。owner が移った後の新しい owner にも同じ。
2. **UNKNOWN のときは NO_SEND**: owner が移った・消えたときは送らない（X は claim しない。Threads は `failed` で止める）。
3. **二重の送信をしない**: claim・送信中・結果不明の行は取り消せない。取消が claim と同時なら claim が勝つ。
4. **受領票に秘密を出さない**: lease の token・worker・本文以外の秘密の値は出さない。
5. **監査**: X の取消は 1 行残す（Threads は残さない＝T5）。

## 4. 最小のソースの候補（実施していない。全部 PROPOSED）
| # | 候補 | 閉じるもの | 依存・注意 |
|---|---|---|---|
| C1 | X `post_now_readback` で、`claimed` かつ lease が切れていれば `uncertain` と答える（Threads `007:280` と同じ形） | X5 | 読み取りだけの変更。状態は変えない |
| C2 | Threads の取消・受領票の前に、G5 の session verdict（SV）を呼ぶ | T4 の 2 個（と P7 の D1〜D5） | G5 の SV の install（D1）が先。X 側の G3-25 の 43 個と同じ道 |
| C3 | Threads に監査の表を足し、取消・記録で 1 行書く（本文は書かない。X の `audit` と同じ形） | T5 | 削除のときの扱い（仮名にする・消す）は PENDING_POLICY（PR #475 の Q2） |
| C4 | 元の owner の取消の扱いを X と Threads でそろえる | X4 の A | 方針が先（PENDING_POLICY）。どちらにそろえても、二重の送信の防止は変わらない |

## 5. 依存・回帰・Sol（高）の独立レビュー
- 依存（未合意。仮に決めていない）: G5 の SV・作業場所の述語・owner epoch、G4 の connection epoch。T3・T4 の Threads の止め方は G5 の代役（`g5_verdict_test_double.sql`）によるので、本物の G5 では UNKNOWN。
- 回帰の条件:
  - この `run.sh`。C1 なら X5、C2 なら T4 の 2 個、C3 なら T5 が消える。INVARIANT はそのまま通ること。
  - G3-25・G3-26・G3-30・PR #392 の P7・behavior の試験も通ること。
- Sol（高）の独立レビューの要否:
  - **C1〜C4 は、どれも製品の SQL・RPC の変更なので必要。**
  - 確かめること: §3 の契約が保たれること（特に 401／404 の使い分けで存在を漏らさないこと）。
  - SV を足すときは、拒否を存在の確認より**先**に置き、他人の行と存在しない ID が同じ答えのままであること。

## 6. UNKNOWN と PENDING_POLICY
- UNKNOWN: 本物の G5・G4 での T3・T4 の止め方と理由、managed の GoTrue での削除と session の関係、本番の Threads の行の分布。
- PENDING_POLICY:
  - 元の owner の取消・閲覧（X4）
  - 削除の後の本文の保持（T4、PR #475 の Q1）
  - 予定の投稿の受領票に結果の理由・post id を見せるか（X3）
  - BAN・locked・ログアウト・古い作業場所（#299）
- 別のトラック: PR #370 の P2、P7（43 個と D1〜D5）、U8・U9。本番は NO_GO。
