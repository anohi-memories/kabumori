# POSTONA Threads 退会時の後片付け: 担当期限（lease）の確認漏れの修正 V1（ソースのみ・未適用）

- TASK: `postona-f4-threads-cleanup-live-lease-security-fix-20261013`（新系統 F4 → L4）
- 基準: F4 Draft PR #169 の先頭 `fd15430ddcd640c5c7389582f37f1b478fc7204c` に積む Draft PR（#169 は無変更）
- 読み取り専用で重ねて確認した版: F5 PR #178 `83334a091ded5571cf595fd99d7a035627564735`（Phase 6、PR #165 → G5 #152 → #121 の上）、PR #124 `c30f246409a77080cbc03aef6c4cb72b5481e125`
- 発見: F5 Phase 6 の独立した再現（PR #178 `docs/common-account/phase6-postona-cleanup.md` §8.3）

## 1. 不具合

F4 の `public.threads_cleanup_authorized(p_user_id)`（`supabase/candidates/postona_threads_cleanup/threads_provider_cleanup_candidate.sql`）は、**POSTONA だけの利用終了（service_deletion `x_autopost`）について担当期限（owner lease）を見ていなかった**。そのため、終了が始まっただけで誰も担当を取っていないとき、または担当期限が切れた後でも、後片付けの権限を持つ呼び出し元なら、その人の Threads の認証情報・アカウント・OAuth の状態を消せた。G5 の通常の経路は削除直前に `stillOwned()` を確認するので安全だったが、それ以外の呼び出し元や、確認から削除までの間の時間経過は防げていなかった。

## 2. 修正（1関数＋前提確認）

- `threads_cleanup_authorized` の中身を G5/F5 の判定 **`private.account_lifecycle_cleanup_authorized(p_user_id)`**（Phase 6、所有者専用）に置き換えた。アカウント削除（後片付け段階）と POSTONA だけの終了の**両方**で、有効な担当期限（実時刻で判定）が必要になる。`SECURITY DEFINER`・`search_path = ''`・戻り値 boolean・所有者専用の実行権限はそのまま。
- 入口と、ロック取得の後（削除の直前）の2回確認するのは前と同じ。待っている間に期限が切れたら何も消さない（`LEASE_NOT_HELD`）。
- 前提確認を追加: G5 の判定関数が無い、所有者が違う、戻り値が boolean でない、API ロールから呼べる、のいずれかなら適用を拒否する（`THREADS_CLEANUP_PRECONDITION_LIFECYCLE`）。G5 の表を自分で読む処理はなくなった。
- 関数の署名（`uuid` だけ）は変えていない。F5 の登録・付与の候補（PR #178）とそのまま合う。担当者が「誰か」までは関数側では区別できないため（G5 の差し込み口はアダプターに lease を渡さない）、古い担当者はアダプターの `stillOwned()`（PR #167 から実装済み）で止まる。

## 3. 検証（2026-10-13 JST、すべてローカル・偽データ）

| 検証 | 結果 |
|---|---|
| `supabase/tests/postona_threads_t13_run.sh`（**G5/F5 の実物**: Phase 1/2/3a/3b/4/F5/**Phase 6** のマイグレーション、PR #178 から読み取り専用） | **修正前（PR #169 の候補）は失敗**: 担当を取った POSTONA 終了の期限がロック待ちの間に切れても消える（競合テスト R7）、担当を取る前でも消える（`postona_threads_t13_cleanup_lease.sql` の「unclaimed POSTONA deletion」）。**修正後はすべて合格**: 本物の開始（`begin_service_deletion`）だけでは何も消えない → 本物の担当取得（`claim_service_deletion`）後に本人の分だけ消える／期限切れ・返却（`release_service_deletion_claim`）・他人の担当では消えない／新しい担当者が取り直せば消える（引き継ぎ）／アカウント削除も後片付け段階＋有効な期限が必要／判定関数・本関数・削除関数はどれも service_role・authenticated・anon から呼べない。前提確認（判定関数が無い・API ロールから呼べる）も確認。投稿・接続のガード（PR #169）の全テスト（競合5種、変異6/6）も引き続き合格 |
| `supabase/tests/postona_threads_cleanup_run.sh`（簡易環境、判定関数は F5 と同じ本文の代役） | **修正前は失敗**（POSTONA 終了の期限切れ競合）、**修正後は合格**。新規: 担当を取る前・期限切れ・返却・他人の期限では消えない、POSTONA 終了の期限がロック待ちで切れる競合。**変異11/11検出**（出荷時の抜け道・どの service_deletion でも可・アカウント削除の段階を見ない・トランザクション開始時刻で判定、ほか） |
| `supabase/tests/postona_threads_disconnect_run.sh` | ALL PASS（解除は削除の手続き中なら拒否のまま。変更不要） |
| NOT_RUN | 管理された Supabase（本物の service_role・PostgREST・Vault）、本番 |

## 4. F5 への引き継ぎ

- §8.3 の修正はこれで F4 側が対応済み。F5 の登録（`provider_registry.threads.candidate.ts`）と実行権限の付与（`threads_cleanup_execute_grant_candidate.sql`）の前提がそろった（どちらも F5 のレビュー後、F5 のファイルで）。
- 関数側で「どの担当者か」まで縛りたい場合は、差し込み口から lease をアダプターに渡す設計変更が必要（G5/F5 の判断）。今は `stillOwned()`＋削除の冪等性＋ワークスペースのロックで扱っている。
- 適用順: G5 Phase 1〜4 → F5 → Phase 6 → G4 の投稿一式 → この後片付け候補 → F5 の付与。
