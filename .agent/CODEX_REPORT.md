# Codex Report

- task_id: x-multibrand-phase2-brand-context-20260910
- result: review_required
- next_owner: chatgpt
- implementation_branch: `feature/multibrand-foundation`
- commit_hash: `5806e85`
- push: `origin/feature/multibrand-foundation`へpush済み（`719249f..5806e85`）
- deploy: なし
- production_changes: なし

## Summary

複垢化 Phase 2 の基盤を feature branch のローカル専用 migration と Edge Function 共有層として実装した。`kabumori` は既存挙動を維持し、`ai_salaryman_lab` と `mio` は `disabled` の未接続状態である。本番 Supabase、Edge Function、Cron、Secret/Vault、OAuth、X投稿、main への merge は一切行っていない。

## Changed files

- `supabase/migrations/20260910170000_add_multibrand_brand_context_foundation.sql`
- `supabase/functions/_shared/brand/brand_context.ts`
- `supabase/functions/_shared/brand/brand_profiles.ts`
- `supabase/functions/_shared/brand/publish_guard.ts`
- `supabase/functions/_shared/brand/token_loader.ts`
- `supabase/functions/_shared/brand/brand_context_test.ts`
- `supabase/functions/x-test-post/index.ts`
- `supabase/functions/x-test-post/fixed_hashtags_logic.ts`
- `supabase/functions/x-test-post/morning_greeting_payload_logic_test.ts`
- `supabase/functions/x-test-post/morning_greeting_publish_logic_test.ts`

## DB / pipeline

- `brands`、`social_accounts`、`brand_settings` を追加し、初期IDは `kabumori` / `ai_salaryman_lab` / `mio`。Kabumoriのみ `live`、新2ブランドは `disabled` かつ social account/token未作成。
- `posting_windows`、`scheduled_posts`、`post_execution_logs`、`publish_claims`、3種の report runs に `brand_id`（既定 `kabumori`）を追加。既存の一意制約と no-argument RPC contract は残した。
- 旧 boolean singleton の morning/close/US premarket settings は `brand_id` を主キーにして多行化可能にした。旧 `id=true` は既存読み取り互換のため残した。
- `plan_daily_posts()` と `claim_due_post()` はブランドを保持する。実行ログは trigger が scheduled row から brand を導出するため、既存 completion/failure RPC でも失われない。
- `x-test-post` は claim 後に BrandContext を解決・安全判定し、その後にだけ OAuth を読む。未知、disabled、dry_run、Xアカウント無効、未対応 profile/token resolver はすべて X API 到達前に fail-closed。
- 既存の `oauth_token_store` は Kabumori legacy 専用のまま。重複した token loader を削除し、将来の Vault/social account resolver 切替点を `_shared/brand/token_loader.ts` に集約した。Vault secretや新OAuth情報は作成していない。

## Verification

- `supabase db reset --local --no-seed`: pass。新 migration を含む全 migration をローカル DB に再現。
- 直接ローカル SQL: Kabumori設定の `brand_id=kabumori`、planner/claim の brand 引継ぎ、execution log trigger の brand 引継ぎを確認。テスト書込みは transaction rollback 済み。
- `deno test --no-check --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions`: **683 passed / 0 failed**。
- `git diff --check`: pass。
- `scripts/multibrand/check-safe-env.sh`: 完了時 **SAFE**。local pg_cron job数は **0**。
- `deno check supabase/functions/x-test-post/index.ts`: 今回変更由来ではない既知の6エラー（既存 `x_oauth2_post.ts` BufferSource、morning greeting Blob/BodyInit、既存retry_count、既存 timestamp precision）。新 BrandContext module 単体の `deno check` は pass。

## Known gaps / Phase 3 readiness

- Kong/PostgREST/Auth を含む full Edge Function integration は、DB-only Podman環境のため未実施。ローカル SQL と pure Deno tests で検証した。
- 新ブランドの profile、Vault token resolver、OAuth接続、brand-aware admin UI、古い一意制約のcontractは Phase 3以降。新ブランドは disabled のため投稿不能。
- report run作成など旧経路の legacy insert は `brand_id` default `kabumori` により互換を保つ。新ブランドを実際に有効化する前に、各専用 run/complete経路へ明示的な context 引渡しを追加してレビューする必要がある。

## Next recommendation

ChatGPTで C1 review を行い、feature branchの migration/境界設計を確認する。承認なしに本番適用・Edge deploy・Cron/Secret/OAuth変更・新ブランド有効化は行わない。
