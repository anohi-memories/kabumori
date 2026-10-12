# POSTONA Threads アプリの接続フロー＋退会時の Threads 後片付け V1（ソース実装・ゲート OFF）

- TASK: `postona-g4-threads-mobile-oauth-and-cleanup-wiring-v1-20261012`（G4）
- 基準: PR #144 の先頭 `09fd2c49114b7d26c23b71a3084574dc6a5a7ad6` に積む Draft PR（PR #144・#140 は無変更）
- 依存の正確な版（読み取り専用）: #124 `c30f246409a77080cbc03aef6c4cb72b5481e125`、#135 `e38788d6677082138f0990453c7d2f00549666d0`、#139 `b4fa672f97592e87682671454e868a92098cbd56`、G5 #152 `5ad5bb40cadf013f00553acd5509f4f74fdbff7c`（未マージ・未適用。最終の G5 契約ではない）
- 状態: **ソースは動く形で完成、ユーザーが触れる入口はゲート OFF**。本番・Meta・Supabase への呼び出しはしていない。

## 1. 作ったもの

### A. アプリの接続／再接続フロー（本物の処理。ボタンは `THREADS_CONNECT_UI_ENABLED = false` で無効）

`apps/social-mobile/src/features/threads-connect/`

1. 本人のログイン（`useAuth` のアクセストークン）で `threads-oauth-connect-user` に `{"action":"start"}` を送る。
2. 返ってきた認可 URL を検証する（公式の `https://threads.com/oauth/authorize`、5つのパラメータだけ、戻り先＝登録した HTTPS コールバック、`threads_basic,threads_content_publish`、`response_type=code`、形の正しい state）。違えば開かない。
3. システムの認証ブラウザ（iOS は非共有セッション）で開く。
4. 最初に来た「登録したコールバックへの戻り」（ブラウザの結果、またはアプリリンク）を**1回だけ**受け取る。ほかの URL は無視。
5. その時点でも同じ人がログインしていて、期限内であることを確認する（途中でアカウントが変わった・ログアウトした → 中止して何も送らない）。
6. 戻り URL をそのまま（コード・state を読まず、保存もログもせず）、**その時点の**本人のトークンでサーバーへ `{"action":"callback","callback_url":…}` として送る。Threads で「許可しない」を選んだ戻りは送らずにキャンセル扱い。
7. サーバーの「接続完了の受領票」を受け取ったら、アカウント一覧を読み直し、その Threads アカウントが接続済みと確認できてから「接続しました」と表示する（受領票やブラウザの戻りだけでは表示しない）。投稿の許可は別（自動では有効にならない）。
- 二重タップ（`IN_PROGRESS`）、キャンセル、期限切れ、アカウントの切り替え、不正な戻り URL、サーバーの拒否や結果不明（再試行しない）、それぞれ固定の文言。
- **戻り先の設定が無い間は動かない**: 登録した HTTPS コールバックはアプリ設定 `expo.extra.threadsConnectCallbackUrl` から読む。今は未設定なので `CALLBACK_NOT_CONFIGURED`（「戻り先の設定がまだ整っていません」）で止まる。この URL は Meta アプリに登録した正確な URL で、かつこのアプリの検証済みアプリリンク（iOS Associated Domains／Android App Links）である必要があり、運用側の作業。

### B. アプリと H5 の接続処理の間の受け渡し口（ソースのみ・未接続）

`supabase/functions/_shared/social/threads_connect_edge.ts`

- `POST {"action":"start"}` → `{ok, provider, authorization_url, expires_at}`、`POST {"action":"callback","callback_url":…}` → `{ok, status:"connected", provider, social_account_id, publish_enabled:false, token_expires_at}`。それ以外は固定コードだけ（入力を返さない）。
- 呼び出し元のトークンはそのまま H5 の処理（`createThreadsRuntime`）に渡す。本人確認と state の本人・セッションへの束縛は H5（署名の検証＋Auth の状態）と #124 が DB で行う。この受け渡し口は JWT を解読せず、user id を受け取らず、Meta の秘密も見ない。
- H5 の答えを形で検証し、`publishEnabled:true` の受領票や、公式でない認可 URL は通さない。登録したコールバック以外の戻りは H5 に渡さない。
- **未接続**: H5 の Edge の入口（`threads-oauth-connect-user`、H5 所有）は今も常に 503。この受け渡し口を入口に組み込むのと、H5 の本物の owner transport（専用の所有者 DB 接続）を用意するのは H5 側の作業。

### C. 退会時の Threads 後片付けアダプター（G5 の差し込み口にそのまま合う形・未登録）

- `supabase/functions/_shared/social/threads_provider_cleanup.ts`: G5 #152 の `ProviderCleanupAdapter`（`provider:'threads'`、`hasConnection`、`cleanup`）と同じ形（組み合わせ検証で型も一致を確認）。G5 のファイルには登録しない。
- `supabase/candidates/postona_threads_cleanup/threads_provider_cleanup_candidate.sql`（未適用）: 1トランザクションで、その人の POSTONA ワークスペースの Threads アカウント・Vault のトークン・手動投稿の許可・投稿の試行・nonce・トークン期限の記録を消し、読み戻して確認する。
  - **G5 の表で、その人の削除（アカウント削除、または POSTONA だけの利用終了）が「後片付けの段階」にある間だけ動く**。それ以外は `blocked`（何も消さない）。kabumori だけの利用終了では動かない。
  - 投稿が進行中かもしれない試行（`creating_container`／`publishing`／`publish_returned`／`uncertain`）があれば消さずに `reconciliation_required`（「投稿されていない」に化けさせない）。
  - トークンが他の行と共有されていれば消さずに `reconciliation_required`。
  - Threads にはアプリ側から確かめられる取り消しの仕組みが無いので、成功でも `local_removed_remote_unverified`。`confirmed_remote_revoked` は返さない。Threads は呼ばない。
  - 結果が届かなかった（例外・応答なし）ときは `reconciliation_required`。自動の再試行はしない。
  - X のアカウントや他の人のデータには触れない（検証で確認）。
  - 実行権限は所有者だけ。G5 の削除処理が動くロールへの付与は、G5 が登録するときに別途レビューして行う。それまでアダプターは届かず、`hasConnection` は「読めない」を返す（G5 は照合が必要として止まる）。

## 2. 検証（2026-10-12 JST、すべてローカル・偽データ）

| 検証 | 結果 |
|---|---|
| アプリ `tests/threads-connect.test.mjs` | 18 PASS（開始・アプリリンク経由・二重の戻り・キャンセル・拒否・期限切れ・別アカウント／ログアウト・不正な戻り・期限後の戻り・二重タップ・未設定・開始の拒否と不正な URL ではブラウザを開かない・結果不明の扱い・ログ出力なし・サーバーとの URL 判定の一致・「確認できてから接続済み」） |
| アプリ `tests/threads-manual-publish.test.mjs`（回帰） | 18 PASS |
| アプリ `tsc --noEmit`・`expo lint` | PASS・問題なし |
| Deno `supabase/functions/_shared/social/`＋投稿の Edge | 105 PASS（新規: 受け渡し口 8、後片付け 4） |
| `supabase/tests/postona_threads_cleanup_run.sh`（使い捨て PG17） | ALL PASS（前提不足2種で停止、権限、接続の有無、削除中でなければ何もしない、進行中の投稿、共有トークン、1人分だけ消える・X と他人は無傷、2回目も同じ答え、POSTONA だけの終了、変異4種検出） |
| `supabase/tests/postona_threads_connect_smoke_run.sh`（組み合わせ環境） | ALL PASS（G4 の受け渡し口 × H5 の実コードで start→公式 URL→callback→受領票、他所の戻りは H5 に届かない。G4 のアダプター × G5 #152 の実際の `runProviderCleanups`） |
| NOT_RUN | 本物の Meta、H5 の本物の owner transport、管理された Supabase、アプリリンクの実機確認、シミュレーター（ゲート OFF のため画面は「準備中」） |

既存の大きな回帰（統合 176、アプリ 258、G5 80+）は、変更していない部分なので回していない（TASK の指示どおり）。

## 3. 引き継ぎ表

| | 状態 | 内容 |
|---|---|---|
| (a) G4 | **済（ソース）** | アプリの接続フロー、受け渡し口、Threads の後片付けアダプターと DB 候補、テスト |
| (b) G5 | 未 | #152 の K5 と、1回の独立したセキュリティレビュー（Sol（高））の後で、G5 のファイルでこのアダプターを登録し、削除処理のロールに2つの関数の実行権限を付与。T13 と T10 の最終配線 |
| (c) H5 | 未 | 本物の owner transport（専用の所有者ロール・セッションのロック・custody の1文）、Edge の入口にこの受け渡し口を組み込む、コールバックの受け渡しを検証済みのソースで配線 |
| (d) 運用・ユーザー | 未 | Meta の開発者アプリ、HTTPS コールバックと検証済みのアプリリンク（`expo.extra.threadsConnectCallbackUrl` に設定）、Threads テスター、`threads_basic`／`threads_content_publish`、秘密はチャットやリポジトリに置かない、各種デプロイの承認 |

**ゲートが OFF の今、ユーザーができないこと**: アプリから Threads を接続すること・投稿すること（ボタンは「準備中」で押せない）。サーバー側の入口も 503。
