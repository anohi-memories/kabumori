# Phase 1: ローカルSupabaseでの現行かぶモリ1ブランド再現（結果）

- task_id: `x-multibrand-phase1-local-baseline-20260910`
- 実施: 2026-09-10 / Claude slot 2
- 前提: [ARCHITECTURE.md](ARCHITECTURE.md) の承認済み判断（X App共通・Vault採用・シングルトンin-place多行化・Docker導入）
- 状態: **本番への変更ゼロ。Phase 2（brand_id導入のコード変更）は未着手、ここで停止。**

## 結論（先に要約）

- **Docker Desktopの導入は完了できなかった**（brewのcaskインストールが特権ヘルパーの配置でsudoパスワードを要求し、対話端末が無いため失敗）。
- 代わりに**Podman**（`brew install podman`、sudo不要）で代替し、**ローカルPostgreSQL + 既存41件全migration + ローカルRPC呼び出し + Edge Functions 3本のローカルサーブ**まで再現に成功した。
- 途中、**重大な安全上の発見**があり、その場で対処した（下記「安全上の発見と対処」）。
- Kong/PostgREST/Auth/Storage等の補助コンテナは、Podman経由のDocker API互換層の制限で起動できなかった（DB本体・Edge Functionsの動作には影響しない）。
- 既存Denoテスト680件は最初から最後まで一貫してpassしている。

## Docker / Supabase local の状態

| 項目 | 結果 |
|---|---|
| Docker Desktop（brew cask） | **失敗**。`docker-credential-osxkeychain` を `/usr/local/bin` へ配置する際の `sudo mkdir` が対話式パスワード入力を要求し、この実行環境には対話端末が無いため失敗。GUIアプリの初回起動でも別途管理者権限が要求される想定 |
| Podman（brew formula） | 成功。`brew install podman`（sudo不要）→ `podman machine init` → `podman machine start`（Apple Virtualization.framework、sudo不要） |
| Docker socket互換ヘルパー（`podman-mac-helper`） | **未導入**（sudoが必要なため）。代わりに `DOCKER_HOST=unix:///.../podman-machine-default-api.sock` を明示的にexportしてSupabase CLIに使わせた |
| `supabase start`（フル構成） | 失敗（`LegacyContainerCreateError: statfs ... operation not supported`）。DBのmigration適用は最後まで成功した後、補助コンテナの作成で失敗 |
| `supabase start -x <補助サービス全部>`（DBのみ） | **成功**。`supabase_db_kabumori-multibrand-local` が healthy で起動 |
| `supabase functions serve` | **成功**。3関数（`important-news-monitor` / `send-push-notifications` / `x-test-post`）がローカルでサーブされた（Kongコンテナが無い旨の警告のみ、起動自体は成功） |
| Kong / PostgREST / GoTrue / Storage / Studio / Realtime 等 | 起動せず（`-x` 除外リストに含めなくても実際には起動しなかった。ログにエラーは出ず、`supabase status` は常にこれらを "Stopped services" として報告） |

**Docker Desktopが必要な理由**: 今回はPodmanで代替できたが、これはDocker API互換層のvolumeマウント処理（`statfs`）に依存する一部のコンテナ（Kong等）が起動できないという制限付きの代替。本物のDocker Desktopであれば全コンテナが起動できる可能性が高い。Docker Desktop導入には管理者パスワードの対話入力が必要なため、**ユーザー本人の操作が必要**（下記「ユーザーが次に行えること」）。

## 使用したローカル構成

- 作業ディレクトリ: `/Users/yuya/Developer/kabumori-multibrand`（`feature/multibrand-foundation`）
- `supabase/config.toml`: `project_id = "kabumori-multibrand-local"`（未追跡、README記載の内容のまま）
- コンテナランタイム: Podman 6.1.1（`podman machine` は Apple Virtualization.framework、rootlessモード）
- `DOCKER_HOST` を明示的に指定してSupabase CLIから利用
- 追加した2つのローカル専用migration（詳細は次節）

## 追加したファイル（ローカル専用、本番へは絶対適用しない）

### `supabase/migrations/00000000000000_local_only_enable_extensions.sql`

本番の`pg_cron`/`pg_net`拡張はSupabaseのプラットフォーム側管理で有効化されており、リポジトリのmigrationには「拡張を作る」文が存在しない。そのため空のローカルDBに全migrationをそのまま適用すると、`20260908110000_add_important_news_publish_ready_cron.sql`が `relation "cron.job" does not exist` で失敗する。既存migrationは一切変更せず、全migrationより前に適用される最古のタイムスタンプでこのファイルを追加し、`create extension if not exists pg_cron / pg_net` のみを行う。

### `supabase/migrations/99999999999999_local_only_disable_cron_jobs.sql`

下記「安全上の発見と対処」への恒久対策。全migrationの後（最も新しいタイムスタンプ）に適用され、その時点で`cron.job`に登録されている全ジョブを`cron.unschedule`する。

**この2ファイルは、本番チェックアウト（`/Users/yuya/Developer/kabumori`）や `main` ブランチには絶対にコピー・マージしないこと。** ファイル冒頭にも同じ注記をコメントで記載済み。

## 安全上の発見と対処（重要）

**発見**: 既存migration中の `cron.schedule(...)` は、ジョブの実行内容（SQL文字列）に**本番のプロジェクトURL**（`https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/...`）を直接埋め込んでいる（`important-news-publish-ready` と `send-push-notifications-dispatch`）。これは本番でCronが動くために必要な実装だが、**そのままローカルDBへ全migrationを再生すると、同じジョブ本文がローカルのpg_cronスケジューラにも登録される**。ローカルPostgresは本番と同じ`pg_net`拡張（`net.http_post`）を持つため、条件さえ揃えばローカルのpg_cronワーカーが実際に本番のEdge FunctionへHTTPリクエストを送ってしまう構造的リスクがあった。

**確認した実際の状態**（今回のローカルDBで）:
- `important-news-publish-ready`: WHERE句が `important_news_monitor_settings.is_active=true and auto_publish=true` を要求。ローカルDBのシード値はどちらも `false` だったため、**今回は実際には発火しなかった**。
- `send-push-notifications-dispatch`: `vault.decrypted_secrets` から `send_push_notifications_cron_secret` を読めた場合のみ`net.http_post`を実行する設計。ローカルVaultにはSecretが1件も無い（`select name from vault.decrypted_secrets` が0行）ため、**今回は実際には発火しなかった**。

**結論**: 実害は発生しなかった（値がたまたま安全側だった）が、構造的リスクであり、以後の作業で誰かがテストのために`is_active`/`auto_publish`をtrueにする、あるいは何らかの理由でローカルVaultにsecretを入れる、といった操作を行えば発火しうる状態だった。

**対処**:
1. 発見直後、ローカルDBに対して `select cron.unschedule('important-news-publish-ready'); select cron.unschedule('send-push-notifications-dispatch');` を実行し、その場でローカルのcron.jobを空にした。
2. 恒久対策として `99999999999999_local_only_disable_cron_jobs.sql`（前節）を追加し、`supabase db reset` のたびに自動でcron.jobが空になることを確認した。
3. `scripts/multibrand/check-safe-env.sh` に、ローカルDBコンテナが起動している場合は `cron.job` が0件であることを確認する項目を追加した（0件以外なら `NG` として具体的なunschedule手順を表示する）。

この一連の対処はすべて**ローカルDBに対する操作のみ**で、本番のCron・DB・Secretには一切触れていない。

## migration再現結果

- **41件全て成功**（既存39件＋ローカル専用2件）。
- 適用後のテーブル数: 32、public関数（RPC）数: 20、有効拡張（pg_cron, pg_net）: 2、`tips`テーブルのシード行: 50件。
- `public`スキーマ内のどの関数のソースにも `net.http_post` は含まれていない（`net.http_post`はEdge Function自体のコードと`cron.job`のジョブ本文にのみ存在）ことを確認済み。**RPCを直接呼び出す分には、上記cron対策と独立して、本番への副作用は構造的に発生しない。**

## RPC / Edge Functions / Cron相当のローカル検証可否

| 対象 | 可否 | 方法・備考 |
|---|---|---|
| RPC（`claim_due_post` / `plan_daily_posts` 等） | **可能**。DBコンテナへ直接psqlで接続し `select public.claim_due_post();` 等を実行して確認した（0行/正常応答） | PostgRESTが無いため、REST経由（`/rest/v1/rpc/...`）ではなく直接SQLで検証 |
| Edge Functions（HTTP起動） | **可能**。`supabase functions serve` で3関数（important-news-monitor / send-push-notifications / x-test-post）がローカルでサーブされることを確認した | Kong（APIゲートウェイ）が無いため `54321/functions/v1/...` への直接アクセスは未検証（関数プロセス自体の起動は確認済み） |
| Edge Functionsのロジック単体 | **可能**（既存手段）。`deno test`（fetchモック）で680件が引き続き通る。今回の変更でも影響なし | 本番Supabaseに一切接続しないため、Phase 1の主要な検証手段として最も安定 |
| Cron相当（`cron.schedule`の定期実行） | **未検証**（意図的）。上記の安全上の理由により、ローカルでもジョブを常に無効化する方針にした | 定期実行そのものを検証したい場合は、ジョブ本文をローカルのEdge Function URL（`http://127.0.0.1:54321/...`）に差し替えた**別のローカル専用migration**を追加する必要がある（今回は実施せず、必要性が出た時点で改めて設計する） |
| PostgREST / GoTrue / Storage / Studio | **不可**（Podman経由の制限）。Docker Desktop導入後に再検証が必要 |

## X実投稿なしで検証できるdry-run/テスト経路

- 既存の `close_report_dry_run` / `morning_report_dry_run` / `useful_tip_dry_run` / `kabumori_voice_dry_run` 等のmodeは、いずれもコード内で「dry-runはX APIを呼ばない」ことがテストで固定されている（例: 15番テスト「the close_report dry-run branch in index.ts never calls the X API」）。ローカルの `functions serve` からこれらのdry-runモードを叩けば、DB接続はローカルのみ、X APIは呼ばれない状態で生成〜Fact Check〜Voice評価までを検証できる（今回は関数の起動確認までで、実際のdry-run呼び出し自体は行っていない。OPENAI_API_KEY等のSecretをローカル`.env`に置く必要があり、それは複垢worktreeでは禁止のため、Phase 2以降で安全な方法を別途検討）。
- X投稿そのもの（`postToXWithRefresh` / `/2/tweets` / `/2/media/upload`）はローカルで一切呼び出していない。

## 680テスト結果

- 開始前（`feature/multibrand-foundation`、origin/mainの新規migration 1件を取り込み後）: **680 passed / 0 failed**
- Phase 1の全作業（ローカルmigration2件追加、check-safe-env.sh更新）後、再実行: **680 passed / 0 failed**
- 実行コマンド: `deno test --no-check --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions`

## 本番非接続・誤投稿防止の確認

- `scripts/multibrand/check-safe-env.sh` を作業の節目ごとに実行し、常に `SAFE` を確認した。
- `supabase/.temp/` にlink情報が生成されていないことを確認した（このworktreeは一度も `supabase link` していない）。
- 本番プロジェクト参照（`wsmznyzcvmuitkglfeuj`）を含むコマンド（`--project-ref` 指定、`--linked`）は一切実行していない。
- 上記「安全上の発見と対処」の通り、ローカルpg_cronが本番URLへ到達しうる状態を検出し、その場で解消し、再発しない恒久対策（migration＋check-safe-env.shのチェック）を入れた。
- X OAuth・トークン取得・実アカウント接続・X実投稿は一切行っていない。

## 作成・変更ファイル（このコミットの範囲）

- 追加: `supabase/migrations/00000000000000_local_only_enable_extensions.sql`
- 追加: `supabase/migrations/99999999999999_local_only_disable_cron_jobs.sql`
- 追加: `docs/multibrand/PHASE1.md`（本ファイル）
- 変更: `scripts/multibrand/check-safe-env.sh`（cron.jobチェック追加）
- 変更: `docs/multibrand/README.md`（本ファイルへのリンク追加）
- 本番チェックアウト（`/Users/yuya/Developer/kabumori`）・`main`ブランチへの変更なし

## 残課題

1. **Docker Desktopが未導入**。ユーザー本人がパスワードを入力してインストールする必要がある（下記手順）。導入後、Kong/PostgREST/Auth/Storage等を含むフル構成での再検証が必要。
2. Podman経由でも、DB本体とEdge Functionsのプロセス起動自体は確認できたため、Phase 2のコード開発・DBレベルのテストはPodmanのままでも継続できる可能性が高い。ただし「PostgREST経由のAPI呼び出し」「Auth」「Storage」を伴う検証にはDocker Desktop（またはPodmanの `podman-mac-helper`導入、要sudo）が必要。
3. dry-runモードのローカルEdge Function実行には`OPENAI_API_KEY`等のSecretが必要。複垢worktreeに`.env`を置くことは禁止しているため、安全な受け渡し方法（例: シェル環境変数のみ、ファイルに書かない）をPhase 2で決める。
4. Cronの定期実行そのもののローカル検証は意図的に見送った（安全のため）。必要になった時点で、ローカル専用URLを指すジョブ本文に差し替える設計を別途行う。
5. `ARCHITECTURE.md` §19 に記載済みの残課題（本番migration適用状況の未確定、Cron 1〜4がmigration外等）はPhase 1の対象外のまま。

## ユーザーが次に行えること（任意、Phase 1の完了自体はこれに依存しない）

Docker Desktopをフル機能で使いたい場合:

```bash
brew install --cask docker
```

上記はGUIアプリ配置時にパスワード入力を求められる可能性がある。導入後、Docker.appを一度起動してセットアップを完了させてから、複垢worktreeで `supabase start` を再試行する。

## Phase 2開始可否

**条件付きで開始可能。** DB migration・RPC・Edge Functionsのロジックはローカルで再現・検証できる状態にあり、`ARCHITECTURE.md` のPhase 2（`brand_id`導入、`_shared/brand/*`追加、`x-test-post`の`loadXTokens`重複解消等）はこの環境で着手できる。ただしPostgREST/Auth等を伴う結合テストや、`supabase functions serve`経由でのdry-run実行検証は、Docker Desktop導入（または`podman-mac-helper`導入）まで手動SQL・deno testでの代替検証にとどまる。
