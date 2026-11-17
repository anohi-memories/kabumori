# POSTONA Threads 予約：独立台帳 + Worker 実行契約のローカル一体測定（G3-02 第27TASK）

Status: SOURCE CANDIDATE。デプロイ無し、実 Threads / Meta / X への通信ゼロ、PRODUCTION_NO_GO。
Base: G3 PR #699 HEAD `8ebf3a7b079a79817644a2317139c16cb7465ca4`（stacked）。G4 契約: PR #701 HEAD `1c2b239e86c5b7b56991bdb26105409b317291d2`（読み取り専用 pin）。

## 1. 台帳の決定（中央判断の実装）

- **予約は G3 の独立台帳 `postona_threads_resv.reservations`（SQL 007 / 009 / 011 / 013、既存）**。G4 の手動 publish attempt 台帳は使わない。予約の所有者・日時・同意（本文 SHA-256）・lease・結果はこの台帳だけが持つ。
- G4 と共有するのは「契約」だけ：007 の関数の中で G4 の `threads_publish_credential_verdict`（verified + credential generation）、公開スイッチ U8（`publish_enabled`）、G5 の bound state を読み、送信は G4 の 2 段階 send port（container → status → **G3 の pre-publish hook** → publish → read-back）。
- 新しい SQL / RPC / RLS / SECURITY DEFINER / 権限は**追加していない**（007 の worker 4 関数をそのまま使う）。

## 2. 今回追加した G3 ソース（すべてゲート OFF）

| file | 役割 |
|---|---|
| `supabase/functions/_shared/postona_reservations/threads_worker_store.ts` | 007 の `claim_due / preflight / record / release_unsent` を `postona_resv_worker` ロール・1 呼び出し 1 トランザクション・bind 引数のみで呼ぶ PG store。想定外の応答は throw（送らない）。 |
| `supabase/functions/_shared/postona_reservations/threads_worker_http.ts` | Threads 予約 worker の HTTP handler。`THREADS_RESERVATION_WORKER_ENABLED = false`、G4 の port は `NOT_CONNECTED`（claim 0・DB 接続なし）。scheduler の secret（定数時間比較）のみ。応答は件数だけ。 |
| `threads_dispatch.ts` | ヘッダ注記のみ（store と handler が出来たこと）。ロジック変更なし。 |
| `local_stack/postona-threads-reservation-worker-e2etest/` | TEST ONLY twin：上の handler + **G4 PR #701 の実 send port（blob pin）** + fake Threads。 |
| `local_stack/fake_threads.ts` | TEST ONLY の fake Graph API（graph.threads.net のみ応答、それ以外は拒否）。token は SHA-256 だけ記録。 |
| `local_stack/threads_worker_local_test.ts` | L47–L58（下表）。 |
| `local_stack/run.sh` | twin / fake / G4 pin / g3ls_test 表の追加、Threads テスト実行、RB 前の Threads 行の operator 解決と「Threads uncertain だけでも rollback 拒否」の確認。 |

本番用の Edge entry（`supabase/functions/postona-threads-reservation-worker/`）は TASK の変更範囲外のため**作っていない**（次工程）。

## 3. ローカル一体測定（実 GoTrue JWT → Kong → Edge → PG17、2026-11-17 JST、`G3LS_LOCAL_STACK_PASS`）

| step | 内容 | 結果 |
|---|---|---|
| L47 | G5 実 first run、SYNTHETIC Threads 接続、G4 実 verdict VERIFIED、013 generation | PASS |
| L48 | 作成（同一 requestId は同じ行）、本文違い 409、同意不一致、過去 / 60 日超、他人、token 無し → 拒否・書込 0；receipt；取消；二重取消 NOT_CANCELLABLE；送信 0 | PASS |
| L49 | due → worker HTTP → claim（generation 束縛）→ G4 2 段階送信 + hook → published 1 回、receipt `sent` + media id、2 回目 claim 0 | PASS |
| L50 | 日時変更 = 取消 + 新しい同意付き予約（in-place reschedule は台帳に無い）→ 新しい方だけ送信 | PASS |
| L51 | 3 worker 同時（1 run 1 行）→ 3 行を別々に、残り 1 行を次の run が 1 回；container 4 / publish 4、media id 4 種 | PASS |
| L52 | container 拒否 → failed `THREADS_REQUEST_REJECTED`；container 不明 → failed `THREADS_CONTAINER_UNKNOWN_NOT_POSTED`；publish 拒否 → failed `THREADS_TOKEN_INVALID`；publish 不明 → uncertain `THREADS_UNAVAILABLE`；read-back 不明 → uncertain `THREADS_READBACK_UNKNOWN`。どれも再送 0、取消不可 | PASS |
| L53 | credential の generation 違い → `CREDENTIAL_GENERATION_CHANGED`；U8 OFF → `NOT_PUBLISHABLE_AT_SEND`；claim 後の再接続 → `CREDENTIAL_CHANGED`。provider 呼び出し 0 | PASS |
| L54 | container 後・publish 前に U8 OFF / 再接続（fake が status 読みで停止中に変更）→ hook が拒否、publish 要求 0 | PASS |
| L55 | lease を持ったまま死んだ worker：lease 中は他 run が取らない（receipt pending）、期限後は次の claim で uncertain `LEASE_EXPIRED`、送信 0（時刻による再試行なし） | PASS |
| L56 | worker secret 無し / 違い → 401・claim 0；sign-out 済み本人は create / cancel / receipt 401；同意済みの行は台帳どおり送信 | PASS |
| L57 | G5 サービス終了（SYNTHETIC）→ claim 0・送信 0・failed `SERVICE_NOT_ACTIVE`；作成拒否；取消 / receipt は可 | PASS |
| L58 | fake が見た token は snapshot の 1 つ（hash のみ）、台帳 / audit に token 無し、API / worker ロールは 007 の 7 関数だけ、G4 U8 CHECK を元に戻して read-back（ON は再び拒否） | PASS |

最終カウント（L58）: rows cancelled=3, failed=9, published=7, uncertain=3；provider calls container=14, status=12, publish=10, readback=8。
既存 L0–L46（47 steps）、G1 画面統合、CRON、RB（X 62:62:134 / Threads 22:4 を明示破棄、17 steps rollback、schema / role 消滅）もすべて PASS。

## 4. SYNTHETIC（G3 が決めることではない・GO ではない）

- **G4 の U8 は CHECK `social_accounts_meta_publish_disabled`（`platform = 'x' OR publish_enabled IS FALSE`）で強制されている**（測定：ON の insert は拒否）。L47 はこの使い捨て環境だけで CHECK を外し、L58 で同じ定義に戻した。**実際の Threads 予約送信には G4 による U8 解除が必要。**
- credential：fake snapshot。G4 の generation 付き Threads credential statement は未提供（G4 `THREADS_POSTING_SERVICE_KEY = null`）。
- 時計（due 化・lease 期限）、再接続（binding の `oauth_state_id` 差し替え）、サービス終了（entitlement 行）。

## 5. 未完・次工程（remaining）

1. **G4**：U8（CHECK）解除の判断と手順、Threads の generation 付き credential statement（token + 007 と同じ generation を 1 文で）、send port の有効化（`THREADS_SEND_PORT_ENABLED`）、Threads の service key（G5 と決定）。
2. **G3（次 TASK）**：本番用 Edge entry `postona-threads-reservation-worker`（この handler を index から serve）と scheduler（X の 016 tick は X 専用）、Threads 結果通知（現在は receipt のみ。`postona_threads_resv.notifications` は無い：X の 018 相当を作るなら SQL 追加 + 独立 H レビュー）、in-place reschedule（今は取消 + 新規作成）。
3. **G1**：Threads 予約 UI の「日時変更 = 取消 + 新規」表示、uncertain / failed の receipt 表示。
4. 方針確認：sign-out は予約を止めない（同意済み行は送信される、L56 で測定）。止める必要があるなら G5 / 中央判断。
5. 実 Meta provider での投稿可否、実 OAuth、hosted / production は **NOT_RUN**。

## 6. 再実行

`bash supabase/candidates/postona_reservations_rollout/local_stack/run.sh`（supabase CLI 2.116.0、podman にイメージ済み、`apps/social-mobile` で `npm ci` 済み（G1 画面統合に typescript が要る）、G4 PR #701 を fetch 済み）。単体：`cd supabase/functions && deno test --no-config --no-check --allow-read --allow-run _shared/postona_reservations`。
