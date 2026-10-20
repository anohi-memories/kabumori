# G4-15：PR #377（Threads の資格情報の読み取り）の期限の確認の P2 の修正（隔離 PG17）（2026-10-21 JST）

- task_id: `postona-g4-pr377-credential-expiry-clock-p2-source-fix-20261021`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY_FIX_CANDIDATE／PRODUCTION_NO_GO（未適用、使い捨ての PG17 だけで証明）**。独立のセキュリティレビューは別のゲート。
- 土台: PR #377 の head `afab36d977bbc5588f4dce283bd5f05521b41733` から、新しいブランチ。PR #377・#405・#124 の head は**変えていない**。
- 元の指摘: H2 #329 コメント 6288164206（REPORT、CHANGES_REQUIRED_P2）、6288206500（ACCEPT）。

## 1. 問題（H2 C2 R1）
- `credential_row` は、保管の期限を `expires_at > now()` で確かめていた。
- `now()` はトランザクションの**開始時刻**。期限より前に始まったトランザクションの中では、期限を過ぎても「未来」と判定され、**期限切れのトークンを返し続けた**（H2 が独立の PG17 で再現）。

## 2. 直したこと（`supabase/candidates/postona_threads_credential_atomic/001_threads_credential_atomic.sql`）
1. **取り出す時点の時計で比べる**: `expires_at > clock_timestamp()`（厳密。等しければ期限切れ）。同じ1つの SELECT の中で比べる。
2. **関数の区分を VOLATILE にした**（時計を読むので STABLE は正しくない）。事後の確認も `provolatile = 'v'` を求める。
3. **READ COMMITTED のときだけ行を返す**（REPEATABLE READ・SERIALIZABLE では行なし）。
   - VOLATILE の関数は、READ COMMITTED では自分の SELECT の開始時に新しい snapshot を取る。だから、判断・トークン・世代はすべて「取り出した時点」のもの。
   - REPEATABLE READ などでは snapshot がトランザクションの最初のもののまま。その後に commit された取り消し（結び付けの削除、入れ替え、所有者やサービスの変化）が見えない。修正前の版では、長い REPEATABLE READ のトランザクションで**取り消した資格情報も返った**（今回の runner で再現。H2 の指摘と同じ種類の「古い時点で判断する」問題として足した）。
   - G5 の T13 も READ COMMITTED 以外を拒否するので、同じ前提に揃う。
4. **依存の関数を、呼ぶたびに同じ文の中で確かめる**: 4つの依存（G5 の brand owner と W1、G4 の保管の読み取り口、G3 の世代）が、今も存在し、同じ owner で、STABLE であること。どれかが違えば行なし。
   - H2 の DDL drift の再現（適用の後に G3 の世代の関数を VOLATILE にすると、古いトークンと新しい世代の組が返る）は、この確認で**行なし**になる（振る舞いの 16）。
- **トークンと世代は、今までどおり1つの SELECT（1つの snapshot）から返る**。VOLATILE にしても、関数の中は1つの文なので snapshot は1つ。その中から呼ぶ STABLE の依存は、同じ snapshot を使う。入れ替えの同時実行の試験（race）も、修正前と同じく PASS。

## 3. 証明（`supabase/tests/postona_threads_credential_atomic_run.sh`、PostgreSQL 17.11、ローカルの socket）
| 段階 | 結果 |
|---|---|
| 世界（G5 の本物の T13・Phase 4・ブランドの状態・Phase 6、F5 PR #303、2a-2、PR #124、G4 の保管、G4 PR #367 の結び付け、G5 PR #358 の R1／W1、G3 PR #374 の世代の関数） | PASS |
| 前提の拒否（G4-11 の7種）、H2 の委任の形、再適用、rollback、2回目の rollback、再適用 | PASS |
| 振る舞い（G4-11 の全部 ＋ 新しい 14〜16） | PASS |
| 入れ替えの同時実行（commit 前は前の組、後は新しいトークンと新しい世代。組は混ざらない） | PASS |
| **修正前の失敗の再現と修正後**（下の表） | PASS |
| ミューテーション | **16/16 を検出**（等価3件は別に表示） |

### 修正前の失敗の再現と修正後（5b、2つの接続を使う）
| 場面 | 修正前（PR #377 `afab36d9` の 001） | 修正後 |
|---|---|---|
| 期限を「1秒後」で commit し、別のトランザクションを開いて 1.3 秒待ってから読む（時計では期限切れ／`now()` では未来／行の数） | `true|true|1`（**期限切れのトークンが返る**。H2 の再現と同じ） | `true|true|0` |
| REPEATABLE READ で読み、別の接続が結び付けを消して commit した後に、同じトランザクションでもう一度読む（前,後の行の数） | `1,1`（**取り消した資格情報が返る**） | `0,0`（REPEATABLE READ では返さない） |
| 同じことを READ COMMITTED で（前,後） | （対象外） | `1,0`（取り消しが見える） |

### 振る舞いの新しい確認（`supabase/tests/postona_threads_credential_atomic_behavior.sql`）
- **14 期限の境界**:
  - 2秒後の期限 → 行あり。
  - 1ミリ秒前に期限切れ → 行なし。
  - 期限を「その時の時計」に設定 → その後の読み取りでは行なし（等しいは期限切れ）。
  - H2 の再現の形（期限前に開いたトランザクションの中で期限を過ぎる）→ 行なし。このとき「時計では期限切れ、`now()` では未来」であることも同じトランザクションで確かめた。
  - **1つの文の中**（DO ブロック、`now()` も `statement_timestamp()` も変わらない）で、期限を過ぎる前は行あり、過ぎた後は行なし。
  - 期限を未来に戻すと、同じ資格情報がまた返る（読み取りは何も書いていない）。
- **15 分離レベル**: REPEATABLE READ・SERIALIZABLE では行なし。READ COMMITTED（明示）では行あり。
- **16 依存の変化**: G3 の世代・W1・保管の読み取り口・brand owner の関数を、それぞれ VOLATILE にすると行なし。STABLE に戻すと行あり。`credential_row` 自身は VOLATILE。

### ミューテーション（16種、すべて検出）
- G4-11 からのもの（キー、W1、W1 の active、結び付けの一致、結び付けた人、保管の期限、世代を別に計算、API への付与、適用時の確認4種）。
- 新しいもの:
  - 期限を `now()` に戻す
  - 期限を `statement_timestamp()` にする（1つの文の中の確認で検出）
  - 分離レベルの確認を外す
  - 呼ぶたびの依存の確認（STABLE）を外す
- **等価なので数えていないもの**（runner が別に表示）:
  - 期限の比較を `>=` にするもの: 読み取りのマイクロ秒と期限がちょうど等しい状態は作れない。厳密な `>` を残した。
  - identity_verified の確認、世代の 64 桁の確認: G4-11 と同じ理由。
- **単独では証明していないもの**: 呼ぶたびの「依存が同じ owner」の確認。owner を変える試験は作っていない（適用時の確認はある）。

### その他
- Deno の回帰（TS は変更なし）:
  - パスに threads を含む23ファイル（`--no-config --no-check --allow-read=. --deny-net`）: 295 passed／0 failed
  - 型チェック付き（`--config supabase/candidates/postona_threads_auth_runtime/wiring/deno.json --no-lock --cached-only --deny-net --allow-read`、`_shared/social/threads*_test.ts` と `g5_owner_epoch_token_test.ts`）: 190 passed／0 failed
  - `deno lint --no-config`（`_shared/social/threads*.ts`・`g5_*.ts`、32ファイル）: 問題なし
- 外への通信・本物の Supabase・Vault・OAuth・トークン・Threads は0回（Vault は fixture の表、トークンは偽物）。秘密の値はログに出していない（runner は行の数と真偽だけを表示する。race の確認だけは偽のトークンの文字列を比べる）。

## 4. 依存の関数の DDL drift（H2 の条件付きの限界）への契約
- **H2 の証拠**: 適用の後に、G3 の世代の関数を正規の owner が VOLATILE に変えると、古いトークンと新しい世代の組が返った（合成の DDL の変更。本番での発生や API の役割による変更を示すものではない）。
- **この候補でできるようになったこと**: 4つの依存が STABLE でなくなったら、その時点から行を返さない（停止）。振る舞いの 16 で確かめた。
- **この候補ではできないこと**（契約として残す）:
  - STABLE のまま本体を書き換えた場合（中で別の snapshot を取る処理を入れるなど）は、この文からは見えない。依存の本体の指紋（md5）を固定するかどうかは、G3（世代の関数の持ち主）・G5・H2 の判断。G4 は他の持ち主の関数を固定・変更していない。
- **運用の契約（提案）**: 4つの依存のどれかに DDL（CREATE OR REPLACE・ALTER・owner の変更）をするときは、次の順にする。
  1. 先に worker への資格情報の付与（またはゲート）を止める。
  2. 新しい定義でこの runner を再実行して PASS させる。
  3. H2 が再レビューする。
  4. その後で再開する。

## 5. 他の持ち主との IF と、未解決のまま（今回は変えていない）
- **PR #405 と PR #124 の有効化の計画の衝突**: PR #405 は、PR #124 の complete を owner だけのままにする前提。PR #124 は、有効化の migration で authenticated に complete の EXECUTE を付ける計画。合意が要る（PR #405 は付与があれば適用も呼び出しも拒否する）。
- **この候補の世界は PR #367（`fd714505`）の結び付け**。PR #405 の結び付け（表の形は同じ。入口が `complete_and_attest_binding` に変わった）との組み合わせは、今回の runner では NOT_VERIFIED。
- **G5** は PR #358 を固定している。H2 が使った PR #371 との組み合わせは、今回の runner では NOT_VERIFIED。G5 R0（本物の begin の認可）も未決定。
- **G3**:
  - U8（Threads の `publish_enabled` の CHECK と 007 の食い違い）と U9（世代が動いた後の再接続の案内）は、未解決。
  - 呼び出し側の条件: READ COMMITTED で呼ぶ。取り出したトークンはすぐに使う。送信の直前の確認（G3 の preflight・W2・beforePublish）は G3 の持ち物。期限の確認は「取り出した時点」のもので、HTTP の送信の時点を保証するものではない。
- **H5**: 本物のトークンの保管と Vault の書き手、owner transport、延長の時の保管の更新。どれも未接続。
- **新しく見つけた同じ種類の問題（今回は直していない）**: G4 の保管の記録 `public.record_threads_credential_custody`（`supabase/candidates/postona_threads_publish/threads_credential_custody_candidate.sql`）は、「接続を確かめたのと同じトランザクションだけ」を `verified_at = now()` で確かめている。これは H2 が PR #388 で指摘した「時刻の一致はトランザクションの識別子にならない」と同じ形。
  - owner だけの関数なので、API の役割からは届かない。
  - 直し方の案: PR #405 の1つの入口（complete と結び付け）に、保管の記録も含める。別の TASK で扱う。

## 6. 行っていないこと
- `supabase/migrations`、管理環境・本番の DB／Auth／RLS／RPC／Edge／Cron／GRANT／REVOKE の本物への適用
- 本物の Vault・トークン、Meta／X／Threads の OAuth・API・投稿、有料の API、ゲートを開くこと
- main への push、マージ、デプロイ、force push
- PR #377・#405・#124 の既存の head の変更、G3／G5／H5 のソース、他の枠の worktree
