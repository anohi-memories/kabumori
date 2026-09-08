# Codex Report

- task_id: important-news-freshness-coverage-fix-20260906
- result: review_required
- next_owner: chatgpt
- implementation_commit: `7bed84e063db`（`origin/main`へpush済み）
- implementation_base: `origin/main` `81f7c0a8828e`。clean worktreeで載せ替え・全検証後にpush。

## 実装結果

1. `breaking_market`の2検索/cycleを維持し、主要米指標・緊急BOJ/Fed/MOF・市場急変を含む`critical_market_events`を毎20分固定枠化。残り1枠は関税/半導体、地政学、銀行/中国刺激策をrotation。
2. breaking freshnessを24時間から3時間へ短縮。critical queryはsourceで確認できる時刻付き`event_at`を必須化し、欠落・不正・stale eventを候補化前に除外。
3. event種別と検証済みevent minuteから`breaking:event:<kind>:<minute>`を生成。同一eventの別source/別見出しを3時間範囲でduplicate扱いし、異なるevent timestampは統合しない。
4. `market_macro`は全sourceを順次取得・prepareし、保存済みduplicateを除外してから既存30件capを適用。source round-robinで後段source starvationを抑制。
5. query単位でselected key/query、provider/HTTP/Responses状態、incomplete reason、web search call数、raw/validated件数、主要除外理由をresponseとstructured logへ追加。raw response/secretは保存しない。

## 変更ファイル

- `supabase/functions/important-news-monitor/breaking_market_source_fetchers.ts`
- `supabase/functions/important-news-monitor/breaking_market_source_fetchers_test.ts`
- `supabase/functions/important-news-monitor/fetch_resource_limit_logic.ts`
- `supabase/functions/important-news-monitor/fetch_resource_limit_logic_test.ts`
- `supabase/functions/important-news-monitor/index.ts`
- `supabase/functions/important-news-monitor/news_candidate_logic.ts`
- `supabase/functions/important-news-monitor/news_candidate_logic_test.ts`

## 検証

- 変更moduleの型チェック付きtest: 55/55 pass
- important-news-monitor全回帰: 244/244 pass（`--no-check --allow-read`）
- 変更helper/test lint: pass（6 files）
- `git diff --check`: pass
- full `deno check index.ts`: 既存baselineと同じ2件でfail
  - `_shared/x_oauth2_post.ts`のUint8Array/BufferSource型
  - `important-news-monitor/index.ts`の既存GenerationCandidate id optional型
- full-suite type-check: 既存`official_source_fetchers_test.ts`の`never.id`型エラー。いずれも本タスク前のclean baseでも再現し、scope外のため未変更。

## 制約と残課題

- DB schema変更禁止のためdiagnosticsの新規DBカラム/永続化は未実施。現状はHTTP responseとEdge structured logで確認可能。
- 実装コードはユーザーの明示承認後、`origin/main`へpush済み。
- 実デプロイ・本番Fetch・OpenAI実APIは未実施。効果確認はレビュー後のdeploy判断が必要。

## Safety

- production DB write: 0
- migration / DDL / GRANT: 0
- Edge Function deploy: 0
- Cron / settings: 0
- OpenAI実API: 0
- X API / X投稿: 0 / 0
- `apps/admin/**`: 変更0
- `HANDOFF.md`: 変更0
- 他Edge Function: 変更0
- secrets露出: 0
- 正式repo既存未コミット変更: 無傷（作業はclean一時worktreeで分離）

## 次工程

ChatGPTが`C`で本Reportと実装commitをレビューし、deploy/自然サイクル観測を別途明示判断する。
