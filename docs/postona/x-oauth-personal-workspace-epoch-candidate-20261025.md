# G4-39：X の begin・callback の作業場所・epoch の不整合を直す、G4 の実装候補（2026-10-25 JST）

- task_id: `postona-g4-x-begin-callback-personal-workspace-epoch-candidate-batch-20261025`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定:
  - **SOURCE_CANDIDATE_PASS**: 隔離した PG17 で測った。Auth・Vault・G5 は偽物。
  - **G5_WIRING_NOT_DONE**: G5 の本物の判定への結線はしていない。
  - **PRODUCTION_NO_GO**: 本番には出せない。製品に採用する前に、Codex Sol（高）がこの一式をまとめてレビューする必要がある。
- 土台: PR #508（`c60eb99c12c4d90bb051976bb05b590c2a90d55f`）。製品の行は main `0c42933c` に固定した。
- G5 の参照先（読み取りだけ）:
  - PR #506（`bbc52a6b…`）: S2-3 の作業場所の判定。本体を検証用にそのまま複製した。
  - PR #510（`6d59f3b6…`）: S2-2 の本人 session の判定。名前と形だけを使った。

## 1. 直したもの（G4 が持つ X の OAuth）
| 記号 | 今の main（再現した） | 候補 |
|---|---|---|
| B2 | begin が、持っている brand が1つなら何でも使う（古い・共有の brand） | 本人の作業場所（`u_`）だけを使う |
| B6 | 他の人が作った `u_` の行に、`on conflict do nothing` で2人目の owner として加わる | 加わらない。insert が負けたら拒否する（RACE の件） |
| S1-F2 | begin も callback も、匿名や失効した session を拒否しない | G5 の session の判定が `active` のときだけ通す（両方の段で） |
| B10 | callback は membership しか見ない | callback でも G5 の作業場所の判定を聞き直す（G4 から G5 への Q13 の提案） |
| OE | X には owner epoch が無く、A→B→A でも接続できる | begin で G5 の owner epoch を記録し、callback で比べる |
| SUP | 古い保留の state が、新しい begin の後でも完了する | 最後の begin だけが完了できる |
| CE | 接続の世代が無く、再接続の後に古い token を持つ側が新しい token を上書きできる | `connection_epoch` と CAS で保存する関数 |
| NUL | 完了時の空の token の確認が NULL を通す | `coalesce` で弾く |

拒否の code（Edge は RPC の message をそのまま code として返す。`oauth_logic.ts:101`）:
- `SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE`・`OWN_WORKSPACE_CONFLICT`・`WORKSPACE_OWNER_UNKNOWN`
- `WORKSPACE_VERDICT_UNKNOWN`・`OWNER_EPOCH_UNAVAILABLE`・`OWNER_EPOCH_CHANGED`
- `OAUTH_STATE_SUPERSEDED`・`OAUTH_STATE_NOT_BOUND`
- `X_CONNECTION_CHANGED`・`X_CONNECTION_NOT_FOUND`

## 2. ファイル
- `supabase/candidates/postona_g4_x_oauth_personal_epoch/001_x_oauth_personal_epoch.sql`
  - 公開の begin と complete を、同じ signature・owner・ACL のまま差し替える（CREATE OR REPLACE）。
  - G4 の schema `postona_g4_x_oauth` を作る。
    - 表: `connections`（epoch と latest state）・`state_bindings`
    - 関数: disconnect・epoch の読み出し・CAS の保存。API のロールには grant しない。
  - 適用の前に次を確かめて、違えば止まる:
    - 製品の本体の md5
    - G5 の3つの関数があること、その形、owner が EXECUTE できること
  - 適用の後に確かめる: ACL が変わっていないこと、API のロールが G4 の schema に届かないこと。
- `…/001_x_oauth_personal_epoch_rollback.sql`
  - 2つの本体を、main からそのまま写して戻す（md5 は一致した）。そのあと G4 の schema を消す。
  - 適用されていないとき、他の関数が G4 の schema を呼んでいるときは拒否する。
- `supabase/tests/postona_g4_x_oauth_personal_epoch_{world.sql,behavior.sql,run.sh}`

## 3. G5 から受け取るもの（結線はしていない）
| 関数（G5 の名前） | G4 がそれをどう扱うか |
|---|---|
| `private.postona_personal_session() -> text`（PR #510） | `active` のときだけ通す。NULL やほかの値は拒否する |
| `private.postona_personal_workspace_eligibility(uuid) -> text`（PR #506） | `absent` なら作る（作った直後にもう一度聞く）、`own` なら使う。2つの code はそのまま返し、それ以外は `WORKSPACE_VERDICT_UNKNOWN` |
| `private.account_lifecycle_brand_owner_epoch(text) -> bigint` | NULL や 1 未満なら拒否する。begin で記録し、callback で等しいかを比べる |

G5 に合意してほしいこと:
- **Q13**（提案）: callback でも判定を聞き直す。候補ではそう実装した。
- **Q10**（提案）: 匿名の場合は、begin でも callback でも、同じ `SESSION_NOT_ACTIVE` で拒否する。結果を読み直す経路は、この候補には含めていない。
- **Q11**: ABA の後は、新しく begin し直せば接続できる（`OE a fresh begin after the ABA connects` で測った）。
- **EXECUTE**: G5 の3つの関数は今「lifecycle owner だけ」が実行できる。begin と complete の owner が実行できる必要がある。候補は、適用の前にこれを確かめる。
- **後片付けの対象**: 新しい表2つは、`social_accounts` と `oauth_states` の削除に連動して消える（cascade）。G5 の削除の saga・在庫の一覧に載せるかは、G5 が決める。

## 4. G3・アプリへの IF
- **G3**（Q9・Q12）: X の worker が token を使うときは、`x_connection_epoch(account)` を持ち、更新は `store_refreshed_x_tokens(account, epoch, …)` だけで行う案。再接続・切断の後は `X_CONNECTION_CHANGED` になる。worker への結線は G3 の TASK。
- **アプリ（G1・G2）**: 新しい code の文言を決めること。Edge は変えていない。
- **disconnect**: 今の製品に X の切断の RPC は無い。候補の関数は API のロールに grant していない。Edge やアプリからつなぐのは、レビューの後の別の TASK。

## 5. 試験（`supabase/tests/postona_g4_x_oauth_personal_epoch_run.sh`、2026-10-25 JST、隔離した PG17）
- **mode=current**（main の本体）: **51/51**。欠陥は B2・B6・RACE・B6b・B6c・S1F2・B10・SESS・OE・SUP・NUL・LEG のとおり再現した。
- **mode=candidate**: **75/75**。
  - 上の欠陥はすべて拒否した。
  - 正常な接続・再接続、重複・期限切れ・他の人の callback、失敗の後の rollback と再試行、X の識別子の重複、切断、CE、CAS、権限を測った。
- **同時の2つの session**:
  - 同じ state への同時の完了: 片方が OK、もう片方は待ってから（0.71 秒）`OAUTH_STATE_NOT_CONSUMABLE`。
  - 同じ人の最初の begin が同時に2つ: 2つとも OK。owner は1、member も1、latest は後の begin。
- **適用の拒否**: 再適用、製品の本体が違う場合、G5 の関数が無い場合。
- **rollback**: 未適用のときと、まだ参照されているときは拒否した。戻した後の md5 は main と一致し、mode=current は再び 51/51。
- **欠陥 11/11 を検出**:
  - session の無視、UNKNOWN の許可、`absent` の経路で加わる
  - complete の作業場所の確認を省く、owner epoch を省く、superseded を省く、epoch を進めない
  - 古い state の許可、NULL token の許可、切断が state を残す、CAS が epoch を無視する

## 6. 採用の門と、まとめてレビューするもの
1. G5 が §3 の IF を受け入れ、G5 の S2-2・S2-3・owner epoch のレビューを通す。
2. Codex Sol（高）が、この一式（候補・rollback・試験）を、G5 PR #506・#510 と G3 の worker の結線と一緒にレビューする。
3. G3 が worker を CAS に結線する。アプリが code の文言を決める。
4. 本番: owner の明示の承認。そのときは、本番の本体の md5 を読み取りだけで確かめてから。

## 7. 未実施（NOT_RUN）と残件
- 本物の DB・Auth・Vault・X・本番は使っていない。
- G5 の本物の session の判定と owner epoch の関数は使っていない（偽物）。作業場所の判定は、PR #506 の本体をそのまま複製して使った。
- 本物の Vault の ACL、Edge 経由の E2E も未実施。
- 決めていないもの（G5・ユーザー）: R0、古い・共有の作業場所の移行（P-1）、locked／ban、ログアウト、切断の後に token をどれだけ残すか。
- 別に残っている課題: 候補 005（TOCTOU）・D8・H5 の transport・本物の Vault の ACL。PR #124 の authenticated の EXECUTE は有効にしない。Issue #131 は延期のまま。
