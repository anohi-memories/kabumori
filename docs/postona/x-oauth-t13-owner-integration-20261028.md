# G4-46：X の接続に G5 の T13 を入れ、関数の owner を1つにする（2026-10-28 JST）

- task_id: `postona-g4-x-threads-oauth-product-contract-integration-nonprod-20261028`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定:
  - **SOURCE_CANDIDATE_PASS**: G5 の本物の world（T13 と G5 の migration 候補）で、非本番の PG17 で測った。
  - **PRODUCT_NOT_DEPLOYED**: 製品にはまだ出していない。
  - **PRODUCTION_NO_GO**: 本番には出せない。
- 土台: PR #533（`98e5cf0320000421c301be7602aab3a9d8357548`）。G5 の参照先: PR #543（`b2e5aaa48af0b4d149c133bf52f923ff683b0ee0`）。

## 1. 直したこと
| 段 | 今（#533） | この PR |
|---|---|---|
| X の begin・consume・complete | G5 の T13 を呼ばない。G5-44 の **GAP G4-1** として測られていた。POSTONA を始めていない人や、サービスを終えている途中の人でも、X の接続を始められる | **SQL 005** で、3つの本体の先頭で T13 を呼ぶ（`private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost')`）。本体は 002・004 のまま、1行を足しただけ |
| 関数の owner（G5-43 の推奨「grant しない」） | 001 は、G5 の関数に EXECUTE できればよかった（grant や superuser でも通る） | 005 の適用の前に確かめる: begin・consume・complete・T13・G5 の3つの関数の **owner が全部同じ**で、**superuser ではない**。違えば `G4X_T13_PRECONDITION_OWNER` で止まる |
| 2つの候補が同じ関数を置き換える問題（G3 の wrapper と G4） | 2つの候補が、同じ3つの関数を置き換えていた | **G4 が1つの owner になる**（G5-44 の選択肢 b）。G3 の wrapper を先に入れると、本体が違うので 005 は止まる（`G4X_T13_PRECONDITION_BODY`）。wrapper を取り下げるかは G3 の判断（G3 のファイルは変えていない） |
| Edge | T13 の code は一覧に無く、一般のエラーになっていた | `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` → 401。サービスが無い・終える途中・削除中・ロック → 409。writer fence が使えない → 503（一時的なもの。アプリは再試行の扱い）。どれも決まった code のまま、アプリに渡す |

## 2. 試験（`supabase/tests/postona_g4_x_oauth_t13_run.sh`）
- **world**: G5-44 と同じ（PR #543 の runner L83–L104 をそのまま写した）。
  - main の lifecycle と T13（`21a5cad4` に固定し、blob も照合）、owner epoch の候補、`auth.sessions`
  - G5 の migration 候補（PR #543 の install、blob `36126066…`）
  - 適用はすべて lifecycle owner（superuser ではない）で行った。
- **rv（005 なし）**: G5-44 の GAP G4-1 を再現した。サービスの無い C も、サービスを終える途中の A も、X の接続を始められた。
- **t13（005 あり）**:
  - A は begin → consume → complete で接続でき、account は `identity_verified` になった。
  - C は `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND` で拒否された。
  - サービスを終える途中は、begin・consume・complete のどれも `SERVICE_DELETION_IN_PROGRESS` で拒否された。
  - 匿名、`is_anonymous` が無い場合、終わった session は `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` で拒否された。
  - A→B→A は `OWNER_EPOCH_CHANGED` で拒否された。
- **適用の拒否 4件**: 再適用、004 が無い、superuser が持つ stack、begin だけ owner が違う。
- **順番の拒否**: 005 が入っている間は、004 と 002 の rollback が止まる。005 の rollback は 002・004 の本体に戻り、GAP がまた現れる（元に戻った証拠）。
- **欠陥 4/4 を検出**: begin・consume・complete のそれぞれで T13 を外したもの、superuser を許したもの。それぞれ、対応する場面で FAIL した。
- **Edge**: `deno test` は **39 passed**（T13 の3件を足した）。`deno lint` も問題なし。アプリは変えていない（#533 で 322/322）。
- **NOT_VERIFIED**: 本物の GoTrue・JWT・managed・PostgREST、Edge のデプロイ、実機、X の OAuth、本番

## 3. 他の担当に必要なこと（G4 は代わりに実装しない）
| 担当 | 必要なこと |
|---|---|
| G5 | migration 候補（#539→#543）のレビューと適用。T13 と、S2-2・S2-3・owner epoch の3つの関数を、**G4 の X の関数と同じ owner（lifecycle owner）** で持つこと（grant しない）。PR #457（P2）の解消 |
| G3 | X の OAuth の T13 wrapper（`postona_x_oauth_t13_guard/001`）を取り下げること。G4 の 005 が同じことをし、関数の owner は1つにする |
| H5 | owner transport の claims に、検証済みの `is_anonymous` を置くこと（Threads の 002 と begin。変わらず） |
| token の更新の担当・G3 | R-1・R-2・Q9・Q12（変わらず） |
| G1・G2 | 409 の文言（「POSTONA を始めていない」と「作業場所の問題」が、今は同じ文言になる）、切断のボタン |

- **採用の順番**:
  1. G5 の migration
  2. G4 の X 001→005（lifecycle owner で）
  3. Edge のデプロイ
  4. アプリ
  - Threads は H5 の対応の後。
  - 本番は owner の明示の承認があってから。
- **Codex Sol（高）がレビューするもの**（Auth と SQL の境界を新しく触ったので、この差分だけ）:
  - `005_x_connect_lifecycle_t13.sql`・`…_rollback.sql`
  - `x-oauth-connect-user/oauth_logic.ts` の T13 の部分
  - 上の runner と試験
  - PR #533 の F1・F2 は、もう一度レビューする必要は無い。

## 4. 残件
- 決めていない: R0・P-1・locked／ban・ログアウト・token の保持。
- 別に残っている課題: D8・候補 005（Threads）・本物の Vault の ACL。PR #124 の authenticated の EXECUTE は NO_GO。Issue #131 は延期のまま。
