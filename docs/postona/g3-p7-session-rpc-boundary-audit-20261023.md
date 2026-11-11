# G3｜P7：失効したセッションでの予約の取消・受領票の RPC の境界の read-only 監査（2026-10-23、Issue #318 TASK 24/50）

- task_id: `postona-g3-p7-revoked-session-reservation-rpc-boundary-audit-20261023`
- 返却先: POSTONA G3担当ちゃ（Issue #318）／完了コード: K3
- 判定: **読み取りの監査と docs だけ。P7 は未修正。** 製品 SQL・RPC・Auth・Edge・アプリは変えていない。本番は NO_GO。security PASS とは書かない。
- 根拠の印:
  - [C] Draft PR の候補（G3 スタックの先頭 #392 `f34aab97`。G5 #406 `1d032e1e`・#408 `ceb77ce4`・#413 `0ba1fcfc`。G4 #426 `03968e5c`・#428 `c305152d`）
  - [M] main `0c42933c`
  - [D] この TASK での再実行
  - [S] G5 が読んだ GoTrue の公開ソース（G5-09 の記載）
  - [U] 未確認

## 1. 今の保証の範囲（ソースの追跡）
### 1.1 G3 の入口ごとに、DB の層で何を確かめるか
| 入口（G3 の候補） | 本人の決め方 | セッション（`auth.sessions`・`not_after`・本人のものか） | 匿名 | サービスの状態 | 根拠 |
|---|---|---|---|---|---|
| Threads `postona_threads_resv.create_reservation`（007） | `caller()` = `auth.uid()` | ○（G5 の R1 を呼ぶ） | ○（R1） | ○（R1） | PR #392 の docs §1 [C] |
| Threads `cancel_reservation`・`receipt`（007） | 同上 | **× 見ない** | **× 見ない** | × | 同上。**P7** |
| X `postona_x_resv.list_reservations`・`get_reservation` | `caller()` = `auth.uid()` | **× 見ない** | **× 見ない** | ○（`assert_account_access` → `g5_x_autopost_allowed` → G5 の `service_state_refusal(p_user_id, 'x_autopost')`。引数の利用者 ID を見るだけで、セッションは見ない） | `001:440,184-209`、`002:35`、`003:48-58`、G5 `20261012130000` の関数の冒頭 [C] |
| X `cancel`・`reschedule`・`reconfirm`（`lock_own` を通す） | 同上 | **× 見ない** | **× 見ない** | ○（同上） | `001:454-542`・`004:49` [C] |
| X `create_batch`・`post_now_begin`（作成） | 同上 | **× 見ない**（Threads と違い R1 を呼ばない） | **× 見ない** | ○（同上）＋ G4 の X のアカウントの確認 | `001:336`、`005:86`・`006:152` [C] |
| X `post_now_get`・`post_now_readback`（単発投稿の読み戻し） | 同上（`own_single_post` で本人の行だけ） | **× 見ない** | **× 見ない** | × | `005:150-153,191`、`006:286` [C] |
| worker（`claim_due`・`preflight`・`record` など） | 人ではない（worker の役割だけ） | — | — | ○（W1・fence） | PR #392 の docs §1 [C] |

- **新しい所見**: P7 は Threads の取消・受領票だけの問題ではない。**X の予約の候補（001〜006）も、DB の層ではセッションを一切確かめていない**（作成を含む）。X は、サービスの状態（解約・停止・削除中）だけを見る。
- どの入口も、他人の行は「知らない ID」と同じ答えにする（PR #392 の I2、`lock_own`・`own_single_post` の `user_id` の一致）。

### 1.2 DB の手前（Edge）
- **X の予約の Edge**（`postona-x-reservations` など。未デプロイ・リリースの門は OFF）:
  - 検証器（`_shared/postona_reservations/supabase_auth.ts`）は、要求ごとに `GET /auth/v1/user` を呼ぶ。匿名・BAN 中・削除済みを自分で断り、`{ userId }` だけを返す [C]。
  - DB のアダプター（`postgres_db.ts:72-73`）は `request.jwt.claims`・`claim.sub`・`claim.role='authenticated'` を置くが、**`session_id` を渡さない** [C]。
- GoTrue の `/user` は、G5 が読んだ公開ソースによると次のとおり [S]（デプロイ版・managed は [U]）。
  - サインアウトした、または存在しないセッション（`session_id` の行が無い）を 403 `session_not_found` で断る。
  - ただし `not_after` の期限切れ、トークンに `session_id` が無い場合は断らない。`session.user_id = sub` の照合もしない。
- **Threads の HTTP** は、テスト用の fixture だけで、検証器はモック [C]。
- **結論**: X では、サインアウトしたセッションは Edge の GoTrue の呼び出しで止まる見込み [S]。それでも、期限切れのセッションと、DB を直接呼ぶ道（`postona_resv_api` の役割）については、DB の層に防御が無い。P7 は深い層の防御の欠けにとどまらない（G5-09 と同じ判断）。

## 2. 再現した負例（PR #392、この TASK で再実行 [D]）
- 実行環境: 使い捨ての PG17.11。G5 #371・G4 #377 の写し、PR #370 の 001 を使った。
- 結果:
  - 現行 `P7_MODE=current`: 11 passed
  - 望ましい `P7_MODE=desired`: 5 passed・5 failed（D1〜D5 だけ）
  - → `POSTONA_THREADS_P7_GATE_PASS`
- 失敗する 5 つの場面（現行では、取消も受領票も通る）:
  - D1: セッションの行が無い（サインアウト）
  - D2: `not_after` が過去
  - D3: 他人の生きているセッション
  - D4: 存在しないセッション ID
  - D5: 匿名
- 不変条件 I1〜I5（境界は `postona_resv_api` だけ、他人の行は 404 と同じ、claims 無しは拒否、G5 の R1 は 5 つの場面すべてで allow にならない、U8 で作成は止まる）は、両方のモードで合格した。
- X の候補には、同じ形の負例のテストがまだ無い（§4 の受入の条件に入れる）。

## 3. G5 の IF との依存（G5 のファイルは変えていない）
| 項目 | 状態 |
|---|---|
| G5 の推奨（G5-09） | 案 B: セッションだけの判定 `private.account_lifecycle_session_verdict()` |
| SQL 候補（G5-10・PR #408 `003_session_verdict.sql`） | 引数なし、STABLE・SECURITY DEFINER・`search_path=''`・`row_security=off`、owner の所有。EXECUTE は owner だけ（API の役割への付与なし）。答えは `active`／`AUTH_REQUIRED`／`SESSION_REVOKED`／`SESSION_EXPIRED`。読めない事実は例外（`active` にしない）。H1 は P0〜P2 なしで PASS（P3 が 4 つ）。**未適用・未接続** |
| 利用者の契約（G5-11・PR #413） | C-1: 利用する関数は VOLATILE で、同じ owner の所有。C-2: 最初に READ COMMITTED 以外を拒否（0A000）。C-3: 行に触る前に判定し、`active` 以外は `POSTONA_RESV_AUTH_REQUIRED`（42501）。C-4: 行を読み書きする文の WHERE の中でも判定し直し、0 行なら判定を呼び直して 401 と 404・409 を分ける。C-5: 404 の同一性・503 の読み戻し・送信の独立は変えない |
| 前提（G5-11 A-1〜A-5） | A-1: BAN 中・削除フラグの利用者でも、セッションの行が残れば `active`（DB で断るかは**ユーザー・G1 の判断**）。A-2: JWT の署名と `exp` は上流が確かめ、claims を置けるのは検証層の役割だけ（G3 の `postona_resv_api`）。A-3: `auth.uid()` の定義を信じる。A-4: G3 の役割を owner の member にしない。A-5: 契約・権利の入力なし（サービス終了後の受領票は G5 は「見せる」を推奨。停止中・owner の交代は**ユーザー・G1 の判断**） |
| 残る窓 | 書き込みの文がスナップショットを取った後に commit したサインアウトは、その文に見えない（GoTrue が持つ `auth.sessions` の行の lock が要るので、範囲外）。取消は投稿を止める側、受領票は本人の記録 |
| G4 との対比 | G4 の Threads の接続は、H5 の owner transport（専用の owner の接続、READ COMMITTED、検証済みの `sub`・`session_id` をトランザクションの中だけの claims に置く）だけ（#428）。アプリの X の接続は、開始の利用者と `session_id` に固定し、途中の交代で止まる（#426）。G3 の Edge も同じ形（`sub` と `session_id` の受け渡し）が要る |

## 4. G3 の後続の修正（別 TASK。ここでは決めず、受入の条件を示す）
### 4.1 範囲（案）
1. 007 の `cancel_reservation`・`receipt` を、G5 の利用者の契約 C-1〜C-5 の形にする。
2. X の候補の、人が呼ぶ入口（list・get・cancel・reschedule・reconfirm・create_batch・post_now_begin・post_now_get・post_now_readback）にも、同じ判定を入れる。作成は、R1 にするか、セッションの判定とサービスの状態を併用するか、G5 と決める。
3. Edge の受け渡し:
   - X の検証器は、GoTrue の 200 の後、同じトークンの `session_id` を返す。
   - DB のアダプターは `sub`・`session_id`・`role` を置く（G5-09 の `edgeClaimsForDb`）。
   - Threads も、本物の検証器ができたら同じ形にする。

### 4.2 依存の順番
1. G5 の `003` の install（G5 の TASK、Sol のレビュー、ユーザーの承認）
2. G3 の 007 と X の利用者
3. Edge の受け渡し
4. G1 の 401 の扱い

### 4.3 受入の条件（後続 TASK と Codex Sol（高）のレビュー）
| # | 条件 |
|---|---|
| AC-1 | PR #392 の D1〜D5 が、望ましいモードで全部合格し、現行の記録は「直った」形に更新される（期待の失敗の数は 0）。I1〜I5 は合格のまま |
| AC-2 | X の候補にも同じ D1〜D5 と、§5 の行列の場面の負例のテストがあり、修正の前は失敗、後は合格する |
| AC-3 | 利用者は C-1〜C-4 を満たす。変異のテストで、STABLE・分離の検査なし・最初の確認だけ・WHERE の再判定なしの 4 つを検出する |
| AC-4 | 他人の行と存在しない ID は、同じバイトの答え（404）。セッションが死んでいても同じ |
| AC-5 | 503 `OUTCOME_UNKNOWN` の読み戻しと冪等性、送信の経路の独立は変わらない。公開 0 |
| AC-6 | `postona_resv_api` は owner の member でない。API の役割は、判定の関数も利用者の関数も直接呼べない（42501） |
| AC-7 | Edge は検証済みのトークンの `sub` と `session_id` だけを DB に渡す。`session_id` が無いトークンは拒否する |
| AC-8 | ユーザー・G1 の判断（BAN 中の利用者、サービス終了後の受領票、停止中、owner の交代）が出るまでは、決まっていない場面の期待を「未決定」として残し、テストで固定しない |
| AC-9 | PG17 の偽データだけ。managed の確認は別の承認 |

## 5. テストの行列（後続のための仕様。今の挙動は §1・§2 から）
| 場面 | 今の Threads の取消・受領票 | 今の X の人の入口 | 望ましい答え（C-1〜C-5 の後） | 決まっているか |
|---|---|---|---|---|
| 生きているセッション、本人 | 通る | 通る（サービスが有効なら） | 通る | 決まっている |
| サインアウト（セッションの行が無い） | 通る（D1） | DB は通す。X の Edge は `/user` で止める見込み [S] | 401 `AUTH_REQUIRED`、行は変わらない | 決まっている |
| `not_after` の期限切れ | 通る（D2） | 通る（Edge も止めない [S]） | 401 | 決まっている |
| 他人の生きているセッション（`sub` は本人） | 通る（D3） | 通る | 401 | 決まっている |
| 存在しないセッション ID | 通る（D4） | DB は通す。Edge は止める見込み | 401 | 決まっている |
| トークンに `session_id` が無い | 通る | 通る（今のアダプターは渡さない） | 401 | 決まっている |
| 匿名のサインイン | 通る（D5） | DB は通す。X の Edge は自分で断る | 401 | 決まっている |
| BAN 中・削除フラグの利用者（セッションの行が残る） | 通る | DB は通す。X の Edge は断る | **未決定**（A-1。ユーザー・G1） | 未決定 |
| 利用者の削除（`auth.users` の行が無い） | 不明（cascade で行も消える見込み [E]） | 同左 | 401 | 決まっている |
| トークンの更新（同じセッション、新しいトークン） | 通る | 通る | 通る | 決まっている |
| 利用者の切替 A→B（B のトークン） | B の行だけ。A の行は 404 | 同左 | 同左（404 は同じバイト） | 決まっている |
| A→B→A（A の新しいセッション） | 通る | 通る | 通る（新しいセッションは生きている） | 決まっている |
| 再試行（同じ要求、503 の後） | 冪等 | 冪等 | 冪等のまま（判定は毎回） | 決まっている |
| REPEATABLE READ・SERIALIZABLE の呼び出し | 通る | 通る | 0A000 で拒否（C-2） | 決まっている |
| 文の途中でのサインアウト | — | — | 文の前に commit したものは見える。後のものは残る窓（§3） | 決まっている（窓は残る） |
| サービス終了後の受領票 | 通る | X は止まる（サービスの状態を見る） | **未決定**（G5 は「見せる」を推奨。ユーザー・G1） | 未決定 |
| 停止中・owner の交代（PR #392 の Q1） | 本人の行は読めて取り消せる | X は止まる（サービスの状態） | **未決定**（ユーザー・G1） | 未決定 |

## 6. 別のトラック（この文書は触らない）
- PR #370 の P2（システム列の ACL）と A1・A2・B・C
- G5 の L-1（#446・#457）
- G4 の Threads の CAS（G4-25〜28）
- U8（公開のスイッチ）・U9（G4 の結合の期限）

どれも未解決のまま。security PASS としない。

## 7. 確かめたこと（read-only と隔離だけ）
- ソースの読み取り: G3 の候補 001〜007、`supabase_auth.ts`・`postgres_db.ts`、G5 の `003`・G5-09・G5-11 の文書、G5 の `service_state_refusal`（`20261012130000`）、G4 の #426・#428 の PR の本文。
- 再実行: PR #392 の `postona_threads_p7_session_run.sh` → `POSTONA_THREADS_P7_GATE_PASS`（現行 11 passed、望ましい 5 failed＝D1〜D5）。使い捨ての PG17.11、ローカルのソケットと 127.0.0.1 だけ。終了後に停止した。
- 本物の Auth・GoTrue・RPC・managed には接続していない。セッションの操作もしていない。
