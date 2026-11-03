# G4-16：Threads の資格情報の保管の記録（custody）の「同じトランザクション」の確認の修正（隔離 PG17）（2026-10-21 JST）

- task_id: `postona-g4-threads-custody-verified-at-transaction-proof-source-fix-20261021`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY_FIX_CANDIDATE／PRODUCTION_NO_GO（未適用、使い捨ての PG17 だけで証明）**。独立のセキュリティレビューは別のゲート。
- 土台: PR #405 の head `80667ffb788836722eb8d98190eaa874e6d5acc4` から、新しいブランチ。PR #405・#412・#124・#377 の head は**変えていない**。
- きっかけ: G4-15 の REPORT（#319 6303374129）で見つけた、同じ種類の問題。

## 1. 元の SQL が主張していたことと、実際に守れていたこと
- 対象: G4 の保管の候補 `supabase/candidates/postona_threads_publish/threads_credential_custody_candidate.sql` の書き込み関数 `public.record_threads_credential_custody(account, expires_at)`。
  - owner だけ（API の役割への付与なし）、SECURITY INVOKER。
  - 期限（`expires_at`）を、「接続を確かめたトランザクションの中でだけ」記録すると主張していた。その確認が `verified_at = now()`（PR #124 の complete は `verified_at = now()` を書く）。
  - 何のための主張か: 記録する期限が、**その接続で保存したトークンのもの**であること。読み取り口（`threads_account_credential_expires_at`）は、同じ Vault の参照で、最後の確認より後に記録された期限だけを返す。PR #412 の `credential_row` は、この期限で資格情報を出すかどうかを決める。
- **実際に守れていた範囲**（PG17 で実測）:
  - 開始時刻が違う後のトランザクションからの記録は、拒否される（runner 5c の「original writer, a later transaction with another now()」）。
  - **開始時刻が同じマイクロ秒の別のトランザクションからの記録は、通ってしまう**（下の C）。`now()` はトランザクションの開始時刻で、トランザクションの識別子ではない。PR #388 で H2 が指摘したのと同じ形。
- **影響の範囲（偽らない）**:
  - 書き込み関数は owner だけ。API の役割やアプリからは届かない。
  - 起きうるのは、owner の経路（H5 の owner transport）が、接続のトランザクションの**外**で記録してしまった場合（呼び出し側の不具合や、失敗した接続の後に続けて記録するなど）に、それが開始時刻の一致で通ること。結果は「期限が、そのトークンのものでない」こと（期限の取り違え）。権限が広がるわけではない。
  - 重大度は独立のレビューが判断する。G4 は P2 と確定しない。

## 2. 直したこと
### 001（`supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql`、PR #405 の入口）
- 入口 `complete_and_attest_binding` は、接続ごとに**ランダムな接続の証明**（uuid）を作る。
  - 結び付けの行に `connect_proof` として保存する（再接続のたびに新しい値）。
  - 同じ値を、**このトランザクションの中だけ**の設定 `postona_threads_binding.connect_proof` に置く。
    - COMMIT・ROLLBACK で消える。savepoint の rollback でも、結び付けと一緒に戻る。
    - SECURITY DEFINER の関数から戻った後も、トランザクションの終わりまで残る（試験 10b で確認）。
- 1つのトランザクションでの Threads の接続は1つ（2回目の入口が設定を置き換える。試験 C7）。

### 002（新しいファイル `supabase/candidates/postona_threads_binding_epoch/002_custody_connect_proof.sql`）と rollback
- custody の書き込み関数を、**同じ形のまま**入れ替える。
  - 形 = 名前・引数・VOID・SECURITY INVOKER・空の search_path・ACL。H5 の custody port（`postona_threads_auth_runtime/wiring/custody_port.ts`）が確かめている形。H5 のコードは変えていない。
- 変えたのは「同じトランザクション」の確認だけ:
  - 前: `verified_at = now()`。
  - 今: このトランザクションの設定の証明と、このアカウントの結び付けの `connect_proof` が一致し、その結び付けが**この人**が、**このワークスペース**と**この Threads の利用者**について作ったものであること。
  - 時刻は使わない。同じマイクロ秒に始まっただけの別のトランザクションには、証明が無い。
- そのほかの確認（期限の範囲、identity_verified、Vault の参照、所有者であること、claims）は、元のまま。
- 適用時の確認:
  - 001（G4-16 の版）が先に入っている（`connect_proof` の列と、入口が設定を置くこと）。PR #405 の版の 001 の上では拒否する。
  - 入れ替える書き込み関数が、custody の候補の元の本体であること（ソースの md5 を固定）。
  - superuser でない、API の役割が owner になれない、再適用の拒否（関数の comment を目印にする）。
  - 事後: 形（INVOKER・VOID・空の search_path・owner）と、ACL が owner だけであること。
- rollback: 元の書き込み関数を一字一句そのまま戻す（md5 で確認）。**001 の rollback より先に**行う。
- 証明は秘密ではない（ランダムな uuid で、トークンではない）。owner は表を読めるので手で設定することもできるが、owner はすべての表の持ち主なので信頼の範囲の外にはしていない。止めるのは「別のトランザクションから呼んだだけ」の場合。

### なぜ custody の書き込みを入口の中に入れなかったか
- TASK の案のとおり入口に入れると、書き込み関数を無くすか、引数を変える必要がある。
- そうすると、H5 の owner transport の custody port（書き込み関数の形を確かめて、complete の直後に呼ぶ）が動かなくなる。他の持ち主のコードの変更になる。
- そこで、入口が「このトランザクションで接続した」証明を残し、書き込み関数がそれを求める形にした。H5 が変える必要があるのは、PR #405 で既に必要になっている「complete の代わりに入口を呼ぶ」ことだけ。そのあと同じトランザクションで、今までどおり書き込み関数を呼べば通る。

## 3. 証明（`supabase/tests/postona_threads_binding_epoch_run.sh`、PostgreSQL 17.11、ローカルの socket）
| 段階 | 結果 |
|---|---|
| 世界（G4-14 と同じ ＋ G4 の custody の候補） | PASS |
| G4-14 までの全部（深い役割の構成、PR #367 の修正前、前提の拒否、振る舞い、同時実行、同じ `now()` の A・B・A'・B'） | PASS |
| 002 の前提の拒否（001 なし／PR #405 の 001（証明なし）の上／元と違う書き込み関数／superuser／authenticator が owner になれる／書き込み関数が委任先に付与済み）、再適用の拒否、rollback で元の関数に戻る（md5 一致）、2回目の rollback の拒否、再適用 | PASS |
| custody の振る舞い（下の C0〜C13） | PASS |
| **同じ開始時刻・別のトランザクション（custody）** | 修正前は再現（C）、修正後は拒否（C'） |
| ミューテーション | **41/41 を検出** |

### 同じ開始時刻・別のトランザクション（`postona_threads_binding_epoch_collision.mjs` の custody のモード）
| 版 | 場面 | 結果 |
|---|---|---|
| 修正前（001 ＋ custody の候補の元の書き込み関数） | **C**: X が入口だけを実行して commit（custody なし）。Y（同じ `now()`、別の XID）が、X の資格情報の期限を記録する | Y から見て `verified_at = now()` が true。記録が **OK** になり、読み取り口が期限を返す |
| 修正前 | 開始時刻が違う後のトランザクションから記録する | `THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION`（元の確認が守れていたのはこの場合だけ） |
| 修正後（001 ＋ 002） | **C'**: 同じ形 | `THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION`。何も記録されない |

### custody の振る舞い（`supabase/tests/postona_threads_binding_custody_behavior.sql`）
- **C0**: 書き込み関数の形（INVOKER・VOID・空の search_path・目印・`now()` の確認なし）、ACL は owner だけ。
- **C1**: 入口と記録を同じトランザクションで → 記録され、保存した Vault の参照の期限になる。トランザクションの外に証明は残らない。
- **C2**: 後のトランザクション（入口なし）では拒否。明示のトランザクションの中でも拒否。`verified_at` をそのトランザクションの `now()` にしても（SYNTHETIC）拒否。拒否で何も変わらない。
- **C3**: 入口を通さず PR #124 の complete だけを呼んでから記録 → 拒否、両方取り消し。
- **C4**: 再接続の入口を savepoint の中で実行して rollback → 証明も戻り、その後の記録は拒否。何も変わらない。
- **C5**: 入口と記録の後に ROLLBACK → 何も残らない。
- **C6**: A の入口の後に、別のアカウント B（前に接続済み）の記録 → 拒否。A の記録 → OK。
- **C7**: 1つのトランザクションで入口を2回（X、Y）→ X の記録は拒否、最後の Y は OK。
- **C8**: 2人目の所有者が、同じトランザクションで1人目の接続の期限を記録 → 拒否（結び付けた人が違う）。
- **C9**: 入口の後に、アカウントの Threads の利用者が変わった（SYNTHETIC）→ 拒否。
- **C10**: 再接続（新しい証明、新しい期限）→ 新しい期限になる。
- **C11**: 証明はランダムな uuid で、結び付けの値と同じ。トークンを含まない。custody の行にもトークンは無い。
- **C12**: 期限の範囲（過去、62日後）と claims なしは、元のとおり拒否。
- **C13**: API の役割は書き込み関数に届かない。
- binding の振る舞い **10b**: 入口の後、同じトランザクションの設定が結び付けの証明と一致する（関数から戻った後も）。COMMIT の後は消える。再接続で新しい証明になる。

### ミューテーション（41種）
- G4-14 からの 28 種（すべて検出）。
- 001 の証明 4 種:
  - 設定を置かない
  - セッション全体に置く（is_local = false）
  - 違う値を保存する
  - 再接続で古い証明を残す
- 002 の振る舞い 5 種:
  - 確認を外す
  - 証明を比べない
  - 結び付けた人を見ない
  - Threads の利用者を見ない
  - `verified_at = now()` に戻す
- 002 の適用時 4 種（不利な世界で適用できてしまえば検出）:
  - 元の書き込み関数の固定を外す
  - ACL の事後の確認を弱める
  - owner への到達の前提を外す
  - 001 の確認を外す

### その他
- Deno（TS は変更なし）:
  - パスに threads を含む23ファイル（`--no-config --no-check --allow-read=. --deny-net`）: 295 passed
  - 型チェック付き（wiring の deno.json）: 190 passed
  - `deno lint`: 32ファイル問題なし
- 外への通信・本物の Supabase・Vault・OAuth・トークン・Threads は0回（偽の値だけ）。拒否のたびに snapshot は変わらない。

## 4. 他の持ち主との IF と、未解決のまま
- **H5（owner transport）**:
  - Threads の接続は、PR #124 の complete ではなく PR #405 の入口を呼び、同じトランザクションで custody の書き込み関数を呼ぶ。complete の直後に呼ぶ今の形は、002 では拒否される（C3）。
  - 1つのトランザクションでの接続は1つ。
  - H5 のコードは変えていない。H5 の custody port の形の確認は、002 の後も通る形にした（実際に H5 の port を動かす確認は NOT_VERIFIED）。
- **PR #405 と PR #124 の有効化の計画の衝突**: 未解決。complete を authenticated に付与する計画とは両立しない。
- **PR #412**（期限の確認の修正）: 独立のレビュー待ち。今回は変えていない。PR #412 の世界は PR #367 の結び付けと元の custody の書き込み関数で、001（G4-16）・002 との組み合わせは NOT_VERIFIED。
- **G5 PR #371**、**G3 U8／U9**、**H5 の本物のトークン・Vault の書き手**: NOT_VERIFIED／未解決。
- **同じ種類の観察（再現していない。今回は扱っていない）**:
  - 延長の候補 `threads_credential_rotation_candidate.sql` の compare-and-set は、custody の `recorded_at`（`now()` で書く）を版として比べている。
  - 開始時刻が同じトランザクションどうしで版が一致しうるかは、リース（1回限り）・Vault の参照の一致・行のロックとの組み合わせで確かめる必要がある。
  - 別の TASK の候補。
- 002 は、custody の候補のファイルそのものは変えていない（後から適用して関数を入れ替える）。custody の候補を単独で使う古い試験（release・integration など）は、今までどおり元の書き込み関数で動く。

## 5. 行っていないこと
- `supabase/migrations`、管理環境・本番の DB／Auth／RLS／RPC／Edge／Cron／Vault／GRANT／REVOKE の本物への適用
- 本物の Meta／X／Threads の OAuth・投稿、トークン、有料の API、ゲートを開くこと
- main への push、マージ、デプロイ、force push
- PR #124・#405・#412・#377 の既存の head の変更、G3／G5／H5 のソース、他の枠の worktree
