# Codex Task 2

- task_id: close-report-dual-failure-diagnosis-and-hardening-20260916
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: 2026-09-15 JSTの大引けで「Xの大引け投稿」と「アプリの大引け personalized report」が両方失敗した事象を、production read-only evidenceから切り分け、再発防止に必要な最小修正を安全に準備する。

## User intent

ユーザーは、今日の大引けでX投稿もアプリ側も失敗したため修正したい。Phase 5 broad-newsは本番rollout済みで、このH2は別タスクとして大引け障害に集中する。

## Critical parallel-safety boundary

現在Codex H1は `x-multibrand-phase3k-ai-lab-first-live-test-20260916` が `ready` で、`x-test-post` / X OAuth / AI Lab publish path / posting windows を扱う。

したがってこのH2では、H1が完了するまで以下を厳守:

- `x-test-post` sourceを変更しない
- `x-oauth-connect` を変更しない
- OAuth/Vault/social_accounts/AI Lab publish設定を変更しない
- posting_windows / planner / X Cronを変更しない
- H1と同じproduction設定を書き換えない

X大引け側は **read-only診断のみ** 可。
X側の修正に `x-test-post` 変更が必要と判明した場合は、その具体箇所・原因・修正案をReportして停止し、H1完了後の別承認を待つ。

一方、`personalized-reports` 側がH1と競合しないことをfresh-checkで確認できた場合のみ、アプリ大引け側の最小修正・テストをこのH2で進めてよい。

競合判定が曖昧なら書き込みせず停止する。

## Mandatory startup

開始前に必ず確認:

1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/tasks/CODEX_TASK.md`
5. `.agent/CODEX_REPORT_2.md`
6. fresh `origin/main`
7. production Function versions / relevant Cron / settings read-only
8. 2026-09-15 JST大引け前後のproduction evidence

必ずisolated clean worktree/cloneを使う。
既存の未コミット変更は他workstream所有物として触らない。

## Phase A — 2026-09-15 dual-failure forensic audit

まずコード変更なしで、Xとアプリを別々に時系列化する。

### A1. X大引け

2026-09-15 JSTの大引けについて最低限確認:

- `plan_close_report()` が当日rowを生成したか
- `scheduled_posts` の対象row
  - scheduled_for
  - claim / status
  - retry/error
  - published_at / external post id相当
- `close_report_runs` / diagnostics
- `x-test-post` invocation結果
- Nikkei取得
- `TOPIX連動ETF（1306）` 取得
- source URL / observed_at / freshness
- 15:30以降の同日終値gate
- Fact評価
- Voice評価 / retry
- generation / publish直前のstop reason
- X APIまで到達したか
- 同じ時刻帯のDB/HTTP timeoutや504等

「スケジュールされなかった」「claimされなかった」「市場データ不足」「Fact/Voice失敗」「publish失敗」を混同しない。

### A2. アプリ personalized close report

同じ2026-09-15 JSTについて最低限確認:

- `personalized_reports` の close report row有無
- scheduled/started/completed/failed時刻
- status / fact_status / error code
- packet / market-data diagnostics（秘密情報を含めない）
- generation回数
- Fact retry有無
- report保存まで到達したか
- notification enqueue有無
- notification queue status
- Push dispatcher到達有無
- user setting `close_report` / push opt-inをread-only確認

### A3. 共通原因判定

Xとアプリで以下の共通依存を確認:

- 同日市場データ source / timestamp
- Nikkei / TOPIX proxy扱い
- source freshness
- OpenAI/Fact evaluator availability
- Supabase/pg_net timeout
- scheduler/Cron時刻

共通原因か、独立した2障害かを明示する。

## Phase B — app close-report hardening

H1と競合しないことを確認できた場合のみ実装可。

特に既知事象:
- 2026-09-14 morning personalized reportは `REPORT_FACT_FAILED`
- packetにない「指数→保有銘柄へ影響」という因果表現を生成し、fail-closed
- retryがなく朝刊自体が欠落した

今回のclose reportが同系統なら、以下を検討:

1. prompt / writer rule
   - packetにない因果関係を断定しない
   - 「指数が保有銘柄に影響した/する」等は根拠がpacketにある場合だけ

2. bounded retry
   - Fact fail時に最大1回だけ再生成→再Fact check
   - 無限retry禁止
   - retry後もfailなら従来どおりfail-closed
   - 同一reportの重複保存/重複Pushを起こさない

3. deterministic guard
   - 明確な未根拠因果フレーズを事前/事後に検知できるならpure logic化
   - 根拠のある表現まで過剰除外しない

4. observability
   - first Fact fail / retry result / terminal reasonを既存diagnosticsに安全に残す
   - raw secret/model内部出力を保存しない

今回の障害原因が別なら、実データに基づき最小修正に変更してよいが、scopeを拡大しすぎない。

## Phase C — X close-report fix boundary

X側の原因が `x-test-post` sourceにある場合:

- このH2では修正しない
- 原因箇所、該当function/file、再現条件、必要テスト、最小修正案をReport
- H1が完了した後に新しいH2/Codex taskとして実装する

X側がsource変更不要で、read-only監査だけで運用上の既知原因が確定した場合も、production設定を勝手に変更しない。

## Tests — personalized reports

コード変更した場合、最低限:

- close report Fact fail → 1回だけretry
- retry success → completed exactly once
- retry fail → terminal failed / no notification
- unsupported causality is rejected or rewritten without fabricated relation
- supported causality remains allowed
- duplicate report saveなし
- duplicate notificationなし
- morning report regression
- close report regression
- push deep-link/source type regression
- report_logic tests
- `deno check` changed modules
- app relevant tests if client changes occur
- `git diff --check`

## Production policy before C2

このH2ではC2前に以下禁止:

- `x-test-post` deploy
- `personalized-reports` deploy
- DB migration/schema/RPC apply
- `supabase db push`
- Cron/settings変更
- manual/synthetic close report
- manual/synthetic Push
- scheduled_postsの人工挿入/再claim
- X/OpenAI production manual invoke
- X投稿
- OAuth/Vault/token変更
- migration history repair/reconcile

production read-only auditは可。

## Deliverables

Reportに必須:

1. 2026-09-15 X大引けの正確な失敗地点
2. 2026-09-15 app大引けの正確な失敗地点
3. 共通原因か独立障害か
4. 各failure code / timestamp / relevant diagnostics
5. X API / Push APIまで実際に到達したか
6. app側修正をした場合の変更ファイル・テスト結果
7. X側に必要な次修正（H1競合がある場合）
8. production変更0件の確認
9. remaining issues
10. next recommendation

## Completion

- 原因調査だけで終わる場合も `status: review_required`
- app側の非競合修正まで完了した場合も `status: review_required`
- `next_owner: chatgpt`
- `.agent/CODEX_REPORT_2.md` を更新
- 必要最小限のTASK/Report/sourceのみcommit/push
- C2前に本番反映しない
