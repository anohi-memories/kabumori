# Claude Task 1

- task_id: published-news-feed-and-push-tap-fix-20260910
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus 5
- purpose: Push通知をタップして `/news` を開いた際、すでに `published` になった重要ニュースが `get_my_important_stock_news` の状態条件から漏れて表示されない可能性を解消し、Push→ニュース一覧の導線を本番で一貫させる。

## Context

直前TASK `send-push-notifications-production-restore-20260910` は完了済み。

確認済み:
- `important-news-monitor` v37 は正しい最新版で本番稼働
- important news producerは本番投入済み
- `send-push-notifications` v4 は正しい最新版へ復旧済み
- `alert_settings.push_enabled` / `important_news` opt-outは本番Cron自然実行で実証済み
- 実在ニュースを使った `notifications -> Cron -> iPhone Push` はPASS
- Pushタップ時のクライアント遷移先は `/news`
- 既知問題: `public.get_my_important_stock_news` が現在 `status in ('ready_for_publish','generation_failed')` のような条件で絞っており、`published` を含まないため、自然publish済みニュースがPushタップ後の `/news` に表示されない可能性がある
- テスト用ウォッチ銘柄17件は自然E2E観測用として残している

## Model

変更自体は小さいが、DB RPC・本番migration履歴・アプリ表示導線・既存ニュース状態遷移をまたぐ。直近に本番deploy root事故があったため、安全監査込みで **Opus 5を使用する**。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. shared checkout / clean worktreeの未コミット状態確認
7. `.agent/tasks/CODEX_TASK.md` / `.agent/tasks/CODEX_TASK_2.md` / `.agent/tasks/CLAUDE_TASK.md` をread-only確認
8. 他slotが `get_my_important_stock_news`、同じmigration、同じRPC、`/news` 関連ファイルを変更中なら開始せず競合報告
9. 本番RPC定義とrepo内migration/RPC定義を両方確認し、現在条件を推測でなく確定する
10. `/news` 画面がどのRPC/fields/statusを期待しているか確認する

既存未コミット変更は他workstream所有として扱い、変更・削除・stage・commitしない。

## Goal

`published` になった重要ニュースも、対象ユーザーの `/news` フィードに安全に表示されるようにする。

最低条件:
- `published` をフィード対象へ含める
- 現在表示対象の `ready_for_publish` / `generation_failed` 等を意図せず消さない
- `tracked_stocks.is_active=true` の既存対象判定を維持
- 他ユーザー/非登録銘柄のニュースを混ぜない
- 同じニュースの重複表示を増やさない
- Push producerの対象判定との整合を維持
- 既存Push/dispatcher/X投稿ロジックは変更しない

## Phase 1: Audit

まず実装せず以下を確定する。

- 本番 `public.get_my_important_stock_news` のSQL定義
- status filterの現状
- RPCのORDER BY / LIMIT / dedupe / ticker matching
- `/news` 画面で使用する返却列
- `published` 行に必要なtitle/body/source_url/company_code等が揃っているか
- `published` を足すことで古いbacklogや不適切な行が大量表示されないか
- feedに表示すべき時刻基準（published_at / generated_at / source published_at等）の現状を変える必要があるか

今回の主目的はstatus漏れ修正。無関係なフィード全面改修はしない。

## Phase 2: Minimal fix

監査で問題が `published` status漏れだけと確認できた場合、最小修正を行う。

推奨:
- 既存RPCのstatus条件へ `published` を追加
- 既存の対象銘柄マッチ、active判定、limit/order、返却shapeは維持
- migrationでRPC定義を更新する場合、既存権限/SECURITY DEFINER/SET search_path等を完全に保持
- migration名は今回専用にする

もし本番RPCとrepo定義が乖離している場合は、勝手にrepo版で上書きせず差分をReportして安全な統合案を決める。

## Phase 3: Tests

最低限:
- tracked stockに一致する `published` ニュース -> フィードに出る
- tracked stockに一致する現行status -> 従来どおり出る
- 非登録銘柄 -> 出ない
- inactive tracked stock -> 出ない
- 他ユーザーの追跡銘柄 -> 混ざらない
- 同一ニュース -> 重複しない
- order/limit -> 既存仕様維持
- return shape -> アプリ互換
- migration/SQL lint可能範囲
- `git diff --check`

## Production / verification

安全確認・テストPASS後に限り、今回のRPC修正に必要な **最小migration / RPC更新だけ** 本番適用してよい。

直近のmigration履歴乖離があるため、`supabase db push` を盲目的に使わない。本番migration historyを先に確認し、未適用migrationを巻き込まない方法を選ぶ。

本番適用後:
1. RPC定義が期待どおり `published` を含むことをread-only確認
2. 実在する対象銘柄の `published` ニュースがあれば、本人ユーザーでRPCをread-only実行し表示対象になることを確認
3. 非対象銘柄が混ざらないことを確認
4. Push通知行・X投稿・candidate status・backlogは変更しない
5. アプリ実機で `/news` を開ける場合は表示確認してよい。ただし人工ニュース投入は禁止

## Deploy / root safety

このタスクはEdge Function deployを原則必要としない。
Supabase CLIを使う場合は、前回事故対策として必ず:
- `pwd`
- git HEAD
- worktree内 `supabase/config.toml`
- linked project ref
を確認する。

共有checkoutを誤ってrootとして使わない。

## Forbidden

- `important-news-monitor`変更/deploy
- `send-push-notifications`変更/deploy
- `x-test-post`変更/deploy
- Cron変更
- secrets/OAuth変更
- alert_settings変更
- Push本文品質改善を同時実施
- 認証強化を同時実施
- X投稿
- 人工important-news candidate投入
- 既存backlogのstatus変更/削除
- unrelated migration

## Completion

終了時:
- status: `review_required`
- next_owner: `chatgpt`
- このTASK末尾に `## Report` を追記
- `.agent/ORCHESTRATION.md` 規定どおり同期

Report必須:
- task_id
- result
- model_used
- production_rpc_before
- repo_definition_before
- root_cause
- chosen_fix
- changed_files / migration
- tests
- production_apply_method
- production_rpc_after
- published_news_positive_proof
- non_target_negative_proof
- app/news compatibility
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation
