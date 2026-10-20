# G3｜`public.brand_memberships` の API の役割の権限を絞る候補（2026-10-20、Issue #318 TASK 8/50）

- task_id: `postona-g3-brand-memberships-api-ddl-privilege-isolated-20261020`
- 返却先: POSTONA G3のちゃ
- 完了コード: K3
- 判定: **SOURCE_ONLY（使い捨て PG17 の模擬スキーマ。権限の照会と安全な正常系だけ）／本番 NO_GO**
- 根拠: G5 PR #303（`88481aefaf5488adb2735161ec76fa8ea7046260`）の L-1 と §7 の 0 番。G5 PR #358（`4f4ece89af51a345c0e71cb3876278789a4f3896`）の R1・W1・W2 の install も同じ検査を通る。
- 積み順: origin/main（`0c42933ca5030ab31a56267529430d0473d9b155`）の上。G3 の Threads の PR（#334〜#360）には依存しない。
- **本番の実際の付与は UNKNOWN**（managed の DB は読んでいない。読むにも別の承認が要る）。

## 0. 作業範囲の改訂（安全性チェックによる拒否の記録）
- 元の TASK には、「取り上げる前の権限で何ができてしまうか」を実際に動かして見せる手順が含まれていた。
- その手順を組み立てる Claude の応答が、2026-10-20 に安全性チェックで止められた。止められたのは Claude の応答の生成で、ツールの呼び出しではない。止められる前に実行したのは、PR #303 のファイルを読むことと、PR #360 のランナーを読むことだけ。DB・ファイル・GitHub は何も変えていない。
- G3担当ちゃが、同じ task_id のまま範囲を改訂した（2026-10-20 13:52 JST の Issue 本文）。
  - 使ってよいのは、権限の照会（システムカタログと `has_table_privilege`）と、安全な正常系だけ。
  - 攻撃・回避・スキーマを壊す操作の実演と再現はしない。権限を足すこと、悪用につながる役割の切り替えもしない。
- そのため、**「この権限で実際に何ができるか」は実演で確かめていない（NOT_VERIFIED）**。危険の根拠は G5 PR #303 の文書（L-1）と PostgreSQL の権限の定義だけ。

## 1. リポジトリの読み取り監査（main、読むだけ）

| 項目 | 内容 | 根拠 |
|---|---|---|
| 表の定義 | `brand_id text`・`user_id uuid`・`role text`（owner / admin / member / viewer）・主キー `(brand_id, user_id)`。`brands` と `auth.users` への外部キーは on delete cascade。 | `20260918120000_social_mobile_brand_memberships.sql` |
| RLS | 有効（FORCE はしていない）。ポリシーは `social_mobile_membership_self_select`（authenticated が自分の行だけ SELECT できる）の 1 つ。 | 同上 |
| 付与 | `grant select … to authenticated`・`revoke all … from anon`・`revoke insert, update, delete … from anon, authenticated` だけ。**TRIGGER・TRUNCATE・REFERENCES は扱っていない**。新しい表の既定の付与が残る [A]。 | 同上。main の migration で、この表に付与・取り上げをするのは、この 3 行だけ。 |
| 書き込む人 | X の接続 RPC（`20260919120000`・`20260922003101`、SECURITY DEFINER）。削除の流れ（`20260928160000`、cascade）。service_role。どれも表の owner か service_role の権限で書く。 | 各 migration |
| トリガー | `social_mobile_deletion_guard`（BEFORE INSERT OR UPDATE）。G5 PR #303 の install が、AFTER のトリガーを 2 つ足す。 | `20260928160000`、PR #303 |
| この表を参照する外部キー | main には無い。 | `git grep "references public.brand_memberships"` が 0 件 |
| TRUNCATE | main の migration と Edge には無い。 | `git grep` が 0 件 |
| Edge・アプリ・管理画面 | どれも SELECT だけ。利用者のトークンで RLS を通して読む（`social-mobile-consult`・`social-mobile-brand-dry-run`・`social-mobile-history-learning`・`apps/social-mobile`・`apps/admin`）。 | 各ファイル |
| G3 の予約候補 | X の予約（`postona_x_reservations/001`）は、definer の関数の中で SELECT するだけ。Threads の 007 は、表を直接は読まない（F5 の所有者の関数を通す）。 | PR #360 の木 |

**必要な権限（最小）**:
- authenticated: SELECT（行は RLS が決める）
- service_role: SELECT・INSERT・UPDATE・DELETE
- 表の owner: すべて（definer の RPC と削除の流れ）
- anon・PUBLIC: なし
- TRIGGER・TRUNCATE・REFERENCES を API の役割が使う正当な道は、リポジトリに無い。

## 2. 候補（G3 の新しいフォルダ。`supabase/migrations/` の外）
`supabase/candidates/postona_brand_memberships_privileges/`

### `001_brand_memberships_api_privilege_revoke.sql`
- 取り上げるもの（G5 L-1 と同じ。PUBLIC を足した）:
  - `revoke trigger, truncate, references … from public, anon, authenticated`
  - `revoke trigger … from service_role`
- 残すもの: authenticated の SELECT、service_role の SELECT・INSERT・UPDATE・DELETE（と TRUNCATE・REFERENCES。L-1 の範囲外）、表の owner。
- 前提（どれかが成り立たなければ、何も変えずに止める）:
  - 表がある
  - 実行者が superuser でない
  - **実行者が表の owner**（owner 以外の REVOKE は警告だけで何も取り上げないため）
  - RLS が有効
  - 自分の行を読むポリシーがある
  - anon・authenticated・service_role がある
- ロック: `share row exclusive`（G5 PR #303 の install と同じ）、`lock_timeout` は 5 秒。書き込みは待ち、読み取りは待たない。
- 事後条件（カタログだけで判定。成り立たなければ全体を戻す）:
  - API の役割（anon・authenticated・service_role・authenticator）と、それらが MEMBER である全ての役割に、TRIGGER が無い
  - その中で anon・authenticated の側に、INSERT・UPDATE・DELETE・TRUNCATE・REFERENCES が無い
  - superuser と表の owner に届かない
  - `session_replication_role` を SET できない
  - anon・authenticated が BYPASSRLS でない
  - PUBLIC の ACL の項目が 0
  - authenticated の SELECT と、service_role の 4 つの DML が残っている
  - RLS が有効
  - ほかの付与者が与えた権限や、membership を通した権限は、この REVOKE では消えない。それでも事後条件の照会が見つけて止める。
- 何度当てても同じ（2 回目は何も取り上げず、同じ事後条件を確かめる）。

### `001_brand_memberships_api_privilege_revoke_rollback.sql`
- 001 が取り上げたものだけを戻す: authenticated の TRIGGER・TRUNCATE・REFERENCES と、service_role の TRIGGER。anon と PUBLIC には何も戻さない。
- **G5 の owner epoch（PR #303）が入っている間は戻さない**（`BM_PRIV_ROLLBACK_REFUSED_OWNER_EPOCH_INSTALLED`）。戻す順番は PR #358 → PR #303 → この rollback。
- 表の owner だけが実行できる。

## 3. テスト（使い捨ての PG17、`brand_memberships_privileges_run.sh`）
- 土台はリポジトリのファイル: 偽データの fixture（新しい表への既定の付与を、プラットフォームの既定の模型として入れる [A]）→ X の接続 RPC → 削除の候補 → membership の migration（`20260918120000`）。
- 照会は `has_table_privilege`・`pg_has_role(…, 'MEMBER')`・`aclexplode` だけ。権限を足すこと、役割の membership を足すことはしていない。

| 番号 | 確かめたこと |
|---|---|
| C0 | 適用の前: authenticated は `MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE`、service_role は 8 つすべて、anon・authenticator・PUBLIC は無し。G5 の L-1 検査（G3 の写し）は `API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS`。 |
| C1 | 表の owner でない・RLS が無い（membership の migration の前）・RLS はあるが自分の行を読むポリシーが無い・表が無い・superuser は、それぞれのコードで止まる。ACL は変わらない。 |
| K1 | 書き込みのトランザクションが開いている間は、5 秒でロック待ちを打ち切って止まる。ACL は変わらない。書き込みはそのまま commit できる。 |
| K2 | 読み取りのトランザクションが開いたままでも、候補は commit できる（読み取りを止めない）。 |
| C2 | 適用の後: authenticated は `MAINTAIN, SELECT`、service_role は TRIGGER だけが無くなる。MEMBER で届く全ての役割に TRIGGER が無い。anon・authenticated の側に書き込み・TRUNCATE・REFERENCES が無い。PUBLIC の項目 0。API の役割の grant option 0。BYPASSRLS 0。G5 の L-1 検査（G3 の写し）は `NONE`。RLS とポリシーは変わらない。 |
| C3 | 正常系: authenticated は RLS で自分の行だけ読める。service_role の INSERT・UPDATE・DELETE と、owner の書き込みは通る。anon は SELECT を持たない。 |
| C4 | 2 回目の適用と、2 つの同時の適用: どちらも成功し、ACL は同じ。 |
| C5 | rollback で ACL が**元と文字単位で同じ**に戻る。owner 以外の rollback は止まる。もう一度当てると、適用後の ACL に戻る。 |
| C6 | 作り直したスキーマ（fixture → migration → 候補）でも ACL は同じ。migration を後から当てた DB でも、その後なら当てられる。 |
| O1 | **G5 の本物のファイル**（PR #358 の木、変えずに使う）: G3 の候補の前は、PR #303 の install が `OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS` で止まる。PR #358 は PR #303 が無いので止まる。 |
| O2 | G3 の候補 → PR #303 の install（G5 の本物の検査 `account_lifecycle_owner_epoch_exposure()` が NULL）→ PR #358 の install（R1・W1・W2 ができる）。G3 の写しと G5 の本物の答えが一致する。 |
| O3 | G5 が入っている間は、G3 の rollback が止まる。権限も G5 の検査も変わらない。 |
| O4 | 戻す順番 PR #358 → PR #303 → G3 は通る。戻した後は PR #303 の再 install が止まる。G3 の候補を当て直すと、G5 は再 install できる。 |

- 結果: `BRAND_MEMBERSHIPS_PRIVILEGES_ALL_PASS`（G5 の木あり・なしの両方。なしのときは O が `O_NOT_RUN`）。
- 変異テスト: 候補と rollback に 21 個入れ、**19 個を検出**した。
  - REVOKE を一部抜いた変異（TRIGGER・TRUNCATE・REFERENCES・service_role・authenticated）と、SELECT・service_role の DML を取り過ぎる変異は、どれも候補自身の事後条件で止まった（`BM_PRIV_POSTCONDITION_*`）。
  - 前提・ロック・rollback の変異は、C1・K1・C5・O3 で検出した。
  - 最初の実行では、自分の行を読むポリシーの前提が止まらずに残った。C1 にテストを足して検出した。
  - **残った 2 個**: PUBLIC の事後条件と BYPASSRLS の事後条件。止まる場面を作るには、PUBLIC への付与か BYPASSRLS の役割を足す必要があり、範囲の外（§6）。模型では、この 2 つは消しても結果が変わらない。
- G3 の Threads・X の予約への影響: PR #360 の 2 つのランナーを、作業用の写しで実行した。写しは、土台に membership の migration とこの候補を足しただけ。実行の後に消した。§4 を参照。

## 4. 影響の表

| 対象 | この候補の影響 | 根拠 |
|---|---|---|
| X の既存の投稿（x-test-post・Cron・`scheduled_posts`） | なし。membership を書かない。読むのは service_role か definer。 | §1 の監査。TRIGGER・TRUNCATE・REFERENCES を使う道が無い |
| X の接続 RPC（membership を作る） | なし。表の owner として書く。 | C3 の owner の書き込み |
| アプリ・管理画面・Edge の読み取り | なし。authenticated の SELECT は残り、行は RLS が決める。 | C2・C3 |
| service_role の書き込み | なし。SELECT・INSERT・UPDATE・DELETE は残る。 | C2・C3 |
| G3 の X の予約（001〜006） | なし。 | PR #360 の `postona_threads_reservations_run.sh` の写しで、候補を当てた土台でも `POSTONA_THREADS_RESV_ALL_PASS`（X の予約のスキーマの指紋も不変） |
| G3 の Threads の予約（007）と worker・公開直前の確認 | なし。 | 同上と、`postona_threads_http_worker_run.sh` の写しで `POSTONA_THREADS_HTTP_WORKER_ALL_PASS`（16 passed） |
| G5 の owner epoch（PR #303） | **前提が満たされる**。この候補が無いと install できない。 | O1・O2 |
| G5 の R1・W1・W2（PR #358） | 同上（PR #358 も同じ検査を通る）。 | O1・O2 |

## 5. 本番の手順（どれも未実施。production は NO_GO）
1. **Codex Sol（高）の限定レビュー**: この 2 つのファイルとランナー。
2. **ユーザーの個別の GO**。
3. 本番の前の読み取り（別の承認が要る）: `public.brand_memberships` の owner・ACL・RLS、API の役割の membership、表のトリガーと、表を参照する外部キーの一覧。読み取り用の SQL はレビューの後に用意する。
4. **本番の作業時間（production mutation window）**: 表の owner として、この 1 ファイルだけを当てる（`db push` はしない）。書き込みは最大 5 秒待つ。止まったら何も変わらない。
5. **読み戻し**: ACL、`has_table_privilege` の表、G5 の検査と同じ照会の答えが `NONE` であること。
6. その後に限って、G5 の順番に進む（PR #303 のレビュー → install → PR #358）。
7. 戻すときは PR #358 → PR #303 → この rollback の順。

## 6. NOT_VERIFIED・UNKNOWN
- **本番の実際の付与・役割の membership・表の owner**: UNKNOWN（managed を読んでいない）。
- **これらの権限で実際に何ができるか**: 実演していない（範囲の改訂のため）。根拠は G5 の文書と PostgreSQL の権限の定義だけ。
- 事後条件のうち、PUBLIC・BYPASSRLS・他の付与者・membership を通した権限で**止まる側**: 実際に止まる場面は試していない。権限を足す必要があり、範囲の外だから。ただし、REVOKE を一部抜いた変異（TRIGGER・TRUNCATE・REFERENCES・service_role・authenticated）では事後条件で止まる。
- grant option を持つ役割がいる場合: REVOKE が「依存する権限がある」で失敗して全体が戻る見込み。試していない。
- managed の `authenticator` の membership と、プラットフォームの既定の付与: この模型は G5 の runner と同じ形で、本物ではない。

## 7. 残ること
1. **PostgreSQL 17 の MAINTAIN**: 既定の付与の模型では、authenticated に MAINTAIN が残る（C0・C2）。G5 の L-1 検査の対象ではなく、この候補も取り上げていない。取り上げるかどうかは、Sol のレビューで判断してほしい（`revoke maintain … from authenticated` を足すだけ。正当な使い道はリポジトリに無い）。本番で付いているかは UNKNOWN。
2. service_role の TRUNCATE・REFERENCES は L-1 の範囲外なので残した。G5 の検査も service_role には求めていない。
3. G5 の文書（PR #303 L-1・§7 の 0 番）は、この候補を前提としている。G5 のファイルは変えていない。G5 への連絡は、差分の提案が要るときだけにする。
4. この候補の migration 化・本番の適用は、レビューとユーザーの承認の後。x-test-post の認証（PR #349／#352）と Threads の流れの本番の停止は続けている。
