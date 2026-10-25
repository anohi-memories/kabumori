# G4-43：X・Threads の OAuth の採用に向けた統合の修正と、一括レビューの準備（2026-10-25 JST）

- task_id: `postona-g4-oauth-integration-adoption-blockers-batch-20261025`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定:
  - **SOURCE_BATCH_PASS**: 隔離した PG17 と deno で測った。
  - **G5_H5_WIRING_NOT_DONE**: G5 と H5 の本物にはつないでいない。
  - **PRODUCT_NOT_DEPLOYED**: 製品にはまだ出していない。
  - **PRODUCTION_NO_GO**: 本番には出せない。
- 土台: PR #522（`90cc2ce0eef6594ef1b21f376c980ba6ac5de2fd`）。main は `0c42933c`。

## 1. この PR で直したこと
| 経路 | 変更 | 持ち主 |
|---|---|---|
| X: 交換の前の確認 | **SQL 004** `004_x_consume_preexchange_recheck.sql`: Edge が X と code を交換する**前**に呼ぶ consume（読むだけ）が、complete と同じことを確かめる（binding・最後の begin・connection epoch・G5 の session と作業場所・owner epoch）。今の main では、拒否されるはずの state でも X から token をもらってしまう（c003 で再現） | G4 |
| X: Edge | `oauth_logic.ts`: RPC の決まった code だけを返す（データベース自身の文言は返さない）。begin は登録済みの redirect URI だけ受け付ける。どちらも PR #353 から持ってきた | G4（製品のコード。デプロイはしていない） |
| Threads: callback | **SQL 002** `002_threads_entry_person_session.sql`: entry が、既存の確認のすべての後に G5 の S2-2 も聞く。**H5 が `is_anonymous` を置くまでは採用しない**（§3） | G4 |
| Threads: 契約 | `threads_connect_rpc_contract.ts`: entry の拒否の code の一覧と `threadsConnectRefusalKind`（ログインし直し、作業場所の問題、やり直し）。X の G4-41 と同じ3つに分ける | G4（共有の契約。H5 の transport や Edge が使う） |

- **PR #353 の扱い**:
  - G5 R1 の authorization port は 004 で置き換えた。port は Edge にあり未結線で、入れると X の接続が止まる。004 は SQL で同じ確認をし、接続は止めない。
  - code の allowlist と redirect の固定は、この PR に入れた。
  - なので **#353 は閉じてよい**と提案する（判断は総合指令ちゃ）。
- **PR #426**: G4-42（#522）に cherry-pick 済み。**閉じてよい**と提案する。

## 2. Codex Sol（高）が一度にレビューするもの（採用もこの順番）
| 順 | PR | HEAD | 内容 | 主なリスク |
|---|---|---|---|---|
| 1 | #511 | `c686644ef3951dca722f0c4ff7b66750e4bdb23f` | X の 001: 作業場所・session・owner epoch・最後の begin・connection epoch | G5 の関数の契約、`require_person` の扱い |
| 2 | #516 | `25be22ed9ecc08e343ca6b56cb19f8ab8761f405` | X の 002: W1（CHECK）・W2（2つ目の書き手を削除）・W3（deadlock） | 表のロックの順番 |
| 3 | #517 | `038202df730bcf95c3d420be33f45dfb16f8af7a` | Edge の 401・409、アプリの状態、X の 003（切断の RPC、門は閉） | authenticated に新しい関数を grant する |
| 4 | #522 | `90cc2ce0eef6594ef1b21f376c980ba6ac5de2fd` | Threads の 001（B10）、#426 の取り込み、`disconnect()` の確認 | entry の本体の差し替え |
| 5 | この PR | §6 | X の 004、Edge の allowlist と redirect、Threads の 002、契約 | 交換の前の確認、Threads の claims |

- 一緒に読むもの: G5 PR #506（`bbc52a6b…`）・#510（`6d59f3b6…`）、H5 の `owner_transport.ts` L53–L65 と `claim_candidate.sql` の `assert_actor`、main の `20260925140000`（token の更新）。

## 3. 他の担当に必要なこと（G4 は代わりに実装しない）
| 担当 | 必要なこと | 具体的なもの |
|---|---|---|
| G5 | 3つの判定を適用し、EXECUTE を与えること | `private.postona_personal_session() -> text`（'active' だけ通す）、`private.postona_personal_workspace_eligibility(uuid) -> text`（'absent' と 'own'）、`private.account_lifecycle_brand_owner_epoch(text) -> bigint`（NULL は拒否）。X の begin・consume・complete と Threads の entry の owner が EXECUTE できること（どの候補も適用の前に確かめて、できなければ止まる） |
| G5 | Q10・Q11・Q13 | 匿名は begin でも callback でも同じ code にする／ABA の後は begin し直し／callback でも確かめ直す（候補はこのとおりに作ってある） |
| **H5** | **owner transport の claims に `is_anonymous` を置く** | `owner_transport.ts` L53–L65 は `sub`・`session_id`・`role` を置くが `is_anonymous` は置かない。S2-2（#510 L19・L31・L35）は `is_anonymous = false` を要求する。検証済みの JWT の値を、JSON の claims と1つずつの claim の両方に置く（定数にしてはいけない）。それまで Threads の 002 は採用しない（入れると、すべての callback が拒否される。S1 で実測） |
| token の更新の担当（G4 ではない） | R-1・R-2 | R-1: 再接続の reset は、lease が `refreshing` の間は何もしない。R-2: `postona_g4_x_oauth.x_connection_epoch(text)` を lease に加える |
| G3 | Q9・Q12 | worker は更新の lease の外で X の token を書かない。必要なら epoch を読む |
| G1・G2 | 画面の契約 | X の状態は `session_changed`・`session_required`・`workspace_blocked`・`disconnecting`・`disconnected`（文言は仮）。Threads は `threadsConnectRefusalKind` の3つ。切断のボタン |
| 運用者 | 門 | X の切断（003 の `x_disconnect_enabled`）と Threads の切断（`threads_disconnect_gate_open`）。どちらも閉じている |

- **G4-42 の REPORT の訂正**: 「H5 は `sub` と `session_id` しか置かない」と書いたが、誤り。H5 は `role` も置いている。足りないのは `is_anonymous` だけ（L53–L65 で確かめた）。

## 4. 利用者にできるようになること（§2 と §3 がそろい、デプロイした場合）
- **X**:
  - 接続・再接続ができる。古い brand・共有の brand の人は、理由を示して止まる（P-1 は未決）。
  - 途中でログインが変わったら止まる。
  - 拒否されるはずの callback では、X と code を交換しない（token を受け取らない）。
  - 切断は、門を開けてボタンを付ければ使える。
- **Threads**:
  - callback で、作業場所と（H5 の claims がそろえば）本人の session を確かめ直す。
  - Threads の経路そのもの（PR #124・H5 の transport・Edge）は、まだ採用されていない。
- **H 枠**（割り当てはしていない。担当ちゃへの報告だけ）:
  - H5 #332 は idle（空き）。
  - H1 #328 と H2 #329 は ready、H3 #330 は review_required、H4 #331 は ready（G3 PR #509 のレビュー）。

## 5. 試験（2026-10-25 JST、外部への通信は0）
- **X**: `postona_g4_x_oauth_preexchange_run.sh` → `G4XP_PREEXCHANGE_ALL_PASS`
  - c003 と c004 で、それぞれ 19/19（authenticated で実行）
  - 拒否2件、rollback の拒否1件と rollback
  - 欠陥 **4/4 を検出**
  - 回帰: G4-41（19/19）、G4-40（23/24/30・W3）、G4-39（51/75）がすべて PASS
- **Edge**: `deno test supabase/functions/x-oauth-connect-user/` → **36 passed**（#522 では 33）
  - 既存の試験1件は redirect を `app://cb` から登録済みの値に変えた（試験の内容は、RPC の拒否を通すこと）
- **Threads**: `postona_g4_threads_person_session_run.sh` → `G4T_PERSON_SESSION_ALL_PASS`
  - g442 と g443
  - 002 の下で、binding-epoch と G4-42 の behavior が PASS
  - 拒否4件、rollback
  - 欠陥 **2/2 を検出**
  - 実測: main の T13 は、終わった session を拒否するが、匿名の session は通す
- **回帰**: `postona_g4_threads_entry_recheck_run.sh` → ALL_PASS
- **契約**: `deno test threads_connect_rpc_contract_test.ts` → **12 passed**（2件足した。isolation の試験を含む）。`postona_threads_edge/` は **41 passed**。
  - `_shared/social/` 全体の型の確認は、H5 の wiring の依存（`@supabase/supabase-js`・`@db/postgres`）で失敗する。#522 でも同じ2件なので、今回の変更とは関係しない。
- **アプリ**: 今回は変えていない（#522 の head で 314/314）。
- **NOT_VERIFIED**: G5・H5 の本物、本物の Auth・Vault・X・Threads・Meta、Edge のデプロイ、実機、本番

## 6. 残件
- 決めていない（G5・ユーザー）: R0、P-1、locked／ban、ログアウト、token の保持。
- 別に残っている課題: 候補 005・D8・本物の Vault の ACL。PR #124 の authenticated の EXECUTE は NO_GO。Issue #131 は延期のまま。
