# G4-42：Threads の callback の認可と、X の接続の PR をまとめた一括（2026-10-25 JST）

- task_id: `postona-g4-threads-auth-x-oauth-integration-product-batch-20261025`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定:
  - **SOURCE_BATCH_PASS**: 隔離した PG17 と node・deno の試験で測った。
  - **G5_WIRING_NOT_DONE**: G5 の本物の判定にはつないでいない。
  - **PRODUCT_NOT_DEPLOYED**: 製品にはまだ出していない。
  - **PRODUCTION_NO_GO**: 本番には出せない。
- 土台: PR #517（`038202df730bcf95c3d420be33f45dfb16f8af7a`）← #516 ← #511 ← … ← #482（Threads の stack）。main は `0c42933c`。

## 1. Threads: callback で作業場所の規則を確かめ直す（Threads の B10）
- **source での確認**:
  - begin は PR #124 の厳しい規則で作業場所を作る（provisioner は L129–169。ほかの brand を持っていない、ほかのメンバーがいない）。
  - callback は、この規則をもう一度は聞かない。
    - PR #124 の complete（L286–293）は、「本人がその作業場所の owner であること」だけを見る。
    - binding-epoch 001 の entry は、owner・owner epoch・lifecycle_version を見る。
- **実測**（mode=current）:
  - begin と callback の間に、本人がほかの brand の owner になっても接続できた。作業場所の owner epoch は動かない（T2 で確かめた）。
  - 作業場所に別のメンバーが入っても、接続できた。
- **候補** `supabase/candidates/postona_g4_threads_personal_auth/001_threads_entry_workspace_recheck.sql`:
  - entry（`complete_and_attest_binding`）は binding-epoch 001 の本体のまま。既存の確認がすべて終わった後、attest を書く前に、確認を **1つだけ** 足した。
  - 足した確認: G5 の S2-3 の判定 `private.postona_personal_workspace_eligibility(actor)` が `own` でなければ拒否する。
  - 既存の拒否の code と順番は変えていない（T4 と、binding-epoch の behavior の全件で確かめた）。
  - 適用の前に、entry の md5 と、G5 の判定の名前・戻りの型・EXECUTE を確かめる。適用の後に、本体の md5 と、API のロールが届かないことを確かめる。
  - grant は何もしない（PR #124 の authenticated の EXECUTE は NO_GO のまま）。
- **入れなかったもの**: G5 の S2-2（本人 session の判定）。
  - S2-2 は claim `role=authenticated` を要求する。H5 の owner transport の設計（PR #428）では、transaction の中の claims は `sub` と `session_id` だけ。
  - 入れると、すべての接続が拒否される。H5 と G5 の間の IF（§4）。
  - H5 の `assert_actor` はすでに、生きている `auth.sessions` の行を要求している。匿名は G5 の S2-1（T13）が拒否する（候補）。
- **Threads の切断**: G4 の候補 `disconnect_threads_account` がある（門は閉じている）。行と Vault を削除するので、X の W1 のような問題は無い（G4-41 で確かめた）。

## 2. X: PR #511 → #516 → #517 と、G4 の古い PR #353・#426
| 組み合わせ | `git merge-tree` | この PR での扱い |
|---|---|---|
| #517 × #426（`use-x-connect.ts`） | **衝突**（状態の型と import。どちらも状態を足していた） | #426 の commit `03968e5c` だけを cherry-pick した（`05a93571`）。衝突は、両方の状態を残して解いた |
| #517 × #353（Edge） | 衝突なし | 含めない。#353 は G5 R1 と Sol の前は採用できないので、別のまま |
| #353 × #426 | 衝突なし | — |

- #426 の branch は、より新しい main の上にある。そのまま merge すると、関係のない main の `.agent` などの変更まで入るので、cherry-pick にした。
- 足したもの: `disconnect()` も connect と同じく、画面の人と今の session の人が違えば何もしない（`session_changed`）。
- **採用の順番の提案**: この PR を採用すれば、#426 の内容も入る。#426 は閉じてよい（判断は総合指令ちゃ）。#353 は G5 R1 の後に、別に採用する（衝突なし）。

## 3. 利用者にできるようになること（すべてを適用し、デプロイした場合）
- **X**:
  - 接続・再接続のエラーが「ログインし直し」「このアカウントではまだ接続できない」「やり直し」に分かれる（G4-41）。
  - 途中でログイン中の人や session が変わったら、接続は止まる（#426）。
  - 切断は hook と RPC まである。ただし、**門は閉じていて、ボタンも無い**。
- **Threads**: 接続の途中で作業場所の条件が崩れたら、callback で拒否する。
  - Threads の接続は今、main に経路が無い（PR #124・H5 の transport・Edge が未採用）。この部分は候補のまま。

## 4. 他の担当への IF（G4 が代わりに実装はしない）
- **G5**:
  - S2-3（#506、H4 PASS）・S2-2（#510、Sol 待ち）・owner epoch の適用
  - begin・complete・entry の owner への EXECUTE の付与
  - Q10・Q11・Q13 への合意
  - **新しい質問**: owner transport（claims は `sub` と `session_id` だけ）で S2-2 を使うには、`role` の claim を transport が置くべきか、それとも G5 が「user と session id」による判定を出すか
- **H5**: owner transport が置く claims（上の質問）。entry の差し替えに伴って、transport の呼び出しを変える必要は無い（署名は同じ）。
- **token の更新を担当する側（R-1・R-2）、G3（Q9・Q12）**: G4-40・41 のまま。
- **G1・G2**: 文言の確定（`session_changed` は #426 の文言のまま）、切断のボタン。

## 5. 試験（2026-10-25 JST、外部への通信は0）
- `supabase/tests/postona_g4_threads_entry_recheck_run.sh`（本物の G5 の lifecycle・T13、F5 の owner epoch、PR #124、custody、binding-epoch 001、G5 PR #506 の判定の本体をそのまま入れた）→ **`G4T_THREADS_ENTRY_RECHECK_ALL_PASS`**
  - behavior: current は穴を再現、candidate は拒否
  - 回帰: binding-epoch の behavior の全件が、候補を入れても PASS
  - 拒否3件（G5 の判定が無い、再適用、rollback の未適用）。rollback の後、current が PASS
  - 欠陥 **3/3 を検出**（確認を外す、NULL のときだけ拒否、CONFLICT を許可）
  - 「workspace の owner を聞く」欠陥は**等価**なので外した（entry はすでに owner = actor を要求している）
- X の回帰（この branch で実行）: `postona_g4_x_oauth_user_flow_run.sh` → 19/19 と、G4-40 の 23/24/30・W3 → ALL_PASS
- Edge: `deno test` → **33 passed**
- アプリ（`npm ci --ignore-scripts`）:
  - `npm test` **314/314**（#426 の 11件と、新しい hook の試験 5件を含む）
  - `tsc` 0 件、`expo lint` exit 0
  - 新しい hook の試験は、画面が残っているかの確認を外すと FAIL することを確かめた（1件 FAIL）
- **NOT_VERIFIED**: G5 の本物の判定の適用、本物の Auth・Vault・X・Threads・Meta、Edge のデプロイ、実機の画面、本番

## 6. Codex Sol（高）がまとめてレビューするもの
| PR | HEAD | 内容 |
|---|---|---|
| #511 | `c686644ef3951dca722f0c4ff7b66750e4bdb23f` | X の 001（作業場所・epoch・CAS） |
| #516 | `25be22ed9ecc08e343ca6b56cb19f8ab8761f405` | X の 002（W1・W2・W3） |
| #517 | `038202df730bcf95c3d420be33f45dfb16f8af7a` | Edge の 401・409、アプリの状態、003 の切断 RPC |
| この PR | §7 | Threads の B10、#426 の cherry-pick と衝突の解消、`disconnect()` の確認 |
| #353 | `4d42b5c7a511831151bd98a34e473866dea43173` | X の交換の前の再認可（別に。G5 R1 が先） |

- 読むもの: G5 PR #506 `bbc52a6b…`・#510 `6d59f3b6…`、H5 の `postona_threads_auth_runtime/claim_candidate.sql`（`assert_actor`）

## 7. 残件
- 決めていない（G5・ユーザー）: R0、P-1、locked／ban、ログアウト、token の保持。
- 別に残っている課題: 候補 005・D8・H5 の transport・本物の Vault の ACL。PR #124 の authenticated の EXECUTE は NO_GO。Issue #131 は延期のまま。
