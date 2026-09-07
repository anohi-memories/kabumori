# Claude Task 2

- task_id: close-report-factcheck-dryrun-live-parity-20260907
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: urgent
- purpose: 2026-09-07 の close_report で、同じ production v89 に対し `close_report_dry_run` は `factCheck=passed / wouldPublish=true` だった一方、1回だけ実行した live close_report は `CLOSE_REPORT_FACT_CHECK_FAILED` で X API 前に安全停止した。dry-run/live の差分を根本原因まで特定し、最小修正する。

## Confirmed incident

- production `x-test-post`: v89 ACTIVE
- `close_report_dry_run`:
  - `factCheck: passed`
  - `Voice: passed`
  - `wouldPublish: true`
  - fixed 4 tags 各1回、重複なし
  - X未投稿
- live close_report を1回だけ実行:
  - `CLOSE_REPORT_FACT_CHECK_FAILED`
  - X未投稿 / x_post_id null
  - 二重投稿なし
  - 安全ゲートを迂回する再試行なし
- `posting_windows.close_report.is_active=false` を維持

## Investigation scope

重点的に比較する:
- dry-run/live それぞれが Fact Check へ渡す生成本文
- source/evidence
- market data
- fact-check request body
- mode依存分岐
- claim/run state
- 実行時刻による入力差
- liveだけ再生成・再取得されていないか
- dry-runとliveが同じFact Check関数・同じ判定条件を通っているか

## Required work

1. 根本原因を特定する。
2. まず問題を再現するテストを追加する。
3. dry-run/live の Fact Check 条件差が原因なら、同一入力・同一条件で同じ判定になるよう最小修正する。
4. 必要なら診断情報を追加し、dry-run/live の比較ができるようにする。
5. 既存 v89 の以下を壊さない:
   - close_report Voice gate
   - Voice fail時最大1回rewrite
   - 固定4タグを最終Voice後に1回だけ付与
   - X二重投稿防止
6. relevant tests + full regression testを実行する。

## Safety / scope

触ってよい主対象:
- `supabase/functions/x-test-post/**` の close_report / fact-check 関連
- 必要な関連tests

触らない:
- Codex `important-news-monitor/**`
- Claude slot1 の別タスク領域
- `send-push-notifications/**`
- 他Edge Function

禁止:
- production deploy
- X実投稿
- `posting_windows`変更
- DB migration/schema/GRANT
- Cron変更
- secrets変更/表示
- 本番設定変更

## Completion

完了時:
- `status: review_required`
- `next_owner: chatgpt`
- `## Report` を追記
- 根本原因
- dry-run/live の具体的な差
- changed files
- 再現テスト
- relevant/full test結果
- commit hash
- production変更なし
- 次工程の推奨
