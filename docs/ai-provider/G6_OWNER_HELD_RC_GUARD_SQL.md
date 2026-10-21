# G6-13 owner-held の RPC と READ COMMITTED のガード（共有 SQL の migration の候補）

- task_id: `common-ai-g6-owner-held-rc-guard-shared-sql-source-20261021`（Issue #321、G6-13）
- 作成: 2026-10-21。**Draft PR まで**。本番の DB への適用・merge・deploy・呼び出し口への組み込みは **NO_GO**。
- 承認: G6 の継続チャットで、ユーザーが G6-13 の共有 SQL / RPC の修正を Draft PR まで明示承認（2026-10-21 登録）。
- 元: G6-12 の案 A（H3 #330 の第 4 回のレビューで、別 TASK として先に進めるよう推奨）。案 B（`fence_seq` の列とトリガー）は採らない。
- **実装のレビュー（Codex Sol（高））は未実施**。この文書と PR は、実装の完成や本番の安全を意味しない。
- **G6-14 で更新**（H4 #331 の CHANGES_REQUIRED_P2）: `ai_calls` / `ai_ledger` の権限のずれを、前と後の両方で拒むようにした（§10）。

## 1. 変えるもの・変えないもの

新しいファイル: `supabase/migrations/20261020154536_ai_calls_owner_held_rc_guard.sql`

- Supabase CLI 2.116.0 の `supabase migration new ai_calls_owner_held_rc_guard` で作った。手元のファイルを作るだけで、リモートには触れない。
- 時刻は UTC で、日本時間では 2026-10-21 00:45。

| もの | 変更 |
| --- | --- |
| `public.ai_calls_abandon(jsonb)` | `CREATE OR REPLACE`。本体は 20261017120000 のものを**機械的に写し**、`begin` の直後に 3 行のガードだけを足す（READ COMMITTED 以外は P0001 `AI_CALLS_REQUIRES_READ_COMMITTED: <isolation>`）。署名・OID・所有者・ACL・ほかの全行は同じ |
| `public.ai_calls_forget_user(jsonb)` | 同上 |
| `public.ai_calls_claim_held(jsonb)` | **新規**。行を作らず、書き込まない、持ち主の確認（§2）。同じガードを持つ |
| ほか | 変えない（`ai_calls_claim`・`ai_calls_complete`・`ai_calls_purge_content`・`ai_calls_forget_system_brand`（既存のガードを保つ）・`ai_calls_recovery_candidates`・台帳・`ai_ledger_erase_user`（既存のガードを保つ）・表・列・トリガー・helper） |

ガードを通らない別名（G6-12 の fixture の `_unguarded` のようなもの）は作らない。関数は呼び出し元の isolation を変えられない（G6-12 で実測）ので、拒むことしかしない。

## 2. `ai_calls_claim_held` の契約

- 入力 `p`:
  - `call_key`・`tenant_tag`・`fingerprint`・`application`・`feature`・`subject_kind`・`user_id`（人のとき）・`brand_ref`（あるとき）
  - `owner`（**最初の `ai_calls_claim` が返した claim_token**）
- 答え: `{held: true}` か、`{held: false, reason}`。`reason` は次のどれか。
  - `NOT_FOUND`: 行が無い（**作らない**）
  - `IDENTITY_MISMATCH`: 完全な ID のどれかが違う
  - `NOT_ACQUIRED`: complete か abandoned
  - `OWNER_MISMATCH`: トークンが違う
- エラー:
  - 入力が不正: `AI_CALLS_INVALID_INPUT`（22023。既存の入力の検査と同じ）
  - READ COMMITTED 以外: `AI_CALLS_REQUIRES_READ_COMMITTED`（P0001）
  - どちらも、何も書かない。
- ロック: `ai_calls_claim` と同じ順番。
  1. 人の advisory lock を共有で
  2. 呼び出しの番号の advisory lock
  3. 行を `FOR SHARE`
- 形:
  - `VOLATILE`、`SECURITY DEFINER`、`search_path = ''`、所有者は既存の `ai_calls_*` の RPC と同じ。
  - EXECUTE は `service_role` だけ（grant option なし）。
  - 既定の権限で付く PUBLIC / anon / authenticated は revoke する。
- トークンは返さず、記録しない。呼び出し側も、メモリにだけ持つこと（組み込みは別 TASK）。

## 3. 呼び出し側の決まり（SQL では強制していない）

- ledger の試みを**予約してから**、`ai_calls_claim_held` を聞く。
- `{held: true}` と権限の再確認の後でだけ送る。
- エラー・時間切れ・答えの喪失は「held ではない」とみなし、送らない。
- `ai_calls_complete` は、元のトークンを持つ持ち主が、自分の流れの最後に呼ぶ finalizer。
  - SQL は台帳の開いた試みを見ない。そのため、トークンを共有した別の信頼された呼び出し元や、特権を持つ所有者の操作までは、このガードでは封じない。

## 4. 書き手の一覧（なぜガードが abandon と forget_user だけか）

| 書き手 | 古いスナップショットでの扱い |
| --- | --- |
| `ai_calls_abandon` | 台帳を普通の SELECT で数える（今回の反例の元）→ **ガード** |
| `ai_calls_forget_user` | 処理中の数え上げと DELETE がスナップショットに依る → **ガード** |
| `ai_calls_forget_system_brand` | 既存のガードを保つ（変えない） |
| `ai_ledger_erase_user` | 既存のガードと、人・台帳のロックを保つ（変えない） |
| `ai_calls_claim` | 一意のキー、最初のトークン、行のロック。古いスナップショットで新しい行や版に当たると、競合か 40001 になることがある（一般の定理ではない）。owner-held には使わない |
| `ai_calls_complete` | §3 の決まりに依る持ち主専用の finalizer。第三者の復旧がトークンなしで閉じる道ではない |
| `ai_calls_purge_content` | complete の中身を墓石にするだけ。acquired は閉じない |
| 台帳の `mark_sent`・`release`・`recover_stale`・`settle` | 予約の行をロックして前にだけ進める。released の古い許可は生き返らない |
| 読み取りの RPC | 閉じない・消さない |

- `service_role` は表に直接触れない。helper も直接実行できない（試験で確認）。
- 今後、行を閉じる・消す書き手を足すときは、このガードと所有者の決まり、実効の ACL を必ずレビューする。
- 本物の Supabase に、ほかの RPC・view・トリガー・権限の付与があるかは未確認。

## 5. fail closed（適用の前後の確認）

**前の確認**（カタログだけ）:

- 実行しているのが `ai_calls` の所有者であること（違えば最初に止まる）。
- 表があること。
- 置き換える関数・触れない関数の本体が、**既知の指紋**であること（md5。元のもの、または再適用ならこの migration のもの）。
- `ai_calls_claim_held` は無いか、この migration のもの。ほかの overload は無いこと。
- abandon と forget_user の ACL が、`service_role` の EXECUTE だけであること。

**後の確認**:

- 記録した関数の OID・所有者が同じ。置き換えた 2 つの本体と新しい 1 つの本体は、この migration のもの。ほかの本体は同じ。`ai_calls` に新しい関数が無い。別名が無い。
- 3 つの RPC は所有者・definer・空の `search_path`。`claim_held` は VOLATILE。
- 正確な ACL と、anon / authenticated / service_role の実効の EXECUTE（継承と grant option を含む）。
- anon / authenticated が、継承や SET ROLE で service_role・所有者・superuser に届かないこと。

どこかで違えば P0001 で止まり、`begin` / `commit` の中なので**全体が巻き戻る**（試験で、置き換えの後に失敗させて確認）。修復はしない。

- 既存の 3 つの migration と同じく、ファイルの中で `begin;` / `commit;` を明示した。
- Supabase CLI の公式資料には、各ファイルをトランザクションで包むかの記述が無い。本物の適用の道での動きは NOT_VERIFIED。

## 6. 適用の順番と、巻き戻し（試験専用）

1. `20261010050613_ai_provider_budget_ledger.sql`（main にある）
2. `20261017120000_ai_consumer_call_store.sql`（**未 merge の候補**。G6 の積み重ねの中だけ）
3. `20261017150000_ai_ledger_user_erasure.sql`（**未 merge の候補**）
4. `20261020154536_ai_calls_owner_held_rc_guard.sql`（今回）

main の `20261014100000_app_market_report_story_v2.sql` とは関係しない（main と合わせた木で確認）。

巻き戻しの SQL `supabase/tests/ai_calls_owner_held_rc_guard_rollback.sql` は、**隔離した試験の DB 専用**。

- この migration が残す状態でなければ拒む（2 回目の実行も拒む）。
- 元の本体に戻し（OID と ACL は同じ）、`claim_held` を `CASCADE` なしで消す。
- 戻すと R1 の根本と isolation の反例が復活するので、Supabase のプロジェクトでは決して使わない（production NO_GO）。

## 7. 試験（隔離 PG17。socket だけ、TCP なし、deny-net、偽の G5・偽の AI）

| 試験 | 結果 |
| --- | --- |
| `common_ai_gateway_owner_held_rc_guard_migration_pg_test.ts`（**実際の migration を psql -f**） | **6 PASS**（うち 1 は準備）。3 回続けて実行し、毎回 PASS |
| `common_ai_gateway_owner_held_contract_pg_test.ts` を **source=migration** で | **8 PASS**（契約・ロック・ABA で持ち主でないプロセスの送信 0・持ち主の通り道・答えの喪失・時間切れ・消去の後に行を作り直さない・4 者の同時実行） |
| 同じファイルを source=fixture で（PR #384 の候補） | 8 PASS（変わらない） |
| `common_ai_gateway_owner_held_isolation_baseline_pg_test.ts`（**変えていない今の SQL**） | **2 PASS / 3 FAIL**。FAIL は見込みどおりの反例として残す |
| G6-12 の guard / fence の fixture | 6 / 6 PASS（比べるため） |

migration の試験 6 件の中身:

| 試験 | 中身 |
| --- | --- |
| 準備 | 適用の前のカタログを記録し、migration を適用する |
| カタログ | 置き換えた 2 つは OID・所有者・形・ACL が同じで、本体だけが変わる。ガードは本体の先頭（最初のロックより前）。`claim_held` は所有者・definer・空の `search_path`・VOLATILE・ACL。触れていない 7 つの関数は 1 バイトも変わらない。`forget_system_brand` と `ai_ledger_erase_user` のガードは残る。別名は無い |
| ACL | 3 つとも `service_role:EXECUTE` だけ（grant option なし）。anon は本体の前で拒否。authenticated の仲間のロールは不可。`service_role` は表を直接 SELECT / INSERT / UPDATE / DELETE できず、helper も実行できない |
| ガード | 3 つの RPC × REPEATABLE READ / SERIALIZABLE / **READ UNCOMMITTED** → すべて P0001 で、行は 1 バイトも変わらない。セッションの既定を REPEATABLE READ にすると拒否。REPEATABLE READ の中で既定を READ COMMITTED に変えても拒否。superuser の SECURITY DEFINER の包みからも拒否。READ COMMITTED では、開いた試みの無い古い行を閉じ、消せる |
| 安全 | G6-12 の反例の場面（READ COMMITTED / REPEATABLE READ / SERIALIZABLE / READ UNCOMMITTED の復旧）で、すべて安全の条件を満たす（古いスナップショットの復旧は P0001）。別プロセスでは、A は持ち主のまま 1 回だけ送り、持ち主でないプロセスの送信は 0 |
| 適用の全体（試験の中で作る新しい DB） | 適用と再適用は同じ（行・トリガー・OID・ACL・関数を比べた）。巻き戻しで元と完全に同じ状態に戻る。巻き戻しの 2 回目は拒否。ずれ（本体の変更・権限の拡大・別の overload）・所有者でない実行は、それぞれ P0001 で止まり、何も変わらない。置き換えの後に失敗させる（authenticated に service_role を付ける）と、後の確認で止まり、置き換えた本体と新しい関数も含めて全部が巻き戻る |

わざと壊した migration（作業用の写しだけ。本体を変えた写しは指紋を計算し直し、適用できる状態で振る舞いを試した）: **10/10 を検出**。

- 3 つの RPC のそれぞれのガードを外す
- 持ち主のトークンを見ない
- ID を見ない
- 状態を見ない
- 行を作る
- revoke を消す（後の確認も外した写し）
- ずれの確認を外す
- 後の確認を外す

## 8. NOT_VERIFIED と、運用の前のゲート

- 本物の Supabase と PostgREST（**別の承認の読み取りのゲート**が要る）。確かめるべき点は次のとおり。
  - migration を実行するロールと関数の所有者（postgres か supabase_admin か）
  - 既定の権限、独自のロールと継承、`service_role` の membership
  - PostgREST での公開
  - ロールごとの `default_transaction_isolation`
  - 適用の道がトランザクションで包むか
- `20261017120000` と `20261017150000` 自体が未適用の候補で、本番にあるかは未確認（照会していない）。
- 呼び出し口への組み込み（`gateway.ts`・`ai_calls_store.ts`）は別 TASK。最初のトークンをメモリにだけ持ち、held の失敗・時間切れ・答えの喪失では送らず、台帳が主導する復旧と、R2 の最後の再確認を保つこと。
- 未解決（変えない）:
  - G5 の取り消し → 送信中のものを待ち切る / 不明の確定 → 復旧 → call の forget → 台帳の消去の順番と、再び認める場合・同じ ID の再利用の決まり（G5 と運用）
  - R2 の最後の再確認の後の窓
  - ABA の後に B も送れない（可用性）
  - NOT_SENT_PROVEN の墓石が「不明」なこと、呼んだときの決まりの版、記録できた行の控えと台帳のずれ
- 本番の負荷・時間（試みごとの確認の RPC は今と同じ 1 回）は未測定。

## 9. 変えたパス

- `supabase/migrations/20261020154536_ai_calls_owner_held_rc_guard.sql`（新規）
- `supabase/tests/ai_calls_owner_held_rc_guard_rollback.sql`（新規、試験専用）
- `supabase/tests/common_ai_gateway_owner_held_rc_guard_migration_pg_test.ts`（新規）
- `supabase/tests/common_ai_gateway_owner_held_contract_pg_test.ts`（source=migration の切り替えだけ）
- `supabase/tests/common_ai_gateway_owner_held_fixture.ts`（migration と巻き戻しのパス、`psqlFile`、`read uncommitted`）
- `supabase/tests/common_ai_gateway_restart_race_pg_run.sh`（新しいファイルと、2 つ目の引数 source）
- `docs/ai-provider/G6_OWNER_HELD_RC_GUARD_SQL.md`（この文書）

## 10. G6-14: 権限のずれ（ACL drift）を拒む（H4 #331 の P2）

### 指摘

- H4 の再現: 祖先の migration の後で、次の権限を付けてから G6-13 の migration を流すと、成功してしまい、権限は残った（true / true / true）。
  - `service_role` に `ai_calls.consumer_calls` の SELECT / INSERT / UPDATE / DELETE
  - `ai_calls.input_text` の EXECUTE
- G6-13 の後の確認は、3 つの RPC の ACL とロールの到達だけを見ていた。スキーマ・表・helper の直接の権限は見ていなかった。
- 「RPC からしか行に届かない」という境界が、すり抜けられる状態を見逃していた。

### 直し（`20261020154536_ai_calls_owner_held_rc_guard.sql` だけ。関数の本体と指紋は変えていない）

- **一時的な確認の関数** `pg_temp.ai_calls_owner_held_acl_check(stage)` を、`begin` の直後に作る。
  - 前の確認の後に `PRESTATE` として、後の確認の後に `POST` として呼び、`commit` の前に消す。
  - `pg_temp` なので、セッションの外には残らない。`ai_calls` に helper を足していない（試験で、適用の後に残っていないことを確認）。
- 対象: `ai_calls` と `ai_ledger` の両方（復旧の判断は ledger に頼るので、同じ境界）。
- 拒むもの（どれかがあれば P0001 `AI_CALLS_OWNER_HELD_<stage>: ACL drift: ...`、全体が巻き戻る）:
  1. スキーマや、その中の表・関数の所有者が、アプリのロール（anon / authenticated / service_role）であるか、混在している。
  2. 所有者以外への直接の付与。対象は、スキーマ・表・列・helper（PUBLIC と grant option を含む）。
  3. SECURITY DEFINER の helper、そのスキーマの既定の権限（`pg_default_acl`）。
  4. anon / authenticated / service_role の**実効**の権限（継承・PUBLIC を含む）。対象は、スキーマの USAGE / CREATE、表のすべての権限（PG17 は MAINTAIN も）、列、sequence、helper の EXECUTE。
  5. それらのロールが、継承か SET ROLE で、所有者か superuser に届く。anon / authenticated が service_role に届く。
- **修復はしない**（GRANT / REVOKE で「直す」ことはしない）。想定どおりの状態のときだけ適用できる。
- 所有者や superuser 自身の操作までは防げない。また、適用の後で権限が変わるのを、恒久的に防ぐものでもない（適用の時点の確認）。

### 試験（隔離 PG17、実際の migration を `psql -f`。`..._rc_guard_migration_pg_test.ts` は 8 PASS）

- **ずれ 13 通り**: それぞれ新しい DB で付けてから適用すると、PRESTATE で P0001 になる。関数・行・トリガー・すべての ACL・既定の権限・ロールの付与が 1 つも変わらず、付けた権限も残る（修復しない）。
  - H4 そのもの
  - PUBLIC の表の SELECT
  - anon のスキーマの USAGE だけ（表の付与なし）
  - authenticated の列の SELECT
  - PUBLIC の helper の EXECUTE
  - grant option 付きの helper
  - 継承するロール（ledger を読めるロールを authenticated に付ける）
  - `ai_calls` の既定の権限
  - service_role の ledger の UPDATE
  - service_role が所有する ledger の表
  - SECURITY DEFINER の helper
  - service_role が所有者に届く
  - authenticated が SET ROLE だけで service_role に届く（`WITH INHERIT FALSE`）
- **実際の migration の文から作った probe**:
  - PRESTATE の呼び出しを外すと、POST が同じずれを拒み、置き換えた本体と新しい関数を含めて全体が巻き戻る。
  - 両方を外すと、H4 のずれが通ってしまう（＝この確認が効いている）。
  - きれいな DB では通り、一時的な関数は残らない。
- **後の確認だけが見つけられる失敗**: DDL のイベントトリガーが、migration の REVOKE の直後に、`claim_held` を authenticated に付け直す。後の確認（正確な ACL）が拒み、全体が巻き戻る。
- G6-13 で認めていた「authenticated に service_role を付けた状態」は、今は PRESTATE で止まる（期待を更新した）。

### わざと壊した写し（作業用の写しだけ）

- G6-14 の確認の 12 項目を 1 つずつ外した写し: **9 種類を検出**。
- 検出しなかった 3 種類（実効の表・列・helper の EXECUTE の確認）は、**実質同じ動き（二重目の防御）**。
  - 直接の付与が無い状態で実効の権限だけが立つのは、所有者を継承する場合だけ。その場合は、先に実効のスキーマの USAGE か到達の確認で止まる。
- G6-13 の 10 種類（ガード・持ち主・ID・状態・行の作成・revoke・ずれ・後の確認）: 最終の形で再実行。結果は REPORT に書く。

### NOT_VERIFIED・残るもの

- 本物の Supabase のロール（`supabase_admin`、`authenticator`、`postgres` など）と、ほかのスキーマへの継承。今回の確認の対象は anon / authenticated / service_role と、その継承・到達だけ。
- 本物の適用の道で、一時的な関数（`pg_temp`）を作れるか。
- 適用の後の権限の変化の監視（運用。この migration の範囲外）。
