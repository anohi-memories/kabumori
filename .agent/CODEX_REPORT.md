# Codex Report

- task_id: x-multibrand-phase3a-second-brand-dryrun-20260910
- result: review_required
- next_owner: chatgpt
- implementation_branch: `feature/multibrand-foundation`
- commit_hash: `34cb78c`
- push: `origin/feature/multibrand-foundation`へpush済み（`5806e85..34cb78c`）
- deploy: なし
- production_changes: なし

## Summary

Phase 3Aとして、`ai_salaryman_lab` をKabumoriから独立した `BrandCodeProfile` として、dry-run専用に解決・検証できる基盤を追加した。実OAuth、実Token、Vault書込み/読出し、本番Supabase、Edge deploy、Cron、X投稿、main mergeは行っていない。

## Changed files

- `supabase/functions/_shared/brand/brand_profiles.ts`
- `supabase/functions/_shared/brand/publish_guard.ts`
- `supabase/functions/_shared/brand/dry_run.ts`
- `supabase/functions/_shared/brand/dry_run_test.ts`
- `supabase/functions/_shared/brand/token_loader.ts`
- `supabase/functions/x-test-post/index.ts`

## Result

- AIサラリーマン研究所はKabumoriの voice、hashtags、prompt断片を継承しない最小 profile を持つ。詳細人格・投稿戦略は実装していない。
- `brand_context_dry_run` は `brand_id` を明示可能（省略時Kabumori互換）。`profile_preview` の安全なpreflightを返し、X token loader/X API回数は0。
- disabled/unknown はdry-run入口でもfail-closed。dry_runは既存 publish boundary で引き続き拒否される。
- Vault境界はopaque secret referenceとmock可能なreader interfaceだけを実装。未設定/account不一致はVault readerを呼ぶ前にfail-closed。実Secretは一切扱っていない。
- `mio` は未実装・disabledのまま。

## Tests / safety

- `deno test --no-check --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions`: **686 passed / 0 failed**。
- 新規 dry-run/Vault境界テスト: 3 passed。
- 新規Brand moduleの `deno check`: pass。
- `x-test-post/index.ts` 全体チェックは既知6エラーのみ（BufferSource/既存morning greeting/timestamp型）。今回変更由来の新規エラーなし。
- `git diff --check`: pass。
- `scripts/multibrand/check-safe-env.sh`: **SAFE**、local `cron.job=0`。

## Known gaps / next

- DB-only Podman環境のため、PostgREST経由のHTTP dry-run統合実行は未実施。pure testsでX/Vault未到達を固定した。
- `profile_preview` はブランド接続前の安全な生成preflightであり、公開用のAIサラリーマン研究所コンテンツ生成器ではない。ブランド方針の承認後にのみ追加する。
- Phase 3B（実OAuth、実アカウント、Vault secret、live/X投稿）へは進めていない。
