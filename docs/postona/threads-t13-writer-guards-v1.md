# POSTONA Threads の書き込み口と共通アカウントの利用状態（T13・F5）V1（ソース実装・ゲートOFF）

- TASK: `postona-f4-threads-t13-authenticated-writer-integration-20261013`（新系統 F4 → L4）
- 基準: F4 Draft PR #167 の先頭 `02fd1989303879979b137f8338f8bc6944f266b1` に積む Draft PR（#167・#154 は無変更）
- 読み取り専用で重ねて確認した版: F5 PR #165 `4638891f6c7ff432e08d462019594e1ec3d66f07`（G5 PR #152 `ccea1fe8…` → PR #121 `76b50e1e…` の上）、PR #124 `c30f246409a77080cbc03aef6c4cb72b5481e125`
- 状態: **ソースとテストのみ**。本番・Supabase・Meta への操作なし。アプリ・サーバー・データベースのゲートはすべて閉じたまま。

## 1. Threads の書き込み口と、それぞれの確認（棚卸し）

POSTONA の Threads には、**サーバー側で人なしに動く処理（ワーカー）はありません**。すべて本人のログイン（JWT）で動きます（接続は H5 の所有者経路で本人のクレームを付けて、投稿・解除は Data API で本人として）。

| 書き込み口 | 所有 | 種類 | 本人の利用状態（T13） | ワークスペース所有者の利用状態（F5） | 今回 |
|---|---|---|---|---|---|
| 接続の開始・状態の確認・完了（`begin/consume/complete_social_mobile_threads_oauth_connection`、#124） | G4 | 本人（H5 所有者経路） | 各関数の最初で確認済み（H5 の `assert_actor` でも） | 不要: ワークスペースは本人専用で、#124 は他人が入った共有ワークスペースを拒否するため、所有者＝本人 | 変更なし。**G5 の実物で**全状態を検証 |
| トークン期限の記録（`record_threads_credential_custody`） | G4 | 接続完了と同じトランザクション内のみ | 完了の T13 の内側 | 同上 | 変更なし |
| 手動投稿の許可 ON（`set_threads_manual_publish_permission` true） | G4 | 本人 | 確認済み | **新規追加** | F5 を行ロックの前に |
| 手動投稿の予約（`begin_threads_manual_publish`） | G4 | 本人 | 確認済み | **新規追加**（`authorize` 内） | 同上 |
| トークンを渡す段階（`release_threads_manual_publish_step`） | G4 | 本人＋サーバーの証明 | 確認済み | **新規追加**（`authorize` 内） | 同上 |
| 投稿結果の記録（`record_threads_manual_publish_result`） | G4 | 本人＋サーバーの証明 | なし（意図的） | なし（意図的） | 変更なし: 投稿されたかもしれない事実の記録は止めない |
| 手動投稿の許可 OFF | G4 | 本人 | なし（意図的） | なし | 変更なし: 取り下げはいつでも可能 |
| Threads だけの解除（`disconnect_threads_account`、#167） | F4 | 本人 | **「解除用」の判定に変更**（下記 2） | 不要（本人専用ワークスペースのみ） | 変更 |
| 退会時の後片付け（`cleanup_threads_provider_footprint`） | G4/F4 | G5 の削除処理（lease） | なし（意図的） | なし | 変更（下記 3） |

**新しい F5 の確認**（`supabase/candidates/postona_threads_lifecycle_guards/threads_writer_lifecycle_guards_candidate.sql`、未適用）
- ワークスペースの **所有者** の POSTONA を、F5 の `private.account_lifecycle_assert_brand_service_active(brand, 'x_autopost')`（PR #165 の正確な名前・所有者・権限）で確認する。管理者（admin）としてほかの人のワークスペースに入っている人は、自分の POSTONA が有効でも、**所有者の POSTONA が終了・停止・削除中・所有者不明なら投稿できない**。
- 順番: 本人の T13 → （メンバーでなければその場で拒否。他人のアカウント名を出しただけで所有者の行を待たせない）→ 所有者の F5（G5 の順序でロック、コミットまで保持）→ ワークスペース・アカウントの行ロック。G5 の Phase 4 の「ライフサイクルのロックが先」の順を守る。
- 答えは既存の固定コードに対応させた（アプリ・サーバーの変更不要）: 所有者不明 → `WORKSPACE_INACTIVE`、未登録・停止・終了 → `SERVICE_NOT_ACTIVE`、削除中・ロック → `ACCOUNT_LIFECYCLE_BLOCKED`、待ち時間切れ → `BUSY`（再試行可）。
- 置き換える2つの関数（`threads_manual_publish_authorize`、`set_threads_manual_publish_permission`）は、元の本文の指紋（md5）が一致するときだけ置き換える（ずれていたら適用を止める）。

## 2. 解除は「消すための判定」に（利用が終わっていても消せる）

- これまでは解除も T13（POSTONA が有効なこと）を求めていたため、**利用を停止・終了した人は Threads の認証情報を自分で消せなかった**。
- 今回、G5 の Phase 4 の判定 `private.account_lifecycle_service_state_refusal(user, 'x_autopost')`（ロックの順は G5 と同じ・コミットまで保持）を使い、次の方針にした:
  - **消せる**: 有効・停止中・終了済み・未登録
  - **消せない**（何も変えない）: アカウント削除中・POSTONA の削除中（G5 の後片付けが lease の下で消すため）、アカウントのロック中・不明、待ち時間切れ（`BUSY`）
- 本人確認（セッションの生存）、本人専用ワークスペース、二重防止、送信中の投稿の保護などは #167 のまま。

## 3. 実物の G5 の環境で見つかった不具合と修正（解除・後片付けの両方）

- #124 の接続は `social_account_oauth_states`（OAuth の状態）を残し、これは Threads のアカウント行を **連鎖削除なし** で参照している。そのため、**本物の接続手順で作ったアカウントは、解除も退会時の後片付けも失敗していた**（解除は `DISCONNECT_FAILED`、後片付けは `CLEANUP_FAILED` で止まり、消えない）。前回までのテストは行を直接作っていたので見えなかった。
- 修正: そのアカウントの OAuth の状態（とその検証用シークレット）を、アカウントと同じトランザクションで先に消し、読み戻しでも確認する（POSTONA の退会候補が同じことをしているのに合わせた）。他の人の OAuth の状態は残る（テストで確認）。

## 4. 検証（2026-10-13 JST、すべてローカル・偽データ）

| 検証 | 結果 |
|---|---|
| `supabase/tests/postona_threads_t13_run.sh`（**G5 の実物**: Phase 1/2/3a/3b(T13)/4/F5 の本物のマイグレーション＋#124＋投稿一式＋後片付け＋解除） | ALL PASS: 前提（本文のずれ、F5 が無い・API ロールから呼べる）、2セッションの競合5種（管理者の release 中に所有者の POSTONA が終了 → 待ってから拒否・トークン渡さず／非メンバーは所有者の行を待たない（1秒未満で拒否）／ロックの順（許可 ON・予約）→ デッドロックなし／所有者の行が3秒以上止まる → `BUSY`・何も変わらない／#124 の完了がアカウントのロックを待って拒否・何も書かれない）、振る舞い（下記）、**変異6/6検出** |
| 振る舞いの内容 | 接続の開始・状態確認: 共通アカウントなし・POSTONA 未登録・停止・終了・アカウント削除中・POSTONA 削除中・ロック → それぞれの G5 のコードで拒否、OAuth の状態は1件も書かれない／期限切れ・削除済み・他人のセッション・anon のクレーム → 拒否／開始後に停止 → 完了を拒否（認証情報もアカウントも書かれず、状態も未使用）→ 有効に戻せば同じ状態で1回だけ完了／他人は完了できない／同じ状態の二重開始は拒否／Vault の失敗 → 何も書かれない。投稿: 本人・所有者とも有効なら予約・トークン渡し可／所有者が停止・終了・削除中・ロック → 管理者の予約は拒否・1件も作られない／本人（管理者）が停止 → 拒否（T13）／所有者2人 → `WORKSPACE_INACTIVE`／非メンバー → 拒否／所有者が終了しても投稿結果の記録はできる／所有者が停止中でも許可 OFF はできる・ON はできない。解除: 停止・終了の人は解除できる、削除中・ロックは拒否。後片付け: POSTONA が有効でなくても（削除の手続き中なら）正しく消える。ACL: どの判定関数も authenticated・anon から呼べない |
| `supabase/tests/postona_threads_disconnect_run.sh` | ALL PASS（競合2種、振る舞い、**変異15/15検出**。新規: 判定なし・削除中も許す・有効のみ・OAuth 状態を消さない・検証用シークレットを残す） |
| `supabase/tests/postona_threads_cleanup_run.sh` | ALL PASS（lease の競合、振る舞い、**変異9/9検出**。新規: OAuth 状態を消さない・検証用シークレットを残す） |
| `supabase/tests/postona_threads_connect_smoke_run.sh` | ALL PASS（H5 #159・G5 #152 の実コードとの組み合わせ、無変更の確認） |
| Deno `_shared/social`＋投稿・解除の Edge | 118 PASS |
| アプリ `threads-disconnect`＋`threads-connect`＋`threads-manual-publish` | 53 PASS、`tsc`・`expo lint` 問題なし |
| NOT_RUN | 管理された Supabase（本物の Auth・PostgREST の SQLSTATE 対応・Vault）、H5 の本物の所有者経路、Meta、実機、本番 |

## 5. 他の担当への依頼・引き継ぎ

| 担当 | 内容 |
|---|---|
| **F5（G5）** | (1) 後片付けアダプターの登録と、削除処理のロールへの `threads_provider_connection_state(uuid)`・`cleanup_threads_provider_footprint(uuid)` の EXECUTE 付与（独立レビュー後、G5 のファイルで）。(2) ~~POSTONA だけの終了（service_deletion）に所有者 lease が無い~~ → **解決済み**（2026-10-13）: F5 Phase 6（PR #178）が lease を用意し、F4 の後片付けが G5 の判定 `private.account_lifecycle_cleanup_authorized` に追従（`threads-cleanup-live-lease-fix-v1.md`）。(3) Threads は外部の取り消しを確認できないため、**アカウント全体の削除は `acceptRemoteUnverified` を許すかの判断が必要**（許さないと Threads がつながった人の削除は止まる）。(4) 今回の F5 の使い方（`assert_brand_service_active` を定義者関数の中で、行ロックの前に）が F5 の意図どおりかの確認。Threads には人なしのワーカーが無いので `common_account_brand_service_state`（読み取りの判定）は使っていない。 |
| **H5** | 変更依頼なし。いまの形（`assert_actor` で T13 → セッション FOR SHARE → #124 の関数、接続の完了とトークン期限の記録を同じトランザクションで）を保つこと。所有者経路が本人のクレームなしに #124 の関数を呼ぶと T13 が必ず拒否する（安全側）。 |
| **G3（F3）** | X の予約・投稿・saga・認証には触れていない。X 側の F5 配線（PR #165 の文書 §4）は G3 側の作業。 |
| **既知の限界** | Threads への HTTP 呼び出しの間はデータベースのロックが及ばない（トークンを渡した後の1回は止められない。次の段階は必ず再確認）。所有者の POSTONA が終わった後は、送信中かもしれない投稿の照合（confirm／reconcile）も T13 で止まる（#144 のまま）。その場合は人が確認し、退会時の後片付けは `reconciliation_required` で止まる。 |
