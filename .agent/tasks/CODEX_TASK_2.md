# Codex Task 2

- task_id: morning-greeting-soft-daily-copy-20260909
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- purpose: 朝の挨拶本文を柔らかい日常挨拶へ変更し、固定5タグを決定論的に付与する実装のcommit/pushを完了する。

## C2 Review continuation

- review_result: follow_up_required
- reviewed_by: chatgpt
- implementation_review: pass
- blocker: 実装6ファイルは未コミット、push未実施。元TASKのCompletionはcommit/pushまで必須のため、現時点ではdone承認不可。

## Verified implementation from current Report

- morning_greeting専用指示で相場解説・決算/指数説明・先生/指導口調を抑制。
- 本文validator: 60〜140文字。
- generation target: 80〜120文字。
- length retry: 最大1回を維持。
- 固定タグ `#おはよう #日本株 #日経平均 #かぶモリ #ブルバ100` をコード側で決定論的に1回だけ付与。
- 固定タグの部分/重複は `MORNING_GREETING_FIXED_HASHTAG_INVALID` で安全停止。
- morning_greeting関連 tests: 60 passed / 0 failed。
- x-test-post全体回帰: 365 passed / 0 failed。
- git diff --check: PASS。
- production変更なし。

## Required continuation

1. `.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、このTASKを再確認する。
2. `origin/main` をfresh-checkする。
3. 他workstreamの未コミット変更を絶対にstage/commitしない。
4. 今回のmorning_greeting実装6ファイルだけを対象に差分を再確認する。
5. 同じ `x-test-post` 対象ファイルに競合する新規変更がないことを確認する。
6. 安全なら今回の実装6ファイルをcommitし、origin/mainへpushする。
7. push後のcommit hashを確認する。
8. `.agent/CODEX_REPORT_2.md` を最新結果へ更新し、commit_hash / push結果を明記する。
9. このTASKを `review_required`、`next_owner: chatgpt` に更新してGitHubへ同期する。

## Changed code files expected

- `supabase/functions/x-test-post/morning_greeting_logic.ts`
- `supabase/functions/x-test-post/morning_greeting_logic_test.ts`
- `supabase/functions/x-test-post/morning_greeting_payload_logic.ts`
- `supabase/functions/x-test-post/morning_greeting_payload_logic_test.ts`
- `supabase/functions/x-test-post/morning_greeting_publish_logic.ts`
- `supabase/functions/x-test-post/morning_greeting_publish_logic_test.ts`

## Safety / forbidden

- production deploy禁止。
- X実投稿禁止。
- 本番DB write禁止。
- Cron / scheduler / posting_windows変更禁止。
- secrets変更・表示禁止。
- 画像生成・画像prompt・canonical reference・画像model/quality/sizeは変更禁止。
- Storage receipt 400問題はこのTASKで修正しない。
- morning_report / close_report / important-news-monitorは触らない。
- 他workstreamの変更をstage/commitしない。

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- `.agent/CODEX_REPORT_2.md` 更新
- commit_hashを実値で記録
- push成功を記録
- production変更なしを再確認
