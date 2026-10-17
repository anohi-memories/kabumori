# Threads の OAuth 接続：2つのスタックの結合と iOS の戻り（F4・2026-10-17 JST）

TASK: `postona-f4-threads-oauth-stack-integration-ios-return-20261017`。ソースだけの候補。

- スイッチはすべて OFF のまま。本物の OAuth・トークンの交換・投稿・配備はしていない。
- 本番と試験運用は NO_GO。接続や投稿ができるようになったとは言わない。

## 1. 結合

- PR180 `7c4f457834cddb42b72be6b74996e643b213e8c8`（アプリ・投稿・後片付け）に、PR159 `163675c62835e84417905f98f97ceedd4dd1bcd9`（接続の Edge・H5 のランタイム）を `--no-ff` でマージした（`f21d5caa`）。
  - 共通の祖先は `fc1a1c11`。PR159 から入るのは、その4つのコミット（PR124 `c30f2464`、PR135 `e38788d6`、PR139 `b4fa672f`、PR159）だけで、関係のない main の履歴は入らない。衝突なし。
  - PR180・PR159 の元のブランチは変えていない。
- マージの後の F4 の変更は次のとおり。H5 のランタイムの中身と、PR #118 の約束のモジュールは変えていない。

| ファイル | 変更 |
|---|---|
| `supabase/functions/_shared/social/threads_connect_entry.ts` | 新規。Edge の入口のアダプタ |
| `supabase/functions/threads-oauth-connect-user/index.ts` | アダプタへ委ねる（3行） |
| `apps/social-mobile/src/domain/threads-connect.ts` | 戻りの経路の判定と、文言1つ |
| `apps/social-mobile/src/features/threads-connect/threads-connect-runtime.ts` | 判定を使う |
| `apps/social-mobile/src/features/threads-connect/threads-connect-starter.ts` | 端末の理由を返す |

## 2. Edge の入口（`threads-oauth-connect-user`）

既にある3つをつないだ。

- H5 の止めてある入口（`disabled_entry.ts`）。
- H5 の組み立て（`wiring/nondeployable.ts` の `buildForApprovedSourceIntegration`。本物の SDK・ドライバ・H5 の設定の検査）。
- G4 の HTTP の約束（`threads_connect_edge.ts` の `createThreadsConnectHandler`）。

入口の振る舞い:

| 条件 | 入口の振る舞い |
|---|---|
| 静的なゲート `THREADS_CONNECT_EDGE_WIRED`（G4、ソースでは `false`）が閉じている | 入口は **H5 の止めてある入口そのもの**。環境変数を読まず、何も組み立てず、組み立てのモジュールを読み込みもしない（動的 import はゲートの先にだけある） |
| ゲートは開いているが、`THREADS_CONNECT_ENABLED` が厳密に `"true"` でない | 止めてある入口の 503 `THREADS_CONNECT_DISABLED` |
| 正式な名前と別名が食い違う | 503 `THREADS_CONNECT_RUNTIME_UNAVAILABLE`（値は出さない） |
| H5 が設定を拒む（専用でない owner、DB ホスト、HTTPS でない戻り先など）、または組み立てに失敗する | 503 `THREADS_CONNECT_RUNTIME_UNAVAILABLE`。成功として覚えず、次の要求で作り直しを試す |
| それ以外 | H5 の `sourceHandler` へ（呼び手の Bearer をそのまま渡す。state・セッションの結び付け、再送の拒否、トークンの保管は H5 と SQL の担当） |

- **H5 の分離の約束は保っている**。`source_isolation.smoke.ts` が確かめているのは、入口のファイルに `server_factory`・`nondeployable`・`Deno.env`・`createSourceServer` が無いこと。入口はアダプタを呼ぶだけで、ゲートが閉じている間は本物の組み立てに届かない。
- **PR #118 の約束のモジュールは、どこからも読み込まれないまま**（その分離テストのため、アダプタはそのファイル名にも触れない）。H5 の止めてある入口と分離の smoke は、従来どおりその静的なゲート（`false`）を読む。

**環境変数の名前**（値は伏せる）

| 正式な名前（H5 が検査する） | 別名（PR #118 の約束） |
|---|---|
| `POSTONA_THREADS_APP_ID` | `THREADS_APP_ID` |
| `POSTONA_THREADS_APP_SECRET` | `THREADS_APP_SECRET` |
| `POSTONA_THREADS_CALLBACK` | `THREADS_REDIRECT_URI` |
| `POSTONA_THREADS_PROJECT_URL`／`_PROJECT_REF`／`_PUBLISHABLE_KEY`／`_DB_HOST`／`_DB_PORT`／`_DB_NAME`／`_DB_OWNER`／`_DB_PASSWORD`／`_DB_CA_PEM`／`_ATTESTATION_KEY` | なし |
| 動かすスイッチ: `THREADS_CONNECT_ENABLED`（`"true"` のときだけ） | なし |

- 正式な名前を優先し、空か未設定のときだけ別名を使う。両方があって値が違えば拒む。ランタイムには `POSTONA_THREADS_*` 以外の名前を見せない。

## 3. iOS／Android の戻り

Threads の戻り先は HTTPS だけ。

- **iOS**:
  - expo-web-browser 57 が HTTPS の戻りを認証の画面の中で捕まえるのは、`preferUniversalLinks: true` かつ iOS 17.4 以上のときだけ（`ASWebAuthenticationSession` の `.https(host:path:)`）。そのうえ、その host の Associated Domains が要る。
  - 判定（`threadsCallbackDelivery`）は、次のすべてが揃ったときだけ開始を許し、`{ preferEphemeralSession: true, preferUniversalLinks: true }` で開く。揃う条件は、戻り先が素の HTTPS（クエリ・ポートなし）、`ios.associatedDomains` に `applinks:<host>` がある、iOS 17.4 以上。
  - **17.4 未満は最初に `UNIVERSAL_LINK_UNSUPPORTED` で断る**（戻れない認証の画面を開いたまま待たせない）。
- **Android**: `android.intentFilters` に、VIEW・`autoVerify: true`・`https` と host・戻り先を含む path（`path` または `pathPrefix`）がある場合だけ許す。認証の画面に追加のオプションは渡さない（確認済みの App Link でアプリへ戻る）。
- それ以外、または何かが欠けているときは `CALLBACK_NOT_CONFIGURED`。どちらの場合も、要求を1つも送らない。
- **X は変えていない**（独自 scheme `kabumori-social://oauth-callback`。`preferUniversalLinks` は使わない）。

**ビルドの時に運用が入れる設定**（`app.json` には入れていない。値はまだ決まっていない）

- `expo.extra.threadsConnectCallbackUrl`: Meta に登録したものと完全に同じ、素の HTTPS の URL。
- `expo.ios.bundleIdentifier`、`expo.ios.associatedDomains: ["applinks:<host>"]`。
- `expo.android.package`、`expo.android.intentFilters: [{ action: "VIEW", autoVerify: true, data: [{ scheme: "https", host: "<host>", pathPrefix: "<path>" }], category: ["BROWSABLE", "DEFAULT"] }]`。
- 戻り先の host に置くもの:
  - `/.well-known/apple-app-site-association`（`applinks` に `<TeamID>.<bundleId>` と戻り先の path）。
  - `/.well-known/assetlinks.json`（package と署名の SHA-256）。
- Associated Domains を変えたら、ネイティブのビルドを作り直す必要がある（EAS などは別の承認）。

## 4. スコープを絞った提案（今回は変えていない）

1. `supabase/config.toml` が無い。`threads-oauth-connect-user` を `verify_jwt` を有効にして登録する案を、共有の設定として決める（H5・F5 と調整）。
2. 関数の import map（`@supabase/supabase-js`・`@db/postgres` を H5 の `wiring/deno.json` と同じ版に固定）を、関数のディレクトリに置く。H5 のランタイムが `supabase/candidates` にあるので、配備の前に関数から束ねられる場所へ移すかどうかを H5 が決める。
3. H5 の専用 owner と直接 DB 接続（`db.<ref>.supabase.co:5432`）を、管理された Supabase に合わせる方式（H5・G5）。
4. ゲートを開ける変更（`THREADS_CONNECT_EDGE_WIRED`）は、上の3つと、SQL の適用（2a-2 → F5 の柵 → PR124 → H5 の claim → G4 の保管）、Meta の設定、本番ではない project、焦点を絞ったレビューの後に、別の承認で行う。

## 5. テスト（ネットワークなし）

| テスト | 結合だけ（`f21d5caa`、変更の前） | 変更の後 |
|---|---|---|
| アプリ全体 | 287/287（PR180 と同じ） | 295/295（＋8） |
| 新規 `tests/threads-connect-ios-return.test.mjs` | 6件失敗・2件合格（合格は X と `app.json` の対照） | 8/8 |
| Threads・H5・約束の Deno（`--no-config --allow-read --allow-env`、ネットワークの権限なし） | — | 209件合格（入口のアダプタ8件を含む） |
| 新規 `threads_connect_entry_test.ts` | 読み込みで失敗（アダプタが無い） | 8/8 |
| H5 の smoke（組み立て・分離）＋ connector ＋ 新規の組み立てのテスト | — | 35件合格 |

- H5 の smoke は、H5 の import map を使い、`--cached-only` でネットワークの権限なしに実行した。
- そのうち G5 の `provider_cleanup.ts` が要る1件は、H5 の手順どおり `ccea1fe8` から一時的に重ねて実行した。重ねないと、その1件だけはファイルが無いため失敗する（接続とは関係ない）。
- 組み立てのテストは、本物の SDK・ドライバ・H5 の設定の検査・G4 の約束をアダプタ越しに組み立て、次の拒否が通信の前に決まることを確かめた。
  - 認証なし → 401、余計な項目 → 400、別のドメインの戻り → `CALLBACK_INVALID`、`code` の二重 → `CALLBACK_INVALID`、口座 ID の持ち込み → 400、H5 が拒む設定 → 503。
  - 応答に設定の値は出ない。
- `npm run typecheck`・`CI=1 npm run lint` は合格。

## 6. 一度だけ受けるべき、焦点を絞ったレビューの対象

- 入口のアダプタ: ゲート、`THREADS_CONNECT_ENABLED`、名前の一本化、失敗を成功として覚えないこと、組み立ての動的 import。
- iOS の `preferUniversalLinks` と、17.4 未満を最初に断ること。Android の App Link の判定。
- 戻り（リダイレクト）・トークン・本人の結び付けは、H5 と SQL の既存の担当のまま。アダプタは中身を変えていない。
