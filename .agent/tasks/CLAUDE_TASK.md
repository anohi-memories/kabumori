# Claude Task 2

- task_id: x-multibrand-phase1-local-baseline-20260910
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
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

未実施。G2開始後に記入する。
