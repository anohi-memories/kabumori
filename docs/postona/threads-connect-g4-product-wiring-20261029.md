# POSTONA Threads 接続 — G4 の製品配線とアプリからの通し試験（G4-02 #1, 2026-10-29）

task_id: `postona-g4-gen2-01-threads-auth-bridge-product-wiring-batch-20261029`（Issue #561）。
状態: **配線済み（source）・門は閉じたまま・未デプロイ・PRODUCTION_NO_GO**。

## 1. 何を配線したか

| 部品 | 担当 | この PR |
| --- | --- | --- |
| アプリの接続カード・hook・starter（session 固定） | G4（G4-49 まで） | 変更なし。そのまま試験 |
| SDK（`supabase.functions.invoke('threads-oauth-connect-user')`） | 既存 | 変更なし |
| Edge の入口 `functions/_shared/social/threads_connect_entry.ts` | **G4**（F4 = G4 の系譜。F4 の 3163928d／PR #251） | 門を通った後に読む composition を、H5 の `nondeployable.ts` から G4 の `composition.ts` に変更（動的 import のみ） |
| G4 の composition `candidates/postona_g4_threads_personal_auth/composition.ts` | G4（新規） | H5 の `createSourceServer` と同じ組み立て（厳格な config・`/auth/v1/` 固定の SDK・redirect "error"・5秒・issuer の確認・H5 の verifier と runtime・TLS 固定の connector）。違いは1点だけで、bridge が G4 の `createG4ThreadsOwnerBridge`（G4-50） |
| H5 の runtime・verifier・config・connector | H5 | **変更なし** |
| G4 の owner bridge（G4-50） → SQL | G4 | 変更なし |
| 切断の Edge `social-mobile-threads-disconnect` とアプリの切断カード | G4（F4 PR #167 の系譜） | 変更なし。そのまま試験 |

門は3つとも閉じたまま。`THREADS_CONNECT_EDGE_WIRED=false`（入口は H5 の disabled handler そのもの）、`THREADS_CONNECT_ENABLED` は未設定、`THREADS_DISCONNECT_SERVER_ENABLED=false`。SQL の `threads_disconnect_gate_open()` は `false` のまま。

**訂正（G4-50 の REPORT）**: 「F4 の1行」を他の担当の作業として書いたが、F4 は G4 の前身の枠で、入口は G4 の持ち物。この PR で G4 が行った。

## 2. 通し試験（アプリの hook → SDK → Edge の入口 → G4 の composition → H5 の runtime・verifier → G4 の bridge → SQL）

`G4T_APP_FLOW=1 supabase/tests/postona_g4_threads_person_session_run.sh`（TB_PGHOST/TB_PGPORT/TB_PGSUPER）。

- アプリ側（Node）: 本物の `use-threads-connect`・starter・runtime・`use-threads-disconnect`・runner・runtime を transpile して実行。本物の supabase-js。偽物は expo の各モジュールと React の hook の器だけ。
- Edge 側（Deno の子プロセス、127.0.0.1 のみ）: 本物の `createThreadsConnectEntry` → 本物の G4 composition。差し替えたのは試験用の2つの口（`ownerConnect` = 隔離 PG17 のソケット、`fetch` = 偽の GoTrue と偽の Threads）だけ。GoTrue の JWT は RS256 で本当に署名し、本物の SDK が JWKS で検証する。
- 切断: 本物の `createHandler`（門が閉じた状態）と、本物の `handleThreadsDisconnect` + `createGetUser` + `createThreadsDisconnectRpc`（門を開けた状態）。PostgREST は psql を使う偽物（`set local role authenticated` + `request.jwt.claims`）。
- SQL: real G5（T13・Phase 4・brand state・Phase 6）+ PR #303 + PR #124 + G4 001/002・G4-42/43 + H5 の claim SQL + publish・cleanup・切断の候補。隔離した PG17。外部への通信は0。

| # | 場面 | 結果 |
| --- | --- | --- |
| 1 | A が接続。binding・custody 1件。accounts の再読み込みで画面が verified | PASS |
| 2 | 再接続。binding が新しい state に置き換わる。account も custody も1件のまま | PASS |
| 3 | Threads にいる間に token を更新（同じ session） | PASS |
| 4 | Threads にいる間に B がサインイン → `SESSION_CHANGED`。callback は送らない | PASS |
| 5 | A → B → A（A の新しい session）→ アプリが code を送る前に拒否（G4-49） | PASS |
| 6 | 匿名 → `START_REFUSED`。state 0、ブラウザ 0、Threads の呼び出し 0 | PASS |
| 7 | POSTONA を始めていない C → `START_REFUSED`。SQL の拒否理由 `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND` | PASS |
| 8 | ABA（D が Threads にいる間に lifecycle_version +2。合成の操作）→ `COMPLETE_OUTCOME_UNKNOWN`（照合が必要）。拒否理由 `THREADS_BINDING_SERVICE_GENERATION_CHANGED`。binding・custody 0 | PASS |
| 9 | Threads が code を拒否 → `EXCHANGE_OUTCOME_UNCERTAIN`（照合が必要）。binding なし | PASS |
| 10 | Threads で取り消し → canceled。callback は送らない | PASS |
| 11 | source のままの入口（静的な門が閉じている）→ `THREADS_CONNECT_DISABLED`。ブラウザ 0 | PASS |
| 12 | callback が未設定のビルド → `CALLBACK_NOT_CONFIGURED`。要求 0 | PASS |
| 13 | source のままの切断（門が閉じている）→ `THREADS_DISCONNECT_DISABLED`。binding・custody は残る | PASS |
| 14 | 試験の world だけで切断の門を開けて切断 → `LOCAL_REMOVED`。account の行が消え、binding と custody も CASCADE で消える。そのあと再接続 → binding・custody 1件 | PASS |

測った振る舞い（試験の期待はこれに合わせた）:
- H5 の runtime は、開始の失敗をすべて `START_REFUSED` にまとめる（匿名で verifier が出す `AUTH_REQUIRED` も外には出ない）。拒否した層は SQL の理由（7・8）とブラウザ・state・Threads の回数で確かめた。
- ABA は complete のときに見つかるので、Threads の code は使われた後になる（`COMPLETE_OUTCOME_UNKNOWN`、照合が必要）。G4-50 と同じ。
- Threads の `user_id` は `Number.MAX_SAFE_INTEGER` を超える。偽物も本物と同じく JSON の数値を文字列のまま返す（数値で作ると桁が丸まり、照合に失敗する）。

## 3. 他の担当への最小の IF（他の担当のファイルには書き込んでいない）

1. **H5**: `wiring/server_factory.ts` の `ConstructionPorts` に `bridgeFactory?: (connect) => OwnerBridge` を足し、`bridge: (ports.bridgeFactory ?? createOwnerTransport)(ports.ownerConnect ?? createPostgresConnector(c))` とする。`nondeployable.ts` の `buildForApprovedSourceIntegration` にも同じ引数を通す。入ったら G4 の composition は `createSourceServer(readConfig(read), { handlerFactory, bridgeFactory: createG4ThreadsOwnerBridge })` の1行になり、SDK と Auth の組み立ての写しは消せる。runtime に渡す actor は今のままでよい（verifier が JWT と GoTrue の両方で `is_anonymous=false` を確かめ、`generation`（lifecycle）は bridge が SQL で記録する。complete は G4 の入口 `complete_and_attest_binding` を通す）。
2. **G5**: G4 の入口は owner epoch（PR #303）を必須にしている。G5-48 の R1-MVP（g5pv）を正式にする場合は、G4 の次の候補で合わせる。G5 の SQL には触れていない。
3. **G3**: 予約と消費者の SQL には触れていない。切断は publish の許可の行を消す（`social_account_manual_publish_permissions`）。
4. **G1・G2**: callback の URL（`expo.extra.threadsConnectCallbackUrl`）、iOS の `associatedDomains`（`applinks:<host>`）、Android の App Links、公開の flag。今は未設定なので、アプリは `CALLBACK_NOT_CONFIGURED` で何も始めない（12）。

## 4. 採用の順

1. 非本番に SQL（PR #124、G4 の 001・002・G4-42・G4-43、H5 の claim SQL、切断の候補）を lifecycle owner で入れる
2. H5 の `bridgeFactory`（入れば composition の写しを消す）
3. 配線（G4 の bridge と入口）の独立レビューを1回（新しい Auth の信頼の境界。レビューの TASK は起こしていない）
4. Edge のデプロイ、callback と app link の設定（G1・G2）
5. 明示の承認の後、本物の Threads で確かめる

## 5. NOT_VERIFIED / NOT_RUN

本物の Threads・GoTrue・PostgREST・managed、Edge のデプロイ（Supabase の Edge runtime）、実機（Universal Link・ASWebAuthenticationSession）、G5-44 の T13（この world の T13 は main の write guard）、本番。
