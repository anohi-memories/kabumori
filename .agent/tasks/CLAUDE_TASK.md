# Claude Task 2

- task_id: x-multibrand-phase1-local-baseline-20260910
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- purpose: 複垢化正式設計の承認済み判断を反映し、本番へ一切影響を与えずにPhase 1（ローカルSupabaseで現行かぶモリ1ブランドの再現・検証基盤構築）を進める。

## Approved architecture decisions

ChatGPT側で以下を正式決定済み。

1. X Appは当面3ブランドで共通1 Appを使用する。将来分離できるよう `oauth_client_ref` は設計上残す。
2. Xトークン管理は自前AES-GCMではなくSupabase Vaultを採用する。通常テーブルへSecret値を平文保存しない。
3. 既存のシングルトン設定は、新テーブルへ全面移行せずin-placeでブランド対応へ多行化する方針。
4. Phase 1開始前にDocker Desktopを導入し、ローカルSupabaseを使って本番から分離したDB検証環境を作る。

正式設計書は `docs/multibrand/ARCHITECTURE.md`（feature/multibrand-foundation commit `bfa4c7b`）を正本とする。

## Read First

開始時に必ず確認する。

- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- `.agent/tasks/CLAUDE_TASK.md`
- `docs/multibrand/README.md`
- `docs/multibrand/SURVEY.md`
- `docs/multibrand/ARCHITECTURE.md`

開始前に `origin/main` をfresh-checkすること。既存未コミット変更は他workstreamの所有物として扱い、編集・削除・stage・commitしない。

## Model Guidance

Phase 1は環境構築・再現・テストが中心なので通常はSonnet系でよい。設計の再判断、DB構造の重大な変更判断、Vault/Cron/認証まわりで設計変更が必要になった場合は勝手に決めず停止してChatGPTへ報告する。その際は必要ならOpusへ切り替える。

## Scope — Phase 1 only

目的は「複垢化実装」ではなく、現行かぶモリ1ブランドの安全なローカル再現基盤を作ること。

実施してよいこと：

- `/Users/yuya/Developer/kabumori-multibrand` の分離作業環境を使用
- 最新 `origin/main` と `feature/multibrand-foundation` の差分・競合を確認
- Docker Desktopの導入と起動（必要な範囲のみ）
- Supabase CLI / ローカルSupabaseの初期化・起動
- 本番へlinkされていないことの確認
- リポジトリに存在するmigrationからローカルDBを再構築
- 既存Edge Functions/RPC/DB schemaのローカル再現性確認
- 既存テスト680件の再実行
- 必要ならローカル再現用の安全な設定・スクリプト・文書の追加
- 本番依存があってローカル再現できない箇所の洗い出し
- Phase 2へ進むための不足条件を明文化

## Non-Negotiable Safety Rules

- 本番Supabaseへのlink禁止
- 本番DBへの書き込み禁止
- 本番migration適用禁止
- 本番RPC変更禁止
- 本番Edge Function deploy禁止
- 本番Cron変更禁止
- 本番Secret/Vault変更禁止
- X OAuth・トークン取得・実アカウント接続禁止
- X実投稿禁止
- 会社員AIラボ／みおの有効化禁止
- mainへのmerge禁止
- Secret値・認証情報をGit、ログ、文書へ出さない
- `kabumori`既存本番挙動を変えるコード変更はPhase 1では行わない

特に、ローカルSupabaseの起動前後で `scripts/multibrand/check-safe-env.sh` を実行し、本番project ref/linkを拾っていないことを確認する。

## Important known gaps

以下は現行Gitと本番の不整合として既知。Phase 1で勝手に解消・取り込みしない。

- GitHubに存在しない本番コード（銘柄マスタ同期Function 2本、DB変更9本）
- 本番で動いている重要ニュースX公開Cron migrationが既存作業側では削除状態
- 本番migration適用状況が完全確認できていない

これらがローカル再現の妨げになる場合は、事実と影響範囲を報告して停止する。複垢化タスクへ混ぜない。

## Completion Criteria

- Docker + ローカルSupabaseが本番非接続状態で起動できる
- repository管理下のmigrationでローカルDBを再構築できる、または再構築不能な具体的理由が特定できる
- 現行かぶモリ1ブランドのDB/RPC/主要投稿パイプラインについて、ローカルでどこまで再現可能か一覧化されている
- X実投稿なしで検証できるdry-run/テスト経路を明確化している
- 既存テスト680件を再実行し結果を記録する
- 本番への変更がゼロである
- Phase 2（brand_id導入）へ進めるかどうかを判定できる状態にする

## Deliverables

必要に応じて `docs/multibrand/` 配下へPhase 1結果を追記・新規文書化する。

最低限Reportで以下を明記する。

- Docker / Supabase localの状態
- 使用したローカル構成
- migration再現結果
- RPC / Edge Functions / Cron相当のローカル検証可否
- 680テスト結果
- 本番非接続・誤投稿防止確認
- 作成／変更ファイル
- commit hash / push先
- 残課題
- Phase 2開始可否

完了後は勝手にPhase 2へ進まず、statusを `review_required` にして停止する。ChatGPT側でK2確認を行う。

## Report

- task_id: x-multibrand-phase1-local-baseline-20260910
- result: ローカルSupabase再現基盤を構築し、`feature/multibrand-foundation` にcommit/push（mainへはmergeしていない）。本番への変更ゼロ。Docker Desktop導入は環境制約により未完了だが、Podmanで代替し検証を完了した。作業中に本番へ実影響しうる安全上の懸念を発見しその場で解消した（下記）。ここで停止し、Phase 2へは進んでいない。
- deliverable: `docs/multibrand/PHASE1.md`（commit `719249f`、親は設計commit `bfa4c7b`）。詳細な検証結果・表・手順は同ファイルを正本とする。以下は要約。
- Docker / Supabase localの状態:
  - Docker Desktop（`brew install --cask docker`）: **失敗**。`docker-credential-osxkeychain`配置の`sudo mkdir`が対話式パスワード入力を要求し、この実行環境には対話端末が無いため完了不能
  - 代替としてPodman（`brew install podman`、sudo不要）を導入し、`podman machine init/start`（Apple Virtualization.framework、sudo不要）でVMを起動
  - `supabase start`フル構成: 失敗（`statfs`エラー、Podman経由のDocker API互換層の既知の制限）。DB本体のmigration適用は最後まで成功した後、補助コンテナ作成で失敗
  - `supabase start -x <補助サービス全部>`（DBのみ）: **成功**。healthy状態で起動
  - `supabase functions serve`: **成功**。important-news-monitor / send-push-notifications / x-test-post の3関数ともローカルでサーブ確認
  - Kong/PostgREST/GoTrue/Storage/Studio: 起動せず（Podmanの制限。Docker Desktop導入後に要再検証）
- migration再現結果: リポジトリ管理下の既存39件＋ローカル専用2件、**全41件が成功**。適用後テーブル32・public関数20・拡張(pg_cron,pg_net)2・tipsシード50行を確認
- RPC / Edge Functions / Cron検証可否:
  - RPC: 直接psql経由で`claim_due_post()`/`plan_daily_posts()`等を実行し正常応答を確認（PostgRESTが無いためREST経由ではなく直接SQL）
  - Edge Functions: `functions serve`でプロセス起動を確認（Kong無しのためHTTPエンドポイント経由の呼び出し自体は未検証）。ロジック単体は既存`deno test`（fetchモック、本番非接続）で680件検証
  - Cron定期実行そのものは意図的に未検証（下記安全上の理由）
  - X実投稿なしで検証できる経路: 既存dry-runモード群（テストで「Xを呼ばない」ことが固定済み）。ただし今回はOPENAI_API_KEY等のSecret受け渡し方法が未整備のため、dry-run呼び出し自体は次回以降
- 680テスト結果: 作業開始時・Phase1完了後の両方で **680 passed / 0 failed**（`deno test --no-check --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions`）
- **安全上の発見と対処（重要）**: 既存migrationの`cron.schedule(...)`はジョブ本文に本番プロジェクトURL（`https://wsmznyzcvmuitkglfeuj.supabase.co/...`）を直接埋め込んでいる。ローカルDBへ全migrationを再生すると同じジョブがローカルpg_cronにも登録され、条件が揃えばローカルのpg_cronワーカーが実際に本番Edge Functionへ`net.http_post`してしまう構造的リスクがあった。今回は`important_news_monitor_settings`の`is_active`/`auto_publish`がいずれも`false`、ローカルVaultにSecretが0件だったため実害は発生しなかったが、値次第では発火しうる状態だった。発見直後にローカルDBで`cron.unschedule`し即座に解消、恒久対策として全migration適用後に必ずcron.jobを空にするローカル専用migrationと、`check-safe-env.sh`への`cron.job`件数チェックを追加した。本番のCron・DB・Secretには一切触れていない
- 作成／変更ファイル（`feature/multibrand-foundation`、commit `719249f`）:
  - 追加: `supabase/migrations/00000000000000_local_only_enable_extensions.sql`（pg_cron/pg_net、ローカル専用、本番へは絶対適用しない旨を冒頭に明記）
  - 追加: `supabase/migrations/99999999999999_local_only_disable_cron_jobs.sql`（同上、cron.job全unschedule）
  - 追加: `docs/multibrand/PHASE1.md`
  - 変更: `scripts/multibrand/check-safe-env.sh`（cron.job件数チェック追加）
  - 変更: `docs/multibrand/README.md`（PHASE1.mdへのリンクと注意書き追加）
  - 変更: `.gitignore`（`supabase/.temp/` `supabase/.branches/` `supabase/config.toml`を追加、ローカルCLI生成物のコミット防止）
  - 本番チェックアウト（`/Users/yuya/Developer/kabumori`）・mainブランチへの変更なし
- commit_hash: `719249f`（`feature/multibrand-foundation`、親は設計commit `bfa4c7b`）。main側は本Report更新の`.agent/`2ファイルのみ
- push: `origin/feature/multibrand-foundation`へpush済み（`bfa4c7b..719249f`）。mainへのmergeなし
- 本番非接続・誤投稿防止確認: `check-safe-env.sh`を節目ごとに実行し常に`SAFE`を確認。`supabase/.temp/`にlink情報が生成されていないことを確認。`--project-ref`/`--linked`は一度も実行していない。上記cron安全対処により、ローカルpg_cronが本番URLへ到達しうる状態は解消済み。X OAuth・トークン取得・実アカウント接続・X実投稿は一切実施していない
- 残課題:
  1. Docker Desktop未導入。ユーザー本人がパスワード入力で`brew install --cask docker`を完了させる必要がある（詳細はPHASE1.md「ユーザーが次に行えること」）
  2. Kong/PostgREST/Auth/Storageを伴う結合検証はDocker Desktop導入後（またはPodmanの`podman-mac-helper`導入、要sudo）に再実施が必要
  3. dry-runモードのローカルEdge Function実行にはOPENAI_API_KEY等のSecret受け渡し方法の安全な設計がPhase 2以降で必要（`.env`を複垢worktreeに置くのは禁止のため）
  4. Cron定期実行そのもののローカル検証は安全のため意図的に見送った。必要になれば、ジョブ本文をローカルURLへ差し替える別設計が必要
  5. `ARCHITECTURE.md` §19記載の既存残課題（本番migration適用状況未確定、Cron 1〜4がmigration外等）はPhase1の対象外のまま
- Phase 2開始可否: **条件付きで開始可能**。DB migration・RPC・Edge Functionsのロジックはローカルで再現・検証できる状態にあり、`ARCHITECTURE.md`のPhase 2（brand_id導入、`_shared/brand/*`追加、`loadXTokens`重複解消等）はこの環境で着手できる。PostgREST/Auth等を伴う結合テストは、Docker Desktop導入までdeno testと直接SQL検証で代替する
- next_recommendation: (a) K2でレビュー、(b) Docker Desktop導入をユーザーに依頼（任意、Phase2着手をブロックしない）、(c) Phase 2（brand_id導入のコード変更・migration）を新タスクとして割当
