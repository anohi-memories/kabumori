# G4-13：PR #367（Threads の結び付けの世代の SQL）の ACL の委任の P2 と S1→S2→S1 の修正（隔離 PG17）（2026-10-20 JST）

- task_id: `postona-g4-pr367-binding-acl-role-reachability-p2-source-fix-20261020`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY_FIX_CANDIDATE（未適用、使い捨ての PG17 だけで証明）**。
  - 受け入れの後、H2 #329 で Codex Sol（高）の限定の再レビューが要る。
  - 安全の PASS・PRODUCTION_GO とは言わない。
- 土台: PR #367 の head `fd71450511f4a8d73e150a92bd9fe95677b70edc` から、新しいブランチ。
  - PR #367 自身の head、H2 のレビューの証拠、PR #377 は**変えていない**。
- 元のレビュー: H2 #329 コメント 6287507627（REPORT）、6287571008（ACCEPT）。

> **訂正（G4-14、2026-10-21）**: 下の「complete と同じトランザクションの中だけ（`consumed_at = now()`）」は、同じトランザクションの証明に**なっていなかった**（H2 #329 C2 R1。同じ開始時刻の別のトランザクションから通る）。G4-14 で、単独の attest を無くし、PR #124 の complete と結び付けを1つの入口 `complete_and_attest_binding` にまとめた。詳しくは `threads-binding-attest-atomic-entry-20261021.md`。

## 1. 直したこと（`supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql`）

### R1［P2］SET ROLE だけで届く役割を、事後の確認が見落とす
- **前の版**:
  - 事後の確認は、API の3つの役割それぞれの `has_*_privilege` だけを見ていた。
  - そのため、authenticated が **INHERIT FALSE・SET TRUE** で届く委任先の役割に、owner の**既定の ACL**で付いた EXECUTE（`attest_binding` など、SECURITY DEFINER）とスキーマの USAGE を見逃した。
- **今回**:
  - 前提: API の役割（anon・authenticated・service_role・authenticator）が、MEMBER・SET・USAGE の**どの経路でも owner になれない**こと（NOINHERIT・SET だけのメンバーも含む）。
  - 事後の確認: 新しく作ったものの ACL を**1つずつ確かめる**。
    - スキーマ、2つの表、3つの関数の ACL に **owner 以外の名前が1つでもあれば**、適用を丸ごと取り消す。
    - 関数の ACL が null（＝PUBLIC が実行できる）でも拒否する。
    - 最後に、owner に届く API の役割が無いことを、もう一度確かめる。
  - 既存の付与を**勝手に外して片付けることはしない**（拒否するだけ）。
- 誰が委任先に届くかを調べる必要が無い形にした: 委任先が何かを持っていれば、その時点で拒否する。

### 補足のギャップ: S1→S2→S1（attest の helper を直接呼んで、古い state に戻す）
- **前の版**:
  - 「同じ state の2回目」の拒否は、今の結び付けの行だけを見ていた。
  - そのため、S1 で接続 → S2 で再接続（結び付けは S2 に置き換わる）→ owner の経路から S1 の attest を直接もう一度呼ぶと通り、結び付けが S1 に戻った。
  - callback の再送そのものは、PR #124 が `THREADS_OAUTH_STATE_NOT_CONSUMABLE` で拒否していた。
- **今回は、2つで閉じた**:
  1. **state ごとに1回だけ**: `state_generations.attested_at` を記録し、記録のある state は二度と attest できない（`THREADS_BINDING_ALREADY_ATTESTED`）。
  2. **complete と同じトランザクションの中だけ**: PR #124 の complete は `consumed_at = now()` にする。attest は、その state の `consumed_at = now()`（同じトランザクション）のときだけ受け付ける。それ以外は `THREADS_BINDING_NOT_IN_COMPLETE_TRANSACTION`。
     - H5 の owner transport は、complete と attest を1つのトランザクションで呼ぶ必要がある（今までの契約を強制にした）。

## 2. 証明（`supabase/tests/postona_threads_binding_epoch_run.sh`、PostgreSQL 17.11、ローカルの socket）
| 段階 | 結果 |
|---|---|
| 世界（G4-09 と同じ: G5 の本物の T13・Phase 4・ブランドの状態・Phase 6、F5 PR #303 の owner epoch、2a-2、PR #124） | PASS |
| **修正前の失敗の再現**: 元の PR #367（`fd714505`）は、H2 の形（既定の ACL で関数とスキーマを委任先へ）でも適用できる | PASS（`authenticated → 委任先 SET = true`、`委任先の attest_binding EXECUTE = true`、`委任先のスキーマ USAGE = true`、`authenticated 自身の EXECUTE = false`。H2 の再現と同じ） |
| 前提の拒否: superuser、F5 の getter・coverage、PR #124、G5 の brand owner、**authenticator が SET で owner になれる** | PASS |
| **H2 の形の拒否**: 既定の ACL で、関数の EXECUTE（`FUNCTION_ACL`）・スキーマの USAGE（`SCHEMA_ACL`）・表の SELECT（`TABLE_ACL`）を委任先へ | PASS |
| 再適用の拒否、rollback、rollback の2回目の拒否、再適用 | PASS |
| 振る舞い（G4-09 の全部 ＋ 新しい 7b・7c） | PASS |
| 同時実行: 1つの state に、complete と attest の2つのトランザクション | PASS（2つ目は待って PR #124 が拒否。結び付けは1件、attest 済みの state も1件） |
| ミューテーション | **24/24 を検出** |

- 新しい振る舞い:
  - **7b**: S1→S2→S1。S1 を直接もう一度 attest すると `ALREADY_ATTESTED` で、何も変わらない。結び付けは S2 のまま。2つの state は、どちらも1回だけ attest 済みと記録される。
  - **7c**: complete だけを先に commit し、別のトランザクションで attest すると `NOT_IN_COMPLETE_TRANSACTION` で、何も変わらない。
- 前からの振る舞い（すべて維持）: 別の人・別のワークスペース・別の Threads の利用者、A→B→A、終了と再開（SYNTHETIC）、2人の所有者、期限切れ・消費済みの state、2^53 を超える数、cascade、拒否で書き込み0。
- ミューテーション24種:
  - 前からの17種を新しい形に合わせた。
  - 新しく足した: state ごとに1回の確認を外す、今の結び付けだけを見る形に戻す、同じトランザクションの確認を外す、`attested_at` を記録しない。
  - 適用時の確認: 関数・スキーマ・表の ACL の確認を弱める（不利な世界で適用できてしまう）。
  - owner への到達の前提を外す。
    - これは拒否のコードが変わるので検出に数えたが、F5 の coverage の確認も同じ状態を拒否する。この前提と事後の確認は**二重の守り**。
- 等価なもの（数えていない）: 関数の ACL が null のときの拒否。直前の revoke で ACL は必ず明示されるので、外しても答えは変わらない。それでも、既定の ACL の振る舞いが変わった場合の守りとして残した。
- Threads の TS の回帰: 295 passed／0 failed（TS は変更なし）。
- 外への通信・本物の Supabase・Vault・OAuth・トークン・Threads は0回（偽の値だけ）。
- NOT_VERIFIED:
  - 管理環境の役割の構成（本番に H2 の形が存在するとは言っていない）
  - H5 の owner transport の本物の組み込み
  - 本物の終了・再開・退会の RPC の流れ
  - G5 PR #358 の W1 との結合（PR #377 側）
  - 本番

## 3. この修正の外で、未解決のまま（今回は変えていない）
- **PR #377**（H2 の CHANGES_REQUIRED P2）:
  - `credential_row` の期限の確認が `now()`（トランザクションの開始の時刻）なので、長いトランザクションでは期限切れの資格情報を返しうる。
  - 依存の STABLE→VOLATILE の後からの変更（DDL の drift）で、古いトークンと新しい世代の組になりうる（契約の判断が要る）。
- **G3 U8**: Threads の `publish_enabled` は 2a-2 の CHECK で常に OFF だが、G3 の 007 は ON を求める（別の許可の表を読むか、解除の migration か、の判断）。
- **G3 U9**: 接続の後に世代が動くと、再接続まで資格情報が出ない。本人に「再接続が必要」と伝える道が無い。
- **G5 R0**: 本物の RPC は未接続。begin の認可（ブランドなし）も未決定。
- **H5**: 本物のトークンの保管と Vault の書き手。

## 4. 行っていないこと
- `supabase/migrations`、管理環境・本番の DB／Auth／RLS／RPC／SECURITY DEFINER／GRANT／REVOKE の本物への適用
- Vault・トークン、Meta／X／Threads の本物の API・投稿、Edge／Cron、有料の API、ゲートを開くこと
- main への push、マージ、デプロイ、force push
- PR #367・#377 の既存の head の直接の変更、G3／G5／H5 のパス、他の枠の worktree
