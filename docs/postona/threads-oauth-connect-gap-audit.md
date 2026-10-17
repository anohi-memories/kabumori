# Threads の OAuth 接続から最初の投稿まで：まだできない理由の調査（F4・2026-10-17 JST）

TASK: `postona-f4-threads-oauth-connect-gap-readiness-20261017`。ソースを読み取りだけで調べた文書。デプロイ・API・本物の OAuth・投稿はしていない。本番は NO_GO。値（URL・project ref・キー）は伏せる。

## 0. 結論

Threads の接続から最初のテキスト投稿までが今できない理由は、次の6つが重なっているため。

1. **コードが2つの別スタックに分かれていて、まだ一度も組み合わせていない。**
   - 接続の Edge は PR124 → PR135 → PR139 → PR159 のスタック、アプリ・投稿・後片付けは PR140 → … → PR180 のスタックにある。
   - アプリが呼ぶ `threads-oauth-connect-user` は PR180 の系列に無く、PR159 にしか無い。
   - 試しのマージ（結果は書き込まない）では、PR159×PR180、PR159×main、PR180×main のどれも衝突しなかった。
2. **Edge の入口が、ソースの上で必ず 503 を返す。**
   - `threads-oauth-connect-user/index.ts` は `disabled_entry` を返すだけ。
   - G4 側のつなぎ（`THREADS_CONNECT_EDGE_WIRED`）も `false`。
   - `supabase/config.toml` がどのブランチにも無いので、関数の登録（`verify_jwt`）も無い。
   - 配備の証拠は見つからない（報告にある「deployed」という表現はソースの入口のこと）。
3. **DB の候補 SQL がどれも未適用（順番がある）。** 2a-2（main）→ F5 PR193 の書き込みの柵 → PR124 の OAuth 候補 → H5 の claim 候補 → G4 の資格情報の保管 → 投稿の台帳・リリース・ライフサイクルの guard。
4. **外部の設定が無い。**
   - Meta の Threads アプリ（テスターと権限）、Meta に登録する HTTPS の戻り先、その戻り先のドメインのアプリリンク（iOS Associated Domains・Android App Links）、`expo.extra.threadsConnectCallbackUrl`。
   - secrets（App ID・secret、DB の専用 owner の資格情報、証明用のキー2つ）。
5. **iOS では、今のコードのままだと HTTPS の戻りで認証画面が閉じない可能性が高い（新しく見つけた点）。**
   - `threads-connect-runtime.ts:45` は `openAuthSessionAsync(url, <HTTPS の戻り先>, { preferEphemeralSession: true })` で、`preferUniversalLinks` を渡していない。
   - expo-web-browser 57.0.3 の `WebAuthSession.swift` は、`preferUniversalLinks` が true で iOS 17.4 以上のときだけ HTTPS の戻りを捕まえる。それ以外は旧来の `callbackURLScheme: "https"` を使う。旧来の方法は独自 scheme 向けなので、成功を返さず期限切れまで待つ見込み（**実機で確かめる必要がある推定**）。
   - X の接続は独自 scheme `kabumori-social://oauth-callback` を使っているので、この問題は無い。
6. **運用と承認**: 実地の試験の承認（`PILOT_APPROVED`）、結合のセキュリティレビュー、本番の承認。

## 1. 確かめた版

| 範囲 | head |
|---|---|
| main | `b7c60b5d` |
| アプリ・投稿・後片付けの最新（PR180） | `7c4f457834cddb42b72be6b74996e643b213e8c8` |
| 接続 Edge（PR124 → PR135 → PR139 → PR159） | `c30f2464` → `e38788d6` → `b4fa672f` → `163675c62835e84417905f98f97ceedd4dd1bcd9` |
| F5 のライフサイクル（PR193） | `314aeac47a02ce80aea3d94426a563dfbe57ad7c` |

## 2. つながりごとの表

| # | つながり | 場所 | 状態 | 担当 |
|---|---|---|---|---|
| 0 | Meta の OAuth の約束 | main `supabase/functions/_shared/social/threads_connect_contract.ts`（URL・権限 `threads_basic,threads_content_publish`、短期→長期トークン。`THREADS_CONNECT_PREREQUISITES_MET=false`） | main にある（PR118）。オフラインのテストあり | G4 |
| 1 | アプリの接続ボタン | PR180 `apps/social-mobile/src/domain/threads-connect.ts:9` `THREADS_CONNECT_UI_ENABLED=false`。アカウント一覧に1枚、詳細には未接続のときだけ | 実装済み・スイッチで OFF | G4／F4 |
| 2 | 開始（Edge `start`） | PR159 `candidates/postona_threads_auth_runtime/runtime.ts` の `start()`（state 32 byte・ハッシュ・10分以内）→ PR124 の候補 `begin_social_mobile_threads_oauth_connection`（`social_account_oauth_states`、`authorization_pending`） | 実装済み。入口は 503、SQL は未適用・権限付与なし | H5＋G4 |
| 3 | アプリでのブラウザ起動と戻り | PR180 `threads-connect-runtime.ts`（戻り先は `expo.extra.threadsConnectCallbackUrl`。未設定なら通信の前に `CALLBACK_NOT_CONFIGURED`） | 実装済み。戻り先の設定が無い。**iOS の HTTPS 戻りは上の §0-5 の問題** | G4／F4＋運用 |
| 4 | 戻り（Edge `callback`） | PR159 `runtime.ts` の callback（URL の検証 → H5 の `claim`（試行回数・使用済みコード・セッションの確認）→ コードの交換 → セッションの再確認 → 証明付きの `complete_…`（一度だけ使える・Vault にトークン・`identity_verified`・`publish_enabled=false`）） | 実装済み・ゲートで OFF・SQL 未適用・未配備 | H5／G4 |
| 5 | 読み戻し | main の RLS `social_mobile_member_select_social_accounts`、アプリ `supabase-repository.ts:37`。成功の後は再読み込みで確認し、楽観的に「接続済み」とは出さない | 実装済み | G4 |
| 6 | 最初の投稿 | PR180 `social-mobile-threads-publish`（`THREADS_MANUAL_PUBLISH_PREREQUISITES_MET=false`、前提8つ、いつも 503）、アプリ `THREADS_MANUAL_PUBLISH_UI_ENABLED=false` | 実装済み・ゲートで OFF・SQL 未適用 | G4／F4 |
| 7 | 連携解除・後片付け | PR180 `social-mobile-threads-disconnect`（`THREADS_DISCONNECT_SERVER_ENABLED=false`）、後片付けのアダプタ（PR180 で生きたリースを修正）。Meta 側の許可は取り消せない（`not_revoked_by_app`） | 実装済み・OFF。F5 PR193 のプロバイダ登録は候補だけ | F4／F5 |
| 8 | 共通アカウントの書き込みの柵 | F5 PR193 の migration（main には無い）。PR124 のテストはモックの柵 | Draft のみ | F5／G5 |

## 3. 足りないもの（種類別）

**コードが無い・組み合わせていない**

- C1. 2つのスタックを組み合わせたブランチ。そのうえで、Edge の入口を本物のランタイムへつなぐ（スイッチは OFF のまま）。
- C2. 環境変数の名前が2通りある（main の約束は `THREADS_*`、H5 のランタイムは `POSTONA_THREADS_*`）。一本化が要る。
- C3. 関数の登録（`config.toml` と `verify_jwt`）。
- C4. 使えるようにするための migration（`authenticated` への EXECUTE の付与など。PR124 は「後の審査済みの migration」に任せている）。
- C5. **iOS の HTTPS の戻り**（§0-5）。直し方の案は次の2つ。
  - (a) `preferUniversalLinks: true`（iOS 17.4 以上）に、Associated Domains と戻り先のドメインの AASA を組み合わせる。17.4 未満は別の扱いが要る。
  - (b) HTTPS の戻り先ページから、独自 scheme へ引き渡す中継ページ。独自 scheme を横取りされる危険への対策が要る。
- C6. Meta の deauthorize／データ削除のコールバック。一般公開の前に必要。
- C7. トークンの更新（60日以内の1回の投稿には要らないが、継続には要る）。

**コードはあるが、ゲート・未適用・未配備**

- G1. スイッチ: `THREADS_CONNECT_UI_ENABLED`、`THREADS_CONNECT_EDGE_WIRED`、`THREADS_CONNECT_PREREQUISITES_MET`、入口の 503、`THREADS_MANUAL_PUBLISH_PREREQUISITES_MET`、`THREADS_MANUAL_PUBLISH_UI_ENABLED`。
- G2. SQL の適用の順番: 2a-2 → F5 の柵 → PR124 → H5 の claim → G4 の保管 → 投稿の台帳・リリース・ライフサイクルの guard。
- G3. **DB の専用 owner（設計上の課題）**:
  - H5 のランタイムは `db.<ref>.supabase.co:5432` に、`postgres`・`supabase_admin`・`service_role` などではない専用の role で直接つなぐことを求める（`wiring/config.ts:24-36`）。
  - 管理された Supabase では、オブジェクトの owner がふつう `postgres` になる。直接接続の到達性（IPv6）とあわせて、方式の決定が要る。

**外部の設定**

- E1. Meta の Threads アプリ（開発モード・テスターのアカウント・権限）と、正確な HTTPS の戻り先。
- E2. 戻り先のドメイン（チームが管理するもの）と、iOS Associated Domains・AASA、Android App Links・assetlinks、`expo.extra.threadsConnectCallbackUrl`。iOS の `bundleIdentifier`・Android の `package` も `app.json` に無い。
- E3. secrets（App ID・secret、DB の専用 owner のパスワードと CA、接続と投稿の証明用のキーを関数と Vault の両方に）。
- E4. 名前を決めたテスターの承認（`PILOT_APPROVED`）。

## 4. 段階ごとの状態

| 部品 | 実装 | 結合 | 手元のテスト | 管理環境での OAuth | 実地の試験 | 本番の承認 |
|---|---|---|---|---|---|---|
| アプリ（接続・投稿・解除） | あり | 未（接続 Edge と別スタック） | 合格（下記） | 未 | 未 | 未 |
| 接続の Edge・ランタイム（H5） | あり（入口は 503） | 未 | 合格（下記） | 未 | 未 | 未 |
| OAuth の SQL（PR124・H5） | 候補 | 未 | PR124／H5 の使い捨て PG（今回は実行していない） | 未 | 未 | 未 |
| 投稿の Edge・SQL | あり／候補 | 未（接続のランタイムと） | 合格（下記） | 未 | 未 | 未 |
| 後片付け・F5 の登録 | あり／候補 | 一部（F5 の重ねたテスト） | 合格（下記） | 未 | 未 | 未 |

**今回実行したテスト**（ネットワークなし）

| 場所 | テスト | 結果 |
|---|---|---|
| PR180 `7c4f4578` | アプリ全体 | 287/287 |
| PR180 | Threads の接続・解除・投稿 | 18/18・17/17・18/18 |
| PR180 | Threads の Deno のテスト10ファイル（`--allow-read --allow-env` だけで、ネットワークの権限なし） | 105件合格 |
| PR159 `163675c6` | ランタイム・オフラインの候補・分離・プロバイダの領域・接続の約束・RPC の約束（7ファイル、ネットワークの権限なし） | 110件合格 |

- `wiring/connector_test.ts` は実行していない。依存の `@db/postgres` を取ってくる必要があり、ネットワークが要るため。

## 5. 次にやる最小の実装（提案）

1. **F4（G4 の範囲）・ソースだけ**: 結合ブランチ（PR159 ＋ PR180）を作る。
   - Edge の入口を本物のランタイムへつなぐ（`THREADS_CONNECT_EDGE_WIRED` などは `false` のまま）。
   - 環境変数の名前を一本化し、関数の登録の案を作る。
   - iOS の戻り方を決める（C5 の (a) か (b)）。アプリ側の実装（`preferUniversalLinks` と、`app.json` の Associated Domains・bundleIdentifier の雛形）をする。
   - オフラインの結合テストを足す。H5 のファイルを変える場合は、H5 との調整を Report に記録する。
2. **H5／G5（設計の判断）**: 専用 owner と直接 DB 接続の方式を、管理された Supabase に合わせて決める（G3）。
3. **F5（後で）**: Threads のプロバイダ登録の候補を本登録する（削除の経路に要る。最初の投稿には要らない）。
4. **G4／F4（公開の前）**: Meta の deauthorize／データ削除のコールバック、トークンの更新。

## 6. 本番ではない Meta／Supabase で試すための前提（切り離した環境）

- **本番ではない、ホストされた Supabase の project**。H5 のランタイムの設定の検査は `db.<ref>.supabase.co:5432` と専用 owner を求めるので、今のままでは `supabase start` の local は通らない。
- その project に、§3 G2 の順番で SQL を適用し、関数を配備する（F5／G5・H5・G4 の承認）。本番には触れない。
- Meta の Threads アプリを開発モードで用意する。テスターのアカウントだけを使い、戻り先は E2 のドメイン。
- secrets は、その project の関数の secrets と Vault にだけ置く（GitHub には書かない）。
- 端末の確認の前のチェックは、PR243 のスクリプトを Threads 用に広げる必要がある。今は Threads のスイッチを OFF にすることを求めているため、Threads の試験用の別のモードが要る。
- 名前を決めたテスターの承認（`PILOT_APPROVED`）と、結合のセキュリティレビューを、実地の前に行う。
