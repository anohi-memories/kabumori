# G4-14：PR #388 の「同じトランザクションの確認」の P2 の修正（complete と結び付けを1つの入口に）（隔離 PG17）（2026-10-21 JST）

- task_id: `postona-g4-pr388-attest-transaction-identity-p2-source-fix-20261020`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY_FIX_CANDIDATE／PRODUCTION_NO_GO（未適用、使い捨ての PG17 だけで証明）**。
  - 受け入れの後、H2 #329 で Codex Sol（高）の独立の再レビューが要る。
  - 安全の PASS・PRODUCTION_GO とは言わない。
- 土台: PR #388 の head `5bf6f915353eadb4e1425ae6aec3d281ac36c8a8` から、新しいブランチ。PR #388・#367・#377 の head は**変えていない**。
- 元の指摘: H2 #329 コメント 6293252401（REPORT、CHANGES_REQUIRED_P2）、6293287152（ACCEPT）。

## 1. 問題（H2 C2 R1）
- PR #388 の `attest_binding` は、「PR #124 の complete と同じトランザクションの中だけ」を `consumed_at = now()` で確かめていた。
- `now()` はトランザクションの**開始時刻**で、トランザクションの識別子ではない。別の接続で同じマイクロ秒に始まったトランザクションは同じ `now()` を持つ。
- そのため、次の2つが起きた（H2 が独立の PG17 で再現）。
  - A: 別のトランザクションで commit した complete の state を、もう一方のトランザクションから attest できた。
  - B: attest 側を rollback しても、complete の書き込み（state の消費・資格情報の参照）は残った。

## 2. 直したこと（`supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql`）
**時刻・xmin・目印の比較はやめた。代わりに、別の attest の入口そのものを無くした。**

- 新しい入口 `postona_threads_binding.complete_and_attest_binding(state, threads_user_id, handle, token, attestation)`（owner だけ、SECURITY DEFINER、空の search_path）。
  1. 入力と、JWT の claims の本人（`auth.uid()`）があることを確かめる。
  2. **呼ぶたびに**、これから呼ぶ PR #124 の complete が、レビュー済みの本体（ソースの md5 を固定）で、同じ owner、SECURITY DEFINER、空の search_path、**owner 以外に実行権が無い**ことを確かめる。違えば `THREADS_BINDING_COMPLETE_UNPINNED`。
  3. **PR #124 の complete を、この関数の中から呼ぶ**（T13 の確認・ワークスペース・state の順は PR #124 のまま）。
  4. 続けて、G4-13 までと同じ結び付けの確認（記録済みの state、始めた本人、state ごとに一度だけ、アカウントの形、唯一の所有者、owner epoch と lifecycle_version）をして、結び付けを書く。
- **なぜ「同じトランザクション」が証明になるか（時計に頼らない）**:
  - PR #124 の complete は、state を `UPDATE ... WHERE consumed_at IS NULL` で取り、取れなければ `THREADS_OAUTH_STATE_NOT_CONSUMABLE` で失敗する。
  - だから complete が戻ってきたら、**この呼び出しが**その state を消費した。
  - 消費と結び付けは**1つの SQL 文（1回の関数の呼び出し）**の中にあるので、両方 commit されるか、両方取り消されるかのどちらかしかない。savepoint や呼び出し側の rollback でも、両方が一緒に取り消される。
- 単独の `attest_binding` は**削除**した。事後の確認で、スキーマの関数が**ちょうど3つ**であることも確かめる（`THREADS_BINDING_POSTCONDITION_INVENTORY`）。
- 適用時の前提を2つ足した:
  - PR #124 の complete がレビュー済みの本体でない → `THREADS_BINDING_PRECONDITION_COMPLETE_UNPINNED`
  - PR #124 の complete に owner 以外の実行権がある → `THREADS_BINDING_PRECONDITION_COMPLETE_EXPOSED`
  - `auth.uid()` も依存として確かめる。
- G4-13 の修正（ACL を1つずつ確かめる、API の役割が owner になれないこと、`attested_at` で state ごとに一度だけ）は、そのまま残した。
- rollback の SQL は、作るものが同じスキーマの中だけなので変更不要。

### PR #124 の complete を単独で呼んだ場合
- 入口の外で complete だけを呼ぶと、state は消費され、資格情報の参照も書かれるが、**結び付けは無い**。その state は二度と結び付けられない（入口の中の complete が、消費済みの state を拒否する）。
  - 結び付けが無いので、PR #377 の `credential_row` などの結び付けを見る読み取りは、新しい接続を通さない（fail-closed）。
  - ただし、前の接続の結び付けが残っているアカウントで、同じ Threads の利用者のトークンを置き換えた場合は、前の結び付けの数（owner epoch・lifecycle_version）のまま使われうる。G5 の W1 がその数で判定するので、権限が広がるわけではない。それでも、**入口の外で complete を呼ばない**ことを、次の H5 の条件にした。
- これを防ぐため、PR #124 の complete に owner 以外の実行権があれば、適用も呼び出しも拒否する。
  - **PR #124 の今の計画（有効化の migration で authenticated に complete の EXECUTE を付ける）は、この設計とぶつかる**。complete は owner だけのままにして、Threads の callback は入口だけを通す必要がある（begin と consume の付与は、この候補では判断しない）。

### H5 の owner transport の必要条件
1. begin の直後に、新しい R1 の許可の2つの数で `record_state_generation` を呼ぶ（G4-06 の adapter）。
2. Threads の callback の完了は、**`complete_and_attest_binding` だけ**で行う。その同じトランザクションに、本人の JWT の claims を設定する（claims はトランザクションの中だけで有効）。
3. PR #124 の complete を直接呼ばない。どの役割にも付与しない。
4. 結果が失敗なら、呼び出し側は何も残らない（全部取り消される）前提で、本人に再接続を案内する。

## 3. 証明（`supabase/tests/postona_threads_binding_epoch_run.sh`、PostgreSQL 17.11、ローカルの socket）
| 段階 | 結果 |
|---|---|
| 世界（G4-09 と同じ: G5 の本物の T13・Phase 4・ブランドの状態・Phase 6、F5 PR #303 の owner epoch、2a-2、PR #124） | PASS（固定した md5 が、PR #124 の候補の本体と一致） |
| 深い役割の構成: authenticated → hop1 → hop2 → leaf（すべて INHERIT FALSE・SET TRUE）。leaf に既定の ACL で関数の EXECUTE、または表の8種の権限すべて | PASS（どちらも拒否） |
| authenticator → hop1 → owner（SET だけの2段） | PASS（`OWNER_REACHABLE authenticator` で拒否） |
| PR #367 の修正前の失敗の再現（G4-13 から維持） | PASS（`true,true,true,false`） |
| 前提の拒否（G4-13 の分 ＋ **PR #124 の complete が authenticated に付与されている／本体が違う**） | PASS |
| H2 の既定の ACL の形（関数・スキーマ・表）、再適用の拒否、rollback、2回目の rollback の拒否、再適用 | PASS |
| 振る舞い（下の表） | PASS |
| 同時実行: 1つの state に入口の呼び出しを2つ（2つ目は待って PR #124 が拒否。結び付け1件、attest 済みの state 1件） | PASS |
| **同じ開始時刻・別のトランザクション**（下の表） | PASS |
| ミューテーション | **28/28 を検出** |

### 同じ開始時刻・別のトランザクション（`postona_threads_binding_epoch_collision.mjs`）
- 24 の psql の接続で同時に BEGIN し、`now()` が同じで `pg_current_xact_id()` が違う2つが見つかるまで繰り返す。時計・state・カタログは書き換えない。

| 版 | 場面 | 結果 |
|---|---|---|
| **修正前**（PR #388 の `5bf6f915` の 001） | A: X で complete を commit。Y（同じ `now()`、別の XID）で直接 attest | **OK になってしまう**（Y から見て `consumed_at = now()` は true）。消費・資格情報の参照・attest・結び付けがすべて残る。H2 の再現 A と同じ |
| 修正前 | B: X で complete を commit。Y で attest して ROLLBACK | **attest は OK、ROLLBACK の後も消費と資格情報の参照が残る**（attest なし、結び付けなし）。H2 の再現 B と同じ |
| **修正後** | A': X で PR #124 の complete だけを commit。Y（同じ `now()`、別の XID）から | 直接の attest は**関数が存在しない**。入口は `THREADS_OAUTH_STATE_NOT_CONSUMABLE`。結び付けも attest も無い |
| 修正後 | B': Y で入口が成功した後に ROLLBACK。続けて X（同じ `now()`）で入口 | Y の ROLLBACK で**消費・資格情報の参照・attest・結び付けがすべて取り消される**。その後 X は通常どおり結び付けまで commit できる |

- 実測の例（commit `0424cdd4` での実行）: A は1回目の試行で `1792510582.026310`（XID 9474 と 9473）、B は1回目で `1792510582.041697`（9500 と 9498）、A' は4回目で `1792510582.272569`（9647 と 9643）、B' は2回目で `1792510582.285210`（9687 と 9683）。数は実行ごとに変わる。

### 振る舞い（`supabase/tests/postona_threads_binding_epoch_behavior.sql`）
- G4-09〜G4-13 の確認は、入口に合わせて書き直して維持した:
  - 普通の接続、別の owner epoch・lifecycle_version、記録されていない state、A→B→A、終了と再開（SYNTHETIC）、2人の所有者、期限切れ・消費済み、2^53 を超える数、cascade
  - 拒否のたびに書き込み0（snapshot が同じ）
- 新しい確認:
  - **0b**: `attest_binding` は存在しない。スキーマの関数は3つちょうど。
  - **6**: 別の人の claims で他人の state を完了しようとすると、PR #124 が拒否する。login の無い人の claims は G5 の T13 が拒否する。claims が無いと `THREADS_BINDING_INPUT_INVALID`。
  - **7b**: S1→S2→S1。S1 の callback は PR #124 が拒否する。仮に別の欠陥で消費済みの state が戻っても（SYNTHETIC）、`ALREADY_ATTESTED` で何も変わらない。結び付けは S2 のまま。
  - **7c**: 直接の attest の入口は無い。complete だけを先に commit すると、その後の入口は拒否する。同じトランザクションの中で complete を先に呼んでから入口を呼んでも拒否し、両方取り消される。
  - **7d**: 入口の成功の後に、savepoint の rollback、またはトランザクション全体の rollback をすると、complete も一緒に取り消される（消費なし、資格情報の参照なし、結び付けなし）。その後、同じ state で普通に接続できる。
  - **11**: PR #124 の complete が authenticated に付与された／SECURITY INVOKER にされた／本体が変えられた場合、入口は何かを取る前に `THREADS_BINDING_COMPLETE_UNPINNED` で拒否する。

### ミューテーション（28種、すべて検出）
- 前からのもの: owner epoch・lifecycle_version・記録・所有者・一度だけ・`attested_at`・行の形・API の役割・入力の確認と、適用時の ACL の確認3種、owner への到達の前提。
  - owner への到達の前提を外すものは、F5 の coverage の確認も同じ状態を拒否する（二重の守り）。G4-13 と同じ扱い。
- 新しいもの:
  - 入口が complete を呼ばない
  - 本体の md5 の確認を外す
  - 実行権の確認を外す
  - SECURITY DEFINER の確認を外す
  - claims の本人の確認を外す
  - 別の attest の関数を残す
  - 適用時の本体の確認を外す
  - 適用時の付与の確認を外す
- **等価なので数えていないもの**:
  - 始めた本人の確認: PR #124 の complete が `initiated_by_user_id = auth.uid()` を求め、記録もその本人だけなので、外しても答えは変わらない。
  - Threads の利用者の一致: complete が同じ値を書くので、外しても変わらない。
  - 「消費済み」の確認: complete が戻った時点で必ず消費済み。
  - スキーマの関数の数の確認だけを外すもの: 別の attest を残すミューテーションは、振る舞いの 0b でも検出される（二重の守り）。適用の途中で他から関数が入る世界は作れないので、単独では数えていない。
- 関数の ACL が null の確認は、G4-13 と同じく等価として数えていない。

### その他
- Threads の TS の回帰（`--no-config --no-check --allow-read=. --deny-net`、パスに threads を含む23ファイル）: 295 passed／0 failed（TS は変更なし）。
- 外への通信・本物の Supabase・Vault・OAuth・トークン・Threads は0回（偽の値だけ）。
- 必要なもの: Homebrew の PostgreSQL 17、node（5b の同時の接続のため）。
- NOT_VERIFIED:
  - 管理環境の役割の構成と、PR #124 の有効化の付与の実際
  - H5 の owner transport の本物の組み込み
  - 本物の終了・再開・退会の RPC の流れ
  - G5 PR #358／#371 の W1・R0 との結合
  - 本番

## 4. この修正の外で、未解決のまま（今回は変えていない）
- **PR #124 の有効化の計画とのぶつかり**（上の §2）。complete を authenticated に付与しないことの合意が要る。
- **PR #377**（H2 の CHANGES_REQUIRED P2）: `credential_row` の期限の確認が `now()` であること、依存の STABLE→VOLATILE の後からの変更。
- **G3 U8**（Threads の `publish_enabled` の CHECK と 007 の食い違い）、**G3 U9**（世代が動いた後の再接続の案内が無い）。
- **G5 R0**（本物の RPC は未接続、begin の認可は未決定）、**H5**（本物のトークンの保管と Vault の書き手、owner transport）。
- `record_state_generation` は、begin と同じトランザクションかどうかを確かめていない。記録の時点で今の DB の数と一致することを確かめ、完了の時にもう一度確かめるので、安全性はそれに頼っていない（今回は変えていない）。
- X の OAuth の PR #353／#355 は、引き続きマージ・配備しない。

## 5. 行っていないこと
- `supabase/migrations`、管理環境・本番の DB／Auth／RLS／RPC／SECURITY DEFINER／GRANT／REVOKE の本物への適用
- Vault・トークン、Meta／X／Threads の本物の API・投稿、Edge／Cron、有料の API、ゲートを開くこと
- main への push、マージ、デプロイ、force push
- PR #388・#367・#377 の既存の head の変更、G3／G5／H5 のパス、他の枠の worktree
