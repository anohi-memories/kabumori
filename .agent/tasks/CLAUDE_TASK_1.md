# Claude Task 1

- task_id: close-report-factcheck-dryrun-live-parity-20260907
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: urgent
- purpose: 2026-09-07のclose_reportで、本番v89のdry-runはFact Check通過した一方、1回だけ実行したliveが`CLOSE_REPORT_FACT_CHECK_FAILED`で安全停止した差分の根本原因を特定し、dry-run/liveのFact Check条件を一致させる最小修正を行う。

## Confirmed production evidence

- production `x-test-post`: v89 ACTIVE
- `close_report_dry_run`:
  - factCheck: passed
  - Voice: passed
  - wouldPublish: true
  - fixed 4 tags: 各1回、重複なし
  - published: false
  - x_post_id: null
- 同じv89で今日分のlive close_reportを1回だけ実行:
  - `CLOSE_REPORT_FACT_CHECK_FAILED`でX API到達前に安全停止
  - X投稿なし
  - x_post_id: null
  - 二重投稿なし
  - 安全ゲートを迂回する再試行なし
- `posting_windows.close_report.is_active=false` 維持
- migration/schema/GRANT/Cron/secrets/他Function変更なし

## Goal

同一条件のclose_reportについて、dry-runとliveが同じFact Check入力・証拠・判定条件を通るようにし、mode差だけでFact Check結果が変わらないことを保証する。

## Required investigation

以下をdry-run/liveで具体的に比較すること。

1. `generateCloseReport()`へ渡る入力
2. 生成本文（Fact Check前の本文）
3. market data / timestamp
4. source URLs / evidence
5. Fact Check request body
6. Fact Check model・schema・判定条件
7. mode依存分岐
8. claim / run stateの差
9. 実行時刻による再取得・再生成差
10. dry-runとliveが同じFact Check関数を同じ順序で通っているか

「生成内容がたまたま違った」だけで片付けず、live/dry-runの実装上の非対称があるかを特定すること。

## Required implementation

1. まず今回の差分を再現できるテストを追加する。
2. 根本原因を特定する。
3. 原因に対する最小修正だけを行う。
4. 同一のdraft/evidence条件ならdry-run/liveのFact Check判定が一致するテストを追加する。
5. 必要ならFact Check diagnosticsを追加し、dry-run/live双方で少なくとも以下を比較可能にする:
   - fact-check対象本文の識別可能な情報（安全なhash/length等で可）
   - evidence/sourceの件数または識別情報
   - market data timestamp
   - fact-check status
   - mode/path
6. 既存v89の以下は絶対に壊さない:
   - 最終Voice pass後のみX投稿
   - Voice単体fail時の最大1回rewrite
   - rewrite後再Voice
   - 固定4タグを最終Voice後に1回だけ付与
   - dry-runでX APIを呼ばない
   - X二重投稿防止

## Tests

最低限:

1. 今回のdry-run/live差を再現するregression test
2. 同一draft/evidence -> dry-run/live Fact Check parity
3. Fact Check fail -> liveはX API 0
4. Fact Check pass + Voice pass -> liveは投稿直前まで進める構造
5. dry-runは常にX API 0
6. Voice rewrite / fixed hashtags既存tests pass
7. close_report既存tests pass
8. 全体regression test

## Scope

主対象:
- `supabase/functions/x-test-post/index.ts`
- close_report / fact-check関連helper
- 関連tests

必要最小限ならdiagnostics用helper追加可。

## Do not touch

- Codex `important-news-monitor/**`
- Claude slot2 `send-push-notifications/**`
- DB migration/schema/GRANT
- Cron
- secrets
- `posting_windows`
- 他Edge Function

## Production policy

このTASKは **調査 + local implementation + tests + local commitまで**。

禁止:
- production deploy
- X実投稿
- 今日分live再実行
- `posting_windows.close_report.is_active`変更
- DB write
- Cron/secrets変更
- 安全ゲート迂回

pushは原則禁止。完了後にChatGPTレビューへ回すこと。

## Completion

完了時:
- `status: review_required`
- `next_owner: chatgpt`
- `## Report`を追記
- Reportに必ず以下を記載:
  - 根本原因
  - dry-run/liveの具体的な差
  - changed files
  - 再現テスト
  - parity test
  - 全体テスト結果
  - type/lint結果
  - commit hash
  - production変更なし
  - 次工程提案
