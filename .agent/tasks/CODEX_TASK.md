# Codex Task

- task_id: important-news-throughput-and-coverage-hardening-20260909
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: urgent
- recommended_model: Sol

## C1 Review continuation

- review_result: follow_up_required
- reviewed_by: chatgpt
- implementation_review: pass
- blocker: `important-news-monitor` production deploy and post-deploy natural-path verification are not completed.

## Verified implementation

- commit: `afcc79d0e5442deef958e779de95ecad30de2177`
- push: `origin/main` 済み
- important / most_important の両tierを安全条件付きpublish対象へ変更
- most_important優先を維持
- 両tierとも既存10分cooldownを適用
- importantの深夜hold維持、most_importantの既存bypass維持
- `MISSING_EXPLICIT_YEAR` 誤判定を修正し、historical metadata年を過剰要求しないよう改善
- Voice軽微違反を最大1回targeted retry対象へ拡張
- 数字・主体・会社・source・重大Fact・safety違反はhard fail維持
- TDnet / company IR / breaking-marketにtimeout追加
- 海外重要材料はfetch自体より rejected / generation_failed / publish filterで失われていたことをread-only分析済み

## Tests verified

- important-news-monitor tests: 265 passed / 0 failed
- changed pure modules deno check: pass
- git diff --check: pass
- index.ts全体checkの既存型エラーは今回変更由来ではない

## Required continuation

1. `.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、このTASK、`.agent/CODEX_REPORT.md` を再確認。
2. `origin/main` fresh-check。
3. 他slotが `important-news-monitor` / publish_ready Cron / 同じproduction設定を変更していないことを確認。
4. 本TASKで既に承認済みの範囲内で `important-news-monitor` のみproduction deployする。
5. unrelated Edge Function / DB schema / migration / GRANT / secrets / OAuth / morning系 / Pushアプリには触れない。
6. deploy後ACTIVE versionをread-back確認。
7. 旧ready backlogがcutover条件で引き続き除外されることを確認。
8. 手動candidate注入・手動X投稿は行わない。
9. 自然Cronで新規candidateが生成された場合、read-onlyで以下を確認:
   - important / most_important の安全候補がpublish選択へ進むこと
   - `publish_attempts > 0` または自然X投稿へ到達すること
   - most_important優先・10分cooldown・重複防止が維持されること
10. monitor runを複数サイクル観測し、`NEWS_MONITOR_STALE_RUNTIME_TERMINATION` がtimeout追加後も再発するか確認。
11. `.agent/CODEX_REPORT.md` を更新し、deploy version / post-deploy observation / X API calls / old backlog safety / remaining issuesを明記。
12. 完了時 `status: review_required`, `next_owner: chatgpt`。

## Safety

禁止:
- 旧ready backlogの一括投稿・再claim・再生成
- 手動candidate注入
- 手動X投稿で成功扱い
- Fact重大gateの緩和
- unlimited retry
- 全ニュース無差別収集
- unrelated deploy
- migration/schema/GRANT/secrets/OAuth変更
- morning_greeting / morning_report / close_report / Pushアプリ変更

## Completion

- `important-news-monitor` production deploy成功
- ACTIVE version確認
- 旧backlog誤投稿0
- 自然経路でpublish selectionが動くことを確認（自然candidateが無ければ人工生成せず、その旨をReport）
- stale runtimeのpost-deploy観測結果をReport
- status: `review_required`
- next_owner: `chatgpt`
