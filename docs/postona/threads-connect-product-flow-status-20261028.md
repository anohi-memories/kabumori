# G4-49：Threads の接続を、製品の1つの流れにまとめる（2026-10-28 JST）

- task_id: `postona-g4-personal-mvp-threads-connect-edge-hook-real-flow-batch-20261028`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定:
  - **THREADS_APP_SESSION_PIN_FIXED**: アプリ側の修正を1件行った（下の §2）
  - **THREADS_SERVER_CHAIN_BLOCKED**: サーバー側は、H5 と PR #124 の採用待ち（§3）
  - **PRODUCT_NOT_DEPLOYED**／**PRODUCTION_NO_GO**
- 土台: PR #552（`b75748254086aa54d635e0a9a51dd06251eedef7`）

## 1. 経路の各段の状態（G4-48 の §1 を、この branch で読み直した）
| 段 | 状態 | 持ち主 |
|---|---|---|
| アプリの hook・starter・runtime | `apps/social-mobile/src/features/threads-connect/` にある。release の flag は OFF、callback の URL は未設定 | G4（この PR で修正） |
| 画面 | `threads-connect-card.tsx` はある。画面への組み込みは flag OFF | G1・G2 |
| Edge の入口 | `supabase/functions/threads-oauth-connect-user/index.ts` は **hard-disabled**（何も組み立てない） | H5 |
| Edge の handler | G4 の `_shared/social/threads_connect_edge.ts`（`THREADS_CONNECT_EDGE_WIRED=false`） | G4 |
| サーバーの runtime・transport | H5 の `supabase/candidates/postona_threads_auth_runtime/`（候補） | H5 |
| SQL | PR #124 の begin・consume・complete と、G4 の entry（`postona_threads_binding.complete_and_attest_binding`、001 S2-3・002 S2-2）。どれも未採用 | PR #124・G4 |

## 2. この PR の修正（アプリ、G4 の持ち物）
- **問題**: starter は、戻ってきたときに「同じ人か」（user id）しか見ていなかった。A → B → A と入れ替わると、A の **新しい session** でも callback を送ってしまう。サーバーは session の違いで拒否するが、それは Threads の code を使い切った後になる。
- **修正**: X の接続（#426）と同じく、開始時の JWT の `session_id` と、今の JWT の `session_id` が一致しないと `SESSION_CHANGED` で止める。サーバーへは送らない。同じ session の token の更新（refresh）は、そのまま通す。
- **試験**（`tests/threads-connect.test.mjs`）:
  - 新しい session の A → `SESSION_CHANGED`、サーバーへの呼び出しは開始の1回だけ
  - 同じ session の token の更新 → 接続できる
  - **fail-before**: 古い starter では、新しい session の試験が FAIL した（pass 19／fail 1）
  - 既存の試験の token を、JWT の形（sub・session_id）に直した

## 3. サーバー側が通らない理由（証拠は source の行）
1. **Edge の入口が hard-disabled**（`threads-oauth-connect-user/index.ts` L2〜4。source の門が閉じている間は H5 の無効な handler）。H5 が組み込むまで、どの経路でも動かない。
2. **H5 の transport が G4 の entry を通らない**:
   - complete は `public.complete_social_mobile_threads_oauth_connection` を直接呼ぶ（`owner_transport.ts` L171）。G4 の `complete_and_attest_binding` の S2-3・S2-2 の再確認と binding epoch を通らない。
   - begin（L108）の後に `record_state_generation` が無い。
3. **H5 の transport が SQL の session に `is_anonymous` の claim を渡さない**（`owner_transport.ts` L53〜58 は sub・session_id・role だけ）。Edge では GoTrue で匿名を拒否している（`verified_actor.ts` L50・L59）が、G5 の T13 と G4 の entry の S2-2 は、claim が無いと fail-closed で拒否する。
4. **PR #124 が未採用**（authenticated の EXECUTE は NO_GO のまま）。
5. **アプリの callback の URL と app link が未設定**。release の flag も OFF。

## 4. H5 への依頼（IF の案。G4 は H5 のファイルを変えていない）
- complete は G4 の entry（`postona_threads_binding.complete_and_attest_binding`）を呼ぶ。
- begin の後に、同じ transaction で `record_state_generation` を呼ぶ。
- SQL の session の claims に `is_anonymous`（GoTrue で確かめた値）を入れる。
- その後に G4 が、Threads の通し試験（アプリの hook → supabase-js → Edge → H5 の runtime → PG17、Threads・GoTrue は偽物）を、X の `postona_g4_x_oauth_app_flow_run.sh` と同じ形で作る。

## 5. 実測（非本番、外部への通信は0）
- アプリ: `npm test` 324/324、`tsc` exit 0、`expo lint` exit 0
- X の通し試験の回帰（`supabase/tests/postona_g4_x_oauth_app_flow_run.sh`、PG17）: mode=main 7/7、mode=g4 7/7、`G4X_APP_FLOW_ALL_PASS`
- **NOT_VERIFIED**: Threads のサーバー側の通し試験（§3 のため）、本物の Threads OAuth・GoTrue・PostgREST・managed・Edge のデプロイ・実機、本番
