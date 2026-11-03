# G4-40：X の OAuth 候補（PR #511）を製品につなぐ差分と統合 QA（2026-10-25 JST）

- task_id: `postona-g4-x-oauth-pr511-product-wiring-integration-candidate-20261025`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定:
  - **SOURCE_INTEGRATION_CANDIDATE_PASS**: 製品と同じ形の、隔離した PG17 で測った。
  - **G5_WIRING_NOT_DONE**: G5 の本物の判定にはつないでいない。
  - **PRODUCT_NOT_FIXED**: 製品は直っていない。
  - **PRODUCTION_NO_GO**: 本番には出せない。
- 土台: PR #511（`c686644ef3951dca722f0c4ff7b66750e4bdb23f`）。製品は main `0c42933c` に固定した。

## 1. 製品と照らし合わせて見つかったこと（001 だけでは製品に入れられない理由）
| 記号 | 製品の事実（main） | 001 の問題 | 002 での対応 |
|---|---|---|---|
| W1 | `social_accounts.connection_status` に CHECK がある（5つの値だけ。`20261007150000` L232） | disconnect が `'disconnected'` を書き、CHECK 違反になる（実測） | `'unconnected'` にした。アプリはこれを「もう一度接続」と扱う（`onboarding.ts`、`connect_x`） |
| W2 | X の token を書き換えるのは、更新の lease だけ（`x_account_refresh_state_v2` と `begin_`／`commit_x_account_refresh_*`）。commit は、行が変わっていれば `account_changed` で拒否する | `store_refreshed_x_tokens` が2つ目の書き手になる。同時に動く lease の commit が、黙って上書きする（実測） | 削除した。書き手は lease だけにした |
| W3 | **main にすでにある deadlock**: 接続の complete（行のロックから、表の ROW EXCLUSIVE へ）と、更新の commit（表の SHARE ROW EXCLUSIVE から、行のロックへ）が同時に動く | main でも 001 でも、commit が `X_REFRESH_PERSIST_FAILED` で失敗する。`deadlocks` が1増える。lease は `refreshing` のまま残る（X はもう token を回転させた後） | begin・complete・disconnect の最初に、`lock table social_accounts in row exclusive mode` を足した。commit とは順番に動き、commit は `account_changed` になる |

- 002 の begin と complete は、001 の本体に W3 の1行だけを足したもの。`build` で作り、001 の行の範囲を照合した。
- disconnect は、001 の本体に W1 と W3 を足したもの。
- `x_connection_epoch` は残した。更新を担当する側へ、追加の柵として提案する。結線はしていない。

## 2. ファイルの分類
| ファイル・関数 | 持ち主 | この TASK |
|---|---|---|
| X の begin・complete（main の `20260922003101`・`20260919120000`）と 001／002 | **G4** | 002 で差し替える候補を作った（適用はしていない） |
| `postona_g4_x_oauth.*`（001／002） | **G4** | 002 で、2つ目の書き手を削除し、disconnect を直した |
| X の token の更新（`x_account_refresh_*`、`20260925140000`・`150000`・`26032054`） | **G4 ではない**（X 投稿 worker の担当。G3 か X bot の担当に確認が要る） | 読んだだけ。R-1・R-2 を提案した |
| Edge `x-oauth-connect-user` | G4（変えていない） | RPC の message をそのまま code として返す（`oauth_logic.ts:101`）。HTTP は 400 |
| アプリ `use-x-connect.ts`・`onboarding.ts` | G1・G2 | 変えていない。文言は §4 |
| G5 の判定3つ（PR #506・#510・owner epoch） | **G5** | 名前と形と EXECUTE だけを確かめる（001 のまま） |

## 3. 利用者の操作への影響（002 を適用した場合）
- **初めての接続・再接続**: 今と同じ。再接続のあとは今と同じく投稿が OFF になる（`publish_enabled=false`）。
- **古い brand や共有の brand を持つ人**: 接続できなくなる（`OWN_WORKSPACE_CONFLICT`）。アプリは「最初からやり直してください」としか出さず、先へ進めない。
  - 移行（P-1）が決まるまでは、該当する人の X 接続が止まる。
  - 本番に該当者がいるかは調べていない（NOT_VERIFIED）。
- **匿名・失効した session**: begin も callback も拒否する（「最初からやり直し」）。サインインし直しを促す文言が必要。
- **古い callback・重複・期限切れ**: 拒否する（「最初からやり直し」）。今と同じ扱い。
- **切断**: 製品には切断の RPC も画面もない。候補の関数は API のロールに grant していない。
- **接続と token の更新がぶつかった場合**: main では更新の lease が `refreshing` のまま止まり、運用で手当てするまで更新できない。002 では `uncertain` になり、R-1 のとおり、もう一度再接続すると直る。

## 4. 他の担当への IF と採用の順番
- **G5**:
  - Q13（callback で確かめ直す）・Q10（匿名は同じ code）・Q11（ABA の後は再接続）に合意すること。
  - begin と complete の owner が、G5 の3つの関数を EXECUTE できるようにすること（001 は、できなければ適用を拒否する。実測）。
- **token の更新を担当する側**（G4 ではない）:
  - **R-1**: 再接続の reset の trigger は、lease が `refreshing` の間は何もしない。そのため、遅れて来た commit が `uncertain` にした後も、もう一度再接続するまで更新が止まる（main で実測）。
  - **R-2**: commit の柵は `updated_at` が等しいかどうかに頼っている。`connection_epoch` を lease の begin で記録し、commit で比べる案。
- **G3**（Q9・Q12）: worker は、更新の lease の外で token を書かないこと（W2）。
- **アプリ（G1・G2）**: `OWN_WORKSPACE_CONFLICT`・`WORKSPACE_OWNER_UNKNOWN`・`SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE`・`OAUTH_STATE_SUPERSEDED` などの文言。今はすべて「最初からやり直してください」になる。
- **採用の順番**:
  1. G5 の判定3つのレビューと適用、EXECUTE の付与
  2. Codex Sol（高）による一括のレビュー（§5 のファイル）
  3. 001 → 002 の順に適用（それぞれ前提条件で止まる）
  4. アプリの文言
  5. R-1・R-2（更新の担当）
  - 本番は owner の明示の承認があってから。

## 5. Codex Sol（高）がまとめてレビューするもの
- PR #511 `c686644e…`: `001_x_oauth_personal_epoch.sql`・その rollback・G4-39 の試験
- この PR: `002_x_oauth_product_wiring.sql`・その rollback・`postona_g4_x_oauth_product_wiring_{shape.sql,behavior.sql,run.sh}`
- 一緒に読むもの:
  - G5 PR #506 `bbc52a6b…`・PR #510 `6d59f3b6…`
  - main の `20260925140000`（更新の中核）と `20261007150000`（形）

## 6. 試験（`supabase/tests/postona_g4_x_oauth_product_wiring_run.sh`、2026-10-25 JST、2回とも同じ結果）
- 製品と同じ形にした（`social_accounts` の CHECK・UNIQUE、provider guard、更新の中核を main からそのまま読み込み、Vault は偽物）。
- **behavior**:
  - current（main）**23/23**: R-1 と B2・B6 の今の振る舞いを再現した。
  - c001（001 まで）**24/24**: W1 の CHECK 違反と、W2 の二重の書き手を再現した。
  - wired（001 と 002）**30/30**: 接続、更新、再接続中の古い lease、切断、切断中の lease、B2・B6、guard と UNIQUE が残ることを確かめた。
- **2つの session を同時に動かした（W3）**:
  - current と c001: `B=X_REFRESH_PERSIST_FAILED`、deadlocks=1、状態は `refreshing` で止まった。
  - wired: `B=account_changed`、deadlocks=0、状態は `uncertain`。
- **適用の拒否 5件**:
  - 001 が無いときの 002
  - 002 の再適用
  - 削除した書き手がまだ使われているとき
  - status の CHECK に `unconnected` が無いとき
  - owner が G5 の関数を EXECUTE できないときの 001
- **002 の rollback**: 未適用なら拒否する。戻すと 001 とまったく同じになり（後の確認の md5 で照合）、その後 c001 は 24/24。
- **欠陥 4/4 を検出**: `'disconnected'`、行を変えない切断、書き手を残す、complete の W3 を外す。
- **回帰**: G4-39 の runner をこの branch でもう一度実行し、51/51・75/75・ALL_PASS。

## 7. 未実施（NOT_RUN）と残件
- **未実施**:
  - G5 の本物の判定（偽物で代えた。作業場所の判定は PR #506 の本体を複製）
  - 本物の Vault の ACL、Edge 経由の E2E
  - `20260925150000`（v2 の lease）・`20260926032054`（rollout が begin を差し替えるもの）を重ねた試験
  - 削除の saga
  - begin と disconnect の W3 の同時実行（行は足したが、欠陥の検出は complete だけ）
  - 本番
- **決めていない（G5・ユーザー）**: R0、P-1、locked／ban、ログアウト、切断の後の token の保持。
- **別に残っている課題**: 候補 005・D8・H5 の transport・本物の Vault の ACL。PR #124 の authenticated の EXECUTE は有効にしない。Issue #131 は延期のまま。
