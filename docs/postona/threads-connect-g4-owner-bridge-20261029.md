# G4-50：Threads の接続を G4 の入口に通す owner bridge（2026-10-29 JST）

- task_id: `postona-g4-threads-product-oauth-finish-g4-owned-adapter-20261029`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定:
  - **G4_THREADS_OWNER_BRIDGE_E2E_PASS_NONPROD**: G4 の bridge を使うと、Threads の接続のサーバー側が、非本番で最後まで通る
  - **NOT_WIRED**: H5 の server factory に、bridge を差し替える口が無い（§3）。Edge の入口は hard-disabled のまま
  - **PRODUCT_NOT_DEPLOYED**／**PRODUCTION_NO_GO**
- 土台: PR #557（`97e0f0e0273d784da2bf2cbcc65fca727945714b`）

## 1. 作ったもの（G4 の持ち物だけ）
- `supabase/candidates/postona_g4_threads_personal_auth/owner_bridge.ts`（`createG4ThreadsOwnerBridge`）
  - H5 の owner transport と同じ4つの呼び出し（begin・claim・complete・uncertain）を持つ。H5 の `createThreadsRuntime` に、そのまま渡せる。
  - **begin**: PR #124 の begin と H5 の remember の後、**同じ transaction** で `postona_threads_binding.record_state_generation` を呼ぶ。始めた時点の owner epoch と lifecycle_version を、その state に記録する。
  - **complete**: PR #124 の complete を直接呼ばない。G4 の入口 `complete_and_attest_binding` を呼ぶ（PR #124 の complete、binding、G4-42 の作業場所の再確認、G4-43 の本人 session の確認が1回の呼び出しに入っている）。custody の書き込みは、その入口が同じ transaction に残す connect proof を使う。
  - **claim・uncertain**: H5 の SQL（`postona_threads_runtime.*`）をそのまま使う。
  - **SQL の claims**: `is_anonymous=false` を入れるのは、H5 の `createActorVerifier` が封印した actor だけ。封印の条件は、JWT の claims と GoTrue の user の **両方** で `is_anonymous === false` であること。`requireVerified` は、封印されていない actor を、接続を開く前に拒否する。
    - 入れる場所は JSON の claims と、1つずつの GUC（`request.jwt.claim.is_anonymous`）の両方。G5 の S2-2 は、sub の GUC があると、1つずつの GUC を読むため。
  - owner role の確認（H5 と同じ。加えて、G4 の入口の持ち主と同じ role であること）。GRANT・ACL の変更、固定の許可、再試行はしていない。
- `.../owner_bridge_test.ts`（単体試験）: 偽の actor（封印されていない）は拒否され、接続も開かない。匿名・値が無い・文字列の `"false"` は、verifier で拒否される。
- `supabase/tests/postona_g4_threads_bridge_flow.smoke.ts` と、`postona_g4_threads_person_session_run.sh` の `G4T_BRIDGE_FLOW=1` の段（通し試験）

## 2. 通し試験（実測。非本番、外部への通信は0）
- **本物を使ったもの**:
  - G4 の Edge の handler（`createThreadsConnectHandler`）
  - H5 の runtime（`createThreadsRuntime`）と actor verifier
  - G4 の bridge、`@db/postgres`
  - PostgreSQL 17 の上の本物の SQL: PR #124、G4 の binding entry 001、custody proof 002、G4-42 の 001、G4-43 の 002、H5 の claim SQL、G5 の S2-3・S2-2 の行
- **偽物にしたもの**: GoTrue、Threads（code・long-lived・profile）、ブラウザでの承認
- **結果**: 8場面と、負の確認4件がすべて PASS（`G4T_BRIDGE_FLOW_ALL_PASS`）

| # | 場面 | 結果（拒否の理由は SQL のエラー） |
|---|---|---|
| 1 | A が接続する | 接続できる。binding・generation（begin で記録し、complete で attest）・custody が1つの transaction でそろう |
| 2 | A が再接続する | 新しい state で binding が置き換わる |
| 3 | 同じ session で token だけ更新 | 接続できる |
| 4 | A → B → A（A の新しい session で callback） | Threads を呼ぶ前に拒否（`H5_STATE_NOT_USABLE`）。binding は変わらない |
| 5 | 匿名 | start で拒否（actor verifier）。state は作られない |
| 6 | POSTONA を始めていない | start で拒否（`ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND`）。state は作られない |
| 7 | ABA（start と callback の間に、サービスを終えて始め直す） | 拒否（`THREADS_BINDING_SERVICE_GENERATION_CHANGED`）。binding は無く、state も消費されない |
| 8 | G4 の入口が入っていない DB | start で拒否（owner の確認、fail-closed）。state は作られない |

- **負の確認**（G4 の各段を外すと、接続できなくなる）:
  - claims から `is_anonymous` を外す → `THREADS_SESSION_NOT_ACTIVE`
  - `record_state_generation` を飛ばす → `THREADS_BINDING_GENERATION_UNRECORDED`
  - complete で PR #124 を直接呼ぶ → `THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION`
  - **H5 の owner transport をそのまま使う → 同じく `THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION`**（H5 の今の transport では、この構成で接続を完了できない）
- 回帰:
  - G4-43 の runner（`G4T_PERSON_SESSION_ALL_PASS`、mutant 2/2 を検出）
  - X の通し試験（mode=main 7/7、mode=g4 7/7）
  - Threads の Deno の単体試験（36 + 28 PASS）
  - H5 の runtime_test 32、connector_test 15、offline_isolation 1
  - アプリの `npm test` 324/324、`tsc`・`expo lint`・`deno lint`・`deno check` exit 0
- **既存の失敗**（G4 は H5 のファイルを変えていない）:
  - H5 の `runtime_test.ts` は型チェックで2件のエラー（`--no-check` なら 32 PASS）
  - H5 の `source_isolation.smoke.ts` の1件は、`functions/account-delete/provider_cleanup.ts` がこの stack に無いため FAIL
- 注: この world の T13 は main の write guard（PR #178 の版）。G5-44 の T13（is_anonymous の claim が無いと拒否する版）では、まだ回していない。
- 7 の ABA は complete の時点で見つかるため、Threads の code は使われた後になる（runtime の答えは `COMPLETE_OUTCOME_UNKNOWN`、照合が必要）。
- **NOT_VERIFIED**: 本物の Threads OAuth・GoTrue・PostgREST・managed・Edge のデプロイ・実機、アプリの hook から通す試験（Node と Deno の間）、切断（F4 の `social-mobile-threads-disconnect`）、本番

## 3. 他の担当への最小の IF（G4 は他の担当のファイルを変えていない）
1. **H5**（`wiring/server_factory.ts`）: `ConstructionPorts` に bridge の口を足す。
   ```ts
   /** G4's owner bridge (createG4ThreadsOwnerBridge); default stays createOwnerTransport. */
   bridgeFactory?: (connect: () => Promise<OwnerSqlClient>) => ReturnType<typeof createOwnerTransport>;
   // in createSourceServer:
   bridge: (ports.bridgeFactory ?? createOwnerTransport)(ports.ownerConnect ?? createPostgresConnector(c)),
   ```
   - `nondeployable.ts` の `buildForApprovedSourceIntegration` にも、同じ引数を通す。
   - 代わりに H5 が自分の transport を直す場合は、§1 の3点（generation の記録、G4 の入口、`is_anonymous` の claim を2か所）が要る。
2. **F4**（`_shared/social/threads_connect_entry.ts`）: composition に `createG4ThreadsOwnerBridge` を渡す（1行）。門（`THREADS_CONNECT_EDGE_WIRED`）は閉じたまま。
3. **G5**: G4 の bridge は `private.account_lifecycle_brand_owner_epoch`（PR #303）と `common_accounts.lifecycle_version` を読む。G5-46・G5-47 の「owner epoch の無い個人 MVP」（g5pv）を正式にするなら、G4 の入口の 001 が epoch を必須にしている点を、G4 の次の候補で合わせる必要がある（この PR では変えていない）。
4. **G1・G2**: アプリ側は既にある（接続カードは `app/accounts/index.tsx` と `[id].tsx`、切断カードは F4）。要るのは、callback の URL（`expo.extra.threadsConnectCallbackUrl`）と app link（Associated Domains・Android App Links）の設定、そして公開の flag。
5. **採用の順**:
   1. PR #124 と G4 の SQL（001・002・G4-42・G4-43）と H5 の claim SQL を、非本番に lifecycle owner で入れる
   2. H5 の口（上の 1）
   3. F4 の1行（上の 2）
   4. 新しい認証の境界（owner の claims）として、bridge を1回だけ独立レビュー
   5. Edge のデプロイ（非本番）と callback の設定
   6. 開発 build で、本物の Threads を使って確かめる（明示の承認の後）
