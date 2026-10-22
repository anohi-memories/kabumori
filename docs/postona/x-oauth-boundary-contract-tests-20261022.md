# G4-22：X の接続のアプリとサーバーの境界の、合成の契約の試験（2026-10-22 JST）

- task_id: `postona-g4-x-oauth-mock-boundary-contract-tests-20261022`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **MOCK_ONLY_CONTRACT_TESTS／PRODUCTION_NO_GO**
  - 製品のコード（アプリ・Edge・SQL）は変えていない。外部への通信は0。
  - 本物の Auth・X・token・DB は使っていない。
  - Issue #131（B3・v2）はユーザーの延期のまま。再開していない。
- 土台: PR #426 の branch（`03968e5cab5e5bc462fe585d1a72b81c81e43657`、アプリの3つの確認を入れた版）。
- 元: G4-20（PR #437）の監査と、G4-21（PR #440）の B1〜B4 の設計。

## 1. 何を試験したか
- 新しい試験 `apps/social-mobile/tests/x-oauth-boundary-contract.test.mjs`（node、ネットワークなし）。
- **本物のアプリのフック**（`use-x-connect.ts`、PR #426）と、**本物のサーバーの処理**（`supabase/functions/x-oauth-connect-user/oauth_logic.ts`）をつないで動かす。間に `index.ts` と同じ順の小さな代わり（最初に本人を1回確かめてから振り分ける）を置く。
- 偽物にしたのは次の3つだけ。
  - **Auth**: `/auth/v1/user` は、token のセッションが生きている間だけ本人を返し、そうでなければ 403 `session_not_found`。auth-js 2.115.0 が書いている動き。本物の Supabase Auth では未確認。
  - **PostgREST**: JWT（sub と期限）だけを見て、**セッションは見ない**。X の今の3つの RPC（begin・consume・complete、`20260919120000`＋`20260922003101`）の**模擬**を動かす。
  - **X**: PKCE の challenge に結び付いた1回限りのコード、token の端点、`users/me`。
- **模擬が本物の SQL からずれないように固定した**（"model is pinned" の試験）。SQL の本文に次があることを確かめる。
  - consume の `initiated_by_user_id is distinct from v_user_id`、complete の `initiated_by_user_id = v_user_id and consumed_at is null`、owner の確認。
  - session・ライフサイクル・attestation の確認が**無い**こと。
  - complete が authenticated に付与されていること。
  - `index.ts` が本人を1回だけ、振り分けの前に確かめること。
  - callback の順が consume → X の交換 → 本人情報 → complete であること。
  - SQL が変わればこの試験が失敗するので、模擬も合わせて直す。

## 2. 結果（`03968e5c` の上、node v24.19.0）
| 区分 | 件数 | 結果 |
|---|---|---|
| 模擬の固定 | 1 | pass |
| CURRENT（今、守られていること） | 10 | **10 pass** |
| FUTURE（B1〜B4、まだ作っていない） | 4 | **todo 4**（4件とも、期待どおりに「拒否されない」で失敗している。todo は pass ではない） |
| 合計 | 15 | pass 11／fail 0／todo 4 |

- アプリ全体（`node --test tests/*.test.mjs`）: tests 303／pass 299／fail 0／todo 4（PR #426 の 288 ＋ 新しい 15）
- `tsc --noEmit`: エラーなし。`expo lint`: 問題なし。
- **修正前の失敗**: 同じ試験を main のフック（`0c42933c`）に当てた（`X_CONNECT_HOOK_SOURCE`）。pass 7／fail 4／todo 4。
  - 失敗したのは CURRENT 2・3・4・5。どれもアプリ側の確認で守られている項目。
  - サーバー側の CURRENT 6・8・9・10 は、修正前のフックでも通る（サーバーが守っているため）。

### CURRENT（守られていること）
| # | 場面 | 守っている側 | 確かめたこと |
|---|---|---|---|
| 1 | 同じ人・同じセッションの普通の接続 | 両方 | X の交換は1回。その人に結び付く。handle の表示と `onConnected` は1回 |
| 2 | 待機中に B がログイン（G2-CB5） | アプリ（PR #426） | callback を送らない。X の呼び出しは0。誰にも結び付かない。state は未消費 |
| 3 | 待機中に A がログアウト（G2-CB6） | アプリ | callback を送らない。X の呼び出しは0 |
| 4 | A→B→A（A の新しいセッション） | アプリ | callback を送らない。X の呼び出しは0 |
| 5 | 同じセッションの token の更新 | アプリ＋サーバー | 更新後の token で callback し、サーバーも受け付ける |
| 6 | 同じ callback が2つ同時（2つとも consume を通った） | サーバー＋X | 2つ目は X の1回限りのコードで拒否（`X_TOKEN_EXCHANGE_FAILED:400`）。完了は1つ、Vault の書き込みは1回分 |
| 7 | X の一時的な失敗（503）→ やり直し | 両方 | アプリは `retryable_error`。何も消費・結び付けしない。新しい接続で成功する |
| 8 | 別の人に結び付いている X アカウント | サーバー | 全体を取り消す（state は未消費）。成功を出さない。アプリの文に token などが無い |
| 9 | B の token で A の state（サーバーだけ） | サーバー | consume が拒否。X の呼び出しは0。別の人への結び付けは無い |
| 10 | ログアウト済みのセッションの token（サーバーだけ） | サーバー（偽の Auth の動き） | `/auth/v1/user` で 401。RPC も X も呼ばない |

### FUTURE（todo。今は守られていない。修正の設計は PR #440）
| # | 期待 | 今 | 修正の案 |
|---|---|---|---|
| B1 | A の古いセッションで始めた state を、A の新しいセッションで完了すると拒否する | 完了する | S1：state を `session_id` に結び付ける |
| B2 | `/auth/v1/user` の後、complete の前のログアウトは、complete で拒否する（何も結び付かず、state も未消費） | 完了する | S2：G5 の T13。ロックの方針は G5 に質問中（#320 6331312443、**未回答で待機**） |
| B3 | PostgREST で直接、交換していない X の id で complete すると拒否する | 結び付く（先取り） | S3：PR #126 の v2。**Issue #131 はユーザーが延期中。承認なしに再開しない** |
| B4 | POSTONA の利用が有効でない人は、X のコードを使う前に拒否する | X を呼ぶ | S4：T13 ＋ G5 R1（PR #353／#355。MERGE_NO_GO） |

## 3. G2・G5 の返答の反映
- **G2**: G4 が依頼した期待の更新（#317 6329061247）に対して、G2 は別の Draft PR で答えている。
  - #433：本物の supabase-js の SDK で、#426 が CB5・CB6 を拒否に反転させることを確認。
  - #436：#419・#425 の旧い6件を、G2 自身の準備（合成の getSession・本物の recovery-binding）で互換にした。
  - この試験は G2 のファイルに触れず、**サーバーの処理まで含めた**組み合わせを足している（G2 の試験は、Edge を模擬の関数にしている）。
- **G5**: T13 のセッションのロックの方針への返答は**まだ無い**（待機）。PR #440 の設計の文書は変えていない。返答が来たら、B2 の todo の期待（ロックするか、読むだけか）と設計を合わせて直す。

## 4. この試験の限界
- PostgREST・Auth・X は模擬。とくに「PostgREST はセッションを見ない」「ログアウト後の `/user` は 403」は、文書と SDK による前提で、本物では未確認。
- RPC は SQL の本文に固定した模擬で、本物の PostgreSQL で動かしてはいない（本物の SQL の試験は、修正の TASK の PG17 の試験で行う。PR #440 §5）。
- 実機、本物の Supabase、X、本番は NOT_VERIFIED。
