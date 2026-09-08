# Codex Report

- task_id: important-news-generation-reliability-fix-20260908
- result: review_required
- next_owner: chatgpt
- implementation_commit: `f43a95e` (local, ready to push)
- implementation_base: `origin/main` `7de5a37a5138`

## 実装結果

1. 信頼済みTDnetの `company_code` と `entity_key` が一致する場合に限り、一次資料の会社名ヘッダーに現れる安全な法人 suffix 差を許容。小森/小森コーポレーション、旭コンクリ/旭コンクリート工業を追加し、異なるコード・unsafe suffix・単なる部分一致は拒否。
2. Fact失敗後、明示された年・日付の復元、根拠のない市場解釈/影響/因果表現の削除、確認済み企業の安全な表記統一、軽微な表記整合だけを対象に `fact_retry` を最大1回実行。
3. retry本文へは見出し・source URLをプログラム側で再付与し、local Fact → AI Factを再実行。両方passedの場合だけ既存Voiceへ進む。Fact/Voice retryは各1回で、再帰的なretryはない。
4. 既存の `generation_voice_retry` JSONBを維持し、内部に `fact_retry` 診断を追加。attempted、initial issues、model、local/retry Fact status/issues、errorを保存可能にした。migrationは追加していない。

## 変更ファイル

- `supabase/functions/important-news-monitor/post_generation_logic.ts`
- `supabase/functions/important-news-monitor/post_generation_logic_test.ts`
- `supabase/functions/important-news-monitor/index.ts`
- `supabase/functions/important-news-monitor/generation_persistence_test.ts`
- `.agent/tasks/CODEX_TASK.md`
- `.agent/CODEX_REPORT.md`

## 検証

- relevant generation/persistence tests: `106/106` passed.
- important-news-monitor full regression: `255/255` passed (`deno test --no-check --allow-read .../*_test.ts`).
- `deno check` for changed generation/dispatch modules: passed.
- full `index.ts` check: this clean environment lacks cached `npm:unpdf@1.8.1`; dependency resolution stops before type checking. No production command was run.
- `git diff --check`: passed.

## 制約と安全確認

- production DB write: 0
- migration / DDL / GRANT: 0
- Edge Function deploy: 0
- Cron / settings: 0
- OpenAI real API: 0
- X API / X post: 0 / 0
- existing failed candidates: untouched; no reprocessing or backfill
- `apps/admin/**`: 0
- `HANDOFF.md`: 0
- other functions/features: 0
- secrets exposed: 0
- formal dirty worktree: untouched; implementation was isolated in a clean temporary worktree

## Commit / push

- commit_hash: `f43a95e`
- push: pending
- next recommendation: ChatGPT review (`C`), then separately decide any deployment/observation. This task itself does not authorize deploy or production generation.
