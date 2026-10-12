# POSTONA Threadsだけの連携解除 ＋ 退会時の後片付けのG5 lease対応 V1（ソース実装・ゲートOFF）

- TASK: `postona-f4-threads-disconnect-lease-safe-v1-20261012`（新系統 F4 → L4）
- 基準: G4 Draft PR #154 の先頭 `98287392327eabfd5092a3ba89dde51a2e8beff6` に積む Draft PR（#154 は無変更）
- 読み取り専用で組み合わせて確認した版: G5 #152 `ccea1fe8132c6f573a768f0df5a033a05c62ef2c`（H4-P4-R1 の lease 修正版）、H5 #159 `163675c62835e84417905f98f97ceedd4dd1bcd9`、#124 `c30f246409a77080cbc03aef6c4cb72b5481e125`、#135 `e38788d6677082138f0990453c7d2f00549666d0`（いずれも未マージ・未適用）
- 状態: **ソースは動く形で完成。アプリ・サーバー・データベースの3つのゲートはすべて閉じたまま**。本番・Meta・Supabase への呼び出しは一切していない。

## 1. Threadsだけの連携解除（新規）

本人が POSTONA から **Threads の連携だけ**を外す。X 連携、POSTONA の利用登録、共通ID（かぶモリ）は残る。アカウント削除・POSTONA の利用終了（G5 の手続き）とは別物。

### アプリ（`apps/social-mobile/src/features/threads-disconnect/`、`src/domain/threads-disconnect.ts`）

- アカウント一覧画面（Threads の接続カードの下）に「Threads連携の解除」カード。ゲート `THREADS_DISCONNECT_UI_ENABLED = false` のため、今は「（準備中）」で押せない。
- 流れ: 解除を押す → **確認**（`@ハンドル` を表示し、「投稿できなくなり認証情報を削除する」「X・POSTONA登録・共通IDは残る」「Threads側の許可は POSTONA からは取り消せない」を明記）→「解除する」→ 1回だけ送信 → 共有データを読み直し、その Threads アカウントが一覧から消えたと確認できてから「解除しました」。
- **本人の再確認**: 確認を開いた時点のログイン中の本人を記録し、送信の瞬間にも同じ本人がログインしていることを確かめる（違えば送らない）。サーバーはトークンを Auth に問い合わせて確認し、データベースはセッション行がまだ有効か（ログアウト・期限切れでないか）を確かめる。
- 二重タップでは1回しか送らない。結果不明（応答が返らない等）は再送せず、一覧を読み直して確認を促す。
- 結果は **POSTONA 側の結果と Threads 側の注意を別々の行**で表示する。
- カードはアカウント一覧画面に置き、アカウントが消えた後も結果を表示し続ける（アカウント詳細画面に置くと、解除後に画面ごと「見つかりません」になるため）。

### サーバー（`supabase/functions/_shared/social/threads_disconnect.ts`、`supabase/functions/social-mobile-threads-disconnect/`）

- `POST {"action":"disconnect","social_account_id":…,"expected_handle":…}` だけを受け付ける（キー・形を厳密に確認）。
- 本人のトークンを Auth に問い合わせて確認 → **本人のトークンのまま**データベース関数を呼ぶ（service_role なし、JWT を自分で解読しない、user id を受け取らない、ログ出力なし）。
- データベースの答えを厳密に確認し、決まった形以外はすべて「結果不明（503）」。成功に化けさせない。
- ゲート `THREADS_DISCONNECT_SERVER_ENABLED = false` のため、入口は今は常に 503（`THREADS_DISCONNECT_DISABLED`）。未デプロイ。

### データベース（`supabase/candidates/postona_threads_disconnect/threads_disconnect_candidate.sql`、未適用）

`public.disconnect_threads_account(social_account_id, expected_handle)`（実行権限は `authenticated` だけ。anon・service_role は不可）。1トランザクションで:

1. **データベース側のゲート**（`threads_disconnect_gate_open()` は `false` のまま出荷。適用されても、別にレビューした変更で開けるまで何もしない・何もロックしない）
2. 本人（`auth.uid()`）とセッション（ログアウト・期限切れ・別人のセッションは拒否、`FOR SHARE` でログアウトと競合させない）
3. G5 のフェンス（T13）: POSTONA の利用登録が有効で、削除の手続き中でない
4. G5 の表で、本人のアカウント削除・POSTONA の利用終了が進行中なら拒否（そちらの後片付けが lease の下で消すため、競合させない）
5. **本人自身の** POSTONA ワークスペースだけ（他人のワークスペースの管理者でも不可）、owner/admin のみ
6. 確認した Threads アカウント（id とハンドル）が今も同じであること（途中で別アカウントに繋ぎ直されていたら `ACCOUNT_CHANGED`）
7. **まず投稿を止める**（手動投稿の許可を取り消す。以降は新しい投稿を始められない）
8. 送信中かもしれない投稿（`creating_container`／`publishing`／`publish_returned`／`uncertain`）があれば、**認証情報は消さずに残す**（確認・照合に必要なため）→ `stopped / PUBLISH_IN_FLIGHT`。照合（confirm／reconcile）は投稿許可なしでも続けられる。
9. トークンが他の行と共有されていれば消さない → `stopped / SECRET_SHARED`
10. それ以外は Vault のトークンと Threads の行を削除（投稿の記録・nonce・トークン期限の記録は連鎖して消える）し、読み戻して確認 → `disconnected / LOCAL_REMOVED`。削除が失敗したら削除部分だけ取り消し、投稿停止は維持 → `stopped / DISCONNECT_FAILED`
11. もう何も接続されていなければ毎回同じ答え → `not_connected / ALREADY_REMOVED`

- 退会時の後片付けの関数（`cleanup_threads_provider_footprint` など）は所有者専用のまま。個別解除はそれを緩めて使い回したものではない（テストで確認）。
- **Threads の予約は存在しない**: `scheduled_posts` は X 専用（アカウント FK の `target_platform` が `'x'` 固定）、G3 の予約候補も X アカウントしか受け付けない。止める対象は手動投稿（許可と送信中の試行）だけ。

### 外部（Meta）側の取り消し — 公式の契約で区別

- Threads API の公式ドキュメントには、**アプリから利用者の許可（トークン）を取り消すエンドポイントは載っていない**。あるのは、利用者が Threads 側でアプリを削除したときに Meta がアプリを呼ぶ「Deauthorize callback URL」と「Data Deletion Requests URL」（アプリ設定）だけ（[Create an app](https://developers.facebook.com/documentation/threads/get-started/create-an-app.md)、[Get access tokens](https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions)、[ドキュメント索引](https://developers.facebook.com/documentation/threads/llms.txt)、2026-10-13 JST 確認）。
- したがって答えの `remote_access` は常に `not_revoked_by_app`。アプリは「Threads側の許可は、POSTONAからは取り消せません。Threadsの設定から削除してください」を、POSTONA 側の結果とは別の行で必ず表示する。`confirmed_remote_revoked` 相当の表示・答えは一切しない。Meta は一度も呼んでいない。
- Deauthorize／Data Deletion のコールバックを受ける仕組みは今回の範囲外（運用・H5／G4 の後続課題。受けたときは同じ解除処理を所有者経路で呼ぶ設計にできる）。

## 2. 退会時の Threads 後片付けを G5 の新しい約束（signal／stillOwned）に合わせた

- `supabase/functions/_shared/social/threads_provider_cleanup.ts`: G5 #152 修正版の `ProviderCleanupAdapter`（`hasConnection(userId, context)`、`cleanup(userId, context)`、`context = { signal, stillOwned() }`）と同じ形（組み合わせ検証で型も一致）。
  - 読み取りの前・後で `signal` を確認（中断後の答えは使わない＝「読めない」）。
  - **削除の直前**に `stillOwned()` を確認。`true` 以外（例外を含む）や中断なら何もせず `blocked`。
  - 削除の呼び出しには `signal` を渡す。送った後の中断・例外・答えの欠落・想定外・lease 喪失は `reconciliation_required`（人が確認、再送しない）。データベースが「何も消していない」と答えた `blocked` だけは `blocked` のまま。`confirmed_remote_revoked` は返さない。
- `supabase/candidates/postona_threads_cleanup/threads_provider_cleanup_candidate.sql`:
  - アカウント削除は **有効な owner lease を持っている間だけ**（`owner_lease_expires_at > clock_timestamp()`。トランザクション開始時刻ではなく実時刻）。
  - ロック取得の後、削除の直前に **もう一度** 確認（ロック待ちの間に lease が切れたら何も消さず `LEASE_NOT_HELD`）。
  - 関数は「どの所有者か」までは分からない（G5 の port はアダプターに lease を渡さない）ので、所有者の交代はアダプター側の `stillOwned()` と、削除の冪等性＋ワークスペースのロックで扱う（G5 自身の「lease の確認はロックではない」の方針どおり）。
  - G5 のファイルは無変更・未登録。

## 3. 検証（2026-10-13 JST、すべてローカル・偽データ）

| 検証 | 結果 |
|---|---|
| `supabase/tests/postona_threads_disconnect_run.sh`（使い捨て PG17） | ALL PASS: 前提不足2種で停止、2セッションの競合2種（解除がアカウント行を待つ間に投稿が始まった → 気づいて認証情報を残す／ロックが長すぎる → BUSY で何も変わらない）、振る舞い（ゲート閉、権限、本人・セッション、POSTONA の状態、削除中、他人・他ワークスペース・X アカウント、ハンドル違い、送信中4状態、共有トークン、Vault 失敗、解除・2回目・再接続、X／ワークスペース／メンバー／登録は無傷）、**変異10種すべて検出** |
| `supabase/tests/postona_threads_cleanup_run.sh`（使い捨て PG17） | ALL PASS: 前提2種、**lease の競合**（ロック待ちの間に lease が切れる → 何も消えない）、振る舞い（lease なし・期限切れ・同一トランザクション内での期限切れを含む）、**変異7種すべて検出**（新規3種: lease 確認なし／開始時刻で判定／ロック後の再確認なし） |
| `supabase/tests/postona_threads_connect_smoke_run.sh`（組み合わせ環境） | ALL PASS: G5 #152 修正版の実際の `runProviderCleanups` と組み合わせ — 削除完了 → proceed、送信中・応答なし・読めない → 照合、**削除直前に lease 喪失 → 何も消さず lease_lost**、削除中に喪失 → 答えを使わない、時間切れ → 照合・遅れて戻っても再送なし、所有確認の例外 → lease_lost。接続は H5 #159 の実コードと組み合わせ |
| Deno `_shared/social`＋投稿・解除の Edge | 118 PASS（新規: 解除 9＋入口 1、後片付けは 7 に更新） |
| アプリ `tests/threads-disconnect.test.mjs` | 17 PASS（ゲート OFF、確認文、別々の行、サーバーとの答えの一致、本人の再確認、二重タップ、再送なし、ログなし、カード） |
| アプリ回帰 `threads-connect`・`threads-manual-publish` | 36 PASS |
| `tsc --noEmit`・`expo lint`・`deno lint`・フォルダ走査系のガードテスト 16 | PASS |
| NOT_RUN | 本物の Meta、管理された Supabase（Vault 削除権限・`authenticated` への GRANT）、実機・シミュレーター（ゲート OFF のため「準備中」）、既存の大きな回帰（無変更部分） |

## 4. 他の担当への依頼（POSTONA 終了時の X／Threads 一括解除のための接続面）

| 担当 | 依頼 |
|---|---|
| **G5（F5）** | (1) 独立レビュー後、G5 のファイルで `createThreadsProviderCleanupAdapter(createThreadsCleanupRpcStore({...}))` を登録し、削除処理のロールに `threads_provider_connection_state(uuid)`・`cleanup_threads_provider_footprint(uuid)` の EXECUTE を付与。(2) **POSTONA だけの利用終了（service_deletion `x_autopost`）には owner lease が無い**（G5 の表の制約で account_deletion 限定）。Threads 側は今「進行中・後片付け段階」だけで判断している。service_deletion にも所有者の仕組み（lease か同等の `stillOwned`）を用意できるなら、Threads の SQL も同じ確認を足す。(3) Threads は外部の取り消しを確認できないため、アダプターの成功は常に `local_removed_remote_unverified`。**アカウント全体の削除は `acceptRemoteUnverified` が true でない限り `PROVIDER_REMOTE_UNVERIFIED` で止まる**。Threads については「受け入れて、利用者に Threads 側の削除を案内する」かを G5／プロダクトで決める必要がある。 |
| **G3（F3）** | X の saga・予約・投稿には一切触れていない。POSTONA 終了の画面で X と Threads の結果を並べる場合は、Threads 側は `THREADS_REMOTE_NOTE`（取り消せない旨）を別の行で出す。Threads の予約は作らない前提（作る場合は、解除・後片付けの「止める対象」に加える必要がある）。 |
| **H5（J枠）** | 解除は H5 の接続処理に依存しない。解除後は Threads の行が無くなるため、別の Threads アカウントで接続し直せる（#124 の「別 identity 拒否」は行がある間だけ）。Meta の Deauthorize／Data Deletion コールバックを受ける場合は、同じ解除を所有者経路で呼ぶ形を提案（別タスク）。 |
| **運用・ユーザー** | 解除を有効にするには、3つのゲート（アプリ・サーバー・データベース）をそれぞれレビュー済みの変更で開ける必要がある。適用・デプロイ・GRANT・ゲートを開けるのはすべて別承認。 |
