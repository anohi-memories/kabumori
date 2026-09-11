# Codex Task

- task_id: kabumori-production-scheduler-restore-20260911
- owner: codex
- slot: codex-1
- status: done
- next_owner: user
- priority: urgent
- recommended_model: default
- purpose: 複垢化作業で意図せず変更された、かぶモリ本番の投稿スケジューラーを安全に復旧する。新機能追加ではなく復旧専用。朝刊・大引けの専用plannerが再び通常の自動dispatch経路から呼ばれ、明日以降の予定が欠落しない状態へ戻す。

## Confirmed production symptom / root cause

2026-09-11 01:00 JST頃のread-only調査で以下を確認済み。

- `morning_report_settings`: `is_active=true`, center `08:20`, Asia/Tokyo
- `close_report_settings`: `is_active=true`, center `16:00`, Asia/Tokyo
- `posting_windows` の `morning_report` / `close_report` は重複防止のため `is_active=false`
- 2026-09-11 `scheduled_posts` には morning_greeting / tip / useful_tip / interaction は存在するが、`morning_report` / `close_report` は0件
- 本番 `claim_due_post()` は現在 `perform public.plan_daily_posts();` のみ呼び、`plan_morning_report()` / `plan_close_report()` を呼んでいない
- 専用 `plan_morning_report()` / `plan_close_report()` 自体は本番に存在し、設定ON・JPX営業日なら予定rowを作れる
- このため設定ON表示でも、専用plannerが通常dispatchから呼ばれず、朝刊・大引けだけ予定生成されない

## Scope

最小変更で、かぶモリ本番の既存投稿経路を復旧する。

原則:
- `claim_due_post()` の通常dispatchで `plan_daily_posts()` に加えて `plan_morning_report()` と `plan_close_report()` が適切に呼ばれる状態へ戻す
- `posting_windows.morning_report` / `posting_windows.close_report` は `is_active=false` のまま維持し、二重スケジュールを作らない
- 専用plannerの既存営業日/JPX holiday判定、center_time、unique constraint / ON CONFLICTによるduplicate防止を維持
- 2026-09-11分について、まだ各予定時刻前なら専用planner経由で自然に予定rowが補完されることを確認する。手動で `scheduled_posts` rowを直接INSERTしない

## Safety boundary — very important

これは「かぶモリ本番復旧」だけのTASK。

禁止:
- 複垢化Phase 2/3の追加実装
- `brands` / `social_accounts` / `brand_settings` の変更
- AIサラリーマン研究所 / mio の有効化・接続・投稿
- OAuth / Vault / secrets変更
- X token変更
- X手動投稿
- morning_report / close_reportの手動publish
- 人工candidate作成
- important-news pipeline変更
- 他Edge Function変更/deploy
- 管理画面変更
- 投稿内容・Fact/Voiceロジック変更
- H2のclose_report v94ロジック変更

G2は `x-multibrand-phase3c-ai-lab-x-oauth-connect-20260910` を継続中。G2が触っている `x-oauth-connect` / OAuth / Vault / social account領域には触れない。

## Required work procedure

1. `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, このTASK、`.agent/tasks/CLAUDE_TASK.md`, `.agent/tasks/CODEX_TASK_2.md` を確認。
2. `origin/main` fresh-check。
3. 既存未コミット変更は他workstream所有として一切触れない。必要ならclean temporary worktreeを使う。
4. 本番 `claim_due_post()`, `plan_morning_report()`, `plan_close_report()`, relevant settings/windows をread-onlyで再確認。
5. どの本番適用で `claim_due_post()` が書き換わったかを可能な範囲で記録。ただし原因追跡より復旧を優先。
6. 復旧migration/SQLは最小・idempotentにする。既存functionを必要以上に再定義しない。
7. local DB / SQL testsで以下を確認:
   - 平日営業日に morning_report / close_report が各1件だけ計画される
   - 土日・JPX holidayでは計画されない
   - `posting_windows` 側がfalseでも専用plannerは動く
   - 同日複数dispatchでもduplicateされない
   - tip / useful_tip / interaction / morning_greeting等の既存計画挙動を壊さない
8. diff/check/testsを完了。
9. 実装・テストが完了したら `review_required / next_owner: chatgpt` とし、`.agent/CODEX_REPORT.md` を更新してGitHubへ同期。

## Production authorization

このTASKでは、まず実装・テスト・C1レビューまで。

**本番DB function/migration適用はC1前には行わない。**
**Edge Function deployは原則不要。必要だと判明した場合もC1前には行わない。**

C1で復旧内容を確認後、ChatGPT/ユーザーから本番適用を明示承認する。

## C1 completion criteria

- root causeが具体的に確認されている
- 最小復旧patchが完成
- morning_report / close_report両方の専用plannerが通常dispatchから再び到達可能
- duplicate防止維持
- 他通常投稿のscheduler挙動に回帰なし
- 複垢化/OAuth/G2領域へ変更なし
- H2 close_report v94内容へ変更なし
- tests pass
- commit/push/report完了
- production未適用（C1後の別明示承認待ち）

## C1 follow-up — 2026-09-11

初回C1では復旧patch自体は妥当と評価したが、必須のローカルSQL実行テストが未完了だったため差し戻し。

Podman VMはユーザー操作で再作成済み。`podman machine start` と `podman info` が正常完了し、以前の `ssh: handshake failed: EOF` は解消している。今回の再開では新規機能を追加しない。

既存patch `20260911130000_restore_claim_due_post_planners.sql` を対象に、復旧したPodman/local Supabaseまたは同等の隔離Postgresで以下のSQL実行テストを完了すること。

- 平日営業日: morning_report / close_report が各1件だけ計画される
- 土日: 両reportが計画されない
- JPX休日: 両reportが計画されない
- report用 `posting_windows` がinactiveでも専用planner経由で計画される
- 同日複数dispatchでもduplicateされない
- tip / useful_tip / interaction / morning_greeting等の既存planner回帰なし

PodmanのDocker互換socketが必要な場合は、現在のPodman MachineのAPI socketを使うこと。ユーザーが設定した一時的な `DOCKER_HOST` はターミナルセッション依存なので、必要なら現在のsocket pathを `podman machine inspect` 等で安全に再取得する。固定の一時pathを推測しない。

テスト完了後は `.agent/CODEX_REPORT.md` に実行方法・結果を追記し、このTASKを `review_required / next_owner: chatgpt` に戻して再C1を待つ。

**本番適用・Edge deploy・X投稿・Cron変更は引き続き禁止。**

## C1 Review — 2026-09-11

- result: PASS
- local SQL runtime tests: PASS
- implementation commit: `246f080`
- implementation branch: `codex/scheduler-restore-20260911`
- production changes: none
- deploy: none
- safety boundaries: maintained
- next step: user explicit approval is required before applying only `20260911130000_restore_claim_due_post_planners.sql` to production. After application, verify function definition, EXECUTE grants, and natural scheduling read-only; do not manually insert scheduled rows or publish posts.
