# G4-19：Threads の OAuth の complete の実行権の契約（PR #124 の有効化の計画と PR #405／#418 の整合）（設計だけ、2026-10-22 JST）

- task_id: `postona-g4-pr124-pr405-complete-owner-only-activation-contract-design-20261022`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **DESIGN_ONLY／PRODUCTION_NO_GO**。コード・SQL・migration・ACL は変えていない。実装は、別の TASK と、実装の前のレビューの後。
- 読んだもの（すべて読み取り）:
  - main `0c42933ca5030ab31a56267529430d0473d9b155`
  - PR #124 `c30f246409a77080cbc03aef6c4cb72b5481e125`（候補 SQL と `docs/postona/threads-connection-phase2b.md`）
  - PR #405 `80667ffb788836722eb8d98190eaa874e6d5acc4`
  - PR #418 `771600a09579f461740fde4ddccb5add279c9591`
  - PR #412 `b83a7a92524a8862fe0a291d54a364fe15d8048d`
  - PR #139 `b4fa672f`（H5 の owner transport の元）と、PR #418 の木の `supabase/candidates/postona_threads_auth_runtime/`（`owner_transport.ts`・`claim_candidate.sql`・`wiring/custody_port.ts`）
  - `supabase/functions/_shared/social/threads_connect_publish_integration.ts`

根拠の印: **[S]** ソースの本文（ファイル:行）／**[D]** 設計の文書の記述（事実ではなく計画）／**[U]** 未確認。

## 1. 食い違いの中身
| | PR #124 の計画 | PR #405／#418 の要求 |
|---|---|---|
| 書いてあること | 「3つの RPC（begin・consume・complete）を authenticated に付与するのは、後の有効化 migration（別レビュー）」（`threads-connection-phase2b.md` §0.9、§0.5、§0.8、§2）[D]。候補 SQL そのものは、4つの関数すべてを `public, anon, authenticated, service_role` から revoke し、所有者だけにしている（候補 SQL `:346-349`）[S] | 入口 `complete_and_attest_binding` は、呼ぶたびに **PR #124 の complete に所有者以外の実行権が無い**ことを確かめる（`THREADS_BINDING_COMPLETE_UNPINNED`）。適用時にも確かめる（`THREADS_BINDING_PRECONDITION_COMPLETE_EXPOSED`）[S]。custody の書き込み（PR #418 の 002）は、入口が残した接続の証明を求める [S] |
| 有効化で authenticated に complete を付与すると | — | 入口と 002 の適用が拒否され、すでに適用済みなら入口の呼び出しが毎回拒否される（fail-closed）。つまり Threads の接続ができなくなる |

### authenticated から complete を直接呼ぶと、なぜ部分的な commit になるか
- PostgREST の RPC は、1回の呼び出しが1つのトランザクション [S（PostgREST の動き、文書）]／[U（この環境では未実測）]。
- complete だけが commit されると、次の状態が残る。
  - state は消費済み。
  - 資格情報（Vault の参照）が保存されている。
  - **結び付けが無い**（owner epoch・lifecycle_version の記録も無い）。
  - **custody が無い**（期限の記録が無い）。
- その state は、二度と結び付けられない（G4-14 の 7c）。
- 結び付けが無いので、資格情報の読み取り（PR #377／#412 の `credential_row`）は行を返さない（fail-closed）。しかし、前の接続の結び付けが残っているアカウントでは、同じ Threads の利用者のトークンの差し替えが、前の結び付けの数のまま使われうる（G4-14 の doc §2）。
- custody の書き込みは所有者だけ（INVOKER）なので、authenticated の呼び出しの中では、同じトランザクションで期限を記録できない。
- H5 の runtime の一回限りのコードの claim（`postona_threads_runtime.attempts`、`claim_candidate.sql`）も飛ばされる。

## 2. 今の呼び出し元の実態（ソース）
- **Threads の begin／complete を呼んでいるのは、H5 の owner transport だけ**（`owner_transport.ts`）[S]:
  - 操作ごとに**所有者の専用の接続**を作る。共有の pool・PostgREST・service key の経由は禁止と書いてある。
  - READ COMMITTED で `begin` する。`statement_timeout` と `lock_timeout` を置く。
  - 接続の役割が所有者で、superuser でなく、API の役割（anon・authenticated・service_role・authenticator）がどれもそのメンバーでないことを確かめる（`pg_has_role(..., 'MEMBER')`）。
  - 検証済みの人（getClaims の署名 ＋ getUser）の `sub` と `session_id` を、トランザクションの中だけの claims として置く。
  - complete のトランザクションの中身: `assert_actor` → custody の契約の確認 → ワークスペースのロック → state の行のロック → claim 済みの試みの確認 → **PR #124 の complete** → custody の記録 → outcome → COMMIT。失敗なら全部 rollback。
- アプリ（`apps/social-mobile`）にも Edge にも、Threads の RPC を authenticated で呼ぶ道は無い [S]（`git grep` で確認。`threads_connect_rpc_contract.ts` は名前の定義だけで、配線されていない）。
- G4 の統合の契約（`threads_connect_publish_integration.ts:82-86`）も、complete と custody を owner transport の1トランザクションで呼ぶ前提 [S]。
- **結論**: 「authenticated に complete を付与する」計画は、H5 の owner transport の設計（2026-10-11〜12）より前の計画（2026-10-10）のまま残っている。今の呼び出しの設計は、それを必要としていない。

## 3. 選択肢
| 案 | 中身 | 評価 |
|---|---|---|
| A | PR #124 の計画のとおり、authenticated に begin・consume・complete を付与する | **採らない**。PR #405／#418 と両立しない（入口と 002 が拒否する）。部分的な commit（§1）。H5 の claim を飛ばす。本人がコードの交換をせずに呼べる経路が増える（attestation の HMAC は、他人の id の結び付けを止めるが、順序と custody は守らない） |
| B | authenticated に、complete ではなく入口（`complete_and_attest_binding`）を付与する | **採らない**。custody を同じトランザクションに入れられない（入口の引数を変えて custody まで入れる大きな作り直しになる）。H5 の claim も飛ばす。PR #405／#418 の「API の役割が届かない」前提と事後の確認に反する |
| **C（推奨）** | **Threads の接続の RPC と入口は、どれも API の役割に付与しない。呼び出しは H5 の owner transport だけ**。有効化 migration は、これらに何も付与しない | 今のソースの設計（§2）と PR #405／#418 の確認にそのまま合う。足りないのは、H5 の transport の呼び出しの差し替え（§5）と、PR #124 の文書の訂正 |
| D（後で検討） | 所有者の接続の代わりに、入口などだけを実行できる専用の役割（最小の権限）を作る | 所有者の DB の資格情報を Edge に置かずに済む利点がある。しかし、PR #405／#418 の「ACL は所有者だけ」の事後の確認と、custody の書き込み（INVOKER で表の権限が要る）を作り直す必要がある。C の後の強化として、別の設計と審査で扱う |

## 4. 推奨（案 C）の受け入れの条件（実装の前に確かめること）
1. **付与**: 次の関数は、所有者以外の誰にも EXECUTE が無い。PUBLIC・anon・authenticated・service_role・authenticator、既定の ACL による委任先も含む（ACL を1つずつ数え、null の ACL も拒否する）。
   - begin・consume・complete
   - `private.social_mobile_ensure_personal_workspace`
   - 入口 `complete_and_attest_binding`・`record_state_generation`・`binding_row`
   - custody の書き込みと読み取り
   - `credential_row`
   - H5 の runtime の関数（`postona_threads_runtime.*`）
2. PR #405 の入口・PR #418 の 002・PR #412 の `credential_row` には、適用時と実行時の確認がすでにある [S]。PR #124 の候補と H5 の `claim_candidate.sql` にも、同じ「所有者だけ」の事後の確認を揃える（後の TASK）。
3. **到達**: API の役割が、MEMBER・SET・USAGE のどの経路でも所有者になれない（SET だけの2段の経路を含む）。PR #405／#418 は適用時に確かめる [S]。H5 の transport は接続のたびに `MEMBER` で確かめる [S]。
4. **SECURITY DEFINER**: 所有者が持ち、search_path は空。PR #124 の complete の本体は、入口が md5 で固定している [S]。
5. **owner transport の義務**:
   - 操作ごとの専用の接続、READ COMMITTED。
   - 検証済みの人の `sub` と `session_id` を、トランザクションの中だけの claims にする。
   - 1つのトランザクションで1つの接続。
   - Edge の秘密の扱い（所有者の DSN をログに出さない、呼び出し側が DSN や役割を選べない）は、H5 の文書のとおり。
6. **呼び出しの順序**（すべて同じ所有者の接続で、操作ごとに1トランザクション）:
   - **begin**: `assert_actor` → `begin_social_mobile_threads_oauth_connection` → G5 の R1 の許可の2つの数を取る → `postona_threads_binding.record_state_generation(actor, state, owner_epoch, lifecycle_version)` → `remember` → COMMIT
   - **claim**: H5 の今のまま
   - **complete**: `assert_actor` → custody の契約の確認 → ワークスペースのロック → claim 済みの確認 → **`postona_threads_binding.complete_and_attest_binding(state, threads_user_id, handle, token, attestation)`**（PR #124 の complete を直接呼ばない）→ **`public.record_threads_credential_custody(account, expiry)`**（002 の証明を同じトランザクションで満たす）→ outcome → COMMIT。どれかが失敗したら全部 rollback。
7. **アプリとクライアントへの影響**: 無い。アプリは Threads の RPC を呼ばない。X の接続は別の流れで、今回は変えない（X の complete に authenticated の EXECUTE があることは、PR #124 の §0.10 の既知の点。X の側の TASK・PR #353／#355 の範囲）。

## 5. 他の持ち主との IF（合意が要る点）
| 相手 | 内容 | 状態 |
|---|---|---|
| **H5（owner transport、PR #139 の系統。今の H5 Issue #332 は idle）** | §4 の 6 の順序への差し替え: begin の後に `record_state_generation`、complete を入口に置き換え、custody はその後の同じトランザクション。1つのトランザクションで1つの接続。transport の到達の確認は今のまま | **未回答**（COORDINATION を #332 に送った） |
| **G5** | begin のトランザクションの中で、owner transport から R0（最初の接続、ブランドなし）と R1（許可の2つの数）を呼べること、それぞれの契約（呼び出しの役割、claims、ロックの順序）。有効化 migration は Threads の接続の RPC を authenticated に付与しない前提で、R0 の設計を確かめる | **未回答**（COORDINATION を #320 に送った） |
| G3 | 影響なし。G3 の配信は `credential_row`（所有者だけ、worker への付与は別の段階）を読み、接続の RPC には触れない | 連絡不要と判断 |
| G4（自分） | 後の TASK: PR #124 の文書（§0.5・§0.8・§0.9・§2）の訂正、G4 の統合の契約の SQL の並び（`threads_connect_publish_integration.ts:82-86`）の更新、PR #124 の候補と H5 の claim の候補に「所有者だけ」の事後の確認を揃えること | 未着手（この TASK では変えない） |

## 6. 適用の順序と rollback（将来。各段階でユーザーの承認と独立のレビューが要る）
1. 2a-2（`20261007150000`、G4。D-2：列の付与との食い違いを、作り直しのときに直す）
2. G5 の T13・lifecycle、F5 PR #303 の owner epoch、G5 の R0／R1／W1（各 PR）
3. PR #124 の候補（所有者だけ）
4. custody の候補
5. binding の 001（PR #418 の版）→ 002（custody の証明）
6. `credential_row`（PR #412）
7. H5 の runtime の SQL（`claim_candidate.sql`）
8. H5 の transport のコードの差し替え（§4 の 6）
9. Edge の秘密（attestation の鍵、所有者の DSN。ユーザーの承認）
10. ゲートを開く（別の承認）

- 有効化の migration は、**Threads の接続の RPC に何も付与しない**。
- rollback は逆の順。002 は 001 より先に戻す。
- 付与を後から足した場合（誤り）は、入口が呼ぶたびに拒否する（fail-closed）ので、まず付与を外す。

## 7. 未確認・残ること
- PostgREST の RPC が1回で1トランザクションになることは、この環境では実測していない [U]。
- H5 の transport の実際の差し替えと、実際の Edge・Supabase での動作は NOT_VERIFIED。
- 案 D（最小の権限の専用の役割）は未設計。
- 並行して未解決のもの: PR #426 の独立の Auth のレビュー、G2 PR #419 の期待の更新、PR #412・#418 の独立のセキュリティのレビュー、Supabase Data API の 10/27 の持ち主の合意、H2 の Codex の停止。
