# POSTONA 利用終了の端末確認：本番から切り離すための事前チェック（F4・2026-10-17 JST）

TASK: `postona-f4-sandbox-isolation-preflight-20261017`。PR242 head `ec5e27c6f42d7f1b55145fd3cd15310682d03e16`（PR240 `5e462ba7…` の上）に積む。

- 足したのは、手元で動かす確認スクリプトとテスト、この文書だけ。製品のランタイム、F5 の関門、F4 の provider／surface、H5、F3 は変えていない。
- 本番は NO_GO。これは端末での確認の前の「本番に触れない」確認で、リリースの承認ではない。

## 0. 判定

- **確認スクリプトは使える状態**。オフラインのテストと、作り物の値での試行（dry run）で確かめた（§5）。
- **端末での確認は、引き続き BLOCKED_PRECONDITION**。本番ではない project と F5 側の準備が無いので、スクリプトは今のこのリポジトリでは必ず REFUSED を出す（§5）。

## 1. app が本番に触れうる経路（値は伏せる）

| 種類 | 経路 | 備考 |
|---|---|---|
| Auth（GoTrue） | メール＋パスワード（サインイン・登録）、パスワード再設定メール、OAuth（X・Google・Apple web はブラウザ → `kabumori-social://auth-callback`）、Apple ネイティブ（ID トークン）、`/auth/v1/settings` の読み取り、本人確認（サインインし直し） | **本物のメールが送られうる**（登録・再設定） |
| PostgREST の表 | `brands`、`brand_memberships`、`social_accounts`、`scheduled_posts`、`social_mobile_content_settings` | 本人の行だけ（RLS は F5／サーバー側） |
| PostgREST の RPC | `start_x_autopost_service`（本番に適用済み・**書き込みあり**）、`reactivate_x_autopost_service` | 利用登録の関門。サインインしただけで呼ばれる |
| Edge | `account-delete`（`preview`／`withdraw_postona`）、`x-oauth-connect-user`（**本物の X の OAuth**）、`social-mobile-publish-setting`、`social-mobile-consult`（**AI の有料 API**） | 利用終了以外の機能も、サインイン後に押せる |
| ディープリンク | `kabumori-social://auth-callback`、`kabumori-social://oauth-callback` | **本番のビルドと同じ scheme**（下記の注意） |
| 外部リンク | プライバシー・規約・問い合わせの URL（`Linking.openURL`） | 読むだけ |
| 他の Draft スタック（スイッチは OFF） | `threads-oauth-connect-user`、`social-mobile-threads-publish`、`social-mobile-threads-disconnect`、`postona-x-reservations` | `OTHER_GATES_OFF` で OFF を確かめる |

- Realtime・Storage は使っていない。`eas.json`・`app.config.*`・`expo.extra` は無い。`expo-updates`（OTA）も無い。
- 接続先を決めるのは `EXPO_PUBLIC_SUPABASE_URL`／`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`（`.env*` か環境変数。Expo が組み込む）と、`EXPO_PUBLIC_DATA_SOURCE` だけ。
- 本番の project の URL は、リポジトリのサーバー側の cron の migration と運用文書に書かれている（app は読まない）。スクリプトにはその ref の SHA-256 だけを置き、ref そのものは置かない。

**端末での注意**（スクリプトでは確かめられないもの）

- 本番のビルドとテスト用のビルドは同じ scheme `kabumori-social` を使う。両方が同じ端末に入っていると、戻り先がどちらに届くか分からない。テスト用の端末には、テスト用のビルドだけを入れる。
- 「Xを接続」と「相談（AI）」は、テスト用の project に X の client secret や AI のキーがあれば、本物を動かす。そのため、F5／G5 が「無い」と確認することを必須にした（`POSTONA_SMOKE_SIDE_EFFECTS`）。

## 2. 確認スクリプト（`scripts/postona-sandbox-preflight.mjs`）

- ネットワークは使わない。読むのは手元のファイルと `git show HEAD:` だけで、何も書かない。
- 表示するのはチェックの名前と真偽だけ（URL・ref・キーは出さない）。
- すべて合格のときだけ終了コード 0（READY）、それ以外は 1（REFUSED）。分からないものは不合格として扱う。

| チェック | 合格の条件 |
|---|---|
| `DATA_SOURCE_SUPABASE` | 実際に使われる `EXPO_PUBLIC_DATA_SOURCE` が `supabase`（モック・未設定・誤記は拒否。モックは関門を通らないので G1／G2 を確かめられない） |
| `SANDBOX_DECLARED` | `POSTONA_SMOKE_SANDBOX_REF` が20文字の ref か `local` |
| `SANDBOX_NOT_PRODUCTION` | 宣言した ref が本番の ref（のハッシュ）ではない |
| `URL_NOT_PRODUCTION`／`URL_IS_DECLARED_SANDBOX` | URL が `https://<ref>.supabase.co`（パス・クエリ・ユーザー情報なし）で、宣言した ref と同じ。`local` なら 127.0.0.1 か localhost |
| `ENV_FILES_CONSISTENT`／`ENV_FILES_NO_MOCK` | どの `.env*`（`.env.example` は除く）も、本番や別の project を指さず、モックにもしない（Expo はモードで別のファイルを読むため） |
| `KEY_IS_PUBLISHABLE` | 公開用のキー（anon／publishable）だけ。`sb_secret_`・service_role は拒否 |
| `REDIRECTS_DECLARED` | テスト用の project の Auth の許可リスト（宣言）に `kabumori-social://auth-callback` と `kabumori-social://oauth-callback` がある。ワイルドカードは不可 |
| `END_FLAG_LOCAL_ONLY` | `POSTONA_END_SOURCE_ENABLED` が、この作業場所では `true`、Git の HEAD では `false`（ON のままコミットさせない） |
| `OTHER_GATES_OFF` | Threads の接続・投稿・解除、予約の保存のスイッチが、ソースにあればすべて `false` |
| `OWNER_SIGNOFF` | `POSTONA_SMOKE_F5_SIGNOFF`（F5／G5 の承認の参照）がある |
| `SIDE_EFFECTS_ATTESTED` | `POSTONA_SMOKE_SIDE_EFFECTS=no-x-no-ai-no-real-email`（X の secret・AI のキーが無く、メールはテスト用の受信箱か無効） |

## 3. 環境変数のチェック表（端末確認の前に）

| 変数 | 端末確認で必要な値 | 置き場所 |
|---|---|---|
| `EXPO_PUBLIC_DATA_SOURCE` | `supabase` | 手元の `.env.local`（コミットしない） |
| `EXPO_PUBLIC_SUPABASE_URL` | テスト用の project（または local）の URL | 手元の `.env.local` |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | テスト用の project の公開キー | 手元の `.env.local` |
| `EXPO_PUBLIC_AUTH_PROVIDERS` | テストする方法だけ（例 `email`） | 手元の `.env.local` |
| `POSTONA_END_SOURCE_ENABLED` | 手元のファイルだけ `true`（コミットしない） | `src/domain/postona-service-end.ts` |
| `POSTONA_SMOKE_SANDBOX_REF`／`POSTONA_SMOKE_AUTH_REDIRECTS`／`POSTONA_SMOKE_F5_SIGNOFF`／`POSTONA_SMOKE_SIDE_EFFECTS` | F5／G5 から受け取った値 | 端末確認を始める人のシェル（コミットしない） |

- モックと本番ではない環境の区別:
  - モック（`EXPO_PUBLIC_DATA_SOURCE` が未設定か `mock`）は画面の見た目の確認だけに使う。サーバーに触れないが、関門を通らないので、G1／G2 の確認には**使わない**（スクリプトも拒否する）。
  - G1／G2 は、本番ではない project（または local）の上でだけ確かめる。
- 実行するコマンド（`apps/social-mobile` で）:

```bash
node scripts/postona-sandbox-preflight.mjs
```

## 4. スクリプトでは確かめられず、F5／G5 の承認が要るもの

1. 本番ではない project を作り、F5 の migration（セッションの柵を含む）と `account-delete` を配備すること。
2. その project の Auth の設定:
   - 戻り先の許可リスト（上の2つ）。
   - メール（テスト用の受信箱か無効）。
   - Apple・X・Google の各方法の戻り先。
3. その project に X の client secret・AI のキー・本番のデータが無いこと。
4. 方法ごとのテスト用の利用者。
5. `withdraw_postona` の後に `start_x_autopost_service` が `reenroll_required` を返すこと。

## 5. 実行の記録（PR242 の系列、ネットワークなし）

- このリポジトリをそのまま実行すると **REFUSED（10件不合格）**。
  - 不合格: `DATA_SOURCE_SUPABASE`（未設定＝モック）、`SANDBOX_DECLARED`、`SANDBOX_NOT_PRODUCTION`、`URL_NOT_PRODUCTION`（未設定）、`URL_IS_DECLARED_SANDBOX`、`KEY_IS_PUBLISHABLE`、`REDIRECTS_DECLARED`、`END_FLAG_LOCAL_ONLY`（利用終了が無効）、`OWNER_SIGNOFF`、`SIDE_EFFECTS_ATTESTED`。
  - 合格: `ENV_FILES_CONSISTENT`、`ENV_FILES_NO_MOCK`、`OTHER_GATES_OFF`。
  - 終了コードは 1。
- 以前の手元の結合の作業場所（Threads／予約のスタックを含む）でも、4つのスイッチ（Threads の接続・投稿・解除、予約の保存）をすべて `false` として読み取った。
- テスト `tests/postona-sandbox-preflight.test.mjs`（15件）:
  - 作り物の値（偽の ref・偽のキー・使い捨ての git リポジトリ）で、正しい構成は READY、各条件が欠けると REFUSED になる。
  - 出力に ref・キー・URL が出ない。
  - スクリプトに project の URL が無く、ネットワークも使わない。
- アプリ全体 411/411（396 ＋ 15）、`npm run typecheck`・`CI=1 npm run lint` は合格。

## 6. G5／F5 への依頼（コピーして使える文面）

> POSTONA 利用終了（G1/G2）の端末確認のため、本番ではない Supabase 環境について、次の5点の担当と承認をお願いします（F4 からの依頼。F4 は project の作成・設定・配備を行いません）。
> 1. 本番ではない project（使い捨て）を作るか、`supabase start` の local で行うかの決定と承認。
> 2. その環境への F5 の migration（セッションの柵を含む）と `account-delete` の配備。`withdraw_postona` の後に `start_x_autopost_service` が `reenroll_required` を返すことの確認。
> 3. Auth の設定。戻り先の許可リストに `kabumori-social://auth-callback` と `kabumori-social://oauth-callback`（ワイルドカードなし）、メールはテスト用の受信箱か無効、Apple・X・Google の戻り先。
> 4. その環境に X の client secret・AI のキー・本番のデータが無いことの確認。
> 5. 方法ごとのテスト用の利用者の用意。
> 決まったら、`POSTONA_SMOKE_SANDBOX_REF`（または `local`）、`POSTONA_SMOKE_AUTH_REDIRECTS`、`POSTONA_SMOKE_F5_SIGNOFF`（承認の参照）、`POSTONA_SMOKE_SIDE_EFFECTS=no-x-no-ai-no-real-email` を、確認を行う人に直接渡してください（GitHub には書かないでください）。端末確認は `apps/social-mobile/scripts/postona-sandbox-preflight.mjs` が READY を返してから始めます。
