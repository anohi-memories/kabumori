# Codex Task

- task_id: x-multibrand-phase2-brand-context-20260910
- owner: codex
- slot: codex-1
- status: done
- next_owner: chatgpt
- priority: high
- recommended_model: default
- purpose: 複垢化Phase 2として、現行かぶモリの挙動を維持したまま `brand_id` / BrandContext の基礎を導入し、まず `kabumori` 1ブランドだけで完全互換を確認する。本番反映・新ブランド接続は行わない。

## Transfer

2026-09-10、ユーザー指示によりClaude slot 2（G2）からCodex slot 1（H1）へ移管。

- 旧正本: `.agent/tasks/CLAUDE_TASK.md`
- 新正本: `.agent/tasks/CODEX_TASK.md`
- Claude側でPhase 2実装は開始しない／継続しない
- Phase 1まではClaude G2で完了・K2承認済み
- 複垢化作業ブランチは `feature/multibrand-foundation`

## Approved decisions

以下はChatGPT側で承認済み。

- 共通パイプライン + 行ごとの `brand_id` を基本構造とする。
- `brands` と `social_accounts` を分離する。
- 初期ブランドIDは `kabumori` / `ai_salaryman_lab` / `mio`。
- X Appは当面3ブランド共通1 App。将来分離可能な `oauth_client_ref` は残す。
- XトークンはSupabase Vaultを採用する。通常テーブルへSecret値を平文保存しない。
- 既存シングルトン設定はin-placeでブランド対応へ多行化する。
- 新ブランドは既定OFF、`disabled -> dry_run -> live` の明示段階解放。
- migrationは expand -> switch -> contract。Phase 2では原則expand/switchまでで、旧互換を壊すcontractは行わない。
- ブランド文脈解決失敗・未知brand・安全ゲート不明時はfail-closedで投稿しない。

正式設計: `docs/multibrand/ARCHITECTURE.md`
Phase 1結果: `docs/multibrand/PHASE1.md`
Phase 1 branch commit: `719249f` on `feature/multibrand-foundation`

## Completion

2026-09-10、C1レビューでPhase 2を承認。実装は `feature/multibrand-foundation` の commit `5806e85` としてpush済み。

確認済み:
- brand/account基礎schemaと `brand_id` 導入
- Kabumori用BrandContext / BrandCodeProfile
- planner / claim / x-test-post へのbrand context引継ぎ
- unknown / disabled / dry_run のfail-closed
- legacy `oauth_token_store` はKabumori専用のまま
- 会社員AIラボ・みおは未接続・未有効化
- `supabase db reset --local --no-seed` pass
- Deno tests 683 passed / 0 failed
- `git diff --check` pass
- `check-safe-env.sh` SAFE、local pg_cron job数0
- 本番DB・deploy・Cron・Secret/Vault・OAuth・X投稿・main mergeはすべて未実施

既知の未完了:
- Kong/PostgREST/Authを含むfull integrationはPodman制約で未実施
- `deno check x-test-post/index.ts` の既知6エラーは今回変更由来ではない
- Vault token resolver、新ブランドprofile/admin UI、旧制約contractはPhase 3以降
