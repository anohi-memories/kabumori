# G4-09：Threads の OAuth の結び付けに「世代」を保存する SQL の候補と、隔離した PG17 の証明（2026-10-20 JST）

- task_id: `postona-g4-threads-oauth-binding-epoch-lifecycle-sql-candidate-20261020`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY_SQL_CANDIDATE（未適用、使い捨ての PG17 だけで証明）**。
  - Codex Sol（高）の限定のセキュリティレビューの前。PRODUCTION_NO_GO。
  - 安全の PASS とは言わない。
- 土台: PR #364（head `6fe75405196baa52f1b71936f87569b070904e77`）の上。
- 試験で重ねた他の PR（読み取り専用、固定 SHA）:
  - F5 PR #178 `83334a09…`（G5 の T13 の guard・Phase 4・ブランドの状態・Phase 6）
  - F5 PR #303 `88481aef…`（owner epoch の候補、PR #285 の R1〜R3 の修正版）
- PR #124 の SQL は**変えていない**。

## 1. 何を足したか（`supabase/candidates/postona_threads_binding_epoch/`）
`001_threads_binding_epoch.sql`（と `_rollback.sql`）。新しいスキーマ `postona_threads_binding` に、owner だけが使える次のものを足す。API の役割（anon／authenticated／service_role）には何も付与しない。

| もの | 役目 |
|---|---|
| 表 `state_generations` | OAuth の state ごとに、開始した人・ワークスペース・アカウントと、begin を許した **owner epoch と owner の lifecycle_version**（G5 の R1 の allow の `g5oe:<epoch>:<lifecycle>` の2つの数）を記録 |
| 表 `bindings` | アカウントごとに、結び付けた人・元の state・Threads の利用者 ID・2つの数・`bound_at`（**監査用だけで、比べない**）を記録 |
| `record_state_generation(actor, state, epoch, lifecycle)` | PR #124 の begin の**直後、同じトランザクション**で呼ぶ。条件は次のとおり。<br>・その人が始めた・未使用・期限内の state で、同じワークスペースの Threads のアカウント<br>・その人がワークスペースのただ1人の所有者<br>・渡された2つの数が、今の DB の値と同じ（1つの文で読む）<br>・同じ state の2回目は拒否 |
| `attest_binding(actor, state, threads_user_id)` | PR #124 の complete の**直後、同じトランザクション**で呼ぶ。条件は次のとおり。<br>・begin のときの記録がある<br>・complete が state を消費した<br>・始めた人と同じ<br>・アカウントがその state の Threads のアカウントで、identity_verified・資格情報あり・同じ Threads の利用者<br>・まだただ1人の所有者で、**epoch と lifecycle_version が begin のときと同じ**<br>・同じ state の2回目は拒否<br>再接続は、新しい state の結び付けで置き換える |
| `binding_row(account)` | G4-03 の `ThreadsAccountRow` の形。2つの数は **10進の文字列**（`::text`）。結び付けが無いか、アカウントが結び付けた Threads の利用者・ワークスペースでなくなっていれば、結び付けの列は null |

- 拒否はすべて例外を出す。呼び手のトランザクション（PR #124 の begin／complete と同じ）ごと取り消されるので、次のどれも残らない: 消費された state、保存されたトークン、結び付け。
- **時刻では判定しない**（G5-04 と同じ）。
- 前提:
  - superuser でないこと。
  - 表が同じ owner のものであること。
  - `common_accounts.lifecycle_version` が bigint であること。
  - PR #124 の begin／complete・G5 の `account_lifecycle_brand_owner`・F5 の epoch の getter と coverage が、同じ owner のものとして存在すること。
  - coverage が true であること。
  - 2回目の適用ではないこと。
- 事後の確認: 3つの関数が owner・definer・空の search_path で、API の役割がスキーマ・表・関数に届かないこと。

## 2. 閉じること・閉じないこと
- 閉じること:
  - begin から callback の間の **所有者 A→B→A**（epoch の変化）
  - **サービスの終了と再開**（lifecycle_version の変化）
  - 別の人・別のワークスペース・別の Threads の利用者
  - 記録の無い古い state
  - 二重の記録・二重の attest（同時でも1件だけ）
  - complete の前の attest
- **閉じないこと（ブロッカー、仮に許していない）**:
  - 呼び手が無い。H5 の owner transport が、begin の直後に `record_state_generation`、complete の直後に `attest_binding` を、**新しい R1 の allow の数**で呼ぶ必要がある（G4-06 の adapter）。
  - ところが R1 はワークスペースを必要とし、初めての接続の begin はワークスペースを作る。G5 が begin の認可を決めていない（Issue #320 コメント 6279536652／6279934094）。
  - それまで、何もこの候補を呼ばない（PR #124 の今の行には数が無いので、G4-03 は `BIND_EPOCH_UNRECORDED` で拒否する）。
- 利用権のキーは SQL では名指ししていない。使うときの判定は G5 の W1／W2 が保存した数で行う。G5 の `x_autopost` の採用・実接続は別の承認。
- G3 の予約の世代の記録は G3 の持ち物で、触っていない（G4-08 で1回連絡済み）。

## 3. 証明（`supabase/tests/postona_threads_binding_epoch_run.sh`、使い捨ての PG17.11、ローカルの Unix socket）
| 段階 | 結果 |
|---|---|
| 世界: G5 の本物の migration（T13・Phase 4・ブランドの状態・Phase 6）＋ F5 PR #303 の owner epoch ＋ X のオンボーディングの表 ＋ 2a-2 ＋ PR #124 | PASS |
| 前提の拒否: superuser・F5 の getter の欠落・coverage の欠落（代役）・PR #124 の欠落・G5 の brand owner の欠落 | PASS |
| 再適用の拒否、rollback、rollback の2回目の拒否、再適用 | PASS |
| 振る舞い（`postona_threads_binding_epoch_behavior.sql`） | PASS |
| 2つの接続での同時の attest（2つ目は1つ目を待って `THREADS_BINDING_ALREADY_ATTESTED`、結び付けは1件） | PASS |
| ミューテーション | **17/17 を検出** |

- 振る舞いで確かめたこと:
  - API の役割（anon・authenticated・service_role）からは、関数・表のどれにも届かない（42501）。
  - 正常の流れでは、結び付けの行に2つの数が **text** で、結び付けた人と state が入る。
  - record の拒否:
    - 別の epoch・別の lifecycle・0・null・別の人・消費済み・2回目・期限切れ
    - **拒否のたびに何も変わらない**（社会アカウント・state・Vault・2つの表の snapshot が同じ）
  - attest の拒否:
    - 記録の無い state（complete ごと取り消され、state は未消費・資格情報なし）
    - **A→B→A**
    - **終了と再開**（lifecycle_version を +2。SYNTHETIC: 本物の終了・再開の RPC ではなく、同じ列を直接上げた）
    - 別の人・別の Threads の利用者・complete の前・形の悪い ID・再送（attest の再送は `ALREADY_ATTESTED`、callback の再送は PR #124 が先に拒否）・2人の所有者
  - 再接続で結び付けが置き換わる（1件のまま）。
  - 結び付けの行:
    - 結び付けなし・別の Threads の利用者になったアカウントでは列が null。
    - 接続の解除の後は状態が unconnected（G4-03 が拒否する）。
  - 2^53 を超える lifecycle_version（9007199254740993）が、同じ10進の文字列で戻る。
  - state の削除で記録も消える（cascade）。
- ミューテーション（17種）:
  - attest の epoch／lifecycle の比較の削除
  - record の epoch／lifecycle の比較の削除
  - 記録の無い state を通す
  - 別の人の attest を通す
  - 別の Threads の利用者を通す
  - attest の再送を通す
  - complete の前を通す
  - 消費済み・期限切れ・別の人の record を通す
  - 所有者の確認の削除
  - 数を bigint で返す
  - アカウントの ID の照合の削除
  - API の役割への付与
  - 0 の入力を通す
- 試験の作り方で直したこと（正直に）:
  - 最初の「数を bigint で返す」の変異は、宣言が text のため PostgreSQL が自動で text に直し、等価だった。宣言の型ごと変える形に直した。
  - 「API の役割への付与」の変異は、付与を取り消しの前に入れていて無効だったので、事後の確認の前に入れる形に直した。
  - F5 PR #303 の前提（API の役割が membership に trigger を作れないこと）は、F5 自身の試験と同じく、試験の世界だけで revoke した。本番での対応は F3／G3 の作業。
- 外への通信・本物の Supabase・Vault・OAuth・トークン・Threads は0回。
- NOT_VERIFIED:
  - 管理環境の Supabase（Auth・PostgREST・Vault・ACL）
  - H5 の owner transport からの呼び出し
  - 本物の終了・再開・退会の RPC の流れ（lifecycle_version の変化は直接の更新で代用した）
  - G5 の W1／W2（PR #358）との結合
  - 本番

## 4. 再実行
```
PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH TB_PGHOST=/private/tmp/<socket-dir> TB_PGPORT=<port> TB_PGSUPER=<local superuser> \
  bash supabase/tests/postona_threads_binding_epoch_run.sh
```
- 前提: PR #178・#303 の git の objects が手元にあること。
- クラスターは `LC_ALL=C` で起動し、`lc_messages=C` にすること。

## 5. 行っていないこと
- PR #124 の SQL の変更・適用
- 共有の schema・GRANT・RLS・RPC・SECURITY DEFINER の本物への適用
- 管理環境の DB／Auth／Edge／Cron、Vault／トークン／秘密
- 本物の Meta／X／Threads・投稿、ゲートを開くこと
- main への push、マージ、デプロイ
- G5／G3 のファイル・他の枠の checkout の操作
