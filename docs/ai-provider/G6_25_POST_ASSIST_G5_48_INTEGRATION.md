# G6-25 POSTONA の AI 投稿補助 × G5-48 の認可：統合 QA と G1 への接続契約

- task_id: `common-ai-g6-postona-g5-48-r1-edge-auth-product-integration-20261029`（Issue #321、G6-25）
- 作成: 2026-10-29。**本番は NO_GO。deploy・SQL の適用・secret の設定はしていない。**
- つないだもの:
  - G6 の Edge 入口（PR #565、`supabase/functions/postona-post-assist/index.ts` → `postona_post_assist_edge.ts`）
  - G5-48 の未適用の認可候補（PR #563 `9846c0f0`、`git archive` で読むだけ。blob を照合。**G5 のソースは変えていない**）
  - G6 の本物の台帳 + ai_calls + owner-held の SQL（使い捨ての PG17）
  - 偽の OpenAI

## 1. 何をどう確かめたか

`supabase/tests/common_ai_gateway_post_assist_g5_48_pg_run.sh` は、使い捨ての PG17（socket だけ、偽のデータ）に DB を 2 つ作ります。

| DB | 中身 |
|---|---|
| g5 | G5 の前提の世界（PR #563 の runner と同じ作り方。G5 の Draft chain `21a5cad4`、owner epoch なし）。G5 の lifecycle owner（superuser でない役割。試験の後に消す）が `MVP_INSTALL.sql` → `MVP_R1_EXECUTE_GRANT.sql` / `MVP_R1_EXECUTE_REVOKE.sql` を流す |
| led | 台帳（20261010050613）、call store、maintenance、owner-held（20261020154536）、G6-20 の owner-held 台帳候補 001 |

試験の fetch は PostgREST の代わりをします。
- 偽のトークンを、決めておいた claims と、その `role` claim の DB の役割に対応させます。
- R1-MVP は `set local role <役割>` で、本人として呼びます。
- 本物の JWT の検証はしていません（**NOT_VERIFIED**）。

Supabase の URL は本番の形（https）、service key は `sb_secret_` の形です。どちらも偽物で、外へは何も出ません。

| 確かめたこと | 結果 |
|---|---|
| 許可前（R1-MVP は owner だけ） | 403 `POST_ASSIST_NOT_ENTITLED`。G5 は permission denied。claim・予約・送信はすべて 0 |
| `MVP_R1_EXECUTE_GRANT.sql` | ACL は owner と authenticated だけ。anon / service_role は実行できない |
| 許可後の本人の流れ（X / Threads × 下書き・推敲・タグ） | 6 件すべて 200。送信 6、精算 6、ai_calls complete 6。G5 には 1 件につき 2 回（確認＋送信直前の再確認）、本人のトークンと publishable key だけで、引数 3 つだけ |
| 鍵が混ざらない | G5 へは本人のトークンだけ。台帳へは service key だけで、本人のトークンは送らない。OpenAI へは OpenAI の鍵だけで、本文にトークン・service key・user id は無い |
| 二重課金 | 同じ鍵＋同じ内容 → 保存済みの候補（送信 0）。同じ鍵＋別の内容 → 409 `OPERATION_REUSED`。同じ鍵の同時 2 件 → 200 と 409 `IN_PROGRESS`、送信 1・課金 1 |
| 拒否 19 種類（許可後） | 匿名、`is_anonymous` 無し、他人や不明や期限切れのセッション、role claim が anon / service_role、legacy の service_role / anon の鍵を Bearer に、不明なトークン、他人のワークスペース、個人の id でないワークスペース、POSTONA を始めていないログイン、サービスの終了・停止、共有されたワークスペース → 403。`sb_secret_` / `sb_publishable_` の鍵を Bearer に → 401（G5 に尋ねない）。G5 の失敗 → 503（同じ鍵で再試行）。どれも claim・予約・送信・課金は 0 |
| 確認と送信の間の取り消し 4 種類 | 世代の変化（終了→再開）、停止、セッション切れ、ワークスペースの共有 → 403。予約は解放され、送信・課金は 0 |
| `MVP_R1_EXECUTE_REVOKE.sql`（止める） | ACL は owner だけに戻る。新しい依頼も、完了済みの鍵の再送も 403、送信 0。もう一度許可すると、保存済みの候補が返る |
| Edge の設定の不備 7 種類 | 503。G5・台帳・OpenAI には何も尋ねない。一覧に無い Origin → 403 |

壊したコード 6 種類は、すべて検出しました（理由はエラー文で確認）。
- M1: Bearer の形の確認を外す
- M2: 再確認で最初の判定を使い回す
- M3: 世代の比較を外す
- M4: G5 へ publishable key を送る
- M5: 個人 MVP の pin を外す
- M6: https で legacy の service key を通す

### この TASK で直した G6 のコード（1 か所）

Edge の入口は、JWT の形（点で区切った 3 つの部分）でない Bearer を 401 `POST_ASSIST_AUTH_REQUIRED` で返すようにしました。
- 以前も G5 の transport が送る前に止めていたので、何も送っていませんでした。
- ただ、答えが 503 `AUTH_UNAVAILABLE`（同じ鍵で再試行してよい）になっていて、意味が合っていませんでした。

## 2. 画面（G1）の接続契約（動く試験で固定）

G6 が用意したもの:
- 参照クライアント `supabase/tests/postona_post_assist_client_reference.ts`（アプリのコードではない）
- その試験 `supabase/tests/postona_post_assist_client_contract_test.ts`。supabase-js の `functions.invoke` と同じ振る舞いの代わりを通して、本物の Edge 入口を呼びます。

### G1 の結線手順（G1 が自分の PR で行う。G6 はアプリを変えない）

1. 参照クライアントを `apps/social-mobile/src/data/post-assist-client.ts` へ写す。`consult-client.ts` と同じ形で、Deno の API は使っていません。
2. トークンは `useAuth().session.access_token`。ワークスペースは `snapshot.workspace.id`（`app/(tabs)/consult.tsx` と同じ取り方）。
3. ボタンを 1 回押すごとに `newPostAssistKey(randomUUID)` で新しい鍵を作る。同じ鍵を使うのは、状態が `retry_same_key` のときだけ。
4. 候補の `text` とタグを、投稿作成画面（`features/schedule/schedule-composer.tsx` の各行の本文 `TextInput`、`setRow(index, { text })`）へ「編集できる下書き」として入れる。
   - 自動で投稿・予約しない。
   - `notice`（「投稿する前に確認・編集してください」）を表示する。
5. ワークスペースやセッションが変わったら、途中の答えを捨てる（`consult.tsx` の `captureSession` と同じ考え方）。

### 状態と画面

| 状態 | 画面 |
|---|---|
| `candidates` | 候補を編集欄に。投稿は既存の画面から、本人の確認の後 |
| `relogin`（401） | ログインし直す |
| `not_available`（403） | 使えない（未ログイン・期限切れ・別のワークスペース・契約なし・停止中）。セッションを更新してから新しい鍵で |
| `retry_same_key`（409 `IN_PROGRESS`、503 で再試行可） | 少し待って同じ鍵で |
| `new_key_needed`（409 `OPERATION_REUSED`、502） | その鍵の結果は保存済み。やり直すなら新しい鍵で |
| `quota`（429） | 上限。時間をおく |
| `invalid_input`（400 / 405 / 415） | 入力を直す（405 / 415 はアプリの誤り） |
| `unavailable` | 一時的に使えない。決まった形でない答えは、候補として出さない |

### 既存 UI への依存と、G1 が確かめること

- 投稿作成画面は、ローカルのプレビューだけです（#138。保存・投稿の手段は無い）。投稿は既存の投稿の画面（F1 の手動投稿 UI）から行います。
- **要確認**: アプリの `workspace.id` が、G5 の S2-3 が本人のものと認める個人ワークスペースの id と同じ形か。この試験の世界では `u_` + md5(user id) の先頭 24 桁です。違えば 403 になるだけで、何も送りません。
- **NOT_VERIFIED**（本物の Supabase Edge でしか確かめられない）
  - 本物の JWT の検証
  - Supabase の Functions の入口の後ろで、`Content-Length` が届くか（入口は無いと 400 を返す）
  - React Native の `functions.invoke` が送るヘッダー

## 3. 1 回の独立レビューに渡す範囲

**対象**（PR #565 とこの PR の差分だけ）:
- `supabase/functions/_shared/ai_provider/isolation_test.ts` の G6-24 の差分（記録は `supabase/tests/fixtures/g6_24_provider_isolation/provider_isolation_g6.patch`）
- `supabase/functions/postona-post-assist/index.ts`
- `supabase/functions/_shared/ai_gateway/isolation_test.ts`
- `supabase/functions/_shared/ai_gateway/postona_post_assist_edge.ts`（G6-25 の Bearer の形の確認を含む）
- 証拠: この文書の §1 と、`common_ai_gateway_post_assist_g5_48_pg_test.ts`

**対象外**（コードの変更 0）: SQL・台帳・ai_calls・gateway・adapter の中身。

**G5 の PR #563**（Auth の一括レビュー）は G5 の担当です。この PR は、それを読むだけで使っています。

**H2 #329**:
- 第 20 TASK の CHANGES_REQUIRED の原記録は、そのまま残します（PASS とは言いません）。
- PR #558 の負例の再確認は、legacy の fence の境界（https で legacy の台帳 mode を拒む `ledger_mode_nonloopback`）に絞ります。この E2E では、https の設定で使われたのは owner-held の RPC だけで、legacy の `ai_ledger_reserve` / `ai_ledger_mark_sent` は一度も呼ばれていません。
- 新しい H 枠は登録していません。

## 4. まだ決まっていないこと・していないこと

- G5-48 の許可（`MVP_R1_EXECUTE_GRANT.sql`）の採用とセキュリティレビュー（G5 の担当）
- Edge の deploy、secret / 設定、SQL の適用（台帳 → ai_calls → owner-held 001 → G5 の MVP → 許可）。どれもユーザーの承認が要る
- モデル・単価・予算（`POSTONA_POST_ASSIST_FEATURE` の値）。G6 は決めない
- 本物の Supabase の JWT 検証と Edge 上の HTTP（NOT_VERIFIED）
